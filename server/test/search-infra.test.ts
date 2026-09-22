/**
 * P0 搜索基础设施单测：D1(历史封顶/去重置顶)、D2(联想复合 key 去重)、D4(聚合缓存/in-flight)
 *
 * 运行方式：npm test（tsx --test test/*.test.ts）
 * env-sandbox 必须是第一个 import：把 RO_CONFIG / RO_DB_DIR 指向临时目录，
 * 使 D1 的 searchHistoryStore 落到一次性 SQLite，不污染仓库 data/。
 */
import { SANDBOX_ROOT, writeSandboxConfig } from './fixtures/env-sandbox.js'
import { test, describe, before, after } from 'node:test'
import assert from 'node:assert/strict'

// 预置含 search 段的最小配置（config.ts 深合并默认值；search 三字段与代码默认一致）
writeSandboxConfig('server:\n  port: 23331\nsearch:\n  timeoutMs: 8000\n  cacheTtlMs: 300000\n  defaultLimit: 30\n')

// ── D1: 搜索历史封顶 200/uid + 去重置顶 ─────────────────────────────────────

describe('D1: searchHistoryStore — 封顶 200/uid + 去重置顶 + uid 隔离', () => {
  let store: typeof import('../src/core/db/searchHistory.js').searchHistoryStore
  let KEEP: number

  before(async () => {
    const mod = await import('../src/core/db/searchHistory.js')
    store = mod.searchHistoryStore
    KEEP = mod.SEARCH_HISTORY_KEEP
    // 初始化 DB（建表）
    const { initDb } = await import('../src/core/db/index.js')
    initDb()
  })

  test('SEARCH_HISTORY_KEEP 常量为 200', () => {
    assert.equal(KEEP, 200)
  })

  test('写入超过上限后每 uid 封顶 200 条', () => {
    const uid = 'u-cap-' + Date.now()
    // 写 250 条不同关键词（去重键 = (uid,kw)，故需各异）
    for (let i = 0; i < 250; i++) {
      store.add(uid, `kw-${i}`, '', '')
    }
    const rows = store.list(uid, 250)
    assert.equal(rows.length, KEEP, `应封顶 ${KEEP} 条，实际 ${rows.length}`)
    // 保留的应是最近写入的 200 条（kw-50..kw-249），最旧的 kw-0..kw-49 被修剪
    const kws = new Set(rows.map((r) => r.kw))
    assert.ok(!kws.has('kw-0'), '最旧的 kw-0 应被修剪')
    assert.ok(!kws.has('kw-49'), '最旧的 kw-49 应被修剪')
    assert.ok(kws.has('kw-249'), '最新的 kw-249 应保留')
    assert.ok(kws.has('kw-50'), '边界 kw-50 应保留')
  })

  test('去重置顶：重复 (uid,kw) 不新增行，仅刷新 ts 保留原 id', () => {
    const uid = 'u-dedup-' + Date.now()
    const r1 = store.add(uid, 'foo', 'song', 'kw')
    const r2 = store.add(uid, 'bar', '', '')
    assert.equal(store.list(uid, 10).length, 2)

    // 再次写 foo（去重键相同）→ 保留原 id，不新增行
    const r1again = store.add(uid, 'foo', 'song', 'tx')
    assert.equal(r1again.id, r1.id, '去重应保留原 id')
    assert.equal(store.list(uid, 10).length, 2, '去重后总行数不变')

    // 置顶：foo 的 ts 刷新为最新 → list(ts DESC) 中 foo 排第一
    const top = store.list(uid, 10)
    assert.equal(top[0]!.kw, 'foo', 'foo 应被置顶')
    assert.equal(top[1]!.kw, 'bar')
    assert.ok(r1again.ts >= r2.ts, 'foo 刷新后的 ts 应不早于 bar')
    // platform 更新为最近一次上下文
    assert.equal(top[0]!.platform, 'tx')
  })

  test('trim 归一化：首尾空格视为同一关键词', () => {
    const uid = 'u-trim-' + Date.now()
    const a = store.add(uid, '  晴天  ', '', '')
    const b = store.add(uid, '晴天', '', '')
    assert.equal(a.id, b.id, 'trim 后同关键词应去重')
    assert.equal(b.kw, '晴天', '存储应为 trim 后的值')
  })

  test('uid 隔离：不同 uid 各自封顶互不影响', () => {
    const ua = 'u-iso-a-' + Date.now()
    const ub = 'u-iso-b-' + Date.now()
    for (let i = 0; i < 5; i++) store.add(ua, `a-${i}`, '', '')
    for (let i = 0; i < 3; i++) store.add(ub, `b-${i}`, '', '')
    assert.equal(store.list(ua, 100).length, 5)
    assert.equal(store.list(ub, 100).length, 3)
  })

  test('clear 清空某 uid 全部历史，返回删除行数', () => {
    const uid = 'u-clear-' + Date.now()
    store.add(uid, 'x1', '', '')
    store.add(uid, 'x2', '', '')
    const removed = store.clear(uid)
    assert.equal(removed, 2)
    assert.equal(store.list(uid, 100).length, 0)
  })

  test('globalTop 按窗口聚合频次倒序（D3 热搜底座）', () => {
    const tag = 'gt-' + Date.now()
    // 三个不同 uid 各搜 hot，两个搜 warm → 全局 hot 频次更高
    for (let i = 0; i < 3; i++) store.add(`${tag}-u${i}`, `${tag}-hot`, '', '')
    for (let i = 0; i < 2; i++) store.add(`${tag}-u${i}`, `${tag}-warm`, '', '')
    const since = Date.now() - 60_000
    const top = store.globalTop(since, 10)
    const hotRow = top.find((r) => r.kw === `${tag}-hot`)
    const warmRow = top.find((r) => r.kw === `${tag}-warm`)
    assert.ok(hotRow && warmRow, '两个关键词都应出现在聚合结果')
    assert.equal(hotRow!.count, 3)
    assert.equal(warmRow!.count, 2)
    // hot 频次高应排在 warm 前
    assert.ok(top.indexOf(hotRow!) < top.indexOf(warmRow!), 'hot 应排在 warm 之前')
  })
})

// ── D2: 联想 mergeSuggest 复合 key 去重 ──────────────────────────────────────

describe('D2: mergeSuggest — (text,singer) 复合 key 去重 + 匹配 + 优先级', () => {
  let mergeSuggest: typeof import('../src/core/search/suggest.js').mergeSuggest

  before(async () => {
    const mod = await import('../src/core/search/suggest.js')
    mergeSuggest = mod.mergeSuggest
  })

  test('完全相同 (text,singer) 跨源去重为一条，保留首个 type', () => {
    const items = mergeSuggest('晴天', [
      { text: '晴天', singer: '周杰伦', type: 'history' },
      { text: '晴天', singer: '周杰伦', type: 'title' },
    ], 10)
    assert.equal(items.length, 1)
    assert.equal(items[0]!.type, 'history', '应保留优先级最高（首个）的 type')
    assert.equal(items[0]!.singer, '周杰伦')
  })

  test('同名不同歌手 → 复合 key 不同 → 各自保留（修复按 name 去重忽略歌手）', () => {
    const items = mergeSuggest('晴天', [
      { text: '晴天', singer: '周杰伦', type: 'title' },
      { text: '晴天', singer: '翻唱歌手', type: 'title' },
    ], 10)
    assert.equal(items.length, 2, '同名不同歌手应保留为两条')
    const singers = items.map((i) => i.singer).sort()
    assert.deepEqual(singers, ['周杰伦', '翻唱歌手'].sort())
  })

  test('多歌手顺序差异归一化为同一 key（A、B == B、A）', () => {
    const items = mergeSuggest('合作', [
      { text: '合作曲', singer: '甲、乙', type: 'title' },
      { text: '合作曲', singer: '乙、甲', type: 'title' },
    ], 10)
    assert.equal(items.length, 1, '歌手顺序不同应视为同一首去重')
  })

  test('标点/空格/大小写归一化后去重', () => {
    const items = mergeSuggest('hello', [
      { text: 'Hello World', singer: 'A', type: 'title' },
      { text: 'hello  world!', singer: 'a', type: 'history' },
    ], 10)
    assert.equal(items.length, 1, '归一化后应去重')
  })

  test('匹配过滤：仅保留 text 含 q 的候选（子串，归一化）', () => {
    const items = mergeSuggest('晴', [
      { text: '晴天', type: 'hot' },
      { text: '七里香', type: 'hot' },
      { text: '阴晴不定', type: 'title' },
    ], 10)
    const texts = items.map((i) => i.text)
    assert.ok(texts.includes('晴天'))
    assert.ok(texts.includes('阴晴不定'))
    assert.ok(!texts.includes('七里香'), '不含 q 的应被过滤')
  })

  test('limit 截断：最多返回 limit 条', () => {
    const cands = Array.from({ length: 20 }, (_, i) => ({ text: `歌曲${i}`, type: 'title' as const }))
    const items = mergeSuggest('歌曲', cands, 5)
    assert.equal(items.length, 5)
  })

  test('无 singer 的历史词与有 singer 的标题为不同 key（不互相吞并）', () => {
    const items = mergeSuggest('晴天', [
      { text: '晴天', type: 'history' },           // singer 缺省 → key 晴天|
      { text: '晴天', singer: '周杰伦', type: 'title' }, // key 晴天|周杰伦
    ], 10)
    assert.equal(items.length, 2)
  })

  test('空 text 候选被忽略', () => {
    const items = mergeSuggest('晴', [
      { text: '   ', type: 'hot' },
      { text: '', type: 'title' },
      { text: '晴天', type: 'hot' },
    ], 10)
    assert.equal(items.length, 1)
    assert.equal(items[0]!.text, '晴天')
  })
})

// ── D4: 聚合缓存命中 + in-flight 去重 ────────────────────────────────────────

describe('D4: searchAggregate — 5min 缓存命中 + in-flight 并发去重', () => {
  // 通过替换 kw 适配器单例的 search 方法计数（ADAPTERS.kw 与该默认导出为同一对象引用），
  // 无需真实网络即可验证缓存/去重。用后恢复，避免污染其它测试。
  let searchService: typeof import('../src/core/search/index.js').searchService
  let kwAdapter: typeof import('../src/core/adapters/kw/musicSearch.js').default
  let originalSearch: typeof kwAdapter.search
  let callCount = 0

  before(async () => {
    const searchMod = await import('../src/core/search/index.js')
    searchService = searchMod.searchService
    const kwMod = await import('../src/core/adapters/kw/musicSearch.js')
    kwAdapter = kwMod.default
    originalSearch = kwAdapter.search
    kwAdapter.search = (async (str: string, page = 1, limit?: number) => {
      callCount++
      return { list: [], allPage: 1, total: 0, limit: limit ?? 30, source: 'kw' }
    }) as typeof kwAdapter.search
  })

  after(() => {
    kwAdapter.search = originalSearch
  })

  test('缓存命中：同 (keyword,page,platforms,limit) 二次调用不再触达适配器', async () => {
    callCount = 0
    const kw1 = `cache-${Date.now()}`
    const r1 = await searchService.searchAggregate(kw1, 1, ['kw'])
    const r2 = await searchService.searchAggregate(kw1, 1, ['kw'])
    assert.equal(callCount, 1, '第二次应命中缓存，适配器只被调用一次')
    assert.equal(r1, r2, '缓存命中应返回同一结果对象引用')
    assert.equal(r2.keyword, kw1)
  })

  test('in-flight 去重：并发同 key 调用共享一次抓取', async () => {
    callCount = 0
    const kw2 = `inflight-${Date.now()}`
    // 同步发起两个请求（都不先 await）→ 第二个应复用第一个的 in-flight promise
    const [a, b] = await Promise.all([
      searchService.searchAggregate(kw2, 1, ['kw']),
      searchService.searchAggregate(kw2, 1, ['kw']),
    ])
    assert.equal(callCount, 1, '并发去重后适配器只被调用一次')
    assert.equal(a, b, '并发调用应返回同一结果')
  })

  test('不同 keyword 各自独立抓取（缓存 key 隔离）', async () => {
    callCount = 0
    const base = `iso-${Date.now()}`
    await searchService.searchAggregate(`${base}-a`, 1, ['kw'])
    await searchService.searchAggregate(`${base}-b`, 1, ['kw'])
    assert.equal(callCount, 2, '不同关键词应各自触达适配器')
  })

  test('in-flight 完成后释放：缓存过期语义外再次调用走缓存而非重复抓取', async () => {
    callCount = 0
    const kw3 = `release-${Date.now()}`
    await searchService.searchAggregate(kw3, 1, ['kw'])
    assert.equal(callCount, 1)
    // in-flight 已释放且结果已入缓存 → 再调仍命中缓存
    await searchService.searchAggregate(kw3, 1, ['kw'])
    assert.equal(callCount, 1, 'in-flight 释放后应由缓存兜住，不重复抓取')
  })
})

// ── SANDBOX_ROOT 引用（保留 import 语义，避免未使用告警；同时确认沙箱已建）──
describe('sandbox sanity', () => {
  test('SANDBOX_ROOT 为临时目录', () => {
    assert.ok(typeof SANDBOX_ROOT === 'string' && SANDBOX_ROOT.length > 0)
  })
})
