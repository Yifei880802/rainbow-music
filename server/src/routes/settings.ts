/**
 * 设置路由
 *   GET  /api/v1/settings              返回可编辑配置（脱敏）
 *   PATCH /api/v1/settings             局部更新配置（下载/告警/冒烟）
 *   POST /api/v1/settings/notify/test  测试告警推送
 *
 * 安全：apiKey / webLogin.password 不回传明文，只回传是否已设置。
 */
import crypto from 'node:crypto'
import type { FastifyInstance } from 'fastify'
import { config, patchConfig, STARTUP_DOWNLOAD_DIR } from '../core/config.js'
import { userIsAdmin } from '../core/auth/index.js'
import { notify } from '../core/notify/index.js'
import { downloadQueue } from '../core/download/queue.js'
import { rescheduleSmoke } from '../core/smoke/scheduler.js'
import { ALL_PLATFORMS, isPlatform } from '../core/search/index.js'

const QUALITIES = ['flac24bit', 'flac', '320k', '128k']

/** #191 J2：平台权重默认值（与 config.ts buildDefaultConfig 同源） */
const DEFAULT_PLATFORM_WEIGHTS: Record<string, number> = { kw: 1, kg: 1, tx: 1.1, wy: 1, mg: 0.9 }
/** #191：联想标题池取榜平台默认值 */
const DEFAULT_SUGGEST_PLATFORMS: string[] = ['wy', 'tx', 'kg']

/** #73 下载目录路径长度上限（前后端同步：前端 input maxlength=512） */
const DOWNLOAD_DIR_MAX = 512

/**
 * #73 校验下载目录字符串：返回错误文案（string）或 null（合法）。
 * 拒绝：非字符串 / trim 后为空 / 超长 / 含控制字符（null 字节、换行、制表等）。
 * 相对路径与绝对路径均放行（相对相对项目根解析，语义由 config 层统一处理）。
 */
function validateDownloadDir(raw: unknown): string | null {
  if (typeof raw !== 'string') return 'downloadDir 需为字符串'
  const dir = raw.trim()
  if (!dir) return '下载目录不能为空'
  if (dir.length > DOWNLOAD_DIR_MAX) return `下载目录过长（>${DOWNLOAD_DIR_MAX} 字符）`
  // \x00-\x1F 含 null 字节与所有 C0 控制字符，\x7F 为 DEL
  if (/[\x00-\x1F\x7F]/.test(dir)) return '下载目录包含非法控制字符'
  return null
}

/** 脱敏后的配置视图（不含密钥明文） */
function safeView() {
  return {
    auth: {
      // 只回传是否已设置 API Key，绝不回传明文（明文仅在生成的那一次响应里出现）
      // 这里的 ?. 原为评审 #126 M2 而加：当时 loadConfig 不与默认值合并、也从不访问 cfg.auth
      // （仅 RO_AUTH_APIKEY 存在时才在 applyEnvOverrides 里触碰，而 fpk compose 未设该变量），
      // 故旧 config 缺顶层 auth: 块时进程可正常启动、但此处裸访问抛 TypeError → GET /settings 500。
      // #127 起 loadConfig 已深合并 buildDefaultConfig()，config.auth 恒存在，?. 降为冗余防线；
      // 按「不引入新风险」原则保留不回收（回收只省一个 ?.，却把本端点重新绑死在加载层实现上）。
      apiKeySet: !!config.auth?.apiKey,
    },
    download: {
      concurrency: config.download.concurrency,
      defaultQuality: config.download.defaultQuality,
      nameTemplate: config.download.nameTemplate,
      embedCover: config.download.embedCover,
      embedLyric: config.download.embedLyric,
      coverSize: config.download.coverSize,
      // #73 下载目录可见性：resolvedDir = 当前解析后的绝对路径（loadConfig/patchConfig 均已 resolve，
      // 不改变 yaml 里 dir 字段「相对路径相对项目根解析、绝对路径原样使用」的原有语义）；
      // startupResolvedDir = 本次进程启动时快照，两者不一致 → 前端显示「待重启」角标
      resolvedDir: config.download.dir,
      startupResolvedDir: STARTUP_DOWNLOAD_DIR,
      // G1/G2/H5/F2: P1 下载引擎强化配置（脱敏视图透出，前端设置页可编辑）
      dirTemplate: config.download.dirTemplate ?? '',
      dedupePolicy: config.download.dedupePolicy ?? 'skip',
      batchMaxItems: config.download.batchMaxItems ?? 200,
      resume: config.download.resume !== false,
      // N3: 磁盘预检配置（脱敏视图透出，前端设置页可编辑）
      diskPrecheck: config.download.diskPrecheck !== false,
      minFreeBytes: config.download.minFreeBytes ?? 104857600,
    },
    // L1/L2/L3: 音源健康编排与限速配置（透供设置页编辑）
    sources: {
      healthAware: config.sources.healthAware !== false,
      circuitThreshold: config.sources.circuitThreshold ?? 5,
      circuitWindowMs: config.sources.circuitWindowMs ?? 300000,
      ratePerMin: config.sources.ratePerMin ?? 0,
    },
    scrape: {
      enabled: config.scrape?.enabled !== false,
      autoOnComplete: config.scrape?.autoOnComplete !== false,
    },
    // #191 P1 搜索后端 J：相关度评分平台权重 + 联想取榜平台（透供设置页编辑）
    // #200 P2 搜索高阶 O4/O5：错字容错开关/阈值 + 相关推荐开关
    search: {
      platformWeights: config.search?.platformWeights ?? DEFAULT_PLATFORM_WEIGHTS,
      suggestPlatforms: config.search?.suggestPlatforms ?? DEFAULT_SUGGEST_PLATFORMS,
      correctEnabled: config.search?.correctEnabled !== false,
      correctMinResults: config.search?.correctMinResults ?? 3,
      relatedEnabled: config.search?.relatedEnabled !== false,
    },
    smokeTest: {
      // 防御性可选链 + 空值兜底（默认值与 config.ts buildDefaultConfig 同源），
      // 与上方 scrape 的 ?. 风格对齐（审查 t122 M2）。#127 起 loadConfig 已深合并默认值，
      // smokeTest 及其 alert 子树恒存在，下列 ?. / ?? 均为冗余防线，保留不回收。
      // 布尔字段用 === true 而非 ?? true（评审 #126 M1）：运行时消费方是 truthiness 判定
      // （scheduler.ts `if (!config.smokeTest.enabled) return`、smoke/index.ts `if (...checkLyric)`）。
      // 当时的问题是 YAML 空值（`enabled:` → null）用 ?? true 兜底会造成 UI 显示「已勾选」
      // 而调度器实际禁用，且前端全量 PATCH 会把伪造的 true 落盘。
      // #127 后的语义：null / 缺字段已在**加载层**回落 buildDefaultConfig 的值（enabled /
      // checkLyric / checkPic 默认 true，alert.*.enabled 默认 false），此处拿到的是非 null 布尔值，
      // 故 === true 与调度器的 truthiness 判定对同一输入恒同真假，展示层与调度器不可能背离。
      // 注意这是行为变更：字段缺省/留空时有效值由「禁用」变「启用」——与 config.example.yaml
      // 和真机 fpk 模板的设计默认值一致（真机模板恒显式写全，零影响）。要关必须显式写 false。
      // 保留 === true 而非改回直接透传：万一将来加载层合并被移除，这里仍与消费方语义一致。
      // 字符串/数值字段保留 ?? 兜底：消费方用 || 同款默认值（scheduler.ts `cron || '0 6 * * *'`），已核实一致。
      enabled: config.smokeTest?.enabled === true,
      cron: config.smokeTest?.cron ?? '0 6 * * *',
      keyword: config.smokeTest?.keyword ?? '周杰伦',
      checkLyric: config.smokeTest?.checkLyric === true,
      checkPic: config.smokeTest?.checkPic === true,
      alertThreshold: config.smokeTest?.alertThreshold ?? 2,
      alert: {
        bark: {
          enabled: config.smokeTest?.alert?.bark?.enabled ?? false,
          serverUrl: config.smokeTest?.alert?.bark?.serverUrl ?? 'https://api.day.app',
          deviceKeySet: !!config.smokeTest?.alert?.bark?.deviceKey,
        },
        serverChan: {
          enabled: config.smokeTest?.alert?.serverChan?.enabled ?? false,
          sendKeySet: !!config.smokeTest?.alert?.serverChan?.sendKey,
        },
      },
    },
  }
}

interface SettingsPatch {
  download?: Partial<{
    concurrency: number
    defaultQuality: string
    nameTemplate: string
    embedCover: boolean
    embedLyric: boolean
    coverSize: number
    /** #73 下载目录（相对路径相对项目根解析 / 绝对路径原样使用，重启后新目录完全生效） */
    dir: string
    /** G1: 落盘子目录模板（''=平铺；支持 '{singer}/{album}'、'{singerFirstLetter}/{singer}'） */
    dirTemplate: string
    /** H5: 入队去重策略 */
    dedupePolicy: 'skip' | 'replace' | 'always-new'
    /** H1/H5: 批量入队单次上限 */
    batchMaxItems: number
    /** F2: 断点续传开关 */
    resume: boolean
    /** N3: 入队前磁盘空间预检开关 */
    diskPrecheck: boolean
    /** N3: 最小可用磁盘字节数 */
    minFreeBytes: number
  }>
  /** L1/L2/L3: 音源健康编排与限速 */
  sources?: Partial<{
    healthAware: boolean
    circuitThreshold: number
    circuitWindowMs: number
    ratePerMin: number
  }>
  /** #73 顶层快捷字段：设置页「修改下载目录」独立入口发送，语义等同 download.dir */
  downloadDir?: string
  scrape?: {
    enabled?: boolean
    autoOnComplete?: boolean
  }
  /** #191 P1 搜索后端 J：平台权重与联想取榜平台；#200 P2 O4/O5：错字容错与相关推荐 */
  search?: {
    platformWeights?: Record<string, number>
    suggestPlatforms?: string[]
    /** #200 O4：错字容错开关 */
    correctEnabled?: boolean
    /** #200 O4：触发纠错的聚合结果数阈值（1-50） */
    correctMinResults?: number
    /** #200 O5：相关推荐开关 */
    relatedEnabled?: boolean
  }
  smokeTest?: {
    enabled?: boolean
    cron?: string
    keyword?: string
    checkLyric?: boolean
    checkPic?: boolean
    alertThreshold?: number
    alert?: {
      bark?: { enabled?: boolean; serverUrl?: string; deviceKey?: string }
      serverChan?: { enabled?: boolean; sendKey?: string }
    }
  }
}

export async function settingsRoutes(app: FastifyInstance): Promise<void> {
  app.get('/api/v1/settings', async () => safeView())

  app.patch<{ Body: SettingsPatch }>('/api/v1/settings', async (req, reply) => {
    // v0.2.1 模块三：全局配置变更限管理员（网关 Isadmin=false → 403；GET 保持可读）
    if (!userIsAdmin(req.user)) {
      return reply.code(403).send({ error: '需要管理员权限' })
    }
    const body = req.body ?? {}
    // #73 顶层快捷字段 downloadDir 归一化为嵌套 download.dir（两处同传时以顶层为准）
    if (body.downloadDir !== undefined) {
      body.download = { ...(body.download ?? {}), dir: body.downloadDir }
      delete body.downloadDir
    }
    // #73 下载目录校验：字符串 + trim 非空 + ≤512 字符 + 无控制字符（含 null 字节）。
    // 相对/绝对均合法（相对路径相对项目根解析），合法性交由 path.resolve 统一处理；
    // 校验通过后回写 trim 后的干净值，避免首尾空白随 yaml 落盘。
    if (body.download?.dir !== undefined) {
      const bad = validateDownloadDir(body.download.dir)
      if (bad) return reply.code(400).send({ error: bad })
      if (typeof body.download.dir === 'string') body.download.dir = body.download.dir.trim()
    }
    // 校验若干关键字段
    if (body.download?.concurrency != null) {
      const c = Number(body.download.concurrency)
      if (!Number.isInteger(c) || c < 1 || c > 10) return reply.code(400).send({ error: 'concurrency 需为 1-10 的整数' })
    }
    if (body.download?.defaultQuality != null && !QUALITIES.includes(body.download.defaultQuality)) {
      return reply.code(400).send({ error: 'invalid defaultQuality', valid: QUALITIES })
    }
    if (body.download?.coverSize != null) {
      const s = Number(body.download.coverSize)
      if (!Number.isInteger(s) || s < 100 || s > 1000) return reply.code(400).send({ error: 'coverSize 需为 100-1000 的整数' })
    }
    // G1: dirTemplate 字符串校验（''=平铺合法；非字符串拒绝；超长与控制字符同 downloadDir 口径）
    if (body.download?.dirTemplate != null) {
      const t = body.download.dirTemplate
      if (typeof t !== 'string') return reply.code(400).send({ error: 'dirTemplate 需为字符串' })
      if (t.length > DOWNLOAD_DIR_MAX) return reply.code(400).send({ error: `dirTemplate 过长（>${DOWNLOAD_DIR_MAX} 字符）` })
      if (/[\x00-\x1F\x7F]/.test(t)) return reply.code(400).send({ error: 'dirTemplate 包含非法控制字符' })
      body.download.dirTemplate = t.trim()
    }
    // H5: dedupePolicy 枚举校验
    if (body.download?.dedupePolicy != null && !['skip', 'replace', 'always-new'].includes(body.download.dedupePolicy)) {
      return reply.code(400).send({ error: 'invalid dedupePolicy', valid: ['skip', 'replace', 'always-new'] })
    }
    // H1/H5: batchMaxItems 正整数校验（1-1000）
    if (body.download?.batchMaxItems != null) {
      const b = Number(body.download.batchMaxItems)
      if (!Number.isInteger(b) || b < 1 || b > 1000) return reply.code(400).send({ error: 'batchMaxItems 需为 1-1000 的整数' })
    }
    // F2: resume 布尔校验
    if (body.download?.resume != null && typeof body.download.resume !== 'boolean') {
      return reply.code(400).send({ error: 'resume 需为布尔值' })
    }
    // N3: diskPrecheck 布尔校验
    if (body.download?.diskPrecheck != null && typeof body.download.diskPrecheck !== 'boolean') {
      return reply.code(400).send({ error: 'diskPrecheck 需为布尔值' })
    }
    // N3: minFreeBytes 非负整数校验（0=不限制；上限 1TB 防误填）
    if (body.download?.minFreeBytes != null) {
      const m = Number(body.download.minFreeBytes)
      if (!Number.isInteger(m) || m < 0 || m > 1_099_511_627_776) return reply.code(400).send({ error: 'minFreeBytes 需为 0 - 1TB 的整数' })
    }
    // L1: sources.healthAware 布尔校验
    if (body.sources?.healthAware != null && typeof body.sources.healthAware !== 'boolean') {
      return reply.code(400).send({ error: 'sources.healthAware 需为布尔值' })
    }
    // L2: circuitThreshold 正整数（1-100）
    if (body.sources?.circuitThreshold != null) {
      const c = Number(body.sources.circuitThreshold)
      if (!Number.isInteger(c) || c < 1 || c > 100) return reply.code(400).send({ error: 'sources.circuitThreshold 需为 1-100 的整数' })
    }
    // L2: circuitWindowMs 正整数（1000ms - 1h）
    if (body.sources?.circuitWindowMs != null) {
      const w = Number(body.sources.circuitWindowMs)
      if (!Number.isInteger(w) || w < 1000 || w > 3_600_000) return reply.code(400).send({ error: 'sources.circuitWindowMs 需为 1000-3600000 的整数' })
    }
    // L3: ratePerMin 非负整数（0=不限速；上限 100000）
    if (body.sources?.ratePerMin != null) {
      const r = Number(body.sources.ratePerMin)
      if (!Number.isInteger(r) || r < 0 || r > 100000) return reply.code(400).send({ error: 'sources.ratePerMin 需为 0-100000 的整数' })
    }
    // #191 J2: search.platformWeights 校验（对象；键∈平台；值 0-5 数值）
    if (body.search?.platformWeights != null) {
      const pw = body.search.platformWeights
      if (typeof pw !== 'object' || pw === null || Array.isArray(pw)) {
        return reply.code(400).send({ error: 'platformWeights 需为对象' })
      }
      for (const [k, v] of Object.entries(pw)) {
        if (!isPlatform(k)) return reply.code(400).send({ error: `platformWeights 含未知平台: ${k}`, valid: ALL_PLATFORMS })
        const n = Number(v)
        if (!Number.isFinite(n) || n < 0 || n > 5) {
          return reply.code(400).send({ error: `platformWeights.${k} 需为 0-5 的数值` })
        }
      }
    }
    // #191: search.suggestPlatforms 校验（数组；元素∈平台）
    if (body.search?.suggestPlatforms != null) {
      const sp = body.search.suggestPlatforms
      if (!Array.isArray(sp)) return reply.code(400).send({ error: 'suggestPlatforms 需为数组' })
      const invalid = sp.filter((p) => !isPlatform(p))
      if (invalid.length) return reply.code(400).send({ error: `suggestPlatforms 含未知平台: ${invalid.join(',')}`, valid: ALL_PLATFORMS })
    }
    // #200 O4: search.correctEnabled 布尔校验
    if (body.search?.correctEnabled != null && typeof body.search.correctEnabled !== 'boolean') {
      return reply.code(400).send({ error: 'search.correctEnabled 需为布尔值' })
    }
    // #200 O4: search.correctMinResults 正整数校验（1-50）
    if (body.search?.correctMinResults != null) {
      const c = Number(body.search.correctMinResults)
      if (!Number.isInteger(c) || c < 1 || c > 50) return reply.code(400).send({ error: 'search.correctMinResults 需为 1-50 的整数' })
    }
    // #200 O5: search.relatedEnabled 布尔校验
    if (body.search?.relatedEnabled != null && typeof body.search.relatedEnabled !== 'boolean') {
      return reply.code(400).send({ error: 'search.relatedEnabled 需为布尔值' })
    }
    // 空字符串的密钥字段视为「不修改」，避免脱敏视图回传后被清空
    if (body.smokeTest?.alert?.bark && body.smokeTest.alert.bark.deviceKey === '') delete body.smokeTest.alert.bark.deviceKey
    if (body.smokeTest?.alert?.serverChan && body.smokeTest.alert.serverChan.sendKey === '') delete body.smokeTest.alert.serverChan.sendKey

    patchConfig(body as Parameters<typeof patchConfig>[0])
    // 并发变化即时生效；#73 下载目录变化无需运行时钩子：新下载实时读 config.download.dir，
    // yaml 已落盘，完整一致性由重启兑底（前端以「待重启」角标提示）
    if (body.download?.concurrency != null) downloadQueue.setConcurrency(config.download.concurrency)
    if (body.smokeTest?.cron != null || body.smokeTest?.enabled != null) rescheduleSmoke()
    return safeView()
  })

  // 随机生成一个新的 API Key：存盘并「仅此一次」在响应里返回明文。
  // 之后任何 GET /settings 都只能看到 apiKeySet=true，拿不到明文。
  app.post('/api/v1/settings/apikey/generate', async (req, reply) => {
    // v0.2.1 模块三：凭据管理限管理员
    if (!userIsAdmin(req.user)) {
      return reply.code(403).send({ error: '需要管理员权限' })
    }
    // 32 字节 → 43 位 base64url，足够强；前缀 ro_ 方便识别
    const key = 'ro_' + crypto.randomBytes(32).toString('base64url')
    patchConfig({ auth: { apiKey: key } })
    // 明文只在这里出现一次；提醒前端立即展示并让用户保存
    return { apiKey: key, once: true }
  })

  // 撤销 / 清除当前 API Key
  app.delete('/api/v1/settings/apikey', async (req, reply) => {
    // v0.2.1 模块三：凭据管理限管理员
    if (!userIsAdmin(req.user)) {
      return reply.code(403).send({ error: '需要管理员权限' })
    }
    patchConfig({ auth: { apiKey: '' } })
    return { ok: true, apiKeySet: false }
  })

  app.post<{ Body: { title?: string; body?: string } }>('/api/v1/settings/notify/test', async (req, reply) => {
    // v0.2.1 模块三：测试推送会触发外部通知渠道，限管理员
    if (!userIsAdmin(req.user)) {
      return reply.code(403).send({ error: '需要管理员权限' })
    }
    const title = req.body?.title || 'Rainbow 测试 通知'
    const body = req.body?.body || `这是一条来自 Rainbow 的测试推送 (${new Date().toLocaleString('zh-CN')})`
    const results = await notify(title, body)
    return { results }
  })
}
