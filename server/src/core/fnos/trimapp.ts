/**
 * fnOS 开放 API（apiscope）可选客户端（模块四预留件）
 *
 * 环境门控（全部满足才 enabled，缺一即优雅降级空实现）：
 *   - process.env.TRIM_API_TOKEN 已配置（官方仅向生命周期脚本注入，容器常态缺失）
 *   - Unix Socket /var/run/trim_open_gateway_apiscope.socket 存在（TRIM_API_SOCKET 可覆盖，
 *     仅供本机单元自测注入 mock 网关，默认值与官方路径一致）
 *
 * 能力封装（POST http over unix socket，Bearer 鉴权）：
 *   - getUserAccessibleFolders(uid)：用户可访问目录列表
 *   - checkUserACL(uid, path)：目录 ACL 校验
 *   真机接口路径/负载契约在模块七联调时校准（当前按 POST {action, params} 单端点约定实现，
 *   非硬依赖：任何失败均返回 null，调用方按「无数据」降级）。
 *
 * 护栏：LRU+TTL 缓存 60s（容量 128，命中刷新新鲜度）/ 并发上限 4 / 请求超时 3s /
 * 响应体上限 1MB。本任务只实现与自测，不接入任何路由（接入面由模块七真机联调决定）。
 */
import http from 'node:http'
import fs from 'node:fs'

const DEFAULT_SOCKET_PATH = '/var/run/trim_open_gateway_apiscope.socket'
const TOKEN = process.env.TRIM_API_TOKEN ?? ''

function socketPath(): string {
  return process.env.TRIM_API_SOCKET || DEFAULT_SOCKET_PATH
}

/** 门控：token 已配置且 socket 是 Unix socket 文件 */
function isEnabled(): boolean {
  if (!TOKEN) return false
  try {
    return fs.statSync(socketPath()).isSocket()
  } catch {
    return false // ENOENT 等：容器内无网关挂载 → 降级
  }
}

// ── LRU + TTL 缓存（Map 插入序即 LRU 序；命中重插刷新新鲜度）──
const CACHE_TTL_MS = 60_000
const CACHE_MAX = 128
interface CacheEntry {
  value: unknown
  expiresAt: number
}
const cache = new Map<string, CacheEntry>()

function cacheGet(key: string): { hit: boolean; value: unknown } {
  const e = cache.get(key)
  if (!e) return { hit: false, value: undefined }
  if (Date.now() >= e.expiresAt) {
    cache.delete(key)
    return { hit: false, value: undefined }
  }
  cache.delete(key)
  cache.set(key, e) // 重插 = LRU 新鲜度刷新
  return { hit: true, value: e.value }
}

function cachePut(key: string, value: unknown): void {
  cache.delete(key)
  cache.set(key, { value, expiresAt: Date.now() + CACHE_TTL_MS })
  if (cache.size > CACHE_MAX) {
    const oldest = cache.keys().next().value
    if (oldest !== undefined) cache.delete(oldest)
  }
}

/** 仅测试用：清空缓存（单元自测验证 TTL/LRU 行为） */
export function _clearCacheForTest(): void {
  cache.clear()
}

// ── 并发闸门（上限 4）：超发请求排队等待 ──
const MAX_CONCURRENCY = 4
let inflight = 0
const waiters: Array<() => void> = []

async function acquire(): Promise<void> {
  if (inflight < MAX_CONCURRENCY) {
    inflight++
    return
  }
  await new Promise<void>((resolve) => waiters.push(resolve))
  inflight++
}

function release(): void {
  inflight = Math.max(0, inflight - 1)
  waiters.shift()?.()
}

const REQUEST_TIMEOUT_MS = 3_000
const MAX_RESPONSE_BYTES = 1024 * 1024

/**
 * POST JSON 到网关 socket。任何失败（socket 缺失/超时/非 JSON/超限）→ null（resolve 永远幂等安全）。
 * body 长度受限（请求侧构造方保证小负载），响应侧超 1MB 主动断开。
 */
function postJson<T>(apiPath: string, body: unknown): Promise<T | null> {
  return new Promise((resolve) => {
    const payload = JSON.stringify(body)
    const req = http.request(
      {
        socketPath: socketPath(),
        path: apiPath,
        method: 'POST',
        timeout: REQUEST_TIMEOUT_MS,
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(payload),
          Authorization: `Bearer ${TOKEN}`,
        },
      },
      (res) => {
        let data = ''
        res.setEncoding('utf8')
        res.on('data', (chunk: string) => {
          data += chunk
          if (data.length > MAX_RESPONSE_BYTES) {
            req.destroy() // 响应体超限：按失败处理
            resolve(null)
          }
        })
        res.on('end', () => {
          try {
            resolve(JSON.parse(data) as T)
          } catch {
            resolve(null)
          }
        })
        res.on('error', () => resolve(null))
      },
    )
    req.on('timeout', () => req.destroy()) // 超时销毁 → error 事件统一 resolve(null)
    req.on('error', () => resolve(null))
    req.end(payload)
  })
}

/**
 * 动作调用（带缓存）：cacheKey 提供时先查 LRU/TTL 缓存；网络成功且非 null 才写缓存
 * （失败不缓存负结果，网关恢复后立即自愈）。
 */
async function callAction<T>(action: string, params: Record<string, unknown>, cacheKey: string): Promise<T | null> {
  if (!isEnabled()) return null
  const key = `${action}:${cacheKey}`
  const hit = cacheGet(key)
  if (hit.hit) return hit.value as T
  await acquire()
  try {
    const res = await postJson<T>('/api/v1/trimapp', { action, params })
    if (res !== null) cachePut(key, res)
    return res
  } finally {
    release()
  }
}

export interface TrimAppStatus {
  enabled: boolean
  socketPath: string
  tokenConfigured: boolean
}

export const trimAppClient = {
  /** 探测当前可用性（供未来诊断端点/模块七联调排查） */
  isAvailable(): TrimAppStatus {
    return { enabled: isEnabled(), socketPath: socketPath(), tokenConfigured: Boolean(TOKEN) }
  },

  /** 用户可访问目录列表（不可用/失败 → null，调用方按无数据降级） */
  getUserAccessibleFolders(uid: string): Promise<string[] | null> {
    return callAction<string[]>('getUserAccessibleFolders', { uid }, `uid=${uid}`)
  },

  /** 目录 ACL 校验（不可用/失败 → null，调用方不得把 null 当 false 拒绝） */
  checkUserACL(uid: string, folderPath: string): Promise<boolean | null> {
    return callAction<boolean>('checkUserACL', { uid, path: folderPath }, `uid=${uid}|path=${folderPath}`)
  },
}
