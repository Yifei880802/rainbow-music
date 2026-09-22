/**
 * 搜索页：单曲 / 歌单搜索（单平台 + 聚合）
 * 交互：多选勾选、全选、批量下载、一键加入歌单、歌单详情展开
 * #57 实时联想 → P0 D2-fe 接线升级：输入防抖 300ms 调专用 GET /search/suggest
 * （history+hot+title 三源，后端已按 (text,singer) 复合 key 去重、平台不再局限
 * wy/tx），与搜索历史、热搜共用同一浮层容器（无输入 = 热搜组 + 历史组；
 * 有输入 = 联想组在上 + 历史组在下，组标题区分）；请求序号竞态保护；
 * 联想项点击回填关键词直接发起完整搜索；Enter 仍走原生完整搜索。
 * P0 D1-fe 历史同步：搜索成功后 POST /me/search-history；页面加载 GET 与本地
 * localStorage（uid 前缀）merge 去重；清空同步 DELETE。
 * P0 D3-fe 热搜：浮层新增「热门搜索」组，数据来自 GET /search/trending（会话级缓存）。
 * P0 E1 分页：onSearch 解除 page:1 硬编码，单曲结果区「加载更多」追加下一页；
 * P0 E2 真实封面：行渲染 item.img + onerror 移除露出渐变占位（home.js 范式）；
 * P0 E3 批量歌单：新建歌单走 /playlists/import 一次往返（既有歌单无批量端点，仍逐首）。
 * P1 I3 三态：结果行下载钮接入 sse.js + download-state.js 公共三态模块
 * （pending → active 进度环 → completed/failed）：入队用 api.download.batch 返回的
 * accepted[].id 乐观驱动本行，后续 SSE task:* 事件接管；已下载行点击直接播。
 * 环常量 / 三态 HTML / owned 合并 / 批量去重 / 事件清单全部复用公共模块，本页不重造。
 * P1 J4 合并视图：renderMerged() 消费 GET /search/merged（跨平台去重 MergedTrack），
 * 默认折叠展示 name/singer/qualities 并集/score，可展开看全部 sources[]（平台+songmid+音质）；
 * 与既有「按平台分组」视图经 #search-view-seg 切换，切换不丢搜索状态（关键词/页码/勾选）；
 * 不可达音质档位配合 GET /sources/capabilities 灰显（端点不可用静默降级为不灰显）。
 * P1 K1 筛选：#search-filters chips（来源/音质/歌手/专辑，library.js #lib-filters 范式）+ applyFilters()。
 * P1 K2 排序：#search-sort（相关度默认/时长/音质/平台），渲染前 sort。
 */
import { $, $$, escapeHtml, toast, PLATFORM_NAME, QUALITIES, QUALITY_LABEL, pickPlaylistModal } from '../ui.js'
import { api, getDownloadQuality } from '../api.js'
import { store } from '../storage.js'
import * as sse from '../sse.js'
import * as player from '../player.js'
// P1 I3：三态一律复用公共模块（SMALL_RING_LEN 等环常量由 stateButtonHtml/updateRingProgress 内部持有，本页不重造）
import {
  mergeOwned,
  buildOwnedMap,
  stateButtonHtml,
  updateRingProgress,
  subscribeTaskEvents,
  dedupeItems,
  isDone as isDoneT,
} from '../download-state.js'
// P2 O2：收藏到「我喜欢」——ref 口径 = songKey(platform,songmid)（与 owned 同 key），
// 心形 HTML / 乐观 toggle / 失败回滚 / 变更广播全在公共模块，本页不重造
import { heartHtml, handleFavClick, loadFavorites, syncHearts } from '../favorites.js'

const state = {
  results: [], // 扁平化的歌曲列表（含 platform）
  selected: new Set(), // 选中项 key（platform:songmid）
  quality: 'flac',
  // ---- P0 E1 分页（仅单曲搜索；歌单搜索维持单页现状） ----
  page: 1, // 已加载到的页码（加载更多递增）
  totalCount: 0, // 已加载结果累计（状态栏文案）
  moreLoading: false, // 加载更多在途（防重复点击）
  last: null, // 最近一次搜索上下文 { keyword, platform, searchType }（加载更多复用）
  // ---- P1 I3 三态（owned：key=platform:songmid → 代表任务视图，与 home/playlists 同语义） ----
  owned: new Map(),
  ownedLoaded: false,
  // ---- P1 J4 视图（'group' 按平台分组=默认 / 'merged' 按歌曲聚合） ----
  view: 'group',
  mode: 'song', // 'song' | 'songlist'：视图切换/筛选/排序仅对单曲搜索生效
  groupData: null, // { keyword, results:[{platform,ok,list,error}], page, hasMore } 累积快照
  mergedData: null, // { keyword, list:MergedTrack[], total, page, hasMore } 累积快照
  expanded: new Set(), // 合并视图已展开行的 key（重渲染后保持展开态）
  // ---- P1 K1/K2 筛选与排序（纯前端，作用于当前视图累积结果） ----
  filters: { source: null, quality: null, singer: null, album: null },
  sort: 'relevance',
  // ---- P2 O4 错字容错建议（后端不自动替换原词：correct=当前结果对应的原词，to=建议改搜词） ----
  correct: null, // { from:correctedFrom, to:corrected } | null
  suppressCorrect: false, // 用户点了「搜索建议词」后置真，避免改搜后再弹同样建议形成循环
  // ---- P2 O5 相关推荐 chips ----
  related: [], // [{ kw, score }]
}

const rowKey = (item) => `${item.platform}:${item.songmid}`

/** P0 E2：封面 onerror——移除 img 露出下层 .result-cover 橙渐变占位（音符 SVG 常驻，home.js 同范式） */
const COVER_ERR = 'this.remove()'

/** 平台固定序（K1 来源 chips 排序 + K2 平台排序） */
const PLAT_ORDER = ['kw', 'kg', 'tx', 'wy', 'mg']
const platRank = (p) => {
  const i = PLAT_ORDER.indexOf(p)
  return i === -1 ? 99 : i
}

/** 上游 types[].type 别名 → 契约 Quality 归一（合并视图 qualities 已是契约值，直通） */
const Q_ALIAS = {
  flac24bit: 'flac24bit',
  flac: 'flac',
  '320k': '320k',
  '128k': '128k',
  sq: 'flac',
  hq: '320k',
  lq: '128k',
  ape: 'flac',
  mp3: '128k',
}

/** 归一音质集（按 ui.js QUALITIES 降序：flac24bit > flac > 320k > 128k） */
function normQualities(list) {
  const set = new Set()
  for (const q of list || []) {
    const k = Q_ALIAS[String(q ?? '').toLowerCase()]
    if (k) set.add(k)
  }
  return [...set].sort((a, b) => QUALITIES.indexOf(a) - QUALITIES.indexOf(b))
}

/** 最高音质档位得分（越大越好） */
function topQRank(quals) {
  if (!quals || !quals.length) return -1
  return QUALITIES.length - Math.min(...quals.map((q) => QUALITIES.indexOf(q)))
}

/** 时长归一为秒（兼容 "4:29" / 269 / "269" / 0 / 空） */
function durSec(interval) {
  if (interval == null || interval === 0 || interval === '') return 0
  const s = String(interval).trim()
  if (s.includes(':')) {
    const [m, sec] = s.split(':')
    return (Number(m) || 0) * 60 + (Number(sec) || 0)
  }
  const n = Number(s)
  if (!Number.isFinite(n) || n <= 0) return 0
  return n > 1000 ? Math.round(n / 1000) : Math.round(n) // 上游偶有毫秒
}

/** K1 歌手/专辑 chips 最多展示条数（长尾不进 chips，避免撑爆工具条） */
const FACET_TOP_N = 8


/* ============================================================
   * P0-3 · 搜索历史（storage.js 键 `searchHistory`，按 uid 前缀隔离，
   * 最近 10 条去重置顶；v0.2.0 旧无前缀键存量读取自动回落生效）
   * P0 D1-fe · 跨设备同步：搜索成功后 fire-and-forget POST /me/search-history；
   * 页面加载 GET 远端历史与本地按 kw merge（ts 新者胜）写回本地；
   * 「清空」同步 DELETE 远端；网络失败一律静默降级为纯本地历史。
   #57 · 实时联想 → P0 D2-fe/D3-fe：输入防抖 300ms 调 GET /search/suggest
   （后端 history+hot+title 三源、(text,singer) 复合 key 去重，前端直接渲染），
   与热搜、历史共用同一浮层容器：
   - 无输入：热搜组（GET /search/trending，会话级缓存）+ 历史组
     （focus 弹出，↑↓ / Enter / Esc / × 单删 / 清空）
   - 有输入：联想组在上（loading → 结果 / 「无联想，回车搜索」）+
     历史组在下（按输入前缀包含过滤）；防抖等待期不显示联想组避免闪烁；
     suggest 失败静默降级到本地历史（title 池冷启动首拉 ≤8s，期间 loading 占位）
   - 竞态保护：suggestSeq 序号，响应回来时已过期则丢弃
   ============================================================ */
const HISTORY_KEY = 'searchHistory' // storage.js 自动加 rainbow.<uid>. 前缀
const HISTORY_MAX = 10
const SUGGEST_MAX = 10 // 联想条数上限（= 后端 limit 默认值）
const SUGGEST_DEBOUNCE = 300 // 输入防抖 ms（后端 title 池冷启动首拉需抓 3 榜 ≤8s，保留防抖控压）
const TRENDING_MAX = 10 // D3 热搜组条数
const DEFAULT_LIMIT = 30 // D4 后端各 adapter 统一默认 limit（hasMore 判定基准）
const RELATED_MAX = 10 // P2 O5 相关推荐 chips 条数上限

let historyPop = null // 建议面板（首次展示时懒创建，挂 #search-form 内）
let popIdx = -1 // 键盘导航下标（统一覆盖联想项+热搜项+历史项；-1 = 未选择，Enter 走原生提交）
let historyBlurTimer = 0
let suggestTimer = 0 // 联想防抖定时器
let suggestSeq = 0 // 联想请求序号（竞态丢弃依据）
let suggestItems = [] // [{name, singer, type}] 后端已去重的联想项（直接渲染）
let suggestKeyword = '' // 当前联想结果对应的输入（空 = 尚无已完成的联想）
let suggestLoading = false
let trendingItems = [] // D3 [{text, count}] 热搜（会话级缓存，init 拉一次）
let trendingLoaded = false

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

/** 搜索成功渲染后写入：同词去重置顶并刷新时间戳与上下文；P0 D1-fe 同步上报服务端（fire-and-forget） */
function recordSearch(kw, type, platform) {
  writeHistory([{ kw, type, platform, ts: Date.now() }, ...readHistory().filter((it) => it.kw !== kw)])
  api.me.postSearchHistory({ kw, type, platform }).catch(() => {
    /* 远端上报失败静默：本地历史已生效，不打断搜索体验 */
  })
  hidePop()
}

/**
 * P0 D1-fe：拉取远端搜索历史并与本地 localStorage merge 去重（同 kw 取 ts 新者），
 * 写回本地（封顶 HISTORY_MAX 条）。失败静默：纯本地历史照常可用。
 * 远端 items：{ id, kw, type, platform, ts }（ts 服务端毫秒时间戳）。
 */
async function syncRemoteHistory() {
  try {
    const data = await api.me.getSearchHistory(50)
    const remote = (data.items || []).filter((it) => it && typeof it.kw === 'string' && it.kw.trim())
    if (!remote.length) return
    const byKw = new Map()
    for (const it of [...readHistory(), ...remote]) {
      const prev = byKw.get(it.kw)
      if (!prev || Number(it.ts || 0) > Number(prev.ts || 0)) byKw.set(it.kw, it)
    }
    const merged = [...byKw.values()].sort((a, b) => Number(b.ts || 0) - Number(a.ts || 0)).slice(0, HISTORY_MAX)
    writeHistory(merged)
  } catch {
    /* 未登录/网络失败：保持本地历史 */
  }
}

/** P0 D3-fe：热搜拉取（init 一次，会话级缓存；实时 DB 无缓存可直接拉；失败静默无热搜组） */
async function loadTrending() {
  if (trendingLoaded) return
  try {
    const data = await api.search.trending(TRENDING_MAX)
    trendingItems = (data.items || []).filter((it) => it && typeof it.text === 'string' && it.text.trim()).slice(0, TRENDING_MAX)
    trendingLoaded = true
  } catch {
    trendingItems = []
  }
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

/** 当前可导航的热搜项数（仅无输入时热搜组可见可导航） */
function trendingNavCount() {
  return $('#keyword').value.trim() ? 0 : trendingItems.length
}

/** 统一键盘导航项：联想项在前、热搜项居中（仅空输入）、历史项在后（返回 [{kw}] 供回填提交） */
function navItems() {
  const sg = suggestNavCount() ? suggestItems.map((it) => ({ kw: it.name })) : []
  const tr = trendingNavCount() ? trendingItems.map((it) => ({ kw: it.text })) : []
  return [...sg, ...tr, ...historyItems().map((it) => ({ kw: it.kw }))]
}

/** P0 D2-fe 联想请求（防抖后触发）：改调专用 GET /search/suggest，序号竞态保护；
 *  后端已按 (text,singer) 复合 key 去重，前端直接渲染 items（同名不同歌手各自保留）；
 *  失败静默降级：suggestKeyword 不置位 → 不显示「无联想」组，仅历史组可用，不打断输入体验 */
async function fetchSuggest(kw) {
  const seq = ++suggestSeq
  suggestLoading = true
  if (historyPop && !historyPop.hidden) renderPop()
  try {
    const data = await api.search.suggest(kw, SUGGEST_MAX)
    if (seq !== suggestSeq) return // 输入已变化 / 面板已关闭 → 丢弃过期响应
    suggestItems = (data.items || [])
      .filter((it) => it && typeof it.text === 'string' && it.text.trim())
      .slice(0, SUGGEST_MAX)
      .map((it) => ({ name: it.text.trim(), singer: (it.singer || '').trim(), type: it.type }))
    suggestKeyword = kw
  } catch {
    if (seq !== suggestSeq) return
    suggestItems = [] // 网络失败静默降级：仅历史组可用，不打断输入体验
  } finally {
    if (seq === suggestSeq) {
      suggestLoading = false
      if (historyPop && !historyPop.hidden) renderPop()
    }
  }
}

/** 混合建议面板渲染：联想组（上，仅输入非空且非防抖等待）+ 热搜组（D3，仅空输入）+ 历史组（下） */
function renderPop() {
  const pop = ensureHistoryPop()
  const kw = $('#keyword').value.trim()
  const hasKw = !!kw
  const items = historyItems()
  const sgCount = suggestNavCount()
  const trCount = trendingNavCount()
  if (popIdx >= sgCount + trCount + items.length) popIdx = -1

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
      </button>`,
        )
        .join('')}</div>`
    } else {
      sgHtml = `<div class="pop-group">${head}<div class="sh-empty">无联想，回车搜索</div></div>`
    }
  }

  // ---- 热搜组（P0 D3-fe：仅空输入时展示；复用 .sg-item 样式 + data-sg 点击/导航链路，计数在右侧 badge） ----
  let trHtml = ''
  if (!hasKw && trCount) {
    trHtml = `<div class="pop-group"><div class="sh-head"><span>热门搜索</span><span class="sh-meta">近 7 天</span></div>${trendingItems
      .map(
        (it, i) => `
      <button class="sg-item${sgCount + i === popIdx ? ' active' : ''}" type="button" data-sg="${escapeHtml(it.text)}" title="搜索 ${escapeHtml(it.text)}">
        <svg class="sh-ico" viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 3s5 4.2 5 9a5 5 0 0 1-10 0c0-1.6.6-3 1.4-4.2C9.4 9.6 10 11 11 11c0-3 1-6.5 1-8z"/></svg>
        <span class="sg-name">${escapeHtml(it.text)}</span>
        <span class="sg-count">${escapeHtml(String(it.count ?? ''))}</span>
      </button>`,
      )
      .join('')}</div>`
  }

  // ---- 历史组（有输入但无匹配时省略：联想区已有「无联想」兜底） ----
  let hHtml = ''
  if (items.length) {
    hHtml = `<div class="pop-group"><div class="sh-head"><span>搜索历史</span><button class="sh-clear" type="button">清空</button></div>${items
      .map(
        (it, i) => `
      <button class="sh-item${sgCount + trCount + i === popIdx ? ' active' : ''}" type="button" data-kw="${escapeHtml(it.kw)}" title="搜索 ${escapeHtml(it.kw)}">
        <svg class="sh-ico" viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" aria-hidden="true"><circle cx="12" cy="12" r="8.5"/><path d="M12 7.5V12l3 2"/></svg>
        <span class="sh-kw">${escapeHtml(it.kw)}</span>
        <span class="sh-x" role="button" aria-label="删除这条历史" title="删除">×</span>
      </button>`,
      )
      .join('')}</div>`
  } else if (!hasKw) {
    hHtml = '<div class="sh-empty">无匹配历史</div>'
  }
  pop.innerHTML = sgHtml + trHtml + hHtml
  return sgCount + trCount + items.length
}

function showPop() {
  const kw = $('#keyword').value.trim()
  if (!kw && !readHistory().length && !trendingItems.length) return
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

/** 面板点击委托：清空（含远端）/ 单条删除 / 联想项、热搜项或历史项回填并立即搜索 */
function onPopClick(e) {
  if (e.target.closest('.sh-clear')) {
    writeHistory([])
    // P0 D1-fe：清空同步远端（fire-and-forget，失败静默：下次加载 merge 可能回灌远端残存，可再次清空）
    api.me.clearSearchHistory().catch(() => {})
    hidePop()
    toast('已清空搜索历史')
    return
  }
  const sg = e.target.closest('.sg-item')
  if (sg) {
    // #57 联想项 / D3 热搜项：关键词回填 + 直接发起完整搜索
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
  // 行内单首下载 + 已下载直接播（P1 I3）+ 展开来源（P1 J4）+ P0 E1「加载更多」（同一委托）
  $('#results').addEventListener('click', onResultsClick)
  // P1 J4：视图切换（本地重渲染/缓存复用，不丢搜索状态）
  $('#search-view-seg')?.addEventListener('click', onViewSegClick)
  // P1 K2：排序（渲染前 sort）
  $('#search-sort')?.addEventListener('change', onSortChange)
  // P1 K1：筛选 chips（组内单选，点击委托）
  $('#search-filters')?.addEventListener('click', onFilterClick)
  // P0-3：搜索历史（focus 下拉 + 键盘导航 + 写入）
  initSearchHistory()
  // P0 D1-fe：远端历史与本地 merge（失败静默）；D3-fe：热搜预拉（会话级缓存，失败静默）
  syncRemoteHistory()
  loadTrending()
  // P1 I3：SSE 三态订阅（sse.js 全局单连接，多页订阅互不影响；与 home/playlists 同范式）
  subscribeTaskEvents(sse, onTaskEvent)
  sse.on('task:progress', onTaskProgress)
  sse.on('connected', onSseConnected)
  // P1 J4：C4 音质能力预拉（按平台缓存；旧 dist 无该端点 → 静默降级为不灰显）
  void loadCapabilities()
  // P2 O2：收藏快照预拉（心形实心/空心）+ 全局变更广播（搜索行与播放器心形互相同步）
  void loadFavorites()
  document.addEventListener('favorites:changed', onFavoritesChanged)
  // P2 O4：错字容错建议条「搜索建议词」点击（复用 runSearch，不新增请求路径）
  $('#search-correct')?.addEventListener('click', onCorrectClick)
  // P2 O5：相关推荐 chips 点击 = 以该词发起搜索
  $('#search-related')?.addEventListener('click', onRelatedClick)
  // P2 O1：主播放器起播/切歌时停止试听（两条音频不叠加）
  document.addEventListener('player:trackchange', stopPreview)
}

/** 每次进入搜索页：拉全量任务快照对账 owned，再局部刷新行状态（不重建列表、不打断入场动画） */
export function show() {
  void ensureOwned(true).then(() => refreshAllRowStates())
  // P2 O2：每次进页对账收藏快照（其他页/其他设备新增的收藏在此补齐；到位后自动广播刷新心形）
  void loadFavorites(true)
}

/* ============================================================
   P1 I3 · 搜索行三态（全部复用 download-state.js，本页不重造环常量/三态逻辑）
   owned Map（key=platform:songmid → 代表任务视图）+ stateButtonHtml 生成行内控件：
   - 未下载 → .row-dl[data-dl]（data-dl 值沿用 platform:songmid 行 key，onRowDownload/多选零改造）
   - 下载中 → .row-dl.hp-dl-ing[data-task] + 28px 进度环（SSE task:progress 局部推 stroke-dashoffset）
   - 已下载 → .row-dl.done[data-play] 绿勾（hover 播放三角），点击 player.playQueue 直接播
   - failed/canceled → 回到可下载态且 title 提示重试（失败反馈不再丢失）
   ============================================================ */

/** 行内三态控件 HTML（公共模块生成；data-dl 值 = 行 key） */
function rowStateHtml(item) {
  return stateButtonHtml({
    task: state.owned.get(rowKey(item)),
    name: item.name || '',
    dlAttr: 'data-dl',
    dlValue: rowKey(item),
  })
}

/** 拉全量终态任务快照重建 owned（#196-fix2: 改用 /tasks/owned 轻量端点，无分页截断）；失败保持现状（SSE 增量仍可补齐） */
async function ensureOwned(force = false) {
  if (state.ownedLoaded && !force) return
  try {
    const r = await api.tasks.owned()
    const map = new Map()
    for (const o of r.owned || []) {
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
    state.owned = map
    state.ownedLoaded = true
  } catch {
    /* 拿不到任务列表：不覆盖现有 owned，避免一次网络抖动把已知状态洗白 */
  }
}

/** 带状态位的行元素（分组视图 .result-row + 合并视图展开区 .mg-src） */
function stateEls() {
  return $$('#results .result-row[data-key], #results .mg-src[data-key]')
}

/** 局部刷新单个行/来源条的状态位（不重建列表） */
function applyRowState(el) {
  const box = el.querySelector('.hp-row-state')
  if (!box) return
  const item = state.results.find((it) => rowKey(it) === el.dataset.key)
  if (!item) return
  box.innerHTML = rowStateHtml(item)
}

/** SSE 重连 / 进页对账后：全行状态局部刷新 */
function refreshAllRowStates() {
  stateEls().forEach(applyRowState)
}

/** 按行 key 刷新（乐观入队后、task 事件到达后；合并视图下多行同曲也全部命中） */
function refreshRowByKey(key) {
  stateEls().forEach((el) => {
    if (el.dataset.key === key) applyRowState(el)
  })
}

/** SSE task:* 事件（负载 = 完整任务视图）→ mergeOwned 取优 + 局部刷新对应行 */
function onTaskEvent(view) {
  if (!view || !view.id) return
  mergeOwned(state.owned, view)
  refreshRowByKey(`${view.platform}:${view.songmid}`)
}

/** SSE task:progress → 只改 stroke-dashoffset（免整行重渲染，与 home.js 同策略） */
function onTaskProgress(p) {
  if (!p || !p.id) return
  for (const t of state.owned.values()) {
    if (t.id === p.id) {
      t.progress = p.percent
      break
    }
  }
  const btn = $(`#results .hp-row-state [data-task="${CSS.escape(String(p.id))}"]`)
  updateRingProgress(btn, p.percent || 0)
}

/** SSE （重）连：服务端首包 connected 后全量对账（断线期间事件丢失的兑底） */
function onSseConnected() {
  void ensureOwned(true).then(() => refreshAllRowStates())
}

/** P1 I3：已下载行点击 = 直接播（player.playQueue 消费 completed 任务，与 home/playlists 同语义）
 *  #199：owned 视图来自 /tasks/owned 轻量端点（#196-fix2），只有 key/status/quality/hasFile，
 *  没有曲名/歌手 —— 直接入队会让播放器标题退到 filePath 回退解析（显示占位值），
 *  因此入队前用 state.results 同 key 的搜索元数据补齐（同时修正 O2 收藏 toast 的曲名）。 */
function onRowPlay(e) {
  const btn = e.target.closest('button[data-play]')
  if (!btn) return false
  stopPreview() // P2 O1：走主播放器前先停试听，两条音频不叠加
  const id = btn.dataset.play
  const queue = [...state.owned.values()].filter(isDoneT).map((t) => {
    if (t.name) return t
    const it = state.results.find((x) => rowKey(x) === `${t.platform}:${t.songmid}`)
    return it ? { ...t, name: it.name, singer: it.singer, albumName: it.albumName, img: it.img } : t
  })
  if (!queue.length) {
    toast('还没有已下载完成的歌曲')
    return true
  }
  player.playQueue(queue, id)
  return true
}

/* ============================================================
   P2 O2 · 收藏到「我喜欢」（复用既有 me/favorites 后端，不依赖新端点）
   契约（server/src/routes/me.ts 只读确认）：
     GET    /me/favorites            → { favorites:[{ kind, ref, createdAt }] }
     POST   /me/favorites {kind,ref} → { ok, added }    kind ∈ track|playlist|square
     DELETE /me/favorites/:kind/:ref → { ok, deleted }
   收藏态持久显示：init 预拉 + show() 每次进页对账 → favorites.js 内部 Set；
   心形与三态下载钮是两个独立控件，在 .result-right 内并排（互不覆盖 data 属性）。
   ============================================================ */

/** 行内收藏心形（分组视图行 / 合并视图主行 / 展开区各 source 共用同一生成器） */
function favHtml(item) {
  return heartHtml({ platform: item?.platform, songmid: item?.songmid, name: item?.name || '' })
}

/** 由心形按钮反查曲目名（toast 文案用；data-fav 与 rowKey 同一把 key） */
function favNameOf(btn) {
  const it = state.results.find((x) => rowKey(x) === btn.dataset.fav)
  return it?.name || ''
}

/** 收藏集合变更（快照到位 / 本页或播放器 toggle / 落库失败回滚）→ 全量心形局部同步，不重建列表 */
function onFavoritesChanged(e) {
  // 仅用户 toggle（reason='toggle'）播 pop 反馈；快照到位/回滚静默刷新，避免满屏心形齐跳
  syncHearts(document, e?.detail?.reason === 'toggle')
}

/* ============================================================
   P2 O1 · 结果内试听（音源直链流式代理，独立 <audio> 不打断主播放器队列）
   - api.preview.check 预检 302/错误码（redirect:'manual' 不下载音频体），成功后 audio.src = 直链 URL 播放；
   - 独立 previewAudio（非 player.js 主 audio），不碰既有播放队列/状态机；
   - data-preview 独立属性，与三态下载钮(data-dl/data-play)/收藏心形(data-fav)/歌手链接(data-search-kw)
     在 .result-right 内并排，onResultsClick 委派链中优先拦截 + stopPropagation 隔离；
   - 失败 toast 友好提示，按钮态即时复位，不留悬挂 loading。
   ============================================================ */
const PREVIEW_ICON =
  '<svg class="ic-preview" viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 14v-2a8 8 0 0 1 16 0v2"/><rect x="2.6" y="13.5" width="4.2" height="6.4" rx="1.6"/><rect x="17.2" y="13.5" width="4.2" height="6.4" rx="1.6"/></svg>'
const PREVIEW_STOP_ICON =
  '<svg class="ic-preview" viewBox="0 0 24 24" width="15" height="15" fill="currentColor" aria-hidden="true"><rect x="7" y="5" width="3.6" height="14" rx="1.1"/><rect x="13.4" y="5" width="3.6" height="14" rx="1.1"/></svg>'

let previewAudio = null
let previewState = { key: null, btn: null } // 当前试听/加载中的行 key 与按钮元素

function ensurePreviewAudio() {
  if (previewAudio) return previewAudio
  previewAudio = new Audio()
  previewAudio.preload = 'none'
  previewAudio.addEventListener('ended', resetPreviewBtn)
  previewAudio.addEventListener('error', () => {
    // 播放中途出错（直链失效/跨源被拒）：仅当仍有活跃试听时提示（手动 stop 已先置 key=null，不重复报）
    if (previewState.key) {
      toast('试听中断：音源直链不可用')
      resetPreviewBtn()
    }
  })
  return previewAudio
}

/** 复位当前试听按钮为空闲态 + 清活跃记录 */
function resetPreviewBtn() {
  const btn = previewState.btn
  previewState = { key: null, btn: null }
  if (btn) {
    btn.classList.remove('loading', 'playing')
    btn.disabled = false
    btn.setAttribute('aria-pressed', 'false')
    btn.title = '试听'
    btn.innerHTML = PREVIEW_ICON
  }
}

/** 停止试听（再点同一行/切行/主播放器起播时调用） */
function stopPreview() {
  if (previewAudio) {
    try {
      previewAudio.pause()
    } catch {
      /* ignore */
    }
  }
  resetPreviewBtn() // 先清 key：后续 removeAttribute+load 触发的 error 不会误报
  if (previewAudio) {
    previewAudio.removeAttribute('src')
    try {
      previewAudio.load()
    } catch {
      /* ignore */
    }
  }
}

/** 行内试听按钮（分组视图行 / 合并视图主行 / 展开区各 source 共用）；无 platform/songmid 或 NAS 扫描曲不渲染 */
function previewHtml(item) {
  const can = item && item.platform && item.platform !== 'nas' && item.songmid != null && String(item.songmid) !== ''
  if (!can) return ''
  const key = `${item.platform}:${item.songmid}`
  return `<button class="row-preview" data-preview="${escapeHtml(key)}" type="button" aria-pressed="false" aria-label="试听 ${escapeHtml(item.name || '')}" title="试听">${PREVIEW_ICON}</button>`
}

/** 同步拦截：命中试听钮 → 异步走 doPreview，返回 true 阻断后续委派 */
function onPreviewClick(e) {
  const btn = e.target.closest('button[data-preview]')
  if (!btn) return false
  e.preventDefault()
  e.stopPropagation()
  void doPreview(btn)
  return true
}

async function doPreview(btn) {
  const key = btn.dataset.preview
  // 再点当前正在试听/加载的按钮 → 停止
  if (previewState.key === key) {
    stopPreview()
    return
  }
  // 切到别的行：先停当前
  if (previewState.key) stopPreview()
  const [platform, ...rest] = key.split(':')
  const songmid = rest.join(':')
  const it = state.results.find((x) => rowKey(x) === key)
  btn.classList.add('loading')
  btn.disabled = true
  btn.title = '加载中…'
  previewState = { key, btn }
  try {
    const url = await api.preview.check({
      platform,
      songmid,
      quality: getDownloadQuality(),
      name: it?.name || '',
      singer: it?.singer || '',
    })
    if (previewState.btn !== btn) return true // 竞态：等待期间已切行/停止
    const a = ensurePreviewAudio()
    a.src = url
    btn.classList.remove('loading')
    btn.classList.add('playing')
    btn.disabled = false
    btn.setAttribute('aria-pressed', 'true')
    btn.title = '停止试听'
    btn.innerHTML = PREVIEW_STOP_ICON
    await a.play()
  } catch (err) {
    if (previewState.btn === btn) resetPreviewBtn()
    toast(err?.message || '试听失败')
  }
  return true
}

/* ============================================================
   P2 O4 · 错字容错建议 UI
   后端（search/index.ts + correct.ts）**不自动替换原词**：当前结果 = 用户原词(correctedFrom)，
   corrected 为词典建议的高频词。故建议条语义 = 「已搜原词、结果较少，要不要改搜建议词？」，
   点击以 corrected 为词重搜（复用 runSearch）；suppressCorrect 防改搜后再弹同样建议成循环。
   ============================================================ */
function captureCorrect(data, page) {
  if (page !== 1) return
  if (!state.suppressCorrect && data && typeof data.corrected === 'string' && data.corrected.trim()) {
    state.correct = {
      to: data.corrected.trim(),
      from: String(data.correctedFrom || $('#keyword').value || '').trim(),
    }
  } else {
    state.correct = null
  }
  renderCorrect()
}

function renderCorrect() {
  const box = $('#search-correct')
  if (!box) return
  const c = state.correct
  if (!c || state.suppressCorrect || !c.to) {
    box.hidden = true
    box.innerHTML = ''
    return
  }
  box.hidden = false
  box.innerHTML = `
    <svg class="sc-ico" viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="11" cy="11" r="7"/><path d="M20 20l-3.5-3.5"/><path d="M11 8.5v3l2 1.4"/></svg>
    <span class="sc-text">已搜索「<b>${escapeHtml(c.from || c.to)}</b>」，结果较少。要不要搜索「<b>${escapeHtml(c.to)}</b>」？</span>
    <button type="button" class="sc-btn" data-correct-kw="${escapeHtml(c.to)}">搜索「${escapeHtml(c.to)}」</button>`
}

function onCorrectClick(e) {
  const btn = e.target.closest('button[data-correct-kw]')
  if (!btn) return
  const kw = (btn.dataset.correctKw || '').trim()
  if (!kw) return
  state.suppressCorrect = true // 改搜建议词后不再弹同样建议（避免循环）
  $('#keyword').value = kw
  hidePop()
  $('#search-status').textContent = '搜索中…'
  void runSearch(1)
}

/* ============================================================
   P2 O5 · 相关推荐 chips
   歌曲搜索完成后拉 GET /search/related（基于历史共现，冷启动回退 trending），
   渲染为可点击 chips；点击即以该词发起搜索（复用 runSearch）。
   端点失败/空数组静默降级（不展示、不阻断搜索）；序号竞态防过期渲染。
   ============================================================ */
let relatedSeq = 0
async function loadRelated(kw) {
  const box = $('#search-related')
  if (!box) return
  if (state.mode !== 'song' || !kw) {
    state.related = []
    renderRelated()
    return
  }
  const seq = ++relatedSeq
  try {
    const data = await api.search.related(kw, RELATED_MAX)
    if (seq !== relatedSeq) return // 已发起新搜索，丢弃过期响应
    const list = (data?.related || [])
      .filter((r) => r && typeof r.kw === 'string' && r.kw.trim() && r.kw.trim() !== kw)
      .slice(0, RELATED_MAX)
    state.related = list
  } catch {
    if (seq !== relatedSeq) return
    state.related = []
  }
  renderRelated()
}

function renderRelated() {
  const box = $('#search-related')
  if (!box) return
  if (state.mode !== 'song' || !state.related.length) {
    box.hidden = true
    box.innerHTML = ''
    return
  }
  box.hidden = false
  box.innerHTML =
    '<span class="rel-label">相关搜索</span>' +
    state.related
      .map(
        (r) =>
          `<button type="button" class="rel-chip" data-rel-kw="${escapeHtml(r.kw.trim())}" title="搜索 ${escapeHtml(r.kw.trim())}">${escapeHtml(r.kw.trim())}</button>`,
      )
      .join('')
}

function onRelatedClick(e) {
  const btn = e.target.closest('button[data-rel-kw]')
  if (!btn) return
  const kw = (btn.dataset.relKw || '').trim()
  if (!kw) return
  state.suppressCorrect = false
  $('#keyword').value = kw
  hidePop()
  $('#search-status').textContent = '搜索中…'
  void runSearch(1)
}

/* ============================================================
   P2 O3 · 歌手 / 专辑名可点击二次搜索
   .result-artist 内文本渲染为 <a class="rs-link" data-search-kw>（链接样式 + hover 下划线），
   点击 = 回填关键词 + 强制歌曲视图（state.mode='song'）+ 复用 runSearch(1) 入口，
   不新增任何请求路径；stopPropagation 隔离行内播放/下载/收藏/展开/勾选点击。
   ============================================================ */

/** 歌手串常见分隔（「周杰伦/费玉清」→ 两个各自可搜的关键词）；上限 4 段防碎片化 */
const SINGER_SPLIT = /\s*(?:[/、&|]|,|，)\s*/

/** 把一段文本渲染成 1..N 个可点击搜索链接（专辑名不拆分，整串作为一个关键词） */
function kwLinks(text, kind) {
  const raw = String(text || '').trim()
  if (!raw) return ''
  const parts = (kind === 'singer' ? raw.split(SINGER_SPLIT) : [raw])
    .map((s) => s.trim())
    .filter(Boolean)
    .slice(0, 4)
  if (!parts.length) return ''
  const label = kind === 'singer' ? '歌手' : '专辑'
  return parts
    .map(
      (p) =>
        `<a class="rs-link" href="#" role="button" data-search-kw="${escapeHtml(p)}" data-rs="${kind}" title="搜索${label}：${escapeHtml(p)}">${escapeHtml(p)}</a>`,
    )
    .join('<span class="rs-sep" aria-hidden="true"> · </span>')
}

/** .result-artist 内容：歌手 + 专辑（各自可点）；两者皆空时退回占位文案（不留空行） */
function artistHtml(singer, albumName) {
  const s = kwLinks(singer, 'singer')
  const a = kwLinks(albumName, 'album')
  if (!s && !a) return '<span class="rs-none">未知歌手</span>'
  return [s, a].filter(Boolean).join('<span class="rs-sep" aria-hidden="true"> · </span>')
}

/** 点击歌手/专辑链接 = 以该文本为关键词发起全新单曲搜索（page=1，走既有 runSearch 入口） */
function onArtistSearch(e) {
  const a = e.target.closest('a[data-search-kw]')
  if (!a) return false
  e.preventDefault()
  e.stopPropagation()
  const kw = (a.dataset.searchKw || '').trim()
  if (!kw) return true
  // 强制切回歌曲视图：歌单搜索不渲染链接，但 state.mode / #search-type 可能仍停在 songlist
  const typeSel = $('#search-type')
  if (typeSel && typeSel.value !== 'song') typeSel.value = 'song'
  state.mode = 'song'
  syncViewSeg() // 恢复视图 toggle（songlist 下为 hidden）
  state.suppressCorrect = false // P2 O4：歌手/专辑二次搜索属新查询，重置纠错抑制
  $('#keyword').value = kw
  hidePop()
  $('#search-status').textContent = '搜索中…'
  void runSearch(1)
  return true
}

/* ============================================================
   P1 J4 · C4 音质能力（不可达档位灰显）
   GET /sources/capabilities?platform= 逐平台拉取并按平台缓存（会话级）；
   端点缺失/403/网络失败一律静默 → qNa() 恒 false（降级为不灰显，不阻断搜索）。
   ============================================================ */
const capsCache = new Map() // platform → { platform, qualities:{flac24bit,flac,'320k','128k':bool}, sources:[...] }
let capsLoading = null

function loadCapabilities() {
  if (capsCache.size || capsLoading) return capsLoading || Promise.resolve()
  capsLoading = Promise.allSettled(
    PLAT_ORDER.map((p) =>
      api.sources.capabilities(p).then((r) => {
        if (r && r.qualities) capsCache.set(p, r)
      }),
    ),
  ).then(() => {
    capsLoading = null
    // 能力到位后若已有结果，重渲染一次让灰显生效（无结果时不操作 DOM）
    if (state.mode === 'song' && (state.groupData || state.mergedData)) rerender()
  })
  return capsLoading
}

/** 该平台该档位是否「不可达」（无能力数据 → false，不灰显） */
function qNa(platform, q) {
  const c = capsCache.get(platform)
  return !!(c && c.qualities && c.qualities[q] === false)
}

/** 合并视图并集档位灰显判定：全部来源平台都不可达才灰（任一可达成即可下） */
function qNaAll(track, q) {
  const srcs = track.sources || []
  if (!srcs.length) return false
  return srcs.every((s) => qNa(s.platform, q))
}

/* ============================================================
   P1 J4 · 视图切换（按平台分组 / 按歌曲聚合）
   两视图各自缓存累积快照（groupData / mergedData），切换时：
   缓存命中（同关键词）→ 纯本地 rerender，零请求；未命中 → 拉对应端点第 1 页。
   关键词/页码/勾选态均保存在 state，不因切换丢失。
   ============================================================ */
function syncViewSeg() {
  const seg = $('#search-view-seg')
  if (!seg) return
  seg.hidden = state.mode !== 'song' // 歌单搜索无「合并去重」语义
  for (const [id, v] of [
    ['search-view-group', 'group'],
    ['search-view-merged', 'merged'],
  ]) {
    const b = document.getElementById(id)
    if (!b) continue
    b.classList.toggle('on', state.view === v)
    b.setAttribute('aria-pressed', String(state.view === v))
  }
}

function onViewSegClick(e) {
  const btn = e.target.closest('button')
  if (!btn || btn.disabled) return
  const v = btn.id === 'search-view-merged' ? 'merged' : btn.id === 'search-view-group' ? 'group' : null
  if (!v || v === state.view) return
  void switchView(v)
}

/** 从累积快照恢复分页镜像（state.page/totalCount）+ 状态栏文案 */
function restorePaging() {
  if (state.view === 'merged') {
    const md = state.mergedData
    state.page = md?.page || 1
    state.totalCount = md?.list?.length || 0
    $('#search-status').textContent = state.totalCount ? `共 ${state.totalCount} 首（跨平台合并去重）` : '无结果'
  } else {
    const gd = state.groupData
    state.page = gd?.page || 1
    state.totalCount = (gd?.results || []).reduce((n, pr) => n + (pr.ok ? pr.list.length : 0), 0)
    $('#search-status').textContent = state.totalCount
      ? state.page > 1
        ? `共 ${state.totalCount} 首 · 已加载至第 ${state.page} 页`
        : `共 ${state.totalCount} 首`
      : '无结果'
  }
}

async function switchView(v) {
  state.view = v
  syncViewSeg()
  const keyword = $('#keyword').value.trim()
  const platform = $('#platform').value
  if (!keyword || state.mode !== 'song') return
  if (v === 'merged') {
    if (state.mergedData && state.mergedData.keyword === keyword) {
      // 缓存命中：纯本地重渲染（零请求，关键词/页码/勾选零丢失）
      restorePaging()
      rerender()
      return
    }
    $('#search-status').textContent = '搜索中…'
    // #196-fix5: 保留当前页码（分组已加载到第 N 页时切换不重置）
    const curPage = state.groupData?.page || state.page || 1
    const n = await renderMerged(keyword, platform, curPage)
    if (n === false) {
      // 端点不可用（旧 dist / 5xx）→ 降级回分组视图，保搜索页可用
      state.view = 'group'
      syncViewSeg()
      toast('合并视图暂不可用，已切回按平台分组')
      if (state.groupData && state.groupData.keyword === keyword) {
        restorePaging()
        rerender()
      }
    }
    return
  }
  if (state.groupData && state.groupData.keyword === keyword) {
    restorePaging()
    rerender()
    return
  }
  // 分组视图无缓存（如首次搜索就在合并视图）：直拉对应端点，不清 mergedData（两视图缓存共存）
  $('#search-status').textContent = '搜索中…'
  try {
    if (platform === 'aggregate') renderAggregate(await api.search.aggregate({ keyword, page: 1 }), 1)
    else renderSingle(platform, await api.search.song({ keyword, platform, page: 1 }), 1)
  } catch (err) {
    $('#search-status').textContent = `搜索失败: ${err.message}`
  }
}


// ---------- 搜索入口 ----------
/** 提交入口：表单 submit / 面板回填后的合成 submit 事件（page=1 全新搜索） */
function onSearch(e) {
  e.preventDefault()
  state.suppressCorrect = false // P2 O4：用户主动发起新搜索 → 允许再次给出纠错建议
  runSearch(1)
}

/**
 * P0 E1：解除 page:1 硬编码——page 参数化（首页=1 重置渲染；加载更多=page+1 追加渲染）。
 * 仅单曲搜索支持分页；歌单搜索维持单页现状（page 恒 1）。
 * P1 J4：单曲搜索按 state.view 分流——'merged' 走 GET /search/merged（renderMerged），
 *   'group' 走既有 aggregate/single 分组渲染；合并视图不可用时降级回分组视图重拉。
 */
async function runSearch(page = 1) {
  const keyword = $('#keyword').value.trim()
  if (!keyword) return
  state.quality = $('#quality').value
  const platform = $('#platform').value
  const searchType = $('#search-type').value
  state.mode = searchType === 'songlist' ? 'songlist' : 'song'
  syncViewSeg() // 歌单搜索隐藏视图 toggle
  if (page === 1) {
    $('#search-status').textContent = '搜索中…'
    resetResults()
  }

  try {
    if (searchType === 'songlist') {
      if (platform === 'aggregate') {
        renderSongListAggregate(await api.search.songlistAggregate({ keyword, page }))
      } else {
        renderSongListSingle(platform, await api.search.songlist({ keyword, platform, page }))
      }
      if (page === 1) recordSearch(keyword, searchType, platform) // P0-3：成功渲染后写入历史（仅首页，加载更多不重复记）
      return
    }
    if (state.view === 'merged') {
      const n = await renderMerged(keyword, platform, page)
      if (n === false && page === 1) {
        // P1 J4 降级：/search/merged 不可用（旧 dist 未部署 / 5xx）→ 回分组视图，不让搜索页变空壳
        state.view = 'group'
        syncViewSeg()
        toast('合并视图暂不可用，已切回按平台分组')
        if (platform === 'aggregate') renderAggregate(await api.search.aggregate({ keyword, page }), page)
        else renderSingle(platform, await api.search.song({ keyword, platform, page }), page)
      }
    } else if (platform === 'aggregate') {
      renderAggregate(await api.search.aggregate({ keyword, page }), page)
    } else {
      renderSingle(platform, await api.search.song({ keyword, platform, page }), page)
    }
    if (page === 1) recordSearch(keyword, searchType, platform) // P0-3：成功渲染后写入历史（仅首页，加载更多不重复记）
  } catch (err) {
    $('#search-status').textContent = page > 1 ? `加载更多失败: ${err.message}` : `搜索失败: ${err.message}`
  }
}

function resetResults() {
  $('#results').innerHTML = ''
  state.results = []
  state.selected.clear()
  state.page = 1
  state.totalCount = 0
  state.moreLoading = false
  state.last = null
  // P1 J4/K1：新搜索重置两视图累积快照 + 展开态 + 筛选（排序偏好跳搜索保留，更符合直觉）
  state.groupData = null
  state.mergedData = null
  state.expanded.clear()
  // P2 O1/O4/O5：新搜索清空纠错建议与相关推荐 + 停止进行中的试听
  stopPreview()
  state.correct = null
  renderCorrect()
  state.related = []
  renderRelated()
  resetFilters()
  // P1 K1：新一轮搜索先收起 chips 与「显示 X / Y」（数据到位后由 rerender 重建）
  renderFilters()
  updateFilterSummary(0)
  updateSelectedCount()
}

// ---------- P0 E1：「加载更多」（结果区尾部追加，事件走 #results 统一委托） ----------

/** 移除旧的加载更多行（每次渲染/重置后重建，避免叠加） */
function removeMoreRow() {
  $('#results').querySelector('.search-more-row')?.remove()
}

/** 追加「加载更多」按钮（#196-fix4: 用视图数据层的 page 而非 state.page，避免 rerender 在 finalizeSearch 前调用时 label 陈旧） */
function appendMoreRow() {
  removeMoreRow()
  const curPage = state.view === 'merged' ? (state.mergedData?.page || 1) : (state.groupData?.page || 1)
  const row = document.createElement('div')
  row.className = 'search-more-row'
  row.innerHTML = `<button id="search-more" type="button">加载更多（第 ${curPage + 1} 页）</button>`
  $('#results').appendChild(row)
}

/** 加载更多判定：任一平台本页满页（≥ 后端统一默认 limit 30）即认为还有下一页。
 *  兼容三种响应形状：聚合 results[].list / 单平台 list / 合并视图 list（P1 J4） */
function hasMorePages(data) {
  const lists = data.results ? (data.results || []).filter((pr) => pr.ok).map((pr) => pr.list || []) : [data.list || []]
  return lists.some((l) => l.length >= DEFAULT_LIMIT)
}

/** #results 统一点击委托：加载更多 / 歌手专辑二次搜索（O3）/ 试听（O1）/ 收藏心形（O2）/ 展开来源（J4）/ 已下载直接播（I3）/ 行内单首下载 */
function onResultsClick(e) {
  if (e.target.closest('#search-more')) return void onLoadMore()
  if (onArtistSearch(e)) return
  if (onPreviewClick(e)) return
  if (handleFavClick(e, favNameOf)) return
  if (onMergedToggle(e)) return
  if (onRowPlay(e)) return
  return onRowDownload(e)
}

async function onLoadMore() {
  const btn = $('#search-more')
  if (!btn || state.moreLoading || !state.last) return
  state.moreLoading = true
  btn.disabled = true
  btn.textContent = '加载中…'
  const next = state.page + 1
  const { keyword, platform, searchType } = state.last
  try {
    let count
    if (searchType === 'song' && state.view === 'merged') {
      // P1 J4：合并视图分页（追加页 concat 进 mergedData 后统一 rerender）
      count = await renderMerged(keyword, platform, next)
    } else if (platform === 'aggregate') {
      count = renderAggregate(await api.search.aggregate({ keyword, page: next }), next)
    } else {
      count = renderSingle(platform, await api.search.song({ keyword, platform, page: next }), next)
    }
    // P1 J4/K：分页/筛选/排序统一由 rerender() 按 activeHasMore() 决定「加载更多」去留
    //（#189 D2 链路保留：hasMorePages 判定不变，仅渲染方式由 DOM append 改为数据层累积）
    if (!count) $('#search-status').textContent = `共 ${state.totalCount} 首 · 第 ${next} 页无更多结果`
  } catch (err) {
    $('#search-status').textContent = `加载更多失败: ${err.message}`
    btn.disabled = false
    btn.textContent = `重试加载更多（第 ${next} 页）`
  } finally {
    // 成功路径也必须复位：appendMoreRow() 已换新按钮，若沿用旧守卫值则下次点击
    // 被 moreLoading 拦下，分页只能前进一页就永久卡死（到不了末页）。
    state.moreLoading = false
  }
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
  renderFilters() // P1 K1：歌单搜索无单曲筛选语义 → 收起 chips
}

function renderSongListSingle(platform, data) {
  $('#results').appendChild(renderSongListGroup(platform, data.list, null))
  $('#search-status').textContent = data.list.length ? `共 ${data.list.length} 个歌单` : '无结果'
  $('#search-toolbar').hidden = true
  renderFilters()
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
    // 复用歌曲渲染 + 多选批量能力（行下载钮同样享有 P1 I3 三态）
    state.mode = 'songlist' // 歌单详情不参与视图切换/筛选/排序（rerender 早退，不抹掉返回钮）
    syncViewSeg()
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

// ---------- 单曲搜索渲染（P0 E1：page>1 追加，page=1 全新；P1 J4/K：数据层累积 + 统一 rerender） ----------
/**
 * 聚合搜索渲染：一页响应并入 state.groupData 后统一重渲染。
 * @returns {number} 本页新增结果数（供加载更多判定文案）
 */
function renderAggregate(data, page = 1) {
  const pageCount = mergeGroupPage(data, page)
  rerender()
  finalizeSearch(pageCount, page, data)
  return pageCount
}

/** 单平台搜索渲染（与聚合同路径：数据层累积 → rerender） */
function renderSingle(platform, data, page = 1) {
  const pageCount = mergeGroupPage(data, page, platform)
  rerender()
  finalizeSearch(pageCount, page, data)
  return pageCount
}

/**
 * 把一页单曲搜索响应并入 state.groupData（分组视图唯一数据源；追加页同平台合并 list）。
 * 归一化：聚合响应 results[]（保留 ok/error 供 P1b 警示条重建时复原）/ 单平台响应 { list }。
 * @returns {number} 本页有效新增条数（仅 ok 平台，与 #189 前 pageCount 口径一致）
 */
function mergeGroupPage(data, page, platform = null) {
  const incoming = data.results
    ? (data.results || []).map((pr) => ({ platform: pr.platform, ok: !!pr.ok, list: pr.list || [], error: pr.ok ? null : pr.error }))
    : [{ platform, ok: true, list: data.list || [], error: null }]
  const keyword = $('#keyword').value.trim()
  const more = hasMorePages(data)
  if (page === 1 || !state.groupData) {
    state.groupData = { keyword, results: incoming, page, hasMore: more }
  } else {
    const gd = state.groupData
    for (const pr of incoming) {
      const exist = gd.results.find((r) => r.platform === pr.platform)
      if (exist) {
        // 追加页同平台并入既有分组（等价 #189 的 DOM append 合并，改在数据层做，重渲染零重叠）
        exist.list = exist.list.concat(pr.list)
        if (!pr.ok) {
          exist.ok = false
          exist.error = pr.error
        }
      } else gd.results.push(pr)
    }
    gd.page = page
    gd.hasMore = more
  }
  return incoming.reduce((n, pr) => n + (pr.ok ? pr.list.length : 0), 0)
}

/**
 * P1 J4：合并视图取数 + 渲染（GET /search/merged）。
 * @returns {Promise<number|false>} 本页新增合并条目数；false = 端点不可用（首页降级依据）。
 *   追加页失败直接 throw，交给 onLoadMore 的「重试加载更多」文案。
 */
async function renderMerged(keyword, platform, page) {
  let data
  try {
    // platforms 缺省 = 全平台（聚合）；单平台搜索时只传该平台，后端仍走去重合并管线
    data = await api.search.merged(keyword, { platforms: platform === 'aggregate' ? '' : platform, page })
  } catch (err) {
    if (page === 1) {
      $('#search-status').textContent = `合并视图不可用: ${err.message}`
      return false
    }
    throw err
  }
  const list = Array.isArray(data.list) ? data.list : []
  const md = state.mergedData
  if (page === 1 || !md || md.keyword !== keyword) {
    state.mergedData = { keyword, list, total: data.total ?? list.length, page, hasMore: hasMorePages(data) }
  } else {
    md.list = md.list.concat(list)
    md.total = data.total ?? md.list.length
    md.page = page
    md.hasMore = hasMorePages(data)
  }
  const pageCount = list.length
  rerender()
  finalizeSearch(pageCount, page, data)
  if (page === 1) {
    const srcCount = list.reduce((n, t) => n + (t.sources || []).length, 0)
    $('#search-status').textContent = pageCount ? `共 ${pageCount} 首（跨平台合并去重 · ${srcCount} 个来源）` : '无结果'
  }
  return pageCount
}

/** 当前视图是否还有下一页（「加载更多」按钮去留唯一依据） */
function activeHasMore() {
  return state.view === 'merged' ? !!state.mergedData?.hasMore : !!state.groupData?.hasMore
}

/**
 * P1 J4/K1/K2 统一重渲染入口：视图切换、筛选、排序、分页追加一律走这里
 * （数据层累积 + 本地重建 DOM，不重新请求 → 搜索状态零丢失）。
 * 重建后还原勾选态与展开态、刷新筛选 chips 计数与「加载更多」按钮。
 */
function rerender() {
  if (state.mode !== 'song') return // 歌单搜索/歌单详情不参与（它们直渲染，无累积快照）
  const container = $('#results')
  container.innerHTML = ''
  state.results = [] // renderGroup / mergedRow 渲染时重新 push（rowKey 语义不变）
  const shown = state.view === 'merged' ? renderMergedRows(container) : renderGroupRows(container)
  // 还原勾选态（重渲染不丢多选）
  $$('#results input[type=checkbox]').forEach((cb) => {
    cb.checked = state.selected.has(cb.dataset.key)
  })
  $('#check-all').checked = false
  updateSelectedCount()
  renderFilters()
  updateFilterSummary(shown)
  if (activeHasMore()) appendMoreRow()
  else removeMoreRow()
}

/** 分组视图（= 保留既有 renderAggregate 的按平台分组渲染）+ K1 过滤 + K2 排序 */
function renderGroupRows(container) {
  const gd = state.groupData
  if (!gd) return 0
  appendSourceWarnings(container, gd.results) // P1b：失效警示条（重建视图时复原）
  const filtering = filtersActive()
  // K2「平台」在分组视图下语义 = 分组自身顺序（组内条目平台恒定，组内再排无意义）
  const groups =
    state.sort === 'platform' ? gd.results.slice().sort((a, b) => platRank(a.platform) - platRank(b.platform)) : gd.results
  let shown = 0
  for (const pr of groups) {
    const items = applySort(applyFilters(pr.list.map((raw) => ({ ...raw, platform: pr.platform }))))
    shown += items.length
    // 筛选后为空且该平台本身没报错 → 整组跳过（避免满屏「无结果」占位）
    if (!items.length && filtering && !pr.error) continue
    container.appendChild(renderGroup(pr.platform, items, pr.ok ? null : pr.error))
  }
  return shown
}

/** 合并视图渲染（J4）：每条 MergedTrack 一行，默认折叠；展开态由 state.expanded 记忆 */
function renderMergedRows(container) {
  const md = state.mergedData
  if (!md) return 0
  const tracks = applySort(applyFilters(md.list))
  if (!tracks.length) {
    container.appendChild(emptyBox(filtersActive() ? '无符合筛选条件的结果' : '无结果'))
    return 0
  }
  const listEl = document.createElement('div')
  listEl.className = 'result-list merged-list'
  for (const t of tracks) listEl.appendChild(mergedRow(t))
  container.appendChild(listEl)
  return tracks.length
}

function emptyBox(text) {
  const p = document.createElement('div')
  p.className = 'empty'
  p.textContent = text
  return p
}

function appendEmpty(parent, text = '无结果') {
  parent.appendChild(emptyBox(text))
}

/**
 * 收尾：更新分页状态与状态栏文案。
 * @param {object|null} data 原始搜索响应（仅单曲搜索传入）；P0 D2：page=1 渲染完成后
 *   据此判定并打通「加载更多」入口（此前 appendMoreRow 只在 onLoadMore 内调用，
 *   首页路径无入口 → 按钮永不出现、后端分页能力不可达）。
 *   歌单详情 openSongListDetail 不传 data（该接口不分页，不出按钮）。
 */
function finalizeSearch(pageCount, page = 1, data = null) {
  if (page === 1) {
    state.page = 1
    state.totalCount = pageCount
    state.last = { keyword: $('#keyword').value.trim(), platform: $('#platform').value, searchType: $('#search-type').value }
    $('#search-status').textContent = pageCount ? `共 ${pageCount} 首` : '无结果'
    $('#search-toolbar').hidden = pageCount === 0
    $('#check-all').checked = false
    // state.page 已置 1 → 按钮文案为「加载更多（第 2 页）」；无下页/无 data 则不渲染
    if (data && pageCount > 0 && hasMorePages(data)) appendMoreRow()
    else removeMoreRow()
    // P2 O4/O5：仅歌曲搜索响应可能带 corrected；歌单搜索 data 无该字段（captureCorrect(null) 静默隐藏）
    captureCorrect(state.mode === 'song' ? data : null, page)
    if (state.mode === 'song') void loadRelated($('#keyword').value.trim())
  } else {
    state.page = page
    state.totalCount += pageCount
    $('#search-status').textContent = `共 ${state.totalCount} 首 · 已加载至第 ${page} 页`
  }
}

function renderGroup(platform, list, error) {
  const group = document.createElement('div')
  group.className = 'platform-group'
  group.dataset.platform = platform // P0 E1：「加载更多」追加页定位同平台分组合并
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
    // P1 J4：不可达音质档位灰显（C4 capabilities；无能力数据时不灰显，零回归）
    const qualities = (item.types || [])
      .map((t) => {
        const q = Q_ALIAS[String(t.type ?? '').toLowerCase()]
        const na = q ? qNa(platform, q) : false
        return `<span class="badge q${na ? ' q-na' : ''}"${na ? ' title="当前音源池不可达该档位"' : ''}>${escapeHtml(t.type)}</span>`
      })
      .join('')
    // P0 E2：真实封面（item.img 上游已返回）——img 绝对定位盖在音符占位上，
    // onerror 移除自身露出下层橙渐变占位（home.js COVER_ERR 径向渐变兜底范式）；
    // 无 img 字段维持纯占位 SVG，零回归
    const cover = item.img
      ? `<img src="${escapeHtml(item.img)}" alt="" loading="lazy" referrerpolicy="no-referrer" onerror="${COVER_ERR}" />`
      : ''
    const row = document.createElement('div')
    row.className = 'result-row'
    // P1 I3：行 key 上 DOM（SSE task:* 事件按 platform:songmid 定位行局部刷新三态）
    row.dataset.key = key
    row.innerHTML = `
      <label class="result-chk"><input type="checkbox" data-key="${escapeHtml(key)}" aria-label="选中 ${escapeHtml(item.name)}" /></label>
      <div class="result-cover" aria-hidden="true">
        <svg viewBox="0 0 24 24" width="16" height="16"><path d="M9 18V6l10-2v11.5" stroke="currentColor" stroke-width="1.6" fill="none" stroke-linecap="round" stroke-linejoin="round"/><circle cx="6.5" cy="18" r="2.5" fill="currentColor"/><circle cx="16.5" cy="15.5" r="2.5" fill="currentColor"/></svg>${cover}
      </div>
      <div class="result-info">
        <div class="result-name">${escapeHtml(item.name)}</div>
        <div class="result-artist">${artistHtml(item.singer, item.albumName)}</div>
      </div>
      <div class="result-right">
        ${item.interval ? `<span class="result-dur">${escapeHtml(String(item.interval))}</span>` : ''}
        ${qualities}
        ${previewHtml(item)}${favHtml(item)}
        <span class="hp-row-state">${rowStateHtml(item)}</span>
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
  // #196-fix6: 按 key 去重（合并视图展开来源可能与主来源同 key，避免批量 body 重复）
  const seen = new Set()
  return state.results.filter((it) => {
    const k = rowKey(it)
    if (!state.selected.has(k) || seen.has(k)) return false
    seen.add(k)
    return true
  })
}

function clearSelection() {
  state.selected.clear()
  $$('#results input[type=checkbox]').forEach((cb) => (cb.checked = false))
  $('#check-all').checked = false
  updateSelectedCount()
}

// ---------- 单首下载（行内玻璃小圆钮，复用批量下载接口） ----------
/**
 * P1 I3：入队后用返回的 task id 乐观驱动本行三态（pending 进度环），后续由 SSE task:* 接管。
 * 修复 E2E 发现的「入队即 add('done') 绿态、无进度环、无失败反馈」：
 * 旧实现把「已提交」当「已完成」，用户看不到下载中/失败；现在三态完整（含 failed 重试）。
 */
async function onRowDownload(e) {
  const btn = e.target.closest('button[data-dl]')
  if (!btn || btn.disabled) return
  const key = btn.dataset.dl
  const item = state.results.find((it) => rowKey(it) === key)
  if (!item) return
  btn.disabled = true
  try {
    // P0 D3：音质统一走 getDownloadQuality()（顶栏 #dl-quality > settings.download.defaultQuality > 'flac'）
    const r = await api.download.batch({ items: [{ platform: item.platform, musicInfo: item }], quality: getDownloadQuality() })
    const tid = r.accepted?.[0]?.id
    if (tid) {
      // 乐观入队：并入 owned 后立即局部刷新本行 → 进度环（不再是假绿态）
      mergeOwned(state.owned, {
        id: tid,
        platform: item.platform,
        songmid: String(item.songmid),
        name: item.name,
        singer: item.singer,
        status: 'pending',
        progress: 0,
        updatedAt: Date.now(),
      })
      refreshRowByKey(key)
      toast(`已提交下载：${item.name}`)
    } else if (r.acceptedCount) {
      // 无 id 回退（老版服务端）：维持既有「已入队」提示，不误报完成态
      btn.classList.add('done')
      btn.title = '已入队'
      toast(`已提交下载：${item.name}`)
    } else {
      toast('该曲目下载被服务端拒绝')
      btn.disabled = false
    }
  } catch (err) {
    toast(`下载失败: ${err.message}`)
    btn.disabled = false
  }
}

// ---------- 批量下载 ----------
async function onBatchDownload() {
  const picked = selectedItems()
  if (!picked.length) return
  const btn = $('#batch-download')
  btn.disabled = true
  try {
    // P1 I3：前端去重（公共模块 dedupeItems）——已在库（completed）的曲目跳过，不重复入队
    const { pending, skipped } = dedupeItems(picked, state.owned)
    if (!pending.length) {
      toast(`选中的 ${skipped} 首均已下载，无需重复入队`)
      clearSelection()
      return
    }
    const items = pending.map((it) => ({ platform: it.platform, musicInfo: it }))
    // P0 D3：音质统一走 getDownloadQuality()，与 home/playlists 同源
    const r = await api.download.batch({ items, quality: getDownloadQuality() })
    // 乐观入队：accepted[].index 回指提交项 → 逐条并入 owned + 局部刷新对应行
    for (const a of r.accepted || []) {
      const it = pending[a?.index]
      if (!a?.id || !it) continue
      mergeOwned(state.owned, {
        id: a.id,
        platform: it.platform,
        songmid: String(it.songmid),
        name: it.name,
        singer: it.singer,
        status: 'pending',
        progress: 0,
        updatedAt: Date.now(),
      })
      refreshRowByKey(rowKey(it))
    }
    toast(
      `已提交 ${r.acceptedCount} 首` +
        `${skipped ? `（${skipped} 首已在库跳过）` : ''}` +
        `${r.rejectedCount ? `，${r.rejectedCount} 首被拒` : ''}`,
    )
    clearSelection()
  } catch (err) {
    toast(`批量下载失败: ${err.message}`)
  } finally {
    btn.disabled = state.selected.size === 0
  }
}

/* ============================================================
   P1 J4 · 合并视图行渲染（MergedTrack → 折叠行 + 可展开 sources[]）
   行结构与分组视图同语系（.result-row/.result-cover/.result-right），
   额外携带：★score 徽章、来源数、展开钮 .mg-toggle、展开区 .mg-sources。
   ============================================================ */

/** 合并行 key：主来源（sources[0]，服务端按音质最高挑代表）的 platform:songmid；无来源时退化为 name|singer */
function mergedKey(track) {
  const s = (track.sources || [])[0]
  return s ? `${s.platform}:${s.songmid}` : `m:${track.name}|${track.singer}`
}

/** 合并行的全部来源条目（纯函数：{...songInfo, platform, songmid}，与分组视图 item 同构 → 下载/多选零改造） */
function mergedSrcItems(track) {
  return (track.sources || []).map((s) => ({
    ...(s.songInfo || {}),
    platform: s.platform,
    songmid: s.songmid ?? (s.songInfo || {}).songmid,
  }))
}

function mergedRow(track) {
  const srcs = track.sources || []
  const srcItems = mergedSrcItems(track)
  // 全部来源都进 state.results：折叠态下主来源可下载，展开后每个来源各自可下载（rowKey 命中）
  for (const it of srcItems) state.results.push(it)
  const primary = srcItems[0]
  const key = mergedKey(track)
  const open = state.expanded.has(key)
  // 音质并集（已按档位降序）；全平台均不可达的档位灰显
  const badges = normQualities(track.qualities)
    .map((q) => {
      const na = qNaAll(track, q)
      return `<span class="badge q${na ? ' q-na' : ''}"${na ? ' title="当前音源池不可达该档位"' : ''}>${escapeHtml(QUALITY_LABEL[q] || q)}</span>`
    })
    .join('')
  const cover = track.img
    ? `<img src="${escapeHtml(track.img)}" alt="" loading="lazy" referrerpolicy="no-referrer" onerror="${COVER_ERR}" />`
    : ''
  const row = document.createElement('div')
  row.className = 'result-row merged-row'
  row.dataset.key = key // P1 I3：三态局部刷新定位
  row.innerHTML = `
      <label class="result-chk">${
        primary ? `<input type="checkbox" data-key="${escapeHtml(rowKey(primary))}" aria-label="选中 ${escapeHtml(track.name)}" />` : ''
      }</label>
      <div class="result-cover" aria-hidden="true">
        <svg viewBox="0 0 24 24" width="16" height="16"><path d="M9 18V6l10-2v11.5" stroke="currentColor" stroke-width="1.6" fill="none" stroke-linecap="round" stroke-linejoin="round"/><circle cx="6.5" cy="18" r="2.5" fill="currentColor"/><circle cx="16.5" cy="15.5" r="2.5" fill="currentColor"/></svg>${cover}
      </div>
      <div class="result-info">
        <div class="result-name">${escapeHtml(track.name)}</div>
        <div class="result-artist">${artistHtml(track.singer, track.albumName)}</div>
      </div>
      <div class="result-right">
        ${track.interval ? `<span class="result-dur">${escapeHtml(String(track.interval))}</span>` : ''}
        <span class="badge score" title="J2 相关度评分（越高越相关）">★ ${escapeHtml(Number(track.score || 0).toFixed(2))}</span>
        ${
          srcs.length > 1
            ? `<button class="mg-toggle${open ? ' on' : ''}" type="button" data-mg="${escapeHtml(key)}" aria-expanded="${open}" title="展开/收起全部 ${srcs.length} 个来源"><span class="mg-count">${srcs.length} 源</span><svg class="mg-caret" viewBox="0 0 12 12" width="10" height="10" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M2.5 4.5 6 8l3.5-3.5"/></svg></button>`
            : `<span class="badge srcs">${srcs.length} 源</span>`
        }
        ${badges}
        ${primary ? previewHtml(primary) + favHtml(primary) : ''}
        <span class="hp-row-state">${primary ? rowStateHtml(primary) : ''}</span>
      </div>`
  const cb = row.querySelector('input[type=checkbox]')
  if (cb) {
    cb.addEventListener('change', () => {
      if (cb.checked) state.selected.add(cb.dataset.key)
      else state.selected.delete(cb.dataset.key)
      updateSelectedCount()
    })
  }
  if (open) row.appendChild(mergedSourcesBox(track, srcItems)) // 重渲染后保持展开态
  return row
}

/** 展开区：每来源一行（平台名 + songmid + 该来源音质（不可达灰显）+ 独立三态下载钮） */
function mergedSourcesBox(track, srcItems) {
  const box = document.createElement('div')
  box.className = 'mg-sources'
  box.innerHTML = (track.sources || [])
    .map((s, i) => {
      const item = srcItems[i]
      const key = item ? rowKey(item) : `${s.platform}:${s.songmid}`
      const quals = normQualities(s.qualities)
        .map((q) => {
          const na = qNa(s.platform, q)
          return `<span class="badge q${na ? ' q-na' : ''}"${na ? ' title="当前音源池不可达该档位"' : ''}>${escapeHtml(QUALITY_LABEL[q] || q)}</span>`
        })
        .join('')
      return `<div class="mg-src" data-key="${escapeHtml(key)}">
        <span class="mg-plat">${escapeHtml(PLATFORM_NAME[s.platform] || s.platform)}</span>
        <code class="mg-mid" title="songmid">${escapeHtml(String(s.songmid ?? ''))}</code>
        ${quals}
        ${item ? previewHtml(item) + favHtml(item) : ''}
        <span class="hp-row-state">${item ? rowStateHtml(item) : ''}</span>
      </div>`
    })
    .join('')
  return box
}

/** 展开/收起合并行的 sources[]（局部 DOM 增删，不重渲染整表 → 滚动位置不跳） */
function onMergedToggle(e) {
  const btn = e.target.closest('button[data-mg]')
  if (!btn) return false
  const key = btn.dataset.mg
  const row = btn.closest('.result-row')
  if (!row) return true
  const track = (state.mergedData?.list || []).find((t) => mergedKey(t) === key)
  if (!track) return true
  if (state.expanded.has(key)) {
    state.expanded.delete(key)
    row.querySelector('.mg-sources')?.remove()
    btn.classList.remove('on')
    btn.setAttribute('aria-expanded', 'false')
  } else {
    state.expanded.add(key)
    row.appendChild(mergedSourcesBox(track, mergedSrcItems(track)))
    btn.classList.add('on')
    btn.setAttribute('aria-expanded', 'true')
    refreshAllRowStates() // 新展开的来源行立即对齐 owned 三态
  }
  return true
}

/* ============================================================
   P1 K1 · 筛选 chips（来源/音质/歌手/专辑；library.js #lib-filters 范式）
   组内单选、再点同项取消、chip 带计数；计数基数排除本组已选（避免自锁为 0）
   ============================================================ */
const FILTER_GROUPS = [
  { key: 'source', label: '来源' },
  { key: 'quality', label: '音质' },
  { key: 'singer', label: '歌手' },
  { key: 'album', label: '专辑' },
]

function filtersActive() {
  const f = state.filters
  return !!(f.source || f.quality || f.singer || f.album)
}

function resetFilters() {
  state.filters = { source: null, quality: null, singer: null, album: null }
}

/** 分组视图条目 → 筛选面 */
function groupFacet(it) {
  return {
    sources: [it.platform],
    qualities: normQualities((it.types || []).map((t) => t.type)),
    singer: String(it.singer || '').trim(),
    album: String(it.albumName || '').trim(),
    interval: it.interval,
  }
}

/** 合并视图条目 → 筛选面（sources = 全部来源平台；qualities = 服务端并集） */
function mergedFacet(t) {
  return {
    sources: (t.sources || []).map((s) => s.platform),
    qualities: normQualities(t.qualities),
    singer: String(t.singer || '').trim(),
    album: String(t.albumName || '').trim(),
    interval: t.interval,
  }
}

function facetOf(x) {
  return state.view === 'merged' ? mergedFacet(x) : groupFacet(x)
}

function facetValues(f, key) {
  if (key === 'source') return f.sources
  if (key === 'quality') return f.qualities
  const v = key === 'singer' ? f.singer : f.album
  return v ? [v] : []
}

/** 除 except 组外的全部已选条件是否命中（except=null → 全条件，applyFilters 用） */
function passFacet(f, except) {
  const fl = state.filters
  if (except !== 'source' && fl.source && !f.sources.includes(fl.source)) return false
  if (except !== 'quality' && fl.quality && !f.qualities.includes(fl.quality)) return false
  if (except !== 'singer' && fl.singer && f.singer !== fl.singer) return false
  if (except !== 'album' && fl.album && f.album !== fl.album) return false
  return true
}

/** K1：对当前视图结果前端过滤（未启用筛选时原样返回，零开销） */
function applyFilters(list) {
  if (!filtersActive()) return list
  return list.filter((x) => passFacet(facetOf(x), null))
}

/** 当前视图未过滤的筛选面全集（chips 计数基数 + 「显示 X / Y」的 Y） */
function facetRows() {
  if (state.view === 'merged') return (state.mergedData?.list || []).map(mergedFacet)
  const out = []
  for (const pr of state.groupData?.results || []) {
    if (!pr.ok) continue
    for (const raw of pr.list) out.push(groupFacet({ ...raw, platform: pr.platform }))
  }
  return out
}

/** chips 取值排序：来源按平台固定序 / 音质按档位降序 / 歌手·专辑按出现次数 Top N */
function orderFacet(key, count) {
  const keys = [...count.keys()]
  if (key === 'source') return keys.sort((a, b) => platRank(a) - platRank(b))
  if (key === 'quality') return keys.sort((a, b) => QUALITIES.indexOf(a) - QUALITIES.indexOf(b))
  return keys.sort((a, b) => count.get(b) - count.get(a) || String(a).localeCompare(String(b), 'zh')).slice(0, FACET_TOP_N)
}

function facetLabel(key, v) {
  if (key === 'source') return PLATFORM_NAME[v] || v
  if (key === 'quality') return QUALITY_LABEL[v] || v
  return v
}

/** chips 渲染（.lf-label / .lf-sep / .lib-chip + <i>count</i>，与 #lib-filters 同视觉语系） */
function renderFilters() {
  const box = $('#search-filters')
  if (!box) return
  const all = state.mode === 'song' && (state.groupData || state.mergedData) ? facetRows() : []
  if (!all.length) {
    box.hidden = true
    box.innerHTML = ''
    return
  }
  // 预校验：已选值在当前数据中消失（换关键词/翻页后）→ 先重置，避免隐性空结果
  for (const g of FILTER_GROUPS) {
    const cur = state.filters[g.key]
    if (cur && !all.some((f) => facetValues(f, g.key).includes(cur))) state.filters[g.key] = null
  }
  const chip = (active, attrs, label, count) =>
    `<button type="button" class="lib-chip${active ? ' on' : ''}" ${attrs} aria-pressed="${active}">${escapeHtml(label)}<i>${count}</i></button>`
  const parts = []
  for (const g of FILTER_GROUPS) {
    const base = all.filter((f) => passFacet(f, g.key)) // 计数基数排除本组已选
    const count = new Map()
    for (const f of base) for (const v of facetValues(f, g.key)) count.set(v, (count.get(v) || 0) + 1)
    const list = orderFacet(g.key, count)
    if (!list.length) continue
    if (parts.length) parts.push('<span class="lf-sep" aria-hidden="true"></span>')
    parts.push(`<span class="lf-label">${g.label}</span>`)
    parts.push(
      list
        .map((v) =>
          chip(state.filters[g.key] === v, `data-f${g.key}="${escapeHtml(String(v))}"`, facetLabel(g.key, v), count.get(v) || 0),
        )
        .join(''),
    )
  }
  box.innerHTML = parts.join('')
  box.hidden = !parts.length
}

function onFilterClick(e) {
  const btn = e.target.closest('button.lib-chip')
  if (!btn) return
  for (const g of FILTER_GROUPS) {
    const v = btn.dataset[`f${g.key}`]
    if (v == null) continue
    state.filters[g.key] = state.filters[g.key] === v ? null : v // 再点同项取消
    break
  }
  rerender() // 本地重渲染：不重新请求，关键词/页码/勾选零丢失
}

/** 工具条右侧「显示 X / Y」（仅筛选或排序生效时出现，给用户明确可感知反馈） */
function updateFilterSummary(shown) {
  const el = $('#search-filter-summary')
  if (!el) return
  const total = facetRows().length
  el.textContent = filtersActive() || state.sort !== 'relevance' ? `显示 ${shown} / ${total}` : ''
}

/* ============================================================
   P1 K2 · 排序（渲染前 sort）
   相关度（默认）：合并视图 = MergedTrack.score 降序（后端已排，前端防御性稳定重排）；
                 分组视图 = 平台内后端相关度原序；
   时长 = interval（"m:ss"/秒 归一）升序；音质 = 最高档位降序；平台 = PLAT_ORDER。
   ============================================================ */
function onSortChange() {
  state.sort = $('#search-sort').value || 'relevance'
  rerender()
}

function applySort(list) {
  const s = state.sort
  if (!s || s === 'relevance') {
    if (state.view === 'merged' && list.length > 1) return list.slice().sort((a, b) => Number(b.score || 0) - Number(a.score || 0))
    return list
  }
  if (list.length < 2) return list
  const paired = list.map((x) => ({ x, f: facetOf(x) }))
  if (s === 'duration') paired.sort((a, b) => durSec(a.f.interval) - durSec(b.f.interval))
  else if (s === 'quality')
    paired.sort((a, b) => topQRank(b.f.qualities) - topQRank(a.f.qualities) || durSec(a.f.interval) - durSec(b.f.interval))
  else if (s === 'platform')
    paired.sort((a, b) => platRank(a.f.sources[0]) - platRank(b.f.sources[0]) || durSec(a.f.interval) - durSec(b.f.interval))
  return paired.map((p) => p.x)
}

// ---------- 一键加入歌单（弹窗选择/新建；P0 E3 批量接线） ----------
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
  const songs = items.map((it) => ({ platform: it.platform, musicInfo: it }))
  // P0 E3：新建歌单 → /playlists/import 一次往返批量建单（替代 create + N 次 addItem；
  // 服务端同构校验 { platform, musicInfo }，重名自动加后缀 renamed，上限 200 首）
  if (pick.newName != null) {
    try {
      const r = await api.playlists.importSongs({ title: pick.newName, songs })
      toast(
        `已创建「${r.name}」并加入 ${r.addedCount ?? r.count ?? songs.length} 首` +
          `${r.skippedCount ? `（${r.skippedCount} 首已存在）` : ''}${r.rejectedCount ? `，${r.rejectedCount} 首无效被跳过` : ''}`,
      )
    } catch (err) {
      toast(`加入歌单失败: ${err.message}`)
    }
    return
  }
  // 既有歌单：/playlists/import 是「建单」语义、后端无既有歌单批量追加端点（本任务不碰 server/），
  // 维持逐首 addItem（201=新增/200=已存在），待后端补批量端点后切换
  const targetId = pick.id
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
