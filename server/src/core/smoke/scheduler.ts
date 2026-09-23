/**
 * 冒烟测试定时调度 — node-cron，默认每日 06:00。
 * cron 表达式与开关来自 config.smokeTest，设置页改动后需 reschedule。
 *
 * node-cron v4（v0.2.22 起）类型形态变更：`ScheduledTask` 不再是默认导出的**命名空间
 * 成员**（v3 的 `cron.ScheduledTask` 写法在 v4 报 TS2503 Cannot find namespace 'cron'），
 * 改为独立的**具名类型导出**。故此处用内联 `type` 修饰符引入：它在转译时会被正常
 * elide（这是应该的），而默认导入 `cron` 本身被 `cron.validate` / `cron.schedule` 实际
 * 使用，不会被删——运行时行为与 v3 完全一致（v4 仍保留默认导出与这两个 API）。
 */
import cron, { type ScheduledTask } from 'node-cron'
import { runSmokeTest } from './index.js'
import { config } from '../config.js'
import { logger } from '../logger.js'

let task: ScheduledTask | null = null

export function startSmokeScheduler(): void {
  stopSmokeScheduler()
  if (!config.smokeTest.enabled) {
    logger.info('[smoke] scheduler disabled')
    return
  }
  const expr = config.smokeTest.cron || '0 6 * * *'
  if (!cron.validate(expr)) {
    logger.warn({ expr }, '[smoke] invalid cron expression, scheduler not started')
    return
  }
  task = cron.schedule(expr, () => {
    logger.info('[smoke] cron triggered')
    void runSmokeTest().catch((err) => logger.error({ err: (err as Error).message }, '[smoke] scheduled run failed'))
  })
  logger.info({ expr }, '[smoke] scheduler started')
}

export function stopSmokeScheduler(): void {
  if (task) {
    task.stop()
    task = null
  }
}

/** 设置页改了 cron/开关后调用 */
export function rescheduleSmoke(): void {
  startSmokeScheduler()
}
