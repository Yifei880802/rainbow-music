/**
 * 热门歌单聚合端点（#60 首页；#62 P1 酷狗扩展为 5 榜）
 *   GET /api/v1/hot-playlists
 *
 * 十榜聚合（平台交错序）：wy 热歌榜 / tx 巅峰榜·热歌 / kg TOP500 /
 * tx 飙升榜 / kg 飙升榜 / kw 精选(虚拟) / kg 新歌榜 / mg 精选(虚拟) /
 * kg 网络热歌榜 / kg 欧美榜（kg 榜 id 用语义 slug：kg-top500/kg-soar…）。
 * - 单榜失败/超时（8s）→ 该平台进 errors，不阻塞整体（Promise.allSettled）
 * - #71：榜单级封面空 → 榜首歌曲封面兜底（mg 虚拟榜修复；kg 防御性兜底；
 *   kw 双 null 维持前端渐变占位）；配套前端缓存 v:2 强制失效旧数据
 * - songs[].songInfo = 现有 MusicInfo 结构原样内嵌 → 前端零转换进下载/刮削链路
 * - 5 分钟服务端内存缓存 + in-flight 并发去重；缓存签名含榜单集（清单变化即失效）
 * 数据路径权威依据：docs/research/APPLE-MUSIC-REDESIGN-PLAN.md §4 + 附录 A 实测矩阵
 * （kg 55 榜全集 m.kugou.com/rank/list 实测，榜选取见 BOARDS 注释）。
 */
import type { FastifyInstance } from 'fastify'
import wySongList from '../core/adapters/wy/songList.js'
import txToplist from '../core/adapters/tx/toplist.js'
import kgToplist from '../core/adapters/kg/toplist.js'
import kw from '../core/adapters/kw/musicSearch.js'
import mg from '../core/adapters/mg/musicSearch.js'
import type { MusicInfo } from '../core/adapters/common.js'
import type { Platform } from '../core/search/index.js'
import { logger } from '../core/logger.js'

// ---------- 响应契约（API.md §2.6） ----------

export interface HotPlaylistSong {
  platform: Platform
  songmid: string | number
  title: string
  artist: string
  album: string
  interval?: string
  coverUrl?: string | null
  /** ★ 与 GET /api/v1/search 的 list item 同构，可原样作为下载接口 musicInfo 传入 */
  songInfo: MusicInfo
}

export interface HotPlaylist {
  /** 合成 id：{platform}-{原生榜单id}（详情页路由用） */
  id: string
  platform: Platform
  /** 平台原生 id（tx=topid、kg=rankid、wy=playlistId、kw/mg 虚拟榜=关键词 slug） */
  nativeId: string
  title: string
  description: string
  coverUrl: string | null
  /** 平台原生更新时间 YYYY-MM-DD（wy 无显式字段→取聚合生成日；虚拟榜=生成日） */
  updateTime: string
  /** 同 updateTime（别名，供前端统一字段消费） */
  updatedAt: string
  /** 榜单总曲目数 */
  total: number
  /** toplist=官方榜 | virtual=关键词拼装（前端徽标区分，不冒充官方榜） */
  source: 'toplist' | 'virtual'
  songs: HotPlaylistSong[]
}

export interface HotPlaylistsResponse {
  fetchedAt: number
  playlists: HotPlaylist[]
  errors: Array<{ platform: string; error: string }>
}

// ---------- 榜单配置 ----------

interface BoardDef {
  platform: Platform
  nativeId: string
  /** kg 语义 slug 对应的酷狗原生 rankid（55 榜全集实测，附录 A.1） */
  rankid?: number
  /** 虚拟榜固定热门关键词（kw/mg 榜单接口不可用，搜索拼装降级；配置化便于调优） */
  keyword?: string
  title: string
  source: 'toplist' | 'virtual'
}

/**
 * 十榜清单（平台交错序，避免同平台扎堆）。
 * #62 P1：kg 从双榜扩展为 5 榜（TOP500/飙升/新歌/网络热歌/欧美，
 * rankid 8888/6666/74534/82831/31310 均为 m.kugou.com/rank/info 系列实测可用），与 wy 热歌/
 * tx 双榜并列；kw/mg 维持搜索拼装虚拟榜。
 */
const BOARDS: BoardDef[] = [
  { platform: 'wy', nativeId: '3778678', title: '热歌榜', source: 'toplist' },
  { platform: 'tx', nativeId: '26', title: '巅峰榜·热歌', source: 'toplist' },
  { platform: 'kg', nativeId: 'top500', rankid: 8888, title: 'TOP500', source: 'toplist' },
  { platform: 'tx', nativeId: '62', title: '飙升榜', source: 'toplist' },
  { platform: 'kg', nativeId: 'soar', rankid: 6666, title: '飙升榜', source: 'toplist' },
  { platform: 'kw', nativeId: 'hot-hits', keyword: '热门 华语', title: '酷我精选', source: 'virtual' },
  { platform: 'kg', nativeId: 'new', rankid: 74534, title: '新歌榜', source: 'toplist' },
  { platform: 'mg', nativeId: 'hot-hits', keyword: '热门 华语', title: '咪咕精选', source: 'virtual' },
  { platform: 'kg', nativeId: 'webhot', rankid: 82831, title: '网络热歌榜', source: 'toplist' },
  { platform: 'kg', nativeId: 'eur', rankid: 31310, title: '欧美榜', source: 'toplist' },
]

/** 榜单歌曲数上限（wy 全量 200 切片；tx 单页 50；kg 单页 30；kw/mg 搜索 30） */
const SONGS_LIMIT = 50
/** 单榜上游超时（含 gateway 补齐） */
const BOARD_TIMEOUT_MS = 8_000
/** 服务端内存缓存 TTL */
const CACHE_TTL_MS = 5 * 60 * 1000

const today = (): string => {
  const d = new Date()
  const p = (n: number): string => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
}

/** 单榜超时包裹（上游无 SLA，防单榜挂死拖爆整页） */
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

function toSongs(platform: Platform, list: MusicInfo[]): HotPlaylistSong[] {
  return list.slice(0, SONGS_LIMIT).map((m) => ({
    platform,
    songmid: m.songmid,
    title: m.name,
    artist: m.singer,
    album: m.albumName ?? '',
    interval: m.interval || undefined,
    coverUrl: m.img ?? null,
    songInfo: m,
  }))
}

async function fetchBoard(def: BoardDef): Promise<HotPlaylist> {
  let pl: HotPlaylist
  if (def.platform === 'wy') {
    const d = await withTimeout(wySongList.getListDetail(def.nativeId, 1), BOARD_TIMEOUT_MS, 'wy')
    pl = {
      id: `wy-${def.nativeId}`,
      platform: 'wy',
      nativeId: def.nativeId,
      title: d.info?.name || def.title,
      description: d.info?.desc || '',
      coverUrl: d.info?.img || null,
      updateTime: today(), // wy 榜单响应无显式更新时间字段 → 取聚合生成日（规划 M7）
      updatedAt: today(),
      total: d.total || d.list.length,
      source: 'toplist',
      songs: toSongs('wy', d.list),
    }
  } else if (def.platform === 'tx') {
    const d = await withTimeout(txToplist.getToplist(Number(def.nativeId)), BOARD_TIMEOUT_MS, 'tx')
    pl = {
      id: `tx-${def.nativeId}`,
      platform: 'tx',
      nativeId: def.nativeId,
      title: d.info.name || def.title,
      description: '',
      coverUrl: d.info.coverUrl || null,
      updateTime: (d.info.updateTime || today()).slice(0, 10),
      updatedAt: (d.info.updateTime || today()).slice(0, 10),
      total: d.info.total || d.songs.length,
      source: 'toplist',
      songs: toSongs('tx', d.songs),
    }
  } else if (def.platform === 'kg') {
    const d = await withTimeout(kgToplist.getToplist(def.rankid ?? Number(def.nativeId)), BOARD_TIMEOUT_MS, 'kg')
    pl = {
      id: `kg-${def.nativeId}`,
      platform: 'kg',
      nativeId: def.nativeId,
      title: d.info.name || def.title,
      description: d.info.description || '',
      coverUrl: d.info.coverUrl || null,
      updateTime: d.info.updateTime || today(),
      updatedAt: d.info.updateTime || today(),
      total: d.info.total || d.songs.length,
      source: 'toplist',
      songs: toSongs('kg', d.songs),
    }
  } else if (def.platform === 'kw' && def.keyword) {
    const d = await withTimeout(kw.search(def.keyword, 1, 30), BOARD_TIMEOUT_MS, 'kw')
    pl = {
      id: `kw-${def.nativeId}`,
      platform: 'kw',
      nativeId: def.nativeId,
      title: def.title,
      description: `按「${def.keyword}」搜索拼装的精选榜`,
      coverUrl: null, // kw 搜索结果封面恒空 → 前端 M5 渐变占位
      updateTime: today(),
      updatedAt: today(),
      total: d.total || d.list.length,
      source: 'virtual',
      songs: toSongs('kw', d.list),
    }
  } else {
    // mg 虚拟榜（同 kw 搜索拼装降级）
    const d = await withTimeout(mg.search(def.keyword!, 1, 30), BOARD_TIMEOUT_MS, 'mg')
    pl = {
      id: `mg-${def.nativeId}`,
      platform: 'mg',
      nativeId: def.nativeId,
      title: def.title,
      description: `按「${def.keyword}」搜索拼装的精选榜`,
      coverUrl: null,
      updateTime: today(),
      updatedAt: today(),
      total: d.total || d.list.length,
      source: 'virtual',
      songs: toSongs('mg', d.list),
    }
  }
  // #71：榜单级封面空 → 榜首歌曲封面兜底（全平台统一后处理）。
  // mg 虚拟榜榜单级恒 null 但 songs[0].coverUrl 实测 22/22 有图；kg 未来
  // 四字段链全空时同样生效；kw 搜索封面恒空（榜单/歌曲双 null）→ 自然维持
  // null → 前端 M5 渐变占位（设计内，不硬凑）。
  if (!pl.coverUrl && pl.songs[0]?.coverUrl) pl.coverUrl = pl.songs[0].coverUrl
  return pl
}

async function fetchAll(): Promise<HotPlaylistsResponse> {
  const settled = await Promise.allSettled(BOARDS.map((b) => fetchBoard(b)))
  const playlists: HotPlaylist[] = []
  const errorMap = new Map<string, string>() // 平台级去重（tx×2/kg×2 同因失败只报一条）
  settled.forEach((s, i) => {
    if (s.status === 'fulfilled') {
      playlists.push(s.value)
    } else {
      const platform = BOARDS[i]!.platform
      const msg = s.reason instanceof Error ? s.reason.message : String(s.reason)
      logger.warn(`[hot-playlists] ${platform} board failed: ${msg}`)
      if (!errorMap.has(platform)) errorMap.set(platform, msg)
    }
  })
  return {
    fetchedAt: Date.now(),
    playlists,
    errors: [...errorMap.entries()].map(([platform, error]) => ({ platform, error })),
  }
}

// ---------- 内存缓存（5min TTL + in-flight 去重；签名含榜单集） ----------

/** 榜单集签名（#62 P1：榜单清单变化时旧缓存立即失效，避免新旧聚合混用） */
const CACHE_SIG = BOARDS.map((b) => `${b.platform}:${b.nativeId}`).join('|')

let cache: { sig: string; fetchedAt: number; data: HotPlaylistsResponse } | null = null
let inflight: Promise<HotPlaylistsResponse> | null = null

function getHotPlaylists(): Promise<HotPlaylistsResponse> {
  if (cache && cache.sig === CACHE_SIG && Date.now() - cache.fetchedAt < CACHE_TTL_MS) {
    return Promise.resolve(cache.data)
  }
  if (inflight) return inflight
  inflight = fetchAll()
    .then((data) => {
      cache = { sig: CACHE_SIG, fetchedAt: data.fetchedAt, data }
      return data
    })
    .finally(() => {
      inflight = null
    })
  return inflight
}

export async function hotPlaylistsRoutes(app: FastifyInstance): Promise<void> {
  app.get('/api/v1/hot-playlists', async () => {
    return getHotPlaylists()
  })
}
