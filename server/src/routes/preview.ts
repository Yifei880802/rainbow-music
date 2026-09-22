/**
 * O1: 结果内试听（音源直链流式代理）
 *   GET /api/v1/preview?platform=&songmid=&quality=&name=&singer=
 *
 * 语义：走 orchestrator.resolveUrl 取音源直链，成功 302 重定向到该直链
 * （不落地、不占下载配额），失败给结构化错误码（M1）。与下载链路**共享**
 * 音源选择/限流——L1 健康排序、L2 熔断、L3 令牌桶都内建在 resolveSourceOrder
 * 与 sourceEngine.callAction 里，本路由复用 orchestrator 即自动继承，无需另建通道。
 *
 * 刻意 allowToggleSource:false：试听针对「这一首」，跨平台换源会换成另一首歌，
 * 语义不符（下载才需要换源兜底）。故 preview 命中失败即失败，不做换源。
 *
 * 鉴权/限流由全局守卫统一处理（见 routes/auth.ts、core/rate-limit.ts）。
 */
import type { FastifyInstance } from 'fastify'
import { orchestrator } from '../core/orchestrator/index.js'
import { isPlatform, ALL_PLATFORMS } from '../core/search/index.js'
import { classifyError, errorToStatus } from '../core/download/errors.js'
import { logger } from '../core/logger.js'
import type { MusicInfo } from '../core/adapters/common.js'
import type { Quality } from '../core/source-engine/lx-env.js'

const VALID_QUALITIES: Quality[] = ['flac24bit', 'flac', '320k', '128k']

interface PreviewQuery {
  platform?: string
  songmid?: string
  quality?: Quality
  name?: string
  singer?: string
}

export async function previewRoutes(app: FastifyInstance): Promise<void> {
  app.get<{ Querystring: PreviewQuery }>('/api/v1/preview', async (req, reply) => {
    const { platform, songmid, quality = 'flac', name, singer } = req.query ?? {}
    if (!platform || !isPlatform(platform)) {
      return reply.code(400).send({ error: { code: 'ERR_BAD_REQUEST', message: 'invalid platform' }, valid: ALL_PLATFORMS })
    }
    if (!songmid || songmid.trim() === '') {
      return reply.code(400).send({ error: { code: 'ERR_BAD_REQUEST', message: 'songmid is required' } })
    }
    if (!VALID_QUALITIES.includes(quality)) {
      return reply.code(400).send({ error: { code: 'ERR_BAD_REQUEST', message: 'invalid quality' }, valid: VALID_QUALITIES })
    }

    // 构造最小 MusicInfo：音源脚本取直链主要依赖 songmid/source；name/singer 可选透传。
    const musicInfo: MusicInfo = {
      name: name?.trim() || songmid,
      singer: singer?.trim() ?? '',
      source: platform,
      songmid,
      albumName: '',
      types: [{ type: quality }],
      _types: { [quality]: {} },
    }

    try {
      const { result } = await orchestrator.resolveUrl({
        platform,
        musicInfo,
        quality,
        allowToggleSource: false, // 试听不换源：命中「这一首」的直链或失败
      })
      // 302 重定向到音源直链；no-store 防止浏览器/中间层缓存易失效的 CDN 直链
      return reply
        .code(302)
        .header('Location', result.url)
        .header('Cache-Control', 'no-store')
        .send()
    } catch (err) {
      const code = classifyError(err)
      const message = err instanceof Error ? err.message : String(err)
      logger.warn({ platform, songmid, quality, code, err: message }, '[preview] 取直链失败')
      return reply.code(errorToStatus(code)).send({ error: { code, message } })
    }
  })
}
