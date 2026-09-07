/**
 * 测试沙箱环境（#135）：**必须是测试文件的第一个 import**。
 *
 * 为什么需要它：`src/core/config.ts` 在模块求值期就执行 `ensureConfigFile()` 与
 * `export const config = loadConfig()`，读取 `process.env.RO_CONFIG ?? <仓库根>/config.yaml`；
 * `src/core/db/index.ts` 同理读 `RO_DB_DIR ?? <仓库根>/data`。被测的 scanner.ts / settings.ts
 * 都会经 import 链连带求值这两个模块。若不先把这两个变量指向临时目录，测试会：
 *   1. 在仓库根**创建/改写 config.yaml**（ensureConfigFile 发现文件缺失时自动生成并
 *      打印随机密码），污染工作树；
 *   2. 在仓库根 `data/db` 下**创建 SQLite 文件**，污染既有真机数据副本。
 *
 * ESM 的 import 声明按书写顺序求值，故本文件只要写在被测模块之前，下面的 env 赋值
 * 就一定先于 config.ts 的模块体执行。
 *
 * 临时目录在进程退出时无条件清理（含测试失败路径），不留残余。
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

/** 本次测试进程的沙箱根目录（所有 fixture 与临时产物都建在其下） */
export const SANDBOX_ROOT: string = fs.mkdtempSync(path.join(os.tmpdir(), 'rb-test-'))

const configFile = path.join(SANDBOX_ROOT, 'config.yaml')
const dbDir = path.join(SANDBOX_ROOT, 'db')
fs.mkdirSync(dbDir, { recursive: true })

process.env.RO_CONFIG = configFile
process.env.RO_DB_DIR = dbDir
// 抑制 pino 输出，保持 node:test 的报告可读（被测代码的 logger.warn 仍会触发，只是不落 stdout）
process.env.RO_LOG_LEVEL = 'silent'

/**
 * 预置一份最小合法配置，避免 config.ts 的 `ensureConfigFile()` 在测试进程里自动生成
 * 文件并向 console 打印随机密码（那会混进测试输出、干扰 pass/fail 计数行的阅读）。
 */
export function writeSandboxConfig(yamlText: string): string {
  fs.writeFileSync(configFile, yamlText, 'utf8')
  return configFile
}

writeSandboxConfig('server:\n  port: 23330\n')

let cleaned = false
function cleanup(): void {
  if (cleaned) return
  cleaned = true
  try {
    fs.rmSync(SANDBOX_ROOT, { recursive: true, force: true })
  } catch {
    // 清理失败不影响测试结论（临时目录由系统回收），刻意吞掉以免掩盖真实断言失败
  }
}
process.on('exit', cleanup)

/** 供测试显式提前清理（after hook 用） */
export function cleanupSandbox(): void {
  cleanup()
}
