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
import { taskStore, initDb, type DownloadTaskRow, type DownloadAttemptRow, type TaskStatus, type ScrapeStatus } from '../db/index.js'
import { orchestrator, isNoSourceError, type ResolveAttempt } from '../orchestrator/index.js'
import { downloader, isPermanentHttpError, type DownloadOutcome } from './index.js'
import { encodeErrorFrom, decodeError, classifyError, DiskFullError } from './errors.js'
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
  /** H1: 批量入队批次 id（enqueueBatch 生成 UUID 后透传；单首入队缺省 null） */
  batchId?: string
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

// ── N3: enqueue 前磁盘空间预检 ──────────────────────────────────────────────
// check-disk-space 是异步 API，故 enqueue 亦为异步。2s 结果缓存：批量入队时避免
// 每首都 syscall 探测同一挂载点。fail-open：依赖缺失/探测异常时放行（仅记 debug），
// 绝不因预检自身故障阻断正常下载。开关 download.diskPrecheck（默认 true），
// 阈值 download.minFreeBytes（默认 100MB）；不足抛 DiskFullError → 路由映射 507。
let diskSpaceCache: { at: number; free: number } | null = null
const DISK_CACHE_TTL_MS = 2000
async function assertDiskSpace(): Promise<void> {
  if (config.download.diskPrecheck === false) return
  const minFree =
    typeof config.download.minFreeBytes === 'number' && config.download.minFreeBytes > 0
      ? config.download.minFreeBytes
      : 104857600
  const now = Date.now()
  let free: number
  if (diskSpaceCache && now - diskSpaceCache.at < DISK_CACHE_TTL_MS) {
    free = diskSpaceCache.free
  } else {
    try {
      // NodeNext 下类型解析为 CJS 形态（.d.ts 无 type:module），运行时走 .mjs（真 ESM）；
      // 兼容互操作可能出现的两层 default：mod.default.default ?? mod.default。
      const mod = (await import('check-disk-space')) as unknown as { default?: unknown }
      const inner = mod.default as { default?: unknown } | undefined
      const cand = inner?.default ?? mod.default
      if (typeof cand !== 'function') throw new Error('check-disk-space 无可用默认导出')
      const checkDiskSpace = cand as (p: string) => Promise<{ free: number; size: number; diskPath: string }>
      const res = await checkDiskSpace(config.download.dir)
      free = res.free
      diskSpaceCache = { at: now, free }
    } catch (err) {
      logger.debug({ err: (err as Error).message }, '[queue] 磁盘预检不可用，放行入队')
      return
    }
  }
  if (free < minFree) throw new DiskFullError(free, minFree)
}

function toTaskView(row: DownloadTaskRow) {
  let scrapeInfo: Record<string, unknown> | null = null
  if (row.scrape_info) {
    try {
      scrapeInfo = JSON.parse(row.scrape_info) as Record<string, unknown>
    } catch {
      scrapeInfo = null
    }
  }
  // M1: error 落盘为 {code,message} JSON；decodeError 向后兼容旧纯字符串（读取不崩）。
  // error 仍暴露人类可读 message（前端旧逻辑不破），errorCode 为新增结构化字段。
  const decodedError = decodeError(row.error)
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
    error: decodedError?.message ?? null,
    errorCode: decodedError?.code ?? null,
    scrapeStatus: (row.scrape_status ?? 'pending') as ScrapeStatus,
    scrapeInfo,
    // C2: 真实音质回写字段（经 SSE task:completed 推送前端）
    actualBitrate: row.actual_bitrate ?? null,
    actualCodec: row.actual_codec ?? null,
    actualSampleRate: row.actual_sample_rate ?? null,
    // H1: 批量批次 id（单首入队为 null）
    batchId: row.batch_id ?? null,
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

  // ── H3 用户暂停（与 memPaused 独立）：RSS 回落恢复时不得覆盖用户暂停意图 ──
  private userPaused = false

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

  async enqueue(input: EnqueueInput): Promise<string> {
    // ── H5 去重/幂等：按 (platform, songmid, requested_quality) 查在途/已完成任务 ──
    // dedupePolicy: skip(默认，命中即复用既有任务 id、不新建) | replace(取消在途重复项后新建) | always-new(永不去重)
    const songmid = String(input.musicInfo.songmid)
    const policy = config.download.dedupePolicy ?? 'skip'
    if (policy !== 'always-new') {
      const dup = taskStore.findDuplicate(input.platform, songmid, input.quality)
      if (dup) {
        if (policy === 'skip') {
          logger.info({ id: dup.id, platform: input.platform, songmid, quality: input.quality }, '[queue] 去重命中（skip），复用既有任务')
          return dup.id
        }
        // replace：在途重复项先取消（已完成项无需取消，直接新建重下）
        if (dup.status === 'pending' || dup.status === 'active') {
          this.cancel(dup.id)
          logger.info({ id: dup.id }, '[queue] 去重命中（replace），已取消在途重复项')
        }
      }
    }

    // N3: 新建任务前磁盘空间预检（skip 去重复用既有任务已在上方 return，不触发预检）
    await assertDiskSpace()

    const id = randomUUID()
    const now = Date.now()
    const row: DownloadTaskRow = {
      id,
      keyword_source: input.platform,
      platform: input.platform,
      songmid,
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
      actual_bitrate: null,
      actual_codec: null,
      actual_sample_rate: null,
      batch_id: input.batchId ?? null,
      created_at: now,
      updated_at: now,
    }
    taskStore.insert(row)
    this.emit('task:created', toTaskView(row))
    this.schedule(id)
    return id
  }

  /**
   * H1: 批量入队——生成单一 batchId 写入本批全部新建任务，返回 batchId 与逐项结果。
   * 去重命中的项（skip 策略）复用既有任务 id，不归属本批次（既有任务保留原 batch_id）。
   * 调用方需先完成入参校验（platform/musicInfo/quality）。
   */
  async enqueueBatch(inputs: EnqueueInput[]): Promise<{ batchId: string; ids: string[] }> {
    const batchId = randomUUID()
    // N3: enqueue 现为异步（磁盘预检），逐项 await；共享同一 batchId
    const ids = await Promise.all(inputs.map((inp) => this.enqueue({ ...inp, batchId })))
    return { batchId, ids }
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
        // H3: 仅在用户未暂停时恢复出队（用户暂停优先于 RSS 回落）
        if (!this.userPaused) this.queue.start()
        logger.info({ rssMB: Math.round(rssMB), limitMB, userPaused: this.userPaused }, '[queue] RSS 回落，恢复出队')
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
    const { result, attempts } = await orchestrator.resolveUrl({
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
    let outcome: DownloadOutcome
    try {
      outcome = await downloader.download(
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
        id, // F2: 持久化临时名 .tmp-{id}，支持失败/重启后 Range 续传
      )
    } catch (dlErr) {
      // M-1(#203): 直连取流阶段失败（HTTP 410/4xx/5xx、超时、DNS 等）此前不落审计，
      // 导致前端「为什么失败」面板对这类失败显示空态。这里补一行 ok:false 轨迹——复用编排已
      // 命中的 source/platform/quality，error_code 交由 run() catch 内 persistAttempts 的
      // classifyError 从错误文本归类（download/index.ts 已把错误包装为「下载失败: HTTP 410」，
      // 可命中 ERR_HTTP_4XX/5XX；超时/DNS 同理），复用 #198 errors.ts 中枢，不另造映射。
      // 刻意挂到**独立属性 directAttempts**（而非 attempts）：classifyError 把 attempts 数组视为
      // 「全源失败」信号(ERR_ALL_SOURCES_FAILED)，若复用会篡改任务级 errorCode，违背「不改变
      // 任务级 error 文案/码、不改重试策略」的向后兼容约束——本处只补审计写入。
      const directAttempt: ResolveAttempt = {
        quality: result.quality,
        sourceId: result.sourceId,
        ok: false,
        error: dlErr instanceof Error ? dlErr.message : String(dlErr),
        platform: result.platform,
        toggled: result.toggled,
      }
      ;(dlErr as { directAttempts?: ResolveAttempt[] }).directAttempts = [directAttempt]
      throw dlErr
    }
    return { result, outcome, attempts }
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
    // N2: SSE task:progress 节流（与下方 SQLite 落盘节流**解耦**）：100ms / 1% 双阈值，
    // percent===100 强制推送收尾。避免每 chunk 一条 SSE 击穿前端渲染与网络。
    let lastEmitAt = 0
    let lastEmittedPercent = -1
    const SSE_MIN_INTERVAL_MS = 100
    const SSE_MIN_PERCENT_STEP = 1
    const flushProgress = (): void => {
      if (latestPercent === lastFlushedPercent) return
      lastFlushAt = Date.now()
      lastFlushedPercent = latestPercent
      taskStore.update(id, { progress: latestPercent })
    }
    const onProgress = (received: number, total: number, percent: number): void => {
      latestPercent = percent
      const now = Date.now()
      if (now - lastEmitAt >= SSE_MIN_INTERVAL_MS || percent - lastEmittedPercent >= SSE_MIN_PERCENT_STEP || percent === 100) {
        lastEmitAt = now
        lastEmittedPercent = percent
        this.emit('task:progress', { id, received, total, percent })
      }
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
        const { result, outcome, attempts } = await this.runOnce(id, input, onProgress)
        this.persistAttempts(id, attempt + 1, attempts) // M2: 记录本轮全部换源/降级尝试（含命中的 ok:true）
        if (this.isCanceled(id)) {
          flushProgress()
          this.cleanupCanceledFile(outcome.filePath)
          return
        }

        // 换源提示先入 warnings，再判定最终状态（换源本身即视为 with_warnings）
        if (result.toggled) outcome.warnings.push(`跨平台换源：${input.platform} → ${result.platform}（原平台取 URL 失败，自动换到同款歌曲）`)
        // C3: 音质降级透明化 — 实际音质低于请求音质时主动 push 结构化 warning
        if (result.qualityDegraded) {
          outcome.warnings.push(`音质降级：请求 ${input.quality} → 实际 ${result.quality}（高音质无可用源，自动降级）`)
        }
        const finalStatus: TaskStatus = outcome.warnings.length ? 'completed_with_warnings' : 'completed'

        // C2: 写入真实音质检测结果到 DB
        const rq = outcome.realQuality
        this.setStatus(id, finalStatus, {
          progress: 100,
          actual_quality: result.quality,
          actual_source: result.toggled ? `${result.sourceId}@${result.platform}` : result.sourceId,
          file_path: outcome.filePath,
          file_size: outcome.fileSize,
          warnings: outcome.warnings.length ? JSON.stringify(outcome.warnings) : null,
          actual_bitrate: rq?.bitrate ?? null,
          actual_codec: rq?.codec ?? null,
          actual_sample_rate: rq?.sampleRate ?? null,
        })
        logger.info({ id, status: finalStatus, file: outcome.filePath, quality: result.quality, source: result.sourceId }, '[queue] done')
        return
      } catch (err) {
        if (this.isCanceled(id)) {
          flushProgress()
          return
        }
        const message = err instanceof Error ? err.message : String(err)
        const error = encodeErrorFrom(err) // M1: download_tasks.error 存 {code,message} JSON
        // M2: 记录本轮尝试轨迹（同轮共享 attempt_no，按 ts/id 升序呈现）。三种来源统一在此落库：
        //   - directAttempts：直连取流阶段失败（M-1/#203，runOnce 挂载，单行 ok:false）；
        //   - attempts：编排层全源失败上抛（多行 ok:false 换源/降级轨迹）；
        //   - 均无：NoSourceError 等（persistAttempts 内部对空/undefined 直接返回，不写行）。
        // directAttempts 优先：直连失败与全源失败互斥（前者 resolve 已命中，后者 resolve 未命中）。
        const auditAttempts =
          (err as { directAttempts?: ResolveAttempt[] }).directAttempts ??
          (err as { attempts?: ResolveAttempt[] }).attempts
        this.persistAttempts(id, attempt + 1, auditAttempts)
        // ── 熔断：确定性不可恢复错误直接 failed，不走退避重试。
        // F1 分级：仅**永久** HTTP 错误（400/401/403/404/410 等）熔断；瞬态错误
        //    （429/500/502/503/504）不熔断，落入下方退避重试（重试可能换源/恢复）。
        // 1) PermanentHttpError：CDN/源站明确返回确定性失效，重试只会反复命中同一故障。
        // 2) NoSourceError（编排层无可用音源）：重试不可能改变音源可用性，直接失败。
        if (isPermanentHttpError(err) || isNoSourceError(err)) {
          flushProgress()
          this.setStatus(id, 'failed', { error })
          logger.error({ id, error: message, kind: isPermanentHttpError(err) ? `http-permanent-${(err as { httpStatus: number }).httpStatus}` : 'no-source' }, '[queue] 确定性错误，不重试直接失败')
          return
        }
        if (attempt >= maxRetries) {
          flushProgress() // 失败时强制落盘最后进度
          this.setStatus(id, 'failed', { error })
          logger.error({ id, error: message, attempts: attempt + 1 }, '[queue] failed')
          return
        }
        const delayMs = baseDelayMs * 2 ** attempt
        attempt++
        logger.warn({ id, attempt, delayMs, error: message }, '[queue] 下载失败，指数退避后重试')
        await sleep(delayMs)
        if (this.isCanceled(id)) {
          flushProgress()
          return
        }
      }
    }
  }

  /**
   * M2: 把一轮编排产生的 ResolveAttempt[] 落 download_attempts（审计「为什么失败/换源」）。
   * attempt_no = 队列重试轮次（从 1 起）；同轮内跨音源/跨音质尝试共享 attempt_no，以 ts/id 升序呈现。
   * error_code 用 M1 classifyError 对 attempt.error 文本归类；命中项（ok:true）error_code 为 null。
   * best-effort：审计写入失败绝不阻断下载主流程。
   */
  private persistAttempts(id: string, attemptNo: number, attempts: ResolveAttempt[] | undefined): void {
    if (!attempts || attempts.length === 0) return
    const now = Date.now()
    const rows: DownloadAttemptRow[] = attempts.map((a) => ({
      task_id: id,
      attempt_no: attemptNo,
      source_id: a.sourceId ?? '',
      platform: a.platform ?? '',
      quality: a.quality ?? '',
      error_code: a.ok ? null : classifyError(a.error ?? ''),
      ts: now,
    }))
    try {
      taskStore.insertAttempts(rows)
    } catch (err) {
      logger.debug({ id, err: (err as Error).message }, '[queue] attempts 审计写入失败（忽略）')
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
      // 刮削字段一并重置（重新下载会产生新文件，旧刮削结果失效，完成后重新自动刮）。
      // N4: 刻意**不**重置 actual_source / actual_quality / file_path —— 保留上一轮真实命中
      //     审计，直到本轮 run() 成功回写覆盖；失败重试不会抹掉「曾经用哪个源下成功过」的证据。
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

  /**
   * H4: 任务列表（分页 + 过滤）。移除写死 200：默认 limit 50，上限 500（防内存炸裂）。
   * status / batchId 均可选；offset 默认 0。
   */
  list(opts: { status?: TaskStatus; batchId?: string; limit?: number; offset?: number } = {}) {
    const limit = clamp(Math.floor(opts.limit ?? 50), 1, 500)
    const offset = Math.max(0, Math.floor(opts.offset ?? 0))
    return taskStore.list({ status: opts.status, batchId: opts.batchId, limit, offset }).map(toTaskView)
  }

  /** H4/H3: 按状态精确计数（不受 list 分页上限影响，供 /status 面板） */
  counts(): { pending: number; active: number; completed: number; failed: number; canceled: number } {
    return {
      pending: taskStore.count('pending'),
      active: taskStore.count('active'),
      completed: taskStore.count('completed') + taskStore.count('completed_with_warnings'),
      failed: taskStore.count('failed'),
      canceled: taskStore.count('canceled'),
    }
  }

  /** #196-fix2: 轻量 owned 端点——全部终态任务（无分页），仅含 owned 判定所需字段 */
  listOwned() {
    return taskStore.listOwned().map((r) => ({
      key: `${r.platform}:${r.songmid}`,
      taskId: r.id,
      status: r.status,
      quality: r.requested_quality,
      hasFile: !!(r.file_path && r.file_path !== ''),
    }))
  }

  /** M2: 某任务的下载尝试审计轨迹（GET /api/v1/tasks/:id/attempts 数据源） */
  listAttempts(id: string) {
    return taskStore.listAttempts(id)
  }

  /** H1: 批次汇总列表 */
  listBatches() {
    return taskStore.listBatches()
  }

  /** H1: 整批取消（仅 pending/active），返回实际取消数 */
  cancelBatch(batchId: string): number {
    const n = taskStore.cancelBatch(batchId)
    // 同步清理激活缓冲中属于本批的未激活任务（避免已取消任务又被激活）
    if (n > 0) {
      const canceledIds = new Set(taskStore.list({ batchId, status: 'canceled', limit: 1_000_000 }).map((r) => r.id))
      this.activationBuffer = this.activationBuffer.filter((id) => !canceledIds.has(id))
    }
    return n
  }

  // ── H3: 用户级暂停/恢复（与 RSS 护栏 memPaused 独立；两者任一为真则 p-queue 暂停）──

  /** H3: 用户暂停出队（不影响已在途任务，仅停止调度新任务） */
  pause(): void {
    if (this.userPaused) return
    this.userPaused = true
    this.queue.pause()
    logger.info('[queue] 用户暂停出队')
  }

  /** H3: 用户恢复出队（仅当 RSS 护栏也未暂停时才真正恢复） */
  resume(): void {
    if (!this.userPaused) return
    this.userPaused = false
    if (!this.memPaused) this.queue.start()
    logger.info({ memPaused: this.memPaused }, '[queue] 用户恢复出队')
  }

  /** H3: 是否处于用户暂停态 */
  isPaused(): boolean {
    return this.userPaused
  }

  /** H3: 队列运行态快照（GET /api/v1/queue/status 数据源） */
  queueStatus() {
    return {
      paused: this.userPaused,
      memPaused: this.memPaused,
      concurrency: this.queue.concurrency,
      scheduled: this.scheduled,
      activationBuffer: this.activationBuffer.length,
      running: this.queue.pending,
      ...this.counts(),
    }
  }

  /** H3: 激活缓冲长度（GET /api/v1/status 的 activationBuffer 字段数据源） */
  bufferedCount(): number {
    return this.activationBuffer.length
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
