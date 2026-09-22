/**
 * M-1(#203) 缺陷回归单测：直连取流阶段失败也落 download_attempts 审计。
 *
 * 背景：#198 的 persistAttempts 仅覆盖 orchestrator 的 ResolveAttempt（换源/降级）路径。
 * 当编排已成功取到 URL、但**实际取流阶段**失败（HTTP 410/4xx/5xx、超时、DNS 等，
 * 如 QA 任务 3957dce6/3303de2a，任务级 error=「下载失败: HTTP 410」）时，错误不携带
 * attempts，导致 download_attempts 无行 → 前端「为什么失败」面板空态。
 *
 * 修复：runOnce 把 downloader.download() 的失败包装为一行 ok:false 的 directAttempt
 * 挂到 err.directAttempts（独立属性，避免污染 classifyError 的 attempts=全源失败信号），
 * run() catch 统一 persistAttempts。本测试通过 mock orchestrator.resolveUrl（命中）+
 * downloader.download（抛 HTTP 错误）驱动真实 queue.run()，断言审计行落库且字段/错误码正确，
 * 并断言既有编排路径（全源失败）审计不回归、任务级 error 文案/码不变。
 *
 * 独立文件：node --test 每文件独立进程，mock 单例（orchestrator/downloader）不污染其它测试。
 * 运行方式：npm test（tsx --test test/*.test.ts）
 */
import './fixtures/env-sandbox.js'
import { test, describe, before, after } from 'node:test'
import assert from 'node:assert/strict'

import { taskStore, initDb } from '../src/core/db/index.js'
import { downloadQueue } from '../src/core/download/queue.js'
import { orchestrator, type ResolveResult, type ResolveAttempt } from '../src/core/orchestrator/index.js'
import { downloader } from '../src/core/download/index.js'
import { config } from '../src/core/config.js'
import type { MusicInfo } from '../src/core/adapters/common.js'
import type { TaskStatus } from '../src/core/db/index.js'

const TERMINAL: TaskStatus[] = ['completed', 'completed_with_warnings', 'failed', 'canceled']

/** 轮询等待任务进入终态（run() 经 p-queue 异步执行；超时即失败，避免测试挂起） */
async function waitTerminal(id: string, timeoutMs = 8000): Promise<TaskStatus> {
  const start = Date.now()
  for (;;) {
    const row = taskStore.get(id)
    if (row && TERMINAL.includes(row.status)) return row.status
    if (Date.now() - start > timeoutMs) throw new Error(`等待任务 ${id} 终态超时（>${timeoutMs}ms）`)
    await new Promise((r) => setTimeout(r, 30))
  }
}

const mi = (songmid: string): MusicInfo => ({
  name: 'm1',
  singer: 's',
  source: 'tx',
  songmid,
  albumName: 'a',
  types: [],
  _types: {},
})

/** 构造与 download/index.ts 一致的包装错误：「下载失败: HTTP <code>」+ name/httpStatus 透传 */
function wrappedHttpError(status: number, permanent: boolean): Error {
  const e = new Error(`下载失败: HTTP ${status}`)
  e.name = permanent ? 'PermanentHttpError' : 'TransientHttpError'
  ;(e as Error & { httpStatus?: number }).httpStatus = status
  return e
}

// 保存单例原始方法，after 恢复（本文件独立进程，仍显式恢复以杜绝跨 describe 泄漏）
const origResolve = orchestrator.resolveUrl
const origDownload = downloader.download

describe('M-1(#203): 直连取流阶段失败落 download_attempts 审计', () => {
  let prevRetryMax: number | undefined
  let prevDedupe: string | undefined
  let prevPrecheck: boolean | undefined

  before(() => {
    initDb()
    prevRetryMax = config.download.retryMax
    prevDedupe = config.download.dedupePolicy
    prevPrecheck = config.download.diskPrecheck
    // 失败即终态、不退避重试：提速且让 attempt_no/行数断言确定（同轮共享号，仅一轮）
    config.download.retryMax = 0
    // 避免去重复用既有任务；跳过磁盘预检，聚焦审计写入本身
    config.download.dedupePolicy = 'always-new'
    config.download.diskPrecheck = false
  })

  after(() => {
    orchestrator.resolveUrl = origResolve
    downloader.download = origDownload
    config.download.retryMax = prevRetryMax
    config.download.dedupePolicy = prevDedupe
    config.download.diskPrecheck = prevPrecheck
  })

  test('直连取流 HTTP 410 失败 → 补一行审计（ERR_HTTP_4XX，字段完整），任务级 error 文案/码不变', async () => {
    // 编排命中 srcM1/local/flac（platform 用非 kw/kg/tx/wy/mg 值，令 fetchLyric/fetchCoverUrl 走 default 秒返回 null，测试无网络）
    orchestrator.resolveUrl = async () => ({
      result: {
        url: 'http://127.0.0.1:1/gone.flac',
        quality: 'flac',
        sourceId: 'srcM1',
        platform: 'local',
        musicInfo: mi('m1-410'),
        toggled: false,
        qualityDegraded: false,
      } as ResolveResult,
      attempts: [{ quality: 'flac', sourceId: 'srcM1', ok: true, platform: 'local', toggled: false }],
    })
    // 直连取流抛「下载失败: HTTP 410」（永久错误，与真机 QA 一致）
    downloader.download = async () => {
      throw wrappedHttpError(410, true)
    }

    const id = await downloadQueue.enqueue({ platform: 'tx', musicInfo: mi('m1-410'), quality: 'flac' })
    const status = await waitTerminal(id)
    assert.equal(status, 'failed')

    // 向后兼容：任务级 error 文案与 errorCode 均未被 directAttempts 篡改（仍 4XX，而非 ALL_SOURCES_FAILED）
    const view = downloadQueue.get(id)!
    assert.equal(view.error, '下载失败: HTTP 410')
    assert.equal(view.errorCode, 'ERR_HTTP_4XX')

    // 审计：恰好一行，字段完整、error_code 由 errors.ts classifyError 从文本归类
    const rows = downloadQueue.listAttempts(id)
    assert.equal(rows.length, 1, '直连取流失败应补一行 download_attempts')
    const r = rows[0]!
    assert.equal(r.task_id, id)
    assert.equal(r.attempt_no, 1, '重试轮次从 1 起')
    assert.equal(r.source_id, 'srcM1')
    assert.equal(r.platform, 'local')
    assert.equal(r.quality, 'flac')
    assert.equal(r.error_code, 'ERR_HTTP_4XX')
    assert.ok(typeof r.ts === 'number' && r.ts > 0, 'ts 应为有效时间戳')
  })

  test('直连取流 HTTP 503（瞬态）失败 → 审计行 error_code=ERR_HTTP_5XX', async () => {
    orchestrator.resolveUrl = async () => ({
      result: {
        url: 'http://127.0.0.1:1/err.flac',
        quality: '320k',
        sourceId: 'srcM2',
        platform: 'local',
        musicInfo: mi('m1-503'),
        toggled: false,
        qualityDegraded: false,
      } as ResolveResult,
      attempts: [{ quality: '320k', sourceId: 'srcM2', ok: true, platform: 'local', toggled: false }],
    })
    downloader.download = async () => {
      throw wrappedHttpError(503, false)
    }

    const id = await downloadQueue.enqueue({ platform: 'tx', musicInfo: mi('m1-503'), quality: '320k' })
    assert.equal(await waitTerminal(id), 'failed')
    const rows = downloadQueue.listAttempts(id)
    assert.equal(rows.length, 1)
    assert.equal(rows[0]!.error_code, 'ERR_HTTP_5XX')
    assert.equal(rows[0]!.source_id, 'srcM2')
    assert.equal(rows[0]!.quality, '320k')
    // 任务级仍 5XX（瞬态，未被误判为全源失败）
    assert.equal(downloadQueue.get(id)!.errorCode, 'ERR_HTTP_5XX')
  })

  test('编排路径全源失败审计不回归 → 仍写多行 ok:false 轨迹（含正确 error_code），任务级 ERR_ALL_SOURCES_FAILED', async () => {
    // 编排层全源失败：resolveUrl 抛带 attempts 的错误（download 不会走到）
    orchestrator.resolveUrl = async () => {
      const err = new Error('所有音源在所有音质均未取到 URL（platform=tx）')
      ;(err as Error & { attempts?: ResolveAttempt[] }).attempts = [
        { quality: 'flac', sourceId: 'srcA', ok: false, error: 'HTTP 503', platform: 'tx' },
        { quality: '320k', sourceId: 'srcB', ok: false, error: 'request timeout', platform: 'tx' },
      ]
      throw err
    }
    downloader.download = origDownload // 编排先抛，download 不应被调用

    const id = await downloadQueue.enqueue({ platform: 'tx', musicInfo: mi('m1-allsrc'), quality: 'flac' })
    assert.equal(await waitTerminal(id), 'failed')

    const rows = downloadQueue.listAttempts(id)
    assert.equal(rows.length, 2, '编排全源失败应写两行换源/降级轨迹（既有行为不回归）')
    assert.equal(rows[0]!.source_id, 'srcA')
    assert.equal(rows[0]!.error_code, 'ERR_HTTP_5XX')
    assert.equal(rows[1]!.source_id, 'srcB')
    assert.equal(rows[1]!.error_code, 'ERR_TIMEOUT')
    assert.equal(rows[0]!.attempt_no, 1)
    assert.equal(rows[1]!.attempt_no, 1, '同轮跨源共享 attempt_no')
    // 任务级 errorCode 保持既有语义：attempts 数组 → ERR_ALL_SOURCES_FAILED
    assert.equal(downloadQueue.get(id)!.errorCode, 'ERR_ALL_SOURCES_FAILED')
  })
})
