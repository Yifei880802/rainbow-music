/**
 * SSE 实时推送
 *   GET /api/v1/sse/subscribe
 *
 * 事件流（event: <name>\ndata: <json>\n\n）：
 *   task:created / task:active / task:progress / task:completed /
 *   task:completed_with_warnings / task:failed / task:canceled /
 *   source:changed / source:update-alert / smoke:completed / smoke:failed
 *
 * v0.2.1（模块三）：连接建立时记录该连接的 uid（req.user）；事件对象带 uid
 * 字段时仅推给同 uid 连接（如模块四 scan:progress）；现有 task:* 等事件
 * 不带 uid → 维持全局广播不变。
 *
 * 客户端断线重连后应调用 GET /api/v1/tasks 做一次全量对账。
 */
import type { FastifyInstance } from 'fastify'
import { eventBus, type RoEvent } from '../core/events.js'
import { logger } from '../core/logger.js'

export async function sseRoutes(app: FastifyInstance): Promise<void> {
  // 路由级 logLevel=silent 降噪：外部匿名轮询/扫描频繁命中本路由被全局鉴权 401 拒绝，
  // 框架默认 info 级请求日志（incoming request / request completed）会刷屏。
  // pino 的 level 是下限过滤（debug 比 info 更宽松），故压制 info 须取 silent；
  // 路由自身异常仍由 core logger 直记（如 [sse] write failed），不受影响。
  app.get('/api/v1/sse/subscribe', { logLevel: 'silent' }, async (req, reply) => {
    // 接管原始响应，阻止 Fastify 再自行发送响应
    reply.hijack()
    reply.raw.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    })
    // 首包：告知已连接 + 建议全量对账
    reply.raw.write(`event: connected\ndata: ${JSON.stringify({ ts: Date.now() })}\n\n`)

    // v0.2.1：记录本连接身份 uid（鉴权关闭等场景为 null → 只收全局广播）
    const connUid = req.user?.uid ?? null

    const onEvent = (evt: RoEvent): void => {
      // 定向过滤：事件带 uid 且与本连接 uid 不一致 → 不推（跨用户不泄漏）
      if (evt.uid !== undefined && evt.uid !== connUid) return
      try {
        reply.raw.write(`event: ${evt.event}\ndata: ${JSON.stringify(evt.data)}\n\n`)
      } catch (err) {
        logger.warn({ err: (err as Error).message }, '[sse] write failed')
      }
    }
    eventBus.on('event', onEvent)

    // 心跳（注释行），防止中间层因空闲断连
    const heartbeat = setInterval(() => {
      try {
        reply.raw.write(`: ping ${Date.now()}\n\n`)
      } catch {
        /* ignore */
      }
    }, 15_000)

    const cleanup = (): void => {
      clearInterval(heartbeat)
      eventBus.off('event', onEvent)
    }
    req.raw.on('close', cleanup)
    req.raw.on('error', cleanup)

    // hijack 后不再 return reply，连接由 raw 写入保持
  })
}
