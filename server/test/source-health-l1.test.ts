/**
 * L1 音源健康聚合「诊断性步骤污染」复现测试（v0.2.22 修复）。
 *
 * ⚠️ 沙箱 import 必须是**裸副作用形式**且为文件第一条 import：
 *      import './fixtures/env-sandbox.js'
 *    若写成「未被使用的具名 import」（例如 `import { SANDBOX_ROOT } from ...` 而全文件
 *    从不引用它），esbuild / tsx 会在转译期把整条 import **整行 elide** → env-sandbox
 *    永不求值 → `RO_DB_DIR` 未设 → 本文件的 `smokeStore.insertMany` 会写进仓库真机
 *    `data/ro.db`。这正是 v0.2.19 烧号的根因（见 docs/CHANGELOG-0.2.20.md §二）。
 *    `scripts/verify-ci.sh` 的 isolation 段与 `build.yml` 的 SANDBOX_ELISION 护栏会
 *    机械化拦住这种写法，但第一道防线仍是「别这么写」。
 *
 * ── 缺陷（修复前）────────────────────────────────────────────────────────────
 * `computeSourceHealth()` 的聚合 SQL 原先**没有 step 过滤**：
 *      SELECT source_id, run_id, MIN(ok) AS all_ok, MAX(created_at) AS ts
 *      FROM smoke_results GROUP BY source_id, run_id
 * 于是 `MIN(ok)` 把冒烟五步（search / musicUrl / head / lyric / pic）全部算进「该 run
 * 是否失败」。但其中只有 search / musicUrl 代表**真实解析与下载能力**：
 *   - `head` 是**诊断性探测**：mg / tx 等平台的 CDN 常拒 HEAD（405/410/502）而 GET 正常，
 *     HEAD 失败与「下载不了」并不等价；
 *   - `lyric` / `pic` 是附属元数据，缺失完全不影响取链与下载。
 * 后果（真机实测）：承载 ~90% 生产流量、musicUrl 95/95 零失败、实际下载 127/127 全成功的
 * `qdy`，仅因 head 在 mg / tx 被拒就被判 `allRecentFailed=true`，被 `orderByHealth`
 * 降到候选**末尾**——健康排序把最健康的源排到了最后，与设计意图完全相反。
 *
 * ── 修复（v0.2.22）──────────────────────────────────────────────────────────
 * 聚合 SQL 加 `WHERE step IN ('search','musicUrl')`，只用两个关键步骤算健康。
 * 采样深度（5）、`allRecentFailed` 判定式、`orderByHealth` 排序语义、L2 熔断器
 * （阈值 5 / 窗口 5min / 进程内存态）**一律未动**。
 *
 * 运行方式：npm test（tsx --test test/*.test.ts）
 */
import './fixtures/env-sandbox.js'
import { test, describe, before, after } from 'node:test'
import assert from 'node:assert/strict'

import { initDb } from '../src/core/db/index.js'
import { smokeStore, type SmokeStep, type SmokeResultRow } from '../src/core/db/smoke.js'
import {
  computeSourceHealth,
  invalidateHealthCache,
  orderByHealth,
  filterCircuitOpen,
  sourceCircuit,
} from '../src/core/source-engine/source-health.js'
import { config } from '../src/core/config.js'

/** 冒烟五步的真实取值（server/src/core/db/smoke.ts 的 SmokeStep 联合类型） */
const STEPS: SmokeStep[] = ['search', 'musicUrl', 'head', 'lyric', 'pic']
/** 真实冒烟覆盖的五平台 */
const PLATFORMS = ['kw', 'kg', 'tx', 'wy', 'mg']
/** 采样深度：与 source-health.ts 的 HEALTH_SAMPLE_RUNS 一致（达到该深度才可能判 allRecentFailed） */
const RUNS = 5

/**
 * 造一轮**完整**冒烟 run（五步 × 五平台 = 25 行）并落库。
 * `stepOk` 决定每步在每平台是否成功——刻意让所有五步都留行，这样修复前
 * 「任一步骤失败即整 run 失败」的 `MIN(ok)` 一定会被 head/lyric/pic 污染。
 */
function insertRun(sourceId: string, runIdx: number, stepOk: (step: SmokeStep, platform: string) => boolean): void {
  const runId = `${sourceId}-run-${runIdx}`
  // runIdx 越大越新；MAX(created_at) 决定 computeSourceHealth 的「近 N 次」取样顺序
  const base = Date.now() - (RUNS - runIdx) * 60_000
  const rows: SmokeResultRow[] = []
  let i = 0
  for (const platform of PLATFORMS) {
    for (const step of STEPS) {
      const ok = stepOk(step, platform)
      const row = smokeStore.newRow(runId, sourceId, platform, step, ok, 20, ok ? undefined : `${step} 在 ${platform} 失败`)
      row.created_at = base + i // newRow 用 Date.now()，覆盖为递增戳以保证 run 间排序确定
      rows.push(row)
      i++
    }
  }
  smokeStore.insertMany(rows)
}

/** 造 RUNS 轮同构 run */
function insertRuns(sourceId: string, stepOk: (step: SmokeStep, platform: string) => boolean): void {
  for (let r = 0; r < RUNS; r++) insertRun(sourceId, r, stepOk)
}

describe('L1 修复：诊断性 head 步骤不得参与音源健康聚合', () => {
  before(() => {
    initDb()
    invalidateHealthCache()
  })

  after(() => {
    sourceCircuit.reset()
    invalidateHealthCache()
  })

  test('qdy 场景复现：search+musicUrl 全过、head 在 mg/tx 被拒 → 不判 allRecentFailed、不降权', () => {
    const SRC = 'l1fix-qdy-like'
    insertRuns(SRC, (step, platform) => {
      // mg / tx 的 CDN 恒拒 HEAD（真机实测 404 / 502），但 GET 下载完全正常
      if (step === 'head') return platform !== 'mg' && platform !== 'tx'
      return true // search / musicUrl / lyric / pic 全过
    })
    invalidateHealthCache()
    const health = computeSourceHealth()
    const h = health.get(SRC)

    assert.ok(h, 'qdy 应有健康快照（search/musicUrl 行存在）')
    assert.equal(h!.runs, RUNS, `应聚合到 ${RUNS} 轮 run`)
    assert.equal(h!.rate, 1, '关键步骤全过 → 成功率应为 1（修复前被 head 拉成 0）')
    assert.equal(
      h!.allRecentFailed,
      false,
      'head 被 CDN 拒绝 ≠ 源不可用，绝不能判「近 5 次全失败」（修复前此处为 true → 被降权）',
    )

    // 不被降权：qdy 原本就在候选首位（承载 90% 流量），修复后必须仍在首位
    assert.deepEqual(
      orderByHealth([SRC, 'other-a', 'other-b'], health),
      [SRC, 'other-a', 'other-b'],
      '健康的 qdy 不应被移到候选末尾',
    )
  })

  test('head 在**全部**平台失败也不降权（qdy 情形的上界）', () => {
    const SRC = 'l1fix-head-all-dead'
    insertRuns(SRC, (step) => step !== 'head')
    invalidateHealthCache()
    const h = computeSourceHealth().get(SRC)
    assert.ok(h)
    assert.equal(h!.rate, 1, 'head 全灭但 search/musicUrl 全过 → 仍应视为健康')
    assert.equal(h!.allRecentFailed, false)
  })

  test('lyric/pic 缺失同样不参与聚合（附属元数据不影响取链与下载）', () => {
    const SRC = 'l1fix-no-meta'
    insertRuns(SRC, (step) => step !== 'lyric' && step !== 'pic')
    invalidateHealthCache()
    const h = computeSourceHealth().get(SRC)
    assert.ok(h)
    assert.equal(h!.rate, 1)
    assert.equal(h!.allRecentFailed, false, '无歌词/无封面不应导致音源降权')
  })

  test('对照组：musicUrl 真失败的源仍被判 allRecentFailed 并降到末尾（修复未把 L1 打哑）', () => {
    const BAD = 'l1fix-really-dead'
    const GOOD = 'l1fix-healthy'
    insertRuns(BAD, (step) => step === 'search') // search 过、musicUrl 全平台失败 = 上游取链已死
    insertRuns(GOOD, () => true)
    invalidateHealthCache()
    const health = computeSourceHealth()

    const bad = health.get(BAD)
    assert.ok(bad)
    assert.equal(bad!.rate, 0, 'musicUrl 全失败 → 成功率 0')
    assert.equal(bad!.allRecentFailed, true, '真实坏源必须仍被判全失败')

    assert.deepEqual(
      orderByHealth([BAD, GOOD], health),
      [GOOD, BAD],
      '坏源应被降到健康源之后',
    )
  })

  test('对照组：search/musicUrl 等关键步骤失败的源同样被判 allRecentFailed', () => {
    const BAD = 'l1fix-search-dead'
    insertRuns(BAD, () => false) // 五步（search/musicUrl/head/lyric/pic）全灭，不只是 search
    invalidateHealthCache()
    const bad = computeSourceHealth().get(BAD)
    assert.ok(bad)
    assert.equal(bad!.allRecentFailed, true)
    assert.equal(bad!.rate, 0)
  })

  test('阈值语义未变：5 轮里 1 轮 musicUrl 真失败 → rate=0.8 且 allRecentFailed=false', () => {
    const SRC = 'l1fix-mostly-ok'
    for (let r = 0; r < RUNS; r++) {
      // 仅第 3 轮的 musicUrl 在 tx 上失败（真实抖动）
      insertRun(SRC, r, (step, platform) => !(r === 2 && step === 'musicUrl' && platform === 'tx'))
    }
    invalidateHealthCache()
    const h = computeSourceHealth().get(SRC)
    assert.ok(h)
    assert.equal(h!.runs, RUNS)
    assert.equal(h!.rate, 0.8, '4/5 轮全过 → 0.8')
    assert.equal(h!.allRecentFailed, false, '非全失败不得降权')
  })

  test('边界：某源只有 head 行（无 search/musicUrl）→ 无健康快照，按中性不降权', () => {
    const SRC = 'l1fix-head-only'
    for (let r = 0; r < RUNS; r++) {
      const runId = `${SRC}-run-${r}`
      const base = Date.now() - (RUNS - r) * 60_000
      const rows: SmokeResultRow[] = []
      let i = 0
      for (const platform of PLATFORMS) {
        const row = smokeStore.newRow(runId, SRC, platform, 'head', false, 20, 'HEAD 405')
        row.created_at = base + i++
        rows.push(row)
      }
      smokeStore.insertMany(rows)
    }
    invalidateHealthCache()
    const health = computeSourceHealth()
    assert.equal(health.get(SRC), undefined, '没有关键步骤数据 → 不应产生快照')
    assert.deepEqual(
      orderByHealth([SRC, 'peer'], health),
      [SRC, 'peer'],
      '无快照 = 中性，原序不变（绝不因缺数据而降权）',
    )
  })

  test('L2 熔断器与 L1 聚合解耦：L1 判健康的源仍可被熔断（阈值 5 / 窗口 5min 未变）', () => {
    const SRC = 'l1fix-qdy-like' // 上一组已落库、L1 判定为健康
    const prevT = config.sources.circuitThreshold
    const prevW = config.sources.circuitWindowMs
    config.sources.circuitThreshold = 5
    config.sources.circuitWindowMs = 300_000
    try {
      invalidateHealthCache()
      const health = computeSourceHealth()
      assert.equal(health.get(SRC)?.allRecentFailed, false, '前提：L1 认为它健康')

      sourceCircuit.reset()
      for (let i = 0; i < 4; i++) sourceCircuit.recordFailure(SRC)
      assert.equal(sourceCircuit.isOpen(SRC), false, '未达阈值(5)不熔断')
      assert.equal(sourceCircuit.failCount(SRC), 4)
      sourceCircuit.recordFailure(SRC)
      assert.equal(sourceCircuit.isOpen(SRC), true, '达阈值(5)熔断打开——L1 健康不豁免 L2')
      assert.deepEqual(filterCircuitOpen([SRC, 'other-a']), ['other-a'], '熔断源被临时剔除')
      sourceCircuit.recordSuccess(SRC)
      assert.equal(sourceCircuit.isOpen(SRC), false, '成功即清零（关闭熔断）')
      assert.deepEqual(filterCircuitOpen([SRC]), [SRC], '熔断已关闭 → 走「未熔断源正常保留」路径原样返回（回退分支见下一例）')
      sourceCircuit.reset()
    } finally {
      config.sources.circuitThreshold = prevT
      config.sources.circuitWindowMs = prevW
      sourceCircuit.reset()
    }
  })

  /**
   * 上一例的 `recordSuccess(SRC)` 已把熔断关掉，所以那句 `filterCircuitOpen([SRC])`
   * 走的是「未熔断源正常保留」路径（kept 非空），**并未**行使回退分支。
   * 本例专门覆盖 `filterCircuitOpen` 的另一分支：
   *      const kept = ids.filter((id) => !sourceCircuit.isOpen(id))
   *      return kept.length > 0 ? kept : ids      // ← kept 被剔空时才回退原候选
   * 回退是「绕开 ERR_NO_SOURCE」的关键：全部候选熔断时若直接返回空数组，
   * 上层会当成「无可用音源」直接报错，而不是给已熔断源一次重试机会。
   */
  test('L2 回退分支：全部候选均熔断 → filterCircuitOpen 剔空后回退原候选（绝不清空成 ERR_NO_SOURCE）', () => {
    const A = 'l1fix-circuit-a'
    const B = 'l1fix-circuit-b'
    const prevT = config.sources.circuitThreshold
    const prevW = config.sources.circuitWindowMs
    config.sources.circuitThreshold = 5
    config.sources.circuitWindowMs = 300_000
    try {
      sourceCircuit.reset()
      // 两个源各自达阈值(5)，使 kept 必为空
      for (let i = 0; i < 5; i++) {
        sourceCircuit.recordFailure(A)
        sourceCircuit.recordFailure(B)
      }
      assert.equal(sourceCircuit.isOpen(A), true, '前提：A 达阈值(5)熔断打开')
      assert.equal(sourceCircuit.isOpen(B), true, '前提：B 达阈值(5)熔断打开')

      // 对照：只要有一个未熔断，就走正常剔除路径（证明下一句的回退不是无条件生效）
      assert.deepEqual(filterCircuitOpen([A, B, 'never-failed']), ['never-failed'], '未熔断的候选被保留（kept 非空 → 不回退）')

      // 真回退分支：kept 被剔空
      assert.deepEqual(filterCircuitOpen([A, B]), [A, B], '全部候选熔断 → 剔空后必须回退原候选，绝不清空成 ERR_NO_SOURCE')
      assert.deepEqual(filterCircuitOpen([A]), [A], '单候选全熔断同样回退')
      sourceCircuit.reset()
    } finally {
      config.sources.circuitThreshold = prevT
      config.sources.circuitWindowMs = prevW
      sourceCircuit.reset()
    }
  })
})
