/**
 * 歌曲歌词路由（P2-2 歌词 sidecar 的后端增量）
 *   GET /api/v1/lyric/:taskId  取任务歌词（原始 lrc 文本，前端解析 [mm:ss.xx] 时间轴渲染滚动歌词）
 *
 * 解析链路（与下载嵌入、冒烟测试共用同一内核 core/adapters/metadata 的 fetchLyric）：
 *   1) 任务不存在 → 404 { error: 'task not found' }
 *   2) music_info 入队 payload（{ platform, musicInfo, ... }，见 queue.ts enqueue）
 *      解析出 platform + musicInfo → fetchLyric 走平台官方接口（洛雪逻辑：不走音源）
 *   3) 拉取成功且 lyric 非空 → 200 { lyric }（歌词对同一任务不可变，允许浏览器缓存一天）
 *   4) 平台不支持 / payload 损坏 / 上游无歌词 → 404 { error: 'no lyric available' }
 *
 * - session/api key 鉴权由全局 onRequest 守卫统一处理（与 cover.ts / play.ts 一致）
 * - 内存 LRU（容量 100，key=taskId）：命中免重复拉取；「确认无歌词」同样缓存，
 *   避免同一任务反复打上游（Map 迭代序即访问序，touch 时删除重插到队尾）
 */
import type { FastifyInstance } from 'fastify'
import { taskStore } from '../core/db/index.js'
import { fetchLyric } from '../core/adapters/metadata.js'
import type { MusicInfo } from '../core/adapters/common.js'

const LYRIC_CACHE_MAX = 100
/** value 为 null 表示「已确认无歌词」，与有值一样缓存（负缓存，防重复拉取） */
const lyricCache = new Map<string, string | null>()

/** LRU 写入/命中：移到队尾；超容量逐出最老一项 */
function cachePut(key: string, value: string | null): void {
  lyricCache.delete(key)
  lyricCache.set(key, value)
  if (lyricCache.size > LYRIC_CACHE_MAX) {
    const oldest = lyricCache.keys().next().value
    if (oldest !== undefined) lyricCache.delete(oldest)
  }
}

/**
 * music_info 列存的是入队 payload（{ platform, musicInfo, quality, ... }，
 * 见 queue.ts enqueue），歌词所需的 songmid/hash 等字段在内层 musicInfo。
 */
function parsePayload(musicInfoJson: string): { platform: string; musicInfo: MusicInfo } | null {
  try {
    const payload = JSON.parse(musicInfoJson) as { platform?: unknown; musicInfo?: MusicInfo }
    if (typeof payload?.platform !== 'string' || !payload.platform) return null
    if (!payload.musicInfo || typeof payload.musicInfo !== 'object') return null
    return { platform: payload.platform, musicInfo: payload.musicInfo }
  } catch {
    return null // 损坏 JSON → 按无歌词处理（404），不抛
  }
}

export async function lyricRoutes(app: FastifyInstance): Promise<void> {
  app.get<{ Params: { taskId: string } }>('/api/v1/lyric/:taskId', async (req, reply) => {
    const row = taskStore.get(req.params.taskId)
    if (!row) return reply.code(404).send({ error: 'task not found' })

    // 1) LRU 命中（含负缓存 null）
    if (lyricCache.has(row.id)) {
      const cached = lyricCache.get(row.id)
      if (typeof cached === 'string') {
        cachePut(row.id, cached) // 命中后移到队尾
        return reply.code(200).header('Cache-Control', 'private, max-age=86400').send({ lyric: cached })
      }
      return reply.code(404).send({ error: 'no lyric available' })
    }

    // 2) 解析入队 payload → 平台官方歌词接口（best-effort，失败返回 null 不抛）
    const payload = parsePayload(row.music_info)
    if (!payload) {
      cachePut(row.id, null)
      return reply.code(404).send({ error: 'no lyric available' })
    }
    const res = await fetchLyric(payload.platform, payload.musicInfo)
    const lyric = res?.lyric && res.lyric.trim() ? res.lyric : null
    cachePut(row.id, lyric)
    if (!lyric) return reply.code(404).send({ error: 'no lyric available' })
    return reply.code(200).header('Cache-Control', 'private, max-age=86400').send({ lyric })
  })
}
