/**
 * #196 E2E 缺陷修复单测：
 *   - /tasks/owned 完整性（bench 污染下仍返回全部 completed+failed）
 *   - /tasks 响应含 total
 *   - mergeOwned 同任务 active→failed 覆盖（纯逻辑验证）
 *
 * 运行方式：npm test（tsx --test test/*.test.ts）
 */
import { SANDBOX_ROOT } from './fixtures/env-sandbox.js'
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

describe('#196-fix2: /tasks 响应含 total（queue.counts 聚合）', () => {
  test('counts() 返回全部状态计数，total = 各状态之和', () => {
    const counts = downloadQueue.counts()
    assert.ok(typeof counts.pending === 'number')
    assert.ok(typeof counts.active === 'number')
    assert.ok(typeof counts.completed === 'number')
    assert.ok(typeof counts.failed === 'number')
    assert.ok(typeof counts.canceled === 'number')
    const total = counts.pending + counts.active + counts.completed + counts.failed + counts.canceled
    assert.ok(total > 0, 'total should be > 0 (DB has tasks)')
  })

  test('list() 默认 limit=50 但 counts() 不受限', () => {
    const tasks = downloadQueue.list() // 默认 limit=50
    const counts = downloadQueue.counts()
    const total = counts.pending + counts.active + counts.completed + counts.failed + counts.canceled
    // list 返回 ≤50，但 total 应 ≥ list 返回数
    assert.ok(tasks.length <= 50, `list should respect limit 50, got ${tasks.length}`)
    assert.ok(total >= tasks.length, `total ${total} should be >= list count ${tasks.length}`)
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
