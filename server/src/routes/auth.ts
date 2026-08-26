/**
 * 鉴权路由 + 全局守卫钩子（v0.2.1 双实例化，模块二）
 *
 *  POST /api/v1/auth/login          { username, password } → 设 Cookie（本地 admin 账密；两实例均可用）
 *  POST /api/v1/auth/gateway-login  仅网关实例：读 X-Trim-* 可信头 → upsert users → 签发带身份 session
 *  POST /api/v1/auth/logout         → 清 Cookie
 *  GET  /api/v1/auth/status         → { enabled, authenticated, passwordConfigured, mode, user }
 *                                     （新增只增字段：mode = 'gateway'|'local' 按实例；
 *                                      user = {uid,username,isAdmin} 已登录时，含 legacy 本地 admin）
 *
 * 全局 onRequest 守卫（registerAuthGuard，两实例各装一份，opts 控制信任门）：
 *   1. 身份解析（先于放行判定，挂 req.user，decorateRequest）：
 *      - 网关实例（trustGatewayHeaders=true）：优先 X-Trim-* 头——upsertUser 落库、
 *        直接视为已认证，同时签发/复用同身份 session cookie（下游逻辑统一）；
 *        TCP 实例对本头零采信（防伪造）
 *      - 两实例：session cookie 回落（老 session 无身份字段按 legacy/admin）
 *      - API Key 通道视为 legacy admin（脚本/自动化，v0.2.0 语义）
 *   2. 放行判定：
 *      - auth.enabled=false → 全放行
 *      - 白名单路径（登录页/登录接口/静态登录资源）放行
 *      - 其余：req.user 存在即已认证；失败则 /api/* → 401 JSON，其它 → 302 跳 /login.html
 */
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
// 注意：守卫钩子必须装在「根 app」上才全局生效（见 index.ts registerAuthGuard），
// 若通过 app.register(authRoutes) 注册，钩子会被 Fastify 封装、只作用于本插件内的路由。
import { config } from '../core/config.js'
import {
  SESSION_COOKIE, verifyLogin, createSession, destroySession,
  getSession, resolveSessionIdentity, legacyAdminIdentity, verifyApiKey, parseCookie, isPasswordConfigured,
} from '../core/auth/index.js'
import { parseGatewayUser, upsertUser } from '../core/auth/fnid.js'

/** fnOS 统一网关转发前缀（v0.2.5）：网关按官方语义保留完整前缀转发到应用 socket，
 *  网关实例由 index.ts 的 rewriteUrl 在路由查找前剥除（路由/守卫/限流均按无前缀路径工作）；
 *  此常量同时供守卫 302 拼接带前缀的登录页地址（iframe 内不能跳无前缀根路径） */
export const GATEWAY_URL_PREFIX = '/app/com.rainbow.music'

/** 插件级选项：由 buildApp 按实例传入（index.ts） */
export interface AuthPluginOptions {
  trustGatewayHeaders?: boolean
}

// 无需鉴权即可访问的路径（登录闭环 + 登录页资源）。
// gateway-login 自身校验网关头（无头 → 401），进白名单只是让探测请求能到达端点
// 拿到明确错误；TCP 实例上该路由不存在 → 404，伪造头无任何效果。
const PUBLIC_PATHS = new Set<string>([
  '/login.html',
  '/login.js',
  '/style.css', // 登录页复用主样式表
  '/api/v1/auth/login',
  '/api/v1/auth/gateway-login',
  '/api/v1/auth/status',
  '/favicon.ico',
  '/favicon.png',
])

function getToken(req: FastifyRequest): string | undefined {
  return parseCookie(req.headers.cookie, SESSION_COOKIE)
}

function getApiKey(req: FastifyRequest): string | undefined {
  const h = req.headers['x-api-key']
  if (typeof h === 'string' && h) return h
  const auth = req.headers.authorization
  if (auth && auth.startsWith('Bearer ')) return auth.slice(7)
  return undefined
}

function sessionCookie(token: string, maxAgeSec: number): string {
  // 局域网/容器内网部署，secure 留空（与 login 端点现状一致）
  return `${SESSION_COOKIE}=${token}; HttpOnly; Path=/; SameSite=Lax; Max-Age=${maxAgeSec}`
}

/**
 * 身份解析：按实例信任门依次尝试网关头 → session → API Key。
 * 网关实例带头时同步签发/复用同身份 session cookie（reply.header），
 * 使下游（SSE/静态资源/前端 fetch）全部统一走 session 语义。
 */
function resolveUserIdentity(
  req: FastifyRequest,
  reply: FastifyReply,
  trustGatewayHeaders: boolean,
): void {
  // 1) 网关头（仅信任实例；TCP 实例零采信）
  if (trustGatewayHeaders) {
    const gw = parseGatewayUser(req.headers)
    if (gw) {
      upsertUser(gw)
      req.user = gw
      // 签发/复用：已有有效 session 且身份一致 → 复用不重签；否则以头为准换发
      const sess = getSession(getToken(req))
      if (!sess || sess.uid !== gw.uid) {
        reply.header('Set-Cookie', sessionCookie(createSession(gw), 7 * 24 * 60 * 60))
      }
      return
    }
  }
  // 2) session 回落（两实例同规则；老 session 按 legacy/admin 解析）
  const sess = getSession(getToken(req))
  if (sess) {
    req.user = resolveSessionIdentity(sess)
    return
  }
  // 3) API Key（脚本/自动化通道 → legacy admin，v0.2.0 语义）
  if (verifyApiKey(getApiKey(req))) {
    const id = legacyAdminIdentity()
    req.user = { uid: id.uid, username: id.username, isAdmin: true }
  }
}

/**
 * 在根 app 上安装全局鉴权守卫（须在注册业务路由/静态资源前调用）。
 * 参数用 any：主 app 通过 loggerInstance 定制了 logger 泛型，与默认
 * FastifyInstance 泛型不兼容，这里只用到 addHook/decorateRequest，放宽即可。
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function registerAuthGuard(app: any, opts: { trustGatewayHeaders: boolean }): void {
  // req.user 装饰：null 为原始值默认（每请求重置），onRequest 阶段覆盖
  app.decorateRequest('user', null)
  app.addHook('onRequest', async (req: FastifyRequest, reply: FastifyReply) => {
    resolveUserIdentity(req, reply, opts.trustGatewayHeaders)
    if (!config.auth.enabled) return
    const url = (req.raw.url ?? '').split('?')[0]!
    if (PUBLIC_PATHS.has(url)) return
    // /js/* 为登录页/主页的 ES 模块静态资源（纯前端代码，无敏感信息），放行；
    // 未登录时任何 /api/* 仍会被拦，页面自然回退到登录闭环。
    if (url.startsWith('/js/')) return
    if (req.user) return

    if (url.startsWith('/api/')) {
      return reply.code(401).send({ error: '未授权，请先登录或提供有效 API Key' })
    }
    // v0.2.5：网关实例的 302 必须落在前缀内（iframe 里跳无前缀根路径会 404），
    // TCP 实例维持原绝对路径 /login.html（直连场景页面即根路径，行为不变）
    return reply.redirect(opts.trustGatewayHeaders ? GATEWAY_URL_PREFIX + '/login.html' : '/login.html')
  })
}

export async function authRoutes(app: FastifyInstance, opts: AuthPluginOptions = {}): Promise<void> {
  const trustGateway = opts.trustGatewayHeaders === true

  app.post('/api/v1/auth/login', async (req, reply) => {
    const body = (req.body ?? {}) as { username?: string; password?: string }
    if (!isPasswordConfigured()) {
      return reply.code(400).send({ error: '尚未设置登录密码，请在 config.yaml 的 auth.webLogin.password 配置后重启' })
    }
    if (!verifyLogin(body.username ?? '', body.password ?? '')) {
      return reply.code(401).send({ error: '用户名或密码错误' })
    }
    // 本地 admin 账密登录 → legacy/admin 身份（v0.2.0 语义不变）
    const token = createSession()
    reply.header('Set-Cookie', sessionCookie(token, 7 * 24 * 60 * 60))
    return { ok: true }
  })

  // FN ID 网关登录（仅网关实例注册）：读可信头 → upsert → 签发带身份 session。
  // TCP 实例无此路由（带头伪造请求 → 404），是防伪造红线的组成部分。
  if (trustGateway) {
    app.post('/api/v1/auth/gateway-login', async (req, reply) => {
      const gw = parseGatewayUser(req.headers)
      if (!gw) {
        return reply.code(401).send({ error: '缺少有效网关身份头（X-Trim-Userid / X-Trim-Username）' })
      }
      upsertUser(gw)
      const token = createSession(gw)
      reply.header('Set-Cookie', sessionCookie(token, 7 * 24 * 60 * 60))
      return { ok: true, user: { uid: gw.uid, username: gw.username, isAdmin: gw.isAdmin } }
    })
  }

  app.post('/api/v1/auth/logout', async (req, reply) => {
    destroySession(getToken(req))
    reply.header('Set-Cookie', sessionCookie('', 0))
    return { ok: true }
  })

  app.get('/api/v1/auth/status', async (req) => {
    const user = req.user
    return {
      enabled: config.auth.enabled,
      authenticated: !config.auth.enabled || Boolean(user),
      passwordConfigured: isPasswordConfigured(),
      // v0.2.1 新增（只增字段）：前端登录页探测点——gateway 模式显示 FN ID 直达
      mode: trustGateway ? 'gateway' : 'local',
      user: user ? { uid: user.uid, username: user.username, isAdmin: user.isAdmin } : null,
    }
  })
}
