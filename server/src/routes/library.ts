/**
 * 本地音乐库路由（模块四，v0.2.1）
 *
 *   POST   /api/v1/library/scan               启动扫描（202；per-uid 互斥 409；无扫描根 400）
 *   GET    /api/v1/library/scan/status        { scanning, last?, progress? }（进程内存态）
 *   GET    /api/v1/library/tracks             分页列表（limit clamp 1..500 默认 100；
 *                                            q → title/artist LIKE；artist/album 精确；
 *                                            sort ∈ updated(默认)/artist/album）
 *   GET    /api/v1/library/tracks/:id/stream  Range 流式播放（206/断点续拖，play.ts 手法；
 *                                            路径校验 = 该 uid 扫描根 ∪ download.dir）
 *   GET    /api/v1/library/tracks/:id/cover   封面：缓存 data/covers/{uid}/{id}.jpg 优先，
 *                                            未探测时现场解析（flac PICTURE/mp3 APIC）
 *                                            → 写缓存 → 200；解析不到 404
 *   DELETE /api/v1/library/tracks/:id         只删索引行（不动音频文件），顺带清封面缓存
 *
 * - session/api key/网关头鉴权由全局 onRequest 守卫统一处理（routes/auth.ts）
 * - uid 口径与 me.ts 一致：req.user?.uid ?? 'legacy' 兜底
 * - Range/Content-Type/路径校验逻辑复制自 play.ts（模块 1-3 冻结不改其导出面，
 *   两处语义保持一致；上游演进以 play.ts 为权威口径同步）
 */
import type { FastifyInstance } from 'fastify'
import fs from 'node:fs'
import path from 'node:path'
import { scanRootStore } from '../core/db/users.js'
import { config } from '../core/config.js'
import {
  libraryScanner, ScanConflictError, libraryTrackStore,
  coverCacheDir, coverCacheFile, type TrackSort,
} from '../core/library/scanner.js'
import { extractCover } from '../core/library/covers.js'

/** 鉴权关闭等场景下的兜底身份（与 me.ts effectiveUser 同口径） */
function effectiveUid(req: { user: { uid: string } | null }): string {
  return req.user?.uid ?? 'legacy'
}

// ── Content-Type / Range 解析（复制自 play.ts，口径一致）──
const MIME_BY_EXT: Record<string, string> = {
  '.mp3': 'audio/mpeg',
  '.flac': 'audio/flac',
  '.ogg': 'audio/ogg',
  '.opus': 'audio/ogg',
  '.m4a': 'audio/mp4',
  '.aac': 'audio/aac',
  '.wav': 'audio/wav',
}

function contentTypeOf(filePath: string): string {
  const ext = path.extname(filePath).toLowerCase()
  const known = MIME_BY_EXT[ext]
  if (known) return known
  const bare = ext.slice(1)
  if (bare && /^[a-z0-9]+$/i.test(bare)) return `audio/${bare.toLowerCase()}`
  return 'application/octet-stream'
}

type RangeResult = { start: number; end: number } | 'invalid' | undefined

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

/** 数值 query 解析：非法/越界回退默认值 */
function intQuery(raw: string | undefined, def: number, min: number, max: number): number {
  const n = Number(raw)
  if (!Number.isInteger(n) || n < min) return def
  return Math.min(n, max)
}

export async function libraryRoutes(app: FastifyInstance): Promise<void> {
  // ── 扫描启动（202 异步任务语义）──
  app.post('/api/v1/library/scan', async (req, reply) => {
    const uid = effectiveUid(req)
    const roots = scanRootStore
      .listByUid(uid)
      .filter((r) => r.enabled === 1)
      .map((r) => r.path)
    if (roots.length === 0) {
      return reply.code(400).send({
        error: '未配置扫描根，请先通过 GET/PUT /api/v1/me/scan-roots 选择',
      })
    }
    try {
      const jobId = libraryScanner.startScan(uid, roots)
      return reply.code(202).send({ ok: true, jobId })
    } catch (err) {
      if (err instanceof ScanConflictError) {
        return reply.code(409).send({ error: '该用户已有扫描在进行中，请稍后再试' })
      }
      throw err
    }
  })

  app.get('/api/v1/library/scan/status', async (req) => {
    return libraryScanner.status(effectiveUid(req))
  })

  // ── 曲库分页列表 ──
  app.get<{
    Querystring: { limit?: string; offset?: string; artist?: string; album?: string; q?: string; sort?: string }
  }>('/api/v1/library/tracks', async (req) => {
    const uid = effectiveUid(req)
    const q = req.query ?? {}
    const sort: TrackSort =
      q.sort === 'artist' || q.sort === 'album' ? q.sort : 'updated' // updated_at DESC 默认
    const limit = intQuery(q.limit, 100, 1, 500)
    const offset = Math.max(0, intQuery(q.offset, 0, 0, Number.MAX_SAFE_INTEGER))
    const { tracks, total } = libraryTrackStore.list({
      uid,
      limit,
      offset,
      artist: q.artist?.trim() || undefined,
      album: q.album?.trim() || undefined,
      q: q.q?.trim() || undefined,
      sort,
    })
    return {
      tracks: tracks.map((t) => ({
        id: t.id,
        title: t.title,
        artist: t.artist,
        album: t.album,
        durationMs: t.duration_ms,
        format: t.format,
        size: t.size,
        coverState: t.cover_state,
        metaState: t.meta_state,
        updatedAt: t.updated_at,
      })),
      total,
      offset,
      limit,
    }
  })

  // ── 音频流（Range/206/断点续拖）──
  app.get<{ Params: { id: string } }>('/api/v1/library/tracks/:id/stream', async (req, reply) => {
    const uid = effectiveUid(req)
    const id = Number(req.params.id)
    const track = Number.isInteger(id) ? libraryTrackStore.get(uid, id) : undefined
    if (!track) return reply.code(404).send({ error: 'track not found' })

    // 路径安全：解析后必须位于「该 uid 扫描根 ∪ download.dir」内（防 DB 异常路径逃逸）
    if (!libraryTrackStore.isPathAllowed(uid, track.path)) {
      req.log.warn({ trackId: track.id, path: track.path }, 'library stream: path escapes allowed roots')
      return reply.code(404).send({ error: 'track not found' })
    }
    const filePath = path.resolve(track.path)

    let stat: fs.Stats
    try {
      stat = fs.statSync(filePath)
    } catch {
      return reply.code(410).send({ error: 'track file missing (deleted?)' })
    }
    if (!stat.isFile()) return reply.code(410).send({ error: 'track file missing' })

    const size = stat.size
    const contentType = contentTypeOf(filePath)
    const range = parseRange(req.headers.range, size)

    if (range === 'invalid') {
      return reply.code(416).header('Content-Range', `bytes */${size}`).send({ error: 'range not satisfiable' })
    }
    if (range === undefined) {
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

  // ── 封面：缓存优先 → 现场解析（flac PICTURE / mp3 APIC）→ 写缓存 → 200 / 404 ──
  app.get<{ Params: { id: string } }>('/api/v1/library/tracks/:id/cover', async (req, reply) => {
    const uid = effectiveUid(req)
    const id = Number(req.params.id)
    const track = Number.isInteger(id) ? libraryTrackStore.get(uid, id) : undefined
    if (!track) return reply.code(404).send({ error: 'track not found' })

    const sendCover = (buffer: Buffer, mime: string) =>
      reply
        .code(200)
        .header('Content-Type', mime)
        .header('Content-Length', buffer.length)
        // 封面内容随文件 mtime 变化（扫描时会作废旧缓存），允许浏览器缓存 1 天
        .header('Cache-Control', 'private, max-age=86400')
        .send(buffer)

    // 1) 缓存命中（meta 阶段或上次现场解析写入的 {id}.jpg）
    const cached = coverCacheFile(uid, id)
    try {
      const buf = fs.readFileSync(cached)
      return sendCover(buf, 'image/jpeg')
    } catch {
      /* 无缓存继续 */
    }

    // 2) 已定格「无封面」（cover_state=2，扫描时探测过）→ 直接 404 免重复解析
    if (track.cover_state === 2) return reply.code(404).send({ error: 'no cover available' })

    // 3) 现场解析（路径安全同 stream）→ 成功写缓存并定格 cover_state=1；失败定格 2
    if (!libraryTrackStore.isPathAllowed(uid, track.path)) {
      return reply.code(404).send({ error: 'no cover available' })
    }
    const embedded = extractCover(path.resolve(track.path))
    if (!embedded) {
      libraryTrackStore.updateCoverState(uid, id, 2)
      return reply.code(404).send({ error: 'no cover available' })
    }
    try {
      // 缓存目录惰性创建；写失败仅跳过缓存（本次仍返回封面）
      fs.mkdirSync(coverCacheDir(uid), { recursive: true })
      fs.writeFileSync(cached, embedded.buffer)
      libraryTrackStore.updateCoverState(uid, id, 1)
    } catch (err) {
      req.log.warn({ err: (err as Error).message }, 'library cover: cache write failed (serving anyway)')
    }
    return sendCover(embedded.buffer, embedded.mime)
  })

  // ── 删除索引行（不动音频文件）──
  app.delete<{ Params: { id: string } }>('/api/v1/library/tracks/:id', async (req, reply) => {
    const uid = effectiveUid(req)
    const id = Number(req.params.id)
    if (!Number.isInteger(id)) return reply.code(404).send({ error: 'track not found' })
    const deleted = libraryTrackStore.delete(uid, id)
    if (!deleted) return reply.code(404).send({ error: 'track not found' })
    // best-effort 清理封面缓存（失败不影响删除语义）
    try {
      fs.rmSync(coverCacheFile(uid, id), { force: true })
    } catch {
      /* ignore */
    }
    return { ok: true, deleted: true }
  })
}
