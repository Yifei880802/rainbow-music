/**
 * 音频在线播放（流式）路由
 *   GET /api/v1/play/:taskId  流式播放已完成任务的音频文件
 *
 * - session/api key 鉴权由全局 onRequest 守卫统一处理（见 routes/auth.ts）
 * - 完整支持 HTTP Range（206 Partial Content / Content-Range / 断点续拖）
 * - 语义：任务不存在 404 / 任务未完成 409 / 文件缺失 410 / Range 非法 416
 * - 路径安全：file_path 虽来自数据库，仍校验解析后位于 download.dir 之内（防路径穿越）
 */
import type { FastifyInstance } from 'fastify'
import fs from 'node:fs'
import path from 'node:path'
import { taskStore } from '../core/db/index.js'
import { config } from '../core/config.js'

const MIME_BY_EXT: Record<string, string> = {
  '.mp3': 'audio/mpeg',
  '.flac': 'audio/flac',
  '.ogg': 'audio/ogg',
  '.opus': 'audio/ogg',
  '.m4a': 'audio/mp4',
  '.aac': 'audio/aac',
  '.wav': 'audio/wav',
}

/** Content-Type 按扩展名：.mp3→audio/mpeg、.flac→audio/flac，其余 audio/* */
function contentTypeOf(filePath: string): string {
  const ext = path.extname(filePath).toLowerCase()
  const known = MIME_BY_EXT[ext]
  if (known) return known
  const bare = ext.slice(1)
  if (bare && /^[a-z0-9]+$/i.test(bare)) return `audio/${bare.toLowerCase()}`
  return 'application/octet-stream'
}

type RangeResult = { start: number; end: number } | 'invalid' | undefined

/**
 * 解析 Range 请求头（仅处理单个 range，多段时取第一段）。
 * 返回 undefined = 未携带 Range；'invalid' = 不可满足/格式非法（→ 416）。
 */
function parseRange(header: string | undefined, size: number): RangeResult {
  if (!header || !header.startsWith('bytes=')) return undefined
  const spec = header.slice('bytes='.length).split(',')[0]?.trim()
  if (!spec) return 'invalid'
  const m = /^(\d*)-(\d*)$/.exec(spec)
  if (!m || (m[1] === '' && m[2] === '')) return 'invalid'
  let start: number
  let end: number
  if (m[1] === '') {
    // suffix 形式 bytes=-N：最后 N 个字节
    const suffix = Number(m[2])
    if (!Number.isFinite(suffix) || suffix <= 0) return 'invalid'
    start = Math.max(0, size - suffix)
    end = size - 1
  } else {
    start = Number(m[1])
    end = m[2] === '' ? size - 1 : Math.min(Number(m[2]), size - 1)
    if (!Number.isFinite(start) || !Number.isFinite(end)) return 'invalid'
  }
  if (start < 0 || start > end || start >= size) return 'invalid'
  return { start, end }
}

export async function playRoutes(app: FastifyInstance): Promise<void> {
  app.get<{ Params: { taskId: string } }>('/api/v1/play/:taskId', async (req, reply) => {
    const row = taskStore.get(req.params.taskId)
    if (!row) return reply.code(404).send({ error: 'task not found' })
    if (row.status !== 'completed' && row.status !== 'completed_with_warnings') {
      return reply.code(409).send({ error: 'task not completed, cannot play' })
    }
    if (!row.file_path) return reply.code(410).send({ error: 'task file missing' })

    // 路径安全：解析后必须位于 download.dir 之内（防 ../ 穿越与绝对路径逃逸）
    const dir = path.resolve(config.download.dir)
    const filePath = path.resolve(row.file_path)
    const rel = path.relative(dir, filePath)
    if (rel === '' || rel.startsWith('..') || path.isAbsolute(rel)) {
      req.log.warn({ taskId: row.id, filePath }, 'play: file_path escapes download.dir')
      return reply.code(410).send({ error: 'task file missing' })
    }

    let stat: fs.Stats
    try {
      stat = fs.statSync(filePath)
    } catch {
      return reply.code(410).send({ error: 'task file missing (deleted?)' })
    }
    if (!stat.isFile()) return reply.code(410).send({ error: 'task file missing' })

    const size = stat.size
    const contentType = contentTypeOf(filePath)
    const range = parseRange(req.headers.range, size)

    if (range === 'invalid') {
      return reply.code(416).header('Content-Range', `bytes */${size}`).send({ error: 'range not satisfiable' })
    }

    if (range === undefined) {
      // 全量响应（200），同样声明 Accept-Ranges 供后续 seek
      const stream = fs.createReadStream(filePath)
      stream.on('error', () => reply.raw.destroy())
      return reply
        .code(200)
        .header('Accept-Ranges', 'bytes')
        .header('Content-Type', contentType)
        .header('Content-Length', size)
        .send(stream)
    }

    const { start, end } = range
    const stream = fs.createReadStream(filePath, { start, end })
    stream.on('error', () => reply.raw.destroy())
    return reply
      .code(206)
      .header('Accept-Ranges', 'bytes')
      .header('Content-Type', contentType)
      .header('Content-Range', `bytes ${start}-${end}/${size}`)
      .header('Content-Length', end - start + 1)
      .send(stream)
  })
}
