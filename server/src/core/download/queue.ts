/**
 * 下载任务队列 — SQLite 持久化 + p-queue 内存调度
 *
 * 生命周期：pending → active → completed / completed_with_warnings / failed
 * 重启时把中断的 active 重新入队（requeueInterrupted）。
 *
 * #6 性能加固：
 *  - 进度落盘节流：SSE 仍每 chunk 推送，SQLite 按 500ms / 2% 双阈值合并写入，
 *    任务完成/失败/取消时强制落盘
 *  - 失败指数退避重试：1s/2s/4s（retryMax / retryBaseDelayMs 可配置）
 *  - 并发优先级：config.yaml 显式配置 download.concurrency 时手动值优先；
 *    仅缺省时才自适应 clamp(CPU核数, 2, 6)（autoConcurrency=false 同样手动优先）
 *  - RSS 资源护栏：周期采样 process.memoryUsage().rss，超阈值暂停出队，回落后恢复
 *  - batch 入队背压：内存中最多同时激活 batchActivationSize（默认 200）个任务，
 *    超量部分在 activationBuffer 中排队，随任务完成分批激活
 */
import os from 'node:os'
import fs from 'node:fs'
import PQueue from 'p-queue'
import { randomUUID } from 'node:crypto'
import { EventEmitter } from 'node:events'
import { taskStore, initDb, type DownloadTaskRow, type TaskStatus, type ScrapeStatus } from '../db/index.js'
import { orchestrator, isNoSourceError } from '../orchestrator/index.js'
import { downloader, isHttpStatusError } from './index.js'
import { fetchLyric, fetchCoverUrl } from '../adapters/metadata.js'
import { config, isConcurrencyExplicit } from '../config.js'
import { logger } from '../logger.js'
import type { MusicInfo } from '../adapters/common.js'
import type { Quality } from '../source-engine/lx-env.js'

export interface EnqueueInput {
  platform: string
  musicInfo: MusicInfo
  quality: Quality
  primarySourceId?: string
  sourceIds?: string[]
}

function clamp(n: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, n))
}

function cpuCount(): number {
  return typeof os.availableParallelism === 'function' ? os.availableParallelism() : os.cpus().length
}

/**
 * 并发解析：显式配置优先。
 * config.yaml 中显式存在 download.concurrency（或 autoConcurrency=false）且值合法时，
 * 手动值优先；仅缺省未配时才自适应 clamp(CPU核数, 2, 6)。
 */
function resolveConcurrency(): number {
  const manual = config.download.concurrency
  const manualValid = typeof manual === 'number' && Number.isFinite(manual) && manual > 0
  if (manualValid && (config.download.autoConcurrency === false || isConcurrencyExplicit())) return Math.floor(manual)
  return clamp(cpuCount(), 2, 6)
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

function toTaskView(row: DownloadTaskRow) {
  let scrapeInfo: Record<string, unknown> | null = null
  if (row.scrape_info) {
    try {
      scrapeInfo = JSON.parse(row.scrape_info) as Record<string, unknown>
    } catch {
      scrapeInfo = null
    }
  }
  return {
    id: row.id,
    platform: row.platform,
    songmid: row.songmid,
    name: row.name,
    singer: row.singer,
    album: row.album,
    requestedQuality: row.requested_quality,
    actualQuality: row.actual_quality,
    actualSource: row.actual_source,
    status: row.status,
    progress: row.progress,
    filePath: row.file_path,
    fileSize: row.file_size,
    warnings: row.warnings ? (JSON.parse(row.warnings) as string[]) : [],
    error: row.error,
    scrapeStatus: (row.scrape_status ?? 'pending') as ScrapeStatus,
    scrapeInfo,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

class DownloadQueue extends EventEmitter {
  private queue = new PQueue({ concurrency: resolveConcurrency() })

  // ── #6 batch 入队背压：p-queue 中同时激活的任务 ≤ batchLimit，其余排队分批激活 ──
  private activationBuffer: string[] = []
  private scheduled = 0
  private readonly batchLimit = config.download.batchActivationSize ?? 200

  // ── #6 RSS 资源护栏 ──
  private memGuardTimer: NodeJS.Timeout | null = null
  private memPaused = false

  // ── 崩溃循环熔断：重启重排计数（持久化在专用列 requeue_count）──
  // 进程内 run() 的 attempt 是内存态，进程崩溃即丢失；若任务反复因同一确定性错误
  // （如失效 URL）在启动时被 requeueInterrupted 重排，会形成“启动即崩/反复失败”死循环。
  // 计数存在 download_tasks.requeue_count 专用列（不再污染 warnings；内部簿记不外泄），
  // 跨重启累计重排次数超过 retryMax 即置 failed 不再重排；手动 retry() 会重置计数。
  // 优雅停机（SIGTERM/SIGINT）已把 active 置回 pending 并写干净停机标记，
  // 正常重启/发版不计熔断，避免健康任务跨 4 次正常重启被误熔断。
  private shuttingDown = false

  private readRequeueCount(row: DownloadTaskRow): number {
    return typeof row.requeue_count === 'number' ? row.requeue_count : 0
  }

  private writeRequeueCount(id: string, count: number): void {
    taskStore.update(id, { requeue_count: count })
  }

  setConcurrency(n: number): void {
    this.queue.concurrency = n
  }

  init(): void {
    initDb()
    // 熔断判定直接采用 requeueInterrupted 返回的 id 集合（同事务先 SELECT 后 UPDATE，
    // 采样范围与重排范围完全对齐，不再需要 limit:1000 的二次采样）。
    const interruptedIds = new Set(taskStore.requeueInterrupted())
    // 干净停机判定：上一周期是优雅停机（active 已在停机时置回 pending 并写标记），
    // 即使因时序原因仍有 active 残留，也不计入崩溃循环熔断。
    const lastShutdown = taskStore.getMeta('last_shutdown') ?? ''
    const cleanShutdown = lastShutdown.startsWith('clean')
    taskStore.setMeta('last_shutdown', 'dirty') // 立即消费标记：本次周期未正常结束即视为崩溃
    if (interruptedIds.size > 0) {
      logger.warn({ count: interruptedIds.size, cleanShutdown }, '[queue] requeued interrupted task(s)')
    }
    // 重启续跑：把所有 pending 重新塞进内存队列（经背压分批激活）。
    // 分页循环直至取尽，不再 limit:1000 截断；全量快照是同步完成的
    // （better-sqlite3 同步 API），不会与后续异步执行的任务产生分页竞态。
    // 仅对本轮 requeueInterrupted 重排而来、且上一周期非优雅停机的任务累计熔断计数；
    // 原本就是 pending（尚未开始执行）或正常重启留下的任务不计入崩溃循环判定。
    const maxRequeue = config.download.retryMax ?? 3
    const PAGE = 200
    const pendingRows: DownloadTaskRow[] = []
    for (let offset = 0; ; offset += PAGE) {
      const rows = taskStore.list({ status: 'pending', limit: PAGE, offset })
      pendingRows.push(...rows)
      if (rows.length < PAGE) break
    }
    for (const row of pendingRows) {
      if (interruptedIds.has(row.id) && !cleanShutdown) {
        const count = this.readRequeueCount(row) + 1
        if (count > maxRequeue) {
          this.writeRequeueCount(row.id, 0)
          this.setStatus(row.id, 'failed', { error: `熔断：连续 ${count} 次重启重排均失败，停止自动重试（可手动重试）` })
          logger.error({ id: row.id, requeues: count }, '[queue] 崩溃循环熔断，任务置 failed 不再重排')
          continue
        }
        this.writeRequeueCount(row.id, count)
      }
      this.schedule(row.id)
    }
    this.startMemGuard()
    logger.info({ concurrency: this.queue.concurrency, batchLimit: this.batchLimit }, '[queue] ready')
  }

  enqueue(input: EnqueueInput): string {
    const id = randomUUID()
    const now = Date.now()
    const row: DownloadTaskRow = {
      id,
      keyword_source: input.platform,
      platform: input.platform,
      songmid: String(input.musicInfo.songmid),
      name: input.musicInfo.name,
      singer: input.musicInfo.singer,
      album: input.musicInfo.albumName ?? '',
      requested_quality: input.quality,
      actual_quality: null,
      actual_source: null,
      music_info: JSON.stringify({
        ...input,
      }),
      status: 'pending',
      progress: 0,
      file_path: null,
      file_size: null,
      warnings: null,
      error: null,
      requeue_count: 0,
      scrape_status: 'pending',
      scrape_info: null,
      created_at: now,
      updated_at: now,
    }
    taskStore.insert(row)
    this.emit('task:created', toTaskView(row))
    this.schedule(id)
    return id
  }

  /** 入队调度：超过 batchLimit 的进激活缓冲，随任务完成分批进 p-queue */
  private schedule(id: string): void {
    if (this.scheduled >= this.batchLimit) {
      this.activationBuffer.push(id)
      return
    }
    this.activate(id)
  }

  private activate(id: string): void {
    this.scheduled++
    // run() 内部已全量 try/catch，这里的 .catch 只兑底 run 循环外的意外异常，
    // 杜绝 unhandledRejection 击穿进程；无论成败都释放激活槽位。
    void this.queue
      .add(() => this.run(id))
      .catch((err) => logger.error({ id, err: (err as Error)?.message ?? String(err) }, '[queue] 任务执行意外异常（已捕获，进程继续）'))
      .finally(() => this.releaseSlot())
  }

  private releaseSlot(): void {
    this.scheduled = Math.max(0, this.scheduled - 1)
    const next = this.activationBuffer.shift()
    if (next !== undefined) this.activate(next)
  }

  /** #6 RSS 护栏：周期采样，超阈值暂停出队，回落 10% 后恢复 */
  private startMemGuard(): void {
    if (this.memGuardTimer) return
    const intervalMs = config.download.memGuardIntervalMs ?? 5000
    const limitMB = config.download.memLimitMB ?? 400
    this.memGuardTimer = setInterval(() => {
      const rssMB = process.memoryUsage().rss / 1024 / 1024
      if (!this.memPaused && rssMB > limitMB) {
        this.memPaused = true
        this.queue.pause()
        logger.warn({ rssMB: Math.round(rssMB), limitMB }, '[queue] RSS 超阈值，暂停出队')
      } else if (this.memPaused && rssMB < limitMB * 0.9) {
        this.memPaused = false
        this.queue.start()
        logger.info({ rssMB: Math.round(rssMB), limitMB }, '[queue] RSS 回落，恢复出队')
      }
    }, intervalMs)
    this.memGuardTimer.unref()
  }

  private setStatus(id: string, status: TaskStatus, patch: Partial<DownloadTaskRow> = {}): void {
    // 停机窗口内冻结状态迁移：active 已由 shutdown() 统一置回 pending，
    // 避免在途 run() 的后续回写覆盖重排结果。
    if (this.shuttingDown) return
    taskStore.update(id, { status, ...patch })
    const row = taskStore.get(id)
    if (row) this.emit(`task:${status}`, toTaskView(row))
  }

  private isCanceled(id: string): boolean {
    return taskStore.get(id)?.status === 'canceled'
  }

  /** 单次执行：编排取 URL → 歌词/封面 → 下载 + 元数据（返回供最终状态判定） */
  private async runOnce(id: string, input: EnqueueInput, onProgress: (received: number, total: number, percent: number) => void) {
    // 1) 编排器跨音源取 URL（同音质横向找遍 → 降级）
    const { result } = await orchestrator.resolveUrl({
      platform: input.platform,
      musicInfo: input.musicInfo,
      quality: input.quality,
      primarySourceId: input.primarySourceId,
      sourceIds: input.sourceIds,
    })

    // 换源后：歌词/封面/标签都用实际命中的平台与歌曲对象（洛雪 toggleSource 行为）
    const effPlatform = result.platform
    const effMusicInfo = result.musicInfo as MusicInfo

    // 2) 歌词 + 封面（best-effort，走平台官方接口，洛雪逻辑：不走音源）
    const [lyricRes, coverUrl] = await Promise.all([
      fetchLyric(effPlatform, effMusicInfo),
      fetchCoverUrl(effPlatform, effMusicInfo),
    ])
    const lyric = lyricRes?.lyric ?? null

    // 3) 下载 + 元数据（标题/歌手/专辑仍用原曲信息，保持用户搜索预期；封面/歌词用实际命中源）
    const outcome = await downloader.download(
      result.url,
      result.quality,
      {
        name: input.musicInfo.name,
        singer: input.musicInfo.singer,
        album: input.musicInfo.albumName,
        coverUrl,
        lyric,
      },
      input.musicInfo,
      onProgress,
    )
    return { result, outcome }
  }

  private async run(id: string): Promise<void> {
    const row = taskStore.get(id)
    if (!row || row.status === 'canceled') return
    const input = JSON.parse(row.music_info) as EnqueueInput

    this.setStatus(id, 'active', { progress: 0 })
    this.emit('task:active', toTaskView(taskStore.get(id)!))

    // ── #6 进度落盘节流：SSE 仍每 chunk 推，SQLite 按 500ms / 2% 双阈值合并写 ──
    const flushIntervalMs = config.download.progressFlushIntervalMs ?? 500
    const flushPercentStep = config.download.progressFlushPercentStep ?? 2
    let lastFlushAt = 0
    let lastFlushedPercent = -1
    let latestPercent = 0
    const flushProgress = (): void => {
      if (latestPercent === lastFlushedPercent) return
      lastFlushAt = Date.now()
      lastFlushedPercent = latestPercent
      taskStore.update(id, { progress: latestPercent })
    }
    const onProgress = (received: number, total: number, percent: number): void => {
      latestPercent = percent
      this.emit('task:progress', { id, received, total, percent })
      const now = Date.now()
      if (now - lastFlushAt >= flushIntervalMs || percent - lastFlushedPercent >= flushPercentStep) flushProgress()
    }

    // ── #6 失败指数退避重试：1s/2s/4s，retryMax 可配置（默认 3）──
    // 注：attempt 仅覆盖“同一进程周期内”的失败重试；跨重启的重排场景（进程崩溃后
    // requeueInterrupted 再入队）由 init() 中持久化的重排计数熔断兑底，两者不重复。
    const maxRetries = config.download.retryMax ?? 3
    const baseDelayMs = config.download.retryBaseDelayMs ?? 1000
    let attempt = 0

    for (;;) {
      try {
        const { result, outcome } = await this.runOnce(id, input, onProgress)
        if (this.isCanceled(id)) {
          flushProgress()
          this.cleanupCanceledFile(outcome.filePath)
          return
        }

        // 换源提示先入 warnings，再判定最终状态（换源本身即视为 with_warnings）
        if (result.toggled) outcome.warnings.push(`跨平台换源：${input.platform} → ${result.platform}（原平台取 URL 失败，自动换到同款歌曲）`)
        const finalStatus: TaskStatus = outcome.warnings.length ? 'completed_with_warnings' : 'completed'

        this.setStatus(id, finalStatus, {
          progress: 100,
          actual_quality: result.quality,
          actual_source: result.toggled ? `${result.sourceId}@${result.platform}` : result.sourceId,
          file_path: outcome.filePath,
          file_size: outcome.fileSize,
          warnings: outcome.warnings.length ? JSON.stringify(outcome.warnings) : null,
        })
        logger.info({ id, status: finalStatus, file: outcome.filePath, quality: result.quality, source: result.sourceId }, '[queue] done')
        return
      } catch (err) {
        if (this.isCanceled(id)) {
          flushProgress()
          return
        }
        const error = err instanceof Error ? err.message : String(err)
        // ── 熔断：确定性不可恢复错误直接 failed，不走退避重试。
        // 1) 受控 HTTP 状态码错误（CDN/源站明确返回非 2xx）：对同一 URL 确定性失效，
        //    重试只会反复命中同一故障。
        // 2) NoSourceError（编排层无可用音源）：重试不可能改变音源可用性，
        //    直接失败恢复 bench 口径（否则无音源场景走满 1s+2s+4s 退避）。
        if (isHttpStatusError(err) || isNoSourceError(err)) {
          flushProgress()
          this.setStatus(id, 'failed', { error })
          logger.error({ id, error, kind: isHttpStatusError(err) ? `http-${(err as { httpStatus: number }).httpStatus}` : 'no-source' }, '[queue] 确定性错误，不重试直接失败')
          return
        }
        if (attempt >= maxRetries) {
          flushProgress() // 失败时强制落盘最后进度
          this.setStatus(id, 'failed', { error })
          logger.error({ id, error, attempts: attempt + 1 }, '[queue] failed')
          return
        }
        const delayMs = baseDelayMs * 2 ** attempt
        attempt++
        logger.warn({ id, attempt, delayMs, error }, '[queue] 下载失败，指数退避后重试')
        await sleep(delayMs)
        if (this.isCanceled(id)) {
          flushProgress()
          return
        }
      }
    }
  }

  /** 取消发生在下载落盘之后：best-effort 删除已落盘的孤儿文件（失败不影响取消语义） */
  private cleanupCanceledFile(filePath: string | null | undefined): void {
    if (!filePath) return
    fs.promises.rm(filePath, { force: true }).catch((err) => {
      logger.warn({ filePath, err: (err as Error).message }, '[queue] 已取消任务的落盘文件清理失败（忽略）')
    })
  }

  cancel(id: string): boolean {
    const row = taskStore.get(id)
    if (!row) return false
    if (row.status === 'pending' || row.status === 'active') {
      this.setStatus(id, 'canceled')
      return true
    }
    return false
  }

  retry(id: string): boolean {
    const row = taskStore.get(id)
    if (!row) return false
    if (row.status === 'failed' || row.status === 'canceled' || row.status === 'completed_with_warnings') {
      // warnings 置 null + 重置重启重排熔断计数：手动重试视为新一轮周期；
      // 刮削字段一并重置（重新下载会产生新文件，旧刮削结果失效，完成后重新自动刮）
      taskStore.update(id, { status: 'pending', progress: 0, error: null, warnings: null, requeue_count: 0, scrape_status: 'pending', scrape_info: null })
      this.schedule(id)
      return true
    }
    return false
  }

  /**
   * 优雅停机（SIGTERM/SIGINT）：停止出队新任务，把在途 active 置回 pending，
   * 并写干净停机标记（下次启动 init() 据此不计数熔断）。
   * 同步执行（better-sqlite3 同步 API），调用方随后即可退出进程。
   */
  shutdown(): void {
    if (this.shuttingDown) return
    this.shuttingDown = true
    this.queue.pause()
    this.activationBuffer = []
    const ids = taskStore.requeueInterrupted()
    taskStore.setMeta('last_shutdown', `clean:${Date.now()}`)
    logger.warn({ requeued: ids.length }, '[queue] graceful shutdown: active task(s) reset to pending, clean marker written')
  }

  list(status?: TaskStatus) {
    return taskStore.list({ status, limit: 200 }).map(toTaskView)
  }

  get(id: string) {
    const row = taskStore.get(id)
    return row ? toTaskView(row) : undefined
  }

  remove(id: string): boolean {
    const row = taskStore.get(id)
    if (!row) return false
    taskStore.delete(id)
    return true
  }

  stats() {
    return { pending: this.queue.pending, active: this.queue.size > 0 ? this.queue.pending : 0 }
  }
}

export const downloadQueue = new DownloadQueue()
