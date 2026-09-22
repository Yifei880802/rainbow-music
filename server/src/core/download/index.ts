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
import * as musicMetadata from 'music-metadata'
import { config } from '../config.js'
import { logger } from '../logger.js'
import { taskStore } from '../db/index.js'
import type { MusicInfo } from '../adapters/common.js'
import type { Quality } from '../source-engine/lx-env.js'
import type { TagJobMessage, TagResultMessage } from './tag-worker.js'

export interface DownloadMeta {
  name: string
  singer: string
  album?: string
  coverUrl?: string | null
  lyric?: string | null
  // ── G2 命名占位符扩展字段（全部可选；缺失时占位符渲染为空串）──
  quality?: string       // {quality}：请求音质（flac24bit/flac/320k/128k）
  platform?: string      // {platform}：触发来源平台
  songmid?: string       // {songmid}：平台歌曲 id
  year?: string          // {year}：发行年份（刮削前通常未知 → 空串）
  trackNumber?: string   // {trackNumber}：曲目号（同上）
  albumArtist?: string   // {albumArtist}：专辑艺术家（同上）
}

export interface DownloadProgress {
  (received: number, total: number, percent: number): void
}

export interface DownloadOutcome {
  filePath: string
  fileSize: number
  format: 'mp3' | 'flac' | 'unknown'
  warnings: string[]
  /** C1: music-metadata 读取的真实音质信息 */
  realQuality?: {
    bitrate: number | null    // bps
    codec: string | null      // e.g. 'FLAC', 'MPEG'
    sampleRate: number | null // Hz
    bitsPerSample: number | null
  }
}

/**
 * 受控 HTTP 状态码错误：CDN/源站返回非 2xx。
 * 携带 httpStatus 标记，队列侧据此做熔断/重试判定。
 *
 * F1 错误分级：按状态码拆为两个子类（name 属性区分，鸭子类型判定跨模块安全）：
 *  - TransientHttpError（429/500/502/503/504）：瞬态故障，退避重试或换源可能恢复；
 *  - PermanentHttpError（400/401/403/404/410 及其他非瞬态码）：URL 确定性失效，
 *    重试只会反复命中同一故障，队列侧直接熔断不重试。
 */
export class HttpStatusError extends Error {
  readonly httpStatus: number
  constructor(status: number) {
    super(`HTTP ${status}`)
    this.name = 'HttpStatusError'
    this.httpStatus = status
  }
}

/** F1: 瞬态 HTTP 错误（限流/源站临时故障）——可退避重试或换源 */
export class TransientHttpError extends HttpStatusError {
  constructor(status: number) {
    super(status)
    this.name = 'TransientHttpError'
  }
}

/** F1: 永久 HTTP 错误（URL 确定性失效）——队列侧熔断不重试 */
export class PermanentHttpError extends HttpStatusError {
  constructor(status: number) {
    super(status)
    this.name = 'PermanentHttpError'
  }
}

/** F1: 瞬态状态码集合（429 限流 + 5xx 源站临时故障）；其余非 2xx 一律归永久 */
const TRANSIENT_HTTP_CODES = new Set([429, 500, 502, 503, 504])

/** F1: 按状态码构造对应分级的受控错误 */
export function makeHttpError(status: number): HttpStatusError {
  return TRANSIENT_HTTP_CODES.has(status) ? new TransientHttpError(status) : new PermanentHttpError(status)
}

/** 鸭子类型判定：是否为受控 HTTP 状态码错误（不依赖 instanceof，跨模块安全）。
 * name 校验放宽到三个分级名（F1 拆分后 Transient/Permanent 是实际抛出的具体类），
 * 叠加 httpStatus 数字字段校验收窄误判：仅有 httpStatus 的第三方错误不会被误识别。 */
const HTTP_ERROR_NAMES = new Set(['HttpStatusError', 'TransientHttpError', 'PermanentHttpError'])
export function isHttpStatusError(err: unknown): err is HttpStatusError {
  return (
    typeof err === 'object' &&
    err !== null &&
    HTTP_ERROR_NAMES.has((err as Error).name) &&
    typeof (err as { httpStatus?: unknown }).httpStatus === 'number'
  )
}

/** F1: 是否瞬态 HTTP 错误（双保险：name 或 httpStatus 数值命中瞬态集合） */
export function isTransientHttpError(err: unknown): boolean {
  if (!isHttpStatusError(err)) return false
  return err.name === 'TransientHttpError' || TRANSIENT_HTTP_CODES.has(err.httpStatus)
}

/** F1: 是否永久 HTTP 错误（仅受控错误且非瞬态；队列熔断判定专用） */
export function isPermanentHttpError(err: unknown): boolean {
  return isHttpStatusError(err) && !isTransientHttpError(err)
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

/** 歌手首字母（G1 {singerFirstLetter}）：ASCII 字母取大写；中文尝试 Intl 拼音排序近似；其余归 'Other' */
function firstLetterOf(singer: string): string {
  const s = singer.trim()
  if (!s) return 'Other'
  const ascii = s.match(/[A-Za-z]/)
  if (ascii) return ascii[0]!.toUpperCase()
  try {
    // zh-Hans-CN-u-co-pinyin：按拼音排序的 collator，反查首字母落在哪个区间
    const coll = new Intl.Collator('zh-Hans-CN-u-co-pinyin', { sensitivity: 'base' })
    for (let c = 65; c <= 90; c++) {
      const next = String.fromCharCode(c + 1)
      if (coll.compare(s, String.fromCharCode(c)) >= 0 && (c === 90 || coll.compare(s, next) < 0)) {
        return String.fromCharCode(c)
      }
    }
  } catch {
    /* Intl 拼音 collation 不可用（老 ICU）→ 归 Other */
  }
  return 'Other'
}

/**
 * G2: 模板占位符渲染（文件名与目录模板共用）。
 * 支持：{name} {singer} {album} {quality} {ext} {songmid} {platform} {year} {trackNumber} {albumArtist} {singerFirstLetter}
 * ext 由调用方传入（扩展名在拿到 content-type 后才能确定）；缺失字段渲染为空串。
 */
export function renderTemplate(template: string, meta: DownloadMeta, ext = ''): string {
  const map: Record<string, string> = {
    name: meta.name,
    singer: meta.singer,
    album: meta.album ?? '',
    quality: meta.quality ?? '',
    ext,
    songmid: meta.songmid ?? '',
    platform: meta.platform ?? '',
    year: meta.year ?? '',
    trackNumber: meta.trackNumber ?? '',
    albumArtist: meta.albumArtist ?? '',
    singerFirstLetter: firstLetterOf(meta.singer),
  }
  return template.replace(/\{(\w+)\}/g, (m, key: string) => (key in map ? map[key]! : m))
}

function renderName(template: string, meta: DownloadMeta, ext = ''): string {
  return sanitizeFilename(renderTemplate(template, meta, ext))
}

/**
 * G1: 按 download.dirTemplate 计算落盘子目录（未配置/空串 → 平铺返回 baseDir，行为与旧版完全一致）。
 * 模板按 '/' 拆段逐段渲染 + 清洗（sanitizeFilename 会剔除路径分隔符与非法字符），
 * 渲染后为空的段丢弃；额外拦截 '.'/'..' 段防目录穿越（模板可经设置页 PATCH 写入）。
 * 只计算不建目录；调用方拼接 finalPath 前 fs.mkdirSync(recursive)。
 */
export function buildTargetDir(baseDir: string, meta: DownloadMeta): string {
  const tpl = config.download.dirTemplate ?? ''
  if (!tpl.trim()) return baseDir
  const segs = tpl
    .split(/[\\/]/)
    .map((s) => sanitizeFilename(renderTemplate(s.trim(), meta)))
    .filter((s) => s.length > 0 && s !== '.' && s !== '..')
  if (!segs.length) return baseDir
  return path.join(baseDir, ...segs)
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

export interface StreamDownloadResult {
  contentType?: string
  /** 本次响应体实际接收的字节数（续传时不含 baseOffset 部分） */
  received: number
  /** 本次响应的 content-length（206 时为剩余字节数） */
  total: number
  /** 最终落盘字节数（baseOffset + received；完整性校验的权威依据） */
  written: number
  /** 完整文件预期字节数（200 为 content-length；206 从 Content-Range 解析全量），供完整性校验 */
  expectedSize: number
  /** F2: 是否从已有断点续传（206 append） */
  resumed: boolean
}

/** F2: 断点续传选项（dest 即持久化临时文件 .tmp-{taskId}） */
export interface StreamDownloadOptions {
  /** 启用断点续传：dest 已存在时带 Range: bytes=N- 重发（206 append / 200 truncate） */
  resume?: boolean
}

/** F2: 断点旁挂元数据（.tmp-{id}.meta）：记录首轮的 ETag/Last-Modified，续传时校验防内容变更 */
interface ResumeSidecar { etag?: string | null; lastModified?: string | null }

function readResumeSidecar(dest: string): ResumeSidecar {
  try {
    return JSON.parse(fs.readFileSync(`${dest}.meta`, 'utf8')) as ResumeSidecar
  } catch {
    return {}
  }
}

function writeResumeSidecar(dest: string, headers: Record<string, string>): void {
  try {
    const data: ResumeSidecar = { etag: headers['etag'] ?? null, lastModified: headers['last-modified'] ?? null }
    fs.writeFileSync(`${dest}.meta`, JSON.stringify(data), 'utf8')
  } catch (err) {
    logger.warn({ err: (err as Error).message }, '[download] 断点元数据写入失败（忽略，仅影响续传校验精度）')
  }
}

async function removeResumeSidecar(dest: string): Promise<void> {
  await fs.promises.rm(`${dest}.meta`, { force: true }).catch(() => {})
}

/** 单次请求：等到终态 header（或受控失败），不建立写管道 */
function requestHeaders(url: string, headersOut?: Record<string, string>): Promise<{ statusCode: number; headers: Record<string, string>; req: NodeJS.ReadableStream }> {
  const req = needle.get(url, {
    response_timeout: 30_000,
    read_timeout: 60_000,
    follow_max: 5,
    ...(headersOut ? { headers: headersOut } : {}),
  })
  return new Promise((resolve, reject) => {
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
        // F1: makeHttpError 按状态码分级（429/5xx → Transient，其余 → Permanent）
        settle(() => {
          req.resume()
          reject(makeHttpError(statusCode))
        })
        return
      }
      settle(() => resolve({ statusCode, headers: hdrs, req }))
    })
    // needle@3.x 流模式的真正错误通道：done 携带 err（DNS/拒绝连接/重定向超限等）
    req.on('done', (err?: Error) => {
      if (err) fail(err)
    })
    // 'error' 保留作防御（needle 流模式几乎不发，但第三方补丁/未来版本不保证）
    req.once('error', (err: Error) => fail(err))
  })
}

/**
 * F2 断点续传语义（opts.resume 且 dest 已存在时）：
 *  1. fs.stat 取已下载字节数 N，带 `Range: bytes=N-` + `If-Range: <etag|last-modified>` 重发；
 *  2. 206 → 以 append 模式续写；响应 etag/last-modified 与旁挂元数据不一致 → 内容已变更，
 *     丢弃断点从头重下（内部自动重发一次不带 Range 的请求）；
 *  3. 200（服务端不支持 Range 或 If-Range 失配回退全量）→ truncate 重写；
 *  4. 首轮响应的 etag/last-modified 写旁挂 `.meta` 文件（重启后续传仍可校验）；
 *  5. 中途失败时保留 dest 与 .meta（供下次续传）；成功后由调用方 rename 并清理 .meta。
 * opts.resume 未启用时行为与旧版完全一致（truncate 全量写）。
 */
export async function streamDownload(url: string, dest: string, onProgress?: DownloadProgress, opts?: StreamDownloadOptions): Promise<StreamDownloadResult> {
  const resumeEnabled = opts?.resume === true
  let baseOffset = 0
  if (resumeEnabled) {
    try {
      const st = await fs.promises.stat(dest)
      if (st.isFile() && st.size > 0) baseOffset = st.size
    } catch {
      /* 无断点文件：全新下载 */
    }
  }

  for (let pass = 0; ; pass++) {
    const rangeHeaders: Record<string, string> | undefined =
      baseOffset > 0
        ? {
            Range: `bytes=${baseOffset}-`,
            // If-Range：内容变更时服务端直接回 200 全量（而非 206 拼接出损坏文件）
            ...(readResumeSidecar(dest).etag || readResumeSidecar(dest).lastModified
              ? { 'If-Range': String(readResumeSidecar(dest).etag || readResumeSidecar(dest).lastModified) }
              : {}),
          }
        : undefined

    const { statusCode, headers, req } = await requestHeaders(url, rangeHeaders)

    if (statusCode === 206 && baseOffset > 0) {
      // F2: 显式校验 ETag/Last-Modified 与首轮旁挂值一致（If-Range 之外的双保险：
      // 部分 CDN 忽略 If-Range 仍回 206，内容已变时拼接会产生损坏文件）
      const sidecar = readResumeSidecar(dest)
      const etag = headers['etag'] ?? null
      const lm = headers['last-modified'] ?? null
      const changed = (sidecar.etag && etag && sidecar.etag !== etag) || (sidecar.lastModified && lm && sidecar.lastModified !== lm)
      if (changed) {
        req.resume()
        logger.warn({ url, baseOffset }, '[download] 断点续传：ETag/Last-Modified 失配（内容已变更），丢弃断点从头重下')
        await fs.promises.rm(dest, { force: true })
        await removeResumeSidecar(dest)
        baseOffset = 0
        if (pass >= 1) throw new Error('断点续传重下循环超限（内容反复变更）')
        continue // 重发不带 Range 的请求
      }
    }

    // 200（含 Range 被忽略/If-Range 失配回退）→ truncate 重写；206 → append 续写
    const append = statusCode === 206 && baseOffset > 0
    if (!append) baseOffset = 0

    const total = parseInt(headers['content-length'] ?? '0') || 0
    const contentType = headers['content-type']
    // 完整文件预期大小：206 从 Content-Range（bytes N-M/FULL）取权威全量，解析失败回退 baseOffset+total；200 即 content-length
    let expectedSize = total
    if (append) {
      const cr = headers['content-range']
      const m = cr?.match(/\/(\d+)\s*$/)
      expectedSize = m ? parseInt(m[1]!) : baseOffset + total
    }
    // 首轮（非续传）时落旁挂元数据，供失败/重启后的续传校验
    if (!append) writeResumeSidecar(dest, headers)

    let received = 0
    const response: NodeJS.ReadableStream = req
    // B2: 始终跟踪已接收字节数（完整性校验依赖），无论是否提供 onProgress
    response.on('data', (chunk: Buffer) => {
      received += chunk.length
      if (onProgress) {
        const done = baseOffset + received
        const full = expectedSize || (baseOffset + total)
        onProgress(done, full, full ? Math.floor((done / full) * 100) : 0)
      }
    })

    // pipeline 自动双向销毁：源流或写流任一侧出错都会 reject 并清理另一侧，无悬挂流。
    // 中途失败时 dest 保留已写入部分（resume 场景下次续传；非 resume 场景由调用方清理）
    await pipeline(response as never, fs.createWriteStream(dest, append ? { flags: 'a' } : { flags: 'w' }))
    return { contentType, received, total, written: baseOffset + received, expectedSize, resumed: append }
  }
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
 * 背景：流式下载先落临时文件再 rename 为最终文件名，进程崩溃/被 kill
 * 时 rename 未及执行便会遗留无法自愈的残留。启动时扫描删除。
 *
 * F2 续传协同：resume 开启时临时名为 `.tmp-{taskId}`（另有旁挂 `.tmp-{taskId}.meta`），
 * 可续传的任务（DB 中状态 pending/active）的断点文件必须**保留**，否则重启后
 * 无法 Range 续传；仅清理不可续传（已完成/失败/取消或旧版随机名）的残留。
 * 命名规则与进行中的临时文件完全无关：只匹配 .tmp- 前缀，不碰 .cover-*.tmp
 * 封面临存与其他任何文件；单文件删除失败仅告警不中断，目录不存在静默忽略。
 */
export async function cleanupTmpResidue(): Promise<void> {
  const dir = config.download.dir
  let entries: fs.Dirent[]
  try {
    entries = await fs.promises.readdir(dir, { withFileTypes: true })
  } catch {
    return // 目录不存在（首启未下载过）或不可读：无需清理
  }
  // F2: resume 开启时，保留可续传任务（pending/active）的 .tmp-{id} 与 .tmp-{id}.meta
  const preserve = new Set<string>()
  if (config.download.resume !== false) {
    try {
      for (const st of ['pending', 'active'] as const) {
        for (const r of taskStore.list({ status: st, limit: 1_000_000 })) preserve.add(r.id)
      }
    } catch (err) {
      logger.warn({ err: (err as Error).message }, '[download] 续传保留集查询失败（保守全量清理）')
    }
  }
  let removed = 0
  for (const e of entries) {
    if (!e.isFile() || !e.name.startsWith('.tmp-')) continue
    // 解析 .tmp-{id} 或 .tmp-{id}.meta，提取 taskId 判定是否保留
    const isMeta = e.name.endsWith('.meta')
    const idPart = isMeta ? e.name.slice('.tmp-'.length, -'.meta'.length) : e.name.slice('.tmp-'.length)
    if (preserve.has(idPart)) continue
    try {
      await fs.promises.rm(path.join(dir, e.name), { force: true })
      removed++
    } catch (err) {
      logger.warn({ file: e.name, err: (err as Error).message }, '[download] 临时残留文件清理失败（忽略）')
    }
  }
  if (removed > 0) logger.info({ removed, preserved: preserve.size }, '[download] 清理临时文件')
}

// ───────────────────────────────────────────────────────────────────────────

/**
 * B1: 同名文件冲突解决。
 * - suffix: 循环追加 (1)(2)(3)… 直到找到不存在的文件名
 * - overwrite: 直接覆盖（旧行为）
 * - skip: 跳过下载，返回 null
 */
export function resolveConflictPath(finalPath: string): string | null {
  const strategy = config.download.onConflict ?? 'suffix'
  if (strategy === 'overwrite') return finalPath
  if (!fs.existsSync(finalPath)) return finalPath
  if (strategy === 'skip') return null
  // suffix 策略：拆分文件名与扩展名，循环追加 (N)
  const ext = path.extname(finalPath)
  const base = finalPath.slice(0, finalPath.length - ext.length)
  for (let i = 1; i < 10000; i++) {
    const candidate = `${base} (${i})${ext}`
    if (!fs.existsSync(candidate)) return candidate
  }
  // 极端情况：9999 个同名文件都存在，用时间戳后缀兑底
  return `${base} (${Date.now()})${ext}`
}

/**
 * C1: 下载完成后用 music-metadata parseFile 读取真实码率/格式/采样率。
 * detectRealQuality=false 时跳过。失败降级为 warning，不影响下载成功状态。
 */
async function detectRealQuality(filePath: string): Promise<DownloadOutcome['realQuality']> {
  if (config.download.detectRealQuality === false) return undefined
  try {
    const mm = await musicMetadata.parseFile(filePath, { duration: false })
    return {
      bitrate: mm.format.bitrate ?? null,
      codec: mm.format.codec ?? mm.format.container ?? null,
      sampleRate: mm.format.sampleRate ?? null,
      bitsPerSample: mm.format.bitsPerSample ?? null,
    }
  } catch (err) {
    logger.warn({ err: (err as Error).message, filePath }, '[download] music-metadata parseFile failed (non-fatal)')
    return undefined
  }
}

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
    taskId?: string,
  ): Promise<DownloadOutcome> {
    const warnings: string[] = []
    const dir = config.download.dir
    fs.mkdirSync(dir, { recursive: true })
    const resumeEnabled = config.download.resume !== false && !!taskId

    // G2: 命名元数据补齐占位符字段（year/trackNumber/albumArtist 由下载后刮削产生，命名时未知 → 空串）
    const renderMeta: DownloadMeta = {
      ...meta,
      quality: _quality,
      platform: musicInfo.source,
      songmid: String(musicInfo.songmid),
    }

    // F2: 持久化临时名 .tmp-{taskId}（供失败/重启后 Range 续传）；无 taskId 时回退随机名（旧行为）
    const tmpPath = path.join(dir, taskId ? `.tmp-${taskId}` : `.tmp-${Date.now()}-${Math.random().toString(36).slice(2)}`)

    // N1: 封面下载与音频下载并行——音频流式下载耗时长，封面原图拉取同时起跑，
    // 总耗时取 max(音频, 封面) 而非两者之和。fetchRawCoverToTemp 内部已 try/catch 返回 null，
    // 故 coverPromise 绝不 reject（无 unhandled rejection 风险）；音频失败/skip 时清理其临时文件。
    const coverPromise: Promise<string | null> =
      config.download.embedCover && meta.coverUrl ? fetchRawCoverToTemp(meta.coverUrl, dir) : Promise.resolve(null)
    // 音频未成功时回收已下载的封面临时文件（best-effort，不阻断主流程）
    const discardCover = async (): Promise<void> => {
      const cp = await coverPromise.catch(() => null)
      if (cp) await fs.promises.rm(cp, { force: true }).catch(() => {})
    }

    let contentType: string | undefined
    let written = 0
    let expectedSize = 0
    try {
      const r = await streamDownload(url, tmpPath, onProgress, { resume: resumeEnabled })
      contentType = r.contentType
      written = r.written
      expectedSize = r.expectedSize
    } catch (err) {
      // F2: 续传开启时保留断点文件与旁挂元数据（下次重试/重启从此续传）；否则清理
      if (!resumeEnabled) {
        await fs.promises.rm(tmpPath, { force: true })
        await removeResumeSidecar(tmpPath)
      }
      await discardCover() // N1: 音频失败，回收并行下载的封面临时文件
      const wrapped = new Error(`下载失败: ${(err as Error).message}`)
      // 保留受控 HTTP 状态码标记 + 分级 name，供队列侧熔断/重试判定（F1）
      if (isHttpStatusError(err)) {
        wrapped.name = err.name
        ;(wrapped as Error & { httpStatus?: number }).httpStatus = err.httpStatus
      }
      throw wrapped
    }

    // B2: 下载完整性校验 — 最终落盘字节数 vs 完整预期大小（206 续传时 expectedSize 已从 Content-Range 取全量）
    if (config.download.verifyIntegrity !== false && expectedSize > 0 && written !== expectedSize) {
      warnings.push(`文件可能不完整（received ${written} / total ${expectedSize}）`)
      logger.warn({ written, expectedSize, url }, '[download] integrity check failed: size mismatch')
    }

    const { ext, format } = guessFormat(url, contentType)
    // G2: 模板显式含 {ext} 占位符时以渲染结果为准（不重复追加扩展名）；否则沿用「基名 + .ext」
    const templateHasExt = /\{ext\}/.test(config.download.nameTemplate)
    const baseName = renderName(config.download.nameTemplate, renderMeta, ext) || `${meta.name} - ${meta.singer}`
    const fileName = templateHasExt ? baseName : `${baseName}.${ext}`

    // G1: 先算落盘子目录（dirTemplate）并创建，再算冲突后缀（与 B1 resolveConflictPath 协同）
    const targetDir = buildTargetDir(dir, renderMeta)
    fs.mkdirSync(targetDir, { recursive: true })
    const naivePath = path.join(targetDir, fileName)

    // B1: 同名文件冲突保护
    const finalPath = resolveConflictPath(naivePath)
    if (finalPath === null) {
      // skip 策略：文件已存在且配置为跳过
      await fs.promises.rm(tmpPath, { force: true })
      await removeResumeSidecar(tmpPath)
      await discardCover() // N1: 不落盘，回收并行下载的封面临时文件
      warnings.push(`文件已存在，已跳过（onConflict=skip）`)
      const stat = await fs.promises.stat(naivePath)
      return { filePath: naivePath, fileSize: stat.size, format, warnings }
    }
    await fs.promises.rename(tmpPath, finalPath)
    await removeResumeSidecar(tmpPath) // F2: 成功后清理旁挂元数据

    // 封面：N1 已与音频并行下载，此处只 await 结果（resize 交给 worker）
    // 要求嵌封面但音源未提供封面 URL 时显式记 warning（不改终态，仅可观测）
    let coverPath: string | null = null
    if (config.download.embedCover) {
      if (meta.coverUrl) {
        coverPath = await coverPromise
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

    // C1: 下载完成后读取真实音质信息（music-metadata parseFile）
    const realQuality = await detectRealQuality(finalPath)

    return { filePath: finalPath, fileSize: stat.size, format, warnings, realQuality }
  },
}
