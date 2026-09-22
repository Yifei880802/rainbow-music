/**
 * M1: 结构化错误码基础设施
 *
 * 贯穿 download/index.ts、orchestrator/index.ts、queue.ts：把异构的失败原因
 * （DNS/超时/HTTP 4xx-5xx/无音源/全源失败/标签嵌入/磁盘满）归一为一组稳定的
 * 错误码，供三处消费：
 *   1. download_tasks.error 存 `{code,message}` JSON（decodeError 向后兼容旧纯字符串）；
 *   2. download_attempts.error_code（M2 每次换源/重试的审计轨迹）；
 *   3. HTTP 响应（O1 preview / N3 磁盘满 → errorToStatus 映射状态码）。
 *
 * 与 #190 的 Transient/Permanent 分级协同：分级决定「是否重试/熔断」（队列侧用
 * isTransientHttpError / isPermanentHttpError 鸭子类型判定），错误码决定「如何呈现/审计」。
 * 两者互不替代：429 是 TransientHttpError（重试），错误码归 ERR_HTTP_4XX（呈现）。
 *
 * 刻意用鸭子类型（name / httpStatus / attempts 字段探测）而非 instanceof：
 * 避免 errors.ts ↔ download/index.ts ↔ orchestrator/index.ts 的循环导入。
 */

/** M1: 归一化错误码枚举 */
export type ErrorCode =
  | 'ERR_DNS'
  | 'ERR_TIMEOUT'
  | 'ERR_HTTP_4XX'
  | 'ERR_HTTP_5XX'
  | 'ERR_NO_SOURCE'
  | 'ERR_ALL_SOURCES_FAILED'
  | 'ERR_TAG_EMBED'
  | 'ERR_DISK_FULL'
  | 'ERR_BAD_REQUEST'
  | 'ERR_UNKNOWN'

/**
 * N3: 磁盘可用空间不足。enqueue() 前预检抛出，路由侧映射 507 + ERR_DISK_FULL。
 * name 判定（鸭子类型）供 classifyError / isDiskFullError 跨模块安全识别。
 */
export class DiskFullError extends Error {
  readonly free: number
  readonly required: number
  constructor(free: number, required: number) {
    super(`磁盘可用空间不足（free ${free} bytes < required ${required} bytes）`)
    this.name = 'DiskFullError'
    this.free = free
    this.required = required
  }
}

/** 鸭子类型判定：是否磁盘空间不足错误 */
export function isDiskFullError(err: unknown): boolean {
  return typeof err === 'object' && err !== null && (err as Error).name === 'DiskFullError'
}

/** 按错误消息文本归类（用于只有 string 的场景，如 ResolveAttempt.error） */
function classifyMessage(raw: string): ErrorCode {
  const m = raw.toLowerCase()
  if (/(enotfound|eai_again|getaddrinfo|dns)/.test(m) || /解析.{0,4}失败/.test(raw)) return 'ERR_DNS'
  if (/(timeout|etimedout|esockettimedout|stall)/.test(m) || /(停滞|超时)/.test(raw)) return 'ERR_TIMEOUT'
  if (/(标签嵌入|元数据嵌入|tag embed)/.test(raw)) return 'ERR_TAG_EMBED'
  if (/(没有可用音源|no source|no-source)/.test(m) || /没有可用音源/.test(raw)) return 'ERR_NO_SOURCE'
  if (/(所有音源|all sources)/.test(m) || /所有音源/.test(raw)) return 'ERR_ALL_SOURCES_FAILED'
  if (/http\s*5\d\d/.test(m)) return 'ERR_HTTP_5XX'
  if (/http\s*4\d\d/.test(m)) return 'ERR_HTTP_4XX'
  return 'ERR_UNKNOWN'
}

/**
 * M1: 把任意失败原因归一为错误码。
 * 判定顺序（先受控标记，后文本兜底）：
 *   DiskFullError → ERR_DISK_FULL；NoSourceError → ERR_NO_SOURCE；
 *   带 attempts 数组（orchestrator 全源失败上抛）→ ERR_ALL_SOURCES_FAILED；
 *   带 httpStatus（#190 HttpStatusError 及其包装）→ 5xx/4xx；
 *   其余按 message 文本正则归类；无法识别 → ERR_UNKNOWN。
 */
export function classifyError(err: unknown): ErrorCode {
  if (typeof err === 'string') return classifyMessage(err)
  if (typeof err !== 'object' || err === null) return 'ERR_UNKNOWN'
  const e = err as { name?: string; httpStatus?: number; attempts?: unknown; message?: string }
  if (e.name === 'DiskFullError') return 'ERR_DISK_FULL'
  if (e.name === 'NoSourceError') return 'ERR_NO_SOURCE'
  if (Array.isArray(e.attempts)) return 'ERR_ALL_SOURCES_FAILED'
  if (typeof e.httpStatus === 'number') return e.httpStatus >= 500 ? 'ERR_HTTP_5XX' : 'ERR_HTTP_4XX'
  return classifyMessage(typeof e.message === 'string' ? e.message : String(err))
}

/** M1: download_tasks.error 的结构化载荷 */
export interface EncodedError {
  code: ErrorCode
  message: string
}

/** M1: 编码为落盘用 JSON 字符串（`{code,message}`） */
export function encodeError(code: ErrorCode, message: string): string {
  return JSON.stringify({ code, message } satisfies EncodedError)
}

/** 便捷封装：直接从任意错误编码（classifyError + message 提取） */
export function encodeErrorFrom(err: unknown): string {
  const message = err instanceof Error ? err.message : String(err)
  return encodeError(classifyError(err), message)
}

/**
 * M1: 解码 download_tasks.error。
 * 向后兼容：旧库存的是纯字符串（非 JSON），读取不崩——归为 ERR_UNKNOWN + 原文，
 * 前端仍能拿到 message 文案。新库存 `{code,message}` JSON 则原样还原。
 */
export function decodeError(raw: string | null | undefined): EncodedError | null {
  if (raw == null || raw === '') return null
  const trimmed = raw.trim()
  if (trimmed.startsWith('{')) {
    try {
      const obj = JSON.parse(trimmed) as { code?: unknown; message?: unknown }
      if (obj && typeof obj.code === 'string') {
        return { code: obj.code as ErrorCode, message: typeof obj.message === 'string' ? obj.message : raw }
      }
    } catch {
      /* 非合法 JSON → 落到向后兼容分支 */
    }
  }
  return { code: 'ERR_UNKNOWN', message: raw }
}

/**
 * 错误码 → HTTP 状态码映射（O1 preview / N3 磁盘满 / 通用下载失败呈现）。
 * 语义：507 磁盘满、503 无音源、504 超时、400 入参非法、其余上游/未知失败归 502。
 */
export function errorToStatus(code: ErrorCode): number {
  switch (code) {
    case 'ERR_DISK_FULL':
      return 507
    case 'ERR_NO_SOURCE':
      return 503
    case 'ERR_TIMEOUT':
      return 504
    case 'ERR_BAD_REQUEST':
      return 400
    default:
      return 502
  }
}
