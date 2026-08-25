/**
 * 用户上下文路由（模块三，v0.2.1）
 *
 *   GET    /api/v1/me                     当前身份 { uid, username, isAdmin, mode }
 *   GET    /api/v1/me/scan-roots          扫描根契约（模块四/五共用，不得偏离）：
 *                                          available = RO_SCAN_ROOTS 环境变量（':' 分隔容器内
 *                                          路径，缺省 /app/data/downloads）解析；
 *                                          selected = user_scan_roots 表该 uid 的行
 *   PUT    /api/v1/me/scan-roots          { paths: [...] } 全量替换；每个 path 必须 ∈
 *                                          available，越界 400（空数组=清空选择，合法）
 *   POST   /api/v1/me/history             { track: 任意 JSON 对象 } 播放历史上报
 *                                          （track_json 原样存档；每 uid 保最近 200 条）
 *   GET    /api/v1/me/history?limit=50    按 played_at DESC（limit 默认 50，clamp 1..200）
 *   POST   /api/v1/me/favorites           { kind, ref } kind ∈ track|playlist|square
 *   DELETE /api/v1/me/favorites/:kind/:ref
 *   GET    /api/v1/me/favorites            该 uid 全部收藏
 *
 * uid 口径：req.user.uid（网关用户各自隔离；本地 admin='legacy'）；
 * 鉴权关闭时 req.user=null → 按 legacy/admin 兜底（与 v0.2.0 行为一致）。
 */
import type { FastifyInstance } from 'fastify'
import { config } from '../core/config.js'
import { scanRootStore, historyStore, favoritesStore, HISTORY_KEEP } from '../core/db/users.js'

/** 插件级选项：由 buildApp 按实例传入，决定 mode 字段取值 */
export interface MePluginOptions {
  trustGatewayHeaders?: boolean
}

/** 收藏 kind 白名单 */
const FAVORITE_KINDS = ['track', 'playlist', 'square'] as const

/** 扫描根默认值：容器内 data-share 共享下载目录（模块四扫描引擎同一口径） */
const DEFAULT_SCAN_ROOT = '/app/data/downloads'

/**
 * 扫描根契约：RO_SCAN_ROOTS（':' 分隔容器内路径）解析为可选集合；
 * 未设置/为空 → 仅默认根。去重保序。
 */
export function availableScanRoots(): string[] {
  const raw = process.env.RO_SCAN_ROOTS
  if (!raw || !raw.trim()) return [DEFAULT_SCAN_ROOT]
  const parts = raw.split(':').map((s) => s.trim()).filter(Boolean)
  return [...new Set(parts.length ? parts : [DEFAULT_SCAN_ROOT])]
}

/** 鉴权关闭等场景下的 legacy/admin 兜底身份 */
function effectiveUser(req: { user: { uid: string; username: string; isAdmin: boolean } | null }) {
  const u = req.user
  return {
    uid: u?.uid ?? 'legacy',
    username: u?.username ?? (config.auth.webLogin.username || 'admin'),
    isAdmin: u?.isAdmin ?? true,
  }
}

export async function meRoutes(app: FastifyInstance, opts: MePluginOptions = {}): Promise<void> {
  const mode = opts.trustGatewayHeaders === true ? 'gateway' : 'local'

  app.get('/api/v1/me', async (req) => {
    const u = effectiveUser(req)
    return { uid: u.uid, username: u.username, isAdmin: u.isAdmin, mode }
  })

  // ── 扫描根（模块四/五共用契约）──
  app.get('/api/v1/me/scan-roots', async (req) => {
    const uid = effectiveUser(req).uid
    return {
      available: availableScanRoots(),
      selected: scanRootStore.listByUid(uid).map((r) => ({
        path: r.path,
        enabled: r.enabled === 1,
        createdAt: r.created_at,
      })),
    }
  })

  app.put<{ Body: { paths?: unknown } }>('/api/v1/me/scan-roots', async (req, reply) => {
    const uid = effectiveUser(req).uid
    const { paths } = req.body ?? {}
    if (!Array.isArray(paths)) {
      return reply.code(400).send({ error: 'paths (array) is required' })
    }
    const available = availableScanRoots()
    const invalid = paths.filter((p) => typeof p !== 'string' || !available.includes(p))
    if (invalid.length > 0) {
      return reply.code(400).send({ error: 'path not in available scan roots', invalid, available })
    }
    const uniq = [...new Set(paths as string[])]
    scanRootStore.replaceAll(uid, uniq)
    return {
      available,
      selected: scanRootStore.listByUid(uid).map((r) => ({
        path: r.path,
        enabled: r.enabled === 1,
        createdAt: r.created_at,
      })),
    }
  })

  // ── 播放历史（前端 debounce 上报；每 uid 保最近 HISTORY_KEEP 条）──
  app.post<{ Body: { track?: unknown } }>('/api/v1/me/history', async (req, reply) => {
    const uid = effectiveUser(req).uid
    const { track } = req.body ?? {}
    // 「任意 JSON 对象」：接受非 null 的 JSON 值（对象为主，数组/标量也原样存档），
    // 仅拒 undefined/null（无内容可记）；外加大小护栏防滥用
    if (track === undefined || track === null) {
      return reply.code(400).send({ error: 'track (JSON value) is required' })
    }
    let trackJson: string
    try {
      trackJson = JSON.stringify(track)
    } catch {
      return reply.code(400).send({ error: 'track is not JSON-serializable' })
    }
    if (trackJson.length > 64 * 1024) {
      return reply.code(400).send({ error: 'track too large (max 64KB serialized)' })
    }
    historyStore.add(uid, trackJson)
    return { ok: true, keep: HISTORY_KEEP }
  })

  app.get<{ Querystring: { limit?: string } }>('/api/v1/me/history', async (req) => {
    const uid = effectiveUser(req).uid
    let limit = Number(req.query?.limit ?? 50)
    if (!Number.isInteger(limit) || limit < 1) limit = 50
    limit = Math.min(limit, HISTORY_KEEP)
    return {
      history: historyStore.list(uid, limit).map((r) => {
        let track: unknown = null
        try {
          track = JSON.parse(r.track_json)
        } catch {
          /* 防御：异常数据不炸接口 */
        }
        return { id: r.id, track, played_at: r.played_at }
      }),
    }
  })

  // ── 收藏（kind 白名单 + UNIQUE(uid,kind,ref) 去重）──
  app.post<{ Body: { kind?: string; ref?: string } }>('/api/v1/me/favorites', async (req, reply) => {
    const uid = effectiveUser(req).uid
    const { kind, ref } = req.body ?? {}
    if (!kind || !(FAVORITE_KINDS as readonly string[]).includes(kind)) {
      return reply.code(400).send({ error: `kind must be one of ${FAVORITE_KINDS.join('|')}` })
    }
    if (typeof ref !== 'string' || !ref) {
      return reply.code(400).send({ error: 'ref (non-empty string) is required' })
    }
    if (ref.length > 1024) {
      return reply.code(400).send({ error: 'ref too long (max 1024 chars)' })
    }
    const added = favoritesStore.add(uid, kind, ref)
    return { ok: true, added }
  })

  app.delete<{ Params: { kind: string; ref: string } }>('/api/v1/me/favorites/:kind/:ref', async (req, reply) => {
    const uid = effectiveUser(req).uid
    const { kind, ref } = req.params
    if (!(FAVORITE_KINDS as readonly string[]).includes(kind)) {
      return reply.code(400).send({ error: `kind must be one of ${FAVORITE_KINDS.join('|')}` })
    }
    const deleted = favoritesStore.remove(uid, kind, ref)
    return { ok: true, deleted }
  })

  app.get('/api/v1/me/favorites', async (req) => {
    const uid = effectiveUser(req).uid
    return {
      favorites: favoritesStore.list(uid).map((f) => ({ kind: f.kind, ref: f.ref, createdAt: f.created_at })),
    }
  })
}
