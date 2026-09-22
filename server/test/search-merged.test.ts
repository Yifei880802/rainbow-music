/**
 * #191 P1 搜索后端 J 单测：J1(合并去重) + J2(相关度评分) + J3(拼音/首字母)
 *
 * 运行方式：npm test（tsx --test test/*.test.ts）
 * env-sandbox 必须是第一个 import：把 RO_CONFIG / RO_DB_DIR 指向临时目录，
 * 使被测的 config.ts 深合并链落到一次性沙箱，不污染仓库 data/ 与 config.yaml。
 * 沙箱配置预置 search.platformWeights（tx=1.1）以验证 J2 平台权重乘数。
 */
import { writeSandboxConfig } from './fixtures/env-sandbox.js'
import { test, describe } from 'node:test'
import assert from 'node:assert/strict'

// 预置含 search.platformWeights 的配置（tx 加权 1.1，其余 1.0），供 J1/J2 平台权重断言
writeSandboxConfig(
  'server:\n  port: 23331\nsearch:\n  timeoutMs: 8000\n  cacheTtlMs: 300000\n  defaultLimit: 30\n  platformWeights:\n    kw: 1\n    kg: 1\n    tx: 1.1\n    wy: 1\n    mg: 0.9\n  suggestPlatforms: [wy, tx, kg]\n',
)

import type { MusicInfo, MusicQualityType } from '../src/core/adapters/common.js'
import { buildMerged, type AggregatePlatformResult, type Platform } from '../src/core/search/index.js'
import {
  textScore,
  qualityScoreOf,
  qualityRankOf,
  intervalPenalty,
  medianInterval,
  scoreTrack,
} from '../src/core/search/scoring.js'
import {
  toPinyinFull,
  toPinyinFirst,
  matchesPinyin,
  tokenize,
  tokenHitRate,
} from '../src/core/search/pinyin.js'

// ---------- 夹具工厂（MusicInfo 最小合法结构）----------

function q(...types: Array<MusicQualityType['type']>): MusicQualityType[] {
  return types.map((t) => ({ type: t, size: null }))
}

interface MkOpts {
  name: string
  singer: string
  source: Platform
  songmid: string | number
  interval?: string | 0
  albumName?: string
  types?: MusicQualityType[]
  img?: string | null
}

function mk(o: MkOpts): MusicInfo {
  return {
    name: o.name,
    singer: o.singer,
    source: o.source,
    songmid: o.songmid,
    albumName: o.albumName,
    interval: o.interval,
    img: o.img ?? null,
    types: o.types ?? q('128k'),
    _types: {},
  }
}

function plat(platform: Platform, list: MusicInfo[]): AggregatePlatformResult {
  return { platform, ok: true, total: list.length, list }
}

// ══════════════════════════ J3：拼音 / 首字母 ══════════════════════════

describe('J3: pinyin — 全拼 / 首字母 / tokenize / 命中率', () => {
  test('全拼连写：晴天→qingtian，周杰伦→zhoujielun', () => {
    assert.equal(toPinyinFull('晴天'), 'qingtian')
    assert.equal(toPinyinFull('周杰伦'), 'zhoujielun')
  })

  test('首字母连写：周杰伦→zjl，晴天→qt', () => {
    assert.equal(toPinyinFirst('周杰伦'), 'zjl')
    assert.equal(toPinyinFirst('晴天'), 'qt')
  })

  test('matchesPinyin：zjl 命中周杰伦、qingtian 命中晴天、zhoujielun 命中周杰伦', () => {
    assert.equal(matchesPinyin('周杰伦', 'zjl'), true)
    assert.equal(matchesPinyin('晴天', 'qingtian'), true)
    assert.equal(matchesPinyin('周杰伦', 'zhoujielun'), true)
  })

  test('matchesPinyin：中文原样命中 + 不相关词不误命中', () => {
    assert.equal(matchesPinyin('晴天', '晴'), true, '中文子串直接命中')
    assert.equal(matchesPinyin('晴天', 'yedian'), false, '不相关拼音不应命中')
    assert.equal(matchesPinyin('周杰伦', ''), false, '空关键词不命中')
  })

  test('tokenize：空格切分 + 中文 2-gram', () => {
    const t = tokenize('周杰伦 晴天')
    assert.ok(t.includes('周杰伦'))
    assert.ok(t.includes('周杰') && t.includes('杰伦'), '中文词展开 2-gram')
    assert.ok(t.includes('晴天'))
  })

  test('tokenHitRate：全命中=1，半命中=0.5，空 token=0', () => {
    assert.equal(tokenHitRate(tokenize('周杰伦 晴天'), ['晴天', '周杰伦']), 1)
    assert.equal(tokenHitRate(['zjl', 'nomatch'], ['周杰伦']), 0.5)
    assert.equal(tokenHitRate([], ['周杰伦']), 0)
  })
})

// ══════════════════════════ J2：相关度评分 ══════════════════════════

describe('J2: scoring — 文本/音质/时长/平台权重因子', () => {
  test('音质档位分值单调：flac24bit > flac > 320k > 128k', () => {
    assert.ok(qualityScoreOf(q('flac24bit')) > qualityScoreOf(q('flac')))
    assert.ok(qualityScoreOf(q('flac')) > qualityScoreOf(q('320k')))
    assert.ok(qualityScoreOf(q('320k')) > qualityScoreOf(q('128k')))
    assert.equal(qualityScoreOf([]), 0)
    // 取最高档
    assert.equal(qualityScoreOf(q('128k', 'flac', '320k')), qualityScoreOf(q('flac')))
    assert.equal(qualityRankOf(q('128k', 'flac24bit')), 4)
  })

  test('① 歌名精确相等 > ② 包含 > 拼音命中同级包含', () => {
    const exact = textScore('晴天', mk({ name: '晴天', singer: '周杰伦', source: 'wy', songmid: 1 }))
    const contains = textScore('晴', mk({ name: '晴天', singer: '周杰伦', source: 'wy', songmid: 1 }))
    const pinyin = textScore('qingtian', mk({ name: '晴天', singer: '周杰伦', source: 'wy', songmid: 1 }))
    const none = textScore('无关词', mk({ name: '晴天', singer: '周杰伦', source: 'wy', songmid: 1 }))
    assert.ok(exact > contains, '精确相等分值最高')
    assert.ok(contains > none)
    assert.ok(pinyin > none, '拼音全拼命中应加分')
  })

  test('③ intervalPenalty：偏差≤2s 不扣，偏差越大扣分越多，封顶 20', () => {
    assert.equal(intervalPenalty('04:00', 240), 0, '相等不扣')
    assert.equal(intervalPenalty('04:02', 240), 0, '偏差 2s 内不扣')
    assert.ok(intervalPenalty('05:00', 240) > 0, '偏差 60s 应扣分')
    assert.equal(intervalPenalty('20:00', 240), 20, '极端偏差封顶 20')
    assert.equal(intervalPenalty(0, 240), 0, '时长未知不参与惩罚')
    assert.equal(intervalPenalty('04:00', 0), 0, '无中位数不惩罚')
  })

  test('medianInterval：奇数取中位、偶数取均值、忽略未知', () => {
    assert.equal(medianInterval(['01:00', '02:00', '03:00']), 120)
    assert.equal(medianInterval(['01:00', '03:00']), 120)
    assert.equal(medianInterval(['02:00', 0, undefined]), 120, '忽略 0/未知')
    assert.equal(medianInterval([]), 0)
  })

  test('⑤ 平台权重乘数：tx(1.1) 分值高于 kw(1.0) 同曲目', () => {
    const track = mk({ name: '晴天', singer: '周杰伦', source: 'tx', songmid: 1, types: q('flac') })
    const weights = { kw: 1, tx: 1.1 }
    const sTx = scoreTrack('晴天', track, 'tx', { platformWeights: weights })
    const sKw = scoreTrack('晴天', track, 'kw', { platformWeights: weights })
    assert.ok(sTx > sKw, 'tx 权重 1.1 应放大分值')
    assert.ok(Math.abs(sTx / sKw - 1.1) < 0.01, '比值≈权重比')
  })

  test('scoreTrack 综合：音质更高者分值更高（同文本同平台）', () => {
    const lo = mk({ name: '晴天', singer: '周杰伦', source: 'wy', songmid: 1, types: q('128k') })
    const hi = mk({ name: '晴天', singer: '周杰伦', source: 'wy', songmid: 2, types: q('flac24bit') })
    assert.ok(scoreTrack('晴天', hi, 'wy') > scoreTrack('晴天', lo, 'wy'))
  })
})

// ══════════════════════════ J1：合并去重 ══════════════════════════

describe('J1: buildMerged — 跨平台去重 + sources[] + 辅键 interval', () => {
  test('同名同歌手同时长跨平台 → 合并为 1 条，sources 含 2 平台，音质并集', () => {
    const results = [
      plat('kw', [mk({ name: '晴天', singer: '周杰伦', source: 'kw', songmid: 'k1', interval: '04:29', types: q('128k', '320k') })]),
      plat('tx', [mk({ name: '晴天', singer: '周杰伦', source: 'tx', songmid: 't1', interval: '04:29', types: q('flac') })]),
    ]
    const merged = buildMerged('晴天', results)
    assert.equal(merged.length, 1, '应合并为一条')
    assert.equal(merged[0]!.sources.length, 2, '挂两个来源')
    const platforms = merged[0]!.sources.map((s) => s.platform).sort()
    assert.deepEqual(platforms, ['kw', 'tx'])
    // 音质并集按档位降序
    assert.deepEqual(merged[0]!.qualities, ['flac', '320k', '128k'])
    // songmid 与 songInfo 保留
    const kwSrc = merged[0]!.sources.find((s) => s.platform === 'kw')!
    assert.equal(kwSrc.songmid, 'k1')
    assert.equal(kwSrc.songInfo.name, '晴天')
  })

  test('多歌手顺序不同（sortSingle 归一化）→ 视为同一曲目合并', () => {
    const results = [
      plat('kw', [mk({ name: '千里之外', singer: '周杰伦、费玉清', source: 'kw', songmid: 'k1', interval: '04:16' })]),
      plat('wy', [mk({ name: '千里之外', singer: '费玉清、周杰伦', source: 'wy', songmid: 'w1', interval: '04:16' })]),
    ]
    const merged = buildMerged('千里之外', results)
    assert.equal(merged.length, 1, '歌手顺序差异应被 sortSingle 消除后合并')
    assert.equal(merged[0]!.sources.length, 2)
  })

  test('辅键 interval±5s：时长差>5s → 拆成两条（不同版本不误合并）', () => {
    const results = [
      plat('kw', [mk({ name: '晴天', singer: '周杰伦', source: 'kw', songmid: 'k1', interval: '04:29' })]),
      plat('wy', [mk({ name: '晴天', singer: '周杰伦', source: 'wy', songmid: 'w1', interval: '06:30' })]),
    ]
    const merged = buildMerged('晴天', results)
    assert.equal(merged.length, 2, '时长差过大应拆为两条')
  })

  test('辅键 interval±5s：时长差≤5s → 合并（上游时长抖动容错）', () => {
    const results = [
      plat('kw', [mk({ name: '晴天', singer: '周杰伦', source: 'kw', songmid: 'k1', interval: '04:29' })]),
      plat('wy', [mk({ name: '晴天', singer: '周杰伦', source: 'wy', songmid: 'w1', interval: '04:31' })]),
    ]
    const merged = buildMerged('晴天', results)
    assert.equal(merged.length, 1, '2s 抖动应合并')
  })

  test('不同歌手 → 不合并（主键含 singer）', () => {
    const results = [
      plat('kw', [mk({ name: '晴天', singer: '周杰伦', source: 'kw', songmid: 'k1', interval: '04:29' })]),
      plat('wy', [mk({ name: '晴天', singer: '某翻唱歌手', source: 'wy', songmid: 'w1', interval: '04:29' })]),
    ]
    const merged = buildMerged('晴天', results)
    assert.equal(merged.length, 2)
  })

  test('失败平台(ok:false)被忽略，不产生来源', () => {
    const results: AggregatePlatformResult[] = [
      plat('kw', [mk({ name: '晴天', singer: '周杰伦', source: 'kw', songmid: 'k1', interval: '04:29' })]),
      { platform: 'mg', ok: false, total: 0, list: [], error: 'timeout' },
    ]
    const merged = buildMerged('晴天', results)
    assert.equal(merged.length, 1)
    assert.equal(merged[0]!.sources.length, 1)
    assert.equal(merged[0]!.sources[0]!.platform, 'kw')
  })

  test('结果按相关度评分降序：精确命中排在不相关前', () => {
    const results = [
      plat('kw', [
        mk({ name: '无关歌曲', singer: '路人', source: 'kw', songmid: 'k1', interval: '03:00', types: q('128k') }),
        mk({ name: '晴天', singer: '周杰伦', source: 'kw', songmid: 'k2', interval: '04:29', types: q('flac') }),
      ]),
    ]
    const merged = buildMerged('晴天', results)
    assert.equal(merged.length, 2)
    assert.equal(merged[0]!.name, '晴天', '精确命中且音质高者排首')
    assert.ok(merged[0]!.score >= merged[1]!.score, '分值降序')
  })

  test('MergedTrack 结构完整：含 name/singer/albumName/img/interval/qualities/sources/score', () => {
    const results = [
      plat('tx', [mk({ name: '晴天', singer: '周杰伦', source: 'tx', songmid: 't1', interval: '04:29', albumName: '叶惠美', img: 'http://x/1.jpg', types: q('flac') })]),
    ]
    const m = buildMerged('晴天', results)[0]!
    assert.equal(m.name, '晴天')
    assert.equal(m.singer, '周杰伦')
    assert.equal(m.albumName, '叶惠美')
    assert.equal(m.img, 'http://x/1.jpg')
    assert.equal(m.interval, '04:29')
    assert.deepEqual(m.qualities, ['flac'])
    assert.equal(m.sources.length, 1)
    assert.equal(typeof m.score, 'number')
    assert.ok(m.score > 0)
  })
})
