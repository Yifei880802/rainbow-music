/**
 * #45 刮削探测脚本（一次性工具，跑完结论回写设计文档附录）
 *
 * 目的：按 AUTO-SCRAPE-DESIGN.md §5 风险 #1，实现前先逐一验证五平台
 * 「按 songmid 查歌曲详情」的候选接口与字段覆盖，冻结字段映射表。
 *
 * 运行：cd server && npx tsx scripts/probe-scrape.mjs
 * 内容：
 *   1. 五平台搜索「晴天」各取样本 songmid/hash/copyrightId
 *   2. 逐平台试调详情候选接口，dump 关键字段（年份/曲目号/流派/专辑艺术家/碟号）
 *   3. 对 data/downloads 现有 MP3/FLAC 读现有标签，验证 read-merge-write 的 buffer 往返形状
 */
import NodeID3 from 'node-id3'
import { readFlacTags } from 'flac-tagger'
import { searchService } from '../src/core/search/index.ts'
import { eapi } from '../src/core/adapters/wy/crypto.ts'
import { zzcSign } from '../src/core/adapters/tx/crypto.ts'
import { httpFetch } from '../src/core/adapters/http.ts'
import { createSignature } from '../src/core/adapters/mg/musicSearch.ts'

const KEYWORD = process.argv[2] ?? '晴天'
const TIMEOUT = 8000
const hr = (t) => console.log('\n' + '='.repeat(72) + '\n' + t + '\n' + '='.repeat(72))

/** 深度截断 dump：只保留标量/一层对象形状，避免刷屏 */
function brief(obj, depth = 0) {
  if (obj === null || obj === undefined) return obj
  if (typeof obj !== 'object') return typeof obj === 'string' && obj.length > 80 ? obj.slice(0, 80) + '…' : obj
  if (Buffer.isBuffer(obj)) return `<Buffer ${obj.length}b>`
  if (Array.isArray(obj)) return obj.length > 3 ? obj.slice(0, 3).map((v) => brief(v, depth + 1)).concat([`…(${obj.length})`]) : obj.map((v) => brief(v, depth + 1))
  const out = {}
  for (const [k, v] of Object.entries(obj)) {
    out[k] = depth >= 2 ? (typeof v === 'object' && v !== null ? (Array.isArray(v) ? `[array ${v.length}]` : '{obj}') : brief(v, depth + 1)) : brief(v, depth + 1)
  }
  return out
}

// ── 1. 各平台搜索拿样本 ──────────────────────────────────────────
hr(`[1] 搜索样本：keyword="${KEYWORD}"`)
const samples = {}
for (const p of ['kw', 'kg', 'tx', 'wy', 'mg']) {
  try {
    const r = await searchService.searchPlatform(p, KEYWORD, 1, 5)
    const first = r.list.find((x) => x.albumName && x.albumName !== '')
    samples[p] = first ?? r.list[0]
    console.log(`  ${p}: songmid=${samples[p].songmid} name=${samples[p].name} album=${samples[p].albumName} hash=${samples[p].hash ?? '-'} copyrightId=${samples[p].copyrightId ?? '-'} albumId=${samples[p].albumId ?? '-'}`)
  } catch (err) {
    console.log(`  ${p}: SEARCH FAILED: ${err.message}`)
  }
}

// ── 2. wy：eapi /api/v3/song/detail ──────────────────────────────
hr('[2] wy eapi song/detail（post /eapi/song/detail）')
try {
  const s = samples.wy
  const form = eapi('/api/v3/song/detail', { c: JSON.stringify([{ id: Number(s.songmid) }]), ids: `[${Number(s.songmid)}]` })
  const { body } = await httpFetch('https://interface3.music.163.com/eapi/song/detail', {
    method: 'post',
    headers: { 'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/60.0.3112.90 Safari/537.36', origin: 'https://music.163.com' },
    form,
    timeout: TIMEOUT,
  }).promise
  const song = body?.songs?.[0]
  console.log('  code:', body?.code, '| keys:', song ? Object.keys(song).join(',') : '(no songs)')
  if (song) console.log('  song 摘要:', JSON.stringify(brief({ name: song.name, ar: song.ar, al: song.al, dt: song.dt, publishTime: song.publishTime, cd: song.cd, no: song.no, t: song.t, rt: song.rt }, 1), null, 1))
} catch (err) {
  console.log('  FAILED:', err.message)
}

// ── 3. tx：signRequest get_song_detail ───────────────────────────
hr('[3] tx signRequest music.pf_song_detail_svr/get_song_detail')
try {
  const s = samples.tx
  const payload = {
    comm: { ct: 24, cv: 0 },
    req: { module: 'music.pf_song_detail_svr', method: 'get_song_detail', param: { song_mid: String(s.songmid), enc_type: 'utf8' } },
  }
  const raw = JSON.stringify(payload)
  const sign = zzcSign(raw)
  const { body } = await httpFetch(`https://u.y.qq.com/cgi-bin/musics.fcg?sign=${sign}`, {
    method: 'post',
    headers: { 'User-Agent': 'QQMusic 14090508(android 12)', 'Content-Type': 'application/json' },
    body: raw,
    timeout: TIMEOUT,
  }).promise
  const track = body?.req?.data?.track_info
  console.log('  code:', body?.code, 'req.code:', body?.req?.code, '| track keys:', track ? Object.keys(track).join(',') : '(none)')
  if (track) console.log('  track 摘要:', JSON.stringify(brief({ name: track.name, singer: track.singer, album: track.album, interval: track.interval, track_number: track.track_number, disc: track.disc, genre: track.genre, pubtime: track.pubtime, action: track.action }, 1), null, 1))
} catch (err) {
  console.log('  FAILED:', err.message)
}

// ── 4. kg：get_res_privilege 完整响应 + 搜索原始字段 ─────────────
hr('[4] kg get_res_privilege（完整 info 字段盘点）')
try {
  const s = samples.kg
  const songmid = String(s.songmid)
  const albumAudioId = songmid.length === 32 ? undefined : songmid
  const body = {
    appid: 1001, area_code: '1', behavior: 'play', clientver: '9020', need_hash_offset: 1, relate: 1,
    resource: [{ album_audio_id: albumAudioId, album_id: s.albumId, hash: s.hash, id: 0, name: `${s.singer} - ${s.name}.mp3`, type: 'audio' }],
    token: '', userid: 2626431536, vip: 1,
  }
  const { body: resp } = await httpFetch('http://media.store.kugou.com/v1/get_res_privilege', {
    method: 'post', headers: { 'KG-RC': '1', 'KG-THash': 'expand_search_manager.cpp:852736169:451', 'User-Agent': 'KuGou2012-9020-ExpandSearchManager' }, body, timeout: TIMEOUT,
  }).promise
  const info = resp?.data?.[0]?.info
  console.log('  error_code:', resp?.error_code, '| info keys:', info ? Object.keys(info).join(',') : '(none)')
  if (info) console.log('  info 摘要:', JSON.stringify(brief(info, 1), null, 1))
} catch (err) {
  console.log('  FAILED:', err.message)
}
console.log('  -- kg 搜索原始响应字段（song_search_v2 lists[0]）--')
try {
  const url = `https://songsearch.kugou.com/song_search_v2?keyword=${encodeURIComponent(KEYWORD)}&page=1&pagesize=2&userid=0&clientver=&platform=WebFilter&filter=2&iscorrection=1&privilege_filter=0&area_code=1`
  const { body } = await httpFetch(url, { timeout: TIMEOUT }).promise
  console.log('  lists[0]:', JSON.stringify(brief(body?.data?.lists?.[0], 1), null, 1))
} catch (err) {
  console.log('  FAILED:', err.message)
}

// ── 5. kw：候选详情接口 ─────────────────────────────────────────
hr('[5] kw 候选详情接口')
const kwMid = String(samples.kw?.songmid ?? '')
const kwCandidates = [
  ['m.kuwo.cn/newh5/singlesong/info', `http://m.kuwo.cn/newh5/singlesong/info?mid=${kwMid}`],
  ['kuwo.cn/api/www/music/musicInfo', `https://kuwo.cn/api/www/music/musicInfo?mid=${kwMid}&httpsStatus=1`],
  ['mobi.kuwo.cn/mobi.s f=web type=info', `http://mobi.kuwo.cn/mobi.s?f=web&type=info&mid=${kwMid}`],
]
for (const [name, url] of kwCandidates) {
  try {
    const { statusCode, body } = await httpFetch(url, {
      headers: { 'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36', Referer: 'https://m.kuwo.cn/', csrf: kwMid, cookie: `kw_token=${kwMid}` },
      timeout: TIMEOUT,
    }).promise
    console.log(`  ${name} → HTTP ${statusCode}`)
    console.log('   ', JSON.stringify(brief(body, 1)).slice(0, 900))
  } catch (err) {
    console.log(`  ${name} → FAILED: ${err.message}`)
  }
}

// ── 6. mg：候选详情接口 + 搜索原始字段 ──────────────────────────
hr('[6] mg 候选详情接口')
const mgCid = String(samples.mg?.copyrightId ?? '')
const mgCandidates = [
  ['c.musicapp.migu.cn resourceinfo', `https://c.musicapp.migu.cn/MIGUM2.0/v1.0/content/resourceinfo.do?copyrightId=${mgCid}&resourceType=2`],
]
for (const [name, url] of mgCandidates) {
  try {
    const { statusCode, body } = await httpFetch(url, {
      headers: { 'User-Agent': 'Mozilla/5.0 (Linux; U; Android 11.0.0; zh-cn; MI 11) AppleWebKit/534.30 (KHTML, like Gecko) Version/4.0 Mobile Safari/534.30', channel: '0146921', ua: 'Android_migu', version: '5.0.1' },
      timeout: TIMEOUT,
    }).promise
    console.log(`  ${name} → HTTP ${statusCode}`)
    console.log('   ', JSON.stringify(brief(body, 1)).slice(0, 900))
  } catch (err) {
    console.log(`  ${name} → FAILED: ${err.message}`)
  }
}
console.log('  -- mg 搜索原始响应字段（resultList[0][0]）--')
try {
  const time = Date.now().toString()
  const signData = createSignature(time, KEYWORD)
  const url = `https://jadeite.migu.cn/music_search/v3/search/searchAll?isCorrect=0&isCopyright=1&searchSwitch=%7B%22song%22%3A1%2C%22album%22%3A0%2C%22singer%22%3A0%2C%22tagSong%22%3A1%2C%22mvSong%22%3A0%2C%22bestShow%22%3A1%2C%22songlist%22%3A0%2C%22lyricSong%22%3A0%7D&pageSize=2&text=${encodeURIComponent(KEYWORD)}&pageNo=1&sort=0&sid=USS`
  const { body } = await httpFetch(url, { headers: { uiVersion: 'A_music_3.6.1', deviceId: signData.deviceId, timestamp: time, sign: signData.sign, channel: '0146921', 'User-Agent': 'Mozilla/5.0 (Linux; U; Android 11.0.0; zh-cn; MI 11)' }, timeout: TIMEOUT }).promise
  console.log('  resultList[0][0]:', JSON.stringify(brief(body?.songResultData?.resultList?.[0]?.[0], 1), null, 1))
} catch (err) {
  console.log('  FAILED:', err.message)
}

// ── 7. 标签读回形状（read-merge-write 的 buffer 往返） ───────────
hr('[7] 现有文件标签形状（node-id3 read / flac-tagger readFlacTags）')
import fs from 'node:fs'
import path from 'node:path'
const DL = path.resolve(import.meta.dirname, '../../data/downloads')
const files = fs.readdirSync(DL)
const mp3 = files.find((f) => f.endsWith('.mp3'))
const flac = files.find((f) => f.endsWith('.flac'))
if (mp3) {
  try {
    const tags = NodeID3.read(path.join(DL, mp3))
    const img = tags.image
    console.log(`  MP3 "${mp3}"`)
    console.log('    title/artist/album:', JSON.stringify({ title: tags.title, artist: tags.artist, album: tags.album }))
    console.log('    image 形状:', img ? JSON.stringify({ mime: img.mime, type: img.type, description: img.description, imageBufferShape: img.imageBuffer?.constructor?.name ?? typeof img.imageBuffer, imageBufferIsBuffer: Buffer.isBuffer(img.imageBuffer), bufLen: img.imageBuffer?.length }) : 'none')
    console.log('    全部 frame keys:', Object.keys(tags).join(','))
  } catch (err) {
    console.log('  MP3 read FAILED:', err.message)
  }
}
if (flac) {
  try {
    const tags = await readFlacTags(path.join(DL, flac))
    console.log(`  FLAC "${flac}"`)
    console.log('    tagMap keys:', Object.keys(tags.tagMap).join(','))
    console.log('    tagMap 标量值:', JSON.stringify(brief(tags.tagMap, 1), null, 1))
    const pic = tags.picture
    console.log('    picture 形状:', pic ? JSON.stringify({ pictureType: pic.pictureType, mime: pic.mime, description: pic.description, bufferLen: pic.buffer?.length }) : 'none')
  } catch (err) {
    console.log('  FLAC read FAILED:', err.message)
  }
}
console.log('\nprobe done.')
