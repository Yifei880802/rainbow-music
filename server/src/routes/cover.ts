/**
 * 歌曲封面路由
 *   GET /api/v1/cover/:taskId  取任务封面（供 <img> 直接引用，同源 Cookie 自动携带）
 *
 * 解析顺序（前端 onerror 回退装饰位配合，见 library.js / player.js）：
 *   1) 任务不存在 → 404
 *   2) 已完成的 MP3 → node-id3 读嵌入 APIC 封面 → 200 image/*
 *      已完成的 FLAC → 解析 METADATA_BLOCK type=6 PICTURE（flac-tagger 写入端已嵌，
 *      #66 P0-2 补齐读取端，零依赖 Buffer 解析）→ 200 image/*
 *   3) music_info 入队 payload 内层 musicInfo.img 存有音源封面直链
 *      （tx/wy/mg 搜索结果自带 500x500，见 adapters/metadata.ts）→ 302 重定向
 *   4) 两者皆无 → 404（前端回退橙色渐变装饰位）
 *
 * - session/api key 鉴权由全局 onRequest 守卫统一处理（与 play.ts 一致）
 * - 路径安全：file_path 解析后必须位于 download.dir 之内（同 play.ts）
 */
import type { FastifyInstance } from 'fastify'
import path from 'node:path'
import fs from 'node:fs'
import NodeID3 from 'node-id3'
import { taskStore, type DownloadTaskRow } from '../core/db/index.js'
import { config } from '../core/config.js'

const DONE_STATUSES = new Set(['completed', 'completed_with_warnings'])

/**
 * music_info 列存的是入队 payload（{ platform, musicInfo, quality, ... }，
 * 见 queue.ts enqueue），封面直链在内层 musicInfo.img。
 */
function coverUrlFromMusicInfo(musicInfoJson: string): string | null {
  try {
    const payload = JSON.parse(musicInfoJson) as { musicInfo?: { img?: unknown } }
    const img = payload?.musicInfo?.img
    if (typeof img === 'string' && /^https?:\/\//i.test(img)) return img
  } catch {
    // 损坏 JSON → 按无封面处理（404），不抛
  }
  return null
}

/** 读 MP3 嵌入封面（APIC）；无标签/无图/读取失败均返回 null */
function readMp3Cover(filePath: string): { buffer: Buffer; mime: string } | null {
  try {
    const tags = NodeID3.read(filePath, { include: ['APIC'] })
    // 写入时 image 可为文件名字符串，读取时为对象；仅接受带 buffer 的对象形态
    const image = tags.image
    if (image && typeof image !== 'string' && image.imageBuffer && image.imageBuffer.length > 0) {
      const mime = image.mime && image.mime.startsWith('image/') ? image.mime : 'image/jpeg'
      return { buffer: image.imageBuffer, mime }
    }
    return null
  } catch {
    return null // 文件缺失/标签损坏 → 回退后续分支
  }
}

/** mime 无效时按图片魔数兜底判定（jpeg/png；其余默认 jpeg） */
function normalizeMime(mime: string, head: Buffer): string {
  if (/^image\/[a-z0-9.+-]+$/i.test(mime)) return mime.toLowerCase()
  if (head[0] === 0xff && head[1] === 0xd8) return 'image/jpeg'
  if (head[0] === 0x89 && head[1] === 0x50 && head[2] === 0x4e && head[3] === 0x47) return 'image/png'
  return 'image/jpeg'
}

/**
 * 读 FLAC 嵌入封面（#66 P0-2）：标准 METADATA_BLOCK type=6 PICTURE 结构的零依赖 Buffer 解析。
 *
 * 文件布局（RFC：fLaC magic 4B → 连续 metadata block）：
 *   block header 4B：bit7 = last-block 标志，bit0-6 = block type（6=PICTURE），后 3B 大端长度
 *   PICTURE body：4B picType / 4B mimeLen + mime / 4B descLen + desc / 4×4B 宽高深色数 /
 *               4B dataLen + data（图片字节）
 *
 * 实测依据（PLAYLIST-EXPANSION-RESEARCH §2.3）：全库 39 首 kw done flac 全含标准
 * type=6 PICTURE（46~80KB，flac-tagger 写入）。任何异常（非 fLaC 头/损坏/无 PICTURE/
 * 空图片 data）一律返回 null，回退 302/404 分支不影响既有链路。
 */
function readFlacCover(filePath: string): { buffer: Buffer; mime: string } | null {
  const MAX_BLOCK = 32 * 1024 * 1024 // 单 block 长度护栏（防损坏文件声明超大长度读爆内存）
  let fd: number | undefined
  try {
    fd = fs.openSync(filePath, 'r')
    const head = Buffer.alloc(4)
    if (fs.readSync(fd, head, 0, 4, 0) !== 4 || head.toString('latin1') !== 'fLaC') return null
    let pos = 4
    const hdr = Buffer.alloc(4)
    // 上游 metadata block 数量有限（实测 ≤8 个）；1024 次迭代护栏防损坏文件死循环
    for (let guard = 0; guard < 1024; guard++) {
      if (fs.readSync(fd, hdr, 0, 4, pos) !== 4) return null // EOF 未见 PICTURE
      pos += 4
      const type = hdr[0]! & 0x7f
      const last = (hdr[0]! & 0x80) !== 0
      const len = (hdr[1]! << 16) | (hdr[2]! << 8) | hdr[3]!
      // PICTURE body 最小 32B（各长度字段全 0）；按需整读该 block
      if (type === 6 && len >= 32 && len <= MAX_BLOCK) {
        const body = Buffer.alloc(len)
        if (fs.readSync(fd, body, 0, len, pos) !== len) return null
        let o = 0
        o += 4 // picture type（3=front cover；不细分，取第一个 PICTURE）
        const mimeLen = body.readUInt32BE(o)
        o += 4
        if (mimeLen > len - o) return null
        const mime = body.toString('latin1', o, o + mimeLen)
        o += mimeLen
        const descLen = body.readUInt32BE(o)
        o += 4
        if (descLen > len - o) return null
        o += descLen // description（UTF-8，跳过）
        o += 16 // width / height / color depth / color count
        const dataLen = body.readUInt32BE(o)
        o += 4
        if (dataLen <= 0 || o + dataLen > len) return null
        const data = body.subarray(o, o + dataLen)
        return { buffer: data, mime: normalizeMime(mime, data.subarray(0, 4)) }
      }
      if (last) return null // 到末 block 仍未见 PICTURE
      pos += len
      if (pos > MAX_BLOCK) return null // 游标护栏（block 链异常增长）
    }
    return null
  } catch {
    return null // 文件缺失/读取异常 → 回退后续分支
  } finally {
    if (fd !== undefined) {
      try {
        fs.closeSync(fd)
      } catch {
        /* 关闭失败忽略 */
      }
    }
  }
}

export async function coverRoutes(app: FastifyInstance): Promise<void> {
  app.get<{ Params: { taskId: string } }>('/api/v1/cover/:taskId', async (req, reply) => {
    const row = taskStore.get(req.params.taskId)
    if (!row) return reply.code(404).send({ error: 'task not found' })

    // 1) 嵌入封面优先（下载时 fetchCoverUrl 抓取并写入的那一张：MP3 APIC / FLAC PICTURE）
    let embedded: { buffer: Buffer; mime: string } | null = null
    if (DONE_STATUSES.has(row.status) && row.file_path) {
      // 路径安全：解析后必须位于 download.dir 之内（防 ../ 穿越与绝对路径逃逸）
      const dir = path.resolve(config.download.dir)
      const filePath = path.resolve(row.file_path)
      const rel = path.relative(dir, filePath)
      const safe = rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel)
      if (safe) {
        const lower = filePath.toLowerCase()
        if (lower.endsWith('.mp3')) embedded = readMp3Cover(filePath)
        else if (lower.endsWith('.flac')) embedded = readFlacCover(filePath) // #66 P0-2
      }
    }
    if (embedded) {
      return reply
        .code(200)
        .header('Content-Type', embedded.mime)
        .header('Content-Length', embedded.buffer.length)
        // 内容不可变（任务封面不会变），允许浏览器缓存一天，避免重复整读文件
        .header('Cache-Control', 'private, max-age=86400')
        .send(embedded.buffer)
    }

    // 2) 音源封面直链 → 302 让浏览器直连（不经服务端转发，零带宽占用）
    const url = coverUrlFromMusicInfo(row.music_info)
    if (url) return reply.redirect(url, 302)

    return reply.code(404).send({ error: 'no cover available' })
  })
}
