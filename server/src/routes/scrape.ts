/**
 * #45 刮削路由（风格对齐 download.ts：/api/v1 前缀、:id 路径参数、{error} + 恰当 HTTP 码）
 *   POST /api/v1/tasks/:taskId/scrape   单任务刮削/重刮（?force=true 覆盖已 success）
 *   POST /api/v1/scrape/all             一键刮削全部（?force=true）
 *   POST /api/v1/scrape/reset           #47 重置全部刮削状态（pending/簿记清空）
 *   GET  /api/v1/scrape/status          运行态概览 + 状态分布统计
 */
import type { FastifyInstance } from 'fastify'
import { scrapeService } from '../core/scrape.js'

export async function scrapeRoutes(app: FastifyInstance): Promise<void> {
  app.post<{ Params: { taskId: string }; Querystring: { force?: string } }>(
    '/api/v1/tasks/:taskId/scrape',
    async (req, reply) => {
      const force = req.query.force === 'true' || req.query.force === '1'
      const r = await scrapeService.enqueue(req.params.taskId, { force, reason: 'manual' })
      if (!r.ok) {
        if (r.code === 404) return reply.code(404).send({ error: r.error })
        return reply.code(r.code ?? 409).send({ error: r.error })
      }
      return reply.code(202).send({ id: req.params.taskId, scrapeStatus: 'pending' })
    },
  )

  app.post<{ Querystring: { force?: string } }>('/api/v1/scrape/all', async (req) => {
    const force = req.query.force === 'true' || req.query.force === '1'
    const r = await scrapeService.scrapeAll(force)
    return reply202(r)
  })

  app.get('/api/v1/scrape/status', async () => scrapeService.status())

  // #47 重置全部刮削状态：scrape_status → pending、scrape_info → NULL（仅清簿记，不动文件标签）
  app.post('/api/v1/scrape/reset', async () => ({ reset: scrapeService.resetAll() }))

  function reply202(r: { queued: number; skipped: number }) {
    return { queued: r.queued, skipped: r.skipped }
  }
}
