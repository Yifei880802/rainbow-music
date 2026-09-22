/**
 * P1 下载引擎强化单测：
 *   F1 HTTP 错误分级（Transient/Permanent）
 *   F2 断点续传 Range（206 append / 200 truncate / ETag 失配重下）
 *   H5 入队去重/幂等（skip / always-new + DB 去重查询）
 *
 * 运行方式：npm test（tsx --test test/*.test.ts，不依赖 build）
 */
import { SANDBOX_ROOT } from './fixtures/env-sandbox.js'
import { test, describe, before, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import http from 'node:http'
import {
  makeHttpError,
  isTransientHttpError,
  isPermanentHttpError,
  isHttpStatusError,
  TransientHttpError,
  PermanentHttpError,
  streamDownload,
} from '../src/core/download/index.js'
import { taskStore, type DownloadTaskRow } from '../src/core/db/index.js'
import { downloadQueue } from '../src/core/download/queue.js'
import { config } from '../src/core/config.js'
import type { MusicInfo } from '../src/core/adapters/common.js'

// ── F1: HTTP 错误分级 ─────────────────────────────────────────────────────

describe('F1: HTTP 错误分级（Transient vs Permanent）', () => {
  test('429/500/502/503/504 → TransientHttpError（可退避重试/换源）', () => {
    for (const code of [429, 500, 502, 503, 504]) {
      const err = makeHttpError(code)
      assert.ok(err instanceof TransientHttpError, `${code} 应为 TransientHttpError`)
      assert.equal(err.name, 'TransientHttpError')
      assert.equal(err.httpStatus, code)
      assert.equal(isTransientHttpError(err), true, `${code} isTransientHttpError`)
      assert.equal(isPermanentHttpError(err), false, `${code} 不应为 permanent`)
      assert.equal(isHttpStatusError(err), true)
    }
  })

  test('400/401/403/404/410 → PermanentHttpError（队列熔断不重试）', () => {
    for (const code of [400, 401, 403, 404, 410]) {
      const err = makeHttpError(code)
      assert.ok(err instanceof PermanentHttpError, `${code} 应为 PermanentHttpError`)
      assert.equal(err.name, 'PermanentHttpError')
      assert.equal(err.httpStatus, code)
      assert.equal(isPermanentHttpError(err), true, `${code} isPermanentHttpError`)
      assert.equal(isTransientHttpError(err), false, `${code} 不应为 transient`)
    }
  })

  test('非受控错误（普通 Error / 仅有 httpStatus 的第三方错误）不被误判', () => {
    assert.equal(isHttpStatusError(new Error('boom')), false)
    assert.equal(isTransientHttpError(new Error('boom')), false)
    assert.equal(isPermanentHttpError(new Error('boom')), false)
    // 鸭子类型收窄：仅带 httpStatus 但 name 不在集合内 → 不识别
    const fake = Object.assign(new Error('fake'), { httpStatus: 404 })
    assert.equal(isHttpStatusError(fake), false)
    assert.equal(isPermanentHttpError(fake), false)
  })

  test('streamDownload 对 503 抛 TransientHttpError、对 404 抛 PermanentHttpError', async () => {
    const server = http.createServer((req, res) => {
      if (req.url === '/http-503') {
        res.writeHead(503, { 'Content-Length': '0' })
        res.end()
      } else if (req.url === '/http-404') {
        res.writeHead(404, { 'Content-Length': '0' })
        res.end()
      } else {
        res.writeHead(200, { 'Content-Length': '0' })
        res.end()
      }
    })
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()))
    const port = (server.address() as { port: number }).port
    const dest = path.join(SANDBOX_ROOT, 'f1-http.tmp')
    try {
      await assert.rejects(
        () => streamDownload(`http://127.0.0.1:${port}/http-503`, dest),
        (err: unknown) => isTransientHttpError(err) && (err as { httpStatus: number }).httpStatus === 503,
      )
      await assert.rejects(
        () => streamDownload(`http://127.0.0.1:${port}/http-404`, dest),
        (err: unknown) => isPermanentHttpError(err) && (err as { httpStatus: number }).httpStatus === 404,
      )
    } finally {
      server.close()
      fs.rmSync(dest, { force: true })
      fs.rmSync(`${dest}.meta`, { force: true })
    }
  })
})

// ── F2: 断点续传 Range（206 / 200 / ETag 失配）──────────────────────────

describe('F2: streamDownload 断点续传（Range 206/200/ETag 失配）', () => {
  let server: http.Server
  let base: string
  let dir: string

  // full1：支持 Range 的稳定资源（ETag "v1"）；resume200：忽略 Range 恒回 200；
  // changed：内容已变更（ETag "new"），Range 仍回 206 但 ETag 与旁挂 "old" 失配
  const full1 = Buffer.from(Array.from({ length: 200 }, (_, i) => i % 256))
  const fullNew = Buffer.from(Array.from({ length: 200 }, (_, i) => (i + 7) % 256))

  before(async () => {
    dir = path.join(SANDBOX_ROOT, 'f2-resume')
    fs.mkdirSync(dir, { recursive: true })
    server = http.createServer((req, res) => {
      const url = req.url ?? '/'
      const range = req.headers.range
      const send = (buf: Buffer, etag: string, honorRange: boolean): void => {
        const m = honorRange ? /^bytes=(\d+)-$/.exec(range ?? '') : null
        if (m) {
          const start = parseInt(m[1]!, 10)
          const slice = buf.subarray(start)
          res.writeHead(206, {
            'Content-Length': String(slice.length),
            'Content-Range': `bytes ${start}-${buf.length - 1}/${buf.length}`,
            'Content-Type': 'audio/mpeg',
            ETag: etag,
            'Accept-Ranges': 'bytes',
          })
          res.end(slice)
          return
        }
        res.writeHead(200, {
          'Content-Length': String(buf.length),
          'Content-Type': 'audio/mpeg',
          ETag: etag,
          'Accept-Ranges': 'bytes',
        })
        res.end(buf)
      }
      if (url === '/resume-ok') send(full1, '"v1"', true)
      else if (url === '/resume-200') send(full1, '"v1"', false) // 忽略 Range
      else if (url === '/changed') send(fullNew, '"new"', true) // 内容已变更
      else {
        res.writeHead(404, { 'Content-Length': '0' })
        res.end()
      }
    })
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()))
    base = `http://127.0.0.1:${(server.address() as { port: number }).port}`
  })

  after(() => {
    server.close()
    fs.rmSync(dir, { recursive: true, force: true })
  })

  test('206 append：已有 100 字节断点，Range 续传补齐至完整 200 字节', async () => {
    const dest = path.join(dir, 'ok.tmp')
    fs.writeFileSync(dest, full1.subarray(0, 100)) // 断点：前 100 字节
    fs.writeFileSync(`${dest}.meta`, JSON.stringify({ etag: '"v1"', lastModified: null })) // 旁挂元数据匹配

    const r = await streamDownload(`${base}/resume-ok`, dest, undefined, { resume: true })
    assert.equal(r.resumed, true, '应标记为续传（206 append）')
    assert.equal(r.written, 200, 'written = baseOffset(100) + received(100)')
    assert.equal(r.expectedSize, 200, 'expectedSize 从 Content-Range 全量解析')
    assert.equal(r.received, 100, 'received 仅本次响应体字节')
    assert.deepEqual(fs.readFileSync(dest), full1, '落盘内容应为完整文件')
    fs.rmSync(dest, { force: true })
    fs.rmSync(`${dest}.meta`, { force: true })
  })

  test('200 truncate：服务端忽略 Range 回 200，断点被丢弃并全量重写', async () => {
    const dest = path.join(dir, 'trunc.tmp')
    fs.writeFileSync(dest, Buffer.alloc(100, 0x5a)) // 脏断点（内容与目标不符）
    fs.writeFileSync(`${dest}.meta`, JSON.stringify({ etag: '"v1"', lastModified: null }))

    const r = await streamDownload(`${base}/resume-200`, dest, undefined, { resume: true })
    assert.equal(r.resumed, false, '200 全量 → 非续传')
    assert.equal(r.written, 200)
    assert.deepEqual(fs.readFileSync(dest), full1, '应被 truncate 重写为完整新内容')
    fs.rmSync(dest, { force: true })
    fs.rmSync(`${dest}.meta`, { force: true })
  })

  test('ETag 失配：内容已变更 → 丢弃断点从头重下（避免拼接损坏文件）', async () => {
    const dest = path.join(dir, 'changed.tmp')
    fs.writeFileSync(dest, full1.subarray(0, 100)) // 旧内容的前 100 字节
    fs.writeFileSync(`${dest}.meta`, JSON.stringify({ etag: '"old"', lastModified: null })) // 旁挂旧 ETag

    const r = await streamDownload(`${base}/changed`, dest, undefined, { resume: true })
    // 检测到 ETag 失配后删断点、重发不带 Range 的请求 → 200 全量新内容
    assert.equal(r.resumed, false, 'ETag 失配后应从头重下（非续传）')
    assert.equal(r.written, 200)
    assert.deepEqual(fs.readFileSync(dest), fullNew, '落盘内容应为变更后的完整新内容')
    fs.rmSync(dest, { force: true })
    fs.rmSync(`${dest}.meta`, { force: true })
  })

  test('resume 未启用时行为等同全量下载（不带 Range，truncate 写）', async () => {
    const dest = path.join(dir, 'noresume.tmp')
    fs.writeFileSync(dest, Buffer.alloc(100, 0x11)) // 已存在文件应被覆盖
    const r = await streamDownload(`${base}/resume-ok`, dest) // 无 opts.resume
    assert.equal(r.resumed, false)
    assert.equal(r.written, 200)
    assert.deepEqual(fs.readFileSync(dest), full1)
    fs.rmSync(dest, { force: true })
    fs.rmSync(`${dest}.meta`, { force: true })
  })
})

// ── H5: 入队去重/幂等 ─────────────────────────────────────────────────────

/** 构造一条完整 DownloadTaskRow（仅测试用，字段取合理默认） */
function makeRow(o: Partial<DownloadTaskRow> & { id: string; platform: string; songmid: string }): DownloadTaskRow {
  const now = Date.now()
  return {
    keyword_source: o.platform,
    name: 'n',
    singer: 's',
    album: '',
    requested_quality: 'flac',
    actual_quality: null,
    actual_source: null,
    music_info: '{}',
    status: 'pending',
    progress: 0,
    file_path: null,
    file_size: null,
    warnings: null,
    error: null,
    requeue_count: 0,
    scrape_status: 'pending',
    scrape_info: null,
    actual_bitrate: null,
    actual_codec: null,
    actual_sample_rate: null,
    batch_id: null,
    created_at: now,
    updated_at: now,
    ...o,
  } as DownloadTaskRow
}

function mi(songmid: string): MusicInfo {
  return { songmid, name: `song-${songmid}`, singer: 'singer', source: 'tx' } as unknown as MusicInfo
}

describe('H5: enqueue 去重/幂等 + DB 去重查询', () => {
  test('taskStore.findDuplicate：pending/active/completed 命中，canceled/failed 忽略，音质须匹配', () => {
    taskStore.insert(makeRow({ id: 'fd-pending', platform: 'wy', songmid: 'S2', requested_quality: '320k', status: 'pending' }))
    taskStore.insert(makeRow({ id: 'fd-canceled', platform: 'wy', songmid: 'S3', requested_quality: '320k', status: 'canceled' }))
    taskStore.insert(makeRow({ id: 'fd-failed', platform: 'wy', songmid: 'S4', requested_quality: '320k', status: 'failed' }))

    assert.equal(taskStore.findDuplicate('wy', 'S2', '320k')?.id, 'fd-pending')
    assert.equal(taskStore.findDuplicate('wy', 'S3', '320k'), undefined, 'canceled 不算重复')
    assert.equal(taskStore.findDuplicate('wy', 'S4', '320k'), undefined, 'failed 不算重复')
    assert.equal(taskStore.findDuplicate('wy', 'S2', 'flac'), undefined, '音质不同不算重复')
  })

  test('taskStore.findCompletedWithFile：仅 completed 且带落盘文件命中', () => {
    taskStore.insert(makeRow({ id: 'cw-1', platform: 'mg', songmid: 'S10', status: 'completed', file_path: '/tmp/a.mp3' }))
    taskStore.insert(makeRow({ id: 'cw-2', platform: 'mg', songmid: 'S11', status: 'completed', file_path: null }))
    taskStore.insert(makeRow({ id: 'cw-3', platform: 'mg', songmid: 'S12', status: 'pending', file_path: '/tmp/c.mp3' }))

    assert.equal(taskStore.findCompletedWithFile('mg', 'S10')?.id, 'cw-1')
    assert.equal(taskStore.findCompletedWithFile('mg', 'S11'), undefined, '无文件不算已拥有')
    assert.equal(taskStore.findCompletedWithFile('mg', 'S12'), undefined, '未完成不算已拥有')
  })

  test('dedupePolicy=skip（默认）：命中已完成重复项 → 复用既有 id，不新建任务', async () => {
    assert.equal(config.download.dedupePolicy ?? 'skip', 'skip', '沙箱默认应为 skip')
    const dupId = 'h5-dup-completed'
    taskStore.insert(makeRow({ id: dupId, platform: 'tx', songmid: 'S20', requested_quality: 'flac', status: 'completed', file_path: '/tmp/x.mp3' }))

    const pendingBefore = taskStore.count('pending')
    const returned = await downloadQueue.enqueue({ platform: 'tx', musicInfo: mi('S20'), quality: 'flac' })
    assert.equal(returned, dupId, 'skip 应复用既有完成任务 id')
    assert.equal(taskStore.count('pending'), pendingBefore, '不应新建任何 pending 任务')
  })

  test('dedupePolicy=always-new：即便存在重复项也新建任务（返回不同 id）', async () => {
    const prev = config.download.dedupePolicy
    config.download.dedupePolicy = 'always-new'
    try {
      const newId = await downloadQueue.enqueue({ platform: 'tx', musicInfo: mi('S20'), quality: 'flac' })
      // 立即取消，阻止后台 run() 触发真实下载（无音源环境下会失败）
      downloadQueue.cancel(newId)
      assert.notEqual(newId, 'h5-dup-completed', 'always-new 应生成全新任务 id')
      assert.ok(taskStore.get(newId), '新任务应已入库')
    } finally {
      config.download.dedupePolicy = prev
    }
  })
})
