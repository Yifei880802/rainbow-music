/**
 * SQLite 任务持久化层（better-sqlite3，同步 API）
 * 存下载任务，进程重启后可续跑/对账。
 */
import Database from 'better-sqlite3'
import path from 'node:path'
import fs from 'node:fs'
import { ROOT_DIR } from '../config.js'
import { logger } from '../logger.js'

export type TaskStatus =
  | 'pending'
  | 'active'
  | 'completed'
  | 'completed_with_warnings'
  | 'failed'
  | 'canceled'

/** 刮削状态机：pending(待刮) → running → success / failed(可重试) / skipped(确定性不刮) */
export type ScrapeStatus = 'pending' | 'running' | 'success' | 'failed' | 'skipped'

export interface DownloadTaskRow {
  id: string
  keyword_source: string // 触发来源平台（歌曲原始平台）
  platform: string
  songmid: string
  name: string
  singer: string
  album: string
  requested_quality: string
  actual_quality: string | null
  actual_source: string | null // 实际命中的音源脚本 id
  music_info: string // JSON 序列化的 MusicInfo
  status: TaskStatus
  progress: number // 0-100
  file_path: string | null
  file_size: number | null
  warnings: string | null // JSON 数组（只存面向用户的提示，不放内部簿记）
  error: string | null
  /** 跨重启的重排计数（崩溃循环熔断专用，持久化；手动 retry 重置为 0） */
  requeue_count: number
  /** 自动刮削状态（内部簿记，不进 warnings；pending=未刮过/待刮） */
  scrape_status: ScrapeStatus
  /** 刮削详情 JSON：{attempts,error,warnings[],matched,fieldsWritten[],source,degraded,scrapedAt} */
  scrape_info: string | null
  created_at: number
  updated_at: number
}

let db: Database.Database

export function initDb(): Database.Database {
  if (db) return db
  // 默认 <root>/data；可用 RO_DB_DIR 覆盖（Docker 里指向单独映射的 /app/data/db，
  // 避免 WAL 模式的 ro.db-wal/-shm 与单文件 bind mount 冲突）
  const dataDir = process.env.RO_DB_DIR
    ? path.resolve(process.env.RO_DB_DIR)
    : path.join(ROOT_DIR, 'data')
  fs.mkdirSync(dataDir, { recursive: true })
  const dbPath = path.join(dataDir, 'ro.db')
  db = new Database(dbPath)
  db.pragma('journal_mode = WAL')
  db.exec(`
    CREATE TABLE IF NOT EXISTS download_tasks (
      id TEXT PRIMARY KEY,
      keyword_source TEXT NOT NULL DEFAULT '',
      platform TEXT NOT NULL,
      songmid TEXT NOT NULL,
      name TEXT NOT NULL,
      singer TEXT NOT NULL DEFAULT '',
      album TEXT NOT NULL DEFAULT '',
      requested_quality TEXT NOT NULL,
      actual_quality TEXT,
      actual_source TEXT,
      music_info TEXT NOT NULL,
      status TEXT NOT NULL,
      progress INTEGER NOT NULL DEFAULT 0,
      file_path TEXT,
      file_size INTEGER,
      warnings TEXT,
      error TEXT,
      requeue_count INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_tasks_status ON download_tasks(status);
    CREATE INDEX IF NOT EXISTS idx_tasks_created ON download_tasks(created_at);
    CREATE TABLE IF NOT EXISTS meta (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
    -- ── v0.2.1 多用户基础（模块一）：身份与个人数据表（全部幂等 CREATE IF NOT EXISTS）──
    -- users：网关身份落地表。uid 保留 INTEGER PK（网关 uid 本为数字）；
    -- 其余各表 uid 统一 TEXT（网关数字 uid 转字符串；本地模式固定 'legacy'）。
    CREATE TABLE IF NOT EXISTS users (
      uid INTEGER PRIMARY KEY,
      username TEXT NOT NULL UNIQUE,
      is_admin INTEGER NOT NULL DEFAULT 0,
      first_seen_at INTEGER NOT NULL,
      last_seen_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS user_scan_roots (
      uid TEXT NOT NULL,
      path TEXT NOT NULL,
      enabled INTEGER NOT NULL DEFAULT 1,
      created_at INTEGER NOT NULL,
      UNIQUE(uid, path)
    );
    CREATE TABLE IF NOT EXISTS library_tracks (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      uid TEXT NOT NULL,
      path TEXT NOT NULL,
      size INTEGER,
      mtime_ms INTEGER,
      title TEXT,
      artist TEXT,
      album TEXT,
      duration_ms INTEGER,
      format TEXT,
      cover_state INTEGER NOT NULL DEFAULT 0,
      meta_state INTEGER NOT NULL DEFAULT 0,
      updated_at INTEGER NOT NULL,
      UNIQUE(uid, path)
    );
    CREATE INDEX IF NOT EXISTS idx_lt_uid_artist ON library_tracks(uid, artist);
    CREATE INDEX IF NOT EXISTS idx_lt_uid_album ON library_tracks(uid, album);
    CREATE INDEX IF NOT EXISTS idx_lt_uid_updated ON library_tracks(uid, updated_at);
    CREATE TABLE IF NOT EXISTS play_history (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      uid TEXT NOT NULL,
      track_json TEXT NOT NULL,
      played_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_ph_uid_time ON play_history(uid, played_at DESC);
    CREATE TABLE IF NOT EXISTS favorites (
      uid TEXT NOT NULL,
      kind TEXT NOT NULL,
      ref TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      UNIQUE(uid, kind, ref)
    );
    -- 歌单两表（含 user_id 归属列的最新定义；此处为权威 DDL，
    -- core/db/playlists.ts 的 ensureTables 仅作防御性兑底，不再建表）
    CREATE TABLE IF NOT EXISTS playlists (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      description TEXT NOT NULL DEFAULT '',
      user_id TEXT NOT NULL DEFAULT 'legacy',
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS playlist_items (
      id TEXT PRIMARY KEY,
      playlist_id TEXT NOT NULL,
      user_id TEXT NOT NULL DEFAULT 'legacy',
      platform TEXT NOT NULL,
      songmid TEXT NOT NULL,
      name TEXT NOT NULL,
      singer TEXT NOT NULL DEFAULT '',
      album TEXT NOT NULL DEFAULT '',
      music_info TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      FOREIGN KEY (playlist_id) REFERENCES playlists(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_pitems_playlist ON playlist_items(playlist_id);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_pitems_uniq ON playlist_items(playlist_id, platform, songmid);
  `)
  // 安全迁移：旧库缺 requeue_count 列时补列（PRAGMA table_info 检测后 ALTER）
  const cols = db.pragma('table_info(download_tasks)') as { name: string }[]
  if (!cols.some((c) => c.name === 'requeue_count')) {
    db.exec(`ALTER TABLE download_tasks ADD COLUMN requeue_count INTEGER NOT NULL DEFAULT 0`)
    logger.info('[db] migrated: added column download_tasks.requeue_count')
  }
  // #45 刮削状态列：内部簿记独立成列（不污染 warnings，对齐历史教训）。
  // scrape_status 默认 'pending'：既有完成任务的存量行自动获得「待刮」语义。
  if (!cols.some((c) => c.name === 'scrape_status')) {
    db.exec(`ALTER TABLE download_tasks ADD COLUMN scrape_status TEXT NOT NULL DEFAULT 'pending'`)
    logger.info('[db] migrated: added column download_tasks.scrape_status')
  }
  if (!cols.some((c) => c.name === 'scrape_info')) {
    db.exec(`ALTER TABLE download_tasks ADD COLUMN scrape_info TEXT`)
    logger.info('[db] migrated: added column download_tasks.scrape_info')
  }
  // ── v0.2.1 多用户迁移（模块一）：存量表补归属列（PRAGMA 检测幂等；
  // 默认 'legacy' → v0.2.0 存量数据自动归属本地 admin，本地模式行为零变化）──
  // requested_by 纯预留（可空、不写值），供后续下载任务归属增强使用。
  if (!cols.some((c) => c.name === 'requested_by')) {
    db.exec(`ALTER TABLE download_tasks ADD COLUMN requested_by TEXT`)
    logger.info('[db] migrated: added column download_tasks.requested_by')
  }
  const plCols = db.pragma('table_info(playlists)') as { name: string }[]
  if (!plCols.some((c) => c.name === 'user_id')) {
    db.exec(`ALTER TABLE playlists ADD COLUMN user_id TEXT NOT NULL DEFAULT 'legacy'`)
    logger.info("[db] migrated: added column playlists.user_id (default 'legacy')")
  }
  const pliCols = db.pragma('table_info(playlist_items)') as { name: string }[]
  if (!pliCols.some((c) => c.name === 'user_id')) {
    db.exec(`ALTER TABLE playlist_items ADD COLUMN user_id TEXT NOT NULL DEFAULT 'legacy'`)
    logger.info("[db] migrated: added column playlist_items.user_id (default 'legacy')")
  }
  // ── v0.2.1 模块四（本地音乐库扫描引擎）：library_tracks 补轮次列（幂等 PRAGMA 检测后 ALTER）。
  // seen_round = 该行文件最后一次被扫描看到的轮次号（per-uid 轮次计数持久化在 meta 表
  // key=library_scan_round:<uid>）；「消失文件连续 2 轮扫描未出现才 DELETE」的判定依据：
  // 当前轮 R 执行 DELETE ... WHERE uid=? AND seen_round <= R-2（详见 core/library/scanner.ts）。
  // DEFAULT 0：存量行首轮宽容（0 <= R-2 在 R=1/2 时不成立），第二轮起按两轮规则收敛。
  const ltCols = db.pragma('table_info(library_tracks)') as { name: string }[]
  if (ltCols.length > 0 && !ltCols.some((c) => c.name === 'seen_round')) {
    db.exec(`ALTER TABLE library_tracks ADD COLUMN seen_round INTEGER NOT NULL DEFAULT 0`)
    logger.info('[db] migrated: added column library_tracks.seen_round')
  }
  stripLegacyRequeueBookkeeping(db)
  logger.info(`SQLite ready at ${dbPath}`)
  return db
}

/**
 * 启动时清理历史遗留的内部簿记：旧版本把熔断计数写进 warnings（前缀 `[熔断计数]`），
 * 现已迁到专用列 requeue_count，warnings 只保留面向用户的条目。
 */
const LEGACY_REQUEUE_PREFIX = '[熔断计数]重启重排:'
function stripLegacyRequeueBookkeeping(d: Database.Database): void {
  const rows = d.prepare('SELECT id, warnings FROM download_tasks WHERE warnings LIKE ?').all(`%${LEGACY_REQUEUE_PREFIX.slice(0, 5)}%`) as { id: string; warnings: string }[]
  if (rows.length === 0) return
  const upd = d.prepare('UPDATE download_tasks SET warnings = ? WHERE id = ?')
  const tx = d.transaction(() => {
    for (const r of rows) {
      let arr: string[] = []
      try {
        arr = JSON.parse(r.warnings) as string[]
      } catch {
        continue
      }
      const cleaned = arr.filter((w) => !w.startsWith(LEGACY_REQUEUE_PREFIX))
      if (cleaned.length !== arr.length) upd.run(cleaned.length ? JSON.stringify(cleaned) : null, r.id)
    }
  })
  tx()
  logger.info({ scanned: rows.length }, '[db] stripped legacy requeue bookkeeping from warnings')
}

function getDb(): Database.Database {
  return db ?? initDb()
}

const COLUMNS = [
  'id', 'keyword_source', 'platform', 'songmid', 'name', 'singer', 'album',
  'requested_quality', 'actual_quality', 'actual_source', 'music_info',
  'status', 'progress', 'file_path', 'file_size', 'warnings', 'error',
  'requeue_count', 'scrape_status', 'scrape_info', 'created_at', 'updated_at',
] as const

export const taskStore = {
  insert(row: DownloadTaskRow): void {
    const placeholders = COLUMNS.map((c) => `@${c}`).join(', ')
    getDb().prepare(`INSERT INTO download_tasks (${COLUMNS.join(', ')}) VALUES (${placeholders})`).run(row)
  },

  update(id: string, patch: Partial<DownloadTaskRow>): void {
    const keys = Object.keys(patch).filter((k) => k !== 'id')
    if (keys.length === 0) return
    const setClause = keys.map((k) => `${k} = @${k}`).join(', ')
    getDb()
      .prepare(`UPDATE download_tasks SET ${setClause}, updated_at = @updated_at WHERE id = @id`)
      .run({ ...patch, id, updated_at: Date.now() })
  },

  get(id: string): DownloadTaskRow | undefined {
    return getDb().prepare('SELECT * FROM download_tasks WHERE id = ?').get(id) as DownloadTaskRow | undefined
  },

  list(opts: { status?: TaskStatus; limit?: number; offset?: number } = {}): DownloadTaskRow[] {
    const where = opts.status ? 'WHERE status = @status' : ''
    const limit = opts.limit ?? 100
    const offset = opts.offset ?? 0
    return getDb()
      .prepare(`SELECT * FROM download_tasks ${where} ORDER BY created_at DESC LIMIT @limit OFFSET @offset`)
      .all({ status: opts.status, limit, offset }) as DownloadTaskRow[]
  },

  delete(id: string): void {
    getDb().prepare('DELETE FROM download_tasks WHERE id = ?').run(id)
  },

  /**
   * 启动时把中断的 active 任务标记回 pending（重启续跑）。
   * 返回被重排的 id 集合（同事务内先 SELECT 后 UPDATE，采样范围与 UPDATE 完全对齐）。
   */
  requeueInterrupted(): string[] {
    const d = getDb()
    const tx = d.transaction(() => {
      const rows = d.prepare(`SELECT id FROM download_tasks WHERE status = 'active'`).all() as { id: string }[]
      if (rows.length === 0) return [] as string[]
      d.prepare(`UPDATE download_tasks SET status = 'pending', progress = 0, updated_at = ? WHERE status = 'active'`).run(Date.now())
      return rows.map((r) => r.id)
    })
    return tx()
  },

  /** 键值元数据（优雅停机的干净停机标记等） */
  setMeta(key: string, value: string): void {
    getDb().prepare('INSERT INTO meta (key, value) VALUES (@key, @value) ON CONFLICT(key) DO UPDATE SET value = @value').run({ key, value })
  },

  getMeta(key: string): string | undefined {
    const row = getDb().prepare('SELECT value FROM meta WHERE key = ?').get(key) as { value: string } | undefined
    return row?.value
  },

  /** #45 「一键刮削全部」候选：已完成且有文件且未 success 的任务（force=true 时含已 success） */
  listScrapable(force: boolean): DownloadTaskRow[] {
    const where = force
      ? `status IN ('completed','completed_with_warnings') AND file_path IS NOT NULL AND file_path != ''`
      : `status IN ('completed','completed_with_warnings') AND file_path IS NOT NULL AND file_path != ''
         AND (scrape_status IS NULL OR scrape_status != 'success')`
    return getDb().prepare(`SELECT * FROM download_tasks WHERE ${where} ORDER BY created_at ASC`).all() as DownloadTaskRow[]
  },

  /** #45 刮削状态汇总（GET /api/v1/scrape/status 数据源） */
  scrapeStats(): { none: number; pending: number; running: number; success: number; failed: number; skipped: number } {
    const rows = getDb()
      .prepare(`SELECT COALESCE(scrape_status,'none') AS st, COUNT(*) AS n FROM download_tasks GROUP BY st`)
      .all() as { st: string; n: number }[]
    const out = { none: 0, pending: 0, running: 0, success: 0, failed: 0, skipped: 0 }
    for (const r of rows) {
      if (r.st in out) (out as unknown as Record<string, number>)[r.st] = r.n
    }
    return out
  },

  /**
   * #47 重置全部任务的刮削状态：scrape_status 置回 'pending'、scrape_info 置 NULL。
   * 只动内部簿记两列（不碰任务 status/warnings，也不动已写入文件的标签）；
   * WHERE 排除本就 pending 且无 info 的行，返回值 = 实际发生变化的行数。
   */
  resetScrape(): number {
    const r = getDb()
      .prepare(
        `UPDATE download_tasks
         SET scrape_status = 'pending', scrape_info = NULL, updated_at = ?
         WHERE scrape_status != 'pending' OR scrape_info IS NOT NULL`,
      )
      .run(Date.now())
    return r.changes
  },
}
