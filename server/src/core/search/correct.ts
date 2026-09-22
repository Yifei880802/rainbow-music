/**
 * P2 搜索高阶 O4（#200）：本地错字容错（编辑距离 ≤ 1 词典纠错）
 *
 * 目标：当聚合/合并搜索结果过少（< search.correctMinResults）时，用「历史成功搜索词」
 * 作词典，找出与用户输入编辑距离 ≤ 1 的高频候选，作为**纠错建议**返回给前端
 * （「已为你搜索 X，仍要搜索 Y?」）。**绝不自动替换用户原词**——是否改用建议由用户决定。
 *
 * 词典来源：search_history 表全时段高频词（searchHistoryStore.globalTop(0, N)），
 * 以频次 count 作打分权重（越多人搜过的词越可能是正确写法）。
 *
 * 设计要点：
 *   - capped Levenshtein（上限 1）：一旦某行最小值 > max 立即剪枝返回，避免整表 DP；
 *   - 词典带 60s 内存缓存 + LRU 上限，纠错仅在结果稀疏时触发，DB 压力可忽略；
 *   - 归一化：trim + 小写（英文大小写差异不算错字）；比对在归一化空间进行，
 *     但返回的 corrected 用词典里的**原词**（保留用户历史的真实写法）；
 *   - 纯函数 editDistanceWithin 无 IO，供单测直接验证。
 */
import { searchHistoryStore } from '../db/searchHistory.js'

export interface CorrectionResult {
  /** 建议改搜的词（词典中的高频原词） */
  corrected: string
  /** 用户原始输入（trim 后） */
  correctedFrom: string
}

/** 词典候选上限（取全时段高频前 N 词，够覆盖常见错字，避免全表加载） */
const DICT_MAX = 500
/** 词典内存缓存 TTL：60s（纠错仅结果稀疏时触发，无需强实时） */
const DICT_TTL_MS = 60_000

/** 归一化：trim + 小写（大小写差异不视为错字；保留中文/标点原样） */
function norm(s: string): string {
  return (s ?? '').trim().toLowerCase()
}

/**
 * capped Levenshtein：判断 a、b 的编辑距离是否 ≤ max，是则返回实际距离，否则返回 max+1。
 * 经典 DP 滚动数组 + 行最小值剪枝：任一行全部 > max 即可断定距离 > max，提前返回。
 * max 通常取 1，故绝大多数不匹配对在第一行即剪枝，代价远低于完整 O(n·m)。
 */
export function editDistanceWithin(a: string, b: string, max: number): number {
  const s = norm(a)
  const t = norm(b)
  if (s === t) return 0
  // 长度差已超 max，直接判负（无需 DP）
  if (Math.abs(s.length - t.length) > max) return max + 1
  const n = s.length
  const m = t.length
  let prev = new Array<number>(m + 1)
  let curr = new Array<number>(m + 1)
  for (let j = 0; j <= m; j++) prev[j] = j
  for (let i = 1; i <= n; i++) {
    curr[0] = i
    let rowMin = curr[0]
    for (let j = 1; j <= m; j++) {
      const cost = s[i - 1] === t[j - 1] ? 0 : 1
      curr[j] = Math.min(prev[j]! + 1, curr[j - 1]! + 1, prev[j - 1]! + cost)
      if (curr[j]! < rowMin) rowMin = curr[j]!
    }
    if (rowMin > max) return max + 1 // 剪枝：本行最小值已超上限
    ;[prev, curr] = [curr, prev]
  }
  return prev[m]! <= max ? prev[m]! : max + 1
}

// ---------- 词典缓存 ----------

interface DictEntry {
  /** 词典原词（历史真实写法，返回给前端） */
  word: string
  /** 归一化形式（比对用） */
  key: string
  /** 频次权重 */
  count: number
}

let dictCache: { at: number; entries: DictEntry[] } | null = null

/** 取词典（60s 缓存）：全时段高频搜索词，去重归一化键（同键保留最高频原词）。 */
function getDict(): DictEntry[] {
  if (dictCache && Date.now() - dictCache.at < DICT_TTL_MS) return dictCache.entries
  const rows = searchHistoryStore.globalTop(0, DICT_MAX)
  const byKey = new Map<string, DictEntry>()
  for (const r of rows) {
    const word = (r.kw ?? '').trim()
    if (!word) continue
    const key = norm(word)
    if (!key) continue
    const prev = byKey.get(key)
    // 同归一化键保留频次更高者的原词
    if (!prev || r.count > prev.count) byKey.set(key, { word, key, count: r.count })
  }
  const entries = Array.from(byKey.values())
  dictCache = { at: Date.now(), entries }
  return entries
}

/** 测试钩子：清空词典缓存（构造新历史后强制重载）。 */
export function clearCorrectDictCache(): void {
  dictCache = null
}

/**
 * 计算纠错建议：在词典中找与 kw 编辑距离 ≤ 1 的候选，取频次最高者。
 *
 * - kw 为空 / 词典为空 / 无 ≤1 候选 → 返回 null（不纠错）；
 * - 命中候选与 kw 归一化后相同（即原词本就在词典里）→ 返回 null（无需纠错）；
 * - 只返回**建议**，不修改任何调用方状态。
 *
 * @param kw 用户原始搜索词
 * @param maxDistance 允许的最大编辑距离，默认 1（O4 规格）
 */
export function correctKeyword(kw: string, maxDistance = 1): CorrectionResult | null {
  const from = (kw ?? '').trim()
  const nkw = norm(from)
  if (!nkw) return null
  const dict = getDict()
  if (!dict.length) return null
  let best: DictEntry | null = null
  for (const e of dict) {
    if (e.key === nkw) return null // 原词就是高频词，无需纠错
    // 长度差剪枝在 editDistanceWithin 内做；此处仅取 ≤ maxDistance 的候选
    if (editDistanceWithin(from, e.word, maxDistance) <= maxDistance) {
      // 频次高者优先；同频取更短词（更可能是规范写法），再同则字典序，保证确定性
      if (
        !best ||
        e.count > best.count ||
        (e.count === best.count && e.word.length < best.word.length) ||
        (e.count === best.count && e.word.length === best.word.length && e.word < best.word)
      ) {
        best = e
      }
    }
  }
  if (!best) return null
  return { corrected: best.word, correctedFrom: from }
}
