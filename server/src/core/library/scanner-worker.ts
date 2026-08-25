/**
 * 本地音乐库扫描 worker（模块四，worker_threads worker 端）
 *
 * 仿 tag-worker 范式：主线程只传路径（不传 buffer），worker 内完成全部 IO。
 * 单 worker 双模式（消息驱动，两阶段串行复用同一线程）：
 *
 *   阶段一 walk（目录遍历）：
 *     main → worker: { type:'walk', jobId, roots:[绝对路径] }
 *     worker → main: { type:'root', path }                （每个根开始时，供 currentRoot 进度）
 *                 | { type:'batch', entries:[{path,size,mtimeMs}] }（每 500 条一批）
 *                 | { type:'walkDone', total, dirErrors, capped }
 *     - fs.promises.readdir(dir, {withFileTypes:true}) 递归；目录并发微队列上限 8
 *     - 音频扩展名白名单：mp3/flac/m4a/ogg/opus/wav/aac
 *     - 单目录 ENOENT/EACCES：计入 dirErrors 继续不中断
 *     - 防护：单根最大深度 32（超出层级跳过）、单次扫描总文件上限 200,000（防误指根/扫描风暴，
 *       触顶后 capped=true 停止继续收集并如实上报）
 *     - 符号链接/其他文件类型一律跳过（防目录环与误读设备文件）
 *
 *   阶段二 meta（标签补全，music-metadata v7 parseFile）：
 *     main → worker: { type:'meta', jobId, files:[{id,path}], coversDir }
 *     worker → main: { type:'metaResult', results:[{id,ok,title,artist,album,durationMs,format,hasCover,error}] }
 *     - worker 内并发 4 解析；duration:true 选项计算完整时长（需扫帧）
 *     - 封面：common.picture[0] 直接落 coversDir/{id}.jpg（缓存写失败仅降级 hasCover=false）
 *
 * 任何意外异常都以 { type:'fatal' } 汇报后继续存活（主线程据此 failScan 收尾）。
 */
import { parentPort } from 'node:worker_threads'
import fs from 'node:fs'
import path from 'node:path'
import * as musicMetadata from 'music-metadata'

// ── 主线程 ↔ worker 消息协议（类型双向共享；此处为 worker 端定义）──
export interface WalkEntry {
  /** 音频文件绝对路径（根路径 + 相对路径拼接，由本 worker 完成拼接） */
  path: string
  size: number
  mtimeMs: number
}

export interface MetaFileRef {
  /** library_tracks 行 id（主线程 diff 后回填标签的定位键） */
  id: number
  path: string
}

export interface MetaItemResult {
  id: number
  ok: boolean
  title: string | null
  artist: string | null
  album: string | null
  durationMs: number | null
  format: string | null
  /** 解析到嵌入封面且已成功写入缓存目录 */
  hasCover: boolean
  error?: string
}

export type ScanWorkerInbound =
  | { type: 'walk'; jobId: string; roots: string[] }
  | { type: 'meta'; jobId: string; files: MetaFileRef[]; coversDir: string | null }

export type ScanWorkerOutbound =
  | { type: 'root'; path: string }
  | { type: 'batch'; entries: WalkEntry[] }
  | { type: 'walkDone'; total: number; dirErrors: number; capped: boolean }
  | { type: 'metaResult'; results: MetaItemResult[] }
  | { type: 'fatal'; message: string }

// import 绑定按 const 处理：顶层 throw 后类型收窄对后续别名保留（闭包内不再可空）
if (!parentPort) throw new Error('scanner-worker must be started inside worker_threads')
const port = parentPort

// ── 防护栏与批大小（模块四规格冻结值）──
const AUDIO_EXT = new Set(['.mp3', '.flac', '.m4a', '.ogg', '.opus', '.wav', '.aac'])
const MAX_DEPTH = 32
const MAX_FILES = 200_000
const DIR_CONCURRENCY = 8
const WALK_BATCH_SIZE = 500
const META_CONCURRENCY = 4

// ── walk 阶段共享计数 ──
let totalFiles = 0
let dirErrors = 0
let capped = false
let batch: WalkEntry[] = []

function flushBatch(): void {
  if (batch.length > 0) {
    port.postMessage({ type: 'batch', entries: batch } satisfies ScanWorkerOutbound)
    batch = []
  }
}

/**
 * 目录并发微队列：同时在途的 walkDir ≤ DIR_CONCURRENCY。
 * pendingDirs 在「调度时」即自增（而非进入执行时），保证父目录处理完毕、
 * 子目录还在排队时 idle 判定不会提前触发（无竞态）。
 */
let activeDirs = 0
let pendingDirs = 0
const slotWaiters: Array<() => void> = []
let idleResolve: (() => void) | null = null

async function acquireSlot(): Promise<void> {
  if (activeDirs < DIR_CONCURRENCY) {
    activeDirs++
    return
  }
  await new Promise<void>((resolve) => slotWaiters.push(resolve))
  activeDirs++
}

function releaseSlot(): void {
  activeDirs--
  slotWaiters.shift()?.()
}

function scheduleDir(dir: string, depth: number): void {
  pendingDirs++
  void acquireSlot()
    .then(() => walkDir(dir, depth))
    .catch(() => {
      dirErrors++
    })
    .finally(() => {
      pendingDirs--
      releaseSlot()
      if (pendingDirs === 0 && idleResolve) {
        const r = idleResolve
        idleResolve = null
        r()
      }
    })
}

async function walkDir(dir: string, depth: number): Promise<void> {
  let entries: fs.Dirent[]
  try {
    entries = await fs.promises.readdir(dir, { withFileTypes: true })
  } catch {
    // 单目录失败（ENOENT/EACCES/EPERM…）：计数继续，绝不中断整轮扫描
    dirErrors++
    return
  }
  for (const ent of entries) {
    if (capped) return
    if (ent.isDirectory()) {
      // 深度护栏：超过 MAX_DEPTH 的层级整棵剪枝（防误指根到系统深层目录）
      if (depth + 1 > MAX_DEPTH) continue
      scheduleDir(path.join(dir, ent.name), depth + 1)
    } else if (ent.isFile()) {
      if (!AUDIO_EXT.has(path.extname(ent.name).toLowerCase())) continue // 非音频过滤
      if (totalFiles >= MAX_FILES) {
        capped = true
        return
      }
      const full = path.join(dir, ent.name)
      try {
        const st = await fs.promises.stat(full)
        if (!st.isFile()) continue
        totalFiles++
        batch.push({ path: full, size: st.size, mtimeMs: Math.round(st.mtimeMs) })
        if (batch.length >= WALK_BATCH_SIZE) flushBatch()
      } catch {
        dirErrors++ // stat 失败（文件在枚举后被删/权限）同样计数跳过
      }
    }
    // 符号链接 / socket / FIFO 等其他类型：一律跳过（防目录环与误读）
  }
}

async function runWalk(roots: string[]): Promise<void> {
  try {
    for (const root of roots) {
      if (capped) break
      const abs = path.resolve(root)
      port.postMessage({ type: 'root', path: abs } satisfies ScanWorkerOutbound)
      scheduleDir(abs, 0)
    }
    if (pendingDirs === 0) {
      // 根全都不存在（或瞬间完成）时也要走统一收尾路径
    } else {
      await new Promise<void>((resolve) => {
        idleResolve = resolve
      })
    }
    flushBatch()
    port.postMessage({ type: 'walkDone', total: totalFiles, dirErrors, capped } satisfies ScanWorkerOutbound)
  } catch (err) {
    port.postMessage({ type: 'fatal', message: `walk failed: ${(err as Error).message}` } satisfies ScanWorkerOutbound)
  }
}

// ── meta 阶段：music-metadata 解析标签 + 封面落缓存 ──
async function parseOne(f: MetaFileRef, coversDir: string | null): Promise<MetaItemResult> {
  try {
    // duration:true 才会遍历帧计算完整时长（默认只读 header/tags 拿不到可靠 duration）
    const mm = await musicMetadata.parseFile(f.path, { duration: true })
    const common = mm.common
    let hasCover = false
    const pic = common.picture?.[0]
    if (pic && pic.data && pic.data.length > 0 && coversDir) {
      try {
        await fs.promises.mkdir(coversDir, { recursive: true })
        await fs.promises.writeFile(path.join(coversDir, `${f.id}.jpg`), pic.data)
        hasCover = true
      } catch {
        hasCover = false // 缓存写失败降级（cover 端点仍可现场解析兜底）
      }
    }
    const durationSec = mm.format.duration
    return {
      id: f.id,
      ok: true,
      title: common.title ?? null,
      artist: common.artist ?? common.albumartist ?? null,
      album: common.album ?? null,
      durationMs: durationSec && durationSec > 0 ? Math.round(durationSec * 1000) : null,
      // format 统一存小写扩展名（与 stream 端点 MIME 表同口径；container 描述过长不落库）
      format: path.extname(f.path).slice(1).toLowerCase() || null,
      hasCover,
    }
  } catch (err) {
    // 损坏文件/伪音频：ok=false（主线程 meta_state=2 不再重试，除非 mtime 变化触发重扫）
    return {
      id: f.id,
      ok: false,
      title: null,
      artist: null,
      album: null,
      durationMs: null,
      format: null,
      hasCover: false,
      error: (err as Error).message,
    }
  }
}

async function runMeta(files: MetaFileRef[], coversDir: string | null): Promise<void> {
  try {
    const results: MetaItemResult[] = []
    let cursor = 0
    const loop = async (): Promise<void> => {
      for (;;) {
        const i = cursor++
        if (i >= files.length) return
        results.push(await parseOne(files[i]!, coversDir))
      }
    }
    const lanes = Math.min(META_CONCURRENCY, files.length)
    await Promise.all(Array.from({ length: lanes }, () => loop()))
    port.postMessage({ type: 'metaResult', results } satisfies ScanWorkerOutbound)
  } catch (err) {
    port.postMessage({ type: 'fatal', message: `meta failed: ${(err as Error).message}` } satisfies ScanWorkerOutbound)
  }
}

port.on('message', (msg: ScanWorkerInbound) => {
  if (msg.type === 'walk') void runWalk(msg.roots)
  else if (msg.type === 'meta') void runMeta(msg.files, msg.coversDir)
})
