/**
 * 网关注册诊断统计（v0.2.12）
 *
 * 背景：fnOS 手动安装链（manual_install=t + is_docker=t）不写 appcenter.app_service
 * 的 gateway_socket/gateway_prefix → 网关 /app/<appid>/ 404（详见 docs/FNOS-DEPLOY.md
 * 「v0.2.7/v0.2.8 网关 404 第三层根因」章）。应用侧自愈通道（DB 补写三轮：
 * v0.2.9 时序 / v0.2.10 身份 / v0.2.11 docker.sock 权限）已全部真机实证关闭，
 * 根治依赖 fnOS 侧修复。本模块做运行时被动诊断：统计 API 流量来源，让
 * 「网关疑似未注册」从静默 404 变成应用内可见、可指引的状态。
 *
 * 设计要点：
 *  - 全内存态：计数在请求路径上 O(1) 自增，判定在 status 查询时现算
 *    （不在请求路径上算）；无定时器、无持久化；
 *  - 「网关流量」按实例级判定（网关 Unix Socket 实例收到的 /api/v1/* 请求），
 *    而非 X-Trim-* 头存在性：TCP 实例上该头可被伪造（认证层虽忽略，但会污染
 *    统计口径），而网关实例的流量来源唯一——fnOS 统一网关 unix socket，
 *    其到达本身即证明网关已注册且转发正常（fnOS 网关对转发请求注入
 *    X-Trim-Userid/Username/Isadmin 身份头，两个信号在真实流量上等价）；
 *  - 只计 /api/v1/* 业务流量：静态资源（html/js/css/字体）每次页面加载产生
 *    大量请求，稀释信号且不反映 API 使用面；封面 /api/v1/cover 等 API 路由
 *    计入无妨；
 *  - TCP + 网关两实例共享同一份进程级内存计数（模块单例）；
 *  - install marker（fpk install_callback 写 ${TRIM_PKGVAR}/data/db/install.marker，
 *    容器内 /app/data/db/install.marker —— data/db 是 compose 已挂载子目录：
 *    t111 实证 fnOS 仅挂载 data 的三个子目录而非 data 根，v0.2.12 写 data 根
 *    导致容器内不可见、waiting 态永不触发，v0.2.13 修正）：stat mtime 缓存，
 *    文件未变不重复读内容；读不到当不存在（非 fpk 部署/Docker 手动部署无此文件，
 *    recentlyInstalled 恒 false，仅影响 waiting 态判定，无其他副作用）。
 *    t111 另实证 fnOS 手动升级链双跑 install/upgrade 回调（完整重装语义），
 *    故升级后 marker 同样刷新——waiting 态在升级后正确出现。
 */
import fs from 'node:fs'
import path from 'node:path'
import type { FastifyReply, FastifyRequest } from 'fastify'
import { ROOT_DIR } from './config.js'

export type GatewayHealthStatus = 'ok' | 'waiting' | 'suspected-unregistered' | 'unknown'

export interface GatewayHealthSnapshot {
  /** 综合状态（判定优先级见 gatewaySnapshot） */
  status: GatewayHealthStatus
  /** 运行 >10 分钟 && 有 API 流量 && 零网关流量 */
  suspectedUnregistered: boolean
  /** install marker 存在且距今 <45 分钟（覆盖 sacentry 30 分钟同步周期 + 余量） */
  recentlyInstalled: boolean
  totalRequests: number
  gatewayRequests: number
  /** 进程启动时刻（ISO） */
  startedAt: string
  firstRequestAt: string | null
  lastGatewayRequestAt: string | null
  installMarkerAt: string | null
}

/** 判定窗口：进程运行超过该时长且仅有直连流量 → 疑似未注册 */
const SUSPECT_AFTER_MS = 10 * 60 * 1000
/** 安装宽限：marker 距今小于该值 → waiting（sacentry 周期 30 分钟 + 余量） */
const INSTALL_GRACE_MS = 45 * 60 * 1000
/** 只计业务 API（静态资源减噪；网关实例 rewriteUrl 已剥前缀，两实例口径一致） */
const API_PREFIX = '/api/v1/'

const stats = {
  startedAt: Date.now(),
  firstRequestAt: null as number | null,
  lastGatewayRequestAt: null as number | null,
  totalRequests: 0,
  gatewayRequests: 0,
}

let markerCache: { path: string; mtimeMs: number; at: number | null } | null = null

/**
 * onRequest 计数 hook（buildApp 每实例挂一次，isGatewayInstance=网关 Unix Socket 实例）。
 * 注册在限流之后：被限流拒绝的洪水不进入统计。统计永不抛错、不阻断请求。
 */
export function createGatewayStatsHook(isGatewayInstance: boolean) {
  return function gatewayStatsHook(
    request: FastifyRequest,
    _reply: FastifyReply,
    done: () => void,
  ): void {
    try {
      const url = request.url ?? ''
      if (url.startsWith(API_PREFIX)) {
        stats.totalRequests += 1
        if (stats.firstRequestAt === null) stats.firstRequestAt = Date.now()
        if (isGatewayInstance) {
          stats.gatewayRequests += 1
          stats.lastGatewayRequestAt = Date.now()
        }
      }
    } catch {
      /* 诊断统计永不影响请求 */
    }
    done()
  }
}

/** marker 候选路径（v0.2.13 双探测）：RO_INSTALL_MARKER 可覆盖（测试/非标准部署）。
 *  首选 data/db/install.marker（compose 已挂载子目录，t111 实证 bug#1 修复主路径）；
 *  兼容探测旧路径 data/install.marker（v0.2.12 写入点；fnOS 不挂载 data 根，容器内
 *  实际不可见，探测无害——防未来 fnOS 挂载行为变化或非 fnOS 部署显式挂 data 根） */
function markerPaths(): string[] {
  if (process.env.RO_INSTALL_MARKER) return [process.env.RO_INSTALL_MARKER]
  return [
    path.join(ROOT_DIR, 'data', 'db', 'install.marker'),
    path.join(ROOT_DIR, 'data', 'install.marker'),
  ]
}

/** 读安装时刻（epoch ms）；格式 = install_callback 写入的「秒\nISO」两行，取首行 */
function readInstallMarkerAt(): number | null {
  try {
    // 双路径探测：逐个 stat，第一个存在的胜出（新路径优先）
    let p: string | null = null
    for (const cand of markerPaths()) {
      if (fs.existsSync(cand)) {
        p = cand
        break
      }
    }
    if (p === null) return null
    const st = fs.statSync(p)
    if (markerCache && markerCache.path === p && markerCache.mtimeMs === st.mtimeMs) {
      return markerCache.at
    }
    const txt = fs.readFileSync(p, 'utf8')
    const first = (txt.split('\n')[0] ?? '').trim()
    const n = Number(first)
    const at = Number.isFinite(n) && n > 0 ? Math.round(n * 1000) : null
    markerCache = { path: p, mtimeMs: st.mtimeMs, at }
    return at
  } catch {
    return null // 读不到当不存在；不缓存，下次 status 查询重试（成本一次 stat）
  }
}

/**
 * 现算网关健康快照（status 路由调用；不在请求路径上）。判定优先级：
 *  1. ok                     gatewayRequests > 0（网关流量存在，注册且转发正常）
 *  2. waiting                recentlyInstalled 且零网关流量（刚装宽限，别吓用户）
 *  3. suspected-unregistered 运行 >10 分钟 && 有 API 流量 && 零网关流量
 *  4. unknown                其余（零流量无从判断；或有直连流量但观察窗口未满）
 */
export function gatewaySnapshot(): GatewayHealthSnapshot {
  const now = Date.now()
  const uptimeMs = now - stats.startedAt
  const markerAt = readInstallMarkerAt()
  const recentlyInstalled = markerAt !== null && now - markerAt < INSTALL_GRACE_MS
  const suspected =
    stats.gatewayRequests === 0 && uptimeMs > SUSPECT_AFTER_MS && stats.totalRequests > 0

  let status: GatewayHealthStatus
  if (stats.gatewayRequests > 0) status = 'ok'
  else if (recentlyInstalled) status = 'waiting'
  else if (suspected) status = 'suspected-unregistered'
  else status = 'unknown'

  const iso = (t: number | null): string | null => (t === null ? null : new Date(t).toISOString())
  return {
    status,
    suspectedUnregistered: suspected,
    recentlyInstalled,
    totalRequests: stats.totalRequests,
    gatewayRequests: stats.gatewayRequests,
    startedAt: new Date(stats.startedAt).toISOString(),
    firstRequestAt: iso(stats.firstRequestAt),
    lastGatewayRequestAt: iso(stats.lastGatewayRequestAt),
    installMarkerAt: iso(markerAt),
  }
}

/** @internal 仅供测试重置进程级状态（生产代码不调用） */
export function __resetGatewayStatsForTest(startedAtMs?: number): void {
  stats.startedAt = startedAtMs ?? Date.now()
  stats.firstRequestAt = null
  stats.lastGatewayRequestAt = null
  stats.totalRequests = 0
  stats.gatewayRequests = 0
  markerCache = null
}
