/**
 * 配置深合并与设置页回写回归护栏（#135，固化 #127 的关键断言 + 回写审计取证）
 *
 * 覆盖三件事：
 *   1. **加载层深合并**（#127）：`loadConfig()` 用 `buildDefaultConfig('')` 补齐 YAML，
 *      使 config 对象结构恒完整。缺块 / 缺子树 / YAML 空值（`key:` → null）/ 路径留空
 *      这四类真实输入都不得让进程崩溃或让消费侧裸访问抛 TypeError。
 *   2. **展示层与调度器口径一致**（#126 M1 防线）：`settings.ts` 用 `=== true`，
 *      `smoke/scheduler.ts` 用 `if (!config.smokeTest.enabled) return`。两者对同一份配置
 *      必须恒同真假，否则重现「设置页显示已启用、冒烟测试实际从不跑」。
 *   3. **回写审计**（#135 ①）：`PATCH /settings` → `patchConfig()` → `saveConfig()` 落盘后，
 *      取证固化范围、用户显式值是否被改写、YAML 注释是否保留、password 是否被写入随机值。
 *      审计结论（行为可接受、不改实现）已写入 `src/core/config.ts` 的 `saveConfig()` 注释，
 *      本文件的 s7 / s8 / s9 / s10 就是那三条结论的取证载体：将来谁改了回写语义，这里会先红。
 *
 * 为什么整批走子进程：`src/core/config.ts` 在模块求值期就固化了 `CONFIG_PATH` 与
 * `export const config = loadConfig()`，一个进程只能加载一份配置；而这里要为 10 个场景
 * 各喂一份不同的 config.yaml。故每场景 spawn 一次 `fixtures/settings-probe.ts`，
 * 探针内注册**真实** settingsRoutes 并 inject GET/PATCH（不复刻 safeView，避免测试与实现脱钩）。
 *
 * 注意：本文件刻意**不用 import 引入探针模块**（连 `import type` 也不用）——探针是子进程
 * 入口，含顶层 `process.exit(0)`，一旦被测试进程加载就会当场终止 node:test。故 ProbeResult
 * 在此处独立声明，与探针的 ProbeOut 保持字段一致。
 */
import { SANDBOX_ROOT } from './fixtures/env-sandbox.js' // 必须是第一个 import：先设 RO_CONFIG/RO_DB_DIR 再连带求值 config.ts
import { test, before } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { execFile } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import YAML from 'yaml'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const SERVER_DIR = path.resolve(HERE, '..')
const PROBE = path.join(HERE, 'fixtures', 'settings-probe.ts')
// 直接用本地 node_modules/.bin/tsx，省掉 npx 的解析开销；缺失时回落 npx
const TSX_BIN = path.join(SERVER_DIR, 'node_modules', '.bin', 'tsx')
const USE_LOCAL_TSX = fs.existsSync(TSX_BIN)
const CMD = USE_LOCAL_TSX ? TSX_BIN : 'npx'
const CMD_ARGS = USE_LOCAL_TSX ? [PROBE] : ['tsx', PROBE]

// ── 场景 YAML ───────────────────────────────────────────────────────────────

/** s5 / s10 用的「完整显式配置」，逐项对齐 config.ts 的 buildDefaultConfig('')，
 *  也是真机 fpk `render_config()` 渲染出的形态（故它同时充当默认值基准与真机对照组） */
const FULL_YAML = `server:
  host: 0.0.0.0
  port: 23330
auth:
  enabled: true
  apiKey: ""
  webLogin:
    username: admin
    password: ""
download:
  dir: data/downloads
  concurrency: 3
  defaultQuality: flac
  nameTemplate: "{name} - {singer}"
  embedCover: true
  embedLyric: true
  coverSize: 500
sources:
  dir: data/sources
  hotReload: true
rateLimit:
  enabled: true
  windowMs: 60000
  max: 300
scrape:
  enabled: true
  autoOnComplete: true
  concurrency: 1
  timeoutMs: 8000
  retryMax: 2
  overwrite: false
  mbFallback: true
smokeTest:
  enabled: true
  cron: 0 6 * * *
  keyword: 周杰伦
  checkLyric: true
  checkPic: true
  alertThreshold: 2
  alert:
    bark:
      enabled: false
      serverUrl: https://api.day.app
      deviceKey: ""
    serverChan:
      enabled: false
      sendKey: ""
log:
  level: info
`

/** 默认值基准：从 FULL_YAML 解析而来，避免在测试里再抄一份常量（抄错就失去对照意义） */
const DEFAULTS = YAML.parse(FULL_YAML) as Record<string, Record<string, unknown>>

interface Scenario {
  name: string
  desc: string
  /** 写入 config.yaml 的原文；undefined 表示不创建文件，用以覆盖 ensureConfigFile() 首启路径 */
  yaml?: string
  /** PATCH body；undefined 表示只 GET 不 PATCH */
  patch?: Record<string, unknown>
}

const SCENARIOS: Scenario[] = [
  {
    name: 's1',
    desc: '缺 smokeTest.alert 子树',
    yaml: `server:
  port: 23330
smokeTest:
  enabled: true
  cron: 0 6 * * *
  keyword: 周杰伦
`,
  },
  {
    name: 's2',
    desc: '缺整个 auth 块（#126 M2 的原始触发输入）',
    yaml: `server:
  port: 23330
download:
  dir: data/downloads
  concurrency: 3
smokeTest:
  enabled: true
`,
  },
  {
    name: 's3',
    desc: 'smokeTest.enabled 为 YAML 空值 null（#126 M1 的原始触发输入）',
    yaml: `smokeTest:
  enabled:
`,
  },
  {
    name: 's4',
    desc: '全注释文件（YAML.parse 返回 null）',
    yaml: `# 这份配置只有注释，没有任何键
# YAML.parse 对它的返回值是 null
`,
  },
  { name: 's5', desc: '完整显式配置（真机 fpk 形态，加载对照组）', yaml: FULL_YAML },
  {
    name: 's6',
    desc: 'download.dir 与 sources.dir 留空（YAML 空值 null）',
    yaml: `download:
  dir:
sources:
  dir:
`,
  },
  {
    name: 's7',
    desc: '手工精简配置 + PATCH（回写审计主场景）',
    yaml: `# 用户手写注释：首次 PATCH 后本行是否还在，是回写审计的取证点
server:
  port: 23331   # 行尾注释同样是取证点
download:
  dir: data/downloads
smokeTest:
  enabled: false
`,
    patch: { download: { concurrency: 5 } },
  },
  {
    name: 's8',
    desc: '配置文件不存在 + PATCH（ensureConfigFile 首启路径，密码不得被改写）',
    patch: { smokeTest: { keyword: '林俊杰' } },
  },
  {
    name: 's9',
    desc: 'PATCH 显式关闭 smokeTest.enabled（关闭语义在回写后必须保持）',
    yaml: `smokeTest:
  enabled: true
`,
    patch: { smokeTest: { enabled: false } },
  },
  {
    name: 's10',
    desc: '完整显式配置 + PATCH（真机零固化对照组）',
    yaml: FULL_YAML,
    patch: { download: { concurrency: 6 } },
  },
]

// ── 探针结果类型（与 fixtures/settings-probe.ts 的 ProbeOut 字段一致，刻意不 import）──────

interface ProbeResult {
  ok: boolean
  error?: string
  config?: Record<string, unknown>
  getStatus?: number
  view?: Record<string, unknown> | null
  schedulerDisabled?: boolean
  passwordConfigured?: boolean
  passwordFingerprint?: string
  patchStatus?: number
  patchView?: Record<string, unknown> | null
  yamlBefore?: string
  yamlAfter?: string
  parsedAfter?: Record<string, unknown>
  configAfterPatch?: Record<string, unknown>
  schedulerDisabledAfter?: boolean
  passwordFingerprintAfter?: string
}

interface RunResult {
  sc: Scenario
  out?: ProbeResult
  /** 子进程层面的失败（无法启动 / 非 0 退出 / 结果行缺失），有值即代表本场景不可用 */
  failure?: string
}

const RESULTS = new Map<string, RunResult>()

/** 探针 stderr 可能含 ensureConfigFile 打印的一次性随机密码，呈现前先滤掉该行 */
function redact(text: string): string {
  return text
    .split('\n')
    .filter((line) => !/密\s*码|password/i.test(line))
    .join('\n')
}

function spawnProbe(env: NodeJS.ProcessEnv): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    execFile(
      CMD,
      CMD_ARGS,
      { env, cwd: SERVER_DIR, timeout: 180_000, maxBuffer: 16 * 1024 * 1024 },
      (err, stdout, stderr) => {
        const errCode = (err as { code?: unknown } | null)?.code
        const code = err ? (typeof errCode === 'number' ? errCode : 1) : 0
        resolve({ code, stdout: String(stdout), stderr: String(stderr) })
      },
    )
  })
}

async function runScenario(sc: Scenario): Promise<RunResult> {
  const dir = fs.mkdtempSync(path.join(SANDBOX_ROOT, `cfg-${sc.name}-`))
  const dbDir = path.join(dir, 'db')
  fs.mkdirSync(dbDir, { recursive: true })
  const cfgPath = path.join(dir, 'config.yaml')
  if (sc.yaml !== undefined) fs.writeFileSync(cfgPath, sc.yaml, 'utf8')

  const env: NodeJS.ProcessEnv = {
    PATH: process.env.PATH,
    HOME: process.env.HOME,
    RO_CONFIG: cfgPath,
    RO_DB_DIR: dbDir,
    // 刻意不设 RO_LOG_LEVEL：它会经 applyEnvOverrides 改写 config.log.level，
    // 而 PATCH 落盘会把该 env 值一并固化进 yaml，污染 s7/s10 的固化取证
  }
  if (sc.patch !== undefined) env.PROBE_PATCH = JSON.stringify(sc.patch)

  const { code, stdout, stderr } = await spawnProbe(env)
  const marker = '@@PROBE@@'
  const line = stdout.split('\n').find((l) => l.startsWith(marker))
  if (line === undefined) {
    return {
      sc,
      failure: `探针未输出结果行（退出码 ${code}）\n--- stderr ---\n${redact(stderr).trim()}`,
    }
  }
  try {
    return { sc, out: JSON.parse(line.slice(marker.length)) as ProbeResult }
  } catch (err) {
    return { sc, failure: `探针结果行无法解析：${String(err)}` }
  }
}

before(async () => {
  // 串行执行：并发 spawn 十个 tsx 会同时加载 better-sqlite3 原生模块，得不偿失
  for (const sc of SCENARIOS) {
    RESULTS.set(sc.name, await runScenario(sc))
  }
})

/** 取某场景的探针结果；子进程失败或探针内部异常都在此就地报错，避免后续断言空转 */
function must(name: string): ProbeResult {
  const r = RESULTS.get(name)
  assert.ok(r, `场景 ${name} 未被执行（SCENARIOS 里没有它）`)
  assert.equal(r.failure, undefined, `场景 ${name}（${r.sc.desc}）子进程失败：\n${r.failure ?? ''}`)
  const out = r.out as ProbeResult
  assert.equal(out.ok, true, `场景 ${name}（${r.sc.desc}）探针内部抛异常：${out.error ?? '(未提供错误信息)'}`)
  return out
}

/** 按点号路径取值（中途遇到非对象即返回 undefined，不抛错） */
function pick(obj: unknown, dotted: string): unknown {
  let cur: unknown = obj
  for (const seg of dotted.split('.')) {
    if (cur === null || typeof cur !== 'object') return undefined
    cur = (cur as Record<string, unknown>)[seg]
  }
  return cur
}

/**
 * safeView() 的结构契约：字段路径 → 期望 typeof。
 * 这份表是「视图结构完整」的判据；将来 safeView 增删字段时必须同步改这里，
 * 否则测试会失败——这正是所要的强制对齐。
 */
const VIEW_SHAPE: Array<[string, string]> = [
  ['auth.apiKeySet', 'boolean'],
  ['download.concurrency', 'number'],
  ['download.defaultQuality', 'string'],
  ['download.nameTemplate', 'string'],
  ['download.embedCover', 'boolean'],
  ['download.embedLyric', 'boolean'],
  ['download.coverSize', 'number'],
  ['download.resolvedDir', 'string'],
  ['download.startupResolvedDir', 'string'],
  ['scrape.enabled', 'boolean'],
  ['scrape.autoOnComplete', 'boolean'],
  ['smokeTest.enabled', 'boolean'],
  ['smokeTest.cron', 'string'],
  ['smokeTest.keyword', 'string'],
  ['smokeTest.checkLyric', 'boolean'],
  ['smokeTest.checkPic', 'boolean'],
  ['smokeTest.alertThreshold', 'number'],
  ['smokeTest.alert.bark.enabled', 'boolean'],
  ['smokeTest.alert.bark.serverUrl', 'string'],
  ['smokeTest.alert.bark.deviceKeySet', 'boolean'],
  ['smokeTest.alert.serverChan.enabled', 'boolean'],
  ['smokeTest.alert.serverChan.sendKeySet', 'boolean'],
]

function assertViewShape(view: Record<string, unknown> | null | undefined, where: string): void {
  assert.ok(view !== null && view !== undefined, `${where}：视图为空（GET 未返回 200 或响应体不是对象）`)
  for (const [dotted, expected] of VIEW_SHAPE) {
    const actual = pick(view, dotted)
    assert.equal(typeof actual, expected, `${where}：视图字段 ${dotted} 应为 ${expected}，实为 ${typeof actual}（值 ${JSON.stringify(actual)}）`)
  }
}

/**
 * M1 一致性：展示层 `smokeTest.enabled === true` 与调度层 `!config.smokeTest.enabled`
 * 必须恒同真假。#126 的故障形态是 YAML 空值让展示层显示「已勾选」而调度器实际禁用。
 */
function assertM1(out: ProbeResult, where: string): void {
  const shown = pick(out.view, 'smokeTest.enabled')
  assert.equal(typeof shown, 'boolean', `${where}：展示层 enabled 必须是布尔值，实为 ${typeof shown}`)
  assert.equal(typeof out.schedulerDisabled, 'boolean', `${where}：调度层判定缺失`)
  assert.equal(shown, !out.schedulerDisabled, `${where}：M1 背离——设置页显示 enabled=${String(shown)}，而调度器按 !enabled 判定为${out.schedulerDisabled === true ? '禁用' : '启用'}`)
}

// ── 通用三项断言（对全部 10 个场景逐一执行）──────────────────────────────────

for (const sc of SCENARIOS) {
  const label = `${sc.name} ${sc.desc}`

  test(`${label} → loadConfig 不抛错`, () => {
    const out = must(sc.name)
    assert.ok(out.config !== undefined, 'loadConfig() 未产出配置对象')
    assert.equal(typeof out.config, 'object')
  })

  test(`${label} → GET /settings 返回 200 且视图结构完整`, () => {
    const out = must(sc.name)
    assert.equal(out.getStatus, 200, 'GET /api/v1/settings 未返回 200')
    assertViewShape(out.view, label)
  })

  test(`${label} → 展示层 enabled 与调度器 !enabled 判定一致（M1 防线）`, () => {
    assertM1(must(sc.name), label)
  })
}

// ── s1 缺 smokeTest.alert 子树 ──────────────────────────────────────────────

test('s1 alert 子树被补齐为完整两层结构（bark / serverChan 均在位）', () => {
  const out = must('s1')
  const alert = pick(out.config, 'smokeTest.alert') as Record<string, unknown>
  assert.ok(alert !== null && typeof alert === 'object', 'alert 子树缺失，消费侧裸访问会抛 TypeError')
  assert.equal(typeof pick(alert, 'bark.serverUrl'), 'string')
  assert.equal(typeof pick(alert, 'bark.enabled'), 'boolean')
  assert.equal(typeof pick(alert, 'serverChan.enabled'), 'boolean')
  assert.equal(typeof pick(alert, 'serverChan.sendKey'), 'string')
})

test('s1 alert 缺省值等于内置默认值（bark/serverChan 默认关闭、serverUrl 为官方地址）', () => {
  const out = must('s1')
  // 视图把密钥字段换成 *Set 布尔量，故这里比对的是 safeView 的口径而非 config 原值
  assert.deepEqual(pick(out.view, 'smokeTest.alert'), {
    bark: { enabled: false, serverUrl: 'https://api.day.app', deviceKeySet: false },
    serverChan: { enabled: false, sendKeySet: false },
  })
  // config 侧的原值同样回落内置默认（deviceKey / sendKey 为空串）
  assert.deepEqual(pick(out.config, 'smokeTest.alert'), DEFAULTS['smokeTest']!['alert'])
})

test('s1 用户已写的 smokeTest 兄弟字段不被默认值覆盖', () => {
  const out = must('s1')
  assert.equal(pick(out.config, 'smokeTest.keyword'), '周杰伦')
  assert.equal(pick(out.config, 'smokeTest.cron'), '0 6 * * *')
  assert.equal(pick(out.config, 'server.port'), 23330)
})

// ── s2 缺整个 auth 块 ───────────────────────────────────────────────────────

test('s2 auth 块被补齐，apiKeySet 为 false 而非抛错（#126 M2 的根治点）', () => {
  const out = must('s2')
  assert.ok(pick(out.config, 'auth') !== undefined, 'auth 块缺失')
  assert.equal(pick(out.view, 'auth.apiKeySet'), false)
  assert.equal(out.getStatus, 200)
})

test('s2 缺 auth 块时 password 回落空串，「未配置密码」语义保持', () => {
  const out = must('s2')
  assert.equal(out.passwordConfigured, false, 'isPasswordConfigured() 必须为 false，否则 routes/auth.ts 的明确提示退化为静默不可登录')
  assert.equal(out.passwordFingerprint, '', '空串指纹为空，非空即代表注入了随机密码')
  assert.equal(pick(out.config, 'auth.webLogin.password'), '')
})

test('s2 缺 auth 块时其余块仍按 YAML 原值生效（合并不是整体替换）', () => {
  const out = must('s2')
  assert.equal(pick(out.config, 'download.concurrency'), 3)
  assert.equal(pick(out.config, 'smokeTest.enabled'), true)
})

// ── s3 smokeTest.enabled 为 YAML 空值 null ──────────────────────────────────

test('s3 YAML 空值 null 回落内置默认值 true，而非保留 null', () => {
  const out = must('s3')
  const enabled = pick(out.config, 'smokeTest.enabled')
  assert.equal(enabled, true)
  assert.equal(typeof enabled, 'boolean', 'null 未被合并层消化，消费侧仍需各自兜 null')
})

test('s3 展示层与调度层对 null 输入同判为「启用」（#126 M1 的原始故障输入）', () => {
  const out = must('s3')
  assert.equal(pick(out.view, 'smokeTest.enabled'), true)
  assert.equal(out.schedulerDisabled, false)
  assertM1(out, 's3')
})

test('s3 null 只影响该字段，同块其余字段照常回落默认值', () => {
  const out = must('s3')
  assert.equal(pick(out.config, 'smokeTest.checkLyric'), true)
  assert.equal(pick(out.config, 'smokeTest.checkPic'), true)
  assert.equal(pick(out.config, 'smokeTest.alertThreshold'), 2)
  assert.equal(pick(out.view, 'smokeTest.alert.bark.enabled'), false)
})

// ── s4 全注释文件 ───────────────────────────────────────────────────────────

test('s4 全注释文件（YAML.parse 返回 null）等价于全默认配置，不崩', () => {
  const out = must('s4')
  const s5 = must('s5')
  // 两者唯一的差别只可能来自 YAML 是否写了键；全注释等于什么都没写，故运行态必须逐项相同
  assert.deepEqual(out.config, s5.config, '全注释文件应与「显式写全默认值」的配置产出完全相同的运行态')
  assert.equal(out.passwordFingerprint, '', '全注释文件不得注入随机密码')
})

// ── s5 完整显式配置（加载对照组）────────────────────────────────────────────

test('s5 完整配置经深合并后逐项保持原值（合并不得改写用户显式值）', () => {
  const out = must('s5')
  const cfg = out.config as Record<string, unknown>
  // 路径字段在 loadConfig 里被 resolve 为绝对路径，故单独按「以默认相对路径结尾」判定
  for (const block of Object.keys(DEFAULTS)) {
    if (block === 'download' || block === 'sources') continue
    assert.deepEqual(cfg[block], DEFAULTS[block], `块 ${block} 与显式 YAML 不一致`)
  }
  assert.ok(String(pick(cfg, 'download.dir')).endsWith('data/downloads'))
  assert.ok(String(pick(cfg, 'sources.dir')).endsWith('data/sources'))
  assert.equal(pick(cfg, 'download.concurrency'), 3)
  assert.equal(pick(cfg, 'download.nameTemplate'), '{name} - {singer}')
})

test('s5 完整配置下 scrape 可选块在位（settings.ts 的 config.scrape?.enabled 依赖它）', () => {
  const out = must('s5')
  assert.equal(pick(out.config, 'scrape.enabled'), true)
  assert.equal(pick(out.config, 'scrape.mbFallback'), true)
  assert.equal(pick(out.view, 'scrape.enabled'), true)
  assert.equal(pick(out.view, 'scrape.autoOnComplete'), true)
})

// ── s6 download.dir / sources.dir 留空 ──────────────────────────────────────

test('s6 路径留空回落默认相对路径，path.resolve 不抛 TypeError（启动即崩的防线）', () => {
  const out = must('s6')
  const dir = pick(out.config, 'download.dir')
  assert.equal(typeof dir, 'string')
  assert.ok(path.isAbsolute(String(dir)), '解析后必须是绝对路径')
  assert.ok(String(dir).endsWith('data/downloads'), `实际值 ${String(dir)}`)
  assert.ok(String(pick(out.config, 'sources.dir')).endsWith('data/sources'))
})

test('s6 路径留空时视图的 resolvedDir / startupResolvedDir 同为绝对路径且一致', () => {
  const out = must('s6')
  const resolved = pick(out.view, 'download.resolvedDir')
  const startup = pick(out.view, 'download.startupResolvedDir')
  assert.equal(typeof resolved, 'string')
  assert.ok(path.isAbsolute(String(resolved)))
  assert.equal(resolved, startup, '未 PATCH 过目录时两者必须相同，否则前端会误显示「待重启」角标')
})

// ── s7 回写审计主场景 ───────────────────────────────────────────────────────

test('s7 PATCH 返回 200，落盘确实发生（yamlAfter 与 yamlBefore 不同）', () => {
  const out = must('s7')
  assert.equal(out.patchStatus, 200)
  assert.ok(out.yamlBefore !== undefined && out.yamlAfter !== undefined)
  assert.notEqual(out.yamlAfter, out.yamlBefore)
})

test('s7 固化取证：落盘后顶层块由 3 个增至 8 个（用户从未写过的字段被写成显式默认值）', () => {
  const out = must('s7')
  const before = Object.keys(YAML.parse(out.yamlBefore as string) as object).sort()
  const after = Object.keys(out.parsedAfter as object).sort()
  assert.deepEqual(before, ['download', 'server', 'smokeTest'])
  assert.deepEqual(after, ['auth', 'download', 'log', 'rateLimit', 'scrape', 'server', 'smokeTest', 'sources'])
  const added = after.filter((k) => !before.includes(k))
  assert.deepEqual(added, ['auth', 'log', 'rateLimit', 'scrape', 'sources'], '新增固化块清单')
})

test('s7 固化值等于内置默认值（故将来改 buildDefaultConfig 对已 PATCH 用户失效——这是记录在案的代价）', () => {
  const out = must('s7')
  const after = out.parsedAfter as Record<string, unknown>
  for (const block of ['auth', 'log', 'rateLimit', 'scrape', 'sources']) {
    assert.deepEqual(after[block], DEFAULTS[block], `固化块 ${block} 的值与内置默认值不一致`)
  }
})

test('s7 用户显式值不被改写：port / smokeTest.enabled / 相对路径写法均原样保留', () => {
  const out = must('s7')
  const after = out.parsedAfter as Record<string, Record<string, unknown>>
  assert.equal(after['server']!['port'], 23331)
  assert.equal(after['smokeTest']!['enabled'], false, '用户显式写的 false 不得被默认值 true 盖掉')
  assert.equal(after['download']!['dir'], 'data/downloads', '原本写作相对路径的字段回写时仍相对化')
  assert.equal(after['download']!['concurrency'], 5, '本次 PATCH 的值必须落盘')
})

test('s7 注释取证：saveConfig 会抹掉 YAML 注释并按自身风格重排版（既有行为，非 #127 引入）', () => {
  const out = must('s7')
  assert.ok((out.yamlBefore as string).includes('#'), '前提：PATCH 前的 yaml 确实含注释')
  assert.ok(!(out.yamlAfter as string).includes('#'), '落盘后注释仍在——与 saveConfig 的 YAML.stringify 实现不符')
})

test('s7 password 取证：落盘值恒为空串，绝不固化随机强密码（#127 决策 4 的例外）', () => {
  const out = must('s7')
  assert.equal(out.passwordFingerprint, '')
  assert.equal(out.passwordFingerprintAfter, '', 'PATCH 后指纹变化即代表密码被改写')
  const after = out.parsedAfter as Record<string, Record<string, unknown>>
  const webLogin = after['auth']!['webLogin'] as Record<string, unknown>
  assert.equal(webLogin['password'], '')
  assert.ok(out.configAfterPatch !== undefined, 'PATCH 后未回传运行态配置快照')
  assert.equal(pick(out.configAfterPatch, 'download.concurrency'), 5)
})

test('s7 PATCH 后展示层与调度层仍同判（M1 一致性不因回写而破坏）', () => {
  const out = must('s7')
  const shown = pick(out.patchView, 'smokeTest.enabled')
  assert.equal(shown, false)
  assert.equal(out.schedulerDisabledAfter, true)
  assert.equal(shown, !out.schedulerDisabledAfter)
})

// ── s8 配置文件不存在（ensureConfigFile 首启路径）────────────────────────────

test('s8 配置文件不存在时自动生成，密码为随机强密码且 isPasswordConfigured 为 true', () => {
  const out = must('s8')
  assert.equal(out.passwordConfigured, true)
  assert.ok((out.passwordFingerprint ?? '').length === 12, '随机密码应产生非空指纹')
  // ensureConfigFile() 在 config.ts 模块求值期就跑了，故探针读到的 before 已是自动生成的内容
  const before = out.yamlBefore as string
  assert.ok(before.trimStart().startsWith('#'), '首启生成的文件应带文件头注释')
  const generated = YAML.parse(before) as Record<string, Record<string, unknown>>
  const pwd = (generated['auth']!['webLogin'] as Record<string, unknown>)['password']
  assert.ok(typeof pwd === 'string' && pwd.length >= 12, '生成的密码应已落盘（否则重启后无人能登录）')
})

test('s8 取证：首启生成的文件头注释同样会在首次 PATCH 时被抹掉（既有 strip 行为的具体后果）', () => {
  const out = must('s8')
  assert.ok((out.yamlBefore as string).includes('#'), '前提：首启文件含注释')
  assert.ok(!(out.yamlAfter as string).includes('#'), '落盘后注释仍在——与 saveConfig 的 YAML.stringify 实现不符')
  // 密码本身不受影响：注释消失不等于凭据丢失
  assert.equal(out.passwordFingerprintAfter, out.passwordFingerprint)
})

test('s8 PATCH 不改写既有密码：落盘前后指纹完全相同', () => {
  const out = must('s8')
  assert.equal(out.patchStatus, 200)
  assert.equal(out.passwordFingerprintAfter, out.passwordFingerprint)
})

test('s8 落盘密码等于 ensureConfigFile 生成的原值（saveConfig 只回写已有值，不新造）', () => {
  const out = must('s8')
  const after = out.parsedAfter as Record<string, Record<string, unknown>>
  const pwd = (after['auth']!['webLogin'] as Record<string, unknown>)['password']
  assert.equal(typeof pwd, 'string')
  assert.ok((pwd as string).length > 0)
  // 用指纹反证：落盘值的指纹必须与 PATCH 前一致
  assert.equal(out.passwordFingerprintAfter, out.passwordFingerprint)
})

test('s8 首启路径下 PATCH 的关键字修改正确落盘', () => {
  const out = must('s8')
  const after = out.parsedAfter as Record<string, Record<string, unknown>>
  assert.equal(after['smokeTest']!['keyword'], '林俊杰')
})

// ── s9 PATCH 显式关闭 ───────────────────────────────────────────────────────

test('s9 PATCH enabled=false 后落盘为显式 false（关闭语义不被深合并吃掉）', () => {
  const out = must('s9')
  assert.equal(out.patchStatus, 200)
  const after = out.parsedAfter as Record<string, Record<string, unknown>>
  assert.equal(after['smokeTest']!['enabled'], false)
})

test('s9 关闭后调度器判定为禁用、展示层同步为 false（M1 一致性在回写后仍成立）', () => {
  const out = must('s9')
  assert.equal(out.schedulerDisabledAfter, true)
  assert.equal(pick(out.patchView, 'smokeTest.enabled'), false)
  assert.equal(pick(out.patchView, 'smokeTest.enabled'), !out.schedulerDisabledAfter)
})

test('s9 运行态 config 对象被原地更新（无需重读文件即生效）', () => {
  const out = must('s9')
  assert.equal(pick(out.configAfterPatch, 'smokeTest.enabled'), false)
  assert.equal(pick(out.config, 'smokeTest.enabled'), true, '前提：PATCH 前为 true')
})

// ── s10 真机零固化对照组 ────────────────────────────────────────────────────

test('s10 完整配置 PATCH 后顶层块集合不变（真机 fpk 路径固化零影响的直接证据）', () => {
  const out = must('s10')
  const before = Object.keys(YAML.parse(out.yamlBefore as string) as object).sort()
  const after = Object.keys(out.parsedAfter as object).sort()
  assert.deepEqual(after, before, '真机模板已显式写全全部顶层块，PATCH 不应新增任何块')
})

test('s10 完整配置 PATCH 后除被改字段外逐项等值（回写不产生语义漂移）', () => {
  const out = must('s10')
  const before = YAML.parse(out.yamlBefore as string) as Record<string, Record<string, unknown>>
  const after = out.parsedAfter as Record<string, Record<string, unknown>>
  const expected = JSON.parse(JSON.stringify(before)) as Record<string, Record<string, unknown>>
  expected['download']!['concurrency'] = 6
  assert.deepEqual(after, expected)
})

test('s10 完整配置 PATCH 后 password 仍为空串（真机模板写空串的场景同样不被注入随机值）', () => {
  const out = must('s10')
  assert.equal(out.passwordFingerprint, '')
  assert.equal(out.passwordFingerprintAfter, '')
})

// ── 跨场景不变量 ────────────────────────────────────────────────────────────

test('全部场景：合并后 config 恒含 RoConfig 的 8 个顶层块（结构完整性总闸）', () => {
  const expected = Object.keys(DEFAULTS).sort()
  for (const sc of SCENARIOS) {
    const out = must(sc.name)
    assert.deepEqual(Object.keys(out.config as object).sort(), expected, `场景 ${sc.name}（${sc.desc}）顶层块不完整`)
  }
})

test('全部场景：布尔配置字段合并后一律为真布尔值，绝无 null（消费侧无需再兜 null）', () => {
  const boolPaths = ['auth.enabled', 'download.embedCover', 'download.embedLyric', 'sources.hotReload',
    'rateLimit.enabled', 'scrape.enabled', 'scrape.autoOnComplete', 'scrape.overwrite', 'scrape.mbFallback',
    'smokeTest.enabled', 'smokeTest.checkLyric', 'smokeTest.checkPic',
    'smokeTest.alert.bark.enabled', 'smokeTest.alert.serverChan.enabled']
  for (const sc of SCENARIOS) {
    const out = must(sc.name)
    for (const p of boolPaths) {
      assert.equal(typeof pick(out.config, p), 'boolean', `场景 ${sc.name}（${sc.desc}）字段 ${p} 不是布尔值`)
    }
  }
})

test('全部执行过 PATCH 的场景：落盘文件均可被 YAML 重新解析且结构完整（回写产物自洽）', () => {
  const patched = SCENARIOS.filter((s) => s.patch !== undefined)
  assert.ok(patched.length >= 4, '前提：本批至少有 4 个 PATCH 场景')
  for (const sc of patched) {
    const out = must(sc.name)
    assert.equal(out.patchStatus, 200, `场景 ${sc.name} PATCH 未成功`)
    const reparsed = YAML.parse(out.yamlAfter as string) as Record<string, unknown>
    assert.deepEqual(Object.keys(reparsed).sort(), Object.keys(DEFAULTS).sort(), `场景 ${sc.name} 落盘产物顶层块不完整`)
  }
})

