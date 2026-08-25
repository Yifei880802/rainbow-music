/**
 * 歌单持久化层 — 复用 db/index.ts 的同一个 better-sqlite3 连接。
 *
 * 两张表：
 *   playlists       歌单（id/name/desc/uid 归属/时间戳）
 *   playlist_items  歌单内歌曲（含完整 musicInfo JSON，便于直接下载）
 *
 * v0.2.1（模块一/三）：所有方法增加可选 uid 参数（缺省 'legacy'），
 * 查询/变更按 user_id 过滤——v0.2.0 存量行 user_id='legacy' 自动归属
 * 本地 admin，本地模式行为不变；网关用户各自隔离。
 * 表 DDL 的权威定义已上收到 db/index.ts initDb()（启动必跑迁移），
 * 此处 ensureTables 仅作防御性兜底。
 */
import { randomUUID } from 'node:crypto'
import { initDb } from './index.js'
import type { MusicInfo } from '../adapters/common.js'

export interface PlaylistRow {
  id: string
  name: string
  description: string
  /** v0.2.1 归属 uid（本地 'legacy' / 网关数字 uid 字符串） */
  user_id: string
  created_at: number
  updated_at: number
}

export interface PlaylistItemRow {
  id: string
  playlist_id: string
  user_id: string
  platform: string
  songmid: string
  name: string
  singer: string
  album: string
  music_info: string // JSON 序列化 MusicInfo
  created_at: number
}

let inited = false
function ensureTables(): void {
  if (inited) return
  // 表结构（含 user_id 列）由 initDb() 的启动迁移统一创建/补列，此处仅确保连接就绪
  initDb()
  inited = true
}

export const playlistStore = {
  create(name: string, description = '', uid = 'legacy'): PlaylistRow {
    ensureTables()
    const now = Date.now()
    const row: PlaylistRow = { id: randomUUID(), name, description, user_id: uid, created_at: now, updated_at: now }
    initDb().prepare(
      'INSERT INTO playlists (id, name, description, user_id, created_at, updated_at) VALUES (@id, @name, @description, @user_id, @created_at, @updated_at)',
    ).run(row)
    return row
  },

  list(uid = 'legacy'): (PlaylistRow & { count: number })[] {
    ensureTables()
    return initDb().prepare(
      `SELECT p.*, (SELECT COUNT(*) FROM playlist_items i WHERE i.playlist_id = p.id) AS count
       FROM playlists p WHERE p.user_id = @uid ORDER BY p.updated_at DESC`,
    ).all({ uid }) as (PlaylistRow & { count: number })[]
  },

  get(id: string, uid = 'legacy'): PlaylistRow | undefined {
    ensureTables()
    return initDb()
      .prepare('SELECT * FROM playlists WHERE id = ? AND user_id = ?')
      .get(id, uid) as PlaylistRow | undefined
  },

  /** 按名查重（#66 导入端点重名后缀用；限定在 uid 自己的歌单范围内） */
  existsByName(name: string, uid = 'legacy'): boolean {
    ensureTables()
    return !!initDb().prepare('SELECT 1 FROM playlists WHERE name = ? AND user_id = ? LIMIT 1').get(name, uid)
  },

  /**
   * #66 批量导入：事务内建单 + 逐首插入（一次 fs 同步提交，50 首毫秒级）。
   * 顺序保证：与 reorder 同款手法——created_at 每行 +1 严格递增
   * （items() 按 created_at ASC 展示，同毫秒批量插入会导致乱序）；
   * 同批 (platform, songmid) 重复由唯一索引 INSERT OR IGNORE 吸收 → skippedCount。
   */
  createWithItems(
    name: string,
    description: string,
    items: { platform: string; musicInfo: MusicInfo }[],
    uid = 'legacy',
  ): { row: PlaylistRow; addedCount: number; skippedCount: number } {
    ensureTables()
    const db = initDb()
    const now = Date.now()
    const row: PlaylistRow = { id: randomUUID(), name, description, user_id: uid, created_at: now, updated_at: now }
    const ins = db.prepare(
      `INSERT OR IGNORE INTO playlist_items
       (id, playlist_id, user_id, platform, songmid, name, singer, album, music_info, created_at)
       VALUES (@id, @playlist_id, @user_id, @platform, @songmid, @name, @singer, @album, @music_info, @created_at)`,
    )
    let added = 0
    db.transaction(() => {
      db.prepare(
        'INSERT INTO playlists (id, name, description, user_id, created_at, updated_at) VALUES (@id, @name, @description, @user_id, @created_at, @updated_at)',
      ).run(row)
      items.forEach((it, i) => {
        const m = it.musicInfo
        const res = ins.run({
          id: randomUUID(),
          playlist_id: row.id,
          user_id: uid,
          platform: it.platform,
          songmid: String(m.songmid),
          name: m.name,
          singer: m.singer,
          album: m.albumName ?? '',
          music_info: JSON.stringify(m),
          created_at: now + i,
        })
        if (res.changes > 0) added++
      })
    })()
    return { row, addedCount: added, skippedCount: items.length - added }
  },

  rename(id: string, name: string, description?: string, uid = 'legacy'): boolean {
    ensureTables()
    const p = this.get(id, uid)
    if (!p) return false
    initDb().prepare('UPDATE playlists SET name = @name, description = @description, updated_at = @ts WHERE id = @id AND user_id = @uid')
      .run({ id, uid, name, description: description ?? p.description, ts: Date.now() })
    return true
  },

  remove(id: string, uid = 'legacy'): boolean {
    ensureTables()
    const db = initDb()
    // 先按归属校验存在，再级联清理（items 按 playlist_id，id 为 UUID 全局唯一）
    if (!this.get(id, uid)) return false
    db.prepare('DELETE FROM playlist_items WHERE playlist_id = ?').run(id)
    const res = db.prepare('DELETE FROM playlists WHERE id = ? AND user_id = ?').run(id, uid)
    return res.changes > 0
  },

  items(playlistId: string): PlaylistItemRow[] {
    ensureTables()
    return initDb().prepare('SELECT * FROM playlist_items WHERE playlist_id = ? ORDER BY created_at ASC').all(playlistId) as PlaylistItemRow[]
  },

  /** 添加歌曲；已存在(同 platform+songmid)则忽略。返回是否新增。uid 用于行归属落列。 */
  addItem(playlistId: string, platform: string, musicInfo: MusicInfo, uid = 'legacy'): boolean {
    ensureTables()
    const db = initDb()
    const row: PlaylistItemRow = {
      id: randomUUID(),
      playlist_id: playlistId,
      user_id: uid,
      platform,
      songmid: String(musicInfo.songmid),
      name: musicInfo.name,
      singer: musicInfo.singer,
      album: musicInfo.albumName ?? '',
      music_info: JSON.stringify(musicInfo),
      created_at: Date.now(),
    }
    const res = db.prepare(
      `INSERT OR IGNORE INTO playlist_items
       (id, playlist_id, user_id, platform, songmid, name, singer, album, music_info, created_at)
       VALUES (@id, @playlist_id, @user_id, @platform, @songmid, @name, @singer, @album, @music_info, @created_at)`,
    ).run(row)
    if (res.changes > 0) db.prepare('UPDATE playlists SET updated_at = ? WHERE id = ?').run(Date.now(), playlistId)
    return res.changes > 0
  },

  removeItem(playlistId: string, itemId: string): boolean {
    ensureTables()
    const res = initDb().prepare('DELETE FROM playlist_items WHERE id = ? AND playlist_id = ?').run(itemId, playlistId)
    return res.changes > 0
  },

  /**
   * #57 按给定 itemIds 顺序重排歌单曲目（调用方需先校验集合与歌单存在）。
   *
   * 取舍（零 schema 改动方案）：items() 的展示顺序 = created_at ASC，因此重排
   * 通过事务内按新顺序重写 created_at 实现（基准 = max(now, 现有最大 created_at)+1，
   * 每行 +1ms 保证严格递增，且后续 addItem（Date.now()）自然追加到末尾）。
   * - 幂等：相同 itemIds 输入产生相同顺序，重复 PUT 无副作用；
   * - created_at 未在任何 API 响应/前端逻辑中暴露（GET /:id 仅回传
   *   id/platform/songmid/name/singer/album/musicInfo），语义损失可接受；
   * - 相比加 position 列（ALTER + 全量回填 + addItem 维护 MAX+1）省去已部署
   *   数据库的迁移路径，排序唯一性由同事务顺序写入保证。
   */
  reorder(playlistId: string, itemIds: string[]): void {
    ensureTables()
    const db = initDb()
    const maxRow = db.prepare('SELECT MAX(created_at) AS m FROM playlist_items WHERE playlist_id = ?')
      .get(playlistId) as { m: number | null }
    const base = Math.max(Date.now(), maxRow.m ?? 0) + 1
    const upd = db.prepare('UPDATE playlist_items SET created_at = ? WHERE id = ? AND playlist_id = ?')
    db.transaction(() => {
      itemIds.forEach((id, i) => upd.run(base + i, id, playlistId))
      db.prepare('UPDATE playlists SET updated_at = ? WHERE id = ?').run(Date.now(), playlistId)
    })()
  },
}
