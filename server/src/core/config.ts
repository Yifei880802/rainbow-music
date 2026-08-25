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

/** 内置默认配置（结构与仓库 config.example.yaml 一致；密码随机生成） */
function buildDefaultConfig(): RoConfig {
  return {
    server: { host: '0.0.0.0', port: 23330 },
    auth: {
      enabled: true,
      apiKey: '',
      webLogin: { username: 'admin', password: randomStrongPassword() },
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

export function loadConfig(): RoConfig {
  const raw = fs.readFileSync(CONFIG_PATH, 'utf8')
  const cfg = YAML.parse(raw) as RoConfig
  // 记住 yaml 里原本的写法：绝对路径保持绝对（fnOS 下载目录常为绝对路径）
  downloadDirWasRelative = !path.isAbsolute(String(cfg.download.dir))
  sourcesDirWasRelative = !path.isAbsolute(String(cfg.sources.dir))
  // 记录 download.concurrency 是否在 yaml 中显式存在（区分「用户配置」与「代码默认」）
  const downloadRaw = (cfg as unknown as { download?: Record<string, unknown> }).download
  downloadConcurrencyExplicit = !!downloadRaw && Object.prototype.hasOwnProperty.call(downloadRaw, 'concurrency')
  applyEnvOverrides(cfg)
  // path.resolve 对绝对路径原样返回，相对路径相对项目根目录解析
  cfg.download.dir = path.resolve(ROOT_DIR, cfg.download.dir)
  cfg.sources.dir = path.resolve(ROOT_DIR, cfg.sources.dir)
  return cfg
}

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
