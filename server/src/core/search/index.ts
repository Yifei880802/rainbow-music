/**
 * SearchService — 统一 5 平台搜索适配器
 * - searchPlatform: 单平台搜索
 * - searchAggregate: 并发查所有(或指定)平台，合并结果（不跨平台去重，保留各平台来源）
 */
import kw from '../adapters/kw/musicSearch.js'
import kg from '../adapters/kg/musicSearch.js'
import tx from '../adapters/tx/musicSearch.js'
import wy from '../adapters/wy/musicSearch.js'
import mg from '../adapters/mg/musicSearch.js'
import kwSongList from '../adapters/kw/songList.js'
import kgSongList from '../adapters/kg/songList.js'
import txSongList from '../adapters/tx/songList.js'
import wySongList from '../adapters/wy/songList.js'
import mgSongList from '../adapters/mg/songList.js'
import type { SearchResult, MusicInfo, MusicQualityType, SongListSearchResult, SongListDetailResult } from '../adapters/common.js'
import { filterStr, sortSingle, getIntv } from '../adapters/match.js'
import { scoreTrack, medianInterval, qualityRankOf } from './scoring.js'
import { correctKeyword } from './correct.js'
import { logger } from '../logger.js'
import { config } from '../config.js'

export type Platform = 'kw' | 'kg' | 'tx' | 'wy' | 'mg'

interface SearchAdapter {
  search(str: string, page?: number, limit?: number): Promise<SearchResult>
}

const ADAPTERS: Record<Platform, SearchAdapter> = { kw, kg, tx, wy, mg }

interface SongListAdapter {
  search(text: string, page?: number, limit?: number): Promise<SongListSearchResult>
  getListDetail(id: string, page?: number): Promise<SongListDetailResult>
}
const SONGLIST_ADAPTERS: Record<Platform, SongListAdapter> = {
  kw: kwSongList, kg: kgSongList, tx: txSongList, wy: wySongList, mg: mgSongList,
}
export const ALL_PLATFORMS: Platform[] = ['kw', 'kg', 'tx', 'wy', 'mg']

export function isPlatform(p: string): p is Platform {
  return (ALL_PLATFORMS as string[]).includes(p)
}

export interface AggregatePlatformResult {
  platform: Platform
  ok: boolean
  total: number
  list: MusicInfo[]
  error?: string
}

export interface AggregateSearchResult {
  keyword: string
  page: number
  results: AggregatePlatformResult[]
  /**
   * #200 O4：错字容错建议。仅当结果稀疏（各平台条数之和 < search.correctMinResults）
   * 且 search.correctEnabled 时可能出现。**不自动替换用户原词**，供前端「已为你搜索 X，仍要搜索 Y?」提示。
   */
  corrected?: string
  /** #200 O4：纠错建议对应的用户原始输入（trim 后） */
  correctedFrom?: string
}

// ---------- #191 J1：合并视图（跨平台去重 + sources[] + 相关度评分）----------

/** 音质档位（与 MusicQualityType.type 一致，用于并集/排序） */
export type Quality = '128k' | '320k' | 'flac' | 'flac24bit'

/** 合并条目的单个来源（前端「展开看全部来源」时逐项可直接下载） */
export interface MergedSource {
  platform: Platform
  songmid: string | number
  /** 该来源自身可达的音质（去重、按档位降序） */
  qualities: Quality[]
  /** 该平台原始条目（含 score），前端展开来源/换源下载时直接取用 */
  songInfo: MusicInfo
}

/** 合并后的一首「歌」（可能聚合多个平台的同一曲目） */
export interface MergedTrack {
  name: string
  singer: string
  albumName: string
  img: string | null
  interval?: string | 0
  /** 所有来源音质的并集（去重、按档位降序） */
  qualities: Quality[]
  /** 全部来源（前端默认折叠、可展开看全部来源） */
  sources: MergedSource[]
  /** #191 J2：合并条目相关度评分（取代表来源打分），越大越相关 */
  score: number
}

export interface MergedSearchResult {
  keyword: string
  page: number
  /** 合并后条目总数（去重后） */
  total: number
  list: MergedTrack[]
  /** #200 O4：错字容错建议（合并条目数 < search.correctMinResults 时可能出现；不自动替换原词） */
  corrected?: string
  /** #200 O4：纠错建议对应的用户原始输入（trim 后） */
  correctedFrom?: string
}

// ---------- D4：/search/aggregate 8s 超时 + 5min 内存缓存 + in-flight 去重 ----------
// 复用 routes/hotPlaylists.ts 的聚合范式：单平台上游超时落 errors（不拖爆整体），
// 整体结果按 (keyword,page,platforms,limit) 签名做 5min 内存缓存 + 并发 in-flight 去重。
// 超时/缓存 TTL/默认 limit 均来自 config.search（yaml 未提供时回落代码默认值）。

const aggTimeoutMs = (): number => config.search?.timeoutMs ?? 8000
const aggCacheTtlMs = (): number => config.search?.cacheTtlMs ?? 300000
const aggDefaultLimit = (): number => config.search?.defaultLimit ?? 30
// #191 J2：平台权重乘数表（search.platformWeights，缺省各平台按 1.0）
const platformWeights = (): Record<string, number> => config.search?.platformWeights ?? {}
// #200 O4：错字容错开关与触发阈值（缺省 enabled=true / minResults=3）
const correctEnabled = (): boolean => config.search?.correctEnabled !== false
const correctMinResults = (): number => config.search?.correctMinResults ?? 3

/**
 * #200 O4：结果稀疏时计算纠错建议并写入目标对象（corrected/correctedFrom）。
 * 仅当 correctEnabled 且 count < correctMinResults 时触发；correctKeyword 抛错时静默降级
 * （纠错是锦上添花，绝不可拖垮主搜索）。不自动替换 keyword，仅附加建议字段。
 */
function attachCorrection(
  keyword: string,
  count: number,
  target: { corrected?: string; correctedFrom?: string },
): void {
  if (!correctEnabled() || count >= correctMinResults()) return
  try {
    const c = correctKeyword(keyword)
    if (c && c.corrected !== keyword.trim()) {
      target.corrected = c.corrected
      target.correctedFrom = c.correctedFrom
    }
  } catch (e) {
    logger.warn(`[search] correct failed: ${String(e)}`)
  }
}

/** 聚合结果缓存条目上限（超出按插入序淘汰最旧，防长尾关键词无限堆积） */
const AGG_CACHE_MAX = 200

/**
 * 单平台上游超时包裹（AbortSignal.timeout）：慢/挂死平台在 timeoutMs 后 reject，
 * 由 Promise.allSettled 归入该平台 error 项，其余平台结果照常返回。
 * AbortSignal.timeout 内部使用 unref 计时器，不会吊住事件循环。
 */
function withAbortTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  return Promise.race([
    p,
    new Promise<never>((_, reject) => {
      AbortSignal.timeout(ms).addEventListener(
        'abort',
        () => reject(new Error(`${label}: upstream timeout`)),
        { once: true },
      )
    }),
  ])
}

const aggCache = new Map<string, { fetchedAt: number; data: AggregateSearchResult }>()
const aggInflight = new Map<string, Promise<AggregateSearchResult>>()

/** 真正执行并发聚合（无缓存）；每平台带 8s 超时，单平台失败/超时落 errors */
async function runAggregate(
  keyword: string,
  page: number,
  platforms: Platform[],
  limit: number,
): Promise<AggregateSearchResult> {
  const timeoutMs = aggTimeoutMs()
  const settled = await Promise.allSettled(
    platforms.map((p) => withAbortTimeout(ADAPTERS[p].search(keyword, page, limit), timeoutMs, p)),
  )
  const results: AggregatePlatformResult[] = settled.map((s, i) => {
    const platform = platforms[i]!
    if (s.status === 'fulfilled') {
      return { platform, ok: true, total: s.value.total, list: s.value.list }
    }
    const error = s.reason instanceof Error ? s.reason.message : String(s.reason)
    logger.warn(`[search] ${platform} failed: ${error}`)
    return { platform, ok: false, total: 0, list: [], error }
  })
  // #191 J2 scoring pass：返回前跨平台统一打分（时长中位数取全集聚基准）并按分值降序。
  applyAggregateScoring(keyword, results)
  const out: AggregateSearchResult = { keyword, page, results }
  // #200 O4：结果稀疏时附加纠错建议（各平台条数之和；缓存连同建议一起复用）
  attachCorrection(keyword, results.reduce((n, r) => n + r.list.length, 0), out)
  return out
}

/**
 * #191 J2：对聚合结果逐平台打分并降序。时长中位数跨全结果集统一计算（factor ③ 同基准），
 * 平台权重取 search.platformWeights。就地写入 track.score 并稳定排序（同分保留上游原序）。
 */
function applyAggregateScoring(keyword: string, results: AggregatePlatformResult[]): void {
  const weights = platformWeights()
  const median = medianInterval(results.flatMap((r) => r.list.map((t) => t.interval)))
  for (const r of results) {
    if (!r.list.length) continue
    for (const t of r.list) t.score = scoreTrack(keyword, t, r.platform, { medianInterval: median, platformWeights: weights })
    // Array.prototype.sort 在 V8 下稳定，同分保留上游原序
    r.list.sort((a, b) => (b.score ?? 0) - (a.score ?? 0))
  }
}

// ---------- #191 J1：合并去重内核（复用 match.ts 的 filterStr/sortSingle/getIntv）----------

/** 音质并集/排序的档位降序基准 */
const QUALITY_ORDER: Quality[] = ['flac24bit', 'flac', '320k', '128k']

/** 展平后的单条来源（平台 + 原始曲目） */
interface FlatEntry {
  platform: Platform
  track: MusicInfo
}

/**
 * 时长辅键比较（±5s）：0/未知匹配任意，与 match.ts 的 isEqualsInterval 同语义
 * （避免缺时长字段的平台被误拆成独立条目）。
 */
function intervalEq(a: number, b: number): boolean {
  return Math.abs((a || b) - (b || a)) < 5
}

/** 多组音质类型求并集，去重后按档位降序返回 */
function uniqueQualities(lists: Array<MusicQualityType[] | undefined>): Quality[] {
  const set = new Set<string>()
  for (const l of lists) {
    if (!l) continue
    for (const t of l) if (t?.type) set.add(t.type)
  }
  return QUALITY_ORDER.filter((q) => set.has(q))
}

/** 去重主键：`(filterStr(name).lower, filterStr(sortSingle(singer)).lower)`（消除多歌手顺序差异） */
function mergeKey(track: MusicInfo): string {
  return `${filterStr(track.name ?? '').toLowerCase()}|${filterStr(sortSingle(track.singer ?? '')).toLowerCase()}`
}

/** 从一簇来源里挑代表条目：音质最高者优先，同档取首条（上游/评分原序） */
function pickRepresentative(items: FlatEntry[]): FlatEntry {
  let best = items[0]!
  let bestRank = qualityRankOf(best.track.types)
  for (let i = 1; i < items.length; i++) {
    const r = qualityRankOf(items[i]!.track.types)
    if (r > bestRank) { best = items[i]!; bestRank = r }
  }
  return best
}

/**
 * 把聚合结果合并去重为 MergedTrack[]（含 sources[] 与相关度评分，按分值降序）。
 * 步骤：展平（仅 ok 平台）→ 主键分组 → 组内 interval±5s 聚类 → 每簇一个 MergedTrack
 * → 跨簇算时长中位数后逐条评分（factor ③ 同基准）→ 降序。
 */
export function buildMerged(keyword: string, results: AggregatePlatformResult[]): MergedTrack[] {
  // 1) 展平
  const flat: FlatEntry[] = []
  for (const r of results) {
    if (!r.ok) continue
    for (const t of r.list) flat.push({ platform: r.platform, track: t })
  }
  // 2) 按主键分组
  const groups = new Map<string, FlatEntry[]>()
  for (const e of flat) {
    const k = mergeKey(e.track)
    const arr = groups.get(k)
    if (arr) arr.push(e)
    else groups.set(k, [e])
  }
  // 3) 组内按 interval±5s 聚类，每簇构造一个 MergedTrack
  const pending: { merged: MergedTrack; rep: MusicInfo; platform: Platform }[] = []
  for (const entries of groups.values()) {
    const clusters: { interval: number; items: FlatEntry[] }[] = []
    for (const e of entries) {
      const intv = getIntv(e.track.interval)
      let placed = false
      for (const c of clusters) {
        if (intervalEq(intv, c.interval)) {
          c.items.push(e)
          if (!c.interval && intv) c.interval = intv // 用已知时长回填簇基准
          placed = true
          break
        }
      }
      if (!placed) clusters.push({ interval: intv, items: [e] })
    }
    for (const c of clusters) {
      const rep = pickRepresentative(c.items)
      const sources: MergedSource[] = c.items.map((e) => ({
        platform: e.platform,
        songmid: e.track.songmid,
        qualities: uniqueQualities([e.track.types]),
        songInfo: e.track,
      }))
      pending.push({
        rep: rep.track,
        platform: rep.platform,
        merged: {
          name: rep.track.name ?? '',
          singer: rep.track.singer ?? '',
          albumName: rep.track.albumName ?? '',
          img: rep.track.img ?? null,
          interval: rep.track.interval,
          qualities: uniqueQualities(c.items.map((e) => e.track.types)),
          sources,
          score: 0,
        },
      })
    }
  }
  // 4) scoring pass：跨合并条目算时长中位数，逐条按代表来源打分
  const weights = platformWeights()
  const median = medianInterval(pending.map((p) => p.rep.interval))
  for (const p of pending) {
    p.merged.score = scoreTrack(keyword, p.rep, p.platform, { medianInterval: median, platformWeights: weights })
  }
  // 5) 按分值降序
  return pending.map((p) => p.merged).sort((a, b) => b.score - a.score)
}

export const searchService = {
  async searchPlatform(platform: Platform, keyword: string, page = 1, limit?: number): Promise<SearchResult> {
    const adapter = ADAPTERS[platform]
    return adapter.search(keyword, page, limit)
  },

  /**
   * 并发查询多个平台；单平台失败不影响其它平台（容错聚合）。
   * D4：叠加 8s 单平台超时 + 5min 内存缓存 + in-flight 去重。
   * limit 缺省时回落 config.search.defaultLimit（统一各平台默认条数）。
   */
  async searchAggregate(keyword: string, page = 1, platforms: Platform[] = ALL_PLATFORMS, limit?: number): Promise<AggregateSearchResult> {
    const effLimit = limit ?? aggDefaultLimit()
    const key = `${keyword}|${page}|${platforms.join(',')}|${effLimit}`
    const ttl = aggCacheTtlMs()

    const hit = aggCache.get(key)
    if (hit && Date.now() - hit.fetchedAt < ttl) return hit.data

    const flying = aggInflight.get(key)
    if (flying) return flying

    const p = runAggregate(keyword, page, platforms, effLimit)
      .then((data) => {
        // 简单 LRU：超上限先淘汰最旧（Map 保持插入序）
        if (aggCache.size >= AGG_CACHE_MAX) {
          const oldest = aggCache.keys().next().value
          if (oldest !== undefined) aggCache.delete(oldest)
        }
        aggCache.set(key, { fetchedAt: Date.now(), data })
        return data
      })
      .finally(() => {
        aggInflight.delete(key)
      })
    aggInflight.set(key, p)
    return p
  },

  /**
   * #191 J1：合并搜索。复用 searchAggregate（含 D4 超时/缓存/in-flight）后跨平台去重合并，
   * 同一曲目多平台来源折叠为一条 MergedTrack（挂全部 sources[]），叠加 J2 相关度评分并降序。
   * limit 透传给底层聚合作为各平台默认条数；total 为去重后合并条目数。
   */
  async searchMerged(
    keyword: string,
    page = 1,
    platforms: Platform[] = ALL_PLATFORMS,
    limit?: number,
  ): Promise<MergedSearchResult> {
    const agg = await searchService.searchAggregate(keyword, page, platforms, limit)
    const list = buildMerged(keyword, agg.results)
    const out: MergedSearchResult = { keyword, page, total: list.length, list }
    // #200 O4：以合并后条目数判稀疏（用户实际所见），附加纠错建议
    attachCorrection(keyword, list.length, out)
    return out
  },

  async searchSongList(platform: Platform, keyword: string, page = 1, limit?: number): Promise<SongListSearchResult> {
    return SONGLIST_ADAPTERS[platform].search(keyword, page, limit)
  },

  async searchSongListAggregate(keyword: string, page = 1, platforms: Platform[] = ALL_PLATFORMS, limit?: number): Promise<{ keyword: string; page: number; results: Array<{ platform: Platform; ok: boolean; total: number; list: SongListSearchResult['list']; error?: string }> }> {
    const settled = await Promise.allSettled(
      platforms.map((p) => SONGLIST_ADAPTERS[p].search(keyword, page, limit)),
    )
    const results = settled.map((s, i) => {
      const platform = platforms[i]!
      if (s.status === 'fulfilled') {
        return { platform, ok: true, total: s.value.total, list: s.value.list }
      }
      const error = s.reason instanceof Error ? s.reason.message : String(s.reason)
      logger.warn(`[songlist] ${platform} failed: ${error}`)
      return { platform, ok: false, total: 0, list: [] as SongListSearchResult['list'], error }
    })
    return { keyword, page, results }
  },

  async getSongListDetail(platform: Platform, id: string, page = 1): Promise<SongListDetailResult> {
    return SONGLIST_ADAPTERS[platform].getListDetail(id, page)
  },
}
