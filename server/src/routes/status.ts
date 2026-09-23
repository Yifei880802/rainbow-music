import type { FastifyInstance } from 'fastify'
import { sourceEngine } from '../core/source-engine/index.js'
import { downloadQueue } from '../core/download/queue.js'
import { gatewaySnapshot } from '../core/gateway-stats.js'

const startedAt = Date.now()

export async function statusRoutes(app: FastifyInstance): Promise<void> {
  app.get('/api/v1/status', async () => {
    const sources = sourceEngine.list()
    // H3/H4: 计数改用 DB 精确计数（不再受 list 分页上限截断）
    const counts = downloadQueue.counts()
    return {
      app: 'ro',
      version: '0.2.23',
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
        pending: counts.pending,
        active: counts.active,
        completed: counts.completed,
        failed: counts.failed,
      },
      // H3: 激活缓冲长度（批量背压：超过 batchActivationSize 的任务在此排队，随完成分批激活）
      activationBuffer: downloadQueue.bufferedCount(),
      // H3: 队列暂停态（用户暂停 paused / RSS 护栏暂停 memPaused）
      queuePaused: downloadQueue.isPaused(),
    }
  })
}
