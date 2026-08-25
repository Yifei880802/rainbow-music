/**
 * 歌单广场聚合端点（#67 多平台歌单广场接入）
 *   GET /api/v1/playlist-square?platform=all|wy|tx&cat=全部&page=1&limit=20
 *
 * 平台矩阵（docs/research/PLAYLIST-EXPANSION-RESEARCH.md §1 实测结论）：
 * - wy 网易云：`music.163.com/api/playlist/list` 全绿（cat 透传 / offset 翻页零重叠 /
 *   coverImgUrl HEAD 200）→ 主接入
 * - tx QQ音乐：`c.y.qq.com/.../fcg_get_diss_by_tag.fcg` 广场列表可用（sin/ein 翻页零
 *   重叠 / imgurl 300 档）；详情约 75% 成功率（推荐位 dissid 空 cdlist）→ 次接入，
 *   详情容错由前端 toast + 卡片可重试承接（详情复用 /search/songlist/detail，本端点
 *   只出轻量列表，不含曲目）
 * - kg 酷狗：plist 广场端点已死 → 不接入（调研 §1.4）
 *
 * 范式（同 hotPlaylists.ts）：单平台失败/超时(8s)进 errors 不阻塞整体；
 * 服务端 5min 内存缓存（键 = platform|cat|page|limit）+ in-flight 并发去重。
 */
import type { FastifyInstance } from 'fastify'
import { httpFetch } from '../core/adapters/http.js'
import { logger } from '../core/logger.js'

// ---------- 响应契约（API.md §2.7） ----------

export interface SquarePlaylist {
  platform: 'wy' | 'tx'
  /** 平台原生歌单 id（wy=playlistId、tx=dissid；详情 drill 传 /search/songlist/detail） */
  nativeId: string
  title: string
  coverUrl: string | null
  playCount: number
  trackCount: number
  creator: string
  /** 请求分类（wy=分类词透传、tx=sortId 或空）；回显便于前端缓存签名 */
  category: string
}

export interface PlaylistSquareResponse {
  fetchedAt: number
  platform: string
  cat: string
  page: number
  limit: number
  /** 轻量歌单卡列表（不含曲目）；混合模式两平台按索引交错 */
  playlists: SquarePlaylist[]
  /** 参与平台 total 之和（细分见 totals） */
  total: number
  /** 任一参与平台还有下一页（换一批到底后前端回第 1 页） */
  hasMore: boolean
  /** 分平台总数（失败平台为 null） */
  totals: { wy: number | null; tx: number | null }
  errors: Array<{ platform: string; error: string }>
}

interface SquareQuery {
  platform?: string
  cat?: string
  page?: string
  offset?: string
  limit?: string
}

interface PlatformPage {
  list: SquarePlaylist[]
  total: number
  hasMore: boolean
}

const SQUARE_PLATFORMS = ['all', 'wy', 'tx'] as const
const DEFAULT_CAT = '全部'
const DEFAULT_LIMIT = 20
const MIN_LIMIT = 5
const MAX_LIMIT = 20
const UPSTREAM_TIMEOUT_MS = 8_000
const CACHE_TTL_MS = 5 * 60 * 1000
const CACHE_MAX_ENTRIES = 200

/** 单上游超时包裹（同 hotPlaylists 范式） */
async function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined
  try {
    return await Promise.race([
      p,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error('upstream timeout')), ms)
      }),
    ])
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    throw new Error(`${label}: ${msg}`)
  } finally {
    clearTimeout(timer)
  }
}

// ---------- wy 网易云广场（调研 §1.2：直连路径 A，全绿） ----------

interface WySquareItem {
  id: number
  name: string
  coverImgUrl?: string
  playCount?: number
  trackCount?: number
  creator?: { nickname?: string }
}

async function fetchWySquare(cat: string, page: number, limit: number): Promise<PlatformPage> {
  const offset = (page - 1) * limit
  const url =
    `https://music.163.com/api/playlist/list?cat=${encodeURIComponent(cat)}` +
    `&order=hot&limit=${limit}&offset=${offset}&total=true`
  const { statusCode, body } = await httpFetch<{
    code?: number
    total?: number
    more?: boolean
    playlists?: WySquareItem[]
  }>(url, {
    headers: {
      'User-Agent':
        'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
      Referer: 'https://music.163.com/discover/playlist',
    },
  }).promise
  if (statusCode !== 200 || body.code !== 200) {
    throw new Error(`wy square: HTTP ${statusCode ?? '?'} code ${body.code ?? '?'}`)
  }
  const list: SquarePlaylist[] = (body.playlists ?? []).map((it) => ({
    platform: 'wy',
    nativeId: String(it.id),
    title: it.name || '未命名歌单',
    coverUrl: it.coverImgUrl || null,
    playCount: it.playCount ?? 0,
    trackCount: it.trackCount ?? 0,
    creator: it.creator?.nickname ?? '',
    category: cat,
  }))
  const total = body.total ?? list.length
  return { list, total, hasMore: offset + list.length < total }
}

// ---------- tx QQ 音乐广场（调研 §1.3：列表可用；cat=纯数字映射 sortId） ----------

interface TxSquareItem {
  dissid: string | number
  dissname?: string
  imgurl?: string
  listennum?: number
  song_count?: number
  creator?: { name?: string }
}

/**
 * tx 封面归一：imgurl 直出已是 300 档（`/300?n=1`，HEAD 200）；
 * 防御上游改档——末段若为 ≤3 位纯数字尺寸则统一升 300，空值归 null。
 */
function normalizeTxCover(url: string | undefined): string | null {
  const u = (url || '').trim()
  if (!u) return null
  return u.replace(/\/(\d{1,3})(?=\/|$|\?)/, '/300')
}

async function fetchTxSquare(cat: string, page: number, limit: number): Promise<PlatformPage> {
  // cat 为纯数字时作为 sortId（5=推荐 2=最热 3=最新，调研实测）；分类词对 tx 无对应
  // categoryId 体系（10000001 实测为空）→ 固定全部 categoryId=10000000
  const sortId = /^\d+$/.test(cat) ? cat : '5'
  const sin = (page - 1) * limit
  const ein = sin + limit - 1
  const rnd = Math.random().toString().slice(2, 18)
  const url =
    `https://c.y.qq.com/splcloud/fcgi-bin/fcg_get_diss_by_tag.fcg?picmid=1&rnd=${rnd}` +
    `&g_tk=724972804&loginUin=0&hostUin=0&format=json&inCharset=utf8&outCharset=utf-8` +
    `&notice=0&platform=yqq&needNewCode=0&categoryId=10000000&sortId=${sortId}&sin=${sin}&ein=${ein}`
  const { statusCode, body } = await httpFetch<{
    code?: number
    data?: { list?: TxSquareItem[]; sum?: number }
  }>(url, {
    headers: {
      'User-Agent':
        'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
      Referer: 'https://c.y.qq.com/',
      Origin: 'https://c.y.qq.com',
    },
  }).promise
  if (statusCode !== 200 || body.code !== 0) {
    throw new Error(`tx square: HTTP ${statusCode ?? '?'} code ${body.code ?? '?'}`)
  }
  const list: SquarePlaylist[] = (body.data?.list ?? []).map((it) => ({
    platform: 'tx',
    nativeId: String(it.dissid),
    title: it.dissname || '未命名歌单',
    coverUrl: normalizeTxCover(it.imgurl),
    playCount: it.listennum ?? 0,
    trackCount: it.song_count ?? 0,
    creator: it.creator?.name ?? '',
    category: cat,
  }))
  const total = body.data?.sum ?? list.length
  return { list, total, hasMore: ein + 1 < total }
}

// ---------- 聚合（allSettled 平台失败隔离，同 hot-playlists 范式） ----------

/** 混合模式两平台按索引交错（wy 先），避免同平台扎堆 */
function interleave(a: SquarePlaylist[], b: SquarePlaylist[]): SquarePlaylist[] {
  const out: SquarePlaylist[] = []
  const n = Math.max(a.length, b.length)
  for (let i = 0; i < n; i++) {
    if (a[i]) out.push(a[i])
    if (b[i]) out.push(b[i])
  }
  return out
}

async function fetchSquare(platform: string, cat: string, page: number, limit: number): Promise<PlaylistSquareResponse> {
  const targets: Array<'wy' | 'tx'> = platform === 'all' ? ['wy', 'tx'] : [platform as 'wy' | 'tx']
  const settled = await Promise.allSettled(
    targets.map((p) =>
      withTimeout(p === 'wy' ? fetchWySquare(cat, page, limit) : fetchTxSquare(cat, page, limit), UPSTREAM_TIMEOUT_MS, p),
    ),
  )
  const pages = new Map<string, PlatformPage>()
  const errors: Array<{ platform: string; error: string }> = []
  settled.forEach((s, i) => {
    const p = targets[i]!
    if (s.status === 'fulfilled') {
      pages.set(p, s.value)
    } else {
      const msg = s.reason instanceof Error ? s.reason.message : String(s.reason)
      logger.warn(`[playlist-square] ${p} failed (page=${page} cat=${cat}): ${msg}`)
      errors.push({ platform: p, error: msg })
    }
  })

  const wy = pages.get('wy') ?? null
  const tx = pages.get('tx') ?? null
  const playlists =
    platform === 'all'
      ? interleave(wy?.list ?? [], tx?.list ?? [])
      : (wy?.list ?? tx?.list ?? [])
  const total = (wy?.total ?? 0) + (tx?.total ?? 0)
  const hasMore = !!(wy?.hasMore || tx?.hasMore)
  return {
    fetchedAt: Date.now(),
    platform,
    cat,
    page,
    limit,
    playlists,
    total,
    hasMore,
    totals: { wy: wy?.total ?? null, tx: tx?.total ?? null },
    errors,
  }
}

// ---------- 内存缓存（5min TTL + in-flight 去重；键含 platform|cat|page|limit） ----------

const cache = new Map<string, { fetchedAt: number; data: PlaylistSquareResponse }>()
const inflight = new Map<string, Promise<PlaylistSquareResponse>>()

function getSquare(platform: string, cat: string, page: number, limit: number): Promise<PlaylistSquareResponse> {
  const key = `${platform}|${cat}|${page}|${limit}`
  const hit = cache.get(key)
  if (hit && Date.now() - hit.fetchedAt < CACHE_TTL_MS) return Promise.resolve(hit.data)
  const flying = inflight.get(key)
  if (flying) return flying
  const p = fetchSquare(platform, cat, page, limit)
    .then((data) => {
      if (data.playlists.length || data.errors.length) {
        cache.set(key, { fetchedAt: data.fetchedAt, data })
        // 简单容量控制：超上限按插入序淘汰最旧键（cat×page 组合有限，正常远达不到）
        if (cache.size > CACHE_MAX_ENTRIES) cache.delete(cache.keys().next().value as string)
      }
      return data
    })
    .finally(() => {
      inflight.delete(key)
    })
  inflight.set(key, p)
  return p
}

// ---------- 路由 ----------

export async function playlistSquareRoutes(app: FastifyInstance): Promise<void> {
  app.get<{ Querystring: SquareQuery }>('/api/v1/playlist-square', async (req, reply) => {
    const rawPlatform = (req.query.platform || 'all').trim().toLowerCase()
    if (!(SQUARE_PLATFORMS as readonly string[]).includes(rawPlatform)) {
      return reply.code(400).send({ error: `unknown platform: ${rawPlatform}`, valid: SQUARE_PLATFORMS })
    }
    const cat = (req.query.cat || DEFAULT_CAT).trim().slice(0, 24) || DEFAULT_CAT
    // offset 与 page 等价（offset 优先，按 limit 换算；供脚本直调）
    let page = parseInt(req.query.page || '1', 10) || 1
    if (req.query.offset != null) {
      const off = parseInt(req.query.offset, 10)
      if (Number.isFinite(off) && off > 0) page = Math.floor(off / DEFAULT_LIMIT) + 1
    }
    if (page < 1) page = 1
    if (page > 1000) return reply.code(400).send({ error: 'page out of range (1-1000)' })
    let limit = parseInt(req.query.limit || String(DEFAULT_LIMIT), 10) || DEFAULT_LIMIT
    limit = Math.min(Math.max(limit, MIN_LIMIT), MAX_LIMIT)
    return getSquare(rawPlatform, cat, page, limit)
  })
}
