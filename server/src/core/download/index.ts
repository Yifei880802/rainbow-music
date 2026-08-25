/**
 * 下载器 — 流式下载 + 进度 + 元数据嵌入
 *
 * 流程：orchestrator 取 URL → 流式下载到临时文件 → 探测格式 →
 *       嵌入封面(sharp 缩放) + 标签 + 歌词 → 落盘到最终路径。
 *
 * 元数据：MP3 用 node-id3；FLAC 用 flac-tagger。封面统一 sharp 缩放。
 *
 * #6 性能加固：NodeID3.write / flac-tagger / sharp 封面处理全部移入
 * worker_threads（tag-worker.ts），主线程维护 1–2 个 worker 的小池；
 * 消息只传文件路径与元数据，封面先落临时文件避免大 buffer 拷贝。
 * part-fail 语义不变：元数据失败降级为 warnings，不影响下载成功状态。
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { Worker } from 'node:worker_threads'
import { pipeline } from 'node:stream/promises'
import needle from 'needle'
import { config } from '../config.js'
import { logger } from '../logger.js'
import type { MusicInfo } from '../adapters/common.js'
import type { Quality } from '../source-engine/lx-env.js'
import type { TagJobMessage, TagResultMessage } from './tag-worker.js'

export interface DownloadMeta {
  name: string
  singer: string
  album?: string
  coverUrl?: string | null
  lyric?: string | null
}

export interface DownloadProgress {
  (received: number, total: number, percent: number): void
}

export interface DownloadOutcome {
  filePath: string
  fileSize: number
  format: 'mp3' | 'flac' | 'unknown'
  warnings: string[]
}

/**
 * 受控 HTTP 状态码错误：CDN/源站返回非 2xx。
 * 携带 httpStatus 标记，队列侧据此熔断不重试（URL 确定失效，重试只会放大故障）。
 */
export class HttpStatusError extends Error {
  readonly httpStatus: number
  constructor(status: number) {
    super(`HTTP ${status}`)
    this.name = 'HttpStatusError'
    this.httpStatus = status
  }
}

/** 鸭子类型判定：是否为受控 HTTP 状态码错误（不依赖 instanceof，跨模块安全）。
 * 叠加 name === 'HttpStatusError' 校验，收窄误判：仅有 httpStatus 数字字段的
 * 第三方错误不会被误识别为受控状态码错误。 */
export function isHttpStatusError(err: unknown): err is HttpStatusError {
  return (
    typeof err === 'object' &&
    err !== null &&
    (err as Error).name === 'HttpStatusError' &&
    typeof (err as { httpStatus?: unknown }).httpStatus === 'number'
  )
}

/** 从 URL 猜扩展名/格式 */
function guessFormat(url: string, contentType?: string): { ext: string; format: 'mp3' | 'flac' | 'unknown' } {
  const lower = url.split('?')[0]!.toLowerCase()
  const ct = (contentType ?? '').toLowerCase()
  if (lower.endsWith('.flac') || ct.includes('flac')) return { ext: 'flac', format: 'flac' }
  if (lower.endsWith('.mp3') || ct.includes('mpeg')) return { ext: 'mp3', format: 'mp3' }
  if (lower.endsWith('.m4a') || ct.includes('mp4') || ct.includes('m4a')) return { ext: 'm4a', format: 'unknown' }
  if (lower.endsWith('.wav')) return { ext: 'wav', format: 'unknown' }
  return { ext: 'mp3', format: 'mp3' }
}

function sanitizeFilename(name: string): string {
  return name.replace(/[/\\:*?"<>|]/g, '_').replace(/\s+/g, ' ').trim().slice(0, 200)
}

function renderName(template: string, meta: DownloadMeta): string {
  return sanitizeFilename(
    template.replace(/\{name\}/g, meta.name).replace(/\{singer\}/g, meta.singer).replace(/\{album\}/g, meta.album ?? ''),
  )
}

/** 下载封面原图并落临时文件（sharp 缩放放到 worker 里做） */
async function fetchRawCoverToTemp(coverUrl: string, dir: string): Promise<string | null> {
  try {
    const resp = await needle('get', coverUrl, { response_timeout: 15_000, follow_max: 3 })
    const raw = resp.body as Buffer
    if (!Buffer.isBuffer(raw) || raw.length < 100) return null
    const tmpPath = path.join(dir, `.cover-${Date.now()}-${Math.random().toString(36).slice(2)}.tmp`)
    await fs.promises.writeFile(tmpPath, raw)
    return tmpPath
  } catch (err) {
    logger.warn({ err: (err as Error).message }, '[download] cover fetch failed')
    return null
  }
}

/**
 * 流式下载单个 URL 到 dest。
 *
 * 健壮化要点：
 *  - needle@3.x 流模式下错误不走 'error' 而是 `out.emit('done', err)`；
 *    response_timeout 只 destroy 连接不发任何事件。故 header 等待 Promise
 *    主监听 `done`（带 err 即失败）、保留 'error' 作防御，另加 120s stall
 *    看门狗兑底（settled 后 clearTimeout）—— 消灭 DNS 失败/连接拒绝/
 *    response_timeout/重定向超限导致的 Promise 永久挂起（并发槽泄漏→队列死锁）。
 *  - needle 只对终态响应发一次 'header'（被跟随的重定向不 emit header），
 *    故到达 statusCode >= 300 的 header 一定是终态（304、无 Location 的
 *    301/302、4xx/5xx），不会再有下一次 header：>= 300 统一受控 reject
 *    （HttpStatusError + resume 排空），不建立到写流的管道，绝不触发
 *    ERR_STREAM_UNABLE_TO_PIPE 崩溃路径。
 *  - 数据管道用 stream/promises pipeline，任一侧 I/O 错误都受控上抛。
 *  - 重定向（follow_max）/响应超时（response_timeout）/读超时（read_timeout）行为不变。
 */
/** header 等待看门狗：任何通道都没事件时 120s 后强制受控失败 */
const HEADER_STALL_TIMEOUT_MS = 120_000

export async function streamDownload(url: string, dest: string, onProgress?: DownloadProgress): Promise<{ contentType?: string }> {
  const req = needle.get(url, { response_timeout: 30_000, read_timeout: 60_000, follow_max: 5 })

  let headers: Record<string, string> = {}
  await new Promise<void>((resolve, reject) => {
    let settled = false
    // stall 看门狗：response_timeout 只 destroy 不发 done，靠它兑底强制 settle
    const stallTimer = setTimeout(() => {
      if (settled) return
      settled = true
      reject(new Error(`请求停滞 ${HEADER_STALL_TIMEOUT_MS / 1000}s 无响应（stall watchdog）`))
    }, HEADER_STALL_TIMEOUT_MS)
    const settle = (fn: () => void): void => {
      if (settled) return
      settled = true
      clearTimeout(stallTimer)
      fn()
    }
    const fail = (err: Error): void => settle(() => reject(err))

    req.on('header', (statusCode: number, hdrs: Record<string, string>) => {
      if (settled) return
      if (statusCode >= 300) {
        // 终态 3xx/4xx/5xx：needle 只对终态发一次 header，到这里一定是最后一次。
        // 受控终止：此时尚未建立任何 pipeline；不 destroy(req)（needle 内部在
        // 'header' 后仍会 incoming.pipe(req)，先销毁会抛 ERR_STREAM_UNABLE_TO_PIPE），
        // 只 reject 并 resume 排空残余响应体，让连接自然释放。
        settle(() => {
          ;(req as unknown as { resume?: () => void }).resume?.()
          reject(new HttpStatusError(statusCode))
        })
        return
      }
      settle(() => {
        headers = hdrs
        resolve()
      })
    })
    // needle@3.x 流模式的真正错误通道：done 携带 err（DNS/拒绝连接/重定向超限等）
    req.on('done', (err?: Error) => {
      if (err) fail(err)
    })
    // 'error' 保留作防御（needle 流模式几乎不发，但第三方补丁/未来版本不保证）
    req.once('error', (err: Error) => fail(err))
  })

  const total = parseInt(headers['content-length'] ?? '0') || 0
  const contentType = headers['content-type']
  const response: NodeJS.ReadableStream = req

  let received = 0
  if (onProgress) {
    response.on('data', (chunk: Buffer) => {
      received += chunk.length
      onProgress(received, total, total ? Math.floor((received / total) * 100) : 0)
    })
  }

  // pipeline 自动双向销毁：源流或写流任一侧出错都会 reject 并清理另一侧，无悬挂流
  await pipeline(response as never, fs.createWriteStream(dest))
  return { contentType }
}

// ── #6 元数据嵌入 worker 小池 ─────────────────────────────────────────────

interface TagJobResult {
  ok: boolean
  warnings: string[]
  /** #45 刮削模式：实际写入补全的字段名列表（下载模式为空） */
  fieldsWritten?: string[]
}

/** 在途 job 超时：60s 无响应按失败降级（part-fail 语义：降 warning 不阻断下载） */
const TAG_JOB_TIMEOUT_MS = 60_000

interface PoolSlot {
  worker: Worker
  /** 当前在途任务的完成回调；null 表示空闲 */
  current: ((r: TagJobResult) => void) | null
  /** 在途 job 超时定时器；空闲为 null */
  timer: NodeJS.Timeout | null
  /** 已被 error/exit/超时处理过（避免 error+exit 双触发重复 respawn） */
  dead: boolean
}

/** dev（tsx 直跑 .ts）与 prod（编译后 .js）的 worker 入口按当前模块扩展名选择 */
function tagWorkerUrl(): URL {
  return import.meta.url.endsWith('.ts')
    ? new URL('./tag-worker.ts', import.meta.url)
    : new URL('./tag-worker.js', import.meta.url)
}

/** worker 数：config.download.tagWorkers 手动值优先，否则 clamp(floor(CPU/2), 1, 2) */
function resolveTagWorkerCount(): number {
  const manual = config.download.tagWorkers
  if (typeof manual === 'number' && manual > 0) return Math.min(Math.floor(manual), 4)
  const cpus = typeof os.availableParallelism === 'function' ? os.availableParallelism() : os.cpus().length
  return Math.min(2, Math.max(1, Math.floor(cpus / 2)))
}

class TagWorkerPool {
  private slots: PoolSlot[] = []
  private waitQueue: { job: TagJobMessage; resolve: (r: TagJobResult) => void }[] = []
  private seq = 0
  private terminated = false

  constructor(private readonly size: number) {}

  private spawnSlot(): PoolSlot {
    const worker = new Worker(tagWorkerUrl())
    worker.unref() // 不阻止进程退出
    const slot: PoolSlot = { worker, current: null, timer: null, dead: false }
    worker.on('message', (res: TagResultMessage) => {
      this.clearJobTimer(slot)
      const done = slot.current
      slot.current = null
      // #45：透传刮削模式的 fieldsWritten（下载模式为 undefined，不影响原语义）
      done?.({ ok: res.ok, warnings: res.warnings ?? [], fieldsWritten: res.fieldsWritten })
      this.pump()
    })
    worker.on('error', (err) => {
      logger.warn({ err: err.message }, '[download] tag worker crashed, respawning')
      this.failAndRespawn(slot, `元数据 worker 崩溃: ${err.message}`)
    })
    worker.on('exit', (code) => {
      // code===0 或已被 error/超时接管（dead）时不重复处理；terminated 时由 terminate() 收尾
      if (this.terminated || slot.dead || code === 0) return
      logger.warn({ code }, '[download] tag worker exited abnormally, respawning')
      this.failAndRespawn(slot, `元数据 worker 异常退出 (code=${code})`)
    })
    return slot
  }

  /** 兑现在途 Promise 为失败，并 terminate + respawn 该 slot */
  private failAndRespawn(slot: PoolSlot, warning: string): void {
    if (slot.dead) return
    slot.dead = true
    this.clearJobTimer(slot)
    const done = slot.current
    slot.current = null
    done?.({ ok: false, warnings: [warning] })
    void slot.worker.terminate().catch(() => {})
    const idx = this.slots.indexOf(slot)
    if (idx >= 0) this.slots[idx] = this.spawnSlot()
    this.pump()
  }

  private clearJobTimer(slot: PoolSlot): void {
    if (slot.timer) {
      clearTimeout(slot.timer)
      slot.timer = null
    }
  }

  private pump(): void {
    if (this.terminated || this.waitQueue.length === 0) return
    const idle = this.slots.find((s) => s.current === null && !s.dead)
    if (!idle) return
    const next = this.waitQueue.shift()!
    idle.current = next.resolve
    // 在途 job 60s 超时：超时按 ok:false 降级 warning 并 terminate+respawn 该 slot
    idle.timer = setTimeout(() => {
      if (idle.current === null) return
      logger.warn({ jobId: next.job.jobId }, '[download] tag job timeout (60s), respawning worker')
      this.failAndRespawn(idle, '元数据嵌入超时 (60s)，已重启对应 worker')
    }, TAG_JOB_TIMEOUT_MS)
    idle.timer.unref?.()
    idle.worker.postMessage(next.job)
  }

  run(job: Omit<TagJobMessage, 'jobId'>): Promise<TagJobResult> {
    if (this.slots.length === 0) {
      for (let i = 0; i < this.size; i++) this.slots.push(this.spawnSlot())
      logger.info({ workers: this.size }, '[download] tag worker pool ready')
    }
    const jobId = ++this.seq
    return new Promise((resolve) => {
      this.waitQueue.push({ job: { ...job, jobId }, resolve })
      this.pump()
    })
  }

  async terminate(): Promise<void> {
    this.terminated = true
    for (const s of this.slots) {
      s.dead = true
      this.clearJobTimer(s)
      s.current?.({ ok: false, warnings: ['worker 池已关闭'] })
      s.current = null
    }
    await Promise.all(this.slots.map((s) => s.worker.terminate()))
    this.slots = []
  }
}

let tagPool: TagWorkerPool | null = null
function getTagPool(): TagWorkerPool {
  if (!tagPool) tagPool = new TagWorkerPool(resolveTagWorkerCount())
  return tagPool
}

/** #45 刮削写回复用：把标签 job 派发到既有 TagWorkerPool（串行化、已 unref） */
export function runTagJob(job: Omit<TagJobMessage, 'jobId'>): Promise<TagJobResult> {
  return getTagPool().run(job)
}

/**
 * #73 启动时清理下载目录里的 .tmp-* 残留临时文件。
 *
 * 背景：流式下载先落 `.tmp-{ts}-{rand}` 再 rename 为最终文件名，进程崩溃/被 kill
 * 时 rename 未及执行便会遗留无法自愈的残留。启动时（此时队列尚未恢复出队，无在途
 * .tmp 文件）扫描删除。
 * 命名规则与进行中的临时文件完全无关：只匹配 .tmp- 前缀，不碰 .cover-*.tmp
 * 封面临存与其他任何文件；单文件删除失败仅告警不中断，目录不存在静默忽略
 * （首次启动无下载目录属正常）。
 */
export async function cleanupTmpResidue(): Promise<void> {
  const dir = config.download.dir
  let entries: fs.Dirent[]
  try {
    entries = await fs.promises.readdir(dir, { withFileTypes: true })
  } catch {
    return // 目录不存在（首启未下载过）或不可读：无需清理
  }
  let removed = 0
  for (const e of entries) {
    if (!e.isFile() || !e.name.startsWith('.tmp-')) continue
    try {
      await fs.promises.rm(path.join(dir, e.name), { force: true })
      removed++
    } catch (err) {
      logger.warn({ file: e.name, err: (err as Error).message }, '[download] 临时残留文件清理失败（忽略）')
    }
  }
  if (removed > 0) logger.info(`[download] 清理 ${removed} 个临时文件`)
}

// ───────────────────────────────────────────────────────────────────────────

export const downloader = {
  /**
   * 下载并嵌入元数据。part-fail 语义：下载成功但封面/标签失败 → warnings 非空。
   */
  async download(
    url: string,
    _quality: Quality,
    meta: DownloadMeta,
    musicInfo: MusicInfo,
    onProgress?: DownloadProgress,
  ): Promise<DownloadOutcome> {
    void musicInfo
    const warnings: string[] = []
    const dir = config.download.dir
    fs.mkdirSync(dir, { recursive: true })

    const baseName = renderName(config.download.nameTemplate, meta) || `${meta.name} - ${meta.singer}`

    // 先下到临时文件，拿到 content-type 再定扩展名
    const tmpPath = path.join(dir, `.tmp-${Date.now()}-${Math.random().toString(36).slice(2)}`)
    let contentType: string | undefined
    try {
      const r = await streamDownload(url, tmpPath, onProgress)
      contentType = r.contentType
    } catch (err) {
      await fs.promises.rm(tmpPath, { force: true })
      const wrapped = new Error(`下载失败: ${(err as Error).message}`)
      // 保留受控 HTTP 状态码标记，供队列侧熔断判定（不重试失效 URL）
      if (isHttpStatusError(err)) (wrapped as Error & { httpStatus?: number }).httpStatus = err.httpStatus
      throw wrapped
    }

    const { ext, format } = guessFormat(url, contentType)
    const finalPath = path.join(dir, `${baseName}.${ext}`)
    await fs.promises.rename(tmpPath, finalPath)

    // 封面：主线程只负责下载原图落临时文件，resize 交给 worker
    // 要求嵌封面但音源未提供封面 URL 时显式记 warning（不改终态，仅可观测）
    let coverPath: string | null = null
    if (config.download.embedCover) {
      if (meta.coverUrl) {
        coverPath = await fetchRawCoverToTemp(meta.coverUrl, dir)
        if (!coverPath) warnings.push('封面获取失败')
      } else {
        warnings.push('封面未嵌入：音源未提供封面')
      }
    }
    const lyricMeta: DownloadMeta = { ...meta, lyric: config.download.embedLyric ? meta.lyric : null }

    // 标签：worker 内完成 sharp + node-id3 / flac-tagger，失败降级 warnings
    try {
      if (format === 'mp3' || format === 'flac') {
        const res = await getTagPool().run({
          filePath: finalPath,
          format,
          meta: { name: lyricMeta.name, singer: lyricMeta.singer, album: lyricMeta.album, lyric: lyricMeta.lyric },
          coverPath,
          coverSize: config.download.coverSize,
        })
        warnings.push(...res.warnings)
        if (res.warnings.length) logger.warn({ warnings: res.warnings, finalPath }, '[download] tag embed warnings')
        // job 失败（worker 崩溃/超时/池关闭）时 worker 未走到清理逻辑，主线程兑底删封面临时文件
        if (!res.ok && coverPath) await fs.promises.rm(coverPath, { force: true })
      } else {
        warnings.push(`未知格式(${ext})，跳过标签嵌入`)
        if (coverPath) await fs.promises.rm(coverPath, { force: true })
      }
    } catch (err) {
      warnings.push(`标签嵌入失败: ${(err as Error).message}`)
      logger.warn({ err: (err as Error).message, finalPath }, '[download] tag embed failed')
      if (coverPath) await fs.promises.rm(coverPath, { force: true })
    }

    const stat = await fs.promises.stat(finalPath)
    return { filePath: finalPath, fileSize: stat.size, format, warnings }
  },
}
