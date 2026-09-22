/**
 * #196 E2E 缺陷修复单测：
 *   - /tasks/owned 完整性（bench 污染下仍返回全部 completed+failed）
 *   - /tasks 响应含 total
 *   - mergeOwned 同任务 active→failed 覆盖（纯逻辑验证）
 *
 * 运行方式：npm test（tsx --test test/*.test.ts）
 *
 * ⚠️ 沙箱 import 必须是**裸副作用形式** `import './fixtures/env-sandbox.js'`（与
 * download-m1.test.ts 一致），**绝不可**写成 `import { SANDBOX_ROOT } from ...` 却又不使用它：
 * TS 语义下「未使用的具名 import」可能是类型，esbuild/tsx 会把**整条 import 语句删掉**，
 * env-sandbox 于是永不执行 → RO_CONFIG / RO_DB_DIR / RO_LOG_LEVEL 全部未设 → initDb() 回退
 * 打开**真机仓库 data/ro.db**。后果两面：① 污染真机数据副本；② 任何「库里有数据」类断言
 * 在本地假绿、在 CI 空库上真败。v0.2.19 的 CI 失败（run 35726769721，单元测试 job）根因
 * 即此，详见 docs/CHANGELOG-0.2.20.md。下方「沙箱前置守卫」用例 + scripts/verify-ci.sh 的
 * isolation 段共同把该回归机械化拦住。
 */
import './fixtures/env-sandbox.js'
import { test, describe, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { taskStore, type DownloadTaskRow } from '../src/core/db/index.js'
import { downloadQueue } from '../src/core/download/queue.js'

// ── 辅助：构造最小任务行 ──────────────────────────────────────────────────

let seq = 0
function makeRow(overrides: Partial<DownloadTaskRow> = {}): DownloadTaskRow {
  const id = `test-196-${++seq}`
  return {
    id,
    keyword_source: 'kw',
    platform: 'kw',
    songmid: `song${seq}`,
    name: `Test Song ${seq}`,
    singer: 'Tester',
    album: 'Test Album',
    requested_quality: '320k',
    actual_quality: null,
    actual_source: null,
    music_info: JSON.stringify({ songmid: `song${seq}`, name: `Test Song ${seq}`, singer: 'Tester' }),
    status: 'completed',
    progress: 100,
    file_path: `/tmp/test/${id}.mp3`,
    file_size: 1024,
    warnings: null,
    error: null,
    requeue_count: 0,
    scrape_status: 'pending',
    scrape_info: null,
    actual_bitrate: null,
    actual_codec: null,
    actual_sample_rate: null,
    batch_id: null,
    created_at: Date.now(),
    updated_at: Date.now(),
    ...overrides,
  }
}

// ── 沙箱前置守卫（v0.2.20 新增：把「沙箱是否真的生效」变成显式断言）──────────────
// 放在所有 suite 之前：一旦首行沙箱 import 再次被 elide，本用例第一个失败并直接说明根因，
// 不必再从「total=0」这类间接症状反推。

test('沙箱前置守卫：本进程确实运行在临时沙箱（env-sandbox 已设 RO_DB_DIR/RO_CONFIG/RO_LOG_LEVEL）', () => {
  const dbDir = process.env.RO_DB_DIR
  assert.ok(
    dbDir,
    'RO_DB_DIR 未设置 → env-sandbox 未执行。最可能原因：本文件首行沙箱 import 被写成未使用的具名 import 而被 esbuild elide（v0.2.19 CI 失败根因），请改回裸副作用 import',
  )
  assert.match(
    dbDir!,
    /rb-test-/,
    `RO_DB_DIR='${dbDir}' 不含 env-sandbox 的 mkdtemp 前缀 'rb-test-' → 测试正在读写真机 data/ro.db`,
  )
  assert.ok(process.env.RO_CONFIG, 'RO_CONFIG 未设置 → env-sandbox 未执行')
  assert.equal(process.env.RO_LOG_LEVEL, 'silent', 'RO_LOG_LEVEL 未被 env-sandbox 置为 silent → env-sandbox 未执行')
})

// ── /tasks/owned 完整性 ──────────────────────────────────────────────────

describe('#196-fix2: /tasks/owned 完整性（bench 污染下仍返回全部 completed+failed）', () => {
  const insertedIds: string[] = []

  before(() => {
    // 插入 60 条合成 bench 任务（completed_with_warnings，模拟 bench-track 污染）
    for (let i = 0; i < 60; i++) {
      const row = makeRow({
        platform: 'kg',
        songmid: `bench${i}`,
        status: 'completed_with_warnings',
        name: `Bench Track ${i}`,
        file_path: null, // 合成任务无文件
      })
      taskStore.insert(row)
      insertedIds.push(row.id)
    }
    // 插入 10 条真实 completed 任务
    for (let i = 0; i < 10; i++) {
      const row = makeRow({
        platform: 'wy',
        songmid: `real${i}`,
        status: 'completed',
        name: `Real Song ${i}`,
      })
      taskStore.insert(row)
      insertedIds.push(row.id)
    }
    // 插入 5 条 failed 任务
    for (let i = 0; i < 5; i++) {
      const row = makeRow({
        platform: 'tx',
        songmid: `fail${i}`,
        status: 'failed',
        name: `Failed Song ${i}`,
        file_path: null,
        error: 'source timeout',
      })
      taskStore.insert(row)
      insertedIds.push(row.id)
    }
    // 插入 3 条 pending 任务（不应出现在 owned 中）
    for (let i = 0; i < 3; i++) {
      const row = makeRow({
        platform: 'kw',
        songmid: `pend${i}`,
        status: 'pending',
        progress: 0,
        file_path: null,
      })
      taskStore.insert(row)
      insertedIds.push(row.id)
    }
  })

  after(() => {
    for (const id of insertedIds) {
      try { taskStore.delete(id) } catch { /* ignore */ }
    }
  })

  test('listOwned 返回全部 completed+failed（含 bench 污染），不含 pending', () => {
    const owned = downloadQueue.listOwned()
    // 应包含 60 bench + 10 real + 5 failed = 75 条（加上 DB 中既有的终态任务）
    const ownedIds = new Set(owned.map((o) => o.taskId))
    // 验证我们插入的终态任务全部在列
    for (let i = 0; i < 60; i++) {
      const benchId = insertedIds[i]!
      assert.ok(ownedIds.has(benchId), `bench task ${i} should be in owned`)
    }
    for (let i = 60; i < 70; i++) {
      const realId = insertedIds[i]!
      assert.ok(ownedIds.has(realId), `real task ${i - 60} should be in owned`)
    }
    for (let i = 70; i < 75; i++) {
      const failId = insertedIds[i]!
      assert.ok(ownedIds.has(failId), `failed task ${i - 70} should be in owned`)
    }
    // pending 任务不应出现
    for (let i = 75; i < 78; i++) {
      const pendId = insertedIds[i]!
      assert.ok(!ownedIds.has(pendId), `pending task ${i - 75} should NOT be in owned`)
    }
  })

  test('listOwned 条目结构正确：key/taskId/status/quality/hasFile', () => {
    const owned = downloadQueue.listOwned()
    const benchItem = owned.find((o) => o.taskId === insertedIds[0])
    assert.ok(benchItem, 'bench item should exist')
    assert.equal(benchItem!.key, `kg:bench0`)
    assert.equal(benchItem!.status, 'completed_with_warnings')
    assert.equal(benchItem!.quality, '320k')
    assert.equal(benchItem!.hasFile, false) // bench 无文件

    const realItem = owned.find((o) => o.taskId === insertedIds[60])
    assert.ok(realItem, 'real item should exist')
    assert.equal(realItem!.key, `wy:real0`)
    assert.equal(realItem!.status, 'completed')
    assert.equal(realItem!.hasFile, true)
  })

  test('listOwned 数量 > 50（证明不受默认 limit=50 截断）', () => {
    const owned = downloadQueue.listOwned()
    // 我们插入了 75 条终态任务，加上 DB 既有的，总数应远超 50
    assert.ok(owned.length > 50, `owned length ${owned.length} should be > 50`)
  })
})

// ── /tasks 响应含 total ──────────────────────────────────────────────────
//
// 本 suite **完全自足**（v0.2.20 修复）：自己造已知条数的 fixture、自己清理，断言精确等值。
// 原断言 `assert.ok(total > 0, 'total should be > 0 (DB has tasks)')` 里那句「DB has tasks」
// 正是**对外部既有数据的隐式依赖**：本地真机 data/ro.db 有 141 条真实任务 → 假绿；CI runner
// 上 data/*.db 被 .gitignore 排除、库是空的，且上一个 suite 的 after() 已把它插入的 78 行全部
// 硬删 → total=0 → 真败。
// fixture 总量刻意 **> list() 默认 limit 50**：这样「counts() 不受分页上限截断」才是被真正验证
// 过的结论，而不是原写法（库里只有几条时 total>=tasks.length 恒真）那种空断言。

/** 本 suite 自建 fixture：覆盖全部 6 个 TaskStatus 取值，共 61 条 */
const COUNT_FIXTURE: ReadonlyArray<{ status: DownloadTaskRow['status']; n: number }> = [
  { status: 'pending', n: 12 },
  { status: 'active', n: 8 },
  { status: 'completed', n: 20 },
  { status: 'completed_with_warnings', n: 6 },
  { status: 'failed', n: 10 },
  { status: 'canceled', n: 5 },
]
/** counts() 的期望值——注意它把 completed_with_warnings 并入 completed（20+6=26） */
const EXPECT_COUNTS = { pending: 12, active: 8, completed: 20 + 6, failed: 10, canceled: 5 }
const EXPECT_TOTAL =
  EXPECT_COUNTS.pending + EXPECT_COUNTS.active + EXPECT_COUNTS.completed + EXPECT_COUNTS.failed + EXPECT_COUNTS.canceled // 61
const LIST_DEFAULT_LIMIT = 50

function sumCounts(c: ReturnType<typeof downloadQueue.counts>): number {
  return c.pending + c.active + c.completed + c.failed + c.canceled
}

describe('#196-fix2: /tasks 响应含 total（queue.counts 聚合）', () => {
  const insertedIds: string[] = []

  before(() => {
    for (const { status, n } of COUNT_FIXTURE) {
      for (let i = 0; i < n; i++) {
        const row = makeRow({
          platform: 'wy',
          songmid: `cnt-${status}-${i}`,
          name: `Count ${status} ${i}`,
          status,
          progress: status === 'pending' ? 0 : 100,
          file_path: null, // 本 suite 只验计数，与落盘文件无关
        })
        taskStore.insert(row)
        insertedIds.push(row.id)
      }
    }
  })

  after(() => {
    for (const id of insertedIds) {
      try { taskStore.delete(id) } catch { /* ignore */ }
    }
  })

  test('counts() 五个状态字段均为非负整数', () => {
    const counts = downloadQueue.counts()
    for (const k of ['pending', 'active', 'completed', 'failed', 'canceled'] as const) {
      assert.equal(typeof counts[k], 'number', `counts.${k} 应为 number`)
      assert.ok(Number.isInteger(counts[k]) && counts[k] >= 0, `counts.${k} 应为非负整数，实得 ${counts[k]}`)
    }
  })

  test('counts() 各状态精确等于本 suite 插入的条数（completed 合并 completed_with_warnings）', () => {
    const counts = downloadQueue.counts()
    assert.equal(counts.pending, EXPECT_COUNTS.pending, 'pending 计数应精确匹配 fixture')
    assert.equal(counts.active, EXPECT_COUNTS.active, 'active 计数应精确匹配 fixture')
    assert.equal(counts.completed, EXPECT_COUNTS.completed, 'completed 应为 completed + completed_with_warnings 之和')
    assert.equal(counts.failed, EXPECT_COUNTS.failed, 'failed 计数应精确匹配 fixture')
    assert.equal(counts.canceled, EXPECT_COUNTS.canceled, 'canceled 计数应精确匹配 fixture')
  })

  test('total = 各状态之和，且精确等于插入总数（不依赖任何外部既有数据）', () => {
    const total = sumCounts(downloadQueue.counts())
    assert.equal(total, EXPECT_TOTAL, `total 应精确等于本 suite 插入的 ${EXPECT_TOTAL} 条`)
  })

  test(`list() 默认 limit=${LIST_DEFAULT_LIMIT} 截断，counts() 不受限（total ${EXPECT_TOTAL} > ${LIST_DEFAULT_LIMIT}）`, () => {
    const tasks = downloadQueue.list() // 默认 limit=50
    const total = sumCounts(downloadQueue.counts())
    assert.equal(tasks.length, LIST_DEFAULT_LIMIT, `list() 默认 limit 应为 ${LIST_DEFAULT_LIMIT}，实得 ${tasks.length}`)
    assert.equal(total, EXPECT_TOTAL)
    assert.ok(
      total > tasks.length,
      `total ${total} 必须 > list 返回数 ${tasks.length}，否则「counts 不受分页上限截断」未被真正验证`,
    )
  })
})

// ── mergeOwned 同任务 active→failed 覆盖（纯逻辑验证）──────────────────────

describe('#196-fix3: mergeOwned 同任务 active→failed 无条件覆盖', () => {
  // 复刻前端 mergeOwned 纯逻辑（无 DOM/browser 依赖）
  const STATUS_RANK: Record<string, number> = {
    completed: 3,
    completed_with_warnings: 3,
    active: 2,
    pending: 2,
    failed: 1,
    canceled: 0,
  }

  function mergeOwned(map: Map<string, any>, view: any) {
    if (!view || !view.id || !view.platform || !view.songmid) return
    const key = `${view.platform}:${view.songmid}`
    const prev = map.get(key)
    if (!prev) { map.set(key, view); return }
    // #196-fix3: 同任务状态迁移无条件覆盖
    if (prev.id === view.id) { map.set(key, view); return }
    const pr = STATUS_RANK[prev.status] ?? 0
    const nr = STATUS_RANK[view.status] ?? 0
    if (nr > pr || (nr === pr && (view.updatedAt || 0) >= (prev.updatedAt || 0))) map.set(key, view)
  }

  test('同任务 active→failed：无条件覆盖（rank 降级不阻塞）', () => {
    const map = new Map<string, any>()
    const activeView = { id: 'task-1', platform: 'kw', songmid: 's1', status: 'active', progress: 50, updatedAt: 100 }
    const failedView = { id: 'task-1', platform: 'kw', songmid: 's1', status: 'failed', progress: 50, updatedAt: 200 }

    mergeOwned(map, activeView)
    assert.equal(map.get('kw:s1').status, 'active')

    mergeOwned(map, failedView)
    assert.equal(map.get('kw:s1').status, 'failed', 'same task active→failed should override')
  })

  test('同任务 pending→active→completed：每步均覆盖', () => {
    const map = new Map<string, any>()
    mergeOwned(map, { id: 'task-2', platform: 'wy', songmid: 's2', status: 'pending', updatedAt: 1 })
    assert.equal(map.get('wy:s2').status, 'pending')

    mergeOwned(map, { id: 'task-2', platform: 'wy', songmid: 's2', status: 'active', updatedAt: 2 })
    assert.equal(map.get('wy:s2').status, 'active')

    mergeOwned(map, { id: 'task-2', platform: 'wy', songmid: 's2', status: 'completed', updatedAt: 3 })
    assert.equal(map.get('wy:s2').status, 'completed')
  })

  test('不同任务同 key：仍按 rank 选代表（completed > failed）', () => {
    const map = new Map<string, any>()
    mergeOwned(map, { id: 'task-A', platform: 'kg', songmid: 's3', status: 'completed', updatedAt: 10 })
    assert.equal(map.get('kg:s3').id, 'task-A')

    // 不同任务 failed（rank 1）不应覆盖 completed（rank 3）
    mergeOwned(map, { id: 'task-B', platform: 'kg', songmid: 's3', status: 'failed', updatedAt: 20 })
    assert.equal(map.get('kg:s3').id, 'task-A', 'different task: completed should stay over failed')
  })

  test('不同任务同 key 同 rank：updatedAt 新者胜', () => {
    const map = new Map<string, any>()
    mergeOwned(map, { id: 'task-C', platform: 'tx', songmid: 's4', status: 'completed', updatedAt: 10 })
    mergeOwned(map, { id: 'task-D', platform: 'tx', songmid: 's4', status: 'completed_with_warnings', updatedAt: 20 })
    assert.equal(map.get('tx:s4').id, 'task-D', 'same rank: newer updatedAt wins')
  })
})
