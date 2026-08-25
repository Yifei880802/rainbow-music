/**
 * #45 自动刮削服务（Auto-Scraping / Auto-Tagging）
 *
 * 职责（设计文档 §4.5）：
 *   1. 事件接线  wire(downloadQueue) —— 订阅 task:completed / task:completed_with_warnings，
 *      下载完成后 fire-and-forget 入刮削队列（模式 A，autoOnComplete 控制）
 *   2. 队列调度  独立 PQueue（默认并发 1 + 任务间 ≥300ms 节流；与下载 p-queue 完全隔离）
 *   3. 元数据解析 resolveMetadata —— 候选平台直查（actual_source 平台优先 → 入队平台），
 *      防串号校验（name/singer 归一化比对）；直查失败走 findMusic 跨平台模糊匹配兜底
 *   4. 标签写回  复用 TagWorkerPool（runTagJob + scrape 模式 read-merge-write 只补缺）
 *   5. 状态持久化 taskStore.update(id, { scrape_status, scrape_info })
 *   6. 事件广播  emitEvent('scrape:update' / 'scrape:progress') 上事件总线（SSE 推给前端）
 *
 * 状态机（§4.3）：pending → running → success / failed（限次 2 次自动重试，5s/15s 退避）
 *                                        └→ skipped（确定性不刮：查无结果/平台不符/文件缺失/未知格式）
 * 红线：任何失败只写 scrape_status/scrape_info，绝不触碰任务 status / warnings（part-fail 语义延伸）。
 */
import fs from 'node:fs'
import path from 'node:path'
import PQueue from 'p-queue'
import { config } from './config.js'
import { logger } from './logger.js'
import { taskStore, type DownloadTaskRow, type ScrapeStatus } from './db/index.js'
import { emitEvent } from './events.js'
import { fetchScrapeDetail, fetchMbAlbumArtist, type ScrapeDetailResult } from './adapters/scrape-detail.js'
import { findMusic } from './adapters/match.js'
import { isPlatform, type Platform } from './search/index.js'
import { runTagJob } from './download/index.js'
import type { EnqueueInput } from './download/queue.js'
import type { MusicInfo } from './adapters/common.js'

/** config.scrape 解析后的运行态（yaml 未提供时取默认值，对齐 #6 可选字段范式） */
export function scrapeConfig() {
  return {
    enabled: config.scrape?.enabled !== false,
    autoOnComplete: config.scrape?.autoOnComplete !== false,
    concurrency: Math.min(4, Math.max(1, Math.floor(config.scrape?.concurrency ?? 1))),
    timeoutMs: config.scrape?.timeoutMs ?? 8000,
    retryMax: config.scrape?.retryMax ?? 2,
    overwrite: config.scrape?.overwrite === true,
    mbFallback: config.scrape?.mbFallback !== false, // #47 MB L2 兜底 albumArtist，默认开
  }
}

interface ScrapeInfo {
  attempts: number
  error?: string | null
  warnings?: string[]
  matched?: { platform: string; songmid: string } | null
  fieldsWritten?: string[]
  source?: string
  degraded?: boolean
  /** #47 MB 兜底结果：attempted=已尝试(失败/超时) hit=高置信命中 miss=未命中 */
  mbFallback?: 'attempted' | 'hit' | 'miss'
  scrapedAt?: number
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

/** 歌名/歌手归一化（对齐 match.ts filterStr）后比对：相等或互相包含即视为同一首（防串号） */
function normStr(s: unknown): string {
  return String(s ?? '')
    .replace(/\s|'|\.|,|，|&|"|、|\(|\)|（|）|`|~|-|<|>|\||\/|\]|\[|!|！/g, '')
    .toLowerCase()
}

class ScrapeService {
  /** 刮削独立小队列：并发默认 1；interval 300ms 保证任务间 ≥300ms（批量风控缓冲，§5 风险 5） */
  private queue = new PQueue({ concurrency: scrapeConfig().concurrency, interval: 300, intervalCap: 1 })
  /** 在途去重（内存态；DB running 持久化为重启恢复用） */
  private inFlight = new Set<string>()
  private wired = false
  /** 批量模式进度（模式 B）：一轮批量里的 done/total */
  private batch: { total: number; done: number } | null = null
  private activeTaskId: string | null = null

  /**
   * 启动接线（index.ts 装配段调用，与 wireEvents() 相邻）。
   * 只读订阅下载队列的完成事件，绝无反向写；关掉 autoOnComplete/enabled 时不登记。
   */
  wire(downloadQueue: { on(event: string, listener: (task: { id: string }) => void): unknown }): void {
    if (this.wired) return
    this.wired = true
    downloadQueue.on('task:completed', (t) => this.onDownloadComplete(t))
    downloadQueue.on('task:completed_with_warnings', (t) => this.onDownloadComplete(t))
  }

  private onDownloadComplete(task: { id: string }): void {
    const cfg = scrapeConfig()
    if (!cfg.enabled || !cfg.autoOnComplete) return
    // fire-and-forget：登记即返回，绝不阻塞下载管线
    void this.enqueue(task.id, { reason: 'auto' }).catch(() => {})
  }

  /** 进程重启恢复：在途 running 归 failed（可被「一键刮削」或手动触发重试，对齐 §4.1） */
  init(): void {
    const rows = taskStore.list({ limit: 1000 }) // 全量对账口径（better-sqlite3 同步快照）
    let recovered = 0
    for (const row of rows) {
      if (row.scrape_status === 'running') {
        this.persist(row.id, 'failed', (info) => ({ ...info, error: info.error ?? '服务重启中断，待重试' }))
        recovered++
      }
    }
    if (recovered > 0) logger.warn({ recovered }, '[scrape] interrupted running task(s) reset to failed')
    if (scrapeConfig().enabled) logger.info({ concurrency: scrapeConfig().concurrency }, '[scrape] ready')
  }

  /**
   * 单任务入刮削队列（幂等）。
   * 校验失败返回 { ok:false, code, error }（路由层据此回 404/409）；成功返回 202 语义。
   */
  async enqueue(
    taskId: string,
    opts: { force?: boolean; reason?: 'auto' | 'manual' | 'retry' | 'batch' } = {},
  ): Promise<{ ok: boolean; code?: number; error?: string }> {
    const cfg = scrapeConfig()
    if (!cfg.enabled) return { ok: false, code: 409, error: 'scrape disabled (scrape.enabled=false)' }
    const row = taskStore.get(taskId)
    if (!row) return { ok: false, code: 404, error: 'task not found' }
    if (row.status !== 'completed' && row.status !== 'completed_with_warnings') {
      return { ok: false, code: 409, error: `task not completed (status=${row.status})` }
    }
    if (!row.file_path) return { ok: false, code: 409, error: 'task has no file' }
    // 幂等：已 success 不重刮除非 force（验收 5）
    if (row.scrape_status === 'success' && !opts.force) return { ok: false, code: 409, error: 'already scraped (use ?force=true to re-scrape)' }
    if (this.inFlight.has(taskId)) return { ok: true } // 在途重复：静默去重
    this.inFlight.add(taskId)
    void this.queue
      .add(() => this.runTask(taskId, !!opts.force, opts.reason ?? 'manual'))
      .catch((err) => logger.error({ taskId, err: (err as Error)?.message ?? String(err) }, '[scrape] unexpected error (isolated)'))
      .finally(() => this.inFlight.delete(taskId))
    return { ok: true }
  }

  /** 模式 B：一键刮削全部。返回 {queued, skipped}（skipped=已 success 且未 force） */
  async scrapeAll(force: boolean): Promise<{ queued: number; skipped: number }> {
    const cfg = scrapeConfig()
    if (!cfg.enabled) return { queued: 0, skipped: 0 }
    const rows = taskStore.listScrapable(force)
    let queued = 0
    let skipped = 0
    this.batch = { total: rows.length, done: 0 }
    for (const row of rows) {
      if (this.inFlight.has(row.id)) {
        skipped++
        continue
      }
      const r = await this.enqueue(row.id, { force, reason: 'batch' })
      if (r.ok) queued++
      else if (r.code === 409) skipped++ // 已刮过/在途/无文件
    }
    if (rows.length === 0) {
      this.batch = null
      emitEvent('scrape:progress', { done: 0, total: 0 })
    }
    logger.info({ queued, skipped, force }, '[scrape] scrape-all enqueued')
    return { queued, skipped }
  }

  /** 运行态概览（GET /api/v1/scrape/status） */
  status(): { running: boolean; activeTaskId: string | null; queueSize: number; stats: ReturnType<typeof taskStore.scrapeStats> } {
    return {
      running: this.queue.pending > 0,
      activeTaskId: this.activeTaskId,
      queueSize: this.queue.size,
      stats: taskStore.scrapeStats(),
    }
  }

  /** #47 重置全部刮削状态（scrape_status → pending、scrape_info → NULL），返回受影响行数 */
  resetAll(): number {
    const affected = taskStore.resetScrape()
    logger.info({ affected }, '[scrape] scrape status reset')
    return affected
  }

  // ── 内部：单任务执行 ────────────────────────────────────────────

  private persist(id: string, status: ScrapeStatus, merge: (info: ScrapeInfo) => ScrapeInfo): void {
    const row = taskStore.get(id)
    let info: ScrapeInfo = { attempts: 0 }
    if (row?.scrape_info) {
      try {
        info = JSON.parse(row.scrape_info) as ScrapeInfo
      } catch {
        info = { attempts: 0 }
      }
    }
    taskStore.update(id, { scrape_status: status, scrape_info: JSON.stringify(merge(info)) })
  }

  private emitUpdate(id: string, status: ScrapeStatus, extra: Record<string, unknown> = {}): void {
    emitEvent('scrape:update', { taskId: id, status, ...extra })
  }

  private bumpBatchProgress(): void {
    if (!this.batch) return
    this.batch.done++
    emitEvent('scrape:progress', { done: this.batch.done, total: this.batch.total })
    if (this.batch.done >= this.batch.total) this.batch = null
  }

  private async runTask(taskId: string, force: boolean, reason: string): Promise<void> {
    this.activeTaskId = taskId
    try {
      await this.attemptScrape(taskId, force, reason, 0)
    } finally {
      if (this.activeTaskId === taskId) this.activeTaskId = null
      this.bumpBatchProgress()
    }
  }

  /** 带重试的一次执行：失败（网络/接口异常）按 retryMax 退避重试；skipped 不重试 */
  private async attemptScrape(taskId: string, force: boolean, reason: string, attempt: number): Promise<void> {
    const cfg = scrapeConfig()
    const row = taskStore.get(taskId)
    if (!row) return
    // 运行前重校验（等待期间可能被删除/重下）
    if (row.status !== 'completed' && row.status !== 'completed_with_warnings') return
    if (!row.file_path) return
    if (row.scrape_status === 'success' && !force) return

    // ── skipped 类确定性判定（不重试）──
    if (!fs.existsSync(row.file_path)) {
      this.skip(taskId, `文件不存在或已被删除: ${path.basename(row.file_path)}`)
      return
    }
    const format = row.file_path.toLowerCase().endsWith('.flac') ? 'flac' : row.file_path.toLowerCase().endsWith('.mp3') ? 'mp3' : null
    if (!format) {
      this.skip(taskId, `未知格式（${path.extname(row.file_path) || '无扩展名'}），跳过标签写回`)
      return
    }
    let input: EnqueueInput
    try {
      input = JSON.parse(row.music_info) as EnqueueInput
    } catch {
      this.skip(taskId, 'music_info JSON 损坏，无法解析')
      return
    }
    if (!input?.musicInfo?.songmid) {
      this.skip(taskId, 'music_info 缺少 songmid，无法定位歌曲')
      return
    }

    // ── running ──
    this.persist(taskId, 'running', (info) => ({ ...info, attempts: attempt + 1, error: null, warnings: [] }))
    this.emitUpdate(taskId, 'running', { attempt: attempt + 1 })

    // ── 元数据解析（候选平台直查 + 防串号校验 + findMusic 兜底）──
    let detail: ScrapeDetailResult | null = null
    let resolveError: string | null = null
    try {
      detail = await this.resolveDetail(row, input)
    } catch (err) {
      resolveError = err instanceof Error ? err.message : String(err)
    }

    if (detail) {
      // ── #47 L2 MusicBrainz 兜底 albumArtist（五平台详情均不提供；宁缺勿错，失败/超时静默跳过） ──
      let mbFallback: ScrapeInfo['mbFallback']
      if (cfg.mbFallback && !detail.meta.albumArtist) {
        const mb = await fetchMbAlbumArtist({
          name: row.name || input.musicInfo.name,
          singer: row.singer || input.musicInfo.singer,
          interval: input.musicInfo.interval,
        })
        if (mb.albumArtist) detail.meta.albumArtist = mb.albumArtist
        mbFallback = mb.status
        if (mbFallback === 'hit') logger.info({ taskId, albumArtist: mb.albumArtist }, '[scrape] mb fallback hit')
      }

      // ── 标签写回（worker 内 read-merge-write 只补缺） ──
      const meta = detail.meta
      const res = await runTagJob({
        filePath: row.file_path,
        format,
        meta: {
          name: input.musicInfo.name,
          singer: input.musicInfo.singer,
          album: meta.album ?? input.musicInfo.albumName,
          year: meta.year,
          trackNumber: meta.trackNumber,
          genre: meta.genre,
          albumArtist: meta.albumArtist,
          discNumber: meta.discNumber,
          lyric: null,
        },
        coverPath: null,
        coverSize: config.download.coverSize,
        scrape: true,
      })
      const fieldsWritten = res.fieldsWritten ?? []
      this.persist(taskId, 'success', (info) => ({
        ...info,
        error: null,
        warnings: res.warnings,
        fieldsWritten,
        matched: { platform: row.platform, songmid: String(input.musicInfo.songmid) },
        source: detail!.source,
        degraded: detail!.degraded === true,
        mbFallback,
        scrapedAt: Date.now(),
      }))
      this.emitUpdate(taskId, 'success', { fieldsWritten, warnings: res.warnings, source: detail.source, degraded: detail.degraded === true, mbFallback })
      logger.info({ taskId, fields: fieldsWritten, source: detail.source }, `[scrape] done (${reason})`)
      return
    }

    // ── 失败/无结果分流 ──
    if (resolveError) {
      // 平台接口失败/超时 → failed（限次重试）
      this.persist(taskId, 'failed', (info) => ({ ...info, error: resolveError }))
      this.emitUpdate(taskId, 'failed', { error: resolveError, attempts: attempt + 1 })
      if (attempt < cfg.retryMax) {
        const delayMs = attempt === 0 ? 5000 : 15000 // §4.1 轻量退避 5s/15s
        logger.warn({ taskId, attempt: attempt + 1, delayMs, error: resolveError }, '[scrape] failed, scheduled retry')
        setTimeout(() => {
          if (this.inFlight.has(taskId)) return // 已被手动/批量重新登记
          this.inFlight.add(taskId)
          void this.queue
            .add(() => this.attemptScrape(taskId, force, 'retry', attempt + 1))
            .catch(() => {})
            .finally(() => this.inFlight.delete(taskId))
        }, delayMs).unref?.()
      } else {
        logger.error({ taskId, attempts: attempt + 1, error: resolveError }, '[scrape] failed (no more retry)')
      }
      return
    }
    // 接口正常但查无结果/串号 → skipped（确定性，不自动重试）
    this.skip(taskId, '平台直查与模糊匹配均未定位到歌曲')
  }

  private skip(taskId: string, reason: string): void {
    this.persist(taskId, 'skipped', (info) => ({ ...info, error: reason }))
    this.emitUpdate(taskId, 'skipped', { error: reason })
    logger.info({ taskId, reason }, '[scrape] skipped')
  }

  /**
   * 元数据解析（§4.2 匹配策略）：
   *   1) 候选平台序列直查：actual_source 解析出的实际命中平台优先（换源场景），入队 platform 次之；
   *      songmid 与入队平台语义对应，actual 平台直查结果必须过防串号校验；
   *   2) 直查无果 → findMusic 跨平台模糊匹配（复用 match.ts），候选首位回平台直查补字段。
   * throw = 接口异常（上层 failed）；返回 null = 确定性无结果（上层 skipped）。
   */
  private async resolveDetail(row: DownloadTaskRow, input: EnqueueInput): Promise<ScrapeDetailResult | null> {
    const musicInfo = input.musicInfo as MusicInfo
    const ref = { name: row.name || musicInfo.name, singer: row.singer || musicInfo.singer }
    const actualPlatform = row.actual_source?.includes('@') ? row.actual_source.split('@').pop()! : null
    const candidates: Platform[] = []
    for (const p of [actualPlatform, input.platform]) {
      if (p && isPlatform(p) && !candidates.includes(p)) candidates.push(p)
    }

    let lastError: unknown = null
    for (const platform of candidates) {
      let detail: ScrapeDetailResult | null = null
      try {
        detail = await fetchScrapeDetail(platform, musicInfo)
      } catch (err) {
        lastError = err // 单候选接口失败不立即 failed：换下一候选，全失败才抛
        logger.warn({ platform, songmid: String(musicInfo.songmid), err: (err as Error).message }, '[scrape] detail fetch failed')
        continue
      }
      if (!detail) continue // 该平台查无此歌 → 下一候选
      // 防串号校验：kg 反查按 Audioid 精确匹配可豁免；其余直查结果须与任务歌名/歌手对齐
      const exempt = detail.source.startsWith('kg:')
      if (exempt || this.matchesRef(detail, ref)) return detail
      logger.info({ platform, songmid: String(musicInfo.songmid) }, '[scrape] detail name mismatch, trying next candidate')
    }

    // 第 2 级：跨平台模糊匹配兜底（换源场景 musicInfo 最小化 / 直查平台未覆盖时）
    try {
      const found = await findMusic({
        name: ref.name,
        singer: ref.singer,
        albumName: row.album || musicInfo.albumName,
        interval: musicInfo.interval,
        source: input.platform,
      })
      const best = found[0]
      if (!best) return null
      const detail = await fetchScrapeDetail(best.source, best)
      if (detail && (detail.source.startsWith('kg:') || this.matchesRef(detail, ref))) return detail
      return null
    } catch (err) {
      // findMusic 兜底也失败：若此前有接口异常则上抛（failed 语义），否则视为无结果（skipped）
      if (lastError) throw lastError
      logger.warn({ err: (err as Error).message }, '[scrape] findMusic fallback failed')
      return null
    }
  }

  /** 直查结果与任务基准的防串号校验（name 必须对齐；singer 尽力对齐） */
  private matchesRef(detail: ScrapeDetailResult, ref: { name: string; singer: string }): boolean {
    const m = detail.meta
    // 无 name 可校验时（kw L0 等自源数据）默认可信
    if (!m.name) return true
    const fa = normStr(m.name)
    const fb = normStr(ref.name)
    if (!fa || !fb) return true
    if (fa !== fb && !fa.includes(fb) && !fb.includes(fa)) return false
    if (!m.singer) return true
    const sa = normStr(m.singer)
    const sb = normStr(ref.singer)
    return !sa || !sb || sa === sb || sa.includes(sb) || sb.includes(sa)
  }
}

export const scrapeService = new ScrapeService()

