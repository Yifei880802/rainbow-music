import type { FastifyInstance } from 'fastify'
import { sourceEngine } from '../core/source-engine/index.js'
import { downloadQueue } from '../core/download/queue.js'
import { gatewaySnapshot } from '../core/gateway-stats.js'

const startedAt = Date.now()

export async function statusRoutes(app: FastifyInstance): Promise<void> {
  app.get('/api/v1/status', async () => {
    const sources = sourceEngine.list()
    const tasks = downloadQueue.list()
    const count = (s: string): number => tasks.filter((t) => t.status === s).length
    return {
      app: 'ro',
      version: '0.2.15',
      uptimeSec: Math.floor((Date.now() - startedAt) / 1000),
      node: process.version,
      memoryMB: Math.round(process.memoryUsage().rss / 1024 / 1024),
      // v0.2.12：网关注册诊断（全内存计数 + install marker 现算，见 core/gateway-stats）。
      // status 为公开端点——网关 404 时用户恰好走直连访问，正是诊断的目标场景；
      // 仅计数与时间戳，无敏感信息。
      gatewayHealth: gatewaySnapshot(),
      sources: {
        loaded: sources.length,
        ready: sources.filter((s) => s.status === 'ready' && s.enabled).length,
      },
      tasks: {
        pending: count('pending'),
        active: count('active'),
        completed: count('completed') + count('completed_with_warnings'),
        failed: count('failed'),
      },
    }
  })
}
