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
  /** C1: music-metadata parseFile 读取的真实码率 (bps) */
  actual_bitrate: number | null
  /** C1: music-metadata parseFile 读取的真实编码格式 (如 'FLAC', 'MP3') */
  actual_codec: string | null
  /** C1: music-metadata parseFile 读取的真实采样率 (Hz) */
  actual_sample_rate: number | null
  /** H1: 批量入队批次 id（UUID；单首入队为 null） */
  batch_id: string | null
  created_at: number
  updated_at: number
}

/** P2 M2: download_attempts 一行（每次换源/降级/重试尝试的审计轨迹） */
export interface DownloadAttemptRow {
  task_id: string
  attempt_no: number
  source_id: string
  platform: string
  quality: string
  error_code: string | null
  ts: number
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
    -- ── P0 搜索基础设施 D1：搜索历史表（跨设备同步的“我搜过什么”）──
    -- 复用 play_history 范式：id 自增 PK、uid TEXT（网关数字 uid 转字符串；本地模式 'legacy'）、
    -- ts 为写入时间戳（去重置顶时刷新）。store 层按 uid 封顶 200 条（见 core/db/searchHistory.ts）。
    -- type/platform 为可选上下文（搜索类型与平台），缺省空串。
    CREATE TABLE IF NOT EXISTS search_history (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      uid TEXT NOT NULL,
      kw TEXT NOT NULL,
      type TEXT NOT NULL DEFAULT '',
      platform TEXT NOT NULL DEFAULT '',
      ts INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_sh_uid_ts ON search_history(uid, ts DESC);
    -- 热搜聚合（D3 trending / D2 suggest 全局源）按 kw 分组统计频次，加 kw 索引避免全表扫
    CREATE INDEX IF NOT EXISTS idx_sh_kw ON search_history(kw);
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
    -- ── P2 M2 下载审计：每次「换源/降级/重试」尝试写一条，前端「为什么失败」可展开。
    -- 幂等 CREATE IF NOT EXISTS，非破坏（不动 ro.db 既有表）；attempt_no 为队列重试轮次（从 1 起），
    -- 同一轮内跨音源/跨音质的多次尝试共享同一 attempt_no，以 ts/id 升序呈现。
    CREATE TABLE IF NOT EXISTS download_attempts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      task_id TEXT NOT NULL,
      attempt_no INTEGER NOT NULL,
      source_id TEXT NOT NULL DEFAULT '',
      platform TEXT NOT NULL DEFAULT '',
      quality TEXT NOT NULL DEFAULT '',
      error_code TEXT,
      ts INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_attempts_task ON download_attempts(task_id, ts);
    -- ── P2 O5（#200）搜索共现表：「搜过 X 的人也搜 Y」全局共现统计。
    -- 幂等 CREATE IF NOT EXISTS，非破坏（不动 ro.db 既有表）。存双向对 (a,b)+(b,a)，
    -- 使邻居查询按 a=? 命中索引即 O(logN)；count 为共现累计次数，ts 为最近一次共现时间。
    -- 写入时机：search_history 写入时（同一 uid 时间相邻、30min 窗口内的不同搜索词对），见 core/db/searchHistory.ts。
    CREATE TABLE IF NOT EXISTS search_cooccurrence (
      a TEXT NOT NULL,
      b TEXT NOT NULL,
      count INTEGER NOT NULL DEFAULT 1,
      ts INTEGER NOT NULL,
      PRIMARY KEY (a, b)
    );
    CREATE INDEX IF NOT EXISTS idx_cooc_a ON search_cooccurrence(a, count DESC);
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
  // ── P0 C2: 真实音质回写列（music-metadata parseFile 读取后写入，供 SSE task:completed 推送前端）──
  if (!cols.some((c) => c.name === 'actual_bitrate')) {
    db.exec(`ALTER TABLE download_tasks ADD COLUMN actual_bitrate INTEGER`)
    logger.info('[db] migrated: added column download_tasks.actual_bitrate')
  }
  if (!cols.some((c) => c.name === 'actual_codec')) {
    db.exec(`ALTER TABLE download_tasks ADD COLUMN actual_codec TEXT`)
    logger.info('[db] migrated: added column download_tasks.actual_codec')
  }
  if (!cols.some((c) => c.name === 'actual_sample_rate')) {
    db.exec(`ALTER TABLE download_tasks ADD COLUMN actual_sample_rate INTEGER`)
    logger.info('[db] migrated: added column download_tasks.actual_sample_rate')
  }
  // ── P1 H1: 批量下载批次列（/download/batch 入队时写入 UUID；存量行 NULL=非批量）──
  if (!cols.some((c) => c.name === 'batch_id')) {
    db.exec(`ALTER TABLE download_tasks ADD COLUMN batch_id TEXT`)
    logger.info('[db] migrated: added column download_tasks.batch_id')
  }
  db.exec(`CREATE INDEX IF NOT EXISTS idx_tasks_batch ON download_tasks(batch_id)`)
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
  'requeue_count', 'scrape_status', 'scrape_info',
  'actual_bitrate', 'actual_codec', 'actual_sample_rate', 'batch_id',
  'created_at', 'updated_at',
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

  list(opts: { status?: TaskStatus; batchId?: string; limit?: number; offset?: number } = {}): DownloadTaskRow[] {
    // H4: 动态 WHERE（status / batch_id 均可选）；参数对象未提供的键为 undefined，
    // better-sqlite3 对未被 SQL 引用的命名参数不报错，无需逐条拼接参数
    const conds: string[] = []
    if (opts.status) conds.push('status = @status')
    if (opts.batchId) conds.push('batch_id = @batchId')
    const where = conds.length ? `WHERE ${conds.join(' AND ')}` : ''
    const limit = opts.limit ?? 100
    const offset = opts.offset ?? 0
    return getDb()
      .prepare(`SELECT * FROM download_tasks ${where} ORDER BY created_at DESC LIMIT @limit OFFSET @offset`)
      .all({ status: opts.status, batchId: opts.batchId, limit, offset }) as DownloadTaskRow[]
  },

  /** #196-fix2: 轻量 owned 端点数据源——全部终态任务（completed/completed_with_warnings/failed），仅含 owned 判定所需字段，无分页 */
  listOwned(): { id: string; platform: string; songmid: string; status: TaskStatus; requested_quality: string; file_path: string | null }[] {
    return getDb()
      .prepare(
        `SELECT id, platform, songmid, status, requested_quality, file_path
         FROM download_tasks
         WHERE status IN ('completed','completed_with_warnings','failed')
         ORDER BY updated_at DESC`,
      )
      .all() as ReturnType<typeof taskStore.listOwned>
  },

  /** H4/H3: 按状态计数（status 缺省计全部；/status 面板与队列状态端点数据源） */
  count(status?: TaskStatus): number {
    const row = (status
      ? getDb().prepare('SELECT COUNT(*) AS n FROM download_tasks WHERE status = ?').get(status)
      : getDb().prepare('SELECT COUNT(*) AS n FROM download_tasks').get()) as { n: number }
    return row.n
  },

  /** H1: 批次汇总列表（按批次内最新活动时间倒序） */
  listBatches(): { batch_id: string; total: number; pending: number; active: number; completed: number; failed: number; canceled: number; created_at: number; updated_at: number }[] {
    return getDb()
      .prepare(
        `SELECT batch_id,
                COUNT(*) AS total,
                SUM(CASE WHEN status = 'pending' THEN 1 ELSE 0 END) AS pending,
                SUM(CASE WHEN status = 'active' THEN 1 ELSE 0 END) AS active,
                SUM(CASE WHEN status IN ('completed','completed_with_warnings') THEN 1 ELSE 0 END) AS completed,
                SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) AS failed,
                SUM(CASE WHEN status = 'canceled' THEN 1 ELSE 0 END) AS canceled,
                MIN(created_at) AS created_at,
                MAX(updated_at) AS updated_at
         FROM download_tasks WHERE batch_id IS NOT NULL
         GROUP BY batch_id ORDER BY MAX(updated_at) DESC`,
      )
      .all() as ReturnType<typeof taskStore.listBatches>
  },

  /** H1: 整批取消（仅 pending/active 可取消；返回实际取消数） */
  cancelBatch(batchId: string): number {
    const r = getDb()
      .prepare(`UPDATE download_tasks SET status = 'canceled', updated_at = ? WHERE batch_id = ? AND status IN ('pending','active')`)
      .run(Date.now(), batchId)
    return r.changes
  },

  /** H5: 去重查找——同 (platform, songmid, requested_quality) 的在途/已完成任务（canceled/failed 不算） */
  findDuplicate(platform: string, songmid: string, quality: string): DownloadTaskRow | undefined {
    return getDb()
      .prepare(
        `SELECT * FROM download_tasks
         WHERE platform = ? AND songmid = ? AND requested_quality = ?
           AND status IN ('pending','active','completed','completed_with_warnings')
         ORDER BY created_at DESC LIMIT 1`,
      )
      .get(platform, songmid, quality) as DownloadTaskRow | undefined
  },

  /** H2: download-missing 用——同 (platform, songmid) 是否已有带落盘文件的完成任务 */
  findCompletedWithFile(platform: string, songmid: string): DownloadTaskRow | undefined {
    return getDb()
      .prepare(
        `SELECT * FROM download_tasks
         WHERE platform = ? AND songmid = ?
           AND status IN ('completed','completed_with_warnings')
           AND file_path IS NOT NULL AND file_path != ''
         ORDER BY updated_at DESC LIMIT 1`,
      )
      .get(platform, songmid) as DownloadTaskRow | undefined
  },

  delete(id: string): void {
    getDb().prepare('DELETE FROM download_tasks WHERE id = ?').run(id)
    // M2: 级联清理审计轨迹（避免孤儿 attempts 无限累积）
    getDb().prepare('DELETE FROM download_attempts WHERE task_id = ?').run(id)
  },

  /** M2: 批量写入一个重试轮次的全部尝试轨迹（单事务） */
  insertAttempts(rows: DownloadAttemptRow[]): void {
    if (rows.length === 0) return
    const d = getDb()
    const stmt = d.prepare(
      `INSERT INTO download_attempts (task_id, attempt_no, source_id, platform, quality, error_code, ts)
       VALUES (@task_id, @attempt_no, @source_id, @platform, @quality, @error_code, @ts)`,
    )
    const tx = d.transaction((list: DownloadAttemptRow[]) => {
      for (const r of list) stmt.run(r)
    })
    tx(rows)
  },

  /** M2: 某任务的全部尝试轨迹（按 ts/id 升序，GET /tasks/:id/attempts 数据源） */
  listAttempts(taskId: string): DownloadAttemptRow[] {
    return getDb()
      .prepare(
        `SELECT task_id, attempt_no, source_id, platform, quality, error_code, ts
         FROM download_attempts WHERE task_id = ? ORDER BY ts ASC, id ASC`,
      )
      .all(taskId) as DownloadAttemptRow[]
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
