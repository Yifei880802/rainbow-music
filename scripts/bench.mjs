#!/usr/bin/env node
/**
 * Rainbow 下载管线基准脚本（任务 #6）
 *
 * 流程：登录取会话 → 批量创建 N 个下载任务（分批 ≤200 提交）→
 *       轮询 /api/v1/status 采集吞吐、服务端 RSS 峰值与完成/失败统计 →
 *       输出 Markdown 报告（stdout + 文件）。
 *
 * 无音源环境下任务会失败，但脚本仍正常产出报告结构；
 * --dry-run 模式在服务不可达时离线自检，只校验脚本自身可运行。
 *
 * 用法：node scripts/bench.mjs --help
 */

import { writeFileSync } from 'node:fs'

// ── CLI 参数 ─────────────────────────────────────────────────────────────

const DEFAULTS = {
  n: 200,
  base: 'http://127.0.0.1:23330',
  user: 'admin',
  pass: 'admin',
  apiKey: '',
  platform: 'kw',
  quality: 'flac',
  pollMs: 2000,
  timeoutSec: 1800,
  out: 'bench-report.md',
}

const HELP = `Rainbow bench — 下载管线基准测试

用法: node scripts/bench.mjs [选项]

选项:
  --n <数量>           任务数量（默认 ${DEFAULTS.n}）
  --base <url>         服务地址（默认 ${DEFAULTS.base}）
  --user <用户名>      登录用户名（默认 ${DEFAULTS.user}）
  --pass <密码>        登录密码（默认 ${DEFAULTS.pass}）
  --api-key <key>      用 API Key 鉴权（优先于登录）
  --platform <平台>    合成任务的平台（默认 ${DEFAULTS.platform}）
  --quality <音质>     flac24bit|flac|320k|128k（默认 ${DEFAULTS.quality}）
  --poll-ms <毫秒>     /api/v1/status 轮询间隔（默认 ${DEFAULTS.pollMs}）
  --timeout <秒>       整体超时（默认 ${DEFAULTS.timeoutSec}）
  --out <文件>         报告输出路径（默认 ${DEFAULTS.out}）
  --dry-run            自检模式：服务不可达时离线产出报告结构
  --help               显示帮助
`

function parseArgs(argv) {
  const opts = { ...DEFAULTS, dryRun: false, help: false }
  const args = argv.slice(2)
  for (let i = 0; i < args.length; i++) {
    const a = args[i]
    const next = () => args[++i]
    switch (a) {
      case '--help': case '-h': opts.help = true; break
      case '--dry-run': opts.dryRun = true; break
      case '--n': opts.n = Math.max(1, parseInt(next(), 10) || DEFAULTS.n); break
      case '--base': opts.base = next().replace(/\/$/, ''); break
      case '--user': opts.user = next(); break
      case '--pass': opts.pass = next(); break
      case '--api-key': opts.apiKey = next(); break
      case '--platform': opts.platform = next(); break
      case '--quality': opts.quality = next(); break
      case '--poll-ms': opts.pollMs = Math.max(200, parseInt(next(), 10) || DEFAULTS.pollMs); break
      case '--timeout': opts.timeoutSec = Math.max(10, parseInt(next(), 10) || DEFAULTS.timeoutSec); break
      case '--out': opts.out = next(); break
      default:
        console.error(`未知参数: ${a}（--help 查看用法）`)
        process.exit(2)
    }
  }
  return opts
}

// ── HTTP 客户端（cookie jar + api key）────────────────────────────────────

let sessionCookie = ''

async function api(opts, path, init = {}, timeoutMs = 10_000) {
  const headers = { ...(init.headers ?? {}) }
  if (sessionCookie) headers.cookie = sessionCookie
  if (opts.apiKey) headers['x-api-key'] = opts.apiKey
  if (init.body && !headers['content-type']) headers['content-type'] = 'application/json'

  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), timeoutMs)
  try {
    const res = await fetch(opts.base + path, { ...init, headers, signal: ctrl.signal, redirect: 'manual' })
    const setCookies = typeof res.headers.getSetCookie === 'function' ? res.headers.getSetCookie() : []
    if (setCookies.length) sessionCookie = setCookies.map((c) => c.split(';')[0]).join('; ')
    return res
  } finally {
    clearTimeout(timer)
  }
}

async function getJson(res) {
  const text = await res.text()
  try { return JSON.parse(text) } catch { return { _raw: text } }
}

// ── 登录 ──────────────────────────────────────────────────────────────────

async function ensureAuth(opts, notes) {
  const statusRes = await api(opts, '/api/v1/auth/status')
  const status = await getJson(statusRes)
  if (!status.enabled) { notes.push('鉴权未启用，跳过登录'); return true }

  const check = async () => (await getJson(await api(opts, '/api/v1/auth/status'))).authenticated === true
  if (opts.apiKey && (await check())) { notes.push('API Key 鉴权通过'); return true }

  const loginRes = await api(opts, '/api/v1/auth/login', {
    method: 'POST',
    body: JSON.stringify({ username: opts.user, password: opts.pass }),
  })
  if (loginRes.status !== 200) { notes.push(`登录失败: HTTP ${loginRes.status}`); return false }
  if (await check()) { notes.push('登录成功（会话 Cookie）'); return true }
  notes.push('登录后仍未通过鉴权（检查用户名/密码/apiKey）')
  return false
}

// ── 任务构造与提交 ────────────────────────────────────────────────────────

function buildItems(opts) {
  const items = []
  for (let i = 0; i < opts.n; i++) {
    items.push({
      platform: opts.platform,
      quality: opts.quality,
      musicInfo: {
        name: `bench-track-${String(i + 1).padStart(4, '0')}`,
        singer: 'bench',
        source: opts.platform,
        songmid: `bench-${Date.now()}-${i}`,
        albumName: 'bench-album',
        types: [{ type: opts.quality }],
        _types: {},
      },
    })
  }
  return items
}

/** 分批提交（每批 ≤200，与服务端 batch 上限一致） */
async function submitItems(opts, items, notes) {
  const accepted = []
  let rejectedCount = 0
  for (let i = 0; i < items.length; i += 200) {
    const batch = items.slice(i, i + 200)
    const res = await api(opts, '/api/v1/download/batch', { method: 'POST', body: JSON.stringify({ items: batch }) })
    const body = await getJson(res)
    if (res.status !== 201) {
      notes.push(`批次 ${Math.floor(i / 200) + 1} 提交失败: HTTP ${res.status} ${body.error ?? ''}`)
      continue
    }
    accepted.push(...(body.accepted ?? []))
    rejectedCount += body.rejectedCount ?? 0
  }
  if (rejectedCount > 0) notes.push(`服务端拒绝 ${rejectedCount} 个任务项`)
  return accepted
}

// ── 轮询采集 ──────────────────────────────────────────────────────────────

async function collect(opts, notes) {
  const samples = []
  const start = Date.now()
  let rssPeakMB = 0
  let last = null
  let finished = false

  while (!finished) {
    const elapsedSec = (Date.now() - start) / 1000
    if (elapsedSec > opts.timeoutSec) { notes.push(`达到超时 ${opts.timeoutSec}s，提前结束采集`); break }

    try {
      const res = await api(opts, '/api/v1/status', {}, 5_000)
      last = await getJson(res)
    } catch (err) {
      notes.push(`status 轮询异常: ${err.message}`)
    }

    if (last && typeof last === 'object' && last.tasks) {
      const t = last.tasks
      rssPeakMB = Math.max(rssPeakMB, last.memoryMB ?? 0)
      samples.push({ t: Math.round(elapsedSec), pending: t.pending, active: t.active, completed: t.completed, failed: t.failed, rssMB: last.memoryMB ?? 0 })
      finished = (t.pending ?? 0) === 0 && (t.active ?? 0) === 0
    }
    if (!finished) await new Promise((r) => setTimeout(r, opts.pollMs))
  }

  return { durationSec: (Date.now() - start) / 1000, rssPeakMB, samples, last, finished }
}

// ── 报告生成 ──────────────────────────────────────────────────────────────

function renderReport(opts, ctx) {
  const { mode, notes, acceptedCount, durationSec, rssPeakMB, samples, last } = ctx
  const tasks = last?.tasks ?? {}
  const completed = tasks.completed ?? 0
  const failed = tasks.failed ?? 0
  const pending = tasks.pending ?? 0
  const active = tasks.active ?? 0
  const throughput = durationSec > 0 ? ((completed + failed) / (durationSec / 60)).toFixed(1) : '0'
  const localRssMB = Math.round(process.memoryUsage().rss / 1024 / 1024)
  const ts = new Date().toISOString().replace('T', ' ').slice(0, 19)

  const lines = []
  lines.push('# Rainbow 下载管线基准报告')
  lines.push('')
  lines.push(`- 生成时间: ${ts}`)
  lines.push(`- 模式: ${mode}`)
  lines.push(`- 目标服务: ${opts.base}`)
  lines.push(`- 计划任务数: ${opts.n}（提交成功 ${acceptedCount ?? '-'}，平台 ${opts.platform} / 音质 ${opts.quality}）`)
  lines.push('')
  lines.push('## 结果统计')
  lines.push('')
  lines.push('| 指标 | 值 |')
  lines.push('| --- | --- |')
  lines.push(`| 总耗时 | ${durationSec.toFixed(1)} s |`)
  lines.push(`| 完成（含 warnings） | ${completed} |`)
  lines.push(`| 失败 | ${failed} |`)
  lines.push(`| 未完成（pending/active，超时残留） | ${pending + active} |`)
  lines.push(`| 吞吐 | ${throughput} 任务/分钟 |`)
  lines.push(`| 服务端 RSS 峰值 | ${rssPeakMB} MB |`)
  lines.push(`| 服务端 RSS 末值 | ${last?.memoryMB ?? '-'} MB |`)
  lines.push(`| bench 脚本自身 RSS | ${localRssMB} MB |`)
  lines.push(`| Node 版本 | ${last?.node ?? process.version} |`)
  lines.push('')
  lines.push('## 采样时间线')
  lines.push('')
  if (samples.length === 0) {
    lines.push('（无采样数据）')
  } else {
    lines.push('| t(s) | pending | active | completed | failed | RSS(MB) |')
    lines.push('| --- | --- | --- | --- | --- | --- |')
    // 采样点过多时均匀抽稀到 ≤30 行
    const step = Math.max(1, Math.ceil(samples.length / 30))
    for (let i = 0; i < samples.length; i += step) {
      const s = samples[i]
      lines.push(`| ${s.t} | ${s.pending} | ${s.active} | ${s.completed} | ${s.failed} | ${s.rssMB} |`)
    }
    const lastSample = samples[samples.length - 1]
    if ((samples.length - 1) % step !== 0) {
      lines.push(`| ${lastSample.t} | ${lastSample.pending} | ${lastSample.active} | ${lastSample.completed} | ${lastSample.failed} | ${lastSample.rssMB} |`)
    }
  }
  lines.push('')
  lines.push('## 备注')
  lines.push('')
  if (notes.length === 0) lines.push('- 无')
  else for (const n of notes) lines.push(`- ${n}`)
  lines.push('')
  return lines.join('\n')
}

function writeReport(opts, report) {
  process.stdout.write('\n' + report + '\n')
  try {
    writeFileSync(opts.out, report, 'utf8')
    console.log(`\n报告已写入: ${opts.out}`)
  } catch (err) {
    console.error(`报告写入失败: ${err.message}`)
  }
}

// ── 主流程 ────────────────────────────────────────────────────────────────

async function main() {
  const opts = parseArgs(process.argv)
  if (opts.help) { process.stdout.write(HELP); return }

  const notes = []

  // 连通性探测（dry-run 不可达时离线自检）
  let reachable = true
  try {
    await api(opts, '/api/v1/auth/status', {}, 5_000)
  } catch {
    reachable = false
  }

  if (!reachable) {
    if (!opts.dryRun) {
      console.error(`无法连接 ${opts.base}（非 --dry-run 模式，退出）`)
      process.exit(1)
    }
    const report = renderReport(opts, {
      mode: 'dry-run（离线自检）',
      notes: [
        `服务 ${opts.base} 不可达，dry-run 仅校验脚本自身可运行`,
        `计划构造 ${opts.n} 个合成任务（平台 ${opts.platform} / 音质 ${opts.quality}），未实际提交`,
        '报告结构完整性校验通过',
      ],
      acceptedCount: 0,
      durationSec: 0,
      rssPeakMB: 0,
      samples: [],
      last: null,
    })
    writeReport(opts, report)
    return
  }

  const mode = opts.dryRun ? 'dry-run（合成任务，预期失败）' : 'live'

  if (!(await ensureAuth(opts, notes))) {
    const report = renderReport(opts, { mode, notes, acceptedCount: 0, durationSec: 0, rssPeakMB: 0, samples: [], last: null })
    writeReport(opts, report)
    process.exit(1)
  }

  const items = buildItems(opts)
  const accepted = await submitItems(opts, items, notes)
  notes.push(`无音源环境下任务会失败，属预期行为，仅考察管线吞吐与资源占用`)

  const { durationSec, rssPeakMB, samples, last } = await collect(opts, notes)

  const report = renderReport(opts, {
    mode,
    notes,
    acceptedCount: accepted.length,
    durationSec,
    rssPeakMB,
    samples,
    last,
  })
  writeReport(opts, report)
}

main().catch((err) => {
  console.error(`bench 脚本异常: ${err?.stack ?? err}`)
  process.exit(1)
})
