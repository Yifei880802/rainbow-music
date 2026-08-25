/**
 * QQ音乐排行榜适配器（#60 热门歌单首页）
 * 端点：GET c.y.qq.com/v8/fcg-bin/fcg_v8_toplist_cp.fcg?topid={id}&format=json&song_begin=0&song_num=50
 * 实测（APPLE-MUSIC-REDESIGN-PLAN 附录 A.1/A.6）：裸 fetch 无需任何请求头 code=0；
 * 单页上限 50（song_num=100 实返 50）；songlist[].data 与 musicSearch 的 TxRawItem
 * 字段同构但扁平（strMediaMid 顶层、无 file 嵌套），此处做 20 行小适配。
 */
import { httpFetch } from '../http.js'
import { formatPlayTime, sizeFormate, type MusicInfo, type MusicQualityType } from '../common.js'

export interface TxToplistInfo {
  name: string
  coverUrl: string
  updateTime: string
  total: number
}

export interface TxToplistResult {
  info: TxToplistInfo
  songs: MusicInfo[]
}

interface TxTopSongData {
  songmid: string
  songname: string
  singer?: { name?: string; mid?: string }[]
  albummid?: string
  albumname?: string
  albumid?: number | string
  interval?: number
  strMediaMid?: string
  size_128mp3?: number
  size128?: number
  size_320mp3?: number
  size320?: number
  size_flac?: number
  sizeflac?: number
  size_hires?: number
  sizehires?: number
}

interface TxToplistBody {
  code: number
  topinfo?: {
    ListName?: string
    pic_v12?: string
    pic?: string
    update_time?: string
  }
  songlist?: { data?: TxTopSongData }[]
  update_time?: string
  total_song_num?: number
}

const NUM = (v: number | undefined): number => (typeof v === 'number' ? v : 0)

export default {
  /**
   * 拉取一个 toplist（topid：26=巅峰榜·热歌 / 62=飙升榜 / 27=新歌榜）。
   * songBegin 分页偏移（+=50 翻页）；P0 首屏单页 50 首够用。
   */
  async getToplist(topid: number, songBegin = 0, songNum = 50): Promise<TxToplistResult> {
    const url = `https://c.y.qq.com/v8/fcg-bin/fcg_v8_toplist_cp.fcg?topid=${topid}&format=json&song_begin=${songBegin}&song_num=${songNum}`
    const { statusCode, body } = await httpFetch<TxToplistBody>(url).promise
    if (statusCode !== 200 || body.code !== 0) throw new Error(`获取QQ音乐榜单失败(topid=${topid})`)
    const topinfo = body.topinfo ?? {}
    const songs: MusicInfo[] = []
    for (const item of body.songlist ?? []) {
      const d = item.data
      if (!d?.songmid || !d.strMediaMid) continue
      const types: MusicQualityType[] = []
      const _types: MusicInfo['_types'] = {}
      const s128 = NUM(d.size_128mp3 ?? d.size128)
      const s320 = NUM(d.size_320mp3 ?? d.size320)
      const sflac = NUM(d.size_flac ?? d.sizeflac)
      const shires = NUM(d.size_hires ?? d.sizehires)
      if (s128 !== 0) { const size = sizeFormate(s128); types.push({ type: '128k', size }); _types['128k'] = { size } }
      if (s320 !== 0) { const size = sizeFormate(s320); types.push({ type: '320k', size }); _types['320k'] = { size } }
      if (sflac !== 0) { const size = sizeFormate(sflac); types.push({ type: 'flac', size }); _types.flac = { size } }
      if (shires !== 0) { const size = sizeFormate(shires); types.push({ type: 'flac24bit', size }); _types.flac24bit = { size } }
      const singer = (d.singer ?? []).map((s) => s.name ?? '').filter(Boolean).join('、')
      const albumId = d.albummid ?? ''
      songs.push({
        singer,
        name: d.songname,
        albumName: d.albumname ?? '',
        albumId,
        source: 'tx',
        interval: formatPlayTime(d.interval ?? 0),
        albumMid: d.albummid ?? '',
        strMediaMid: d.strMediaMid,
        songmid: d.songmid,
        // 封面构造式（与 tx/musicSearch 同款；专辑缺省回退歌手图）
        img:
          albumId === '' || albumId === '空'
            ? d.singer?.length
              ? `https://y.gtimg.cn/music/photo_new/T001R500x500M000${d.singer[0].mid}.jpg`
              : ''
            : `https://y.gtimg.cn/music/photo_new/T002R500x500M000${albumId}.jpg`,
        types,
        _types,
        typeUrl: {},
      })
    }
    return {
      info: {
        name: topinfo.ListName ?? `QQ音乐榜单 ${topid}`,
        coverUrl: topinfo.pic_v12 || topinfo.pic || '',
        updateTime: topinfo.update_time ?? body.update_time ?? '',
        total: body.total_song_num ?? songs.length,
      },
      songs,
    }
  },
}
