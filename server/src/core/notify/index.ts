/**
 * 告警通知 — Bark + Server酱 双渠道（用户决策：配哪个用哪个，都配则同时推送）
 *
 * 阶段 6 冒烟测试失败时调用；设置页「测试通知」也用它。
 * 纯 needle 请求，失败各自吞掉并返回结果，不影响其它渠道。
 */
import needle from 'needle'
import { config } from '../config.js'
import { logger } from '../logger.js'

export interface NotifyChannelResult {
  channel: 'bark' | 'serverChan'
  ok: boolean
  skipped?: boolean
  error?: string
}

async function pushBark(title: string, body: string): Promise<NotifyChannelResult> {
  // 可选链原为评审 #126 M3 而加：settings.ts 修好后 GET /api/v1/settings 恢复 200，设置页
  // 「测试告警推送」按钮变为可达；当时 loadConfig 不与默认值合并，现场 config.yaml 若缺
  // smokeTest.alert 子树（旧配置或手动精简过），此处裸访问会抛 TypeError →
  // POST /settings/notify/test 500（新可达崩溃面）。#127 起 loadConfig 已深合并
  // buildDefaultConfig()，alert.bark 恒存在（默认 enabled: false），可选链降为冗余防线，保留不回收。
  // 子树缺失或未启用一律等价于「该渠道未启用」→ skipped，与 bark.enabled=false 时语义一致。
  const bark = config.smokeTest?.alert?.bark
  if (!bark || !bark.enabled) return { channel: 'bark', ok: false, skipped: true }
  if (!bark.deviceKey) return { channel: 'bark', ok: false, error: 'deviceKey 未配置' }
  try {
    const base = (bark.serverUrl || 'https://api.day.app').replace(/\/$/, '')
    const url = `${base}/${bark.deviceKey}/${encodeURIComponent(title)}/${encodeURIComponent(body)}`
    const resp = await needle('get', url, { response_timeout: 10_000, follow_max: 3 })
    const code = (resp.body as { code?: number })?.code
    if (resp.statusCode === 200 && (code === 200 || code === undefined)) return { channel: 'bark', ok: true }
    return { channel: 'bark', ok: false, error: `HTTP ${resp.statusCode} code=${code}` }
  } catch (err) {
    return { channel: 'bark', ok: false, error: (err as Error).message }
  }
}

async function pushServerChan(title: string, body: string): Promise<NotifyChannelResult> {
  // 同 pushBark：?. 原为评审 #126 M3 而加；#127 深合并后 serverChan 子树恒存在（默认
  // enabled: false），保留为冗余防线，子树缺失或未启用同样归为 skipped。
  const sc = config.smokeTest?.alert?.serverChan
  if (!sc || !sc.enabled) return { channel: 'serverChan', ok: false, skipped: true }
  if (!sc.sendKey) return { channel: 'serverChan', ok: false, error: 'sendKey 未配置' }
  try {
    const url = `https://sctapi.ftqq.com/${sc.sendKey}.send`
    const resp = await needle('post', url, { title, desp: body }, { response_timeout: 10_000 })
    const code = (resp.body as { code?: number })?.code
    if (resp.statusCode === 200 && (code === 0 || code === undefined)) return { channel: 'serverChan', ok: true }
    return { channel: 'serverChan', ok: false, error: `HTTP ${resp.statusCode} code=${code}` }
  } catch (err) {
    return { channel: 'serverChan', ok: false, error: (err as Error).message }
  }
}

/** 向所有已启用渠道推送；返回各渠道结果 */
export async function notify(title: string, body: string): Promise<NotifyChannelResult[]> {
  const results = await Promise.all([pushBark(title, body), pushServerChan(title, body)])
  const active = results.filter((r) => !r.skipped)
  if (active.length === 0) logger.warn('[notify] 无已启用的告警渠道')
  else logger.info({ results: active }, '[notify] pushed')
  return results
}
