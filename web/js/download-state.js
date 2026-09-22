/**
 * download-state.js — 公共三态下载状态模块（P0-A1）
 *
 * 收敛 home.js / playlists.js / library.js 三处复制粘贴的：
 * - owned 映射（key = `platform:songmid`）与代表任务合并逻辑
 * - STATUS_RANK（done > busy > failed/canceled）
 * - 三态按钮 HTML 生成（未下载=下载钮 / 下载中=进度环 / 已下载=绿勾 hover 播放三角）
 * - 进度环常量（28px 小环 SMALL_RING_LEN / 40px 队列环 QUEUE_RING_LEN）
 * - SSE task 事件名清单 + connected 重连对账 helper
 *
 * 迁移铁律：各页 DOM 选择器 / 类名 / id / 事件绑定 / 行为完全等价，零功能回归。
 */

import { escapeHtml } from './ui.js'
import { api } from './api.js'

// ---------- 常量 ----------

/** 行状态代表任务优先级：done > busy > failed/canceled（同档取 updatedAt 新） */
export const STATUS_RANK = {
  completed: 3,
  completed_with_warnings: 3,
  active: 2,
  pending: 2,
  failed: 1,
  canceled: 0,
}

/** 28px 进度环 r=9 周长（2πr ≈ 56.55）— home.js HP_RING_LEN / playlists.js PL_RING_LEN 收敛 */
export const SMALL_RING_LEN = 56.55

/** 40px 进度环 r=16 周长（2πr ≈ 100.53）— library.js RING_LEN 收敛 */
export const QUEUE_RING_LEN = 100.53

/** SSE task 事件清单（负载 = 完整任务视图；与 sse.js EVENT_NAMES 同源子集） */
export const TASK_EVENTS = [
  'task:created',
  'task:pending',
  'task:active',
  'task:completed',
  'task:completed_with_warnings',
  'task:failed',
  'task:canceled',
]

// ---------- 状态判定 ----------

/** 任务终态（可播） */
export const isDone = (t) => !!t && (t.status === 'completed' || t.status === 'completed_with_warnings')

/** 任务进行态（下载中：环脉冲） */
export const isBusy = (t) => !!t && (t.status === 'pending' || t.status === 'active')

// ---------- owned 映射 ----------

/** 构建 owned key（platform:songmid） */
export const songKey = (platform, songmid) => `${platform}:${songmid}`

/**
 * 代表任务合并入 map：新视图优先于旧值（同曲多任务时保留最高优先级）。
 * 等价于原 home.js ownedUpsert / playlists.js plMerge。
 */
export function mergeOwned(map, view) {
  if (!view || !view.id || !view.platform || !view.songmid) return
  const key = `${view.platform}:${view.songmid}`
  const prev = map.get(key)
  if (!prev) {
    map.set(key, view)
    return
  }
  // P0-fix#3: 同任务状态迁移（active→failed 等）无条件覆盖，rank 仅用于同 key 不同任务选代表
  if (prev.id === view.id) {
    map.set(key, view)
    return
  }
  const pr = STATUS_RANK[prev.status] ?? 0
  const nr = STATUS_RANK[view.status] ?? 0
  if (nr > pr || (nr === pr && (view.updatedAt || 0) >= (prev.updatedAt || 0))) map.set(key, view)
}

/**
 * 从任务数组构建 owned Map（全量快照）。
 * 等价于原 home.js reconcileOwned 内部 / playlists.js ownedTaskMap 内部。
 */
export function buildOwnedMap(tasks) {
  const map = new Map()
  for (const t of tasks || []) mergeOwned(map, t)
  return map
}

/**
 * 拉全量终态任务快照重建 owned Map（async）。
 * #196-fix2: 改用 /tasks/owned 轻量端点（覆盖全部 completed+failed，无分页截断）。
 * 失败时返回空 Map（行为回退为全下载态，SSE 增量仍可补齐）。
 */
export async function reconcileOwned() {
  try {
    const r = await api.tasks.owned()
    const map = new Map()
    for (const o of r.owned || []) {
      // owned 端点返回 { key, taskId, status, quality, hasFile }
      // 转换为 mergeOwned 兼容的 view 结构
      const [platform, songmid] = o.key.split(':')
      mergeOwned(map, {
        id: o.taskId,
        platform,
        songmid,
        status: o.status,
        requestedQuality: o.quality,
        filePath: o.hasFile ? 'yes' : null,
      })
    }
    return map
  } catch {
    return new Map()
  }
}

// ---------- 三态按钮 HTML ----------

/**
 * 生成行内三态状态按钮 HTML（与迁移前 home.js rowStateCtl / playlists.js plStateBtn 输出逐字节等价）。
 *
 * @param {object} opts
 * @param {object|null|undefined} opts.task  代表任务视图（null/undefined = 未下载）
 * @param {string} opts.name                 歌曲名（aria-label 用）
 * @param {string} opts.dlAttr               未下载态 data 属性名（home: 'data-dl' / playlists: 'data-song'）
 * @param {string} opts.dlValue              未下载态 data 属性值（home: songmid / playlists: encoded payload）
 * @param {number} [opts.ringLen]            进度环周长（默认 SMALL_RING_LEN）
 * @returns {string} button HTML
 */
export function stateButtonHtml({ task, name, dlAttr, dlValue, ringLen = SMALL_RING_LEN }) {
  const t = task
  if (isDone(t)) {
    return `<button class="row-dl done" data-play="${escapeHtml(String(t.id))}" type="button" aria-label="播放已下载的 ${escapeHtml(name)}" title="已下载到本地 · 点击播放"><svg class="ic-ok" viewBox="0 0 12 12" width="12" height="12" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M2 6.5l2.6 2.6L10 3.5"/></svg><svg class="ic-go" viewBox="0 0 12 12" width="11" height="11" fill="currentColor" aria-hidden="true"><path d="M3 1.5v9l7.5-4.5z"/></svg></button>`
  }
  if (isBusy(t)) {
    const pct = t.progress || 0
    return `<button class="row-dl hp-dl-ing" data-task="${escapeHtml(String(t.id))}" type="button" disabled title="下载中 ${pct}%"><svg class="hp-ring" viewBox="0 0 28 28" width="16" height="16" aria-hidden="true"><circle class="hp-ring-track" cx="14" cy="14" r="9" /><circle class="hp-ring-fill" cx="14" cy="14" r="9" style="stroke-dasharray:${ringLen};stroke-dashoffset:${(ringLen * (1 - pct / 100)).toFixed(2)}" /></svg></button>`
  }
  // 未下载（含 failed/canceled 代表任务：回到可下载态，可再次提交新任务）
  const failed = t && (t.status === 'failed' || t.status === 'canceled')
  return `<button class="row-dl" ${dlAttr}="${escapeHtml(dlValue)}" type="button" aria-label="下载 ${escapeHtml(name)}" title="${failed ? '上次下载未完成，点击重试' : '下载这首'}"><svg viewBox="0 0 12 12" width="11" height="11" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M6 1.5v7M3 6l3 3 3-3M2 10.5h8"/></svg></button>`
}

// ---------- 进度环局部更新 ----------

/**
 * 更新进度环 SVG 的 stroke-dashoffset + title（免整行重渲染）。
 * @param {HTMLElement} btn  包含 .hp-ring-fill 的按钮元素
 * @param {number} percent   0-100
 * @param {number} [ringLen] 环周长（默认 SMALL_RING_LEN）
 */
export function updateRingProgress(btn, percent, ringLen = SMALL_RING_LEN) {
  if (!btn) return
  const fill = btn.querySelector('.hp-ring-fill')
  if (fill) fill.style.strokeDashoffset = (ringLen * (1 - (percent || 0) / 100)).toFixed(2)
  btn.title = `下载中 ${percent || 0}%`
}

/**
 * 更新 40px 队列环进度（library.js 专用：.dl-ring-fill + .dl-ring-pct）。
 * @param {HTMLElement} row   .queue-row 元素
 * @param {number} percent    0-100
 */
export function updateQueueRing(row, percent) {
  if (!row) return
  const ringFill = row.querySelector('.dl-ring-fill')
  if (ringFill) ringFill.style.strokeDashoffset = String(QUEUE_RING_LEN * (1 - (percent || 0) / 100))
  const ringPct = row.querySelector('.dl-ring-pct')
  if (ringPct) ringPct.textContent = `${percent || 0}%`
}

// ---------- 批量下载去重 ----------

/**
 * 批量下载前端去重（P1-I4）：按 (platform:songmid) 排除已在库（completed）的条目。
 * 收敛 home.js downloadAll / playlists.js / search.js 各处去重为单一实现。
 *
 * @param {Array<{platform:string, songmid:string}>} items  待下载条目
 * @param {Map<string,any>} ownedMap  owned 映射 (key=`platform:songmid` → task view)
 * @returns {{ pending: typeof items, skipped: number }}  pending=去重后待入队；skipped=已在库跳过数
 */
export function dedupeItems(items, ownedMap) {
  const doneKeys = new Set()
  for (const [k, t] of ownedMap) {
    if (isDone(t)) doneKeys.add(k)
  }
  const pending = items.filter((it) => !doneKeys.has(`${it.platform}:${it.songmid}`))
  return { pending, skipped: items.length - pending.length }
}

// ---------- SSE 订阅 helper ----------

/**
 * 批量注册 task 状态事件监听（TASK_EVENTS 全集）。
 * @param {import('./sse.js')} sse  sse 模块引用
 * @param {(view: any) => void} handler
 */
export function subscribeTaskEvents(sse, handler) {
  for (const ev of TASK_EVENTS) sse.on(ev, handler)
}
