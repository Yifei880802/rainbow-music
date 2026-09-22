/**
 * #191 J3：拼音 / 首字母匹配内核
 *
 * 用途：让搜索关键词支持拼音全拼与首字母命中中文歌名/歌手/专辑。
 *   输入 `zjl` 命中「周杰伦」，`qingtian` 命中「晴天」，`zhoujielun` 命中「周杰伦」。
 *
 * 依赖 pinyin-pro（#191 新增）。设计要点：
 *   - 全拼/首字母均按「整串连写小写」比对（子串包含），避免分词歧义；
 *   - 结果带 Map 缓存 + LRU 上限，聚合/合并视图对同批 name/singer 反复求拼音时零重复计算；
 *   - tokenize() 支持空格切分 + 中文 2-gram，多关键词按 token 命中率加权（供 J2 评分复用）；
 *   - 纯函数、无 IO：单测可直接注入文本验证命中。
 *
 * 说明：#190 已用 Intl 拼音 collator 实现下载目录 {singerFirstLetter} 占位符（首字母排序），
 * 与此处目标不同——本模块用 pinyin-pro 做「全拼 + 首字母子串匹配」，不复用 collator。
 */
import { pinyin } from 'pinyin-pro'

/** 拼音缓存上限（超出按插入序淘汰最旧，防长尾文本无限堆积） */
const PINYIN_CACHE_MAX = 4000

const fullCache = new Map<string, string>()
const firstCache = new Map<string, string>()

/** 读缓存 + LRU 淘汰（Map 保持插入序，超限先删最旧） */
function cacheGet(cache: Map<string, string>, key: string): string | undefined {
  const v = cache.get(key)
  if (v !== undefined) {
    // 命中即刷新为新近（删除再插入，维持 LRU 语义）
    cache.delete(key)
    cache.set(key, v)
  }
  return v
}

function cacheSet(cache: Map<string, string>, key: string, value: string): void {
  if (cache.size >= PINYIN_CACHE_MAX) {
    const oldest = cache.keys().next().value
    if (oldest !== undefined) cache.delete(oldest)
  }
  cache.set(key, value)
}

/** 仅保留中文/字母/数字，其余（空格标点）剔除后小写——拼音连写比对前的归一化 */
function stripNonWord(s: string): string {
  return s.replace(/[^\u4e00-\u9fa5a-z0-9]/gi, '').toLowerCase()
}

/**
 * 全拼连写（无声调、小写）：'周杰伦' → 'zhoujielun'，'晴天' → 'qingtian'。
 * 非中文字符原样保留其字母/数字（pinyin-pro 对非汉字返回原字符）。
 */
export function toPinyinFull(text: string): string {
  const raw = (text ?? '').trim()
  if (!raw) return ''
  const cached = cacheGet(fullCache, raw)
  if (cached !== undefined) return cached
  const arr = pinyin(raw, { toneType: 'none', type: 'array', nonZh: 'consecutive' }) as string[]
  const out = stripNonWord(arr.join(''))
  cacheSet(fullCache, raw, out)
  return out
}

/**
 * 首字母连写（小写）：'周杰伦' → 'zjl'，'晴天' → 'qt'。
 * 非中文字符取其首字母（pinyin-pro pattern:'first' 对字母返回该字母）。
 */
export function toPinyinFirst(text: string): string {
  const raw = (text ?? '').trim()
  if (!raw) return ''
  const cached = cacheGet(firstCache, raw)
  if (cached !== undefined) return cached
  const arr = pinyin(raw, { pattern: 'first', toneType: 'none', type: 'array', nonZh: 'consecutive' }) as string[]
  const out = stripNonWord(arr.join(''))
  cacheSet(firstCache, raw, out)
  return out
}

/**
 * 文本是否被关键词命中（三通道任一成立即命中）：
 *   1) direct：归一化后文本直接包含关键词（子串）——支持英文/数字/中文原样；
 *   2) full  ：文本全拼连写包含关键词（关键词视为拼音）——`qingtian` 命中「晴天」；
 *   3) first ：文本首字母连写包含关键词——`zjl` 命中「周杰伦」。
 * 关键词为空返回 false（不构成命中）。
 */
export function matchesPinyin(text: string, keyword: string): boolean {
  const kw = stripNonWord(keyword ?? '')
  if (!kw) return false
  const t = stripNonWord(text ?? '')
  if (!t) return false
  if (t.includes(kw)) return true
  if (toPinyinFull(text).includes(kw)) return true
  if (toPinyinFirst(text).includes(kw)) return true
  return false
}

/**
 * 多关键词 tokenize：
 *   - 先按空白切分为若干词；
 *   - 每个纯中文词再生成 2-gram（长度≥2 时），提升「周杰」命中「周杰伦」的召回；
 *   - 去重、剔除空串。
 * 例：'周杰伦 晴天' → ['周杰伦','周杰','杰伦','晴天']（2-gram 仅对中文词展开）。
 */
export function tokenize(query: string): string[] {
  const parts = (query ?? '').trim().split(/\s+/).filter(Boolean)
  const out: string[] = []
  const seen = new Set<string>()
  const push = (t: string) => {
    const k = t.trim()
    if (!k || seen.has(k)) return
    seen.add(k)
    out.push(k)
  }
  for (const p of parts) {
    push(p)
    // 纯中文词展开 2-gram
    if (/^[\u4e00-\u9fa5]{2,}$/.test(p)) {
      for (let i = 0; i + 2 <= p.length; i++) push(p.slice(i, i + 2))
    }
  }
  return out
}

/**
 * token 命中率：给定 token 列表与一组字段文本，返回「命中 token 数 / token 总数」∈[0,1]。
 * 任一字段命中该 token（走 matchesPinyin 三通道）即算命中。tokens 为空返回 0。
 */
export function tokenHitRate(tokens: string[], fields: Array<string | undefined>): number {
  if (!tokens.length) return 0
  const texts = fields.filter((f): f is string => typeof f === 'string' && f.length > 0)
  if (!texts.length) return 0
  let hit = 0
  for (const tk of tokens) {
    if (texts.some((t) => matchesPinyin(t, tk))) hit++
  }
  return hit / tokens.length
}
