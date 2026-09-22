/**
 * P2 下载/音源侧强化单测（L + M + N + O1）：
 *   L1 音源健康排序（orderByHealth / computeSourceHealth 聚合 smoke_results）
 *   L2 音源级熔断器（SourceCircuitBreaker / filterCircuitOpen）
 *   M1 结构化错误码（classifyError / encodeError / decodeError / errorToStatus / DiskFullError）
 *   M2 download_attempts 审计（insertAttempts / listAttempts / 级联删除）
 *   N1 封面与音频并行下载（本地 HTTP 服务观测到达时序）
 *   N3 enqueue 前磁盘空间预检（minFreeBytes 巨值 → DiskFullError）
 *   O1 preview 路由（校验分支 + 无音源 → 503 ERR_NO_SOURCE）
 *
 * 运行方式：npm test（tsx --test test/*.test.ts，不依赖 build）
 */
import { SANDBOX_ROOT } from './fixtures/env-sandbox.js'
import { test, describe, before, after } from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import fs from 'node:fs'
import path from 'node:path'
import Fastify from 'fastify'

// M1
import {
  classifyError,
  encodeError,
  encodeErrorFrom,
  decodeError,
  errorToStatus,
  DiskFullError,
  isDiskFullError,
} from '../src/core/download/errors.js'
// L1/L2
import {
  orderByHealth,
  SourceCircuitBreaker,
  filterCircuitOpen,
  sourceCircuit,
  computeSourceHealth,
  invalidateHealthCache,
  type SourceHealth,
} from '../src/core/source-engine/source-health.js'
// M2
import { taskStore, initDb, type DownloadAttemptRow } from '../src/core/db/index.js'
import { smokeStore } from '../src/core/db/smoke.js'
// N3 + queue
import { downloadQueue } from '../src/core/download/queue.js'
// N1
import { downloader } from '../src/core/download/index.js'
// O1
import { previewRoutes } from '../src/routes/preview.js'
import { config } from '../src/core/config.js'
import type { MusicInfo } from '../src/core/adapters/common.js'

// ── M1: 结构化错误码 ──────────────────────────────────────────────────────

describe('M1: 结构化错误码映射', () => {
  test('classifyError: DiskFullError → ERR_DISK_FULL', () => {
    assert.equal(classifyError(new DiskFullError(1, 2)), 'ERR_DISK_FULL')
    assert.equal(isDiskFullError(new DiskFullError(1, 2)), true)
    assert.equal(isDiskFullError(new Error('x')), false)
  })

  test('classifyError: NoSourceError（鸭子类型 name）→ ERR_NO_SOURCE', () => {
    assert.equal(classifyError({ name: 'NoSourceError', message: '没有可用音源' }), 'ERR_NO_SOURCE')
  })

  test('classifyError: 带 attempts 数组（全源失败上抛）→ ERR_ALL_SOURCES_FAILED', () => {
    assert.equal(classifyError({ message: '所有音源失败', attempts: [{ ok: false }] }), 'ERR_ALL_SOURCES_FAILED')
  })

  test('classifyError: httpStatus 5xx/4xx 分流', () => {
    assert.equal(classifyError({ httpStatus: 503, message: 'x' }), 'ERR_HTTP_5XX')
    assert.equal(classifyError({ httpStatus: 404, message: 'x' }), 'ERR_HTTP_4XX')
  })

  test('classifyError: 文本兜底 DNS / 超时 / 标签嵌入', () => {
    assert.equal(classifyError('getaddrinfo ENOTFOUND host'), 'ERR_DNS')
    assert.equal(classifyError(new Error('request timeout')), 'ERR_TIMEOUT')
    assert.equal(classifyError(new Error('标签嵌入失败: bad')), 'ERR_TAG_EMBED')
    assert.equal(classifyError(new Error('完全未知的原因')), 'ERR_UNKNOWN')
  })

  test('encodeError / decodeError 往返；旧纯字符串向后兼容（读取不崩）', () => {
    const enc = encodeError('ERR_TIMEOUT', '超时了')
    assert.deepEqual(decodeError(enc), { code: 'ERR_TIMEOUT', message: '超时了' })
    // 旧库存的纯字符串（非 JSON）→ 归 ERR_UNKNOWN + 原文
    assert.deepEqual(decodeError('历史遗留的纯文本错误'), { code: 'ERR_UNKNOWN', message: '历史遗留的纯文本错误' })
    // 非法 JSON（以 { 开头但解析失败）→ 向后兼容分支
    assert.deepEqual(decodeError('{坏掉的 json'), { code: 'ERR_UNKNOWN', message: '{坏掉的 json' })
    assert.equal(decodeError(null), null)
    assert.equal(decodeError(''), null)
  })

  test('encodeErrorFrom: 从任意错误编码为 {code,message} JSON', () => {
    const parsed = JSON.parse(encodeErrorFrom(new DiskFullError(10, 100))) as { code: string; message: string }
    assert.equal(parsed.code, 'ERR_DISK_FULL')
    assert.ok(parsed.message.includes('磁盘'))
  })

  test('errorToStatus: 507/503/504/400/502 映射', () => {
    assert.equal(errorToStatus('ERR_DISK_FULL'), 507)
    assert.equal(errorToStatus('ERR_NO_SOURCE'), 503)
    assert.equal(errorToStatus('ERR_TIMEOUT'), 504)
    assert.equal(errorToStatus('ERR_BAD_REQUEST'), 400)
    assert.equal(errorToStatus('ERR_UNKNOWN'), 502)
    assert.equal(errorToStatus('ERR_HTTP_5XX'), 502)
  })
})

// ── L1: 音源健康排序 ──────────────────────────────────────────────────────

describe('L1: 音源健康排序', () => {
  test('orderByHealth: 近 N 次全失败的源降到末尾，其余保持原相对顺序', () => {
    const health = new Map<string, SourceHealth>([
      ['bad', { rate: 0, runs: 5, allRecentFailed: true }],
      ['good', { rate: 1, runs: 5, allRecentFailed: false }],
    ])
    // bad 在前，但 allRecentFailed → 应被降到末尾；good/mid 保持原序
    assert.deepEqual(orderByHealth(['bad', 'good', 'mid'], health), ['good', 'mid', 'bad'])
  })

  test('orderByHealth: 无健康数据（空 Map）时原序不变', () => {
    assert.deepEqual(orderByHealth(['a', 'b', 'c'], new Map()), ['a', 'b', 'c'])
  })

  test('computeSourceHealth: 聚合 smoke_results 近 N 次成功率（全失败源 allRecentFailed=true）', () => {
    const base = Date.now() - 100_000
    const rows = []
    for (let i = 0; i < 5; i++) {
      rows.push({ id: `p2-bad-${i}`, run_id: `p2-rbad-${i}`, source_id: 'p2srcBad', platform: 'tx', step: 'musicUrl' as const, ok: 0, ms: 10, error: 'boom', created_at: base + i * 1000 })
      rows.push({ id: `p2-good-${i}`, run_id: `p2-rgood-${i}`, source_id: 'p2srcGood', platform: 'tx', step: 'musicUrl' as const, ok: 1, ms: 10, error: null, created_at: base + i * 1000 })
    }
    smokeStore.insertMany(rows)
    invalidateHealthCache()
    const health = computeSourceHealth()
    const bad = health.get('p2srcBad')
    const good = health.get('p2srcGood')
    assert.ok(bad, 'bad 源应有健康快照')
    assert.equal(bad!.allRecentFailed, true, '近 5 次全失败 → allRecentFailed')
    assert.equal(bad!.rate, 0)
    assert.ok(good, 'good 源应有健康快照')
    assert.equal(good!.allRecentFailed, false)
    assert.equal(good!.rate, 1)
    // orderByHealth 应把 bad 降到 good 之后
    assert.deepEqual(orderByHealth(['p2srcBad', 'p2srcGood'], health), ['p2srcGood', 'p2srcBad'])
    invalidateHealthCache()
  })
})

// ── L2: 音源级熔断器 ──────────────────────────────────────────────────────

describe('L2: 音源级熔断器', () => {
  test('SourceCircuitBreaker: 窗口内连续失败达阈值 → isOpen；成功即清零', () => {
    const prevT = config.sources.circuitThreshold
    const prevW = config.sources.circuitWindowMs
    config.sources.circuitThreshold = 3
    config.sources.circuitWindowMs = 60_000
    try {
      const cb = new SourceCircuitBreaker()
      cb.recordFailure('s')
      cb.recordFailure('s')
      assert.equal(cb.isOpen('s'), false, '未达阈值不熔断')
      assert.equal(cb.failCount('s'), 2)
      cb.recordFailure('s')
      assert.equal(cb.isOpen('s'), true, '达阈值(3)熔断打开')
      cb.recordSuccess('s')
      assert.equal(cb.isOpen('s'), false, '成功即关闭熔断')
      assert.equal(cb.failCount('s'), 0)
    } finally {
      config.sources.circuitThreshold = prevT
      config.sources.circuitWindowMs = prevW
    }
  })

  test('filterCircuitOpen: 剔除熔断源；全部熔断时回退原候选（half-open，绝不清空）', () => {
    const prevT = config.sources.circuitThreshold
    config.sources.circuitThreshold = 2
    try {
      sourceCircuit.reset()
      sourceCircuit.recordFailure('s1')
      sourceCircuit.recordFailure('s1')
      assert.equal(sourceCircuit.isOpen('s1'), true)
      assert.deepEqual(filterCircuitOpen(['s1', 's2']), ['s2'], '剔除熔断的 s1')
      assert.deepEqual(filterCircuitOpen(['s1']), ['s1'], '全部熔断 → 回退原候选')
      sourceCircuit.reset()
    } finally {
      config.sources.circuitThreshold = prevT
    }
  })
})

// ── M2: download_attempts 审计 ────────────────────────────────────────────

describe('M2: download_attempts 审计轨迹', () => {
  before(() => initDb())

  test('insertAttempts + listAttempts：按 ts/id 升序返回', () => {
    const taskId = 'p2-attempts-1'
    const now = Date.now()
    const rows: DownloadAttemptRow[] = [
      { task_id: taskId, attempt_no: 1, source_id: 'srcA', platform: 'tx', quality: 'flac', error_code: 'ERR_HTTP_5XX', ts: now },
      { task_id: taskId, attempt_no: 1, source_id: 'srcB', platform: 'tx', quality: 'flac', error_code: null, ts: now },
      { task_id: taskId, attempt_no: 2, source_id: 'srcA', platform: 'tx', quality: '320k', error_code: 'ERR_TIMEOUT', ts: now + 1000 },
    ]
    taskStore.insertAttempts(rows)
    const got = taskStore.listAttempts(taskId)
    assert.equal(got.length, 3)
    assert.equal(got[0]!.source_id, 'srcA')
    assert.equal(got[0]!.error_code, 'ERR_HTTP_5XX')
    assert.equal(got[1]!.source_id, 'srcB')
    assert.equal(got[1]!.error_code, null, '命中项 error_code 为 null')
    assert.equal(got[2]!.attempt_no, 2)
    assert.equal(got[2]!.quality, '320k')
  })

  test('insertAttempts 空数组无副作用；delete 级联清理审计', () => {
    taskStore.insertAttempts([]) // 不抛
    const taskId = 'p2-attempts-cascade'
    taskStore.insertAttempts([{ task_id: taskId, attempt_no: 1, source_id: 's', platform: 'tx', quality: 'flac', error_code: 'ERR_DNS', ts: Date.now() }])
    assert.equal(taskStore.listAttempts(taskId).length, 1)
    taskStore.delete(taskId) // 级联删除 attempts（不要求 task 行存在）
    assert.equal(taskStore.listAttempts(taskId).length, 0, 'delete 后审计轨迹应被级联清理')
  })
})

// ── N3: enqueue 前磁盘空间预检 ────────────────────────────────────────────

describe('N3: enqueue 磁盘空间预检', () => {
  before(() => initDb())

  test('minFreeBytes 设为巨值 → enqueue 抛 DiskFullError（路由侧映射 507）', async () => {
    const prevPre = config.download.diskPrecheck
    const prevMin = config.download.minFreeBytes
    config.download.diskPrecheck = true
    config.download.minFreeBytes = Number.MAX_SAFE_INTEGER
    try {
      const mi: MusicInfo = { name: 'x', singer: 'y', source: 'tx', songmid: 'p2-disk-full', types: [], _types: {} }
      await assert.rejects(
        () => downloadQueue.enqueue({ platform: 'tx', musicInfo: mi, quality: 'flac' }),
        (err: unknown) => isDiskFullError(err) && classifyError(err) === 'ERR_DISK_FULL',
      )
    } finally {
      config.download.diskPrecheck = prevPre
      config.download.minFreeBytes = prevMin
    }
  })

  test('diskPrecheck=false → 跳过预检直接入队（返回 id，可取消）', async () => {
    const prevPre = config.download.diskPrecheck
    const prevMin = config.download.minFreeBytes
    const prevPolicy = config.download.dedupePolicy
    config.download.diskPrecheck = false
    config.download.minFreeBytes = Number.MAX_SAFE_INTEGER // 即便阈值巨值，关闭预检也应放行
    config.download.dedupePolicy = 'always-new'
    try {
      const mi: MusicInfo = { name: 'x', singer: 'y', source: 'tx', songmid: 'p2-disk-off', types: [], _types: {} }
      const id = await downloadQueue.enqueue({ platform: 'tx', musicInfo: mi, quality: 'flac' })
      assert.ok(id && typeof id === 'string')
      downloadQueue.cancel(id) // 阻止后台 run() 触发真实下载
    } finally {
      config.download.diskPrecheck = prevPre
      config.download.minFreeBytes = prevMin
      config.download.dedupePolicy = prevPolicy
    }
  })
})

// ── N1: 封面与音频并行下载 ────────────────────────────────────────────────

describe('N1: 封面与音频并行下载', () => {
  let server: http.Server
  let port: number
  let audioArrival = 0
  let coverArrival = 0
  const prevDir = config.download.dir
  const prevCover = config.download.embedCover
  const prevLyric = config.download.embedLyric
  const prevDetect = config.download.detectRealQuality

  before(async () => {
    // 下载落盘改到沙箱内，避免污染仓库 data/downloads
    const dlDir = path.join(SANDBOX_ROOT, 'n1-dl')
    fs.mkdirSync(dlDir, { recursive: true })
    config.download.dir = dlDir
    config.download.embedCover = true
    config.download.embedLyric = false
    config.download.detectRealQuality = false

    server = http.createServer((req, res) => {
      const t = Number(process.hrtime.bigint() / 1_000_000n)
      if (req.url?.startsWith('/audio')) {
        audioArrival = t
        // 音频慢响应（250ms）：若封面串行则其到达必然晚于此刻 + 250ms
        setTimeout(() => {
          res.writeHead(200, { 'Content-Type': 'audio/wav' })
          res.end(Buffer.alloc(4096, 7))
        }, 250)
      } else if (req.url?.startsWith('/cover')) {
        coverArrival = t
        setTimeout(() => {
          res.writeHead(200, { 'Content-Type': 'image/jpeg' })
          res.end(Buffer.alloc(2048, 3))
        }, 80)
      } else {
        res.writeHead(404).end()
      }
    })
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
    port = (server.address() as { port: number }).port
  })

  after(async () => {
    await new Promise<void>((r) => server.close(() => r()))
    config.download.dir = prevDir
    config.download.embedCover = prevCover
    config.download.embedLyric = prevLyric
    config.download.detectRealQuality = prevDetect
  })

  test('封面前置起跑：cover 到达时刻与 audio 到达时刻接近（并行而非串行）', async () => {
    audioArrival = 0
    coverArrival = 0
    const mi: MusicInfo = { name: 'n1', singer: 's', source: 'tx', songmid: 'n1', types: [], _types: {} }
    const outcome = await downloader.download(
      `http://127.0.0.1:${port}/audio.wav`,
      'flac',
      { name: 'n1', singer: 's', album: 'a', coverUrl: `http://127.0.0.1:${port}/cover.jpg` },
      mi,
      undefined,
      undefined, // 无 taskId → 不启用续传
    )
    assert.ok(outcome.filePath && fs.existsSync(outcome.filePath), '音频应落盘')
    assert.ok(audioArrival > 0 && coverArrival > 0, '两个端点都应被请求')
    const delta = coverArrival - audioArrival
    // 并行：封面与音频几乎同时起跑（delta < 150ms）；若串行则 delta ≈ 音频耗时(250ms)+
    assert.ok(delta < 150, `封面应与音频并行起跑，实测到达间隔 ${delta}ms（串行会 ≥250ms）`)
  })
})

// ── O1: preview 路由 ──────────────────────────────────────────────────────

describe('O1: preview 路由（音源直链代理）', () => {
  let app: ReturnType<typeof Fastify>

  before(async () => {
    app = Fastify()
    await app.register(previewRoutes)
    await app.ready()
  })

  after(async () => {
    await app.close()
  })

  test('缺少/非法 platform → 400 ERR_BAD_REQUEST', async () => {
    const r1 = await app.inject({ method: 'GET', url: '/api/v1/preview?songmid=abc' })
    assert.equal(r1.statusCode, 400)
    assert.equal((r1.json() as { error: { code: string } }).error.code, 'ERR_BAD_REQUEST')

    const r2 = await app.inject({ method: 'GET', url: '/api/v1/preview?platform=zz&songmid=abc' })
    assert.equal(r2.statusCode, 400)
  })

  test('缺少 songmid → 400 ERR_BAD_REQUEST', async () => {
    const r = await app.inject({ method: 'GET', url: '/api/v1/preview?platform=tx' })
    assert.equal(r.statusCode, 400)
    assert.equal((r.json() as { error: { code: string } }).error.code, 'ERR_BAD_REQUEST')
  })

  test('非法 quality → 400 ERR_BAD_REQUEST', async () => {
    const r = await app.inject({ method: 'GET', url: '/api/v1/preview?platform=tx&songmid=abc&quality=xxx' })
    assert.equal(r.statusCode, 400)
    assert.equal((r.json() as { error: { code: string } }).error.code, 'ERR_BAD_REQUEST')
  })

  test('合法入参但无可用音源 → 503 ERR_NO_SOURCE（结构化错误码）', async () => {
    // 测试环境未加载任何音源 → orchestrator 抛 NoSourceError → errorToStatus 映射 503
    const r = await app.inject({ method: 'GET', url: '/api/v1/preview?platform=tx&songmid=abc&quality=flac' })
    assert.equal(r.statusCode, 503)
    const body = r.json() as { error: { code: string; message: string } }
    assert.equal(body.error.code, 'ERR_NO_SOURCE')
    assert.ok(typeof body.error.message === 'string' && body.error.message.length > 0)
  })
})
