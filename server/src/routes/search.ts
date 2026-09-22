/**
 * 搜索路由
 *   GET /api/v1/search?keyword=晴天&platform=kw&page=1&limit=20   单平台
 *   GET /api/v1/search/aggregate?keyword=晴天&platforms=kw,wy&page=1  聚合(默认全平台)
 *   GET /api/v1/search/merged?keyword=晴天&platforms=kw,wy&page=1&limit=30  P1 J1 合并去重视图
 *   GET /api/v1/search/suggest?q=晴&limit=10     P0 D2 搜索联想（history+hot+title 复合去重）
 *   GET /api/v1/search/trending?limit=10         P0 D3 热搜榜（全局近 7 天频次 Top N）
 *   GET /api/v1/search/related?kw=晴天&limit=10   P2 O5 相关推荐（搜过 X 的人也搜 Y；冷启动回退 trending）
 */
import type { FastifyInstance } from 'fastify'
import { searchService, isPlatform, ALL_PLATFORMS, type Platform } from '../core/search/index.js'
import { suggest, trending, related } from '../core/search/suggest.js'

interface SearchQuery {
  keyword?: string
  platform?: string
  page?: string
  limit?: string
  platforms?: string
}

interface SongListDetailQuery {
  platform?: string
  id?: string
  page?: string
}

interface SuggestQuery {
  q?: string
  limit?: string
}

interface TrendingQuery {
  limit?: string
}

interface RelatedQuery {
  kw?: string
  limit?: string
}

/** 当前请求身份 uid（鉴权关闭等 req.user=null 场景兜底 'legacy'，与 me.ts/search-history 同口径） */
function currentUid(req: { user: { uid: string } | null }): string {
  return req.user?.uid ?? 'legacy'
}

export async function searchRoutes(app: FastifyInstance): Promise<void> {
  app.get<{ Querystring: SearchQuery }>('/api/v1/search', async (req, reply) => {
    const { keyword, platform = 'kw', page = '1', limit } = req.query
    if (!keyword) return reply.code(400).send({ error: 'keyword is required' })
    if (!isPlatform(platform)) return reply.code(400).send({ error: `unknown platform: ${platform}`, valid: ALL_PLATFORMS })
    const result = await searchService.searchPlatform(platform, keyword, parseInt(page) || 1, limit ? parseInt(limit) : undefined)
    return result
  })

  app.get<{ Querystring: SearchQuery }>('/api/v1/search/aggregate', async (req, reply) => {
    const { keyword, page = '1', limit, platforms } = req.query
    if (!keyword) return reply.code(400).send({ error: 'keyword is required' })
    let targets: Platform[] = ALL_PLATFORMS
    if (platforms) {
      const parsed = platforms.split(',').map((p) => p.trim()).filter(Boolean)
      const invalid = parsed.filter((p) => !isPlatform(p))
      if (invalid.length) return reply.code(400).send({ error: `unknown platform(s): ${invalid.join(',')}`, valid: ALL_PLATFORMS })
      targets = parsed as Platform[]
    }
    const result = await searchService.searchAggregate(keyword, parseInt(page) || 1, targets, limit ? parseInt(limit) : undefined)
    return result
  })

  // ── P1 J1 合并视图：GET /api/v1/search/merged?keyword=&platforms=&page=&limit= ──
  // 跨平台去重合并（主键 name+singer、辅键 interval±5s），每条挂 sources[] 与相关度评分，按分降序。
  app.get<{ Querystring: SearchQuery }>('/api/v1/search/merged', async (req, reply) => {
    const { keyword, page = '1', limit, platforms } = req.query
    if (!keyword) return reply.code(400).send({ error: 'keyword is required' })
    let targets: Platform[] = ALL_PLATFORMS
    if (platforms) {
      const parsed = platforms.split(',').map((p) => p.trim()).filter(Boolean)
      const invalid = parsed.filter((p) => !isPlatform(p))
      if (invalid.length) return reply.code(400).send({ error: `unknown platform(s): ${invalid.join(',')}`, valid: ALL_PLATFORMS })
      targets = parsed as Platform[]
    }
    const result = await searchService.searchMerged(keyword, parseInt(page) || 1, targets, limit ? parseInt(limit) : undefined)
    return result
  })

  // 歌单搜索（单平台）
  app.get<{ Querystring: SearchQuery }>('/api/v1/search/songlist', async (req, reply) => {
    const { keyword, platform = 'kw', page = '1', limit } = req.query
    if (!keyword) return reply.code(400).send({ error: 'keyword is required' })
    if (!isPlatform(platform)) return reply.code(400).send({ error: `unknown platform: ${platform}`, valid: ALL_PLATFORMS })
    const result = await searchService.searchSongList(platform, keyword, parseInt(page) || 1, limit ? parseInt(limit) : undefined)
    return result
  })

  // 歌单搜索（聚合，默认全平台）
  app.get<{ Querystring: SearchQuery }>('/api/v1/search/songlist/aggregate', async (req, reply) => {
    const { keyword, page = '1', limit, platforms } = req.query
    if (!keyword) return reply.code(400).send({ error: 'keyword is required' })
    let targets: Platform[] = ALL_PLATFORMS
    if (platforms) {
      const parsed = platforms.split(',').map((p) => p.trim()).filter(Boolean)
      const invalid = parsed.filter((p) => !isPlatform(p))
      if (invalid.length) return reply.code(400).send({ error: `unknown platform(s): ${invalid.join(',')}`, valid: ALL_PLATFORMS })
      targets = parsed as Platform[]
    }
    const result = await searchService.searchSongListAggregate(keyword, parseInt(page) || 1, targets, limit ? parseInt(limit) : undefined)
    return result
  })

  // 歌单详情（含歌曲列表，可直接下载/整单下载）
  app.get<{ Querystring: SongListDetailQuery }>('/api/v1/search/songlist/detail', async (req, reply) => {
    const { platform = 'kw', id, page = '1' } = req.query
    if (!id) return reply.code(400).send({ error: 'id is required' })
    if (!isPlatform(platform)) return reply.code(400).send({ error: `unknown platform: ${platform}`, valid: ALL_PLATFORMS })
    const result = await searchService.getSongListDetail(platform, id, parseInt(page) || 1)
    return result
  })

  // ── P0 D2 搜索联想：GET /api/v1/search/suggest?q=&limit= → { q, items:[{ text, singer?, type }] } ──
  // 数据源 = 搜索历史聚合(全局 hot + 当前 uid history) + 热门榜标题池(title)；5min 内存缓存。
  app.get<{ Querystring: SuggestQuery }>('/api/v1/search/suggest', async (req) => {
    const q = req.query?.q ?? ''
    const limit = req.query?.limit ? parseInt(req.query.limit) : 10
    return suggest(q, Number.isInteger(limit) && limit > 0 ? limit : 10, currentUid(req))
  })

  // ── P0 D3 热搜榜：GET /api/v1/search/trending?limit= → { items:[{ text, count }] } ──
  // 全局搜索历史近 7 天频次 Top N。
  app.get<{ Querystring: TrendingQuery }>('/api/v1/search/trending', async (req) => {
    const limit = req.query?.limit ? parseInt(req.query.limit) : 10
    return trending(Number.isInteger(limit) && limit > 0 ? limit : 10)
  })

  // ── P2 O5 相关推荐：GET /api/v1/search/related?kw=&limit= → { related:[{ kw, score }] } ──
  // 基于搜索历史共现统计（搜过 X 的人也搜 Y），按共现频次降序、排除 kw 自身；
  // 冷启动（无共现数据）回退 trending 热门词或空数组，绝不报错。
  app.get<{ Querystring: RelatedQuery }>('/api/v1/search/related', async (req) => {
    const kw = req.query?.kw ?? ''
    const limit = req.query?.limit ? parseInt(req.query.limit) : 10
    return related(kw, Number.isInteger(limit) && limit > 0 ? limit : 10)
  })
}
