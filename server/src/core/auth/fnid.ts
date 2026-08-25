/**
 * FN ID 网关身份（模块二）
 *
 * fnOS 统一网关在 /app/com.rainbow.music 前缀下校验用户会话（含 FN ID 远程
 * 访问）后注入可信 Header：
 *   X-Trim-Userid    数字 uid（字符串形式）
 *   X-Trim-Username  用户名
 *   X-Trim-Isadmin   布尔语义（"true"/"false"）
 *
 * 安全红线（官方明确警告「不要信任客户端自传 uid」）：
 *   这些头只在网关实例（Unix Socket，RO_GATEWAY_SOCK）上被采信；
 *   TCP 实例（trustGatewayHeaders=false）对本模块零调用——伪造头无效。
 */
import { userStore } from '../db/users.js'

/** 网关三头解析出的用户身份（uid 恒为字符串） */
export interface GatewayUser {
  uid: string
  username: string
  isAdmin: boolean
}

/** 请求链路统一用户身份（req.user 的类型；网关身份 / session 身份 / API Key 身份同构） */
export type RequestUser = GatewayUser

declare module 'fastify' {
  interface FastifyRequest {
    /**
     * 守卫钩子在 onRequest 阶段挂载（见 routes/auth.ts registerAuthGuard）：
     * 网关实例优先 X-Trim-* 头身份，两实例均可回落 session / API Key；
     * 未认证（且鉴权开启）时请求已被拦下，到达 handler 的 req.user 语义上非空；
     * 鉴权关闭（config.auth.enabled=false）时可能为 null，下游按 legacy/admin 兕底。
     */
    user: RequestUser | null
  }
}

function firstHeader(v: unknown): string | undefined {
  return Array.isArray(v) ? (v[0] as string | undefined) : (v as string | undefined)
}

/**
 * 纯函数：解析网关三头。
 * 返回 null（= 无网关身份，回落 session 校验）的条件：
 *   - X-Trim-Userid 缺失 / 非纯数字（uid 非法）
 *   - X-Trim-Username 缺失或空白（users.username NOT NULL，无法落库）
 * X-Trim-Isadmin 缺失按 false 处理（最小权限）。
 */
export function parseGatewayUser(headers: Record<string, unknown>): GatewayUser | null {
  const uidRaw = firstHeader(headers['x-trim-userid'])
  const usernameRaw = firstHeader(headers['x-trim-username'])
  const isAdminRaw = firstHeader(headers['x-trim-isadmin'])
  if (!uidRaw || !/^\d+$/.test(uidRaw)) return null
  const username = (usernameRaw ?? '').trim()
  if (!username) return null
  const isAdmin = isAdminRaw === 'true' || isAdminRaw === '1' || isAdminRaw === 'yes'
  return { uid: uidRaw, username, isAdmin }
}

/** 网关身份 upsert users 表（首见写 first_seen，每次刷新 last_seen/username/is_admin） */
export function upsertUser(u: GatewayUser): void {
  userStore.upsert(u)
}
