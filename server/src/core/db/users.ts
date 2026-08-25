/**
 * v0.2.1 用户与个人数据持久化层（模块一）
 *
 * 四张表（DDL 在 db/index.ts initDb() 统一迁移，此处只提供 store 方法）：
 *   users           网关身份落地（uid INTEGER PK / username UNIQUE / is_admin）
 *   user_scan_roots 用户级扫描根选择（模块四扫描引擎的消费契约）
 *   play_history    播放历史（每 uid 保最近 200 条）
 *   favorites       收藏（kind ∈ track|playlist|square，白名单在路由层校验）
 *
 * uid 口径：对外统一 TEXT（网关数字 uid 转字符串；本地模式固定 'legacy'），
 * 仅 users 表主键按计划保留 INTEGER。
 */
import { initDb } from './index.js'

export interface UserRow {
  uid: number
  username: string
  is_admin: number
  first_seen_at: number
  last_seen_at: number
}

/** 请求链路中的用户身份（uid 恒为字符串） */
export interface UserIdentity {
  uid: string
  username: string
  isAdmin: boolean
}

export const userStore = {
  /**
   * 网关头身份落库（upsert）：首见写 first_seen_at，每次刷新
   * username / is_admin / last_seen_at。
   * username UNIQUE 冲突处理：同名异 uid 旧行先删——网关是身份权威源，
   * 视为同人换 uid / 账号重建，以最新头为准。
   */
  upsert(u: UserIdentity): void {
    const db = initDb()
    const uid = Number(u.uid)
    const now = Date.now()
    db.prepare('DELETE FROM users WHERE username = ? AND uid != ?').run(u.username, uid)
    db.prepare(
      `INSERT INTO users (uid, username, is_admin, first_seen_at, last_seen_at)
       VALUES (@uid, @username, @is_admin, @now, @now)
       ON CONFLICT(uid) DO UPDATE
       SET username = @username, is_admin = @is_admin, last_seen_at = @now`,
    ).run({ uid, username: u.username, is_admin: u.isAdmin ? 1 : 0, now })
  },

  get(uid: string): UserRow | undefined {
    const n = Number(uid)
    if (!Number.isInteger(n)) return undefined
    return initDb().prepare('SELECT * FROM users WHERE uid = ?').get(n) as UserRow | undefined
  },

  list(): UserRow[] {
    return initDb().prepare('SELECT * FROM users ORDER BY last_seen_at DESC').all() as UserRow[]
  },
}

export interface ScanRootRow {
  uid: string
  path: string
  enabled: number
  created_at: number
}

export const scanRootStore = {
  listByUid(uid: string): ScanRootRow[] {
    return initDb()
      .prepare('SELECT * FROM user_scan_roots WHERE uid = ? ORDER BY created_at ASC')
      .all(uid) as ScanRootRow[]
  },

  /** 全量替换该 uid 的扫描根选择（事务内 DELETE + INSERT；enabled 恒写 1） */
  replaceAll(uid: string, paths: string[]): void {
    const db = initDb()
    const del = db.prepare('DELETE FROM user_scan_roots WHERE uid = ?')
    const ins = db.prepare(
      'INSERT OR IGNORE INTO user_scan_roots (uid, path, enabled, created_at) VALUES (?, ?, 1, ?)',
    )
    const now = Date.now()
    db.transaction(() => {
      del.run(uid)
      for (const p of paths) ins.run(uid, p, now)
    })()
  },
}

export interface HistoryRow {
  id: number
  uid: string
  track_json: string
  played_at: number
}

/** 每 uid 保留的播放历史条数上限 */
export const HISTORY_KEEP = 200

export const historyStore = {
  /** 写入一条播放记录，并修剪到最近 HISTORY_KEEP 条（同事务，防超限堆积） */
  add(uid: string, trackJson: string): void {
    const db = initDb()
    db.transaction(() => {
      db.prepare('INSERT INTO play_history (uid, track_json, played_at) VALUES (?, ?, ?)')
        .run(uid, trackJson, Date.now())
      db.prepare(
        `DELETE FROM play_history WHERE uid = ? AND id NOT IN (
           SELECT id FROM play_history WHERE uid = ? ORDER BY played_at DESC, id DESC LIMIT ?
         )`,
      ).run(uid, uid, HISTORY_KEEP)
    })()
  },

  list(uid: string, limit: number): HistoryRow[] {
    return initDb()
      .prepare('SELECT * FROM play_history WHERE uid = ? ORDER BY played_at DESC, id DESC LIMIT ?')
      .all(uid, limit) as HistoryRow[]
  },
}

export interface FavoriteRow {
  uid: string
  kind: string
  ref: string
  created_at: number
}

export const favoritesStore = {
  /** INSERT OR IGNORE（UNIQUE(uid,kind,ref) 去重）；返回是否新增 */
  add(uid: string, kind: string, ref: string): boolean {
    const res = initDb()
      .prepare('INSERT OR IGNORE INTO favorites (uid, kind, ref, created_at) VALUES (?, ?, ?, ?)')
      .run(uid, kind, ref, Date.now())
    return res.changes > 0
  },

  remove(uid: string, kind: string, ref: string): boolean {
    const res = initDb()
      .prepare('DELETE FROM favorites WHERE uid = ? AND kind = ? AND ref = ?')
      .run(uid, kind, ref)
    return res.changes > 0
  },

  list(uid: string): FavoriteRow[] {
    return initDb()
      .prepare('SELECT * FROM favorites WHERE uid = ? ORDER BY created_at DESC')
      .all(uid) as FavoriteRow[]
  },
}
