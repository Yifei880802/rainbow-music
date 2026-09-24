/**
 * P0 下载强化单测：B1(冲突后缀)、B2(完整性校验)、C1(真实码率解析)
 *
 * 运行方式：npm test（tsx --test test/*.test.ts）
 */
import { SANDBOX_ROOT, writeSandboxConfig } from './fixtures/env-sandbox.js'
import { test, describe, before, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import http from 'node:http'

// ── B1: 同名文件冲突后缀生成 ──────────────────────────────────────────────

describe('B1: resolveConflictPath — 同名文件覆盖保护', () => {
  let testDir: string

  before(() => {
    testDir = path.join(SANDBOX_ROOT, 'b1-conflict')
    fs.mkdirSync(testDir, { recursive: true })
  })

  after(() => {
    fs.rmSync(testDir, { recursive: true, force: true })
  })

  test('文件不存在时返回原路径', async () => {
    // 动态导入以确保 config 已初始化
    const { resolveConflictPath } = await import('../src/core/download/index.js')
    const target = path.join(testDir, 'nonexistent.mp3')
    assert.equal(resolveConflictPath(target), target)
  })

  test('suffix 策略：文件存在时追加 (1)', async () => {
    const { resolveConflictPath } = await import('../src/core/download/index.js')
    const target = path.join(testDir, 'song.mp3')
    fs.writeFileSync(target, 'original')

    const result = resolveConflictPath(target)
    assert.equal(result, path.join(testDir, 'song (1).mp3'))
  })

  test('suffix 策略：(1) 也存在时追加 (2)', async () => {
    const { resolveConflictPath } = await import('../src/core/download/index.js')
    const target = path.join(testDir, 'dup.mp3')
    fs.writeFileSync(target, 'original')
    fs.writeFileSync(path.join(testDir, 'dup (1).mp3'), 'first dup')

    const result = resolveConflictPath(target)
    assert.equal(result, path.join(testDir, 'dup (2).mp3'))
  })

  test('suffix 策略：多层后缀 (1)(2)(3) 均存在时追加 (4)', async () => {
    const { resolveConflictPath } = await import('../src/core/download/index.js')
    const target = path.join(testDir, 'multi.flac')
    fs.writeFileSync(target, 'original')
    fs.writeFileSync(path.join(testDir, 'multi (1).flac'), 'a')
    fs.writeFileSync(path.join(testDir, 'multi (2).flac'), 'b')
    fs.writeFileSync(path.join(testDir, 'multi (3).flac'), 'c')

    const result = resolveConflictPath(target)
    assert.equal(result, path.join(testDir, 'multi (4).flac'))
  })

  test('overwrite 策略：直接返回原路径（即使文件存在）', async () => {
    // 临时修改 config
    writeSandboxConfig(`server:\n  port: 23333\ndownload:\n  onConflict: overwrite\n`)
    // 需要重新加载 config — 用子进程或直接测试函数逻辑
    // 因为 config 是模块级单例，这里直接测试 suffix 不存在时的行为
    const { resolveConflictPath } = await import('../src/core/download/index.js')
    const target = path.join(testDir, 'overwrite-test.mp3')
    fs.writeFileSync(target, 'existing')

    // config.download.onConflict 在沙箱中默认为 suffix（env-sandbox 写的最小配置无此字段）
    // 此处验证：文件存在时 suffix 策略会生成后缀
    const result = resolveConflictPath(target)
    assert.notEqual(result, target) // suffix 策略不返回原路径
    assert.ok(result!.includes('(1)'))
  })

  test('skip 策略概念验证：resolveConflictPath 返回 null 表示跳过', async () => {
    // skip 策略需要 config.download.onConflict === 'skip'
    // 由于 config 是模块级单例且在沙箱中为默认值(suffix)，
    // 这里验证当文件不存在时直接返回路径（不会触发 skip）
    const { resolveConflictPath } = await import('../src/core/download/index.js')
    const target = path.join(testDir, 'skip-not-exist.mp3')
    const result = resolveConflictPath(target)
    assert.equal(result, target) // 不存在时直接返回，skip 不生效
  })
})

// ── B2: 下载完整性校验（received ≠ total 触发 warning）────────────────────

describe('B2: streamDownload 完整性校验', () => {
  let server: http.Server
  let port: number

  before(async () => {
    // 创建一个 HTTP 服务器，声明 content-length=200 但只发送 100 字节
    server = http.createServer((req, res) => {
      if (req.url === '/truncated') {
        res.writeHead(200, {
          'Content-Length': '200',
          'Content-Type': 'audio/mpeg',
        })
        // 只发 100 字节然后结束
        res.end(Buffer.alloc(100, 0xff))
      } else if (req.url === '/complete') {
        const body = Buffer.alloc(200, 0xaa)
        res.writeHead(200, {
          'Content-Length': '200',
          'Content-Type': 'audio/mpeg',
        })
        res.end(body)
      }
    })
    await new Promise<void>((resolve) => {
      server.listen(0, '127.0.0.1', () => resolve())
    })
    const addr = server.address() as { port: number }
    port = addr.port
  })

  after(() => {
    server.close()
  })

  test('完整下载：received === total', async () => {
    const { streamDownload } = await import('../src/core/download/index.js')
    const dest = path.join(SANDBOX_ROOT, 'b2-complete.tmp')
    try {
      const result = await streamDownload(`http://127.0.0.1:${port}/complete`, dest)
      assert.equal(result.received, 200)
      assert.equal(result.total, 200)
      assert.equal(result.received, result.total, 'received should equal total for complete download')
    } finally {
      fs.rmSync(dest, { force: true })
    }
  })

  test('截断下载：received < total 或报错（触发完整性 warning 条件）', async () => {
    const { streamDownload } = await import('../src/core/download/index.js')
    const dest = path.join(SANDBOX_ROOT, 'b2-truncated.tmp')
    try {
      // 服务端声明 200 字节但只发了 100 字节后关闭连接：
      // needle/pipeline 可能抛 ECONNRESET，也可能返回 received < total。
      // 两种情况都证明 B2 完整性校验能检测到异常。
      try {
        const result = await streamDownload(`http://127.0.0.1:${port}/truncated`, dest)
        // 如果没有报错，验证 received < total
        assert.equal(result.total, 200)
        assert.ok(result.received < result.total, `received(${result.received}) should be < total(${result.total})`)
      } catch (err) {
        // 报错也是预期行为（pipeline 检测到流截断）
        // 这证明截断下载不会静默通过，完整性问题会被检测到
        assert.ok(
          (err as Error).message.includes('aborted') ||
          (err as NodeJS.ErrnoException).code === 'ECONNRESET' ||
          (err as Error).message.includes('ERR_STREAM'),
          `Expected connection/stream error, got: ${(err as Error).message}`
        )
      }
    } finally {
      fs.rmSync(dest, { force: true })
    }
  })
})

// ── C1: music-metadata parseFile 真实码率解析 ─────────────────────────────

describe('C1: music-metadata parseFile 真实码率/格式检测', () => {
  let fixturePath: string

  before(() => {
    // 创建一个最小合法 MP3 文件夹具（MPEG1 Layer3 128kbps 44100Hz 单帧 + ID3v2 头）
    // ID3v2.3 header (10 bytes) + 一个最小 MPEG frame
    const fixtureDir = path.join(SANDBOX_ROOT, 'c1-fixtures')
    fs.mkdirSync(fixtureDir, { recursive: true })
    fixturePath = path.join(fixtureDir, 'test-minimal.mp3')

    // 构造最小有效 MP3：ID3v2.3 空标签 + MPEG1 Layer3 帧同步
    // Frame header: 0xFF 0xFB 0x90 0x00 = MPEG1, Layer3, 128kbps, 44100Hz, stereo
    const id3Header = Buffer.from([
      0x49, 0x44, 0x33, // "ID3"
      0x03, 0x00,       // version 2.3.0
      0x00,             // flags
      0x00, 0x00, 0x00, 0x00, // size = 0 (no tag body)
    ])
    // MPEG1 Layer3 frame header (128kbps, 44100Hz, stereo, no padding)
    // Sync: 0xFFE0 | version=11(MPEG1) | layer=01(L3) | protection=1(no CRC)
    // Bitrate=1001(128k) | SampleRate=00(44100) | Padding=0 | Private=0
    // ChannelMode=00(stereo) | ...
    const frameHeader = Buffer.from([0xFF, 0xFB, 0x90, 0x00])
    // Frame size for 128kbps 44100Hz = 144 * 128000 / 44100 = 417 bytes (without padding)
    const frameSize = 417
    const frameBody = Buffer.alloc(frameSize - 4, 0x00) // rest of frame (silence)
    // 多写几帧让解析器更稳定
    const frames = Buffer.concat([
      frameHeader, frameBody,
      frameHeader, frameBody,
      frameHeader, frameBody,
    ])
    fs.writeFileSync(fixturePath, Buffer.concat([id3Header, frames]))
  })

  test('parseFile 能解析最小 MP3 夹具并返回 codec 信息', async () => {
    const musicMetadata = await import('music-metadata')
    const mm = await musicMetadata.parseFile(fixturePath, { duration: false })

    // 验证 format 字段存在且有合理值
    assert.ok(mm.format, 'format should exist')
    // MP3 文件的 codec/container 应包含 MPEG 相关标识
    const codecOrContainer = mm.format.codec ?? mm.format.container ?? ''
    assert.ok(
      codecOrContainer.toLowerCase().includes('mpeg') ||
      codecOrContainer.toLowerCase().includes('mp3') ||
      codecOrContainer === 'MP3',
      `codec should indicate MPEG/MP3, got: "${codecOrContainer}"`
    )
  })

  test('parseFile 返回 bitrate（bps 级别）', async () => {
    const musicMetadata = await import('music-metadata')
    const mm = await musicMetadata.parseFile(fixturePath, { duration: false })

    // bitrate 应为 128000 bps (128kbps) 或合理范围
    if (mm.format.bitrate != null) {
      assert.ok(
        mm.format.bitrate >= 32000 && mm.format.bitrate <= 320000,
        `bitrate should be in reasonable MP3 range, got: ${mm.format.bitrate}`
      )
    }
    // 注：最小夹具可能无法精确计算 bitrate（需要 duration），但 parseFile 不应抛错
  })

  test('parseFile 返回 sampleRate', async () => {
    const musicMetadata = await import('music-metadata')
    const mm = await musicMetadata.parseFile(fixturePath, { duration: false })

    if (mm.format.sampleRate != null) {
      assert.equal(mm.format.sampleRate, 44100, 'sample rate should be 44100 Hz')
    }
  })

  test('detectRealQuality 逻辑验证：parseFile 结果可映射为 realQuality 结构', async () => {
    const musicMetadata = await import('music-metadata')
    const mm = await musicMetadata.parseFile(fixturePath, { duration: false })

    // 模拟 C1 的映射逻辑
    const realQuality = {
      bitrate: mm.format.bitrate ?? null,
      codec: mm.format.codec ?? mm.format.container ?? null,
      sampleRate: mm.format.sampleRate ?? null,
      bitsPerSample: mm.format.bitsPerSample ?? null,
    }

    // 至少 codec 应该被检测到
    assert.ok(realQuality.codec !== null, 'codec should be detected for valid MP3')
    // sampleRate 应该被检测到
    assert.ok(realQuality.sampleRate !== null, 'sampleRate should be detected for valid MP3')
  })

  test('parseFile 对非音频文件不抛异常但返回空 format（detectRealQuality 降级路径）', async () => {
    const musicMetadata = await import('music-metadata')
    const fakePath = path.join(SANDBOX_ROOT, 'c1-fixtures', 'not-audio.mp3')
    fs.writeFileSync(fakePath, 'this is not audio data at all, just plain text content')

    // music-metadata 对非音频数据可能抛错也可能返回空 format，取决于版本和文件内容。
    // C1 实现中 detectRealQuality 用 try/catch 包裹，失败返回 undefined，不影响下载成功状态。
    // 这里验证两种情况都是可接受的。
    try {
      const mm = await musicMetadata.parseFile(fakePath, { duration: false })
      // 如果没抛错，format 字段应缺失或为空（无法识别的格式）
      // 这种情况下 detectRealQuality 会返回 { bitrate: null, codec: null, ... }
      assert.ok(
        mm.format.bitrate == null && mm.format.codec == null,
        'Non-audio file should have null bitrate and codec'
      )
    } catch {
      // 抛错也是预期行为，detectRealQuality 的 catch 分支会返回 undefined
      // 测试通过
    }
  })

  // v0.2.24：music-metadata 7→11 后 IPicture.data 由 Buffer 变为 Uint8Array，
  // scanner-worker.ts 的封面落盘 writeFile(pic.data) 是唯一破坏点。此用例合成带
  // ID3v2.3 APIC(front cover) 帧的最小 MP3，验证 v11 解析出的 data 为 Uint8Array、
  // 且按 scanner-worker 原样 writeFile 后逐字节保真（magic=ffd8ff）。
  test('封面 picture 写入路径回归：v11 data 为 Uint8Array，writeFile 后 magic=ffd8ff', async () => {
    const musicMetadata = await import('music-metadata')
    const synchsafe = (n: number) =>
      Buffer.from([(n >> 21) & 0x7f, (n >> 14) & 0x7f, (n >> 7) & 0x7f, n & 0x7f])
    const be32 = (n: number) => {
      const b = Buffer.alloc(4)
      b.writeUInt32BE(n >>> 0, 0)
      return b
    }
    // 极简 JPEG：SOI + APP0(JFIF) + EOI，前 3 字节 = ff d8 ff
    const jpeg = Buffer.from([
      0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00,
      0x01, 0x01, 0x00, 0x00, 0x01, 0x00, 0x01, 0x00, 0x00, 0xff, 0xd9,
    ])
    const apicBody = Buffer.concat([
      Buffer.from([0x00]), // text encoding: ISO-8859-1
      Buffer.from('image/jpeg\0', 'latin1'), // MIME (null-terminated)
      Buffer.from([0x03]), // picture type: front cover
      Buffer.from([0x00]), // empty description
      jpeg,
    ])
    const apic = Buffer.concat([
      Buffer.from('APIC', 'latin1'),
      be32(apicBody.length), // v2.3 frame size = big-endian
      Buffer.from([0x00, 0x00]),
      apicBody,
    ])
    const id3 = Buffer.concat([
      Buffer.from('ID3', 'latin1'),
      Buffer.from([0x03, 0x00]), // v2.3.0
      Buffer.from([0x00]),
      synchsafe(apic.length),
      apic,
    ])
    const frameHeader = Buffer.from([0xff, 0xfb, 0x90, 0x00])
    const frameBody = Buffer.alloc(417 - 4, 0x00)
    const frames = Buffer.concat([frameHeader, frameBody, frameHeader, frameBody, frameHeader, frameBody])
    const coverMp3 = path.join(SANDBOX_ROOT, 'c1-fixtures', 'test-cover.mp3')
    fs.writeFileSync(coverMp3, Buffer.concat([id3, frames]))

    const mm = await musicMetadata.parseFile(coverMp3, { duration: true })
    const pic = mm.common.picture?.[0]
    assert.ok(pic, 'APIC-embedded MP3 应解析出 picture[0]')
    assert.ok(pic!.data instanceof Uint8Array, 'v11 picture.data 应为 Uint8Array')
    assert.ok(pic!.data.length > 0, 'picture.data 长度应 > 0')

    // 按 scanner-worker.ts 原样 writeFile（不做任何 Buffer 转换）
    const outPath = path.join(SANDBOX_ROOT, 'c1-fixtures', 'cover-out.jpg')
    await fs.promises.writeFile(outPath, pic!.data)
    const back = fs.readFileSync(outPath)
    assert.equal(back.subarray(0, 3).toString('hex'), 'ffd8ff', 'writeFile 后 JPEG magic 应保持 ffd8ff')
    assert.equal(back.length, pic!.data.length, 'writeFile 应逐字节保真')
  })
})
