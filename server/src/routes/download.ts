/**
 * 下载 + 任务 + 批次 + 队列控制路由
 *   POST   /api/v1/download             提交单个下载任务
 *   POST   /api/v1/download/batch       批量提交（共享单一 batchId）
 *   GET    /api/v1/tasks                任务列表（分页 ?limit&offset&status&batchId）
 *   GET    /api/v1/tasks/:id            单任务详情
 *   GET    /api/v1/tasks/:id/attempts   任务尝试审计轨迹（M2：为什么失败/换源）
 *   POST   /api/v1/tasks/:id/retry      重试
 *   POST   /api/v1/tasks/:id/cancel     取消
 *   DELETE /api/v1/tasks/:id            删除记录
 *   GET    /api/v1/batches              批次汇总列表（H1）
 *   GET    /api/v1/batches/:id          批次详情（含任务）（H1）
 *   POST   /api/v1/batches/:id/cancel   整批取消（H1）
 *   POST   /api/v1/queue/pause          暂停出队（admin）（H3）
 *   POST   /api/v1/queue/resume         恢复出队（admin）（H3）
 *   GET    /api/v1/queue/status         队列运行态（admin）（H3）
 */
import type { FastifyInstance } from 'fastify'
import { downloadQueue, type EnqueueInput } from '../core/download/queue.js'
import { isDiskFullError, errorToStatus, classifyError } from '../core/download/errors.js'
import { isPlatform, ALL_PLATFORMS } from '../core/search/index.js'
import { userIsAdmin } from '../core/auth/index.js'
import { config } from '../core/config.js'
import type { MusicInfo } from '../core/adapters/common.js'
import type { Quality } from '../core/source-engine/lx-env.js'
import type { TaskStatus } from '../core/db/index.js'

const VALID_QUALITIES: Quality[] = ['flac24bit', 'flac', '320k', '128k']

interface DownloadBody {
  platform?: string
  musicInfo?: MusicInfo
  quality?: Quality
  primarySourceId?: string
  sourceIds?: string[]
}

interface BatchDownloadBody {
  quality?: Quality
  primarySourceId?: string
  sourceIds?: string[]
  items?: { platform?: string; musicInfo?: MusicInfo; quality?: Quality }[]
}

export async function downloadRoutes(app: FastifyInstance): Promise<void> {
  app.post<{ Body: DownloadBody }>('/api/v1/download', async (req, reply) => {
    const { platform, musicInfo, quality = 'flac', primarySourceId, sourceIds } = req.body ?? {}
    if (!platform || !isPlatform(platform)) return reply.code(400).send({ error: 'invalid platform', valid: ALL_PLATFORMS })
    if (!musicInfo || !musicInfo.songmid || !musicInfo.name) return reply.code(400).send({ error: 'musicInfo (with songmid & name) is required' })
    if (!VALID_QUALITIES.includes(quality)) return reply.code(400).send({ error: 'invalid quality', valid: VALID_QUALITIES })
    try {
      const id = await downloadQueue.enqueue({ platform, musicInfo, quality, primarySourceId, sourceIds })
      return reply.code(201).send({ id, status: 'pending' })
    } catch (err) {
      // N3: 磁盘预检不足 → 507 Insufficient Storage + 结构化错误码
      const code = classifyError(err)
      const message = err instanceof Error ? err.message : String(err)
      return reply.code(isDiskFullError(err) ? 507 : errorToStatus(code)).send({ error: { code, message } })
    }
  })

  // 批量下载：一次提交多首（前端复选框勾选后调用），H1 共享单一 batchId
  app.post<{ Body: BatchDownloadBody }>('/api/v1/download/batch', async (req, reply) => {
    const { items, quality: defaultQuality = 'flac', primarySourceId, sourceIds } = req.body ?? {}
    if (!Array.isArray(items) || items.length === 0) return reply.code(400).send({ error: 'items (non-empty array) is required' })
    // H5: 批量上限配置化（download.batchMaxItems，默认 200）
    const maxItems = config.download.batchMaxItems ?? 200
    if (items.length > maxItems) return reply.code(400).send({ error: `too many items (max ${maxItems})` })

    // 先全量校验收集合法项，再一次性 enqueueBatch（保证同批共享 batchId）
    const valid: { index: number; name: string; input: EnqueueInput }[] = []
    const rejected: { index: number; error: string }[] = []
    items.forEach((item, index) => {
      const platform = item.platform
      const musicInfo = item.musicInfo
      const quality = item.quality ?? defaultQuality
      if (!platform || !isPlatform(platform)) return void rejected.push({ index, error: 'invalid platform' })
      if (!musicInfo || !musicInfo.songmid || !musicInfo.name) return void rejected.push({ index, error: 'musicInfo (with songmid & name) is required' })
      if (!VALID_QUALITIES.includes(quality)) return void rejected.push({ index, error: 'invalid quality' })
      valid.push({ index, name: musicInfo.name, input: { platform, musicInfo, quality, primarySourceId, sourceIds } })
    })
    if (valid.length === 0) return reply.code(201).send({ batchId: null, acceptedCount: 0, rejectedCount: rejected.length, accepted: [], rejected })
    try {
      const { batchId, ids } = await downloadQueue.enqueueBatch(valid.map((v) => v.input))
      const accepted = valid.map((v, i) => ({ index: v.index, id: ids[i]!, name: v.name }))
      return reply.code(201).send({ batchId, acceptedCount: accepted.length, rejectedCount: rejected.length, accepted, rejected })
    } catch (err) {
      // N3: 批量入队任一磁盘预检失败即整批拒绝（507），不产生部分入库
      const code = classifyError(err)
      const message = err instanceof Error ? err.message : String(err)
      return reply.code(isDiskFullError(err) ? 507 : errorToStatus(code)).send({ error: { code, message } })
    }
  })

  // H4: 任务列表分页 + 过滤（移除写死 200；默认 limit 50、上限 500）
  app.get<{ Querystring: { status?: string; batchId?: string; limit?: string; offset?: string } }>('/api/v1/tasks', async (req) => {
    const status = req.query.status ? (req.query.status as TaskStatus) : undefined
    const batchId = req.query.batchId || undefined
    const limit = parsePositiveInt(req.query.limit)
    const offset = parsePositiveInt(req.query.offset)
    const tasks = downloadQueue.list({ status, batchId, limit, offset })
    // #196-fix2: 补 total 字段（同条件全量计数，供前端分页判定）
    const total = downloadQueue.counts()
    const totalCount = status
      ? total[status === 'completed_with_warnings' ? 'completed' : status as keyof typeof total] ?? tasks.length
      : total.pending + total.active + total.completed + total.failed + total.canceled
    return { tasks, limit: limit ?? 50, offset: offset ?? 0, count: tasks.length, total: totalCount }
  })

  // #196-fix2: 轻量 owned 端点——覆盖全部终态任务（无分页），仅含 owned 判定所需字段
  app.get('/api/v1/tasks/owned', async () => {
    return { owned: downloadQueue.listOwned() }
  })

  app.get<{ Params: { id: string } }>('/api/v1/tasks/:id', async (req, reply) => {
    const t = downloadQueue.get(req.params.id)
    if (!t) return reply.code(404).send({ error: 'task not found' })
    return t
  })

  // M2: 任务尝试审计轨迹（每次换源/降级/重试写一条）——供前端「为什么失败」展开。
  // 任务不存在 404；存在但无尝试（如尚未执行/去重复用）返回空数组。
  app.get<{ Params: { id: string } }>('/api/v1/tasks/:id/attempts', async (req, reply) => {
    const id = req.params.id
    if (!downloadQueue.get(id)) return reply.code(404).send({ error: 'task not found' })
    return { attempts: downloadQueue.listAttempts(id) }
  })

  app.post<{ Params: { id: string } }>('/api/v1/tasks/:id/retry', async (req, reply) => {
    const ok = downloadQueue.retry(req.params.id)
    if (!ok) return reply.code(409).send({ error: 'task not retryable' })
    return { id: req.params.id, status: 'pending' }
  })

  app.post<{ Params: { id: string } }>('/api/v1/tasks/:id/cancel', async (req, reply) => {
    const ok = downloadQueue.cancel(req.params.id)
    if (!ok) return reply.code(409).send({ error: 'task not cancelable' })
    return { id: req.params.id, status: 'canceled' }
  })

  app.delete<{ Params: { id: string } }>('/api/v1/tasks/:id', async (req, reply) => {
    const ok = downloadQueue.remove(req.params.id)
    if (!ok) return reply.code(404).send({ error: 'task not found' })
    return { id: req.params.id, deleted: true }
  })

  // ── H1: 批次管理端点 ─────────────────────────────────────────────────
  // 批次汇总列表：每批 total + 各状态计数（按最新活动时间倒序）
  app.get('/api/v1/batches', async () => {
    return { batches: downloadQueue.listBatches() }
  })

  // 批次详情：含各状态计数与批次内任务（上限 500）
  app.get<{ Params: { id: string } }>('/api/v1/batches/:id', async (req, reply) => {
    const batchId = req.params.id
    const tasks = downloadQueue.list({ batchId, limit: 500 })
    if (tasks.length === 0) return reply.code(404).send({ error: 'batch not found or empty' })
    const counts = { pending: 0, active: 0, completed: 0, failed: 0, canceled: 0 }
    for (const t of tasks) {
      if (t.status === 'pending') counts.pending++
      else if (t.status === 'active') counts.active++
      else if (t.status === 'completed' || t.status === 'completed_with_warnings') counts.completed++
      else if (t.status === 'failed') counts.failed++
      else if (t.status === 'canceled') counts.canceled++
    }
    return { batchId, total: tasks.length, ...counts, tasks }
  })

  // 整批取消（仅 pending/active）：admin 限定
  app.post<{ Params: { id: string } }>('/api/v1/batches/:id/cancel', async (req, reply) => {
    if (!userIsAdmin(req.user)) return reply.code(403).send({ error: '需要管理员权限' })
    const batchId = req.params.id
    const canceled = downloadQueue.cancelBatch(batchId)
    return { batchId, canceled }
  })

  // ── H3: 队列控制端点（admin 限定）─────────────────────────────────────
  app.post('/api/v1/queue/pause', async (req, reply) => {
    if (!userIsAdmin(req.user)) return reply.code(403).send({ error: '需要管理员权限' })
    downloadQueue.pause()
    return downloadQueue.queueStatus()
  })

  app.post('/api/v1/queue/resume', async (req, reply) => {
    if (!userIsAdmin(req.user)) return reply.code(403).send({ error: '需要管理员权限' })
    downloadQueue.resume()
    return downloadQueue.queueStatus()
  })

  app.get('/api/v1/queue/status', async (req, reply) => {
    if (!userIsAdmin(req.user)) return reply.code(403).send({ error: '需要管理员权限' })
    return downloadQueue.queueStatus()
  })
}

/** H4: 解析非负整数查询参数（非法/缺省返回 undefined，交由 queue.list 用默认值兜底） */
function parsePositiveInt(v: string | undefined): number | undefined {
  if (v === undefined || v === '') return undefined
  const n = parseInt(v, 10)
  return Number.isFinite(n) && n >= 0 ? n : undefined
}
