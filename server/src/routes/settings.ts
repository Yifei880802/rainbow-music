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

const QUALITIES = ['flac24bit', 'flac', '320k', '128k']

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
      apiKeySet: !!config.auth.apiKey,
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
    },
    scrape: {
      enabled: config.scrape?.enabled !== false,
      autoOnComplete: config.scrape?.autoOnComplete !== false,
    },
    smokeTest: {
      enabled: config.smokeTest.enabled,
      cron: config.smokeTest.cron,
      keyword: config.smokeTest.keyword,
      checkLyric: config.smokeTest.checkLyric,
      checkPic: config.smokeTest.checkPic,
      alertThreshold: config.smokeTest.alertThreshold,
      alert: {
        bark: {
          enabled: config.smokeTest.alert.bark.enabled,
          serverUrl: config.smokeTest.alert.bark.serverUrl,
          deviceKeySet: !!config.smokeTest.alert.bark.deviceKey,
        },
        serverChan: {
          enabled: config.smokeTest.alert.serverChan.enabled,
          sendKeySet: !!config.smokeTest.alert.serverChan.sendKey,
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
  }>
  /** #73 顶层快捷字段：设置页「修改下载目录」独立入口发送，语义等同 download.dir */
  downloadDir?: string
  scrape?: {
    enabled?: boolean
    autoOnComplete?: boolean
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
