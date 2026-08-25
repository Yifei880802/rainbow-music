/**
 * #56 · 音源 enabled 状态持久化
 *
 * 修复 docs/SOURCES.md 记录的已知限制：enabled 原为内存态，data/sources 目录
 * 任何文件变动触发热重载 loadAll() 会重建记录并将 enabled 重置为 true。
 *
 * 方案：复用 SQLite meta 键值表（与优雅停机标记同基建，原子写、随库备份），
 * key = 'sourceEnabled'，value = JSON { [sourceId]: boolean }。
 * 语义：只记录用户显式 setEnabled 过的音源；无记录的音源默认启用（true）。
 * - load() 重建记录时据此恢复 enabled（热重载/重启均生效）
 * - remove() 删除音源时同步清理，避免残留脏键
 */
import { taskStore } from '../db/index.js'
import { logger } from '../logger.js'

const META_KEY = 'sourceEnabled'

type EnabledMap = Record<string, boolean>

function readMap(): EnabledMap {
  try {
    const raw = taskStore.getMeta(META_KEY)
    if (!raw) return {}
    const parsed = JSON.parse(raw) as unknown
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return {}
    const out: EnabledMap = {}
    for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
      if (typeof v === 'boolean') out[k] = v
    }
    return out
  } catch (err) {
    logger.warn({ err: (err as Error).message }, '[source-state] read failed, treating as empty')
    return {}
  }
}

function writeMap(map: EnabledMap): void {
  taskStore.setMeta(META_KEY, JSON.stringify(map))
}

export const sourceState = {
  /** 音源的持久化启停状态；无记录返回 undefined（调用方回退默认 true） */
  isEnabled(id: string): boolean | undefined {
    return readMap()[id]
  },

  /** 记录一次显式启停（toggle / API PATCH 均走这里） */
  setEnabled(id: string, enabled: boolean): void {
    const map = readMap()
    if (map[id] === enabled) return
    map[id] = enabled
    writeMap(map)
    logger.info({ source: id, enabled }, '[source-state] persisted')
  },

  /** 音源删除时清理持久化记录 */
  remove(id: string): void {
    const map = readMap()
    if (!(id in map)) return
    delete map[id]
    writeMap(map)
  },
}
