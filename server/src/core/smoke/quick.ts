/**
 * #56 · 一键快速冒烟（POST /api/v1/sources/smoke）
 *
 * 与定时全量冒烟（index.ts，平台串行 + 3s 防风控间隔，落库+告警）不同，
 * 本模块面向音源管理页的即时验证：音源串行、平台并行 ≤3、整体 60s 预算，
 * 同步返回完整矩阵（不落库、不告警、不进 smoke_results 历史）。
 *
 * 链路：search（平台官方 API 适配器，同平台结果缓存复用——音源脚本本身
 * 不提供 search action，搜索可用性反映平台 API 状态，与既有全量冒烟口径一致）
 *   → musicUrl(128k, exact, 15s 超时)
 *   → HEAD 探测（3s 超时；405/501 时回退 Range GET bytes=0-1）
 */
import needle from 'needle'
import { sourceEngine } from '../source-engine/index.js'
import { searchService, isPlatform, type Platform } from '../search/index.js'
import { isSmokeRunning } from './index.js'
import { logger } from '../logger.js'

/** 固定冒烟关键词（任务口径：命中面广，五平台均有结果） */
export const QUICK_SMOKE_KEYWORD = '周杰伦 晴天'
/** 单格 musicUrl action 超时 */
const MUSIC_URL_TIMEOUT_MS = 15_000
/** HEAD/Range 探测超时 */
const PROBE_TIMEOUT_MS = 3_000
/** 整体预算 */
const OVERALL_TIMEOUT_MS = 60_000
/** 平台并行上限（同一音源内） */
const PLATFORM_CONCURRENCY = 3

export interface QuickSmokeCell {
  source: string
  platform: string
  /** 'ok' | 'fail' | '-'（'-' = 该平台未被任何启用音源声明 / 搜索未执行） */
  search: 'ok' | 'fail' | '-'
  /** 'ok' | 'fail' | '-'（'-' = search 失败或音源未声明该平台，未走到取链） */
  url: 'ok' | 'fail' | '-'
  /** musicUrl + 探测链路耗时（ms）；search fail 的格子记录 search 耗时；未执行为 0 */
  latencyMs: number
  /** 首个失败的错误摘要（成功为 null） */
  error: string | null
}

export interface QuickSmokeResult {
  keyword: string
  startedAt: number
  finishedAt: number
  durationMs: number
  /** 整体预算是否耗尽（耗尽时未执行格子以 timeout 错误补齐） */
  timeout: boolean
  total: number
  passed: number
  failed: number
  matrix: QuickSmokeCell[]
}

let quickRunning = false

export function isQuickSmokeRunning(): boolean {
  return quickRunning
}

/** 分批并行执行（保持输入顺序收集结果） */
async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length)
  let cursor = 0
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (cursor < items.length) {
      const i = cursor++
      out[i] = await fn(items[i]!)
    }
  })
  await Promise.all(workers)
  return out
}

/** HEAD 探测；服务器禁 HEAD（405/501）时回退 Range GET bytes=0-1 */
async function probeUrl(url: string): Promise<{ ok: boolean; error?: string }> {
  if (!/^https?:\/\//.test(url)) return { ok: false, error: 'not http url' }
  try {
    const resp = await needle('head', url, {
      response_timeout: PROBE_TIMEOUT_MS,
      follow_max: 3,
      headers: { 'user-agent': 'Mozilla/5.0 RainbowSmoke/1.0' },
    })
    const code = resp.statusCode ?? 0
    if (code >= 200 && code < 400) return { ok: true }
    if (code === 405 || code === 501) {
      // HEAD 被拒：Range GET 兜底（2xx/206 且有 body 即视为可用）
      const r2 = await needle('get', url, {
        response_timeout: PROBE_TIMEOUT_MS,
        follow_max: 3,
        headers: { range: 'bytes=0-1', 'user-agent': 'Mozilla/5.0 RainbowSmoke/1.0' },
      })
      const c2 = r2.statusCode ?? 0
      if ((c2 >= 200 && c2 < 300) || c2 === 206) return { ok: true }
      return { ok: false, error: `Range GET HTTP ${c2}` }
    }
    return { ok: false, error: `HTTP ${code}` }
  } catch (err) {
    return { ok: false, error: (err as Error).message }
  }
}

interface SearchCacheEntry {
  ok: boolean
  musicInfo: unknown | null
  error: string | null
  ms: number
}

/** 跑一轮快速冒烟（同步等待全部格子完成或整体预算耗尽） */
export async function runQuickSmoke(): Promise<QuickSmokeResult> {
  if (quickRunning) throw new Error('快速冒烟已在运行中')
  if (isSmokeRunning()) throw new Error('全量冒烟测试运行中，请稍后再试')
  quickRunning = true
  try {
    return await run()
  } finally {
    quickRunning = false
  }
}

async function run(): Promise<QuickSmokeResult> {
  const startedAt = Date.now()
  const deadline = startedAt + OVERALL_TIMEOUT_MS

  const sources = sourceEngine.list().filter((s) => s.status === 'ready' && s.enabled)
  const allPlatforms = (['kw', 'kg', 'tx', 'wy', 'mg'] as const).filter(isPlatform)
  /** 需真实执行的格子（启用音源 × 其声明的平台），用于超时补齐 */
  const expected = new Set<string>()
  for (const src of sources) {
    for (const p of allPlatforms) {
      if (p in src.sources) expected.add(`${src.id}||${p}`)
    }
  }
  /** 已完成的格子（共享引用：超时 race 返回时读取现场） */
  const cells: QuickSmokeCell[] = []

  const work = (async () => {
    // ---- 阶段 1：平台搜索预取（只搜至少一个启用音源声明的平台；并行 ≤3）----
    const declaredPlatforms = allPlatforms.filter((p) => sources.some((s) => p in s.sources))
    const searchCache = new Map<Platform, SearchCacheEntry>()
    await mapLimit(declaredPlatforms, PLATFORM_CONCURRENCY, async (platform) => {
      const t = Date.now()
      try {
        const r = await searchService.searchPlatform(platform, QUICK_SMOKE_KEYWORD, 1, 5)
        if (!r.list.length) throw new Error('无搜索结果')
        searchCache.set(platform, { ok: true, musicInfo: r.list[0], error: null, ms: Date.now() - t })
      } catch (err) {
        searchCache.set(platform, { ok: false, musicInfo: null, error: (err as Error).message, ms: Date.now() - t })
      }
    })

    // ---- 阶段 2：音源串行 × 平台并行 ≤3 ----
    for (const src of sources) {
      if (Date.now() >= deadline) break
      const declared = allPlatforms.filter((p) => p in src.sources)
      await mapLimit(declared, PLATFORM_CONCURRENCY, async (platform) => {
        if (Date.now() >= deadline) return
        const search = searchCache.get(platform)
        const cell: QuickSmokeCell = {
          source: src.id,
          platform,
          search: search ? (search.ok ? 'ok' : 'fail') : '-',
          url: '-',
          latencyMs: 0,
          error: null,
        }
        if (!search || !search.ok) {
          cell.latencyMs = search?.ms ?? 0
          cell.error = search?.error ?? '搜索未执行'
          cells.push(cell)
          return
        }
        // musicUrl(128k) → HEAD/Range 探测
        const t = Date.now()
        try {
          const url = await sourceEngine.getMusicUrlExact(src.id, platform, search.musicInfo, '128k', MUSIC_URL_TIMEOUT_MS)
          const probe = await probeUrl(url)
          cell.latencyMs = Date.now() - t
          if (probe.ok) {
            cell.url = 'ok'
          } else {
            cell.url = 'fail'
            cell.error = probe.error ?? '探测失败'
          }
        } catch (err) {
          cell.latencyMs = Date.now() - t
          cell.url = 'fail'
          cell.error = (err as Error).message
        }
        cells.push(cell)
      })
    }
  })()

  const timeoutPromise = new Promise<'timeout'>((resolve) => {
    const timer = setTimeout(() => resolve('timeout'), OVERALL_TIMEOUT_MS)
    timer.unref?.()
  })
  const outcome = await Promise.race([work.then(() => 'done' as const), timeoutPromise])
  const timeout = outcome === 'timeout'
  if (timeout) work.catch(() => {}) // 后台在途格子继续收尾，结果不再计入本次响应

  // ---- 补齐：声明了但未执行到的格子标整体超时；未声明平台补干净的 '-' 格 ----
  const done = new Set(cells.map((c) => `${c.source}||${c.platform}`))
  for (const key of expected) {
    if (done.has(key)) continue
    done.add(key)
    const [source, platform] = key.split('||')
    cells.push({ source: source!, platform: platform!, search: '-', url: '-', latencyMs: 0, error: `整体超时（${OVERALL_TIMEOUT_MS / 1000}s）未执行` })
  }
  for (const src of sources) {
    for (const p of allPlatforms) {
      const key = `${src.id}||${p}`
      if (done.has(key)) continue // expected 分支已处理（完成或 timeout 补齐）
      done.add(key)
      cells.push({ source: src.id, platform: p, search: '-', url: '-', latencyMs: 0, error: null })
    }
  }

  // 稳定排序：音源在引擎中的顺序 → 平台固定序（kw kg tx wy mg）
  const platOrder = new Map(allPlatforms.map((p, i) => [p as string, i]))
  cells.sort((a, b) => {
    const si = sources.findIndex((s) => s.id === a.source) - sources.findIndex((s) => s.id === b.source)
    return si !== 0 ? si : (platOrder.get(a.platform) ?? 99) - (platOrder.get(b.platform) ?? 99)
  })

  const passed = cells.filter((c) => c.search === 'ok' && c.url === 'ok').length
  const failed = cells.filter((c) => c.search === 'fail' || c.url === 'fail').length
  const result: QuickSmokeResult = {
    keyword: QUICK_SMOKE_KEYWORD,
    startedAt,
    finishedAt: Date.now(),
    durationMs: Date.now() - startedAt,
    timeout,
    total: cells.length,
    passed,
    failed,
    matrix: cells,
  }
  logger.info(
    { sources: sources.length, total: result.total, passed, failed, timeout, durationMs: result.durationMs },
    '[quick-smoke] done',
  )
  return result
}
