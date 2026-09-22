/**
 * P0 搜索基础设施 D1：搜索历史持久化层
 *
 * 表 `search_history`（DDL 在 db/index.ts initDb() 统一迁移，此处只提供 store 方法）：
 *   id INTEGER PK AUTOINCREMENT / uid TEXT / kw TEXT / type TEXT / platform TEXT / ts INTEGER
 *
 * 复用 core/db/users.ts 的 historyStore 范式（每 uid 封顶 N 条 + 同事务修剪），
 * 并叠加「去重置顶」语义：同一 uid 重复搜同一 kw 不新增行，只把既有行的 ts 刷新为当前
 * 时间（list 按 ts DESC 排序即等价于置顶），同时更新 type/platform 为最近一次上下文。
 *
 * uid 口径与 users.ts 一致：对外统一 TEXT（网关数字 uid 转字符串；本地模式固定 'legacy'）。
 */
import { initDb } from './index.js'
import type Database from 'better-sqlite3'

export interface SearchHistoryRow {
  id: number
  uid: string
  kw: string
  type: string
  platform: string
  ts: number
}

/** 每 uid 保留的搜索历史条数上限（对齐 play_history 的 HISTORY_KEEP=200） */
export const SEARCH_HISTORY_KEEP = 200

/** D3 热搜聚合窗口：近 7 天 */
export const TRENDING_WINDOW_MS = 7 * 24 * 60 * 60 * 1000

/**
 * #200 O5 共现窗口：同一 uid 相邻两次搜索间隔 ≤ 此值才记为一次「共现」。
 * 30min 兼顾「一次听歌会话内连续搜相关词」与「隔天的无关搜索不算共现」。
 */
export const COOC_WINDOW_MS = 30 * 60 * 1000

/**
 * #200 O5 写入一对共现（双向）：(a,b) 与 (b,a) 各 upsert 一次，count+1、ts 刷新。
 * a/b 需已 trim 且非空、a≠b（调用方保证）。在调用方的事务内执行（同一 db 连接）。
 */
function recordCoocPair(db: Database.Database, a: string, b: string, ts: number): void {
  const stmt = db.prepare(
    `INSERT INTO search_cooccurrence (a, b, count, ts) VALUES (?, ?, 1, ?)
     ON CONFLICT(a, b) DO UPDATE SET count = count + 1, ts = excluded.ts`,
  )
  stmt.run(a, b, ts)
  stmt.run(b, a, ts)
}

export const searchHistoryStore = {
  /**
   * 写入一条搜索历史（去重置顶 + 封顶）。
   *
   * 去重键 = (uid, kw.trim())：已存在则刷新 ts/type/platform 并保留原 id（置顶）；
   * 否则新增。随后在同事务内修剪到最近 SEARCH_HISTORY_KEEP 条，防超限堆积。
   * 返回写入/更新后的完整行（含 id 与 ts），供 POST 端点直接回传契约字段。
   *
   * ts 取 max(Date.now(), 该 uid 现有 MAX(ts)+1)：保证同 uid 内 ts 严格递增，
   * 使「去重置顶」在毫秒同刻连写（如脚本/批量）下仍稳定排最前——因刷新行保留原
   * （较小）id，若仅靠 Date.now() 出现同刻并列，list 的 `ts DESC, id DESC` 会被后插入的
   * 新 id 压过，置顶失效。严格递增 ts 让排序不依赖 wall-clock 粒度。
   *
   * 事务函数返回值即 better-sqlite3 transaction() 包裹后的返回值，避免非空断言。
   */
  add(uid: string, kw: string, type = '', platform = ''): SearchHistoryRow {
    const db = initDb()
    const key = kw.trim()
    const tx = db.transaction((): SearchHistoryRow => {
      const now = Date.now()
      const maxRow = db
        .prepare('SELECT MAX(ts) AS m FROM search_history WHERE uid = ?')
        .get(uid) as { m: number | null } | undefined
      const ts = Math.max(now, (maxRow?.m ?? 0) + 1)
      // #200 O5：先捕获该 uid 当前最新一条（本次 upsert 前），用于共现统计
      const prev = db
        .prepare('SELECT kw, ts FROM search_history WHERE uid = ? ORDER BY ts DESC, id DESC LIMIT 1')
        .get(uid) as { kw: string; ts: number } | undefined
      const existing = db
        .prepare('SELECT id FROM search_history WHERE uid = ? AND kw = ?')
        .get(uid, key) as { id: number } | undefined
      let row: SearchHistoryRow
      if (existing) {
        // 去重置顶：保留原 id，刷新时间戳与最近一次上下文
        db.prepare('UPDATE search_history SET ts = ?, type = ?, platform = ? WHERE id = ?')
          .run(ts, type, platform, existing.id)
        row = { id: existing.id, uid, kw: key, type, platform, ts }
      } else {
        const res = db
          .prepare('INSERT INTO search_history (uid, kw, type, platform, ts) VALUES (?, ?, ?, ?, ?)')
          .run(uid, key, type, platform, ts)
        row = { id: Number(res.lastInsertRowid), uid, kw: key, type, platform, ts }
      }
      // 封顶：删除该 uid 超出最近 SEARCH_HISTORY_KEEP 条的旧记录（按 ts DESC, id DESC 保留）
      db.prepare(
        `DELETE FROM search_history WHERE uid = ? AND id NOT IN (
           SELECT id FROM search_history WHERE uid = ? ORDER BY ts DESC, id DESC LIMIT ?
         )`,
      ).run(uid, uid, SEARCH_HISTORY_KEEP)
      // #200 O5：若上一条搜索词与本次不同且在共现窗口内，记一次共现对（同事务，失败随事务回滚）
      if (prev && prev.kw && prev.kw !== key && now - prev.ts <= COOC_WINDOW_MS) {
        recordCoocPair(db, prev.kw, key, now)
      }
      return row
    })
    return tx()
  },

  /** 某 uid 的搜索历史，按 ts DESC（limit 由路由层 clamp） */
  list(uid: string, limit: number): SearchHistoryRow[] {
    return initDb()
      .prepare('SELECT * FROM search_history WHERE uid = ? ORDER BY ts DESC, id DESC LIMIT ?')
      .all(uid, limit) as SearchHistoryRow[]
  },

  /** 清空某 uid 的搜索历史（DELETE 端点）；返回删除行数 */
  clear(uid: string): number {
    const res = initDb().prepare('DELETE FROM search_history WHERE uid = ?').run(uid)
    return res.changes
  },

  /**
   * 全局热搜聚合（D3 trending / D2 suggest 'hot' 源）：
   * 统计 ts >= sinceTs 的记录按 kw 分组频次，倒序取前 limit。
   * 同频次以 MAX(ts) DESC 兜底（近期更热的排前）；过滤空 kw。
   */
  globalTop(sinceTs: number, limit: number): Array<{ kw: string; count: number }> {
    return initDb()
      .prepare(
        `SELECT kw, COUNT(*) AS count FROM search_history
         WHERE ts >= ? AND kw != ''
         GROUP BY kw ORDER BY count DESC, MAX(ts) DESC LIMIT ?`,
      )
      .all(sinceTs, limit) as Array<{ kw: string; count: number }>
  },

  /**
   * 某 uid 的近期搜索词（D2 suggest 'history' 源）：按 ts DESC 取前 limit 个非空 kw。
   * 供联想端点做「我搜过」的个人化匹配。
   */
  recentKeywords(uid: string, limit: number): string[] {
    const rows = initDb()
      .prepare("SELECT kw FROM search_history WHERE uid = ? AND kw != '' ORDER BY ts DESC, id DESC LIMIT ?")
      .all(uid, limit) as Array<{ kw: string }>
    return rows.map((r) => r.kw)
  },
}

/**
 * #200 O5 搜索共现存储（「搜过 X 的人也搜 Y」）。
 * 写入主要由 searchHistoryStore.add() 在同事务内自动触发；record() 另作公开入口（供回填/测试）。
 * 表结构见 db/index.ts 的 search_cooccurrence（双向对 + count + ts）。
 */
export const searchCoocStore = {
  /** 手动记一对共现（双向）；a/b trim 后为空或相等则忽略。 */
  record(a: string, b: string, ts: number = Date.now()): void {
    const ka = (a ?? '').trim()
    const kb = (b ?? '').trim()
    if (!ka || !kb || ka === kb) return
    recordCoocPair(initDb(), ka, kb, ts)
  },

  /**
   * 取与 kw 共现的邻居词，按共现频次降序（同频以最近共现时间降序），排除 kw 自身。
   * 冷启动（无共现数据）返回空数组，由调用方回退 trending。
   */
  neighbors(kw: string, limit: number): Array<{ kw: string; count: number }> {
    const key = (kw ?? '').trim()
    if (!key) return []
    return initDb()
      .prepare(
        `SELECT b AS kw, count FROM search_cooccurrence
         WHERE a = ? AND b != ? ORDER BY count DESC, ts DESC LIMIT ?`,
      )
      .all(key, key, limit) as Array<{ kw: string; count: number }>
  },
}
