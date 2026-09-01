/**
 * #45 刮削元数据获取层 — 各平台「按 songmid 查歌曲详情」适配
 *
 * 字段映射按 2026-08-20 实测探测冻结（脚本 scripts/probe-scrape*.mjs，结论见
 * docs/research/AUTO-SCRAPE-DESIGN.md 附录 B）：
 *   wy: eapi /api/v3/song/detail   → publishTime(ms)→year | no→trackNumber | cd("01")→disc
 *   tx: music.pf_song_detail_svr   → album.time_public→year | index_album→trackNumber |
 *                                    index_cd(>0)→disc | genre 枚举→有限映射
 *   kg: song_search_v2 反查         → 按 Audioid 匹配（含 Grp 展开）→ PublishDate→year
 *   kw: 详情接口均不可用（404/illegal）→ L0 降级：仅 MusicInfo 已有字段（albumName）
 *   mg: resourceinfo.do             → trackNumber | disc("Disc 1")→1 | tagList[0].tagName→genre
 *
 * 语义约定（与 metadata.ts 一致的 best-effort 架构）：
 *   - 网络失败/超时/接口异常 → throw（上层归为 failed，可重试）
 *   - 接口正常但查无此歌/无法定位 → 返回 null（上层归为 skipped，不重试）
 *   - 平台可用但目标字段缺失 → 字段留空（有则写无则跳过）
 * 复用既有基建：httpFetch（per-call timeout）、wy eapi、tx zzcSign、kg/tx 同款 UA。
 */
import { httpFetch } from './http.js'
import { eapi } from './wy/crypto.js'
import { zzcSign } from './tx/crypto.js'
import { filterStr } from './match.js'
import type { MusicInfo } from './common.js'
import { logger } from '../logger.js'

/** 刮削目标字段（只补缺不覆盖；全部可选） */
export interface ScrapedMeta {
  /** 歌名（仅用于上层防串号校验，不写入标签——标签的 title 已在下载时写入） */
  name?: string
  /** 发行年份 YYYY */
  year?: string
  /** 曲目号（"3" 或 "3/12"） */
  trackNumber?: string
  /** 碟号（"1" 或 "1/2"） */
  discNumber?: string
  genre?: string
  albumArtist?: string
  album?: string
  singer?: string
}

export interface ScrapeDetailResult {
  meta: ScrapedMeta
  /** 数据来源标识（写入 scrape_info.source，如 'wy:song-detail'） */
  source: string
  /** L0 降级（平台详情接口不可用，仅用搜索结果已有字段） */
  degraded?: boolean
}

const SCRAPE_TIMEOUT_MS = 8000
const YEAR_RE = /(19|20)\d{2}/

/** 任意日期/时间戳形态提取 4 位年份（"2003-04-15" / 1733068800000 / "2003-07-31"）；数值 0/负数 = 平台未提供（publishTime=0 哨兵），不产出 1970 */
function toYear(input: unknown): string | undefined {
  if (input == null) return undefined
  if (typeof input === 'number' && Number.isFinite(input)) {
    if (input <= 0) return undefined
    const y = new Date(input > 1e12 ? input : input * 1000).getFullYear()
    return y >= 1900 && y <= 2100 ? String(y) : undefined
  }
  const m = YEAR_RE.exec(String(input))
  return m?.[0]
}

function firstStr(...vals: unknown[]): string | undefined {
  for (const v of vals) {
    if (typeof v === 'string' && v.trim() !== '') return v.trim()
    if (typeof v === 'number' && Number.isFinite(v)) return String(v)
  }
  return undefined
}

// ── wy 网易云 ────────────────────────────────────────────────────

interface WyDetailSong {
  name?: string
  ar?: { name?: string }[]
  al?: { name?: string; picUrl?: string }
  publishTime?: number
  cd?: string
  no?: number
}

async function wyDetail(songmid: string): Promise<ScrapeDetailResult | null> {
  const id = Number(songmid)
  if (!Number.isFinite(id)) return null
  const form = eapi('/api/v3/song/detail', { c: JSON.stringify([{ id }]), ids: `[${id}]` })
  const { body } = await httpFetch<{ code?: number; songs?: WyDetailSong[] }>(
    'https://interface3.music.163.com/eapi/song/detail',
    {
      method: 'post',
      headers: {
        'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/60.0.3112.90 Safari/537.36',
        origin: 'https://music.163.com',
      },
      form,
      timeout: SCRAPE_TIMEOUT_MS,
    },
  ).promise
  const song = body?.songs?.[0]
  if (!song || body?.code !== 200) return null
  const cdRaw = firstStr(song.cd) // 形如 "01"
  const cd = cdRaw && /^\d+$/.test(cdRaw) ? String(parseInt(cdRaw, 10)) : undefined
  return {
    meta: {
      name: firstStr(song.name),
      year: toYear(song.publishTime),
      trackNumber: song.no && song.no > 0 ? String(song.no) : undefined,
      discNumber: cd && parseInt(cd, 10) > 0 ? cd : undefined,
      album: firstStr(song.al?.name),
      singer: song.ar?.map((a) => a.name).filter(Boolean).join('、') || undefined,
    },
    source: 'wy:song-detail',
  }
}

// ── tx QQ 音乐 ──────────────────────────────────────────────────

/** tx genre 数字枚举 → 文本（仅映射可确认的常见项，未知枚举宁缺勿错） */
const TX_GENRE_MAP: Record<number, string> = {
  1: '流行', 2: '古典', 3: '民谣', 4: '流行电子', 5: '电子舞曲', 6: '轻音乐',
  7: '爵士', 8: '嘻哈', 9: '说唱', 10: '乡村', 11: 'R&B', 12: '摇滚',
  13: '新世纪', 15: '蓝调', 19: '英伦', 20: '重金属', 22: '器乐', 25: '世界',
  28: '朋克', 29: '雷鬼',
}

interface TxTrackInfo {
  name?: string
  singer?: { name?: string }[]
  album?: { name?: string; time_public?: string; pubTime?: string }
  index_cd?: number
  index_album?: number
  genre?: number
}

async function txDetail(songmid: string): Promise<ScrapeDetailResult | null> {
  const payload = {
    comm: { ct: 24, cv: 0 },
    req: {
      module: 'music.pf_song_detail_svr',
      method: 'get_song_detail',
      param: { song_mid: songmid, enc_type: 'utf8' },
    },
  }
  const raw = JSON.stringify(payload)
  const { body } = await httpFetch<{ code?: number; req?: { code?: number; data?: { track_info?: TxTrackInfo } } }>(
    `https://u.y.qq.com/cgi-bin/musics.fcg?sign=${zzcSign(raw)}`,
    {
      method: 'post',
      headers: { 'User-Agent': 'QQMusic 14090508(android 12)', 'Content-Type': 'application/json' },
      body: raw,
      timeout: SCRAPE_TIMEOUT_MS,
    },
  ).promise
  const track = body?.req?.data?.track_info
  if (!track || body?.code !== 0 || body?.req?.code !== 0) return null
  const genre = typeof track.genre === 'number' ? TX_GENRE_MAP[track.genre] : undefined
  return {
    meta: {
      name: firstStr(track.name),
      year: toYear(track.album?.time_public ?? track.album?.pubTime),
      trackNumber: track.index_album && track.index_album > 0 ? String(track.index_album) : undefined,
      discNumber: track.index_cd && track.index_cd > 0 ? String(track.index_cd) : undefined,
      genre,
      album: firstStr(track.album?.name),
      singer: track.singer?.map((s) => s.name).filter(Boolean).join('、') || undefined,
    },
    source: 'tx:song-detail',
  }
}

// ── kg 酷狗（song_search_v2 反查：响应含 PublishDate，按 Audioid 匹配） ──

interface KgSearchItem {
  Audioid?: number | string
  SongName?: string
  SingerName?: string
  AlbumName?: string
  PublishDate?: string
  Grp?: KgSearchItem[]
}

async function kgDetail(musicInfo: MusicInfo): Promise<ScrapeDetailResult | null> {
  const songmid = String(musicInfo.songmid)
  const keyword = `${musicInfo.name} ${musicInfo.singer}`.trim()
  const url = `https://songsearch.kugou.com/song_search_v2?keyword=${encodeURIComponent(keyword)}&page=1&pagesize=30&userid=0&clientver=&platform=WebFilter&filter=2&iscorrection=1&privilege_filter=0&area_code=1`
  const { body } = await httpFetch<{ error_code?: number; data?: { lists?: KgSearchItem[] } }>(url, {
    timeout: SCRAPE_TIMEOUT_MS,
  }).promise
  if (!body || body.error_code !== 0) return null
  // 展开外层与 Grp 子项，按 Audioid 精确匹配（kg 无按 id 直查的详情接口，此为 L1 变体）
  const flat: KgSearchItem[] = []
  for (const item of body.data?.lists ?? []) {
    flat.push(item)
    if (Array.isArray(item.Grp)) flat.push(...item.Grp)
  }
  const hit = flat.find((it) => String(it.Audioid ?? '') === songmid)
  if (!hit) return null
  return {
    meta: {
      // kg 按 Audioid 精确匹配，歌名天然对齐，无需上层再校验
      year: toYear(hit.PublishDate),
      album: firstStr(hit.AlbumName),
      singer: firstStr(hit.SingerName),
    },
    source: 'kg:search-refetch',
  }
}

// ── mg 咪咕（resourceinfo.do：trackNumber / disc / tagList 流派） ──

interface MgResource {
  songName?: string
  singer?: string
  album?: string
  trackNumber?: string
  disc?: string
  tagList?: { tagName?: string }[]
}

async function mgDetail(musicInfo: MusicInfo): Promise<ScrapeDetailResult | null> {
  const copyrightId = String(musicInfo.copyrightId ?? '')
  if (!copyrightId) return null
  const { body } = await httpFetch<{ code?: string; resource?: MgResource[] }>(
    `https://c.musicapp.migu.cn/MIGUM2.0/v1.0/content/resourceinfo.do?copyrightId=${encodeURIComponent(copyrightId)}&resourceType=2`,
    {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Linux; U; Android 11.0.0; zh-cn; MI 11) AppleWebKit/534.30 (KHTML, like Gecko) Version/4.0 Mobile Safari/534.30',
        ua: 'Android_migu',
        version: '5.0.1',
      },
      timeout: SCRAPE_TIMEOUT_MS,
    },
  ).promise
  const res = body?.resource?.[0]
  if (!res || body?.code !== '000000') return null
  const discRaw = firstStr(res.disc) // 形如 "Disc 1"
  const discDigits = discRaw?.match(/\d+/)?.[0]
  return {
    meta: {
      name: firstStr(res.songName),
      trackNumber: firstStr(res.trackNumber),
      discNumber: discDigits && parseInt(discDigits, 10) > 0 ? String(parseInt(discDigits, 10)) : undefined,
      genre: firstStr(res.tagList?.[0]?.tagName),
      album: firstStr(res.album),
      singer: firstStr(res.singer),
    },
    source: 'mg:resource-info',
  }
}

// ── kw 酷我：详情接口均不可用 → L0 降级（仅搜索结果已有字段） ──

function kwL0(musicInfo: MusicInfo): ScrapeDetailResult | null {
  const meta: ScrapedMeta = {
    name: musicInfo.name || undefined,
    album: musicInfo.albumName || undefined,
    singer: musicInfo.singer || undefined,
  }
  const hasAny = meta.album || meta.singer || meta.year || meta.trackNumber || meta.genre
  if (!hasAny) return null
  return { meta, source: 'kw:l0-degraded', degraded: true }
}

/**
 * 按平台查详情（主入口）。
 * 返回 null = 接口正常但查无此歌（上层 skipped）；throw = 网络/接口异常（上层 failed）。
 */
export async function fetchScrapeDetail(platform: string, musicInfo: MusicInfo): Promise<ScrapeDetailResult | null> {
  const songmid = String(musicInfo.songmid ?? '')
  switch (platform) {
    case 'wy':
      return wyDetail(songmid)
    case 'tx':
      return txDetail(songmid)
    case 'kg':
      return kgDetail(musicInfo)
    case 'mg':
      return mgDetail(musicInfo)
    case 'kw':
      return kwL0(musicInfo)
    default:
      return null
  }
}

// ── #47 L2 MusicBrainz 兜底 albumArtist（五平台详情接口均不提供该字段，见设计文档附录 B） ──

/**
 * MB 官方限流平均 1 req/s；独立节流 ≥1.1s/次（不复用刮削队列的 300ms 任务间隔）。
 * 预占式推进：发起前先占住时刻，保证任意两次实际请求间隔 ≥1.1s（并发调用也安全）。
 */
const MB_MIN_INTERVAL_MS = 1100
const MB_TIMEOUT_MS = 8000
const MB_UA = 'Rainbow/0.2.14 ( https://github.com/Yifei880802/rainbow-music )'
let mbNextAt = 0

async function mbThrottle(): Promise<void> {
  const now = Date.now()
  const at = Math.max(now, mbNextAt)
  mbNextAt = at + MB_MIN_INTERVAL_MS
  if (at > now) await new Promise((r) => setTimeout(r, at - now))
}

export interface MbFallbackResult {
  /** attempted=请求已发出但结果未知（网络失败/超时/非200）；hit=高置信命中；miss=查询完成但无高置信匹配 */
  status: 'attempted' | 'hit' | 'miss'
  albumArtist?: string
}

interface MbRecording {
  title?: string
  length?: number
  'artist-credit'?: { name?: string }[]
  releases?: { 'artist-credit'?: { name?: string }[] }[]
}
interface MbSearchBody {
  count?: number
  recordings?: MbRecording[]
}

/** "4:31" → 秒 */
function intervalToSec(interval: string | 0 | undefined): number {
  if (!interval) return 0
  const parts = String(interval).split(':')
  let sec = 0
  let unit = 1
  while (parts.length) {
    sec += parseInt(parts.pop() as string) * unit
    unit *= 60
  }
  return sec
}

/**
 * MusicBrainz recording 检索兜底 albumArtist（TPE2/ALBUMARTIST），宁缺勿错：
 * 仅当 recording.title 归一化（match.ts filterStr）后与任务歌名完全相等，
 * 且 artist-credit 与任务歌手互相包含（对齐 findMusic 档1最高档：歌名完全相等+歌手包含，
 * 有时长时长差 <5s 一票否决，MB 无 length 时否决豁免）时，
 * 取首个含 artist-credit 的 release（release-group/first-release 维度）的艺术家名。
 * 失败/超时/无结果 → 静默跳过，status 如实回传供 scrape_info.mbFallback 标注。
 * 零新依赖（httpFetch）；中文曲目覆盖有限属预期。
 */
export async function fetchMbAlbumArtist(ref: {
  name: string
  singer: string
  interval?: string | 0
}): Promise<MbFallbackResult> {
  const title = String(ref.name ?? '').trim().replace(/"/g, '')
  const artist = String(ref.singer ?? '').trim().replace(/"/g, '')
  if (!title) return { status: 'miss' }
  await mbThrottle()
  const query = `recording:"${title}"${artist ? ` AND artist:"${artist}"` : ''}`
  try {
    const { statusCode, body } = await httpFetch<MbSearchBody>(
      `https://musicbrainz.org/ws/2/recording?query=${encodeURIComponent(query)}&fmt=json&limit=10`,
      { headers: { 'User-Agent': MB_UA, Accept: 'application/json' }, timeout: MB_TIMEOUT_MS },
    ).promise
    if (statusCode !== 200 || !Array.isArray(body?.recordings)) {
      logger.debug({ statusCode }, '[scrape] mb fallback non-200 (silent)')
      return { status: 'attempted' }
    }
    const fTitle = filterStr(title).toLowerCase()
    const fSinger = filterStr(artist).toLowerCase()
    const refSec = intervalToSec(ref.interval)
    for (const rec of body.recordings) {
      // 档1最高档：归一化歌名完全相等
      if (filterStr(String(rec.title ?? '')).toLowerCase() !== fTitle) continue
      // 歌手包含（归一化后相等或互相包含；歌手缺失时不可信，跳过）
      const credit = (rec['artist-credit'] ?? []).map((c) => c?.name ?? '').filter(Boolean).join('、')
      const fCredit = filterStr(credit).toLowerCase()
      if (!fCredit) continue
      if (fSinger && fCredit !== fSinger && !fCredit.includes(fSinger) && !fSinger.includes(fCredit)) continue
      // 时长一票否决（双方都有数据时，差 ≥5s 视为串号；对齐 findMusic 档1 前置时长校验）
      if (refSec > 0 && typeof rec.length === 'number' && rec.length > 0 && Math.abs(refSec * 1000 - rec.length) >= 5000) continue
      // 取 release-group/first-release 维度的 artist-credit 名作 albumArtist
      const rel = (rec.releases ?? []).find((r) => (r['artist-credit'] ?? []).some((c) => (c?.name ?? '').trim() !== ''))
      const names = (rel?.['artist-credit'] ?? []).map((c) => c?.name ?? '').filter(Boolean)
      if (!names.length) continue
      return { status: 'hit', albumArtist: names.join('、') }
    }
    return { status: 'miss' }
  } catch (err) {
    logger.debug({ err: (err as Error)?.message ?? String(err) }, '[scrape] mb fallback request failed (silent)')
    return { status: 'attempted' }
  }
}
