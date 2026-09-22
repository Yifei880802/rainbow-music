/**
 * L1/L2: 音源健康编排与熔断
 *
 * L1 —— 健康度聚合（离线信号）：从 smoke_results 聚合每个音源「近 N 次冒烟 run」的
 *   整体成功率。orchestrator.resolveSourceOrder() 据此把「近 N 次全失败」的音源降权
 *   （排到候选末尾），优先尝试健康音源，减少每任务在坏源上白跑 30s。
 *   开关 config.sources.healthAware（默认 true）。
 *
 * L2 —— 熔断器（在线信号）：运行期同一 sourceId 在滑动窗口内连续失败累计 ≥K 次即
 *   「打开」，后续任务临时把该源从候选剔除（窗口内失败自然老化后自动「半开」恢复）。
 *   阈值 config.sources.circuitThreshold（默认 5）、窗口 config.sources.circuitWindowMs
 *   （默认 300000）。与 L1 互补：L1 靠定时冒烟的历史，L2 靠实时下载失败的即时反馈。
 *
 * 两个信号都遵循「绝不清空候选」原则：若剔除后为空则回退原候选（half-open 允许再试），
 * 避免把「暂时抖动」放大成 ERR_NO_SOURCE 永久失败。
 */
import { initDb } from '../db/index.js'
import { config } from '../config.js'
import { logger } from '../logger.js'

/** 单音源健康快照 */
export interface SourceHealth {
  /** 近 N 次 run 的成功率 0..1（无数据时视为 1=中性，不降权） */
  rate: number
  /** 参与统计的 run 次数 */
  runs: number
  /** 近 N 次是否「全失败」（达到统计窗口且成功数为 0）→ L1 降权依据 */
  allRecentFailed: boolean
}

/** 健康聚合的 run 采样深度（近 N 次冒烟） */
const HEALTH_SAMPLE_RUNS = 5
/** 健康聚合结果内存缓存 TTL：冒烟是低频事件（默认每日 6 点），30s 缓存足够新鲜且省查询 */
const HEALTH_CACHE_TTL_MS = 30_000

let healthCache: { at: number; map: Map<string, SourceHealth> } | null = null

/**
 * 聚合 smoke_results 得到每个音源的健康快照（source 级，跨平台合并：任一平台失败即该 run 失败）。
 * 表不存在（冒烟从未运行）或查询异常时返回空 Map（消费侧视为全中性，不降权、不熔断），
 * 保证首启/无冒烟历史时行为与 L 特性引入前完全一致。
 */
export function computeSourceHealth(sampleRuns = HEALTH_SAMPLE_RUNS): Map<string, SourceHealth> {
  const now = Date.now()
  if (healthCache && now - healthCache.at < HEALTH_CACHE_TTL_MS) return healthCache.map
  const map = new Map<string, SourceHealth>()
  try {
    const db = initDb()
    // 按 (source_id, run_id) 聚合：MIN(ok)=0 表示该 run 内任一步骤失败即整 run 失败
    const rows = db
      .prepare(
        `SELECT source_id, run_id, MIN(ok) AS all_ok, MAX(created_at) AS ts
         FROM smoke_results
         GROUP BY source_id, run_id`,
      )
      .all() as { source_id: string; run_id: string; all_ok: number; ts: number }[]
    const bySource = new Map<string, { all_ok: number; ts: number }[]>()
    for (const r of rows) {
      const arr = bySource.get(r.source_id) ?? []
      arr.push({ all_ok: r.all_ok, ts: r.ts })
      bySource.set(r.source_id, arr)
    }
    for (const [sid, runs] of bySource) {
      runs.sort((a, b) => b.ts - a.ts)
      const recent = runs.slice(0, sampleRuns)
      const okCount = recent.filter((r) => r.all_ok === 1).length
      const rate = recent.length ? okCount / recent.length : 1
      // 「全失败」需达到采样深度才判定，避免只跑过 1 次失败就被降权（样本不足）
      const allRecentFailed = recent.length >= sampleRuns && okCount === 0
      map.set(sid, { rate, runs: recent.length, allRecentFailed })
    }
  } catch (err) {
    // smoke_results 尚未建表（冒烟从未运行）等：中性返回，不阻断下载链路
    logger.debug({ err: (err as Error).message }, '[source-health] 健康聚合不可用，按中性处理')
  }
  healthCache = { at: now, map }
  return map
}

/** 测试/手动刷新用：清空健康缓存，下次 computeSourceHealth 强制重查 */
export function invalidateHealthCache(): void {
  healthCache = null
}

/**
 * L1: 按健康度稳定排序候选音源——「近 N 次全失败」的源降到末尾，其余保持原相对顺序。
 * 用「装饰-排序-还原」保证稳定性（Array.prototype.sort 在现代 V8 已稳定，此处显式带原始
 * 下标兜底，避免依赖实现细节）。
 */
export function orderByHealth(ids: string[], health: Map<string, SourceHealth>): string[] {
  const decorated = ids.map((id, i) => ({ id, i, deprioritized: health.get(id)?.allRecentFailed ? 1 : 0 }))
  decorated.sort((a, b) => a.deprioritized - b.deprioritized || a.i - b.i)
  return decorated.map((d) => d.id)
}

/**
 * L2: 音源级滑动窗口熔断器（进程内内存态；重启即清零，符合「临时剔除」语义）。
 * recordFailure 累计窗口内失败时间戳；recordSuccess 立即清零（连续失败语义）；
 * isOpen 判定窗口内失败数是否达到阈值（并顺带老化窗口外的时间戳）。
 */
export class SourceCircuitBreaker {
  private fails = new Map<string, number[]>()

  private threshold(): number {
    const t = config.sources.circuitThreshold
    return typeof t === 'number' && t > 0 ? t : 5
  }

  private windowMs(): number {
    const w = config.sources.circuitWindowMs
    return typeof w === 'number' && w > 0 ? w : 300_000
  }

  /** 记录一次失败（追加时间戳，窗口外的顺带老化） */
  recordFailure(sourceId: string): void {
    const now = Date.now()
    const w = this.windowMs()
    const arr = (this.fails.get(sourceId) ?? []).filter((t) => now - t <= w)
    arr.push(now)
    this.fails.set(sourceId, arr)
  }

  /** 记录一次成功：连续失败计数清零，熔断立即关闭 */
  recordSuccess(sourceId: string): void {
    this.fails.delete(sourceId)
  }

  /** 窗口内失败数是否已达阈值（true=熔断打开，应临时剔除） */
  isOpen(sourceId: string): boolean {
    const arr = this.fails.get(sourceId)
    if (!arr || arr.length === 0) return false
    const now = Date.now()
    const w = this.windowMs()
    const recent = arr.filter((t) => now - t <= w)
    if (recent.length !== arr.length) this.fails.set(sourceId, recent)
    return recent.length >= this.threshold()
  }

  /** 窗口内失败计数快照（诊断/测试用） */
  failCount(sourceId: string): number {
    const arr = this.fails.get(sourceId)
    if (!arr) return 0
    const now = Date.now()
    const w = this.windowMs()
    return arr.filter((t) => now - t <= w).length
  }

  /** 手动复位（省略参数则清空全部；测试/管理端用） */
  reset(sourceId?: string): void {
    if (sourceId === undefined) this.fails.clear()
    else this.fails.delete(sourceId)
  }
}

/** 全局单例熔断器（orchestrator 记录、resolveSourceOrder 查询，两路共享同一状态） */
export const sourceCircuit = new SourceCircuitBreaker()

/**
 * L2: 从候选中剔除熔断打开的音源。若剔除后为空（全部熔断）则回退原候选，
 * 保留 half-open 重试机会——绝不因熔断把候选清空成 ERR_NO_SOURCE。
 */
export function filterCircuitOpen(ids: string[]): string[] {
  const kept = ids.filter((id) => !sourceCircuit.isOpen(id))
  return kept.length > 0 ? kept : ids
}
