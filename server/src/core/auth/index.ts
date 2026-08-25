/**
 * 鉴权 — 个人自用 / 局域网部署的轻量方案
 *
 * 通行方式（任一）：
 *   1. Web 登录：用户名+密码 → 签发内存 session token，写 HttpOnly Cookie（ro_sess）
 *   2. API Key：请求头 x-api-key 或 Authorization: Bearer <key> —— 给脚本/自动化用
 *   3. v0.2.1 网关身份：仅网关实例采信 X-Trim-* 头（见 fnid.ts），
 *      gateway-login / 守卫自动换发均会签发带身份的 session，下游逻辑统一走 session 语义
 *
 * 关闭鉴权（config.auth.enabled=false）时全部放行。
 * 局域网自用，不追求高强度：session 存内存，重启即失效（重新登录即可）。
 */
import crypto from 'node:crypto'
import { config } from '../config.js'

const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000 // 7 天
export const SESSION_COOKIE = 'ro_sess'

/** session 携带的用户身份（v0.2.1；uid 恒为字符串，本地 admin 固定 'legacy'） */
export interface SessionIdentity {
  uid: string
  username: string
  isAdmin: boolean
}

interface Session {
  token: string
  createdAt: number
  expiresAt: number
  // v0.2.1 身份字段（向后兼容：老 session / 老代码签发的 session 无这些字段，
  // 读取侧按 legacy + admin 处理，见 resolveSessionIdentity）
  uid?: string
  username?: string
  isAdmin?: boolean
}

const sessions = new Map<string, Session>()

function sweep(): void {
  const now = Date.now()
  for (const [t, s] of sessions) if (s.expiresAt <= now) sessions.delete(t)
}

/** 校验 Web 登录凭据（时间安全比较） */
export function verifyLogin(username: string, password: string): boolean {
  const u = config.auth.webLogin.username
  const p = config.auth.webLogin.password
  if (!u || !p) return false // 未设置密码时禁止登录（引导用户先配密码）
  return safeEqual(username, u) && safeEqual(password, p)
}

/** 本地 admin 兕底身份（账密登录 / API Key 通道共用；存量数据归属 'legacy'） */
export function legacyAdminIdentity(): SessionIdentity {
  return { uid: 'legacy', username: config.auth.webLogin.username || 'admin', isAdmin: true }
}

/**
 * 签发新 session，返回 token。
 * identity 缺省 = 本地 admin（v0.2.0 账密登录语义不变）；
 * 网关实例 gateway-login / 守卫自动换发传入网关身份。
 */
export function createSession(identity?: SessionIdentity): string {
  sweep()
  const token = crypto.randomBytes(32).toString('hex')
  const now = Date.now()
  const id = identity ?? legacyAdminIdentity()
  sessions.set(token, {
    token,
    createdAt: now,
    expiresAt: now + SESSION_TTL_MS,
    uid: id.uid,
    username: id.username,
    isAdmin: id.isAdmin,
  })
  return token
}

/** 取 session（含身份字段）；无效/过期返回 null */
export function getSession(token: string | undefined): Session | null {
  if (!token) return null
  const s = sessions.get(token)
  if (!s) return null
  if (s.expiresAt <= Date.now()) { sessions.delete(token); return null }
  return s
}

/**
 * 解析 session 身份：老 session 无身份字段 → legacy/admin（向后兼容，
 * v0.2.0 存量登录态全部视为本地管理员）。
 */
export function resolveSessionIdentity(s: Session): SessionIdentity {
  return {
    uid: s.uid ?? 'legacy',
    username: s.username ?? (config.auth.webLogin.username || 'admin'),
    isAdmin: s.isAdmin ?? true,
  }
}

/** 校验 session token 是否有效（布尔便捷口径，内部复用 getSession） */
export function validateSession(token: string | undefined): boolean {
  return getSession(token) !== null
}

/**
 * 管理面鉴权判定（模块三）：仅「明确的非管理员」（网关 Isadmin=false）被拦；
 * null（鉴权关闭）与无 isAdmin 字段的老 session（legacy admin）放行，保持 v0.2.0 行为。
 */
export function userIsAdmin(user: { isAdmin?: boolean } | null | undefined): boolean {
  return user?.isAdmin !== false
}

/** 销毁 session（登出） */
export function destroySession(token: string | undefined): void {
  if (token) sessions.delete(token)
}

/** 校验 API Key */
export function verifyApiKey(key: string | undefined): boolean {
  const k = config.auth.apiKey
  if (!k || !key) return false
  return safeEqual(key, k)
}

/** 是否已配置密码（前端登录页据此提示） */
export function isPasswordConfigured(): boolean {
  return Boolean(config.auth.webLogin.password)
}

function safeEqual(a: string, b: string): boolean {
  const ba = Buffer.from(String(a))
  const bb = Buffer.from(String(b))
  if (ba.length !== bb.length) return false
  return crypto.timingSafeEqual(ba, bb)
}

/** 解析 Cookie 头，取指定 name */
export function parseCookie(header: string | undefined, name: string): string | undefined {
  if (!header) return undefined
  for (const part of header.split(';')) {
    const idx = part.indexOf('=')
    if (idx === -1) continue
    const k = part.slice(0, idx).trim()
    if (k === name) return decodeURIComponent(part.slice(idx + 1).trim())
  }
  return undefined
}
