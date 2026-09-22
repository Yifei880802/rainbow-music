/**
 * #191 J2：本地相关度评分（scoring pass）
 *
 * 在 searchAggregate / searchMerged 返回前对每条结果打分并据此排序，让「最像关键词、
 * 音质最好、时长最主流、平台权重最高」的结果排前面。纯本地计算，不依赖上游排序。
 *
 * 评分因子（任务书 J2）：
 *   ① filterStr(name) == keyword（精确）           → 大额加分
 *   ② filterStr(singer) 包含 keyword（或拼音命中） → 中额加分
 *   ③ interval 与结果集中位数的偏差                → 偏差越大扣分越多（冷门/错版降权）
 *   ④ 音质档位 flac24bit > flac > 320k > 128k      → 阶梯加分
 *   ⑤ 平台权重 search.platformWeights（乘数）      → 对总分做平台加权
 * 叠加 J3 拼音/首字母：name/singer/albumName 走 matchesPinyin 三通道命中同样加分，
 * 多关键词按 tokenize() 的 token 命中率加权。
 *
 * finalScore = (textScore + qualityScore + intervalScore) * platformWeight
 *
 * 纯函数、无 IO：单测可直接注入 MusicInfo 夹具验证分值单调性。
 */
import type { MusicInfo, MusicQualityType } from '../adapters/common.js'
import { filterStr, getIntv } from '../adapters/match.js'
import { matchesPinyin, tokenize, tokenHitRate } from './pinyin.js'

/** 音质档位分值（flac24bit > flac > 320k > 128k） */
const QUALITY_SCORE: Record<string, number> = {
  flac24bit: 16,
  flac: 12,
  '320k': 8,
  '128k': 4,
}

/** 音质档位排名（0=无，1=128k … 4=flac24bit），供 merged 音质并集/排序复用 */
const QUALITY_RANK: Record<string, number> = {
  '128k': 1,
  '320k': 2,
  flac: 3,
  flac24bit: 4,
}

/** 文本命中分值常量（集中定义，便于单测断言相对大小） */
const W = {
  nameExact: 100, // 歌名归一化后与关键词完全相等
  nameContains: 60, // 歌名包含关键词（含拼音全拼/首字母命中）
  singerMatch: 40, // 歌手包含关键词（含拼音命中）
  albumMatch: 10, // 专辑名命中
  tokenMax: 50, // 多关键词 token 命中率上限加分（命中率 × 50）
  intervalMaxPenalty: 20, // 时长偏离中位数的最大扣分
}

/** 取一组音质类型里的最高档分值 */
export function qualityScoreOf(types: MusicQualityType[] | undefined): number {
  if (!types?.length) return 0
  let best = 0
  for (const t of types) best = Math.max(best, QUALITY_SCORE[t.type] ?? 0)
  return best
}

/** 取一组音质类型里的最高档排名（0-4）；merged 用它挑代表音质 */
export function qualityRankOf(types: MusicQualityType[] | undefined): number {
  if (!types?.length) return 0
  let best = 0
  for (const t of types) best = Math.max(best, QUALITY_RANK[t.type] ?? 0)
  return best
}

/** 时长偏离中位数的扣分：偏差 ≤2s 不扣，之后每 3s 扣 1 分，封顶 intervalMaxPenalty */
export function intervalPenalty(interval: string | 0 | undefined, median: number | undefined): number {
  if (!median || median <= 0) return 0
  const intv = getIntv(interval)
  if (!intv) return 0 // 时长未知不参与惩罚（避免误伤缺字段平台）
  const dev = Math.abs(intv - median)
  if (dev <= 2) return 0
  return Math.min(W.intervalMaxPenalty, Math.round((dev - 2) / 3))
}

/** 文本相关度分值（不含音质/时长/平台权重） */
export function textScore(keyword: string, track: Pick<MusicInfo, 'name' | 'singer' | 'albumName'>): number {
  const normKw = filterStr(keyword).toLowerCase()
  if (!normKw) return 0
  let score = 0

  const normName = filterStr(track.name ?? '').toLowerCase()
  // ① 歌名精确相等（归一化后）
  if (normName && normName === normKw) {
    score += W.nameExact
  } else if (normName.includes(normKw) || matchesPinyin(track.name ?? '', keyword)) {
    // ② 歌名包含关键词，或拼音全拼/首字母命中（qingtian→晴天 / qt→晴天）
    score += W.nameContains
  }

  // 歌手命中（子串或拼音）
  const singer = track.singer ?? ''
  const normSinger = filterStr(singer).toLowerCase()
  if (normSinger && (normSinger.includes(normKw) || matchesPinyin(singer, keyword))) {
    score += W.singerMatch
  }

  // 专辑命中
  const album = track.albumName ?? ''
  if (album && (filterStr(album).toLowerCase().includes(normKw) || matchesPinyin(album, keyword))) {
    score += W.albumMatch
  }

  // 多关键词 token 命中率加权（空格切分 + 中文 2-gram）
  const tokens = tokenize(keyword)
  if (tokens.length > 1) {
    const rate = tokenHitRate(tokens, [track.name, track.singer, track.albumName])
    score += Math.round(rate * W.tokenMax)
  }

  return score
}

export interface ScoreOptions {
  /** 结果集时长中位数（秒）；缺省则不做时长惩罚 */
  medianInterval?: number
  /** 平台权重乘数表（search.platformWeights）；缺省该平台按 1.0 */
  platformWeights?: Record<string, number>
}

/**
 * 对单条结果打分。返回 ≥0 的浮点分值（保留 2 位小数）。
 * platform 用于取平台权重乘数。
 */
export function scoreTrack(
  keyword: string,
  track: Pick<MusicInfo, 'name' | 'singer' | 'albumName' | 'interval' | 'types'>,
  platform: string,
  opts: ScoreOptions = {},
): number {
  const base =
    textScore(keyword, track) +
    qualityScoreOf(track.types) -
    intervalPenalty(track.interval, opts.medianInterval)
  const weight = opts.platformWeights?.[platform]
  const w = typeof weight === 'number' && Number.isFinite(weight) ? weight : 1
  const final = Math.max(0, base) * w
  return Math.round(final * 100) / 100
}

/** 求一组时长（秒，忽略 0/未知）的中位数；空集返回 0 */
export function medianInterval(intervals: Array<string | 0 | undefined>): number {
  const nums = intervals.map((i) => getIntv(i)).filter((n) => n > 0).sort((a, b) => a - b)
  if (!nums.length) return 0
  const mid = Math.floor(nums.length / 2)
  return nums.length % 2 ? nums[mid]! : Math.round((nums[mid - 1]! + nums[mid]!) / 2)
}

/**
 * 批量评分：先按结果集算时长中位数，再对每条打分，返回与入参等长的分值数组。
 * platformOf 提供每条结果所属平台（用于平台权重）。
 */
export function scoreTracks<T extends Pick<MusicInfo, 'name' | 'singer' | 'albumName' | 'interval' | 'types'>>(
  keyword: string,
  tracks: T[],
  platformOf: (t: T, i: number) => string,
  opts: Omit<ScoreOptions, 'medianInterval'> = {},
): number[] {
  const median = medianInterval(tracks.map((t) => t.interval))
  return tracks.map((t, i) => scoreTrack(keyword, t, platformOf(t, i), { ...opts, medianInterval: median }))
}
