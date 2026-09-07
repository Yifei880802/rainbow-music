/**
 * 设置页回写链路探针（#135，供 config.merge.test.ts 以子进程方式调用）
 *
 * 为什么必须是子进程：`src/core/config.ts` 在模块求值期就固化了
 * `CONFIG_PATH = process.env.RO_CONFIG ?? ...` 与 `export const config = loadConfig()`，
 * 一个进程内只能加载一份配置。而本批要为 8 个场景各喂一份不同的 config.yaml，
 * 故每个场景 spawn 一次本探针，父进程通过 env 传入 RO_CONFIG / RO_DB_DIR / PROBE_PATCH，
 * 探针把结果打成一行 `@@PROBE@@<json>` 回传（加前缀是为了从 pino 等噪音里精确捞出结果行）。
 *
 * 覆盖的链路：loadConfig()（深合并）→ 裸 Fastify 注册真实 settingsRoutes →
 * inject GET /api/v1/settings（真实 safeView，非复刻）→ inject PATCH → saveConfig() 落盘 →
 * 回读落盘后的 yaml 原文。
 *
 * 安全：绝不回传密码明文，只回传 sha256 指纹前 12 位（够判定「是否被改写」，不泄露凭据）。
 */
import fs from 'node:fs'
import crypto from 'node:crypto'
import Fastify from 'fastify'
import YAML from 'yaml'
import { config } from '../../src/core/config.js'
import { settingsRoutes } from '../../src/routes/settings.js'

/** 密码指纹：空串表示未配置密码，非空表示已配置（比对前后是否被改写） */
function fingerprint(s: string): string {
  return s ? crypto.createHash('sha256').update(s).digest('hex').slice(0, 12) : ''
}

interface ProbeOut {
  ok: boolean
  error?: string
  /** loadConfig() 深合并后的运行态配置 */
  config?: unknown
  getStatus?: number
  /** GET /api/v1/settings 的真实响应体（safeView 产物） */
  view?: Record<string, unknown> | null
  /**
   * 调度器口径：`src/core/smoke/scheduler.ts` 用 `if (!config.smokeTest.enabled) return`
   * 的 truthiness 判定。展示层用 `=== true`。两者必须恒同真假（#126 M1 背离的防线）。
   */
  schedulerDisabled?: boolean
  passwordConfigured?: boolean
  passwordFingerprint?: string
  patchStatus?: number
  patchView?: unknown
  /** PATCH 落盘后的 config.yaml 原文（用于审计固化与注释 strip 行为） */
  yamlBefore?: string
  yamlAfter?: string
  parsedAfter?: unknown
  configAfterPatch?: unknown
  schedulerDisabledAfter?: boolean
  passwordFingerprintAfter?: string
}

async function main(): Promise<ProbeOut> {
  const out: ProbeOut = { ok: true }
  const cfgPath = process.env.RO_CONFIG ?? ''
  try {
    out.config = JSON.parse(JSON.stringify(config)) as unknown
    out.passwordConfigured = Boolean(config.auth.webLogin.password)
    out.passwordFingerprint = fingerprint(config.auth.webLogin.password)
    out.schedulerDisabled = !config.smokeTest.enabled
    if (cfgPath && fs.existsSync(cfgPath)) out.yamlBefore = fs.readFileSync(cfgPath, 'utf8')

    const app = Fastify({ logger: false })
    await app.register(settingsRoutes)
    await app.ready()

    const getRes = await app.inject({ method: 'GET', url: '/api/v1/settings' })
    out.getStatus = getRes.statusCode
    out.view = getRes.statusCode === 200 ? (getRes.json() as Record<string, unknown>) : null

    const patchRaw = process.env.PROBE_PATCH ?? '-'
    if (patchRaw !== '-') {
      const patchRes = await app.inject({
        method: 'PATCH',
        url: '/api/v1/settings',
        payload: JSON.parse(patchRaw) as object,
      })
      out.patchStatus = patchRes.statusCode
      out.patchView = patchRes.statusCode === 200 ? patchRes.json() : patchRes.body
      if (cfgPath) {
        out.yamlAfter = fs.readFileSync(cfgPath, 'utf8')
        out.parsedAfter = YAML.parse(out.yamlAfter) as unknown
      }
      out.configAfterPatch = JSON.parse(JSON.stringify(config)) as unknown
      out.schedulerDisabledAfter = !config.smokeTest.enabled
      out.passwordFingerprintAfter = fingerprint(config.auth.webLogin.password)
    }
    await app.close()
  } catch (err) {
    out.ok = false
    out.error = err instanceof Error ? `${err.name}: ${err.message}` : String(err)
  }
  return out
}

const result = await main()
process.stdout.write(`@@PROBE@@${JSON.stringify(result)}\n`)
// 强制退出：PATCH 可能触发 rescheduleSmoke() 挂上 node-cron 定时器，等自然退出会挂住测试
process.exit(0)
