/**
 * 酷狗排行榜适配器（#60 热门歌单首页）
 * 端点：GET m.kugou.com/rank/info/?rankid={id}&page={p}&json=true（移动端 UA）
 * 实测（APPLE-MUSIC-REDESIGN-PLAN 附录 A.1/A.6）：30 首/页；info 含
 * rankname/img_cover({size}→480)/intro/rank_id_publish_date；songs.list[]
 * 含 audio_id/hash/album_sizable_cover；榜单响应无音质档位 → 复用
 * kg/songList.ts 的 fetchAudioInfos gateway 批量补齐（每 100 hash 一批）。
 */
import { httpFetch } from '../http.js'
import type { MusicInfo } from '../common.js'
import { fetchAudioInfos, filterData2, type KgHashItem, type KgGatewaySong } from './songList.js'

export interface KgToplistInfo {
  name: string
  coverUrl: string
  updateTime: string
  total: number
  description: string
}

export interface KgToplistResult {
  info: KgToplistInfo
  songs: MusicInfo[]
}

interface KgRankSong {
  songname?: string
  h5_author_name?: string
  authors?: { author_name?: string }[]
  album_sizable_cover?: string
  album_id?: string | number
  hash?: string
  audio_id?: string | number
  duration?: number
  filename?: string
}

interface KgRankInfoBody {
  status?: number
  info?: {
    rankname?: string
    img_cover?: string
    bannerurl?: string
    /** #66 P0-1：榜单列表系接口的备用封面模板（mcommon/{size} 形态，部分榜 img_cover/bannerurl 双空时可用） */
    img_9?: string
    banner_9?: string
    intro?: string
    rank_id_publish_date?: string
    rankid?: number
  }
  songs?: { total?: number; page?: number; pagesize?: number; list?: KgRankSong[] }
}

const MOBILE_UA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Mobile/15E148 Safari/604.1'

/** {size} 占位替换（榜单封面 480 档 / 歌曲封面 240 档） */
const sizedCover = (tpl: string | undefined, size: number): string | null => {
  if (!tpl) return null
  return tpl.replace('{size}', String(size))
}

/** #66 P0-1：取第一个非空串（上游对部分榜返回 img_cover="" 空串，?? 只判 null/undefined 不吃空串） */
const firstNonEmpty = (...vals: Array<string | undefined>): string | undefined =>
  vals.find((v) => typeof v === 'string' && v.trim() !== '')

export default {
  /**
   * 拉取一个酷狗榜单（rankid：8888=TOP500 / 6666=飙升榜 / 82831=网络热歌榜…）。
   * page 翻页（30 首/页）；P0 首屏单页即够。
   */
  async getToplist(rankid: number, page = 1): Promise<KgToplistResult> {
    const url = `http://m.kugou.com/rank/info/?rankid=${rankid}&page=${page}&json=true`
    const { statusCode, body } = await httpFetch<KgRankInfoBody>(url, {
      headers: { 'User-Agent': MOBILE_UA },
    }).promise
    if (statusCode !== 200 || !body?.songs?.list) throw new Error(`获取酷狗榜单失败(rankid=${rankid})`)
    const rawSongs = body.songs.list ?? []
    // hash → gateway 批量补齐音质档（与 kg/songList.getListDetail 同款链路）
    const hashes: KgHashItem[] = rawSongs.filter((s) => s.hash).map((s) => ({ hash: s.hash! }))
    let gatewaySongs: KgGatewaySong[] = []
    if (hashes.length) gatewaySongs = await fetchAudioInfos(hashes)
    // gateway 返回按 hash 顺序；榜单原序 = gateway 序（同批请求），直接转换
    const songs = filterData2(gatewaySongs)
    // 榜单级专辑封面回填（gateway 链路 img 恒 null；240 档性价比高，A.5 实测全 200）
    const coverByHash = new Map<string, string | null>()
    rawSongs.forEach((s) => {
      if (s.hash) coverByHash.set(s.hash, sizedCover(s.album_sizable_cover, 240))
    })
    for (const s of songs) {
      if (!s.img && s.hash) s.img = coverByHash.get(s.hash) ?? null
    }
    const info = body.info ?? {}
    const publish = info.rank_id_publish_date ?? ''
    return {
      info: {
        name: info.rankname ?? `酷狗榜单 ${rankid}`,
        // #66 P0-1：封面非空串优先级链（飙升/欧美 img_cover=""、新歌四链双空但 img_9/banner_9 可用，
        // 依 PLAYLIST-EXPANSION-RESEARCH §2.1 实测：修复后 kg 五榜卡封面全覆盖）
        coverUrl:
          sizedCover(
            firstNonEmpty(info.img_cover, info.bannerurl, info.img_9, info.banner_9),
            480,
          ) ?? '',
        // "2026-08-21 08:30:00" → 日期部分（今日更新徽标比对用）
        updateTime: publish.slice(0, 10),
        total: body.songs.total ?? songs.length,
        description: info.intro ?? '',
      },
      songs,
    }
  },
}
