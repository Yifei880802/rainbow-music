/**
 * P0 搜索基础设施 D2/D3：搜索联想（suggest）+ 热搜榜（trending）
 *
 * D2 GET /api/v1/search/suggest?q=&limit=
 *   三数据源按优先级合并、匹配 q、按 (text,singer) 复合 key 去重后取前 limit：
 *     1) history —— 当前 uid 近期搜索词（searchHistoryStore.recentKeywords）
 *     2) hot     —— 全局近 7 天热搜词（searchHistoryStore.globalTop）
 *     3) title   —— 热门榜单标题池（自建，见下）歌曲名 + 歌手
 *   复合 key 去重修复「同名不同歌手被折叠」的老问题：同名不同歌手保留为不同条目，
 *   完全相同 (name,singer) 跨源只出现一次（保留优先级最高的 type）。
 *
 * D3 GET /api/v1/search/trending?limit=
 *   全局搜索历史近 7 天频次 Top N（{ text, count }）。
 *
 * 标题池：routes/hotPlaylists.ts 的 getHotPlaylists 为模块私有且该文件不在本任务可改范围，
 * 故此处直接 import 榜单适配器自建轻量标题池（wy 热歌榜 / tx 巅峰榜·热歌 / kg TOP500），
 * 复刻 hotPlaylists 的 8s 单榜超时 + 5min 内存缓存 + in-flight 去重范式。
 */
import wySongList from '../adapters/wy/songList.js'
import txToplist from '../adapters/tx/toplist.js'
import kgToplist from '../adapters/kg/toplist.js'
import type { MusicInfo } from '../adapters/common.js'
import { filterStr } from '../adapters/match.js'
import { searchHistoryStore, searchCoocStore, TRENDING_WINDOW_MS } from '../db/searchHistory.js'
import { config } from '../config.js'
import { logger } from '../logger.js'

// ---------- 契约类型（与 routes/search.ts 响应逐字对齐）----------

export type SuggestType = 'history' | 'hot' | 'title'

export interface SuggestItem {
  text: string
  singer?: string
  type: SuggestType
}

/** 合并前的候选项（三源统一结构） */
export interface SuggestCandidate {
  text: string
  singer?: string
  type: SuggestType
}

export interface SuggestResult {
  q: string
  items: SuggestItem[]
}

export interface TrendingItem {
  text: string
  count: number
}

export interface TrendingResult {
  items: TrendingItem[]
}

/** #200 O5：相关推荐单项（共现邻居词 + 得分） */
export interface RelatedItem {
  kw: string
  score: number
}

/** #200 O5：相关推荐结果（「搜过 X 的人也搜 Y」） */
export interface RelatedResult {
  related: RelatedItem[]
}

// ---------- 归一化工具（自足，不改 match.ts）----------

const SINGER_SEP = /、|&|;|；|\/|,|，|\|/

/** 文本归一化：复用 match.ts 导出的 filterStr（去空格/标点）后小写 */
function normText(s: unknown): string {
  return filterStr(typeof s === 'string' ? s : String(s ?? '')).toLowerCase()
}

/**
 * 歌手归一化：多歌手按分隔符拆分、localeCompare 排序后 join，再走 filterStr 小写。
 * 与 match.ts 的 sortSingle 语义一致（消除 "A、B" 与 "B、A" 的顺序差异），
 * 此处独立实现避免修改 adapters/match.ts（不在本任务可改范围）。
 */
function normSinger(s: unknown): string {
  const raw = (typeof s === 'string' ? s : String(s ?? '')).trim()
  if (!raw) return ''
  const sorted = SINGER_SEP.test(raw)
    ? raw.split(SINGER_SEP).map((x) => x.trim()).filter(Boolean).sort((a, b) => a.localeCompare(b)).join('、')
    : raw
  return filterStr(sorted).toLowerCase()
}

// ---------- 纯函数：匹配 + 复合 key 去重（供单测直接验证）----------

/**
 * 从候选集中筛选匹配 q 的项并按 (text,singer) 复合 key 去重，取前 limit。
 *
 * - 匹配规则：归一化后 candidate.text 包含归一化 q（子串）；q 为空则不过滤（全量按序）。
 * - 去重键：`${normText(text)}|${normSinger(singer)}`；同名不同歌手 → 不同键 → 各自保留。
 * - 保序：候选按传入顺序（history → hot → title 优先级）遍历，先出现者保留其 type。
 *
 * 纯函数、无 IO：单测可直接注入构造候选验证去重与复合 key 行为。
 */
export function mergeSuggest(q: string, candidates: SuggestCandidate[], limit: number): SuggestItem[] {
  const nq = normText((q ?? '').trim())
  const seen = new Set<string>()
  const out: SuggestItem[] = []
  for (const c of candidates) {
    const text = (c.text ?? '').trim()
    if (!text) continue
    if (nq && !normText(text).includes(nq)) continue
    const singer = (c.singer ?? '').trim()
    const key = `${normText(text)}|${normSinger(singer)}`
    if (seen.has(key)) continue
    seen.add(key)
    out.push(singer ? { text, singer, type: c.type } : { text, type: c.type })
    if (out.length >= limit) break
  }
  return out
}

// ---------- 标题池（8s 单榜超时 + 5min 缓存 + in-flight 去重）----------

const titleTimeoutMs = (): number => config.search?.timeoutMs ?? 8000
const titleCacheTtlMs = (): number => config.search?.cacheTtlMs ?? 300000
// #191：标题池取榜平台（search.suggestPlatforms，缺省 wy/tx/kg 全取）
const suggestPlatforms = (): string[] => config.search?.suggestPlatforms ?? ['wy', 'tx', 'kg']

/** 标题池榜单（取 3 个稳定官方榜，够覆盖热门歌曲名；避免全 10 榜的重量级抓取） */
interface TitleBoard {
  platform: string
  fetch: () => Promise<MusicInfo[]>
}
const TITLE_BOARDS: TitleBoard[] = [
  { platform: 'wy', fetch: async () => (await wySongList.getListDetail('3778678', 1)).list },
  { platform: 'tx', fetch: async () => (await txToplist.getToplist(26)).songs },
  { platform: 'kg', fetch: async () => (await kgToplist.getToplist(8888)).songs },
]

function withAbortTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  return Promise.race([
    p,
    new Promise<never>((_, reject) => {
      AbortSignal.timeout(ms).addEventListener('abort', () => reject(new Error(`${label}: upstream timeout`)), { once: true })
    }),
  ])
}

async function fetchTitlePool(): Promise<SuggestCandidate[]> {
  const timeoutMs = titleTimeoutMs()
  // 按 search.suggestPlatforms 过滤取榜平台（配置项落地；未配则全取）
  const enabled = new Set(suggestPlatforms())
  const boards = TITLE_BOARDS.filter((b) => enabled.has(b.platform))
  const settled = await Promise.allSettled(
    boards.map((b) => withAbortTimeout(b.fetch(), timeoutMs, b.platform)),
  )
  const pool: SuggestCandidate[] = []
  settled.forEach((s, i) => {
    if (s.status === 'fulfilled') {
      for (const m of s.value) {
        const name = (m.name ?? '').trim()
        if (name) pool.push({ text: name, singer: (m.singer ?? '').trim(), type: 'title' })
      }
    } else {
      logger.warn(`[suggest] title board ${boards[i]!.platform} failed: ${String(s.reason)}`)
    }
  })
  return pool
}

let titleCache: { fetchedAt: number; data: SuggestCandidate[] } | null = null
let titleInflight: Promise<SuggestCandidate[]> | null = null

/** 取标题池（5min 缓存 + in-flight 去重）；全部榜单失败时返回空池（联想降级为仅 history/hot） */
function getTitlePool(): Promise<SuggestCandidate[]> {
  if (titleCache && Date.now() - titleCache.fetchedAt < titleCacheTtlMs()) {
    return Promise.resolve(titleCache.data)
  }
  if (titleInflight) return titleInflight
  titleInflight = fetchTitlePool()
    .then((data) => {
      titleCache = { fetchedAt: Date.now(), data }
      return data
    })
    .finally(() => {
      titleInflight = null
    })
  return titleInflight
}

// ---------- 对外编排 ----------

/** 热搜/联想取词的历史窗口候选上限（DB 侧聚合，取足够多再本地匹配） */
const HISTORY_CANDIDATES = 100
const HOT_CANDIDATES = 100

/**
 * D2 联想：合并 history(uid) + hot(全局) + title(标题池) 三源，匹配 q、复合 key 去重、取前 limit。
 * uid 为空（未登录/鉴权关闭）时 history 源自然为空，仅 hot + title。
 */
export async function suggest(q: string, limit: number, uid?: string): Promise<SuggestResult> {
  const query = (q ?? '').trim()
  const n = Number.isInteger(limit) && limit > 0 ? limit : 10
  if (!query) return { q: query, items: [] }

  // 标题池异步抓取；history/hot 为同步 DB 查询。并发取标题池，避免串行等待。
  const titlePromise = getTitlePool().catch(() => [] as SuggestCandidate[])

  const candidates: SuggestCandidate[] = []

  // 1) history：当前 uid 近期搜索词（优先级最高）
  if (uid) {
    for (const kw of searchHistoryStore.recentKeywords(uid, HISTORY_CANDIDATES)) {
      candidates.push({ text: kw, type: 'history' })
    }
  }

  // 2) hot：全局近 7 天热搜词
  const since = Date.now() - TRENDING_WINDOW_MS
  for (const row of searchHistoryStore.globalTop(since, HOT_CANDIDATES)) {
    candidates.push({ text: row.kw, type: 'hot' })
  }

  // 3) title：热门榜单标题池（歌曲名 + 歌手）
  const titles = await titlePromise
  candidates.push(...titles)

  return { q: query, items: mergeSuggest(query, candidates, n) }
}

/**
 * D3 热搜榜：全局搜索历史近 7 天频次 Top N（{ text, count }）。
 * 廉价 DB GROUP BY，直查保新鲜（不做内存缓存，trending 语义要求实时）。
 */
export function trending(limit: number): TrendingResult {
  const n = Number.isInteger(limit) && limit > 0 ? limit : 10
  const since = Date.now() - TRENDING_WINDOW_MS
  const rows = searchHistoryStore.globalTop(since, n)
  return { items: rows.map((r) => ({ text: r.kw, count: r.count })) }
}

/**
 * #200 O5 相关推荐（「搜过 X 的人也搜 Y」）：基于 search_history 全局共现统计。
 *
 * - relatedEnabled=false / kw 为空 → 返回空数组（不报错）；
 * - 主数据源：search_cooccurrence 共现邻居（按共现频次降序，排除 kw 自身），score=count；
 * - 冷启动回退：无共现数据时回退到 trending 热门词（同样排除 kw 自身），score=count；
 * - 仍为空则返回空数组。
 *
 * @param kw    基准搜索词
 * @param limit 返回条数上限
 */
export function related(kw: string, limit: number): RelatedResult {
  const n = Number.isInteger(limit) && limit > 0 ? limit : 10
  if (config.search?.relatedEnabled === false) return { related: [] }
  const key = (kw ?? '').trim()
  if (!key) return { related: [] }

  // 1) 共现邻居（排除自身；searchCoocStore.neighbors 已在 SQL 层 b != a 过滤）
  const neighbors = searchCoocStore.neighbors(key, n)
  if (neighbors.length) {
    return { related: neighbors.map((r) => ({ kw: r.kw, score: r.count })) }
  }

  // 2) 冷启动回退：trending 热门词（排除与基准词归一化相同的项）
  const nk = key.toLowerCase()
  const hot = trending(n + 1).items
    .filter((it) => it.text && it.text.trim().toLowerCase() !== nk)
    .slice(0, n)
    .map((it) => ({ kw: it.text, score: it.count }))
  return { related: hot }
}
