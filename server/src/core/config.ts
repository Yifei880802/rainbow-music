import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { fileURLToPath } from 'node:url'
import YAML from 'yaml'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
// server/src/core → 项目根目录 ro/
export const ROOT_DIR = path.resolve(__dirname, '../../..')

export interface RoConfig {
  server: { host: string; port: number }
  auth: {
    enabled: boolean
    apiKey: string
    webLogin: { username: string; password: string }
  }
  download: {
    dir: string
    concurrency: number
    defaultQuality: 'flac24bit' | 'flac' | '320k' | '128k'
    nameTemplate: string
    embedCover: boolean
    embedLyric: boolean
    coverSize: number
    // ── #6 下载管线性能加固新增项（全部可选；yaml 未提供时代码侧用默认值，不影响既有字段与首启逻辑）──
    autoConcurrency?: boolean        // 默认 true：并发 = clamp(CPU核数, 2, 6)；false 时以 concurrency 手动值优先
    retryMax?: number                // 任务失败自动重试次数，默认 3
    retryBaseDelayMs?: number        // 重试指数退避基础延迟，默认 1000（1s/2s/4s）
    progressFlushIntervalMs?: number // 进度落盘节流：时间阈值(ms)，默认 500
    progressFlushPercentStep?: number// 进度落盘节流：百分比阈值，默认 2
    memGuardIntervalMs?: number      // RSS 采样周期(ms)，默认 5000
    memLimitMB?: number              // RSS 暂停出队阈值(MB)，默认 400
    batchActivationSize?: number     // 批量任务分批激活上限，默认 200
    tagWorkers?: number              // 元数据嵌入 worker 数，默认 clamp(floor(CPU/2), 1, 2)
    // ── #6 新增项结束 ──
  }
  sources: { dir: string; hotReload: boolean }
  rateLimit: { enabled: boolean; windowMs: number; max: number }
  // ── #45 自动刮削（全部可选；yaml 未提供时代码侧用默认值，见 scrape.ts 的 scrapeConfig()）──
  scrape?: {
    enabled?: boolean        // 总开关（false 时零行为变化），默认 true
    autoOnComplete?: boolean // 下载完成后自动刮削（模式 A），默认 true
    concurrency?: number     // 刮削并发 1-4，默认 1（后台任务无需时延，平台接口低压）
    timeoutMs?: number       // 平台详情接口超时，默认 8000
    retryMax?: number        // failed 自动重试上限，默认 2（间隔 5s/15s）
    overwrite?: boolean      // 覆盖已有标签字段（默认只补缺），默认 false
    mbFallback?: boolean     // #47 MusicBrainz L2 兜底补 albumArtist（五平台详情均不提供），默认 true
  }
  smokeTest: {
    enabled: boolean
    cron: string
    keyword: string
    checkLyric: boolean
    checkPic: boolean
    alertThreshold: number
    alert: {
      bark: { enabled: boolean; serverUrl: string; deviceKey: string }
      serverChan: { enabled: boolean; sendKey: string }
    }
  }
  log: { level: string }
}

const CONFIG_PATH = process.env.RO_CONFIG ?? path.join(ROOT_DIR, 'config.yaml')

// yaml 里这两个路径原本是否写作相对路径。
// 写回时只对「原本就是相对路径」的做相对化；fnOS 场景用户常配
// 绝对路径（如 /vol1/1000/downloads），不得强制相对化。
let downloadDirWasRelative = true
let sourcesDirWasRelative = true

// config.yaml 中是否显式存在 download.concurrency 字段（来源标记）：
// 显式存在时手动并发值优先于自适应，仅缺省时才走 clamp(CPU, 2, 6)
let downloadConcurrencyExplicit = false
export function isConcurrencyExplicit(): boolean {
  return downloadConcurrencyExplicit
}

/** 生成随机强密码：大小写 + 数字 + 符号，各至少 1 个（剔除易混淆字符） */
function randomStrongPassword(len = 18): string {
  const lower = 'abcdefghjkmnpqrstuvwxyz'
  const upper = 'ABCDEFGHJKMNPQRSTUVWXYZ'
  const digits = '23456789'
  const symbols = '!@#$%^&*+-=_'
  const all = lower + upper + digits + symbols
  const chars = [
    lower[crypto.randomInt(lower.length)]!,
    upper[crypto.randomInt(upper.length)]!,
    digits[crypto.randomInt(digits.length)]!,
    symbols[crypto.randomInt(symbols.length)]!,
  ]
  while (chars.length < len) chars.push(all[crypto.randomInt(all.length)]!)
  // Fisher–Yates 洗牌，避免特征字符固定在前几位
  for (let i = chars.length - 1; i > 0; i--) {
    const j = crypto.randomInt(i + 1)
    ;[chars[i], chars[j]] = [chars[j]!, chars[i]!]
  }
  return chars.join('')
}

/**
 * 内置默认配置（结构与仓库 config.example.yaml 一致）。
 *
 * @param password webLogin.password 的取值；**只有缺省时才随机生成强密码**。两个调用方
 *   口径不同，不可混用：
 *   - `ensureConfigFile()` 走缺省（随机强密码 + 日志打印一次）：配置文件本就不存在，
 *     密码必须当场生成并让用户看到，否则无人能登录；
 *   - `loadConfig()` 的默认值深合并传 `''`：配置文件已存在、只是没写 password 字段，
 *     此时注入随机密码会让 `isPasswordConfigured()` 由 false 变 true —— `routes/auth.ts`
 *     那条「尚未设置登录密码，请在 config.yaml 的 auth.webLogin.password 配置后重启」的
 *     400 明确提示，退化为「密码已设但无人知晓」的静默不可登录；且首次 PATCH 会经
 *     `saveConfig()` 把这个随机密码静默落盘。空串保持「未配置」语义不变。
 */
function buildDefaultConfig(password?: string): RoConfig {
  return {
    server: { host: '0.0.0.0', port: 23330 },
    auth: {
      enabled: true,
      apiKey: '',
      webLogin: { username: 'admin', password: password ?? randomStrongPassword() },
    },
    download: {
      dir: 'data/downloads',
      concurrency: 3,
      defaultQuality: 'flac',
      nameTemplate: '{name} - {singer}',
      embedCover: true,
      embedLyric: true,
      coverSize: 500,
    },
    sources: { dir: 'data/sources', hotReload: true },
    rateLimit: { enabled: true, windowMs: 60000, max: 300 },
    scrape: {
      enabled: true,
      autoOnComplete: true,
      concurrency: 1,
      timeoutMs: 8000,
      retryMax: 2,
      overwrite: false,
      mbFallback: true,
    },
    smokeTest: {
      enabled: true,
      cron: '0 6 * * *',
      keyword: '周杰伦',
      checkLyric: true,
      checkPic: true,
      alertThreshold: 2,
      alert: {
        bark: { enabled: false, serverUrl: 'https://api.day.app', deviceKey: '' },
        serverChan: { enabled: false, sendKey: '' },
      },
    },
    log: { level: 'info' },
  }
}

/**
 * 首次启动（fpk 场景 etc 目录初始为空）：配置文件不存在时自动从内置默认值生成。
 * Web 登录密码随机生成并仅在日志中显著打印一次，禁止沿用 admin/admin。
 * 注意：此时 logger 尚未创建（logger 依赖本模块），只能用 console 输出。
 */
function ensureConfigFile(): void {
  if (fs.existsSync(CONFIG_PATH)) return
  const cfg = buildDefaultConfig()
  fs.mkdirSync(path.dirname(CONFIG_PATH), { recursive: true })
  const header =
    '# Rainbow 配置文件（首次启动自动生成）\n' +
    '# Web 登录密码为随机生成，已在启动日志中打印过一次；如遗失请直接修改本文件。\n'
  // O_EXCL 原子创建（'wx'）+ mode 0o600：含密码的配置文件避免 TOCTOU 竞态与竞态期宽权限
  let fd: number
  try {
    fd = fs.openSync(CONFIG_PATH, 'wx', 0o600)
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'EEXIST') return // 并发启动：另一实例已创建
    throw err
  }
  try {
    fs.writeSync(fd, header + YAML.stringify(cfg), 0, 'utf8')
  } finally {
    fs.closeSync(fd)
  }
  const line = '='.repeat(66)
  console.warn(line)
  console.warn('  [Rainbow] 检测到无配置文件，已自动生成: ' + CONFIG_PATH)
  console.warn('  [Rainbow] Web 登录账号（随机强密码，仅此一次打印，请立即保存！）')
  console.warn(`      用户名: ${cfg.auth.webLogin.username}`)
  console.warn(`      密  码: ${cfg.auth.webLogin.password}`)
  console.warn(line)
}

function applyEnvOverrides(cfg: RoConfig): void {
  // RO_SERVER_PORT / RO_SERVER_HOST / RO_AUTH_APIKEY / RO_LOG_LEVEL 等简单覆盖
  if (process.env.RO_SERVER_PORT) cfg.server.port = Number(process.env.RO_SERVER_PORT)
  if (process.env.RO_SERVER_HOST) cfg.server.host = process.env.RO_SERVER_HOST
  if (process.env.RO_AUTH_APIKEY) cfg.auth.apiKey = process.env.RO_AUTH_APIKEY
  if (process.env.RO_LOG_LEVEL) cfg.log.level = process.env.RO_LOG_LEVEL
}

/**
 * 是否「纯映射对象」。YAML.parse 的映射节点与本文件手写的默认值都满足；Date / Map / 数组
 * 不算 —— 否则 YAML 把 `2026-09-05` 解析成 Date 时会被当作映射递归，而 `Object.entries(Date)`
 * 为空，该字段就被静默丢弃、回落默认值。
 */
function isPlainObject(v: unknown): v is Record<string, unknown> {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return false
  const proto = Object.getPrototypeOf(v) as object | null
  return proto === Object.prototype || proto === null
}

/** 从 YAML 解析结果里取「映射节点」：非映射（null / 数组 / 标量）一律视为未提供 */
function asMapping(v: unknown): Record<string, unknown> | undefined {
  return isPlainObject(v) ? v : undefined
}

/**
 * 用内置默认值补齐 YAML 配置，返回结构完整的 RoConfig（#127：一次性根治消费侧裸访问 500）。
 *
 * 合并规则：双方均为映射时逐键递归；数组与标量以 YAML 值**整体覆盖**默认值（不做数组元素级
 * 合并）；YAML 独有的键（`download.*` 性能加固项、`scrape.*` 等可选字段）原样保留。
 *
 * **null 语义（评审要求二选一，此处定为「未提供」）**：YAML 里的显式 null —— 含 `key:` 这种
 * 空值写法，YAML.parse 出来就是 null —— 一律视为「该字段未提供」并回落内置默认值，**不**视为
 * 「用户要求置空」。依据：
 *   1. 合并结果才真正满足 RoConfig（布尔字段不会出现 null），消费侧无需再各自兜 null；
 *   2. `download.dir:` 留空会让下方 `path.resolve` 抛 TypeError（启动即崩），回落默认值可免；
 *   3. 与 `ensureConfigFile()` / `config.example.yaml` 的默认口径一致：文档写的默认就是实际默认；
 *   4. 展示层（settings.ts 的 `=== true`）与调度器（scheduler.ts 的 `!enabled`）拿到的是同一个
 *      非 null 布尔值，结构上不可能背离（#126 M1 那类「UI 显示启用、调度器禁用」不再可达）。
 * 代价（已在 API.md / DEVELOPMENT.md 文档化）：想关掉某项必须显式写 `false`，留空等于用默认值。
 *
 * 影响面：真机 `.fpk` 的 config.yaml 由 `fpk/cmd/_common` 的 `render_config()` 渲染，恒含完整块
 * （`embedCover` / `hotReload` / `concurrency` / `smokeTest.enabled` / `alert.*` 全部显式在位），
 * 故本合并对真机部署零行为变化；仅对手工精简过的或第三方旧 config 生效（缺省项按上表回落默认值）。
 *
 * 凭据例外：默认值取 `buildDefaultConfig('')`，password 恒为空串而非随机强密码（理由见该函数注释）。
 */
function mergeWithDefaults(yamlCfg: Record<string, unknown>): RoConfig {
  const merged = buildDefaultConfig('') as unknown as Record<string, unknown>
  mergeInto(merged, yamlCfg)
  return merged as unknown as RoConfig
}

/** 把 src 合并进 dst（原地修改 dst）：null / undefined 视为未提供并跳过，其余以 src 为准 */
function mergeInto(dst: Record<string, unknown>, src: Record<string, unknown>): void {
  for (const [k, v] of Object.entries(src)) {
    if (v === undefined || v === null) continue
    if (isPlainObject(v) && isPlainObject(dst[k])) {
      mergeInto(dst[k], v)
      continue
    }
    dst[k] = v
  }
}

export function loadConfig(): RoConfig {
  const raw = fs.readFileSync(CONFIG_PATH, 'utf8')
  // 空文件 / 全注释文件 → YAML.parse 返回 null，按「什么都没提供」处理（旧写法在此即崩）
  const yamlCfg = asMapping(YAML.parse(raw)) ?? {}

  // ── 三项「来源标记」必须取原始 YAML，不能被下面的默认值深合并污染 ──
  const downloadYaml = asMapping(yamlCfg.download)
  const sourcesYaml = asMapping(yamlCfg.sources)
  // 记住 yaml 里原本的写法：绝对路径保持绝对（fnOS 下载目录常为绝对路径）。
  // 字段缺省时按内置默认的相对路径判定 —— 与合并后的运行值一致，回写时仍相对化。
  downloadDirWasRelative = !path.isAbsolute(String(downloadYaml?.dir ?? 'data/downloads'))
  sourcesDirWasRelative = !path.isAbsolute(String(sourcesYaml?.dir ?? 'data/sources'))
  // 记录 download.concurrency 是否在 yaml 中显式存在（区分「用户配置」与「代码默认」）。
  // 深合并后 config.download.concurrency 恒存在，若改从合并结果判定就会恒为 true，
  // 进而永久关闭 #6 的自适应并发 clamp(CPU核数, 2, 6)。
  downloadConcurrencyExplicit = !!downloadYaml && Object.prototype.hasOwnProperty.call(downloadYaml, 'concurrency')

  const cfg = mergeWithDefaults(yamlCfg)
  // env 覆盖排在深合并之后：RO_AUTH_APIKEY / RO_SERVER_PORT 等必须最终生效，不被默认值盖掉
  applyEnvOverrides(cfg)
  // path.resolve 对绝对路径原样返回，相对路径相对项目根目录解析
  cfg.download.dir = path.resolve(ROOT_DIR, cfg.download.dir)
  cfg.sources.dir = path.resolve(ROOT_DIR, cfg.sources.dir)
  return cfg
}

/**
 * 落盘当前运行态配置。#135 回写审计已核实下列三项行为，结论是「可接受、不改实现」，
 * 故此处只做文档化，并以 `test/config.merge.test.ts`（s7 / s8 / s10）把现状钉为回归：
 *
 * 1. **整文件重写，不保留注释与原有排版**：`YAML.stringify` 会丢掉全部注释，并按自身
 *    风格重新决定缩进、引号与键序。这是本函数自引入起就有的既有行为——#127 加深合并
 *    前后本函数逐字节相同（已比对 `git show d26c63a^:server/src/core/config.ts` 与
 *    `git show d26c63a:server/src/core/config.ts` 的本函数段，diff 空输出），故按「记录但
 *    不扩大改动」处置：改成原地编辑以保留注释需要 YAML CST 级别的改写，风险远大于收益。
 *    实际后果是 `ensureConfigFile()` 写的两行文件头注释、以及用户
 *    自己加的注释，都会在首次 PATCH 后消失；密码等**值**不受影响（见第 3 条）。
 * 2. **回写范围是整个 config 对象，而非「用户本次改过的字段」**。#127 起 config 恒为深合并
 *    后的全量对象，故首次 PATCH 会把用户从未写过的字段固化为显式默认值（实测：只写了
 *    3 个顶层块的精简配置，PATCH 一次后 8 个块全部在位）。代价是将来调整
 *    `buildDefaultConfig` 的默认值，对已经 PATCH 过的用户不再生效。真机 fpk 路径零影响：
 *    `fpk/cmd/_common` 的 `render_config()` 渲染出的 config.yaml 本就显式写全全部顶层块，
 *    且值与 `buildDefaultConfig` 逐项相同，固化不改变任何语义（对照用例 s10）。
 *    另注：`applyEnvOverrides` 生效过的字段（如 RO_LOG_LEVEL）同样会被固化成 yaml 里的
 *    显式值。真机 compose 只设了 RO_SERVER_HOST / RO_SERVER_PORT，而模板已写同值，故无危害。
 * 3. **password 恒为用户实设值或空串，绝不会被写入随机强密码**：随机值只在
 *    `ensureConfigFile()`（配置文件本就不存在）那条路径产生；配置文件已存在时默认值取
 *    `buildDefaultConfig('')`，本函数回写的就是文件里已有的那个值（理由见该函数注释与
 *    `mergeWithDefaults` 的「凭据例外」）。
 *
 * 路径字段：仅对「原本写作相对路径」的做相对化；绝对路径原样落盘，不强制相对化。
 */
export function saveConfig(cfg: RoConfig): void {
  // 仅对「原本写作相对路径」的字段做相对化；绝对路径原样落盘，不强制相对化
  const out = JSON.parse(JSON.stringify(cfg)) as RoConfig
  out.download.dir = downloadDirWasRelative
    ? (path.relative(ROOT_DIR, cfg.download.dir) || cfg.download.dir)
    : cfg.download.dir
  out.sources.dir = sourcesDirWasRelative
    ? (path.relative(ROOT_DIR, cfg.sources.dir) || cfg.sources.dir)
    : cfg.sources.dir
  fs.writeFileSync(CONFIG_PATH, YAML.stringify(out), 'utf8')
}

ensureConfigFile()

export const config = loadConfig()

/** #73 启动时解析后的下载目录快照（运行态 dir 被 PATCH 改动后与它不一致 → 前端「待重启」角标依据） */
export const STARTUP_DOWNLOAD_DIR: string = config.download.dir

/**
 * 运行时局部更新配置（设置页用）。深合并 patch → 保存到 yaml → 原地更新 config 对象。
 * 注意：server/auth 等需重启才生效的字段，这里只落盘，运行态不强制刷新。
 *
 * 本函数唯一的落盘出口是 `saveConfig()`，故回写语义（固化范围、注释不保留、password
 * 恒不注入随机值）全部见该函数的注释。#135 的审计结论是行为可接受、不做侵入式改造，
 * 改以注释与回归用例钉住现状；取证用例见 `test/config.merge.test.ts` 的 s7 / s8 / s9 / s10。
 */
export function patchConfig(patch: DeepPartial<RoConfig>): RoConfig {
  // #73 下载目录被显式修改：按用户本次输入的写法更新回写标记——
  // 输入绝对路径 → yaml 原样落盘绝对路径（不强制相对化）；输入相对路径 → 保持相对化回写
  if (patch.download?.dir != null) {
    downloadDirWasRelative = !path.isAbsolute(String(patch.download.dir))
  }
  deepMerge(config as unknown as Record<string, unknown>, patch as Record<string, unknown>)
  // 路径字段重新解析为绝对路径
  config.download.dir = path.resolve(ROOT_DIR, config.download.dir)
  config.sources.dir = path.resolve(ROOT_DIR, config.sources.dir)
  saveConfig(config)
  return config
}

type DeepPartial<T> = { [P in keyof T]?: T[P] extends object ? DeepPartial<T[P]> : T[P] }

/**
 * 运行时 patch 用的深合并（`patchConfig`）：null **视为覆盖**（允许显式清空字段）。
 * 这与加载期 `mergeInto()` 的「null = 未提供」刻意不同，勿互相替换：前者承载用户主动提交的
 * 修改意图，后者只做配置加载时的默认值补齐。
 */
function deepMerge(target: Record<string, unknown>, patch: Record<string, unknown>): void {
  for (const [k, v] of Object.entries(patch)) {
    if (v === undefined) continue
    if (v !== null && typeof v === 'object' && !Array.isArray(v) && typeof target[k] === 'object' && target[k] !== null) {
      deepMerge(target[k] as Record<string, unknown>, v as Record<string, unknown>)
    } else {
      target[k] = v
    }
  }
}
