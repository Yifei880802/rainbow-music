/**
 * 本地音乐库封面提取（模块四）
 *
 * 实现「复制自 routes/cover.ts 的私有实现」而非改动其导出面（模块 1-3 冻结，
 * 本任务不改既有文件语义）：readFlacCover（FLAC METADATA_BLOCK type=6 PICTURE
 * 零依赖 Buffer 解析，#66 P0-2）/ readMp3Cover（node-id3 APIC）/ normalizeMime。
 * 两处实现语义完全一致；若上游演进，以 cover.ts 为权威口径同步本副本。
 */
import fs from 'node:fs'
import NodeID3 from 'node-id3'

/** 读 MP3 嵌入封面（APIC）；无标签/无图/读取失败均返回 null */
export function readMp3Cover(filePath: string): { buffer: Buffer; mime: string } | null {
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
    return null
  }
}

/** mime 无效时按图片魔数兜底判定（jpeg/png；其余默认 jpeg） */
export function normalizeMime(mime: string, head: Buffer): string {
  if (/^image\/[a-z0-9.+-]+$/i.test(mime)) return mime.toLowerCase()
  if (head[0] === 0xff && head[1] === 0xd8) return 'image/jpeg'
  if (head[0] === 0x89 && head[1] === 0x50 && head[2] === 0x4e && head[3] === 0x47) return 'image/png'
  return 'image/jpeg'
}

/**
 * 读 FLAC 嵌入封面：标准 METADATA_BLOCK type=6 PICTURE 结构的零依赖 Buffer 解析。
 * 任何异常（非 fLaC 头/损坏/无 PICTURE/空图片 data）一律返回 null。
 */
export function readFlacCover(filePath: string): { buffer: Buffer; mime: string } | null {
  const MAX_BLOCK = 32 * 1024 * 1024 // 单 block 长度护栏（防损坏文件声明超大长度读爆内存）
  let fd: number | undefined
  try {
    fd = fs.openSync(filePath, 'r')
    const head = Buffer.alloc(4)
    if (fs.readSync(fd, head, 0, 4, 0) !== 4 || head.toString('latin1') !== 'fLaC') return null
    let pos = 4
    const hdr = Buffer.alloc(4)
    // 上游 metadata block 数量有限；1024 次迭代护栏防损坏文件死循环
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
    return null
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

/** 按扩展名分发提取（与 cover.ts 端点口径一致：仅 mp3/flac；其余格式返回 null） */
export function extractCover(filePath: string): { buffer: Buffer; mime: string } | null {
  const lower = filePath.toLowerCase()
  if (lower.endsWith('.mp3')) return readMp3Cover(filePath)
  if (lower.endsWith('.flac')) return readFlacCover(filePath)
  return null
}
