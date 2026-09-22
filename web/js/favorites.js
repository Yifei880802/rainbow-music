/**
 * favorites.js — 「我喜欢」收藏公共模块（P2 O2）
 *
 * 与 download-state.js 同范式收敛：搜索结果行（分组视图 / 合并视图 MergedTrack /
 * 合并展开区各 source）与 now-playing 播放器共用同一份收藏态与同一套心形控件，
 * 避免各页各持一份 Set 导致「搜索页点了心形、播放器不同步」。
 *
 * - ref 口径：统一走 download-state.js 的 songKey(platform, songmid) → `platform:songmid`
 *   （与 owned Map / 批量去重同 key，跨页天然对齐；后端 ref 为自由字符串，无自带口径）
 * - kind 固定 'track'（服务端白名单 track|playlist|square）
 * - 乐观更新：先翻本地集合 + 广播事件刷新所有心形，再落库；失败回滚并 toast
 * - 事件：document 上派发 `favorites:changed`，detail = { ref, favored, reason }
 *   reason ∈ 'load'（快照到位）| 'toggle'（本次点击）| 'rollback'（落库失败回滚）
 *
 * 后端契约（只读确认于 server/src/routes/me.ts，勿臆造路径）：
 *   GET    /api/v1/me/favorites                → { favorites:[{ kind, ref, createdAt }] }
 *   POST   /api/v1/me/favorites  { kind, ref } → { ok:true, added:boolean }
 *   DELETE /api/v1/me/favorites/:kind/:ref     → { ok:true, deleted:boolean }
 *   护栏：kind ∉ 白名单 → 400；ref 非空字符串且 ≤1024 字符；UNIQUE(uid,kind,ref) 天然去重
 */

import { escapeHtml, toast } from './ui.js'
import { api } from './api.js'
import { songKey } from './download-state.js'

/** 收藏类别：本模块只处理曲目收藏（歌单/广场收藏另由对应页消费同一批端点） */
export const FAV_KIND = 'track'

/** 心形图标（Feather heart 路径；stroke 常驻，.on 时由 CSS 填成实心） */
const HEART_SVG =
  '<svg class="ic-heart" viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 0 0 0-7.78z"/></svg>'

/** kind=track 的已收藏 ref 集合（platform:songmid） */
let favored = new Set()
let loaded = false
let inflight = null
/** 在途 toggle 计数：>0 时同一 ref 的再次点击排队拒绝（防连点造成 add/remove 交错错位） */
const pending = new Set()

// ---------- ref 口径 ----------

/** 收藏 ref（= owned / 去重用的同一把 songKey，跨模块对齐） */
export const favRef = (platform, songmid) => songKey(platform, songmid)

/**
 * 是否可收藏：需要真实的 platform + songmid。
 * NAS 扫描曲（library.js 入队时 platform='nas'、无 songmid）不在音源曲库内，
 * 收藏无从复现 → 控件降级为禁用（不隐藏，保持布局稳定与可解释性）。
 */
export function favCan(t) {
  if (!t) return false
  const p = t.platform
  const m = t.songmid
  if (!p || p === 'nas') return false
  return m !== undefined && m !== null && String(m) !== ''
}

/** 当前是否已收藏 */
export function isFavored(platform, songmid) {
  return favored.has(favRef(platform, songmid))
}

/** 只读快照（计数 / 未来「只看收藏」筛选用；不要直接改） */
export function favoredSet() {
  return favored
}

/** 快照是否已就绪（未就绪时心形按未收藏渲染，到位后由 favorites:changed 补齐） */
export function favoritesLoaded() {
  return loaded
}

// ---------- 事件 ----------

function emit(ref, favoredNow, reason) {
  document.dispatchEvent(new CustomEvent('favorites:changed', { detail: { ref, favored: favoredNow, reason } }))
}

// ---------- 快照拉取 ----------

/**
 * 拉取「我喜欢」快照重建本地集合（并发去重：同一时刻只有一个在途请求）。
 * 失败一律静默并保持现有集合——端点缺失/网络抖动不应把已知收藏洗白，也不阻断搜索。
 * @param {boolean} [force] 强制重拉（进入搜索页 / SSE 重连后对账）
 */
export async function loadFavorites(force = false) {
  if (loaded && !force) return favored
  if (inflight) return inflight
  inflight = (async () => {
    try {
      const r = await api.me.favorites()
      const set = new Set()
      for (const f of r?.favorites || []) {
        if (f && f.kind === FAV_KIND && f.ref) set.add(String(f.ref))
      }
      favored = set
      loaded = true
      emit(null, null, 'load')
    } catch {
      /* 静默降级：心形保持未收藏态，点击仍会尝试落库（POST 成功即转正） */
    } finally {
      inflight = null
    }
  })()
  return inflight
}

// ---------- 乐观 toggle ----------

/**
 * 收藏/取消收藏（乐观更新 + 失败回滚）。
 * @param {{platform?:string, songmid?:string|number, ref?:string, name?:string, silent?:boolean}} t
 * @returns {Promise<boolean>} 最终收藏态（false = 未收藏 / 已取消 / 不可收藏）
 */
export async function toggleFavorite(t = {}) {
  const ref = t.ref || (favCan(t) ? favRef(t.platform, t.songmid) : '')
  if (!ref) return false
  if (pending.has(ref)) return favored.has(ref) // 在途：忽略连点，返回当前乐观态
  const next = !favored.has(ref)
  pending.add(ref)
  applyLocal(ref, next)
  emit(ref, next, 'toggle')
  try {
    if (next) await api.me.addFavorite(FAV_KIND, ref)
    else await api.me.removeFavorite(FAV_KIND, ref)
    if (!t.silent) toast(next ? `已收藏到「我喜欢」${t.name ? '：' + t.name : ''}` : `已取消收藏${t.name ? '：' + t.name : ''}`)
    return next
  } catch (err) {
    // 回滚到点击前状态（POST/DELETE 失败或端点不可用）
    applyLocal(ref, !next)
    emit(ref, !next, 'rollback')
    toast(`收藏失败: ${err?.message || err}`)
    return !next
  } finally {
    pending.delete(ref)
  }
}

/** 直接写本地集合（不发请求）：供快照到位后对齐、或外部已知结果时同步 UI */
export function setFavoredLocal(ref, on) {
  if (!ref) return
  applyLocal(ref, !!on)
  emit(ref, !!on, 'toggle')
}

function applyLocal(ref, on) {
  if (on) favored.add(ref)
  else favored.delete(ref)
}

// ---------- 心形控件 HTML / DOM 同步 ----------

/**
 * 生成心形 toggle 按钮 HTML（与三态下载钮并排，独立控件互不干扰）。
 * @param {object} o
 * @param {string} [o.platform]  平台（与 songmid 一起构成 ref）
 * @param {string|number} [o.songmid]
 * @param {string} [o.ref]       直接指定 ref（优先级高于 platform/songmid）
 * @param {string} [o.name]      曲目名（aria-label / toast 用）
 * @param {string} [o.extraClass] 追加类名（如播放器内的 pb-fav）
 */
export function heartHtml({ platform, songmid, ref, name = '', extraClass = '' } = {}) {
  const can = !!ref || favCan({ platform, songmid })
  const key = ref || (can ? favRef(platform, songmid) : '')
  const cls = `row-fav${extraClass ? ' ' + extraClass : ''}`
  if (!can) {
    return `<button class="${cls} na" type="button" disabled aria-hidden="true" tabindex="-1" title="本地扫描曲目暂不支持收藏">${HEART_SVG}</button>`
  }
  const on = favored.has(key)
  const label = on ? '取消收藏' : '收藏到「我喜欢」'
  return `<button class="${cls}${on ? ' on' : ''}" data-fav="${escapeHtml(key)}" type="button" aria-pressed="${on}" aria-label="${escapeHtml(label + (name ? '：' + name : ''))}" title="${escapeHtml(on ? '已收藏 · 点击取消' : '收藏到「我喜欢」')}">${HEART_SVG}</button>`
}

/**
 * 把一个已存在的心形按钮同步到当前集合状态（免整行重渲染）。
 * 禁用态（NAS 曲目）不动。
 * @param {HTMLElement} btn
 * @param {boolean} [pop] 是否播一次 pop 动画（仅用户 toggle 时为 true；
 *                        快照到位/筛选排序重渲染不播，避免满屏心形齐跳）
 */
export function syncHeart(btn, pop = false) {
  if (!btn || !btn.dataset || btn.dataset.fav === undefined) return
  const on = favored.has(btn.dataset.fav)
  btn.classList.toggle('on', on)
  btn.setAttribute('aria-pressed', String(on))
  const base = btn.getAttribute('aria-label') || ''
  btn.setAttribute('aria-label', (on ? '取消收藏' : '收藏到「我喜欢」') + base.replace(/^(取消收藏|收藏到「我喜欢」)/, ''))
  btn.title = on ? '已收藏 · 点击取消' : '收藏到「我喜欢」'
  if (pop) popOnce(btn)
}

/**
 * 批量同步容器内所有心形（快照到位 / 切页对账 / 筛选排序重渲染后调用）。
 * @param {ParentNode} [root] 缺省整个 document
 * @param {boolean} [pop] 是否播 pop 动画
 */
export function syncHearts(root, pop = false) {
  const scope = root || document
  scope.querySelectorAll?.('button[data-fav]').forEach((b) => syncHeart(b, pop))
}

/** 一次性 pop 反馈（类名驱动 CSS 动画，动效结束后自行摘除） */
export function popOnce(btn) {
  if (!btn) return
  btn.classList.remove('pop')
  // 强制重流，连点时动画能重新起跑
  void btn.offsetWidth
  btn.classList.add('pop')
  setTimeout(() => btn.classList.remove('pop'), 320)
}

/**
 * 点击委托入口（与 download-state 的行内控件同范式）。
 * 命中收藏钮时自行 stopPropagation + preventDefault，避免冒泡到行的
 * 播放/下载/展开/勾选逻辑；未命中返回 false 交由后续分支处理。
 * @param {Event} e
 * @param {(btn:HTMLElement)=>string} [nameOf] 由按钮反查曲目名（toast 文案用）
 */
export function handleFavClick(e, nameOf) {
  const btn = e.target?.closest?.('button[data-fav]')
  if (!btn) return false
  e.preventDefault()
  e.stopPropagation()
  const ref = btn.dataset.fav
  const [platform, songmid] = String(ref).split(':')
  void toggleFavorite({ ref, platform, songmid, name: typeof nameOf === 'function' ? nameOf(btn) : '' })
  return true
}
