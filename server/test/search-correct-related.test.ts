/**
 * P2 搜索高阶单测（#200）：O4 错字容错 + O5 相关推荐（共现/冷启动回退）
 *
 * 运行方式：npm test（tsx --test test/*.test.ts）
 * env-sandbox 必须是第一个 import：把 RO_CONFIG / RO_DB_DIR 指向临时目录，
 * 使 searchHistoryStore / searchCoocStore 落到一次性 SQLite，不污染仓库 data/。
 */
import { writeSandboxConfig } from './fixtures/env-sandbox.js'
import { test, describe, before } from 'node:test'
import assert from 'node:assert/strict'

// 预置含 search 段的最小配置（三新字段与代码默认一致；relatedEnabled 默认 true）
writeSandboxConfig(
  'server:\n  port: 23332\nsearch:\n  timeoutMs: 8000\n  cacheTtlMs: 300000\n  defaultLimit: 30\n  correctEnabled: true\n  correctMinResults: 3\n  relatedEnabled: true\n',
)

import { config } from '../src/core/config.js'
import { initDb } from '../src/core/db/index.js'
import { searchHistoryStore, searchCoocStore } from '../src/core/db/searchHistory.js'
import { editDistanceWithin, correctKeyword, clearCorrectDictCache } from '../src/core/search/correct.js'
import { related } from '../src/core/search/suggest.js'

/** 生成唯一 uid，隔离各用例的历史/共现数据 */
let seq = 0
function uid(tag: string): string {
  return `u-${tag}-${Date.now()}-${seq++}`
}

before(() => {
  initDb()
})

// ── O4-a: editDistanceWithin 纯函数（编辑距离 ≤ max 判定 + 剪枝）───────────────

describe('O4: editDistanceWithin — capped Levenshtein', () => {
  test('完全相同 → 距离 0', () => {
    assert.equal(editDistanceWithin('晴天', '晴天', 1), 0)
    assert.equal(editDistanceWithin('qingtian', 'qingtian', 1), 0)
  })

  test('一次替换 → 距离 1（≤ max）', () => {
    assert.equal(editDistanceWithin('晴天', '晴大', 1), 1)
    assert.equal(editDistanceWithin('abc', 'abd', 1), 1)
  })

  test('一次插入/删除 → 距离 1', () => {
    assert.equal(editDistanceWithin('qingtian', 'qintian', 1), 1) // 删除一个 g
    assert.equal(editDistanceWithin('abc', 'abcd', 1), 1) // 插入 d
  })

  test('大小写差异不算错字（归一化后距离 0）', () => {
    assert.equal(editDistanceWithin('QingTian', 'qingtian', 1), 0)
  })

  test('超过 max 返回 max+1（剪枝）', () => {
    assert.equal(editDistanceWithin('abc', 'xyz', 1), 2) // 三次替换 > 1
    assert.equal(editDistanceWithin('周杰伦', '林俊傑', 1), 2)
  })

  test('长度差 > max 直接判负', () => {
    assert.equal(editDistanceWithin('ab', 'abcd', 1), 2)
  })
})

// ── O4-b: correctKeyword — 词典取历史高频词 + 频次权重 ────────────────────────

describe('O4: correctKeyword — 历史词典纠错', () => {
  test('错字词命中编辑距离≤1 的高频历史词', () => {
    // 用两个不同 uid 搜「周杰伦」→ globalTop count=2（同 uid 去重只 1 行）
    searchHistoryStore.add(uid('zjl'), '周杰伦', '', '')
    searchHistoryStore.add(uid('zjl'), '周杰伦', '', '')
    clearCorrectDictCache()
    const r = correctKeyword('周杰仑') // 仑 vs 伦，距离 1
    assert.ok(r, '应返回纠错建议')
    assert.equal(r!.corrected, '周杰伦')
    assert.equal(r!.correctedFrom, '周杰仑')
  })

  test('原词本就是词典高频词 → 不纠错（返回 null）', () => {
    clearCorrectDictCache()
    assert.equal(correctKeyword('周杰伦'), null)
  })

  test('频次权重：两个等距候选取 count 更高者', () => {
    // 'abd' 高频（3 uid），'abx' 低频（1 uid）；typo 'abc' 与两者均距离 1
    for (let i = 0; i < 3; i++) searchHistoryStore.add(uid('abd'), 'abd', '', '')
    searchHistoryStore.add(uid('abx'), 'abx', '', '')
    clearCorrectDictCache()
    const r = correctKeyword('abc')
    assert.ok(r, '应返回纠错建议')
    assert.equal(r!.corrected, 'abd', '应取频次更高的 abd 而非 abx')
  })

  test('无 ≤1 候选 → 返回 null（不强行纠错）', () => {
    clearCorrectDictCache()
    assert.equal(correctKeyword('zzzzqqqqxxxx'), null)
  })

  test('空词 → 返回 null', () => {
    assert.equal(correctKeyword(''), null)
    assert.equal(correctKeyword('   '), null)
  })
})

// ── O5-a: 共现写入 + neighbors 查询 ──────────────────────────────────────────

describe('O5: searchCoocStore — 共现统计', () => {
  test('同 uid 相邻搜索（窗口内）自动记共现，neighbors 可查', () => {
    const u = uid('cooc')
    searchHistoryStore.add(u, '晴天', '', '')
    searchHistoryStore.add(u, '七里香', '', '') // 与上一条相邻、窗口内 → 共现
    const nb = searchCoocStore.neighbors('晴天', 10)
    assert.ok(nb.some((r) => r.kw === '七里香'), '晴天的邻居应含七里香')
    // 双向：七里香 的邻居也应含 晴天
    const nb2 = searchCoocStore.neighbors('七里香', 10)
    assert.ok(nb2.some((r) => r.kw === '晴天'), '共现应双向可查')
  })

  test('neighbors 排除 kw 自身', () => {
    const u = uid('self')
    searchHistoryStore.add(u, 'AAA', '', '')
    searchHistoryStore.add(u, 'BBB', '', '')
    const nb = searchCoocStore.neighbors('AAA', 10)
    assert.ok(!nb.some((r) => r.kw === 'AAA'), '不应返回自身')
  })

  test('重复共现累计 count（频次升）', () => {
    const u1 = uid('rep1')
    const u2 = uid('rep2')
    searchHistoryStore.add(u1, '稻香', '', '')
    searchHistoryStore.add(u1, '忍者', '', '')
    searchHistoryStore.add(u2, '稻香', '', '')
    searchHistoryStore.add(u2, '忍者', '', '')
    const nb = searchCoocStore.neighbors('稻香', 10)
    const hit = nb.find((r) => r.kw === '忍者')
    assert.ok(hit, '应有共现')
    assert.ok(hit!.count >= 2, `count 应累计 ≥2，实际 ${hit!.count}`)
  })

  test('手动 record：空词/自反被忽略', () => {
    searchCoocStore.record('', 'x')
    searchCoocStore.record('same', 'same')
    assert.deepEqual(searchCoocStore.neighbors('same', 10), [])
  })
})

// ── O5-b: related() 编排（共现 → 冷启动回退 trending → 开关）──────────────────

describe('O5: related() — 相关推荐编排', () => {
  test('有共现数据：按共现返回，排除自身', () => {
    const u = uid('rel')
    searchHistoryStore.add(u, '青花瓷', '', '')
    searchHistoryStore.add(u, '东风破', '', '')
    const r = related('青花瓷', 10)
    assert.ok(Array.isArray(r.related))
    assert.ok(r.related.some((x) => x.kw === '东风破'), '应推荐共现词东风破')
    assert.ok(!r.related.some((x) => x.kw === '青花瓷'), '不应含自身')
    const hit = r.related.find((x) => x.kw === '东风破')!
    assert.equal(typeof hit.score, 'number')
    assert.ok(hit.score >= 1)
  })

  test('冷启动：无共现数据时回退 trending 热门词', () => {
    // 'qyz-no-cooc' 从未参与共现；trending 里有前面用例播种的热词
    const r = related('qyz-no-cooc-xyz', 5)
    assert.ok(Array.isArray(r.related))
    assert.ok(r.related.length > 0, '应回退到 trending 非空结果')
    assert.ok(!r.related.some((x) => x.kw === 'qyz-no-cooc-xyz'), '回退结果不含基准词')
    for (const x of r.related) assert.equal(typeof x.score, 'number')
  })

  test('空 kw → 空数组（不报错）', () => {
    assert.deepEqual(related('', 10), { related: [] })
    assert.deepEqual(related('   ', 10), { related: [] })
  })

  test('relatedEnabled=false → 空数组', () => {
    const prev = config.search!.relatedEnabled
    try {
      config.search!.relatedEnabled = false
      const u = uid('dis')
      searchHistoryStore.add(u, '禁用A', '', '')
      searchHistoryStore.add(u, '禁用B', '', '')
      assert.deepEqual(related('禁用A', 10), { related: [] })
    } finally {
      config.search!.relatedEnabled = prev
    }
  })

  test('limit 生效：返回条数 ≤ limit', () => {
    const u = uid('lim')
    searchHistoryStore.add(u, 'base-word', '', '')
    for (let i = 0; i < 5; i++) searchHistoryStore.add(u, `base-n${i}`, '', '')
    // 上面每次 add 都与前一条共现，base-word 的邻居含 base-n0
    const r = related('base-word', 1)
    assert.ok(r.related.length <= 1)
  })
})
