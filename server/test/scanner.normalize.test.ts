/**
 * scanner 扫描根规范化回归护栏（#135，固化 #129 的 M3 验证）
 *
 * 被测对象：`normalizeScanRoots()` —— 扫描根的 realpath 规范化、dev:ino 物理同源去重、
 * 嵌套剪枝。它防的是「曲库翻倍」（M3）：曲库去重键自始至终是路径字符串（表约束
 * UNIQUE(uid,path) 与扫描期 st.seenPaths），两个根指向同一物理目录时 walk 出的字符串
 * 不同，两道去重同时失效，同一文件被索引成两行。
 *
 * #129 交付时这些断言只存在于一个用完即删的临时脚本里，无常驻载体；本文件把它固化为
 * 常驻回归，防止将来改动 scanner 时静默破坏去重语义。
 *
 * 平台说明：`dev:ino` 分支（bind mount 同源、跨挂载视角嵌套）需要「realpath 不同而
 * inode 相同」的目录对，无特权环境下只有 macOS 的 firmlink 能天然提供
 * （/private/... 与 /System/Volumes/Data/private/... 是同一物理目录的两个挂载视角，
 * 语义等价于容器内两个 bind mount 指向同一宿主目录）。探测不到该视角时相关用例记为
 * skip 而非 pass —— 绝不把「没测到」伪装成「测过了」。这些用例已在 macOS 本地实测通过。
 */
import { SANDBOX_ROOT } from './fixtures/env-sandbox.js' // 必须是第一个 import：先设 RO_CONFIG/RO_DB_DIR 再连带求值 config.ts
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { normalizeScanRoots } from '../src/core/library/scanner.js'

// ── fixture 构造 ────────────────────────────────────────────────────────────
// 目录树：roots/alpha/child/grand、roots/beta、roots/link2alpha → roots/alpha
const ROOTS = path.join(SANDBOX_ROOT, 'roots')
fs.mkdirSync(path.join(ROOTS, 'alpha', 'child', 'grand'), { recursive: true })
fs.mkdirSync(path.join(ROOTS, 'beta'), { recursive: true })
fs.symlinkSync(path.join(ROOTS, 'alpha'), path.join(ROOTS, 'link2alpha'))

// macOS 的 os.tmpdir() 位于 /var/folders/...，而 /var 本身是符号链接 → /private/var。
// 故所有期望值都以 realpath 形态为基准：normalizeScanRoots 返回的是规范化后的路径，
// 拿字面路径比对会全部假失败（这一差异本身就是下面 A2 的断言内容）。
const R = fs.realpathSync(ROOTS)
const rAlpha = path.join(R, 'alpha')
const rBeta = path.join(R, 'beta')
const rChild = path.join(rAlpha, 'child')
const rGrand = path.join(rChild, 'grand')

/**
 * 探测「realpath 不同但 dev:ino 相同」的跨挂载视角路径。
 * 返回 null 表示本平台/本环境无此视角（Linux 普通用户环境即如此），相关用例 skip。
 */
function crossViewOf(realPath: string): string | null {
  for (const prefix of ['/System/Volumes/Data']) {
    const alt = prefix + realPath
    try {
      const a = fs.statSync(realPath)
      const b = fs.statSync(alt)
      if (a.dev === b.dev && a.ino === b.ino && fs.realpathSync(realPath) !== fs.realpathSync(alt)) {
        return alt
      }
    } catch {
      // 该视角不存在或不可访问，继续尝试下一个候选
    }
  }
  return null
}

const xAlpha = crossViewOf(rAlpha)
const xChild = crossViewOf(rChild)
const xGrand = crossViewOf(rGrand)
/** 跨视角用例的跳过理由（探测成功时为 false，即不跳过） */
const NO_XVIEW = xAlpha === null
  ? '本平台无「realpath 不同而 dev:ino 相同」的挂载视角（dev:ino 分支已在 macOS firmlink 下实测通过）'
  : false

// ── A. 独立目录不被误剪 ─────────────────────────────────────────────────────

test('A1 两个独立目录均保留、无丢弃', () => {
  const r = normalizeScanRoots([rAlpha, rBeta])
  assert.equal(r.roots.length, 2)
  assert.equal(r.dropped.length, 0)
})

test('A2 保留值为 realpath 规范化形态（字面路径经符号链接时被改写）', () => {
  // 前提「字面路径经符号链接」必须由测试自建符号链接保证，不能依赖平台 tmpdir：
  // macOS 的 os.tmpdir()（/var/folders/...）经 /var→/private/var 符号链接，字面≠realpath；
  // 但 Linux CI 的 /tmp 是真实目录，字面==realpath，旧写法的前提断言会假失败（#156）。
  // 这里显式建 a2-link → roots，用经该符号链接的字面路径喂入，前提在所有平台恒成立。
  const a2Link = path.join(SANDBOX_ROOT, 'a2-link')
  if (!fs.existsSync(a2Link)) fs.symlinkSync(ROOTS, a2Link)
  const literal = path.join(a2Link, 'alpha') // 经符号链接段的字面路径
  const r = normalizeScanRoots([literal])
  assert.equal(r.roots[0], rAlpha) // 规范化后应回落到 realpath 形态
  assert.notEqual(literal, rAlpha, '本用例前提：fixture 路径确实经过符号链接，否则断言无证明力')
})

test('A3 多根保留顺序与输入顺序一致（保序契约）', () => {
  const r = normalizeScanRoots([rBeta, rAlpha])
  assert.deepEqual(r.roots, [rBeta, rAlpha])
})

test('A4 无丢弃时 dropped 为空数组而非 undefined', () => {
  const r = normalizeScanRoots([rAlpha])
  assert.ok(Array.isArray(r.dropped))
  assert.equal(r.dropped.length, 0)
})

// ── B. 同源去重：符号链接视角（realpath 即生效）──────────────────────────────

test('B1 符号链接与真身同源，只留 1 根且留真身', () => {
  const link = path.join(R, 'link2alpha')
  const r = normalizeScanRoots([rAlpha, link])
  assert.equal(r.roots.length, 1)
  assert.equal(r.roots[0], rAlpha)
})

test('B2 逆序输入仍只留 1 根，且保留首次出现者（保序）', () => {
  const link = path.join(R, 'link2alpha')
  const r = normalizeScanRoots([link, rAlpha])
  assert.equal(r.roots.length, 1)
  assert.equal(r.roots[0], rAlpha, 'realpath 归一后两者同为真身路径')
})

test('B3 同源丢弃记录带可读原因', () => {
  const link = path.join(R, 'link2alpha')
  const r = normalizeScanRoots([rAlpha, link])
  assert.equal(r.dropped.length, 1)
  assert.equal(r.dropped[0]!.root, link)
  assert.ok(typeof r.dropped[0]!.reason === 'string' && r.dropped[0]!.reason.length > 0)
})

// ── C. 同源去重：跨挂载视角（只有 dev:ino 生效，realpath 必漏检）──────────────

test('C1 前置事实：跨视角两路径 realpath 不同（故 realpath 单独不足以判同源）', { skip: NO_XVIEW }, () => {
  assert.notEqual(fs.realpathSync(rAlpha), fs.realpathSync(xAlpha!))
})

test('C2 前置事实：跨视角两路径 dev:ino 相同（故必须补 dev:ino）', { skip: NO_XVIEW }, () => {
  const a = fs.statSync(rAlpha)
  const b = fs.statSync(xAlpha!)
  assert.equal(`${a.dev}:${a.ino}`, `${b.dev}:${b.ino}`)
})

test('C3 bind/firmlink 同源被 dev:ino 去重（M3 核心场景）', { skip: NO_XVIEW }, () => {
  const r = normalizeScanRoots([rAlpha, xAlpha!])
  assert.equal(r.roots.length, 1)
  assert.equal(r.dropped.length, 1)
  assert.equal(r.roots[0], rAlpha)
})

test('C4 丢弃原因明确指向 dev:ino 同源（真机排障靠这行文案定位）', { skip: NO_XVIEW }, () => {
  const r = normalizeScanRoots([rAlpha, xAlpha!])
  assert.match(r.dropped[0]!.reason, /dev:ino/)
})

test('C5 跨视角逆序输入同样只留 1 根', { skip: NO_XVIEW }, () => {
  const r = normalizeScanRoots([xAlpha!, rAlpha])
  assert.equal(r.roots.length, 1)
  assert.equal(r.roots[0], xAlpha!)
})

// ── D. 嵌套剪枝：同视角（顺序无关）───────────────────────────────────────────

test('D1 [父,子] 只留父', () => {
  const r = normalizeScanRoots([rAlpha, rChild])
  assert.equal(r.roots.length, 1)
  assert.equal(r.roots[0], rAlpha)
})

test('D2 剪枝原因说明父根已覆盖其全部文件', () => {
  const r = normalizeScanRoots([rAlpha, rChild])
  assert.match(r.dropped[0]!.reason, /位于另一扫描根之内/)
})

test('D3 [子,父] 逆序同样只留父（补全 t128 原设计的顺序依赖缺陷）', () => {
  const r = normalizeScanRoots([rChild, rAlpha])
  assert.equal(r.roots.length, 1)
  assert.equal(r.roots[0], rAlpha, '祖先关系是偏序，判定不得依赖到达顺序')
})

test('D4 三层 [祖,父,孙] 只留祖、丢弃 2 条', () => {
  const r = normalizeScanRoots([rAlpha, rChild, rGrand])
  assert.deepEqual(r.roots, [rAlpha])
  assert.equal(r.dropped.length, 2)
})

test('D5 三层完全逆序 [孙,父,祖] 仍只留祖', () => {
  const r = normalizeScanRoots([rGrand, rChild, rAlpha])
  assert.deepEqual(r.roots, [rAlpha])
  assert.equal(r.dropped.length, 2)
})

test('D6 兄弟目录不被误剪（剪枝只针对严格后代）', () => {
  const r = normalizeScanRoots([rChild, rBeta])
  assert.equal(r.roots.length, 2)
  assert.equal(r.dropped.length, 0)
})

test('D7 父子俱在时不会两个都丢（只丢严格后代，保留祖先）', () => {
  const r = normalizeScanRoots([rChild, rAlpha, rGrand])
  assert.deepEqual(r.roots, [rAlpha])
  assert.ok(r.roots.length >= 1, '必须至少保留一个根，否则扫描范围被清空')
})

// ── E. 嵌套剪枝：跨挂载视角（path.relative 字符串判定必然漏检）────────────────

test('E1 [跨视角子, 父] 只留父', { skip: NO_XVIEW }, () => {
  const r = normalizeScanRoots([xChild!, rAlpha])
  assert.deepEqual(r.roots, [rAlpha])
})

test('E2 [父, 跨视角子] 只留父', { skip: NO_XVIEW }, () => {
  const r = normalizeScanRoots([rAlpha, xChild!])
  assert.deepEqual(r.roots, [rAlpha])
})

test('E3 跨视角孙目录也被剪（dev:ino 祖先链逐级向上命中）', { skip: NO_XVIEW }, () => {
  const r = normalizeScanRoots([xGrand!, rAlpha])
  assert.deepEqual(r.roots, [rAlpha])
})

// ── F. 混合输入 ─────────────────────────────────────────────────────────────

test('F1 同源 + 嵌套 + 独立混合：保留 2 根、丢弃 2 条', () => {
  const link = path.join(R, 'link2alpha')
  const r = normalizeScanRoots([rAlpha, link, rBeta, rChild])
  assert.equal(r.roots.length, 2)
  assert.ok(r.roots.includes(rAlpha))
  assert.ok(r.roots.includes(rBeta))
  assert.equal(r.dropped.length, 2)
})

// ── G. 异常输入不阻断 ───────────────────────────────────────────────────────

test('G1 空数组 → 空结果、无异常', () => {
  const r = normalizeScanRoots([])
  assert.equal(r.roots.length, 0)
  assert.equal(r.dropped.length, 0)
})

test('G2 全空白项被过滤', () => {
  const r = normalizeScanRoots(['', '   ', '\t'])
  assert.equal(r.roots.length, 0)
})

test('G3 重复字面量只留 1 根', () => {
  const r = normalizeScanRoots([rAlpha, rAlpha, rAlpha])
  assert.equal(r.roots.length, 1)
})

test('G4 不存在的路径不抛异常且各自保留（交 worker 按既有容错跳过）', () => {
  const r = normalizeScanRoots([path.join(R, 'nope1'), path.join(R, 'nope2')])
  assert.equal(r.roots.length, 2)
})

test('G5 同一不存在路径重复 → 字符串去重为 1', () => {
  const p = path.join(R, 'nope1')
  const r = normalizeScanRoots([p, p])
  assert.equal(r.roots.length, 1)
})

test('G6 含 . 与 .. 的写法被规范化', () => {
  const r = normalizeScanRoots([`${rAlpha}/./child/../child`])
  assert.deepEqual(r.roots, [rChild])
})

test('G7 尾斜杠与无尾斜杠视为同一根', () => {
  const r = normalizeScanRoots([`${rAlpha}/`, rAlpha])
  assert.equal(r.roots.length, 1)
})

test('G8 相对路径被 resolve 为绝对路径', () => {
  const r = normalizeScanRoots(['test/fixtures'])
  assert.equal(r.roots.length, 1)
  assert.ok(path.isAbsolute(r.roots[0]!), '相对路径必须被 resolve，否则 worker 按 cwd 枚举会漂')
  assert.equal(r.roots[0], fs.realpathSync(path.resolve('test/fixtures')))
})

// ── H. 契约性质 ─────────────────────────────────────────────────────────────

test('H1 幂等：对规范化结果再规范化不改变结果', () => {
  const link = path.join(R, 'link2alpha')
  const once = normalizeScanRoots([rAlpha, link, rBeta, rChild])
  const twice = normalizeScanRoots(once.roots)
  assert.deepEqual(twice.roots, once.roots)
  assert.equal(twice.dropped.length, 0, '已规范化的输入不应再被剪枝')
})

test('H2 每条丢弃记录都含 root 原文与 reason 文案', () => {
  const link = path.join(R, 'link2alpha')
  const r = normalizeScanRoots([rAlpha, link, rChild])
  assert.equal(r.dropped.length, 2)
  for (const d of r.dropped) {
    assert.equal(typeof d.root, 'string')
    assert.equal(typeof d.reason, 'string')
    assert.ok(d.reason.length > 0)
  }
})

test('H3 不修改入参数组（无副作用）', () => {
  const input = [rChild, rAlpha]
  const snapshot = [...input]
  normalizeScanRoots(input)
  assert.deepEqual(input, snapshot)
})

test('H4 dropped 记录的 root 是调用方传入的原文而非 realpath（便于对账）', () => {
  const link = path.join(R, 'link2alpha')
  const r = normalizeScanRoots([rAlpha, link])
  assert.equal(r.dropped[0]!.root, link, '取证日志要能让真机核对者认出自己传进来的那个写法')
})
