/**
 * 本地音乐库扫描引擎 — 主线程编排（模块四，模块级单例）
 *
 * 两阶段流水（单 worker 线程复用，消息驱动，见 scanner-worker.ts）：
 *   阶段一 walk：worker 递归枚举 {path,size,mtimeMs}（500 条/批回传）→ 主线程与
 *     SQLite 快照 diff：新文件 INSERT（meta_state=0 待补）；mtime+size 未变仅刷新
 *     seen_round（不动 updated_at，避免排序抖动）；变化行 UPDATE + meta_state=0
 *     重取标签 + 作废旧封面缓存；消失文件按「连续 2 轮未出现才 DELETE」收敛。
 *   阶段二 meta：对 meta_state=0 的行分批（20 条/批）发 worker 解析
 *     （music-metadata title/artist/album/duration/format + 封面落缓存），批量回写
 *     （每批一个事务 ≤100 行，满足分批事务护栏）。
 *
 * seen_round 删除策略（本任务实际实现，DDL 补列见 db/index.ts）：
 *   - per-uid 轮次计数 R 持久化在 meta 表 key=`library_scan_round:<uid>`；
 *   - 每行 seen_round = 最后一次「被扫描看到」的轮次；
 *   - 每轮 walk 结束后执行 DELETE ... WHERE uid=? AND seen_round <= R-2，
 *     即文件连续两轮（R-1、R）都未出现才删除；首轮（R=1/2）对存量行宽容不误删。
 *
 * 进度事件：emitEvent('scan:progress', {phase:'walk'|'meta'|'done', scanned, total,
 * added, updated, removed, currentRoot, metaDone?, metaTotal?, error?}, uid)——
 * 带 uid 定向推送（SSE 只推同 uid 连接），节流 500ms，完成/失败必发。
 *
 * per-uid 互斥：同 uid 扫描中重复 startScan 抛 ScanConflictError（路由层 409）；
 * worker 崩溃/意外退出 → failScan 收尾（状态复位 + done 事件带 error）。
 */
import fs from 'node:fs'
import path from 'node:path'
import { Worker } from 'node:worker_threads'
import { randomUUID } from 'node:crypto'
import { initDb, taskStore } from '../db/index.js'
import { scanRootStore } from '../db/users.js'
import { emitEvent } from '../events.js'
import { logger } from '../logger.js'
import { ROOT_DIR, config } from '../config.js'
import type { MetaFileRef, MetaItemResult, ScanWorkerOutbound, WalkEntry } from './scanner-worker.js'

/** 同 uid 扫描互斥冲突（路由层转 409） */
export class ScanConflictError extends Error {}

// ── 常量（模块四规格冻结值）──
const PROGRESS_THROTTLE_MS = 500
const META_BATCH_SIZE = 20 // 单批发 worker 解析的文件数（worker 内并发 4）
const ROUND_META_KEY = (uid: string): string => `library_scan_round:${uid}`

/** uid 做文件系统组件前的净化（网关数字 uid / 'legacy' 天然安全，此处防御性兜底） */
function sanitizeUid(uid: string): string {
  return uid.replace(/[^a-zA-Z0-9_-]/g, '_') || 'unknown'
}

/**
 * 封面缓存目录：<数据目录>/covers/<uid>/<trackId>.jpg。
 * 数据目录与 SQLite 同源（RO_DB_DIR 或 <root>/data）——容器内 RO_DB_DIR=/app/data/db
 * 时缓存落在已持久化映射的 db 卷（重建容器封面缓存不丢）；本地开发为 <root>/data/covers，
 * 与规格「data/covers/{uid}/{trackId}.jpg」一致。目录惰性创建（首次写时 mkdir）。
 */
export function coverCacheDir(uid: string): string {
  const dataDir = process.env.RO_DB_DIR ? path.resolve(process.env.RO_DB_DIR) : path.join(ROOT_DIR, 'data')
  return path.join(dataDir, 'covers', sanitizeUid(uid))
}

/** 封面缓存文件路径（cover 端点读 / meta worker 写共用同一口径） */
export function coverCacheFile(uid: string, trackId: number): string {
  return path.join(coverCacheDir(uid), `${trackId}.jpg`)
}

export interface ScanProgress {
  phase: 'walk' | 'meta' | 'done'
  scanned: number
  total: number | null
  added: number
  updated: number
  removed: number
  currentRoot: string | null
  metaDone: number
  metaTotal: number
}

export interface ScanLastResult {
  finishedAt: number
  total: number
  added: number
  updated: number
  removed: number
  error?: string
}

interface SnapshotRow {
  id: number
  path: string
  size: number | null
  mtimeMs: number | null
}

interface ScanState {
  uid: string
  jobId: string
  roots: string[]
  scanning: boolean
  startedAt: number
  round: number
  progress: ScanProgress
  worker: Worker | null
  /** 阶段一快照：path → {id,size,mtimeMs}（diff 依据） */
  snapshot: Map<string, SnapshotRow>
  /** 本轮已见路径集合（多根嵌套/同路径去重，防 UNIQUE(uid,path) 冲突） */
  seenPaths: Set<string>
  /** 阶段二待补标签队列（分批发 worker） */
  pendingMeta: MetaFileRef[]
  /** 当前在途 meta 批：id → path（title 缺失时回退文件名用） */
  currentMetaBatch: Map<number, string>
}

/** dev(tsx) 下指 .ts 源文件，编译后指 .js（与 download/index.ts tagWorkerUrl 同手法） */
function scannerWorkerUrl(): URL {
  return import.meta.url.endsWith('.ts')
    ? new URL('./scanner-worker.ts', import.meta.url)
    : new URL('./scanner-worker.js', import.meta.url)
}

/** title 缺失时回退文件名（去扩展名）；「 - 」分隔的命名保留原样作为可读标题 */
function fallbackTitle(filePath: string): string {
  const base = path.basename(filePath, path.extname(filePath))
  return base || filePath
}

class LibraryScanner {
  private readonly states = new Map<string, ScanState>()
  private readonly lastResults = new Map<string, ScanLastResult>()
  private readonly lastEmitAt = new Map<string, number>()

  isScanning(uid: string): boolean {
    return this.states.get(uid)?.scanning === true
  }

  /** GET /api/v1/library/scan/status 数据源（进程内存态） */
  status(uid: string): { scanning: boolean; last?: ScanLastResult; progress?: ScanProgress } {
    const st = this.states.get(uid)
    return {
      scanning: st?.scanning === true,
      last: this.lastResults.get(uid),
      progress: st?.scanning === true ? { ...st.progress } : undefined,
    }
  }

  /**
   * 启动一轮扫描（fire-and-forget；消息驱动推进，不阻塞调用方）。
   * @throws ScanConflictError 该 uid 已有扫描在途（路由层 409）
   */
  startScan(uid: string, roots: string[]): string {
    if (this.isScanning(uid)) throw new ScanConflictError('scan already in progress for this user')
    const db = initDb()
    // per-uid 轮次计数 +1 并立即持久化（崩溃后重启不会复用旧轮号，删除判定保持单调）
    const round = Number(taskStore.getMeta(ROUND_META_KEY(uid)) ?? '0') + 1
    taskStore.setMeta(ROUND_META_KEY(uid), String(round))
    const snapshot = new Map<string, SnapshotRow>()
    const rows = db.prepare('SELECT id, path, size, mtime_ms FROM library_tracks WHERE uid = ?').all(uid) as Array<{
      id: number
      path: string
      size: number | null
      mtime_ms: number | null
    }>
    for (const r of rows) snapshot.set(r.path, { id: r.id, path: r.path, size: r.size, mtimeMs: r.mtime_ms })

    const st: ScanState = {
      uid,
      jobId: randomUUID(),
      roots,
      scanning: true,
      startedAt: Date.now(),
      round,
      progress: {
        phase: 'walk',
        scanned: 0,
        total: null,
        added: 0,
        updated: 0,
        removed: 0,
        currentRoot: roots[0] ?? null,
        metaDone: 0,
        metaTotal: 0,
      },
      worker: null,
      snapshot,
      seenPaths: new Set(),
      pendingMeta: [],
      currentMetaBatch: new Map(),
    }
    this.states.set(uid, st)
    logger.info({ uid, jobId: st.jobId, round, roots: roots.length, known: snapshot.size }, '[library] scan started')

    try {
      const worker = new Worker(scannerWorkerUrl())
      worker.unref() // 不阻止进程退出（与 tag-worker 池一致）
      st.worker = worker
      worker.on('message', (msg: ScanWorkerOutbound) => this.onWorkerMessage(st, msg))
      worker.on('error', (err: Error) => this.failScan(st, `worker error: ${err.message}`))
      worker.on('exit', (code: number) => {
        // 正常收尾路径（finishScan/failScan）先 terminate/置 scanning=false；此处只兜异常退出
        if (st.scanning && code !== 0) this.failScan(st, `worker exited unexpectedly (code ${code})`)
      })
      worker.postMessage({ type: 'walk', jobId: st.jobId, roots })
      this.emitProgress(st, true)
    } catch (err) {
      this.failScan(st, `worker spawn failed: ${(err as Error).message}`)
      throw err // spawn 失败属于同步异常：让调用方拿到 5xx 而非静默失败
    }
    return st.jobId
  }

  // ── worker 消息分发 ──
  private onWorkerMessage(st: ScanState, msg: ScanWorkerOutbound): void {
    if (!st.scanning) return // 已收尾（failScan 后 worker 仍在排空消息队列）
    switch (msg.type) {
      case 'root':
        st.progress.currentRoot = msg.path
        this.emitProgress(st)
        break
      case 'batch':
        this.applyBatch(st, msg.entries)
        break
      case 'walkDone':
        this.afterWalk(st, msg.total, msg.dirErrors, msg.capped)
        break
      case 'metaResult':
        this.applyMeta(st, msg.results)
        break
      case 'fatal':
        this.failScan(st, msg.message)
        break
    }
  }

  /** 阶段一 diff：新 INSERT / 变化 UPDATE / 未变仅 touch seen_round（单批一个事务） */
  private applyBatch(st: ScanState, entries: WalkEntry[]): void {
    const db = initDb()
    const now = Date.now()
    const ins = db.prepare(
      `INSERT INTO library_tracks (uid, path, size, mtime_ms, format, cover_state, meta_state, updated_at, seen_round)
       VALUES (?, ?, ?, ?, ?, 0, 0, ?, ?)`,
    )
    const updChanged = db.prepare(
      `UPDATE library_tracks SET size = ?, mtime_ms = ?, meta_state = 0, cover_state = 0, updated_at = ?, seen_round = ? WHERE id = ?`,
    )
    const touch = db.prepare(`UPDATE library_tracks SET seen_round = ? WHERE id = ?`)
    const tx = db.transaction(() => {
      for (const e of entries) {
        if (st.seenPaths.has(e.path)) continue // 多根嵌套重复枚举去重
        st.seenPaths.add(e.path)
        st.progress.scanned++
        const known = st.snapshot.get(e.path)
        if (!known) {
          ins.run(st.uid, e.path, e.size, e.mtimeMs, path.extname(e.path).slice(1).toLowerCase(), now, st.round)
          st.progress.added++
        } else if (known.size !== e.size || known.mtimeMs !== e.mtimeMs) {
          updChanged.run(e.size, e.mtimeMs, now, st.round, known.id)
          st.progress.updated++
          this.deleteCoverCache(st.uid, known.id) // 文件已变：旧封面缓存作废
        } else {
          touch.run(st.round, known.id) // mtime+size 未变：跳过（不动 updated_at/meta_state）
        }
      }
    })
    try {
      tx()
    } catch (err) {
      this.failScan(st, `db batch write failed: ${(err as Error).message}`)
      return
    }
    this.emitProgress(st)
  }

  /** walk 完成收口：两轮删除规则 + 进入阶段二（或直接完成） */
  private afterWalk(st: ScanState, total: number, dirErrors: number, capped: boolean): void {
    const db = initDb()
    st.progress.total = total
    if (capped) {
      logger.warn({ uid: st.uid, limit: 200_000 }, '[library] scan hit file cap (200k), truncated')
    }
    if (dirErrors > 0) {
      logger.warn({ uid: st.uid, dirErrors }, '[library] scan skipped some unreadable directories')
    }
    // 消失文件：先取 id（顺带清封面缓存）再删；条件 seen_round <= R-2 = 连续两轮未出现
    try {
      const doomed = db.prepare('SELECT id FROM library_tracks WHERE uid = ? AND seen_round <= ?').all(
        st.uid,
        st.round - 2,
      ) as Array<{ id: number }>
      const res = db.prepare('DELETE FROM library_tracks WHERE uid = ? AND seen_round <= ?').run(st.uid, st.round - 2)
      st.progress.removed = res.changes
      for (const d of doomed) this.deleteCoverCache(st.uid, d.id)
    } catch (err) {
      this.failScan(st, `db removal failed: ${(err as Error).message}`)
      return
    }

    // 阶段二：待补标签（meta_state=0：本轮新增/变化行 + 历史未完成行）
    st.pendingMeta = db
      .prepare('SELECT id, path FROM library_tracks WHERE uid = ? AND meta_state = 0 ORDER BY id ASC')
      .all(st.uid) as MetaFileRef[]
    if (st.pendingMeta.length === 0) return this.finishScan(st)
    st.progress.phase = 'meta'
    st.progress.metaTotal = st.pendingMeta.length
    this.emitProgress(st, true)
    this.sendNextMetaBatch(st)
  }

  private sendNextMetaBatch(st: ScanState): void {
    if (!st.worker) return this.failScan(st, 'worker gone before meta batch')
    const batch = st.pendingMeta.splice(0, META_BATCH_SIZE)
    if (batch.length === 0) return this.finishScan(st)
    st.currentMetaBatch = new Map(batch.map((f) => [f.id, f.path]))
    st.worker.postMessage({ type: 'meta', jobId: st.jobId, files: batch, coversDir: coverCacheDir(st.uid) })
  }

  /** 阶段二回写：单批一个事务（≤100 行，符合分批事务护栏）；解析失败 meta_state=2 不再重试 */
  private applyMeta(st: ScanState, results: MetaItemResult[]): void {
    const db = initDb()
    const now = Date.now()
    const upd = db.prepare(
      `UPDATE library_tracks SET title = ?, artist = ?, album = ?, duration_ms = ?, format = ?,
        cover_state = ?, meta_state = ?, updated_at = ? WHERE id = ? AND uid = ?`,
    )
    try {
      db.transaction(() => {
        for (const r of results) {
          if (r.ok) {
            const filePath = st.currentMetaBatch.get(r.id) ?? ''
            upd.run(
              r.title ?? fallbackTitle(filePath), // title 缺失回退文件名（去扩展名）
              r.artist,
              r.album,
              r.durationMs,
              r.format,
              r.hasCover ? 1 : 2, // 解析成功：有/无封面均定格（cover 端点直接命中缓存或 404）
              1,
              now,
              r.id,
              st.uid,
            )
          } else {
            upd.run(null, null, null, null, null, 0, 2, now, r.id, st.uid) // 伪/损坏文件：meta_state=2，mtime 变化才会重试
          }
        }
      })()
    } catch (err) {
      this.failScan(st, `db meta write failed: ${(err as Error).message}`)
      return
    }
    st.currentMetaBatch.clear()
    st.progress.metaDone += results.length
    this.emitProgress(st)
    this.sendNextMetaBatch(st)
  }

  private finishScan(st: ScanState): void {
    if (!st.scanning) return
    st.scanning = false
    st.progress.phase = 'done'
    const tookMs = Date.now() - st.startedAt
    const last: ScanLastResult = {
      finishedAt: Date.now(),
      total: st.progress.scanned,
      added: st.progress.added,
      updated: st.progress.updated,
      removed: st.progress.removed,
    }
    this.lastResults.set(st.uid, last)
    this.terminateWorker(st)
    logger.info(
      { uid: st.uid, jobId: st.jobId, tookMs, ...last, metaDone: st.progress.metaDone },
      '[library] scan finished',
    )
    this.emitProgress(st, true)
  }

  private failScan(st: ScanState, message: string): void {
    if (!st.scanning) return
    st.scanning = false
    st.progress.phase = 'done'
    const last: ScanLastResult = {
      finishedAt: Date.now(),
      total: st.progress.scanned,
      added: st.progress.added,
      updated: st.progress.updated,
      removed: st.progress.removed,
      error: message,
    }
    this.lastResults.set(st.uid, last)
    this.terminateWorker(st)
    logger.error({ uid: st.uid, jobId: st.jobId, message }, '[library] scan failed')
    this.emitProgress(st, true) // 失败必发（data 带 error 字段）
  }

  private terminateWorker(st: ScanState): void {
    if (st.worker) {
      void st.worker.terminate().catch(() => {
        /* 已退出 */
      })
      st.worker = null
    }
  }

  /** 进度事件：节流 500ms；force=true（完成/失败/阶段切换）必发 */
  private emitProgress(st: ScanState, force = false): void {
    const now = Date.now()
    if (!force && now - (this.lastEmitAt.get(st.uid) ?? 0) < PROGRESS_THROTTLE_MS) return
    this.lastEmitAt.set(st.uid, now)
    const last = this.lastResults.get(st.uid)
    emitEvent(
      'scan:progress',
      { ...st.progress, ...(last ? { last } : {}) },
      st.uid,
    )
  }

  /** best-effort 删除封面缓存文件（文件缺失/失败忽略；目录惰性创建对应惰性回收） */
  private deleteCoverCache(uid: string, trackId: number): void {
    try {
      fs.rmSync(coverCacheFile(uid, trackId), { force: true })
    } catch {
      /* 缓存清理失败不影响主流程 */
    }
  }
}

export const libraryScanner = new LibraryScanner()

// ══════════════════════════════════════════════════════════════════
// library_tracks 数据访问（供 routes/library.ts；与扫描编排同文件，
// 集中维护 SQL 口径：uid 过滤恒在 WHERE，杜绝跨用户读写）
// ══════════════════════════════════════════════════════════════════

export interface LibraryTrackRow {
  id: number
  uid: string
  path: string
  size: number | null
  mtime_ms: number | null
  title: string | null
  artist: string | null
  album: string | null
  duration_ms: number | null
  format: string | null
  cover_state: number
  meta_state: number
  updated_at: number
  seen_round: number
}

export type TrackSort = 'updated' | 'artist' | 'album'

export const SORT_MAP: Record<TrackSort, string> = {
  updated: 'updated_at DESC, id DESC',
  artist: 'artist COLLATE NOCASE ASC, title COLLATE NOCASE ASC, id ASC',
  album: 'album COLLATE NOCASE ASC, title COLLATE NOCASE ASC, id ASC',
}

export const libraryTrackStore = {
  /** 分页列表：q → title/artist LIKE；artist/album 精确；sort 白名单映射（防注入） */
  list(opts: {
    uid: string
    limit: number
    offset: number
    artist?: string
    album?: string
    q?: string
    sort: TrackSort
  }): { tracks: LibraryTrackRow[]; total: number } {
    const db = initDb()
    const where: string[] = ['uid = @uid']
    // better-sqlite3 命名参数不接受 undefined：仅拼接「实际用到」的参数
    const params: Record<string, string | number> = { uid: opts.uid, limit: opts.limit, offset: opts.offset }
    if (opts.artist !== undefined) {
      where.push('artist = @artist')
      params.artist = opts.artist
    }
    if (opts.album !== undefined) {
      where.push('album = @album')
      params.album = opts.album
    }
    if (opts.q !== undefined) {
      where.push(`(title LIKE @q ESCAPE '\\' OR artist LIKE @q ESCAPE '\\')`)
      params.q = `%${escapeLike(opts.q)}%`
    }
    const whereSql = `WHERE ${where.join(' AND ')}`
    const total = (
      db.prepare(`SELECT COUNT(*) AS n FROM library_tracks ${whereSql}`).get(params) as { n: number }
    ).n
    const tracks = db
      .prepare(`SELECT * FROM library_tracks ${whereSql} ORDER BY ${SORT_MAP[opts.sort]} LIMIT @limit OFFSET @offset`)
      .all(params) as LibraryTrackRow[]
    return { tracks, total }
  },

  get(uid: string, id: number): LibraryTrackRow | undefined {
    return initDb().prepare('SELECT * FROM library_tracks WHERE id = ? AND uid = ?').get(id, uid) as
      | LibraryTrackRow
      | undefined
  },

  /** 只删索引行（不删音频文件）；返回是否删除成功 */
  delete(uid: string, id: number): boolean {
    const res = initDb().prepare('DELETE FROM library_tracks WHERE id = ? AND uid = ?').run(id, uid)
    return res.changes > 0
  },

  updateCoverState(uid: string, id: number, state: number): void {
    initDb().prepare('UPDATE library_tracks SET cover_state = ? WHERE id = ? AND uid = ?').run(state, id, uid)
  },

  /**
   * 路径安全：track.path 解析后必须位于「该 uid 的 enabled 扫描根 ∪ config.download.dir」
   * 之内（path.relative 前缀校验，play.ts 同手法——防 DB 内异常路径逃逸）。
   */
  isPathAllowed(uid: string, filePath: string): boolean {
    const dirs = new Set<string>([path.resolve(config.download.dir)])
    for (const r of scanRootStore.listByUid(uid)) {
      if (r.enabled === 1) dirs.add(path.resolve(r.path))
    }
    const abs = path.resolve(filePath)
    for (const dir of dirs) {
      const rel = path.relative(dir, abs)
      if (rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel)) return true
    }
    return false
  },
}

/** LIKE 通配符转义（q 含 %/_/\ 时不产生意外匹配） */
function escapeLike(s: string): string {
  return s.replace(/[\\%_]/g, (c) => `\\${c}`)
}
