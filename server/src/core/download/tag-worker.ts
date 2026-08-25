/**
 * 元数据嵌入 worker（worker_threads worker 端）— #6 性能加固
 *
 * 主线程通过消息传递文件路径与元数据（封面先落临时文件、只传路径，
 * 避免大 buffer 的 postMessage 拷贝），在 worker 内完成：
 *   - sharp 封面缩放（CPU 密集）
 *   - NodeID3.write（MP3，同步阻塞）
 *   - flac-tagger 写入（FLAC）
 * 保持 part-fail 语义：封面/标签失败只产出 warnings，不抛错。
 */
import { parentPort } from 'node:worker_threads'
import fs from 'node:fs'
import sharp from 'sharp'
import NodeID3 from 'node-id3'

export interface TagJobMessage {
  jobId: number
  filePath: string
  format: 'mp3' | 'flac'
  meta: {
    name: string
    singer: string
    album?: string
    lyric?: string | null
    /** #45 刮削增量字段（仅 scrape 模式使用；下载路径不传） */
    year?: string
    trackNumber?: string
    genre?: string
    albumArtist?: string
    discNumber?: string
  }
  /** 原始封面临时文件路径（主线程已下载落盘），worker 负责 resize 后清理 */
  coverPath: string | null
  coverSize: number
  /** #45 刮削模式：read-merge-write 只补缺不覆盖（未设置时为下载路径，行为不变） */
  scrape?: boolean
}

export interface TagResultMessage {
  jobId: number
  ok: boolean
  warnings: string[]
  /** #45 刮削模式：实际写入文件的新增字段名（year/trackNumber/genre/albumArtist/discNumber/album…） */
  fieldsWritten?: string[]
}

/** 读取临时封面文件并用 sharp 缩放为正方形 JPEG */
async function resizeCover(coverPath: string, size: number): Promise<Buffer | null> {
  try {
    const raw = await fs.promises.readFile(coverPath)
    if (raw.length < 100) return null
    return await sharp(raw).resize(size, size, { fit: 'cover' }).jpeg({ quality: 90 }).toBuffer()
  } catch {
    return null
  }
}

/** MP3 标签嵌入 */
function embedMp3(filePath: string, meta: TagJobMessage['meta'], cover: Buffer | null): void {
  const tags: NodeID3.Tags = {
    title: meta.name,
    artist: meta.singer,
    album: meta.album,
  }
  if (meta.lyric) tags.unsynchronisedLyrics = { language: 'chi', text: meta.lyric }
  if (cover) tags.image = { mime: 'image/jpeg', type: { id: 3, name: 'front cover' }, description: 'cover', imageBuffer: cover }
  const ok = NodeID3.write(tags, filePath)
  if (ok !== true) throw new Error('node-id3 write failed')
}

/**
 * #45 MP3 刮削写回：read → 找出「meta 有值且现有标签为空」的字段 → update 帧级合并写入。
 * NodeID3.update 只替换给出的 frame，其余 frame（含下载时嵌入的 APIC/USLT）原样保留，
 * 天然满足「只补缺不覆盖 + 幂等」；返回实际补入的字段名。
 * TPE2 别名为 performerInfo、TPOS 为 partOfSet（node-id3 ID3Definitions）。 */
function scrapeMergeMp3(filePath: string, meta: TagJobMessage['meta']): string[] {
  const existing = NodeID3.read(filePath)
  const patch: NodeID3.Tags = {}
  const fieldsWritten: string[] = []
  const tryFill = (key: keyof NodeID3.Tags, field: string, value: string | undefined): void => {
    if (!value) return
    const cur = existing[key] as unknown
    const curText = typeof cur === 'string' ? cur.trim() : cur && typeof cur === 'object' && 'text' in (cur as object) ? String((cur as { text?: unknown }).text ?? '').trim() : ''
    if (curText !== '') return
    ;(patch as Record<string, unknown>)[key] = value
    fieldsWritten.push(field)
  }
  tryFill('title', 'title', meta.name)
  tryFill('artist', 'artist', meta.singer)
  tryFill('album', 'album', meta.album)
  tryFill('year', 'year', meta.year)
  tryFill('trackNumber', 'trackNumber', meta.trackNumber)
  tryFill('genre', 'genre', meta.genre)
  tryFill('performerInfo', 'albumArtist', meta.albumArtist)
  tryFill('partOfSet', 'discNumber', meta.discNumber)
  if (fieldsWritten.length === 0) return []
  const ok = NodeID3.update(patch, filePath)
  if (ok !== true) throw new Error(`node-id3 update failed: ${String(ok)}`)
  return fieldsWritten
}

/** FLAC 标签嵌入（动态 import flac-tagger，避免无 flac 下载时也加载） */
async function embedFlac(filePath: string, meta: TagJobMessage['meta'], cover: Buffer | null): Promise<void> {
  const { writeFlacTags } = await import('flac-tagger')
  const tagMap: Record<string, string> = {
    TITLE: meta.name,
    ARTIST: meta.singer,
  }
  if (meta.album) tagMap.ALBUM = meta.album
  if (meta.lyric) tagMap.LYRICS = meta.lyric
  await writeFlacTags(
    {
      tagMap,
      ...(cover ? { picture: { buffer: cover, mime: 'image/jpeg', description: 'cover' } } : {}),
    },
    filePath,
  )
}

/** #45 FLAC 刮削写回：readFlacTags 读全量 → 只补缺失 Vorbis 字段 → 连同原 picture 整体写回 */
async function scrapeMergeFlac(filePath: string, meta: TagJobMessage['meta']): Promise<string[]> {
  const { readFlacTags, writeFlacTags } = await import('flac-tagger')
  const existing = await readFlacTags(filePath)
  const tagMap: Record<string, string | string[]> = { ...existing.tagMap }
  const fieldsWritten: string[] = []
  const has = (key: string): boolean => {
    const v = tagMap[key]
    return Array.isArray(v) ? v.some((x) => String(x).trim() !== '') : typeof v === 'string' && v.trim() !== ''
  }
  const tryFill = (key: string, field: string, value: string | undefined): void => {
    if (!value || has(key)) return
    tagMap[key] = value
    fieldsWritten.push(field)
  }
  tryFill('TITLE', 'title', meta.name)
  tryFill('ARTIST', 'artist', meta.singer)
  tryFill('ALBUM', 'album', meta.album)
  tryFill('DATE', 'year', meta.year)
  tryFill('TRACKNUMBER', 'trackNumber', meta.trackNumber)
  tryFill('GENRE', 'genre', meta.genre)
  tryFill('ALBUMARTIST', 'albumArtist', meta.albumArtist)
  tryFill('DISCNUMBER', 'discNumber', meta.discNumber)
  if (fieldsWritten.length === 0) return []
  // writeFlacTags 全量重写 Vorbis Comment：必须把读出的 picture 原样带回，避免丢封面
  await writeFlacTags(
    {
      tagMap,
      ...(existing.picture ? { picture: { ...existing.picture } } : {}),
    },
    filePath,
  )
  return fieldsWritten
}

async function handle(job: TagJobMessage): Promise<TagResultMessage> {
  const warnings: string[] = []
  let cover: Buffer | null = null
  if (job.coverPath) {
    cover = await resizeCover(job.coverPath, job.coverSize)
    if (!cover) warnings.push('封面处理失败')
  }
  // #45 刮削模式：read-merge-write 只补缺（不走下载路径的 write 全量替换）
  if (job.scrape) {
    try {
      const fieldsWritten = job.format === 'mp3' ? scrapeMergeMp3(job.filePath, job.meta) : await scrapeMergeFlac(job.filePath, job.meta)
      return { jobId: job.jobId, ok: true, warnings, fieldsWritten }
    } catch (err) {
      return { jobId: job.jobId, ok: true, warnings: [`刮削写回失败: ${(err as Error).message}`], fieldsWritten: [] }
    } finally {
      if (job.coverPath) await fs.promises.rm(job.coverPath, { force: true })
    }
  }
  try {
    if (job.format === 'mp3') embedMp3(job.filePath, job.meta, cover)
    else await embedFlac(job.filePath, job.meta, cover)
  } catch (err) {
    warnings.push(`标签嵌入失败: ${(err as Error).message}`)
  } finally {
    // 清理封面临时文件（无论成败）
    if (job.coverPath) await fs.promises.rm(job.coverPath, { force: true })
  }
  return { jobId: job.jobId, ok: true, warnings }
}

const port = parentPort
if (!port) throw new Error('tag-worker must be started inside worker_threads')

port.on('message', (job: TagJobMessage) => {
  void handle(job).then(
    (res) => port.postMessage(res),
    (err) => port.postMessage({ jobId: job.jobId, ok: false, warnings: [`元数据 worker 异常: ${(err as Error).message}`] } satisfies TagResultMessage),
  )
})
