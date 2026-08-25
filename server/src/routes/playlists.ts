/**
 * 歌单管理路由（首版）
 *   GET    /api/v1/playlists              歌单列表（含歌曲数）
 *   POST   /api/v1/playlists              创建 { name, description? }
 *   POST   /api/v1/playlists/import       批量导入建单（#66：发现页榜单/平台歌单一键保存）
 *   GET    /api/v1/playlists/:id          歌单详情（含歌曲，按加入顺序）
 *   PATCH  /api/v1/playlists/:id          改名 { name, description? }
 *   DELETE /api/v1/playlists/:id          删除
 *   POST   /api/v1/playlists/:id/items    添加歌曲 { platform, musicInfo }
 *   DELETE /api/v1/playlists/:id/items/:itemId  移除歌曲
 *   PUT    /api/v1/playlists/:id/items/order    重排曲目 { itemIds: [...] }（#57）
 *   POST   /api/v1/playlists/:id/download 整单批量下载 { quality? }
 */
import type { FastifyInstance } from 'fastify'
import { playlistStore } from '../core/db/playlists.js'
import { downloadQueue } from '../core/download/queue.js'
import { isPlatform, ALL_PLATFORMS } from '../core/search/index.js'
import type { MusicInfo } from '../core/adapters/common.js'
import type { Quality } from '../core/source-engine/lx-env.js'

const VALID_QUALITIES: Quality[] = ['flac24bit', 'flac', '320k', '128k']

export async function playlistRoutes(app: FastifyInstance): Promise<void> {
  app.get('/api/v1/playlists', async () => {
    return { playlists: playlistStore.list() }
  })

  app.post<{ Body: { name?: string; description?: string } }>('/api/v1/playlists', async (req, reply) => {
    const { name, description } = req.body ?? {}
    if (!name || !name.trim()) return reply.code(400).send({ error: 'name is required' })
    const row = playlistStore.create(name.trim(), description ?? '')
    return reply.code(201).send(row)
  })

  // #66 批量导入建单：发现页榜单/平台歌单一键保存为本地个人歌单（单请求事务建单，
  // 避免前端逐首 50 次 addItem 往返）。songs 元素与 POST /:id/items 同构
  // （{ platform, musicInfo }），也兼容直接传 MusicInfo（platform 缺省取 musicInfo.source）。
  app.post<{
    Body: {
      title?: string
      description?: string
      songs?: Array<{ platform?: string; musicInfo?: MusicInfo } & Partial<MusicInfo>>
    }
  }>('/api/v1/playlists/import', async (req, reply) => {
    const { title, description, songs } = req.body ?? {}
    const name = (title ?? '').trim()
    if (!name) return reply.code(400).send({ error: 'title is required' })
    if (!Array.isArray(songs) || songs.length === 0) {
      return reply.code(400).send({ error: 'songs (non-empty array) is required' })
    }
    if (songs.length > 200) return reply.code(400).send({ error: 'too many songs (max 200)' })

    const items: { platform: string; musicInfo: MusicInfo }[] = []
    const rejected: { index: number; error: string }[] = []
    songs.forEach((s, index) => {
      // 宽松解析：优先 { platform, musicInfo }；否则把元素本身当 MusicInfo
      const musicInfo = (s?.musicInfo ?? s) as MusicInfo | undefined
      const platform = s?.platform ?? musicInfo?.source
      if (!platform || !isPlatform(platform)) return void rejected.push({ index, error: 'invalid platform' })
      if (!musicInfo || !musicInfo.songmid || !musicInfo.name) {
        return void rejected.push({ index, error: 'musicInfo (with songmid & name) is required' })
      }
      items.push({ platform, musicInfo })
    })
    if (!items.length) {
      return reply.code(400).send({ error: 'no valid song in songs', rejected })
    }

    // 重名自动加后缀：同名歌单已存在 → 「title (2)」「title (3)」…（响应 renamed=true）
    let finalName = name
    for (let n = 2; playlistStore.existsByName(finalName); n++) finalName = `${name} (${n})`

    const { row, addedCount, skippedCount } = playlistStore.createWithItems(
      finalName,
      (description ?? '').slice(0, 500),
      items,
    )
    return reply.code(201).send({
      ...row,
      count: addedCount,
      addedCount,
      skippedCount,
      renamed: finalName !== name,
      rejectedCount: rejected.length,
      rejected,
    })
  })

  app.get<{ Params: { id: string } }>('/api/v1/playlists/:id', async (req, reply) => {
    const p = playlistStore.get(req.params.id)
    if (!p) return reply.code(404).send({ error: 'playlist not found' })
    const items = playlistStore.items(req.params.id).map((it) => ({
      id: it.id,
      platform: it.platform,
      songmid: it.songmid,
      name: it.name,
      singer: it.singer,
      album: it.album,
      musicInfo: JSON.parse(it.music_info) as MusicInfo,
    }))
    return { ...p, items }
  })

  app.patch<{ Params: { id: string }; Body: { name?: string; description?: string } }>('/api/v1/playlists/:id', async (req, reply) => {
    const { name, description } = req.body ?? {}
    if (!name || !name.trim()) return reply.code(400).send({ error: 'name is required' })
    const ok = playlistStore.rename(req.params.id, name.trim(), description)
    if (!ok) return reply.code(404).send({ error: 'playlist not found' })
    return { id: req.params.id, name: name.trim() }
  })

  app.delete<{ Params: { id: string } }>('/api/v1/playlists/:id', async (req, reply) => {
    const ok = playlistStore.remove(req.params.id)
    if (!ok) return reply.code(404).send({ error: 'playlist not found' })
    return { id: req.params.id, deleted: true }
  })

  app.post<{ Params: { id: string }; Body: { platform?: string; musicInfo?: MusicInfo } }>('/api/v1/playlists/:id/items', async (req, reply) => {
    const { platform, musicInfo } = req.body ?? {}
    if (!playlistStore.get(req.params.id)) return reply.code(404).send({ error: 'playlist not found' })
    if (!platform || !isPlatform(platform)) return reply.code(400).send({ error: 'invalid platform', valid: ALL_PLATFORMS })
    if (!musicInfo || !musicInfo.songmid || !musicInfo.name) return reply.code(400).send({ error: 'musicInfo (with songmid & name) is required' })
    const added = playlistStore.addItem(req.params.id, platform, musicInfo)
    return reply.code(added ? 201 : 200).send({ added, message: added ? '已添加' : '歌曲已存在' })
  })

  app.delete<{ Params: { id: string; itemId: string } }>('/api/v1/playlists/:id/items/:itemId', async (req, reply) => {
    const ok = playlistStore.removeItem(req.params.id, req.params.itemId)
    if (!ok) return reply.code(404).send({ error: 'item not found' })
    return { id: req.params.itemId, deleted: true }
  })

  // #57 歌单曲目手动排序（前端拖拽落库）：幂等重排。
  // itemIds 必须与歌单现有曲目集合完全一致（不多、不少、不重复），防部分重排丢歌。
  app.put<{ Params: { id: string }; Body: { itemIds?: string[] } }>('/api/v1/playlists/:id/items/order', async (req, reply) => {
    const { itemIds } = req.body ?? {}
    if (!playlistStore.get(req.params.id)) return reply.code(404).send({ error: 'playlist not found' })
    if (!Array.isArray(itemIds) || itemIds.length === 0) {
      return reply.code(400).send({ error: 'itemIds (non-empty array) is required' })
    }
    const current = playlistStore.items(req.params.id).map((it) => it.id)
    if (itemIds.length !== current.length || new Set(itemIds).size !== current.length) {
      return reply.code(400).send({ error: 'itemIds must cover the current item set exactly (no missing, no duplicates, no unknown ids)', current: current.length, received: itemIds.length })
    }
    const known = new Set(current)
    if (itemIds.some((id) => !known.has(id))) {
      return reply.code(400).send({ error: 'itemIds contains unknown item id(s)', current: current.length, received: itemIds.length })
    }
    playlistStore.reorder(req.params.id, itemIds)
    return { id: req.params.id, reordered: true, count: itemIds.length }
  })

  // 整单批量下载：把歌单里所有歌曲入队
  app.post<{ Params: { id: string }; Body: { quality?: Quality } }>('/api/v1/playlists/:id/download', async (req, reply) => {
    if (!playlistStore.get(req.params.id)) return reply.code(404).send({ error: 'playlist not found' })
    const quality = req.body?.quality ?? 'flac'
    if (!VALID_QUALITIES.includes(quality)) return reply.code(400).send({ error: 'invalid quality', valid: VALID_QUALITIES })
    const items = playlistStore.items(req.params.id)
    if (!items.length) return reply.code(400).send({ error: 'playlist is empty' })
    const accepted: { id: string; name: string }[] = []
    for (const it of items) {
      const musicInfo = JSON.parse(it.music_info) as MusicInfo
      if (!isPlatform(it.platform)) continue
      const id = downloadQueue.enqueue({ platform: it.platform, musicInfo, quality })
      accepted.push({ id, name: it.name })
    }
    return reply.code(201).send({ acceptedCount: accepted.length, accepted })
  })
}
