/**
 * 搜索页：单曲 / 歌单搜索（单平台 + 聚合）
 * 交互：多选勾选、全选、批量下载、一键加入歌单、歌单详情展开
 * #57 实时联想：输入防抖 300ms 调聚合搜索（限 wy/tx 各前 5 条，title
 * 跨平台去重），与搜索历史共用同一浮层容器（无输入 = 纯历史；
 * 有输入 = 联想组在上 + 历史组在下，组标题区分）；请求序号竞态保护；
 * 联想项点击回填关键词直接发起完整搜索；Enter 仍走原生完整搜索。
 */
import { $, $$, escapeHtml, toast, PLATFORM_NAME, pickPlaylistModal } from '../ui.js'
import { api } from '../api.js'
import { store } from '../storage.js'

const state = {
  results: [], // 扁平化的歌曲列表（含 platform）
  selected: new Set(), // 选中项 key（platform:songmid）
  quality: 'flac',
}

const rowKey = (item) => `${item.platform}:${item.songmid}`

/* ============================================================
   * P0-3 · 搜索历史（storage.js 键 `searchHistory`，按 uid 前缀隔离，
   * 最近 10 条去重置顶；v0.2.0 旧无前缀键存量读取自动回落生效）
   #57 · 实时联想：输入防抖 300ms 调聚合搜索（限 wy/tx 各前 5 条，title
   跨平台去重后上限 10 条），与历史共用同一浮层容器：
   - 无输入：纯历史面板（focus 弹出，↑↓ / Enter / Esc / × 单删 / 清空）
   - 有输入：联想组在上（loading → 结果 / 「无联想，回车搜索」）+
     历史组在下（按输入前缀包含过滤）；防抖等待期不显示联想组避免闪烁
   - 竞态保护：suggestSeq 序号，响应回来时已过期则丢弃
   ============================================================ */
const HISTORY_KEY = 'searchHistory' // storage.js 自动加 rainbow.<uid>. 前缀
const HISTORY_MAX = 10
const SUGGEST_PLATFORMS = 'wy,tx' // 联想限定平台（控制后端压力，见 API.md §2）
const SUGGEST_PER_PLATFORM = 5 // 每平台取前 5 条
const SUGGEST_MAX = 10 // title 跨平台去重后上限
const SUGGEST_DEBOUNCE = 300 // 输入防抖 ms

let historyPop = null // 建议面板（首次展示时懒创建，挂 #search-form 内）
let popIdx = -1 // 键盘导航下标（统一覆盖联想项+历史项；-1 = 未选择，Enter 走原生提交）
let historyBlurTimer = 0
let suggestTimer = 0 // 联想防抖定时器
let suggestSeq = 0 // 联想请求序号（竞态丢弃依据）
let suggestItems = [] // [{name, singer}] 去重后的联想项
let suggestKeyword = '' // 当前联想结果对应的输入（空 = 尚无已完成的联想）
let suggestLoading = false

function readHistory() {
  try {
    const list = JSON.parse(store.get(HISTORY_KEY) || '[]')
    return Array.isArray(list) ? list.filter((it) => it && typeof it.kw === 'string' && it.kw.trim()) : []
  } catch {
    return []
  }
}

function writeHistory(list) {
  try {
    store.set(HISTORY_KEY, JSON.stringify(list.slice(0, HISTORY_MAX)))
  } catch {
    /* 隐私模式/配额满：仅本会话内失效 */
  }
}

/** 搜索成功渲染后写入：同词去重置顶并刷新时间戳与上下文 */
function recordSearch(kw, type, platform) {
  writeHistory([{ kw, type, platform, ts: Date.now() }, ...readHistory().filter((it) => it.kw !== kw)])
  hidePop()
}

function ensureHistoryPop() {
  if (historyPop) return historyPop
  historyPop = document.createElement('div')
  historyPop.id = 'search-history-pop'
  historyPop.className = 'search-history-pop'
  historyPop.hidden = true
  // 面板内 pointerdown 阻止搜索框先行 blur 收起（与 blur 延迟双保险）
  historyPop.addEventListener('pointerdown', (e) => e.preventDefault())
  historyPop.addEventListener('click', onPopClick)
  $('#search-form').appendChild(historyPop)
  return historyPop
}

/** 当前输入过滤后的历史列表（空输入 = 全量） */
function historyItems() {
  const kw = $('#keyword').value.trim().toLowerCase()
  const list = readHistory()
  return kw ? list.filter((it) => it.kw.toLowerCase().includes(kw)) : list
}

/** 当前可导航的联想项数（loading 中尚无结果，不参与导航计数） */
function suggestNavCount() {
  const kw = $('#keyword').value.trim()
  return kw && !suggestLoading ? suggestItems.length : 0
}

/** 统一键盘导航项：联想项在前、历史项在后（返回 [{kw}] 供回填提交） */
function navItems() {
  const sg = suggestNavCount() ? suggestItems.map((it) => ({ kw: it.name })) : []
  return [...sg, ...historyItems().map((it) => ({ kw: it.kw }))]
}

/** #57 联想请求（防抖后触发）：序号竞态保护 + title 跨平台去重 */
async function fetchSuggest(kw) {
  const seq = ++suggestSeq
  suggestLoading = true
  if (historyPop && !historyPop.hidden) renderPop()
  try {
    const data = await api.search.aggregate({
      keyword: kw,
      page: 1,
      platforms: SUGGEST_PLATFORMS,
      limit: SUGGEST_PER_PLATFORM,
    })
    if (seq !== suggestSeq) return // 输入已变化 / 面板已关闭 → 丢弃过期响应
    const seen = new Set()
    const items = []
    for (const pr of data.results || []) {
      if (!pr.ok || !Array.isArray(pr.list)) continue
      for (const s of pr.list) {
        const name = (s.name || '').trim()
        if (!name || seen.has(name)) continue
        seen.add(name)
        items.push({ name, singer: (s.singer || '').trim() })
        if (items.length >= SUGGEST_MAX) break
      }
      if (items.length >= SUGGEST_MAX) break
    }
    suggestItems = items
  } catch {
    if (seq !== suggestSeq) return
    suggestItems = [] // 网络失败静默降级：仅历史组可用，不打断输入体验
  } finally {
    if (seq === suggestSeq) {
      suggestLoading = false
      suggestKeyword = kw
      if (historyPop && !historyPop.hidden) renderPop()
    }
  }
}

/** 混合建议面板渲染：联想组（上，仅输入非空且非防抖等待）+ 历史组（下） */
function renderPop() {
  const pop = ensureHistoryPop()
  const kw = $('#keyword').value.trim()
  const hasKw = !!kw
  const items = historyItems()
  const sgCount = suggestNavCount()
  if (popIdx >= sgCount + items.length) popIdx = -1

  // ---- 联想组 ----
  let sgHtml = ''
  if (hasKw && (suggestLoading || suggestKeyword)) {
    const meta = suggestLoading ? kw : suggestKeyword // loading 态显示当前词，完成态显示结果对应词
    const head = `<div class="sh-head"><span>实时联想</span><span class="sh-meta">${escapeHtml(meta)}</span></div>`
    if (suggestLoading) {
      sgHtml = `<div class="pop-group">${head}<div class="sh-empty sg-loading">联想中…</div></div>`
    } else if (suggestItems.length) {
      sgHtml = `<div class="pop-group">${head}${suggestItems
        .map(
          (it, i) => `
      <button class="sg-item${i === popIdx ? ' active' : ''}" type="button" data-sg="${escapeHtml(it.name)}" title="搜索 ${escapeHtml(it.name)}">
        <svg class="sh-ico" viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" aria-hidden="true"><circle cx="11" cy="11" r="7"/><path d="M20 20l-3.5-3.5"/></svg>
        <span class="sg-name">${escapeHtml(it.name)}</span>
        ${it.singer ? `<span class="sg-singer">${escapeHtml(it.singer)}</span>` : ''}
      />`,
        )
        .join('')}</div>`
    } else {
      sgHtml = `<div class="pop-group">${head}<div class="sh-empty">无联想，回车搜索</div></div>`
    }
  }

  // ---- 历史组（有输入但无匹配时省略：联想区已有「无联想」兜底） ----
  let hHtml = ''
  if (items.length) {
    hHtml = `<div class="pop-group"><div class="sh-head"><span>搜索历史</span><button class="sh-clear" type="button">清空</button></div>${items
      .map(
        (it, i) => `
      <button class="sh-item${sgCount + i === popIdx ? ' active' : ''}" type="button" data-kw="${escapeHtml(it.kw)}" title="搜索 ${escapeHtml(it.kw)}">
        <svg class="sh-ico" viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" aria-hidden="true"><circle cx="12" cy="12" r="8.5"/><path d="M12 7.5V12l3 2"/></svg>
        <span class="sh-kw">${escapeHtml(it.kw)}</span>
        <span class="sh-x" role="button" aria-label="删除这条历史" title="删除">×</span>
      </button>`,
      )
      .join('')}</div>`
  } else if (!hasKw) {
    hHtml = '<div class="sh-empty">无匹配历史</div>'
  }
  pop.innerHTML = sgHtml + hHtml
  return sgCount + items.length
}

function showPop() {
  const kw = $('#keyword').value.trim()
  if (!kw && !readHistory().length) return
  popIdx = -1
  renderPop()
  historyPop.hidden = false
}

function hidePop() {
  clearTimeout(historyBlurTimer)
  if (historyPop) historyPop.hidden = true
  popIdx = -1
  // 取消未发出的联想 + 作废在途响应（下次 focus/输入重新发起）
  clearTimeout(suggestTimer)
  suggestSeq++
  suggestItems = []
  suggestKeyword = ''
  suggestLoading = false
}

/** 面板点击委托：清空 / 单条删除 / 联想项或历史项回填并立即搜索 */
function onPopClick(e) {
  if (e.target.closest('.sh-clear')) {
    writeHistory([])
    hidePop()
    toast('已清空搜索历史')
    return
  }
  const sg = e.target.closest('.sg-item')
  if (sg) {
    // #57 联想项：关键词回填 + 直接发起完整搜索
    $('#keyword').value = sg.dataset.sg
    hidePop()
    $('#search-form').dispatchEvent(new Event('submit'))
    return
  }
  const item = e.target.closest('.sh-item')
  if (!item) return
  const kw = item.dataset.kw
  if (e.target.closest('.sh-x')) {
    writeHistory(readHistory().filter((it) => it.kw !== kw))
    if (!historyItems().length && !suggestNavCount()) hidePop()
    else renderPop()
    return
  }
  $('#keyword').value = kw
  hidePop()
  $('#search-form').dispatchEvent(new Event('submit'))
}

/** 搜索框键盘：面板打开时 ↑↓ 循环选择（联想+历史统一序）/ Enter 用选中项 / Esc 关闭 */
function onKeywordKeydown(e) {
  if (!historyPop || historyPop.hidden) return
  const items = navItems()
  if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
    e.preventDefault()
    if (!items.length) return
    popIdx =
      e.key === 'ArrowDown'
        ? (popIdx + 1) % items.length
        : popIdx <= 0
          ? items.length - 1
          : popIdx - 1
    renderPop()
    historyPop.querySelector('.sg-item.active, .sh-item.active')?.scrollIntoView({ block: 'nearest' })
  } else if (e.key === 'Enter') {
    if (popIdx >= 0 && items[popIdx]) {
      e.preventDefault()
      $('#keyword').value = items[popIdx].kw
      hidePop()
      $('#search-form').dispatchEvent(new Event('submit'))
    }
    // popIdx = -1：不拦截，走原生提交（正在输入的词完整搜索）
  } else if (e.key === 'Escape') {
    e.preventDefault()
    hidePop()
  }
}

function initSearchHistory() {
  const kw = $('#keyword')
  kw.addEventListener('focus', showPop)
  kw.addEventListener('input', () => {
    // #57 输入变化：重置联想状态 + 防抖 300ms 后发起联想；面板即时重渲染
    clearTimeout(suggestTimer)
    suggestItems = []
    suggestKeyword = ''
    suggestLoading = false
    const kwText = kw.value.trim()
    if (kwText) {
      suggestTimer = setTimeout(() => fetchSuggest(kwText), SUGGEST_DEBOUNCE)
    } else {
      suggestSeq++ // 清空输入：在途联想响应作废，回纯历史面板
    }
    if (historyPop && !historyPop.hidden) renderPop()
    else showPop() // 无历史时首次输入也弹出（联想即将到来）
  })
  kw.addEventListener('blur', () => {
    // 延迟收起，给面板 click 留出触发窗口
    clearTimeout(historyBlurTimer)
    historyBlurTimer = setTimeout(hidePop, 150)
  })
  kw.addEventListener('keydown', onKeywordKeydown)
}

// ---------- 初始化 ----------
export function init() {
  $('#search-form').addEventListener('submit', onSearch)
  $('#check-all').addEventListener('change', onCheckAll)
  $('#batch-download').addEventListener('click', onBatchDownload)
  $('#batch-add-playlist').addEventListener('click', onBatchAddPlaylist)
  // 行内单首下载（事件委托：data-dl 携带行 key，歌单详情展开后同样生效）
  $('#results').addEventListener('click', onRowDownload)
  // P0-3：搜索历史（focus 下拉 + 键盘导航 + 写入）
  initSearchHistory()
}

export function show() {}

// ---------- 搜索入口 ----------
async function onSearch(e) {
  e.preventDefault()
  const keyword = $('#keyword').value.trim()
  if (!keyword) return
  state.quality = $('#quality').value
  const platform = $('#platform').value
  const searchType = $('#search-type').value
  $('#search-status').textContent = '搜索中…'
  resetResults()

  try {
    if (searchType === 'songlist') {
      if (platform === 'aggregate') {
        renderSongListAggregate(await api.search.songlistAggregate({ keyword, page: 1 }))
      } else {
        renderSongListSingle(platform, await api.search.songlist({ keyword, platform, page: 1 }))
      }
      recordSearch(keyword, searchType, platform) // P0-3：成功渲染后写入历史
      return
    }
    if (platform === 'aggregate') {
      renderAggregate(await api.search.aggregate({ keyword, page: 1 }))
    } else {
      renderSingle(platform, await api.search.song({ keyword, platform, page: 1 }))
    }
    recordSearch(keyword, searchType, platform) // P0-3：成功渲染后写入历史
  } catch (err) {
    $('#search-status').textContent = `搜索失败: ${err.message}`
  }
}

function resetResults() {
  $('#results').innerHTML = ''
  state.results = []
  state.selected.clear()
  updateSelectedCount()
}

// ---------- P1b：聚合源失效警示条 ----------
/**
 * 聚合搜索中某平台（聚合源）请求完全失败（ok=false）时，
 * 在结果区顶部集中提示「该音源不可用」，避免用户对同一平台重复尝试。
 * - 仅个别平台失败且整体仍有结果 → 常规警示条（不高亮整体，不打断浏览）
 * - 全部平台失败 → severe 强化态（整体染红）
 * 判定信号：聚合响应 results[].ok / error（现有结构已具备，无需后端改动）
 */
function appendSourceWarnings(container, results) {
  const failed = (results || []).filter((pr) => !pr.ok)
  if (!failed.length) return
  const allFailed = failed.length === (results || []).length
  const banner = document.createElement('div')
  banner.className = `src-warn-banner${allFailed ? ' severe' : ''}`
  banner.setAttribute('role', 'alert')
  banner.setAttribute('aria-live', 'polite')
  const names = failed.map((pr) => PLATFORM_NAME[pr.platform] || pr.platform)
  const detail = failed
    .map((pr) => `${PLATFORM_NAME[pr.platform] || pr.platform}：${escapeHtml(String(pr.error || '未知错误').slice(0, 90))}`)
    .join('；')
  banner.innerHTML = `
    <svg class="swb-ico" viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 3 2.5 20h19L12 3z"/><path d="M12 9.5v4.5"/><circle cx="12" cy="17.2" r=".4" fill="currentColor"/></svg>
    <div class="swb-body">
      <div class="swb-title">${names.map(escapeHtml).join('、')}音源不可用${allFailed ? '（本次搜索无结果）' : ''}</div>
      <div class="swb-detail">${detail}。该平台结果已跳过，请稍后再试，或前往「音源管理」检查状态。</div>
    </div>`
  container.appendChild(banner)
}

// ---------- 歌单搜索渲染 ----------
function renderSongListAggregate(data) {
  const container = $('#results')
  appendSourceWarnings(container, data.results) // P1b：失效警示条
  let total = 0
  for (const pr of data.results) {
    if (pr.ok && pr.list.length) total += pr.list.length
    container.appendChild(renderSongListGroup(pr.platform, pr.list, pr.ok ? null : pr.error))
  }
  $('#search-status').textContent = total ? `共 ${total} 个歌单` : '无结果'
  $('#search-toolbar').hidden = true
}

function renderSongListSingle(platform, data) {
  $('#results').appendChild(renderSongListGroup(platform, data.list, null))
  $('#search-status').textContent = data.list.length ? `共 ${data.list.length} 个歌单` : '无结果'
  $('#search-toolbar').hidden = true
}

function renderSongListGroup(platform, list, error) {
  const group = document.createElement('div')
  group.className = 'platform-group'
  const title = document.createElement('h3')
  title.textContent = PLATFORM_NAME[platform] || platform
  if (error) {
    const e = document.createElement('span')
    e.className = 'err'
    e.textContent = `  加载失败: ${error}`
    title.appendChild(e)
  }
  group.appendChild(title)
  if (!list || !list.length) {
    if (!error) appendEmpty(group)
    return group
  }
  const listEl = document.createElement('div')
  listEl.className = 'result-list'
  for (const sl of list) {
    const row = document.createElement('div')
    row.className = 'result-row sl-row'
    row.innerHTML = `
      <div class="result-cover sl" aria-hidden="true">
        <svg viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"><path d="M4 6h12M4 11h12M4 16h7"/><path d="M17 13.5v6"/><circle cx="15.4" cy="19.5" r="1.6" fill="currentColor" stroke="none"/><path d="M17 13.5l3-1"/></svg>
      </div>
      <div class="result-info">
        <div class="result-name">${escapeHtml(sl.name)}</div>
        <div class="result-artist">${escapeHtml(sl.author || '未知创建者')}</div>
      </div>
      <div class="result-right">
        <span class="badge">${sl.total ?? 0} 首</span>
        ${sl.play_count ? `<span class="badge">▶ ${escapeHtml(String(sl.play_count))}</span>` : ''}
        <button data-open="1" type="button">查看歌曲</button>
      </div>`
    row.querySelector('[data-open]').addEventListener('click', () => openSongListDetail(platform, String(sl.id), sl.name))
    listEl.appendChild(row)
  }
  group.appendChild(listEl)
  return group
}

async function openSongListDetail(platform, id, name) {
  $('#search-status').textContent = `加载歌单「${name}」…`
  try {
    const d = await api.search.songlistDetail({ platform, id })
    // 复用歌曲渲染 + 多选批量能力
    resetResults()
    const back = document.createElement('button')
    back.textContent = '← 返回歌单列表'
    back.className = 'linkbtn'
    back.addEventListener('click', () => $('#search-form').dispatchEvent(new Event('submit')))
    $('#results').appendChild(back)
    $('#results').appendChild(renderGroup(platform, d.list, null))
    finalizeSearch(d.list.length)
    $('#search-status').textContent = `${d.info?.name || name} · 共 ${d.list.length} 首（可勾选批量下载 / 加入歌单）`
  } catch (err) {
    $('#search-status').textContent = `歌单详情加载失败: ${err.message}`
  }
}

// ---------- 单曲搜索渲染 ----------
function renderAggregate(data) {
  const container = $('#results')
  appendSourceWarnings(container, data.results) // P1b：失效警示条
  let totalCount = 0
  for (const pr of data.results) {
    if (pr.ok && pr.list.length) totalCount += pr.list.length
    container.appendChild(renderGroup(pr.platform, pr.list, pr.ok ? null : pr.error))
  }
  finalizeSearch(totalCount)
}

function renderSingle(platform, data) {
  $('#results').appendChild(renderGroup(platform, data.list, null))
  finalizeSearch(data.list.length)
}

function finalizeSearch(count) {
  $('#search-status').textContent = count ? `共 ${count} 首` : '无结果'
  $('#search-toolbar').hidden = count === 0
  $('#check-all').checked = false
}

function appendEmpty(parent) {
  const p = document.createElement('div')
  p.className = 'empty'
  p.textContent = '无结果'
  parent.appendChild(p)
}

function renderGroup(platform, list, error) {
  const group = document.createElement('div')
  group.className = 'platform-group'
  const title = document.createElement('h3')
  title.textContent = PLATFORM_NAME[platform] || platform
  if (error) {
    const e = document.createElement('span')
    e.className = 'err'
    e.textContent = `  加载失败: ${error}`
    title.appendChild(e)
  }
  group.appendChild(title)
  if (!list || !list.length) {
    if (!error) appendEmpty(group)
    return group
  }

  const listEl = document.createElement('div')
  listEl.className = 'result-list'

  for (const raw of list) {
    const item = { ...raw, platform }
    state.results.push(item)
    const key = rowKey(item)
    const qualities = (item.types || []).map((t) => `<span class="badge q">${escapeHtml(t.type)}</span>`).join('')
    const row = document.createElement('div')
    row.className = 'result-row'
    row.innerHTML = `
      <label class="result-chk"><input type="checkbox" data-key="${escapeHtml(key)}" aria-label="选中 ${escapeHtml(item.name)}" /></label>
      <div class="result-cover" aria-hidden="true">
        <svg viewBox="0 0 24 24" width="16" height="16"><path d="M9 18V6l10-2v11.5" stroke="currentColor" stroke-width="1.6" fill="none" stroke-linecap="round" stroke-linejoin="round"/><circle cx="6.5" cy="18" r="2.5" fill="currentColor"/><circle cx="16.5" cy="15.5" r="2.5" fill="currentColor"/></svg>
      </div>
      <div class="result-info">
        <div class="result-name">${escapeHtml(item.name)}</div>
        <div class="result-artist">${escapeHtml(item.singer)}${item.albumName ? ' · ' + escapeHtml(item.albumName) : ''}</div>
      </div>
      <div class="result-right">
        ${item.interval ? `<span class="result-dur">${escapeHtml(String(item.interval))}</span>` : ''}
        ${qualities}
        <button class="row-dl" data-dl="${escapeHtml(key)}" type="button" aria-label="下载 ${escapeHtml(item.name)}" title="下载这首">
          <svg viewBox="0 0 12 12" width="11" height="11" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M6 1.5v7M3 6l3 3 3-3M2 10.5h8"/></svg>
        </button>
      </div>`
    listEl.appendChild(row)
  }
  group.appendChild(listEl)

  group.querySelectorAll('input[type=checkbox]').forEach((cb) => {
    cb.addEventListener('change', () => {
      if (cb.checked) state.selected.add(cb.dataset.key)
      else state.selected.delete(cb.dataset.key)
      updateSelectedCount()
    })
  })
  return group
}

// ---------- 全选 / 计数 ----------
function onCheckAll(e) {
  const checked = e.target.checked
  $$('#results input[type=checkbox]').forEach((cb) => {
    cb.checked = checked
    if (checked) state.selected.add(cb.dataset.key)
    else state.selected.delete(cb.dataset.key)
  })
  updateSelectedCount()
}

function updateSelectedCount() {
  const n = state.selected.size
  $('#selected-count').textContent = `已选 ${n} 首`
  $('#batch-download').disabled = n === 0
  $('#batch-add-playlist').disabled = n === 0
}

function selectedItems() {
  return state.results.filter((it) => state.selected.has(rowKey(it)))
}

function clearSelection() {
  state.selected.clear()
  $$('#results input[type=checkbox]').forEach((cb) => (cb.checked = false))
  $('#check-all').checked = false
  updateSelectedCount()
}

// ---------- 单首下载（行内玻璃小圆钮，复用批量下载接口） ----------
async function onRowDownload(e) {
  const btn = e.target.closest('button[data-dl]')
  if (!btn || btn.disabled) return
  const item = state.results.find((it) => rowKey(it) === btn.dataset.dl)
  if (!item) return
  btn.disabled = true
  try {
    const r = await api.download.batch({ items: [{ platform: item.platform, musicInfo: item }], quality: state.quality })
    if (r.acceptedCount) {
      btn.classList.add('done')
      btn.title = '已入队'
      toast(`已提交下载：${item.name}`)
    } else {
      toast('该曲目下载被拒绝')
      btn.disabled = false
    }
  } catch (err) {
    toast(`下载失败: ${err.message}`)
    btn.disabled = false
  }
}

// ---------- 批量下载 ----------
async function onBatchDownload() {
  const items = selectedItems().map((it) => ({ platform: it.platform, musicInfo: it }))
  if (!items.length) return
  const btn = $('#batch-download')
  btn.disabled = true
  try {
    const r = await api.download.batch({ items, quality: state.quality })
    toast(`已提交 ${r.acceptedCount} 首${r.rejectedCount ? `，${r.rejectedCount} 首被拒` : ''}`)
    clearSelection()
  } catch (err) {
    toast(`批量下载失败: ${err.message}`)
  } finally {
    btn.disabled = state.selected.size === 0
  }
}

// ---------- 一键加入歌单（弹窗选择/新建） ----------
async function onBatchAddPlaylist() {
  const items = selectedItems()
  if (!items.length) return
  let pls = []
  try {
    pls = (await api.playlists.list()).playlists || []
  } catch (err) {
    return toast(err.message)
  }
  const pick = await pickPlaylistModal(pls, { title: `加入歌单（已选 ${items.length} 首）` })
  if (!pick) return
  let targetId
  try {
    targetId = pick.id ?? (await api.playlists.create({ name: pick.newName })).id
  } catch (err) {
    return toast(err.message)
  }
  let added = 0
  for (const it of items) {
    try {
      const r = await api.playlists.addItem(targetId, { platform: it.platform, musicInfo: it })
      if (r.added) added++
    } catch {
      /* 忽略单首失败 */
    }
  }
  toast(`已加入 ${added} 首（${items.length - added} 首已存在）`)
}
