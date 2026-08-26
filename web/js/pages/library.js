/**
 * 本地收藏页：已下载歌曲曲库 + 下载队列（原任务页的播放器化重构）
 * - 数据层复用任务接口：GET /api/v1/tasks（SSE 增量驱动，与旧任务页一致）
 * - completed / completed_with_warnings → 歌曲行（▶ 播放 + 整行点击播放 + ✦ 单曲刮削钮）
 * - pending / active / failed / canceled → 「下载队列」次要区块（进度、状态、取消/重试/删除）
 * - player:trackchange 事件驱动当前播放行橙色发光高亮
 * - #47 scrape:update SSE → 行内刮削钮状态局部刷新 + 结果 toast（仅该行在视图内时）
 * - #52 刮削状态徽标：每首歌曲行展示 pending/running/success/failed/skipped 状态 pill
 *   （success hover 显示补全字段摘要、failed 附行内「重试」小钮 force 重刮）；
 *   scrape:update / scrape:progress SSE 局部刷新对应行，不整表重渲染。
 *   交互分工：.scrape-flag 徽标 = 纯状态展示（不可点，点击不触发播放）；
 *   .row-scrape 钮 = 手动刮削操作（原有行为不变，契约零改动）。
 * - #56 曲库排序（添加时间/标题/艺术家/时长 + 升降序方向钮，纯前端内存排序，
 *   会话级不持久化）与筛选（平台/刮削状态 chips，组内单选、组间叠加）；
 *   SSE 增量刷新后 render 自动按当前排序筛选重排。网格/列表双视图均生效。
 * - #56 列表密度三档（舒适 56 默认 / 紧凑 44 / 宽松 68）：storage.js
 *   键 libDensity 记忆（uid 前缀隔离），仅列表视图可见（网格态与窄屏由 CSS 隐藏）。
 * - #57 艺人/专辑聚合视图：纯前端按 GET /tasks 顶层 singer/album 字段聚合
 *   （实测填充率 49/51 与 51/51，无需新后端端点）。维度三段钮（歌曲/专辑/艺人，
 *   storage.js 键 libDim 记忆，窄屏保留）；聚合卡点击进入过滤态
 *   （面包屑返回 + visibleSongs 收窄到该组，播放/下载/刮削交互全保留）；
 *   未刮削歌曲（字段缺失）归入「未知专辑/未知艺人」弱化组排末尾；
 *   筛选 chips 计数随维度/drill 联动重算；SSE 刷新自动重算聚合。
 */
import { $, $$, escapeHtml, toast, statusLabel, PLATFORM_NAME, confirmModal, formatBytes } from '../ui.js'
import { api, API_BASE } from '../api.js'
import * as sse from '../sse.js'
import * as player from '../player.js'
import { store } from '../storage.js'

const tasks = new Map() // id → 任务视图
const durations = new Map() // id → 播放加载后回填的时长（秒）；后端任务记录无 duration 列，只能播过才知道
let inited = false
let reconciling = false // reconcile 拉取进行中（SSE 增量与快照存在竞态窗口）
const dirtyDuringReconcile = new Set() // fetch 期间被 SSE upsert 过的任务 id

// #52 批量刮削进度（scrape:progress SSE {done,total}；仅批量进行中非空，running 徽标展示 done/total 进度感）
let scrapeBatch = null

/* ============================================================
   #53 · P1a 网格/列表双视图（Apple Music 风格大封面网格 + 56px 契约列表）
   - 状态机：单 class body.lib-grid（CSS 作用域重排 .song-row，DOM 模板零改动，
     SSE 局部刷新选择器 .song-row[data-id] 两视图进同源生效）
   * - 记忆：storage.js 键 libView（uid 前缀隔离，缺省 grid）；≤900px 窄屏由
     matchMedia 强制网格单列（不覆盖记忆），切换控件由 CSS 媒体查询隐藏
   - 切换瞬间：#library-songs 加 .lib-switching 触发 fade+scale 240ms
     （render 重建 .song-list 不携带该态，不会被 SSE 重渲染误触发）
   ============================================================ */
const LIB_VIEW_KEY = 'libView' // storage.js 自动加 rainbow.<uid>. 前缀（v0.2.1 多账号隔离）
const NARROW_MQ = window.matchMedia('(max-width: 900px)')
let libView = 'grid'

function readLibView() {
  try {
    return store.get(LIB_VIEW_KEY) === 'list' ? 'list' : 'grid'
  } catch {
    return 'grid'
  }
}

/** 只切 body class + 分段钮态（不写记忆；窄屏强制 grid，供初始同步与 resize 复用） */
function applyLibView() {
  const eff = NARROW_MQ.matches ? 'grid' : libView
  document.body.classList.toggle('lib-grid', eff === 'grid')
  const gridBtn = $('#lib-view-grid')
  const listBtn = $('#lib-view-list')
  if (gridBtn) {
    gridBtn.classList.toggle('on', eff === 'grid')
    gridBtn.setAttribute('aria-pressed', String(eff === 'grid'))
  }
  if (listBtn) {
    listBtn.classList.toggle('on', eff === 'list')
    listBtn.setAttribute('aria-pressed', String(eff === 'list'))
  }
}

function setLibView(v) {
  if (v !== 'grid' && v !== 'list') return
  libView = v
  try {
    store.set(LIB_VIEW_KEY, v)
  } catch {
    /* 隐私模式/配额满：仅本会话内生效 */
  }
  applyLibView()
  triggerLibSwitching()
}

function initLibView() {
  libView = readLibView()
  $('#lib-view-grid')?.addEventListener('click', () => setLibView('grid'))
  $('#lib-view-list')?.addEventListener('click', () => setLibView('list'))
  // 跨断点 resize：窄屏强制 grid / 回宽屏恢复记忆态
  NARROW_MQ.addEventListener?.('change', applyLibView)
  applyLibView()
}

/* ============================================================
   #57 · 艺人/专辑聚合维度（歌曲/专辑/艺人三段钮 + 过滤态 drill）
   - 维度：storage.js 键 libDim（uid 前缀隔离，缺省 song；窄屏保留文字三段钮）
   - 过滤态（drill）：会话级不持久化，点击聚合卡进入；面包屑返回钮退出。
     进入后列表 = 该专辑/艺人的歌曲（visibleSongs 收窄，排序筛选照常叠加），
     播放全部/行点击/刮削/下载等交互全部沿用歌曲维度代码路径。
   - 未知分组：album/singer 缺失的任务归入「未知专辑/未知艺人」，弱化排末尾。
   ============================================================ */
const LIB_DIM_KEY = 'libDim' // storage.js uid 前缀
const UNKNOWN_ALBUM = '未知专辑'
const UNKNOWN_ARTIST = '未知艺人'
let libDim = 'song' // 'song' | 'album' | 'artist' | 'nas'（模块六：NAS 音乐维度）
let libDrill = null // { dim: 'album'|'artist', key } | null —— key 即分组 label

function readLibDim() {
  try {
    const v = store.get(LIB_DIM_KEY)
    return v === 'album' || v === 'artist' || v === 'nas' ? v : 'song'
  } catch {
    return 'song'
  }
}

function applyLibDim() {
  document.body.classList.toggle('lib-dim-album', libDim === 'album')
  document.body.classList.toggle('lib-dim-artist', libDim === 'artist')
  document.body.classList.toggle('lib-dim-nas', libDim === 'nas')
  for (const v of ['song', 'album', 'artist', 'nas']) {
    const btn = $(`#lib-dim-${v}`)
    if (btn) {
      btn.classList.toggle('on', libDim === v)
      btn.setAttribute('aria-pressed', String(libDim === v))
    }
  }
  // 模块六：NAS 面板显隐（nas-panel 与 library-songs 互斥；nas-* 新命名空间）
  const nasPanel = $('#nas-panel')
  if (nasPanel) nasPanel.hidden = libDim !== 'nas'
}

function initLibDim() {
  libDim = readLibDim()
  for (const v of ['song', 'album', 'artist', 'nas']) {
    $(`#lib-dim-${v}`)?.addEventListener('click', () => setLibDim(v))
  }
  $('#lib-crumb-back')?.addEventListener('click', onCrumbBack)
  $('#library-songs').addEventListener('click', onAggClick)
  applyLibDim()
}

/** 维度切换：重置 drill + 写记忆 + 切换过渡动画 + 重渲染（模块六：nas 维度额外拉取数据） */
function setLibDim(v) {
  if (v !== 'song' && v !== 'album' && v !== 'artist' && v !== 'nas') return
  if (v === libDim && !libDrill) return
  libDim = v
  libDrill = null
  document.body.classList.remove('lib-drilling')
  try {
    store.set(LIB_DIM_KEY, v)
  } catch {
    /* 隐私模式/配额满：仅本会话内生效 */
  }
  applyLibDim()
  triggerLibSwitching()
  render()
  if (v === 'nas') nasEnsure() // 模块六：进入 NAS 维度 → 拉取 roots/status/tracks
}

/** 点击聚合卡进入过滤态 */
function setDrill(dim, key) {
  if (dim !== 'album' && dim !== 'artist') return
  libDrill = { dim, key }
  document.body.classList.add('lib-drilling')
  triggerLibSwitching()
  render()
  $('.main-wrap')?.scrollTo({ top: 0, behavior: 'smooth' })
}

/** 面包屑返回：退回当前维度的聚合网格 */
function onCrumbBack() {
  libDrill = null
  document.body.classList.remove('lib-drilling')
  triggerLibSwitching()
  render()
}

/** 维度/视图切换过渡：fade+scale 240ms（复用 lib-view-in 动画） */
function triggerLibSwitching() {
  const box = $('#library-songs')
  if (!box) return
  box.classList.remove('lib-switching')
  void box.offsetWidth
  box.classList.add('lib-switching')
  setTimeout(() => box.classList.remove('lib-switching'), 300)
}

/** 聚合卡点击（事件委托；进入过滤态） */
function onAggClick(e) {
  const card = e.target.closest('.lib-agg-card')
  if (!card) return
  setDrill(card.dataset.dim, card.dataset.key)
}

/** 专辑/艺人分组键：缺失（未刮削）返回 null → 归入未知组 */
const albumKeyOf = (t) => (t.album || '').trim() || null
const artistKeyOf = (t) => (t.singer || '').trim() || null

/** drill 维度匹配（未知组 key 用占位 label 对齐） */
function drillMatch(t) {
  if (!libDrill) return true
  if (libDrill.dim === 'album') return (albumKeyOf(t) || UNKNOWN_ALBUM) === libDrill.key
  return (artistKeyOf(t) || UNKNOWN_ARTIST) === libDrill.key
}

/** 聚合候选集：completed + 平台/刮削筛选（不含 drill —— 卡片网格即 drill 的父集） */
function aggBaseSongs() {
  let songs = completedSongs()
  if (libFilterPlatform) songs = songs.filter((t) => t.platform === libFilterPlatform)
  if (libFilterScrape) songs = songs.filter((t) => (t.scrapeStatus || 'pending') === libFilterScrape)
  return songs
}

/** 维度聚合：[{key,label,count,subCount,taskIds,unknown}]；计数降序→名称，未知组恒末尾 */
function buildAggs(dim) {
  const map = new Map()
  for (const t of aggBaseSongs()) {
    const raw = dim === 'album' ? albumKeyOf(t) : artistKeyOf(t)
    const label = raw || (dim === 'album' ? UNKNOWN_ALBUM : UNKNOWN_ARTIST)
    let g = map.get(label)
    if (!g) {
      g = { key: label, label, count: 0, subCount: 0, taskIds: [], unknown: !raw, subSeen: new Set() }
      map.set(label, g)
    }
    g.count++
    g.taskIds.push(t.id) // 封面候选序：首个起依次回退（onerror 换下一个任务封面）
    const sub = dim === 'album' ? artistKeyOf(t) : albumKeyOf(t)
    if (sub && !g.subSeen.has(sub)) g.subSeen.add(sub)
    g.subCount = g.subSeen.size
  }
  const arr = [...map.values()]
  arr.sort((a, b) => {
    if (a.unknown !== b.unknown) return a.unknown ? 1 : -1
    if (b.count !== a.count) return b.count - a.count
    return a.label.localeCompare(b.label, 'zh-Hans-CN')
  })
  return arr
}

/** 聚合卡封面 onerror：依次回退组内下一个任务封面，全失败移除露出渐变位
 *  （v0.2.5：内联处理器无法引用模块变量，改为定义时内插 API_BASE 网关前缀） */
const AGG_COVER_ERR =
  `const i=this,cs=(i.dataset.cands||'').split(',').filter(Boolean);const n=+i.dataset.ci+1;if(n<cs.length){i.dataset.ci=n;i.src='${API_BASE}/api/v1/cover/'+encodeURIComponent(cs[n])}else i.remove()`

/** 艺人头像首字（中英文均可；空串安全） */
const aggInitial = (label) => Array.from(label || '?')[0] || '?'

/** 聚合卡网格渲染（#library-songs 内；独立 .lib-agg-* 命名空间，不触碰 .song-row 契约） */
function renderAggGrid() {
  const box = $('#library-songs')
  const aggs = buildAggs(libDim)
  const isArtist = libDim === 'artist'
  if (!aggs.length) {
    box.innerHTML = `<div class="empty">当前筛选条件下没有${isArtist ? '艺人' : '专辑'}——点击上方已选中的 chip 取消筛选</div>`
    return
  }
  const cards = aggs
    .map((g) => {
      const cands = g.taskIds.join(',')
      const first = encodeURIComponent(g.taskIds[0])
      const sub = isArtist
        ? `${g.count} 首${g.subCount ? ` · ${g.subCount} 张专辑` : ''}`
        : `${g.subCount ? [...g.subSeen][0] + ' · ' : ''}${g.count} 首`
      const cover = isArtist
        ? `<span class="agg-avatar" aria-hidden="true"><b>${escapeHtml(aggInitial(g.label))}</b><img src="${API_BASE}/api/v1/cover/${first}" data-cands="${escapeHtml(cands)}" data-ci="0" alt="" loading="lazy" onerror="${AGG_COVER_ERR}" /></span>`
        : `<span class="agg-cover" aria-hidden="true">
            <svg class="agg-note" viewBox="0 0 24 24" width="42" height="42"><path d="M9 18V6l10-2v11.5" stroke="currentColor" stroke-width="1.5" fill="none" stroke-linecap="round" stroke-linejoin="round"/><circle cx="6.5" cy="18" r="2.5" fill="currentColor"/><circle cx="16.5" cy="15.5" r="2.5" fill="currentColor"/></svg>
            <img src="${API_BASE}/api/v1/cover/${first}" data-cands="${escapeHtml(cands)}" data-ci="0" alt="" loading="lazy" onerror="${AGG_COVER_ERR}" />
          </span>`
      return `
        <button class="lib-agg-card${g.unknown ? ' unknown' : ''}" role="listitem" type="button" data-dim="${libDim}" data-key="${escapeHtml(g.key)}" title="查看${isArtist ? '艺人' : '专辑'}：${escapeHtml(g.label)}">
          ${cover}
          <span class="agg-body">
            <b class="agg-name">${escapeHtml(g.label)}</b>
            <small class="agg-sub">${escapeHtml(sub)}</small>
          </span>
        </button>`
    })
    .join('')
  box.innerHTML = `<div class="lib-agg-list" role="list">${cards}</div>`
}

/** 面包屑渲染（drill 态显示；文本含组名与计数） */
function renderCrumb() {
  const box = $('#lib-crumb')
  if (!box) return
  box.hidden = !libDrill
  if (!libDrill) return
  const songs = visibleSongs()
  $('#lib-crumb-txt').textContent = `${libDrill.dim === 'album' ? '专辑' : '艺人'}：${libDrill.key} · ${songs.length} 首`
}

/* ============================================================
   #56 · 列表密度三档（舒适 56 默认 / 紧凑 44 / 宽松 68）
   storage.js 键 libDensity 记忆（uid 前缀隔离）；仅列表视图生效与可见
   （网格态 body.lib-grid / 窄屏 ≤900px 由 CSS 隐藏按钮）。
   ============================================================ */
const LIB_DENSITY_KEY = 'libDensity' // storage.js uid 前缀
const DENSITIES = [
  { key: 'cozy', label: '舒适', h: 56 },
  { key: 'compact', label: '紧凑', h: 44 },
  { key: 'roomy', label: '宽松', h: 68 },
]
let libDensity = 'cozy'

function readLibDensity() {
  try {
    const v = store.get(LIB_DENSITY_KEY)
    return DENSITIES.some((d) => d.key === v) ? v : 'cozy'
  } catch {
    return 'cozy'
  }
}

function applyLibDensity() {
  for (const d of DENSITIES) document.body.classList.toggle(`lib-density-${d.key}`, libDensity === d.key)
  const cur = DENSITIES.find((d) => d.key === libDensity)
  const btn = $('#lib-density')
  if (btn && cur) {
    const txt = `列表密度：${cur.label}（${cur.h}px 行高）`
    btn.title = txt
    btn.setAttribute('aria-label', txt + '，点击切换')
  }
}

function cycleLibDensity() {
  const idx = DENSITIES.findIndex((d) => d.key === libDensity)
  libDensity = DENSITIES[(idx + 1) % DENSITIES.length].key
  try {
    store.set(LIB_DENSITY_KEY, libDensity)
  } catch {
    /* 隐私模式/配额满：仅本会话内生效 */
  }
  applyLibDensity()
}

/* ============================================================
   #56 · 排序 + 筛选（会话级，不持久化；纯前端内存计算）
   - 排序：added(默认↓) / title / artist / duration；方向钮切升降
   - 筛选：平台组单选 × 刮削状态组单选，组间 AND 叠加；再点已选 chip 取消
   - 与 SSE 协同：upsert/reconcile → render() 自动按当前状态重排
   ============================================================ */
let libSort = 'added'
let libSortDir = 'desc' // 添加时间默认降序（最新在前）
let libFilterPlatform = null
let libFilterScrape = null

/** 比较器：duration 未知的歌一律排末尾（不随方向翻转） */
function cmpSongs(a, b) {
  if (libSort === 'added') return (a.createdAt || 0) - (b.createdAt || 0)
  if (libSort === 'duration') {
    const da = durations.get(a.id)
    const db = durations.get(b.id)
    if (!Number.isFinite(da) && !Number.isFinite(db)) return 0
    if (!Number.isFinite(da)) return 1
    if (!Number.isFinite(db)) return -1
    return da - db
  }
  const field = libSort === 'title' ? 'name' : 'singer'
  const va = songMeta(a)[field] || ''
  const vb = songMeta(b)[field] || ''
  return va.localeCompare(vb, 'zh-Hans-CN')
}

/** 排序 + 筛选后的可见歌曲集（render / 播放全部 / 行点击共用同一视图；
 *  #57 drill 过滤态时收窄到该专辑/艺人的歌曲——播放/下载/刮削交互随之继承） */
function visibleSongs() {
  let songs = completedSongs()
  if (libDrill) songs = songs.filter(drillMatch)
  if (libFilterPlatform) songs = songs.filter((t) => t.platform === libFilterPlatform)
  if (libFilterScrape) songs = songs.filter((t) => (t.scrapeStatus || 'pending') === libFilterScrape)
  const dir = libSortDir === 'asc' ? 1 : -1
  return [...songs].sort((a, b) => dir * cmpSongs(a, b))
}

const SCRAPE_CHIPS = [
  { key: 'success', label: '已刮削' },
  { key: 'pending', label: '待刮削' },
  { key: 'failed', label: '失败' },
]

/** 筛选 chips 重渲染（数据驱动：平台集合来自曲库实际值，含 qdy 等非标准平台）；保留用户选中态；
 *  #57：计数基数联动当前上下文——drill 过滤态收窄到该专辑/艺人集合，
 *  平台组计数排除本组已选筛选（刮削同理），维度/过滤态切换时 chips 数字自动重算 */
function renderFilters() {
  const box = $('#lib-filters')
  if (!box) return
  const all = completedSongs()
  box.hidden = !all.length
  if (!all.length) return

  const baseFor = (exclude) => {
    let s = all
    if (libDrill) s = s.filter(drillMatch)
    if (exclude !== 'platform' && libFilterPlatform) s = s.filter((t) => t.platform === libFilterPlatform)
    if (exclude !== 'scrape' && libFilterScrape) s = s.filter((t) => (t.scrapeStatus || 'pending') === libFilterScrape)
    return s
  }
  const platBase = baseFor('platform')
  const scrapeBase = baseFor('scrape')

  // 平台集合按固定序 + 未知靠后；附计数
  const PLAT_ORDER = ['kw', 'kg', 'tx', 'wy', 'mg']
  const platCount = new Map()
  for (const t of platBase) platCount.set(t.platform, (platCount.get(t.platform) || 0) + 1)
  const platList = [...platCount.keys()].sort((a, b) => {
    const ia = PLAT_ORDER.indexOf(a)
    const ib = PLAT_ORDER.indexOf(b)
    return (ia === -1 ? 99 : ia) - (ib === -1 ? 99 : ib)
  })
  // 选中平台已从数据中消失（如删除后）→ 重置，避免隐性空结果
  if (libFilterPlatform && !platList.includes(libFilterPlatform)) libFilterPlatform = null

  const scrapeCount = new Map()
  for (const t of scrapeBase) {
    const st = t.scrapeStatus || 'pending'
    if (SCRAPE_CHIPS.some((c) => c.key === st)) scrapeCount.set(st, (scrapeCount.get(st) || 0) + 1)
  }

  const chip = (active, attrs, label, count) =>
    `<button type="button" class="lib-chip${active ? ' on' : ''}" ${attrs} aria-pressed="${active}">${escapeHtml(label)}<i>${count}</i></button>`
  let html = '<span class="lf-label">平台</span>'
  html += platList
    .map((p) => chip(libFilterPlatform === p, `data-fplat="${escapeHtml(p)}"`, PLATFORM_NAME[p] || p, platCount.get(p) || 0))
    .join('')
  html += '<span class="lf-sep" aria-hidden="true"></span><span class="lf-label">刮削</span>'
  html += SCRAPE_CHIPS.map((c) => chip(libFilterScrape === c.key, `data-fscrape="${c.key}"`, c.label, scrapeCount.get(c.key) || 0)).join('')
  box.innerHTML = html
}

function onFilterClick(e) {
  const btn = e.target.closest('button.lib-chip')
  if (!btn) return
  if (btn.dataset.fplat) libFilterPlatform = libFilterPlatform === btn.dataset.fplat ? null : btn.dataset.fplat
  else if (btn.dataset.fscrape) libFilterScrape = libFilterScrape === btn.dataset.fscrape ? null : btn.dataset.fscrape
  render()
}

function onSortChange() {
  libSort = $('#lib-sort').value || 'added'
  render()
}

function onSortDirToggle() {
  libSortDir = libSortDir === 'asc' ? 'desc' : 'asc'
  const btn = $('#lib-sort-dir')
  if (btn) {
    btn.classList.toggle('asc', libSortDir === 'asc')
    btn.title = libSortDir === 'asc' ? '升序（点击切换）' : '降序（点击切换）'
  }
  render()
}

function initLibSortFilter() {
  $('#lib-sort')?.addEventListener('change', onSortChange)
  $('#lib-sort-dir')?.addEventListener('click', onSortDirToggle)
  $('#lib-filters')?.addEventListener('click', onFilterClick)
  $('#lib-density')?.addEventListener('click', cycleLibDensity)
  libDensity = readLibDensity()
  applyLibDensity()
}

const isDone = (t) => t.status === 'completed' || t.status === 'completed_with_warnings'
const isBusy = (t) => t.status === 'pending' || t.status === 'active'

// P1：40px SVG 下载进度环周长（r=16，2πr≈100.53，与 style.css .dl-ring-fill 一致）
const RING_LEN = 100.53

/** 秒 → m:ss */
function fmtDur(sec) {
  if (!Number.isFinite(sec) || sec <= 0) return '--:--'
  const m = Math.floor(sec / 60)
  const s = Math.floor(sec % 60)
  return `${m}:${String(s).padStart(2, '0')}`
}

export function init() {
  $('#refresh-library').addEventListener('click', reconcile)
  $('#play-all').addEventListener('click', () => {
    // #56：播放全部 = 当前排序筛选后的可见集合（所见即所得）
    const q = visibleSongs()
    if (q.length) player.playQueue(q)
  })

  // SSE 订阅（全局单连接，断线自动重连）
  sse.on('connected', reconcile) // 首包/重连成功 → 全量对账
  for (const ev of ['task:created', 'task:pending', 'task:active', 'task:completed', 'task:completed_with_warnings', 'task:failed', 'task:canceled']) {
    sse.on(ev, upsert)
  }
  sse.on('task:progress', onProgress)
  sse.on('sse:state', (st) => {
    const dot = $('#sse-dot')
    if (!dot) return
    dot.dataset.state = st
    dot.title = st === 'online' ? '实时连接正常' : '实时连接断开，自动重连中…'
  })

  // 歌曲行：▶ 按钮或整行点击 → 播放；队列行：取消/重试/删除
  $('#library-songs').addEventListener('click', onSongClick)
  $('#library-queue-list').addEventListener('click', onQueueAction)

  // #47 单曲刮削结果：行内按钮态局部刷新 + toast（仅该行在视图内时；设置页另有独立监听）
  sse.on('scrape:update', onScrapeUpdate)
  // #52 批量刮削进度：running 徽标追加 done/total 文案（局部更新，免整表重渲染）
  sse.on('scrape:progress', onScrapeProgress)

  // #53 网格/列表双视图：分段控件 + 记忆 + 窄屏强制（默认网格）
  initLibView()

  // #57 艺人/专辑聚合维度：三段钮 + drill 面包屑返回 + 聚合卡点击委托
  initLibDim()

  // #56 排序 / 筛选 / 密度三档（会话级排序筛选 + localStorage 密度记忆）
  initLibSortFilter()

  // 播放器联动：当前曲目变化 → 高亮对应歌曲行；音频元数据就绪 → 回填该行时长
  document.addEventListener('player:trackchange', (e) => highlightNowPlaying(e.detail?.taskId ?? null))
  document.addEventListener('player:metadata', (e) => {
    const { taskId, duration } = e.detail || {}
    if (!taskId || !Number.isFinite(duration) || duration <= 0) return
    durations.set(taskId, duration)
    const cell = document.querySelector(`#library-songs .song-row[data-id="${CSS.escape(taskId)}"] .song-dur`)
    if (cell) cell.textContent = fmtDur(duration)
    // 模块六：NAS 行时长回填（durationMs 后端可缺，播放后此处补齐）
    const nasCell = document.querySelector(`#nas-tracks .nas-row[data-id="${CSS.escape(taskId)}"] .nas-dur`)
    if (nasCell) nasCell.textContent = fmtDur(duration)
  })

  // v0.2.1 模块六：NAS 音乐面板（搜索/刷新/加载更多/行点击播放 + SSE 扫描进度）
  initNas()

  inited = true
}

/** 每次切到本页：全量对账一次（含首次进入）；模块六：NAS 维度同步兑底扫描状态 */
export function show() {
  reconcile()
  if (libDim === 'nas') nasEnsure()
  highlightNowPlaying(player.currentTask())
}

function upsert(view) {
  if (!view || !view.id) return
  if (reconciling) dirtyDuringReconcile.add(view.id)
  tasks.set(view.id, view)
  if (inited) render()
}

/** 进度事件：只改对应队列行的进度条与文字，避免整表重渲染抖动 */
function onProgress(p) {
  if (!p || !p.id) return
  const t = tasks.get(p.id)
  if (t) {
    t.progress = p.percent
    t.received = p.received
    t.total = p.total
  }
  const row = document.querySelector(`#library-queue-list .queue-row[data-id="${p.id}"]`)
  if (!row) return
  // P1：进度环增量更新（细条已被环替换）；百分比文字同步
  const ringFill = row.querySelector('.dl-ring-fill')
  if (ringFill) ringFill.style.strokeDashoffset = String(RING_LEN * (1 - (p.percent || 0) / 100))
  const ringPct = row.querySelector('.dl-ring-pct')
  if (ringPct) ringPct.textContent = `${p.percent || 0}%`
  const txt = row.querySelector('.progress-txt')
  if (txt) txt.textContent = progressText(t, p.percent)
}

async function reconcile() {
  // 合并策略（而非 tasks.clear() 整体覆盖）：
  // fetch 期间被 SSE upsert 过的任务按 updatedAt 保留较新状态，
  // fetch 期间新建的任务（快照里没有）也一并保留
  reconciling = true
  dirtyDuringReconcile.clear()
  try {
    const r = await api.tasks.list()
    const snapshot = r.tasks || []
    const merged = new Map(snapshot.map((t) => [t.id, t]))
    for (const id of dirtyDuringReconcile) {
      const live = tasks.get(id)
      if (!live) continue
      const snap = merged.get(id)
      if (!snap) {
        merged.set(id, live) // fetch 期间新建的任务，快照缺失 → 保留增量
      } else if ((live.updatedAt || 0) > (snap.updatedAt || 0)) {
        merged.set(id, live) // 增量事件更新 → 保留较新状态
      }
    }
    tasks.clear()
    for (const [id, t] of merged) tasks.set(id, t)
    render()
  } catch (err) {
    $('#library-songs').innerHTML = `<div class="empty">加载失败: ${escapeHtml(err.message)}</div>`
    $('#library-queue').hidden = true
  } finally {
    reconciling = false
    dirtyDuringReconcile.clear()
  }
}

/** #73 歌曲行 hover title：完整文件路径前缀「文件：…\n」+ 原有「点击播放」；
 * 仅 done 行渲染（曲库歌曲行均为 done；filePath 缺失时回退原文案，详情/播放不微弹层，改动最小化） */
function songRowTitle(t) {
  return t.filePath ? `文件：${t.filePath}\n点击播放` : '点击播放'
}

/** 播放队列 = 全部 completed 歌曲（完成时间倒序，与列表展示一致） */
function completedSongs() {
  return [...tasks.values()].filter(isDone).sort((a, b) => (b.completedAt || b.updatedAt || 0) - (a.completedAt || a.updatedAt || 0))
}

function progressText(t, percentOverride) {
  const pct = percentOverride ?? t.progress ?? 0
  const size = t.received && t.total ? ` ${formatBytes(t.received)}/${formatBytes(t.total)}` : ''
  return `${pct}%${size}`
}

/** 音质/来源 pill 组 */
function qualityBadges(t) {
  const q = t.actualQuality || t.requestedQuality || ''
  let html = q ? `<span class="badge q">${escapeHtml(q)}</span>` : ''
  if (t.actualSource) html += `<span class="badge">${escapeHtml(t.actualSource)}</span>`
  return html
}

/** 歌名/歌手（缺失时回退解析文件名） */
function songMeta(t) {
  let name = t.name || ''
  let singer = t.singer || ''
  if (!name && t.filePath) {
    const base = String(t.filePath).split('/').pop().replace(/\.[^.]+$/, '')
    const at = base.indexOf(' - ')
    if (at > 0) {
      name = base.slice(0, at)
      singer = base.slice(at + 3)
    } else {
      name = base
    }
  }
  return { name: name || '未知曲目', singer }
}

/* ============================================================
   #52 · 刮削状态徽标（scrape-flag）
   pending 灰 / running 橙脉冲（批量中带 done/total）/ success 绿勾（title 摘要）
   / failed 红（title 错误 + 行内 .scrape-retry 强制重刮钮）/ skipped 灰
   ============================================================ */
const SCRAPE_LABEL = { pending: '待刮削', running: '刮削中', success: '已刮削', failed: '失败', skipped: '跳过' }

/** scrapeInfo → 徽标 title 摘要（原生 title 多行 tooltip；项目惯例同 .song-warn/.row-scrape） */
function scrapeFlagTitle(t) {
  const st = t.scrapeStatus || 'pending'
  const info = t.scrapeInfo || {}
  if (st === 'success') {
    const f = Array.isArray(info.fieldsWritten) && info.fieldsWritten.length ? info.fieldsWritten.join(' / ') : '无新增字段（已齐）'
    const when = info.scrapedAt ? new Date(info.scrapedAt).toLocaleString() : ''
    return `已刮削\n补全字段: ${f}${info.source ? `\n来源: ${info.source}` : ''}${when ? `\n时间: ${when}` : ''}`
  }
  if (st === 'failed') return `刮削失败${info.error ? `：${info.error}` : ''}\n点「重试」强制重新刮削`
  if (st === 'skipped') return `刮削跳过${info.error ? `：${info.error}` : ''}`
  if (st === 'running') return '正在刮削元数据…'
  return '待刮削：完成后自动补全年份/曲目号/流派等标签'
}

/** 徽标 HTML（render 模板与 SSE 局部刷新共用同一生成器，保证两处结构一致） */
function scrapeFlagHtml(t) {
  const st = t.scrapeStatus || 'pending'
  const label = SCRAPE_LABEL[st] || st
  const batchTxt = st === 'running' && scrapeBatch ? ` ${scrapeBatch.done}/${scrapeBatch.total}` : ''
  const icon =
    st === 'success'
      ? '<svg viewBox="0 0 12 12" width="10" height="10" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M2 6.5l2.6 2.6L10 3.5"/></svg>'
      : '<i class="sf-dot" aria-hidden="true"></i>'
  return `<span class="scrape-flag" data-flag="${escapeHtml(t.id)}" data-st="${escapeHtml(st)}" title="${escapeHtml(scrapeFlagTitle(t))}">${icon}<span class="sf-txt">${label}${escapeHtml(batchTxt)}</span></span>`
}

/** SSE 增量刷新对应行：替换徽标 + 增删 failed 行的重试钮（不整表重渲染） */
function updateRowScrape(view) {
  const row = document.querySelector(`#library-songs .song-row[data-id="${CSS.escape(view.id)}"]`)
  if (!row) return false
  const flag = row.querySelector('.scrape-flag')
  if (flag) flag.outerHTML = scrapeFlagHtml(view)
  const retry = row.querySelector('.scrape-retry')
  if (view.scrapeStatus === 'failed') {
    if (!retry) {
      const btn = document.createElement('button')
      btn.type = 'button'
      btn.className = 'scrape-retry'
      btn.dataset.retry = view.id
      btn.title = '强制重新刮削（force）'
      btn.textContent = '重试'
      row.querySelector('.scrape-flag')?.after(btn)
    }
  } else if (retry) {
    retry.remove()
  }
  return true
}

function render() {
  // v0.2.1 模块六：NAS 维度 → 专属面板渲染（歌曲/专辑/艺人三维度管线零改动；
  // SSE task 事件驱动的 render 在 NAS 维度下幂等重绘 NAS 面板，无副作用）
  if (libDim === 'nas') {
    renderNas()
    return
  }
  const songs = visibleSongs() // #56：排序 + 筛选后的可见集合（#57 drill 态已收窄）
  const queue = [...tasks.values()].filter((t) => !isDone(t))

  // #56：筛选 chips 随数据重算（保留用户选中态；#57 drill 态计数联动）
  renderFilters()

  // #57：面包屑（drill 过滤态）
  renderCrumb()

  // ---- 曲库区（#57：聚合维度非 drill 态 → 聚合卡网格；否则歌曲列表照旧） ----
  const aggMode = libDim !== 'song' && !libDrill
  if (aggMode) {
    const aggs = buildAggs(libDim)
    $('#library-summary').textContent = aggs.length
      ? `${aggs.length} 个${libDim === 'album' ? '专辑' : '艺人'} · ${aggBaseSongs().length} 首`
      : ''
    $('#play-all').disabled = true
    renderAggGrid()
  } else {
    $('#library-summary').textContent = songs.length ? `${songs.length} 首已入库` : ''
    $('#play-all').disabled = !songs.length
    const box = $('#library-songs')
    if (!songs.length) {
      // 区分「曲库为空」与「筛选后为空」：后者提示当前筛选条件
      const filtered = completedSongs().length > 0
      box.innerHTML = filtered
        ? `<div class="empty">当前筛选条件下没有歌曲（共 ${completedSongs().length} 首已入库）——点击上方已选中的 chip 取消筛选</div>`
        : `<div class="empty lib-empty">
      <div class="lib-empty-icon" aria-hidden="true">
        <svg viewBox="0 0 24 24" width="30" height="30"><path d="M9 18V6l10-2v11.5" stroke="currentColor" stroke-width="1.5" fill="none" stroke-linecap="round" stroke-linejoin="round"/><circle cx="6.5" cy="18" r="2.5" fill="currentColor"/><circle cx="16.5" cy="15.5" r="2.5" fill="currentColor"/></svg>
      </div>
      <p>本地还没有歌曲</p>
      <p class="lib-empty-sub">去「发现」搜索并下载，完成后会出现在这里</p>
    </div>`
    } else {
      box.innerHTML = `<div class="song-list" role="list">${songs
        .map((t) => {
        const { name, singer } = songMeta(t)
        const plat = PLATFORM_NAME[t.platform] || t.platform || ''
        const warn = t.warnings && t.warnings.length ? `<span class="song-warn" title="${escapeHtml(t.warnings.join('；'))}">⚠ ${t.warnings.length}</span>` : ''
        return `
      <div class="song-row" role="listitem" data-id="${escapeHtml(t.id)}" tabindex="0" title="${escapeHtml(songRowTitle(t))}">
        <div class="song-cover" aria-hidden="true">
          <img class="cover-img" src="${API_BASE}/api/v1/cover/${encodeURIComponent(t.id)}" alt="" loading="lazy" onerror="this.remove()" />
          <svg class="song-note" viewBox="0 0 24 24" width="18" height="18"><path d="M9 18V6l10-2v11.5" stroke="currentColor" stroke-width="1.6" fill="none" stroke-linecap="round" stroke-linejoin="round"/><circle cx="6.5" cy="18" r="2.5" fill="currentColor"/><circle cx="16.5" cy="15.5" r="2.5" fill="currentColor"/></svg>
          <span class="song-eq" aria-hidden="true"><i></i><i></i><i></i></span>
          <button class="song-play" data-act="play" data-id="${escapeHtml(t.id)}" type="button" aria-label="播放 ${escapeHtml(name)}">
            <svg viewBox="0 0 10 12" width="10" height="12" fill="currentColor" aria-hidden="true"><path d="M0 0l10 6-10 6z"/></svg>
          </button>
        </div>
        <div class="song-info">
          <div class="song-name">${escapeHtml(name)} ${warn}</div>
          <div class="song-artist">${escapeHtml(singer || '未知艺术家')}</div>
        </div>
        <div class="song-right">
          ${scrapeFlagHtml(t)}
          ${t.scrapeStatus === 'failed' ? `<button class="scrape-retry" data-retry="${escapeHtml(t.id)}" type="button" title="强制重新刮削（force）">重试</button>` : ''}
          <button class="row-scrape${t.scrapeStatus === 'success' ? ' done' : ''}" data-scrape="${escapeHtml(t.id)}" type="button"
            aria-label="刮削 ${escapeHtml(name)} 的元数据" title="${t.scrapeStatus === 'success' ? '已刮削过（重刮请在设置页强制）' : '刮削这首：补全年份/曲目号/流派/专辑艺术家等标签'}">
            <svg viewBox="0 0 12 12" width="11" height="11" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M1.5 1.5h4.2l4.8 4.8a1.2 1.2 0 0 1 0 1.7l-2.5 2.5a1.2 1.2 0 0 1-1.7 0L1.5 5.7v-4.2z"/><circle cx="4" cy="4" r="0.9" fill="currentColor" stroke="none"/></svg>
          </button>
          <span class="song-dur" title="播放后自动回填">${fmtDur(durations.get(t.id))}</span>
          ${qualityBadges(t)}
          ${plat ? `<span class="song-plat">${escapeHtml(plat)}</span>` : ''}
        </div>
      </div>`
        })
        .join('')}</div>`
    }
  }

  // ---- 下载队列区（进行中/失败的次要区块） ----
  const qBox = $('#library-queue')
  if (!queue.length) {
    qBox.hidden = true
  } else {
    qBox.hidden = false
    const busy = queue.filter(isBusy).length
    const bad = queue.length - busy
    $('#queue-summary').textContent = `进行中 ${busy}${bad ? ` · 失败/取消 ${bad}` : ''}`
    $('#library-queue-list').innerHTML = queue
      .map((t) => {
        const { name, singer } = songMeta(t)
        const pct = t.progress || 0
        // P1：进度环状态色（失败红 / 取消灰 / 进行中橙）
        const ringState = t.status === 'failed' ? ' failed' : t.status === 'canceled' ? ' canceled' : ''
        let acts = ''
        if (isBusy(t)) acts += `<button data-act="cancel" data-id="${escapeHtml(t.id)}">取消</button>`
        if (t.status === 'failed' || t.status === 'canceled' || t.status === 'completed_with_warnings') {
          acts += `<button data-act="retry" data-id="${escapeHtml(t.id)}">重试</button>`
        }
        acts += `<button data-act="del" data-id="${escapeHtml(t.id)}" class="danger-lite">删除</button>`
        return `
      <div class="queue-row" data-id="${escapeHtml(t.id)}">
        <div class="dl-ring${ringState}" title="${statusLabel(t.status)} ${pct}%" aria-hidden="true">
          <svg viewBox="0 0 40 40" width="40" height="40">
            <circle class="dl-ring-track" cx="20" cy="20" r="16" />
            <circle class="dl-ring-fill" cx="20" cy="20" r="16" style="stroke-dashoffset:${(RING_LEN * (1 - pct / 100)).toFixed(2)}" />
          </svg>
          <span class="dl-ring-pct">${pct}%</span>
        </div>
        <div class="queue-info">
          <div class="queue-name">${escapeHtml(name)} <span class="queue-artist">${escapeHtml(singer)}</span></div>
          <div class="queue-sub">
            <span class="st ${escapeHtml(t.status)}">${statusLabel(t.status)}</span>
            <span class="progress-txt">${progressText(t, pct)}</span>
          </div>
          ${t.error ? `<div class="queue-err" title="${escapeHtml(t.error)}">${escapeHtml(t.error)}</div>` : ''}
        </div>
        <div class="queue-act">${acts}</div>
      </div>`
      })
      .join('')
  }

  highlightNowPlaying(player.currentTask())
}

/**
 * 整行/▶ 点击：以全部 completed 歌曲为队列，从该首开始播放；
 * #47 ✦ 刮削钮优先拦截（不触发播放，普通点击不带 force）；
 * #52 .scrape-retry 重试钮 / .scrape-flag 徽标点击同样不触发播放
 */
function onSongClick(e) {
  const scrapeBtn = e.target.closest('.row-scrape')
  if (scrapeBtn) {
    void onScrapeAction(scrapeBtn.dataset.scrape, scrapeBtn)
    return
  }
  const retryBtn = e.target.closest('.scrape-retry')
  if (retryBtn) {
    void onScrapeRetry(retryBtn.dataset.retry, retryBtn)
    return
  }
  if (e.target.closest('.scrape-flag')) return // 状态徽标纯展示：吞掉点击，不冒泡成播放
  const row = e.target.closest('.song-row')
  if (!row) return
  // #56：行点击播放队列 = 当前排序筛选后的可见集合（与所见一致）
  const q = visibleSongs()
  if (!q.length) return
  player.playQueue(q, row.dataset.id)
}

/** #47 单曲刮削：409 already scraped 时提示而不静默重刮（重刮走设置页强制） */
async function onScrapeAction(id, btn) {
  if (!id) return
  if (btn) btn.classList.add('busy')
  try {
    await api.scrape.task(id)
    toast('已加入刮削队列，完成后在此提示')
  } catch (err) {
    if (btn) btn.classList.remove('busy')
    if (err.status === 409 && /already scraped/i.test(String((err.data && err.data.error) || err.message))) {
      toast('已刮削过，未重复刮削（重刮请在设置页强制）', 3600)
    } else {
      toast(err.message)
    }
  }
}

/** #52 failed 行「重试」：POST scrape?force=true 强制重刮；乐观置 running，后续状态由 SSE 接管 */
async function onScrapeRetry(id, btn) {
  if (!id) return
  if (btn) btn.disabled = true
  try {
    await api.scrape.task(id, true)
    const t = tasks.get(id)
    if (t) t.scrapeStatus = 'running'
    updateRowScrape({ id, scrapeStatus: 'running', scrapeInfo: t ? t.scrapeInfo : {} })
    toast('已重新加入刮削队列（强制）')
  } catch (err) {
    toast(err.message)
    if (btn) btn.disabled = false
  }
}

/** #52 SSE scrape:progress → 批量进度感：running 徽标文字追加 done/total（局部更新，免整表重渲染） */
function onScrapeProgress(d) {
  if (!d || !d.total) {
    scrapeBatch = null
    return
  }
  scrapeBatch = { done: d.done, total: d.total }
  $$('#library-songs .scrape-flag[data-st="running"]').forEach((f) => {
    const txt = f.querySelector('.sf-txt')
    if (txt) txt.textContent = `刮削中 ${d.done}/${d.total}`
  })
  if (d.done >= d.total) scrapeBatch = null // 批次结束：此后新入队的 running 回归默认文案
}

/** #47/#52 SSE scrape:update → 行内刮削钮 + 状态徽标局部刷新（免整表重渲染）；行在视图内时 toast 结果 */
function onScrapeUpdate(d) {
  if (!d || !d.taskId) return
  const t = tasks.get(d.taskId)
  // SSE 只带增字段：与既有 scrapeInfo 浅合并（成功补 scrapedAt；完整快照由下次 reconcile 兑底）
  const merged = { ...(t && t.scrapeInfo) || {}, ...pickScrapeInfo(d) }
  if (d.status === 'success' && !merged.scrapedAt) merged.scrapedAt = Date.now()
  if (t) {
    t.scrapeStatus = d.status
    t.scrapeInfo = merged
  }
  // 徽标 + failed 重试钮局部刷新（行不在视图内时静默，设置页仍有独立结果记录）
  updateRowScrape({ id: d.taskId, scrapeStatus: d.status, scrapeInfo: merged })
  const btn = document.querySelector(`#library-songs .song-row[data-id="${CSS.escape(d.taskId)}"] .row-scrape`)
  if (!btn) return
  btn.classList.toggle('done', d.status === 'success')
  btn.classList.toggle('busy', d.status === 'running')
  if (d.status === 'success') {
    const f = (d.fieldsWritten || []).join(' / ')
    toast(`✦ ${t ? songMeta(t).name : '歌曲'} 刮削完成：${f || '无新增字段（已齐）'}${d.mbFallback === 'hit' ? ' · MB兜底命中' : ''}`, 3600)
  } else if (d.status === 'failed') {
    toast(`刮削失败：${d.error || '未知错误'}`, 3600)
  } else if (d.status === 'skipped') {
    toast(`刮削跳过：${d.error || '未定位到歌曲'}`, 3600)
  }
}

/** #52 SSE scrape:update 负载里的刮削信息字段（其余 taskId/status 属任务层） */
function pickScrapeInfo(d) {
  const out = {}
  for (const k of ['attempt', 'attempts', 'error', 'warnings', 'fieldsWritten', 'source', 'degraded', 'mbFallback']) {
    if (d[k] !== undefined) out[k] = d[k]
  }
  return out
}

async function onQueueAction(e) {
  const btn = e.target.closest('button[data-act]')
  if (!btn) return
  const { act, id } = btn.dataset
  try {
    if (act === 'cancel') {
      await api.tasks.cancel(id)
      toast('已取消')
    } else if (act === 'retry') {
      await api.tasks.retry(id)
      toast('已重新入队')
    } else if (act === 'del') {
      const ok = await confirmModal('删除该任务记录？已下载完成的文件不受影响。', { danger: true, okLabel: '删除' })
      if (!ok) return
      await api.tasks.remove(id)
      tasks.delete(id)
      toast('已删除')
    }
    render()
  } catch (err) {
    toast(err.message)
  }
}

/** 当前播放歌曲橙色发光高亮（模块六：同步覆盖 NAS 行） */
function highlightNowPlaying(taskId) {
  $$('#library-songs .song-row').forEach((row) => {
    row.classList.toggle('now-playing', !!taskId && row.dataset.id === taskId)
  })
  $$('#nas-tracks .nas-row').forEach((row) => {
    row.classList.toggle('now-playing', !!taskId && row.dataset.id === taskId)
  })
}

/* ============================================================
   v0.2.1 模块六 · NAS 音乐（lib-dim-nas 维度专属面板，nas-* 新命名空间）
   - 数据：GET /api/v1/me/scan-roots（available/selected）+ GET /api/v1/library/
     tracks（limit 100 分页 + q 搜索）+ POST /api/v1/library/scan（202/无根 400/
     扫描中 409）+ SSE scan:progress（phase walk|meta|done + scanned/total +
     added/updated/removed + currentRoot；SSE 按 uid 过滤，前端无需处理 uid）
   - 空态：扫描根配置卡（available 多选 + 保存 PUT scan-roots + 开始扫描）；
     本地开发环境 RO_SCAN_ROOTS 默认 /app/data/downloads 在 Mac 不存在——扫描后
     tracks 可能为空，优雅呈现引导文案，不报错不白屏
   - 播放：行点击构造 player 兼容曲目标（id='nas:<trackId>' 命名空间避免与
     任务 id 冲突；kind='nas' 附 playUrl=stream / coverUrl=cover 端点，
     player.loadAt 直接以 playUrl 作音频源；服务端历史 POST /api/v1/me/history
     由 player.reportHistory 30s 节流上报，与 recent 记录同时机）
   - 局部刷新：SSE 进度仅更新进度条 DOM（不重建配置卡，避免打断勾选）；
     扫描完成（phase=done）重拉 roots + tracks
   ============================================================ */
const NAS_PAGE_SIZE = 100
const NAS_SEARCH_DEBOUNCE = 350

const nasState = {
  roots: null, // {available:[], selected:[{path,enabled}]} | null（未加载）
  rootsSaving: false,
  scanning: false,
  progress: null, // {phase, scanned, total, added, updated, removed, currentRoot}
  tracks: [],
  total: 0,
  offset: 0,
  q: '',
  loading: false, // tracks 拉取进行中（分页/竞态守卫）
  loaded: false, // 首次加载完成（之后刷新走显式动作）
  err: null,
}
let nasSearchTimer = 0

/** NAS 曲目 → player 兼容队列条目（id 命名空间 nas: 避免与任务 id 冲突） */
function nasTrackToPlayer(t) {
  const tid = String(t.id)
  return {
    id: `nas:${tid}`,
    kind: 'nas',
    name: t.title || '',
    singer: t.artist || '',
    album: t.album || '',
    platform: 'nas',
    // v0.2.5：stream/cover 地址经 API_BASE 拼网关前缀（iframe 入口下可达）
    playUrl: `${API_BASE}/api/v1/library/tracks/${encodeURIComponent(tid)}/stream`,
    coverUrl: `${API_BASE}/api/v1/library/tracks/${encodeURIComponent(tid)}/cover`,
  }
}

/** 进入 NAS 维度：拉 roots + 扫描状态（轻量），tracks 首次未加载时拉 */
async function nasEnsure() {
  await Promise.all([nasLoadRoots(), nasLoadStatus()])
  renderNas()
  if (!nasState.loaded) await nasLoadTracks(true)
}

async function nasLoadRoots() {
  try {
    nasState.roots = await api.me.scanRoots()
    if (!nasState.err || !nasState.tracks.length) nasState.err = null
  } catch (err) {
    nasState.roots = null
    nasState.err = err
  }
}

async function nasLoadStatus() {
  try {
    const st = await api.library.scanStatus()
    nasState.scanning = !!st.scanning
    nasState.progress = st.progress || null
  } catch {
    /* 旧后端无此端点：静默，进度条不展示 */
    nasState.scanning = false
    nasState.progress = null
  }
}

/** 拉曲目列表（reset=true 重置分页；搜索词变化/刷新/扫描完成走 reset） */
async function nasLoadTracks(reset) {
  if (nasState.loading) return
  if (reset) {
    nasState.offset = 0
    nasState.tracks = []
  }
  nasState.loading = true
  renderNasTracks()
  try {
    const r = await api.library.tracks({
      limit: NAS_PAGE_SIZE,
      offset: nasState.offset,
      q: nasState.q || undefined,
    })
    const list = r.tracks || []
    nasState.tracks = reset ? list : [...nasState.tracks, ...list]
    nasState.total = r.total ?? nasState.tracks.length
    nasState.offset += list.length
    nasState.loaded = true
    nasState.err = null
  } catch (err) {
    nasState.err = err
  } finally {
    nasState.loading = false
    renderNas()
  }
}

/** NAS 面板渲染（幂等；数据未就绪时渲染骨架） */
function renderNas() {
  if (libDim !== 'nas') return
  const panel = $('#nas-panel')
  if (!panel) return
  panel.hidden = false

  nasUpdateProgress()
  const search = $('#nas-search')
  if (search) {
    search.disabled = nasState.scanning
    if (search.value !== nasState.q) search.value = nasState.q
  }
  const sum = $('#nas-summary')
  if (sum) {
    sum.textContent = nasState.scanning
      ? '扫描进行中…'
      : nasState.loaded
        ? nasState.total
          ? `NAS 曲库 ${nasState.total} 首`
          : ''
        : ''
  }

  renderNasRoots()
  renderNasTracks()
}

/** 进度条局部更新（SSE 驱动；不动配置卡避免打断勾选） */
function nasUpdateProgress() {
  const prog = $('#nas-progress')
  if (!prog) return
  if (!nasState.scanning) {
    prog.hidden = true
    return
  }
  prog.hidden = false
  const p = nasState.progress
  const label = $('#nas-progress-label')
  if (label) {
    label.textContent = p?.phase === 'meta' ? '正在读取元数据…' : p?.phase === 'done' ? '扫描收尾…' : '正在遍历目录…'
  }
  const cnt = $('#nas-progress-count')
  if (cnt) cnt.textContent = p ? (p.total ? `${p.scanned ?? 0} / ${p.total}` : `${p.scanned ?? 0}`) : ''
  const pct = p && p.total ? Math.min(100, Math.round(((p.scanned || 0) / p.total) * 100)) : 0
  const fill = $('#nas-progress-fill')
  if (fill) fill.style.width = `${pct}%`
  prog.setAttribute('aria-valuenow', String(pct))
  const stats = []
  if (p) {
    if (p.added) stats.push(`新增 ${p.added}`)
    if (p.updated) stats.push(`更新 ${p.updated}`)
    if (p.removed) stats.push(`移除 ${p.removed}`)
    if (p.currentRoot) stats.push(`当前 ${p.currentRoot}`)
  }
  const st = $('#nas-progress-stats')
  if (st) st.textContent = stats.join(' · ')
  // 扫描中禁用扫描钮（局部更新，配置卡不重建）
  const scanBtn = $('#nas-scan')
  if (scanBtn) {
    scanBtn.disabled = true
    scanBtn.textContent = '扫描中…'
  }
}

/** 扫描根配置卡（毛玻璃卡 + available 多选 + 保存/扫描双钮） */
function renderNasRoots() {
  const box = $('#nas-roots')
  if (!box) return
  const roots = nasState.roots
  if (!roots) {
    // 未就绪：骨架卡（复用 hp-sk 扫光体系）
    box.innerHTML = `
      <div class="nas-card nas-roots-sk" aria-hidden="true">
        <div class="hp-sk nas-sk-title"></div>
        <div class="hp-sk hp-sk-line w70"></div>
        <div class="nas-roots-list">
          <div class="hp-sk nas-sk-root"></div>
          <div class="hp-sk nas-sk-root"></div>
        </div>
        <div class="nas-card-acts"><div class="hp-sk nas-sk-cta"></div><div class="hp-sk nas-sk-cta"></div></div>
      </div>`
    return
  }
  const selectedPaths = new Set((roots.selected || []).filter((s) => s && s.enabled !== false).map((s) => s.path))
  const avail = roots.available || []
  box.innerHTML = `
    <div class="nas-card">
      <div class="nas-card-head">
        <h3 class="nas-card-title">扫描目录</h3>
        <p class="nas-card-sub">选择要纳入 NAS 曲库的音乐目录（可多选，保存后生效）</p>
      </div>
      ${avail.length
        ? `<div class="nas-roots-list">${avail
            .map(
              (p) => `
        <label class="nas-root-item${selectedPaths.has(p) ? ' on' : ''}">
          <input type="checkbox" value="${escapeHtml(p)}"${selectedPaths.has(p) ? ' checked' : ''} />
          <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 7V5.5A1.5 1.5 0 0 1 4.5 4h4l2 2.5h7A1.5 1.5 0 0 1 19 8v1"/><path d="M3 9h17.2a1 1 0 0 1 .98 1.2l-1.5 7A1.6 1.6 0 0 1 18.1 18.4H5.4a1.6 1.6 0 0 1-1.57-1.28L2.2 10.2A1 1 0 0 1 3 9z"/></svg>
          <span class="nas-root-path" title="${escapeHtml(p)}">${escapeHtml(p)}</span>
          ${selectedPaths.has(p) ? '<span class="nas-root-tag">已选</span>' : ''}
        </label>`,
            )
            .join('')}</div>`
        : '<p class="nas-roots-none">服务端未配置可用扫描目录（RO_SCAN_ROOTS）</p>'}
      <div class="nas-card-acts">
        <button id="nas-save-roots" type="button"${nasState.rootsSaving ? ' disabled' : ''}>${nasState.rootsSaving ? '保存中…' : '保存目录'}</button>
        <button id="nas-scan" type="button" class="nas-btn-primary"${nasState.scanning ? ' disabled' : ''}>${nasState.scanning ? '扫描中…' : '开始扫描'}</button>
      </div>
    </div>`
  $('#nas-save-roots')?.addEventListener('click', nasSaveRoots)
  $('#nas-scan')?.addEventListener('click', nasStartScan)
}

/** 保存扫描根：PUT scan-roots（越界路径 400 → toast 提示） */
async function nasSaveRoots() {
  const checked = $$('#nas-roots input[type="checkbox"]:checked').map((i) => i.value)
  nasState.rootsSaving = true
  const btn = $('#nas-save-roots')
  if (btn) {
    btn.disabled = true
    btn.textContent = '保存中…'
  }
  try {
    await api.me.setScanRoots(checked)
    await nasLoadRoots()
    toast('扫描目录已保存')
  } catch (err) {
    toast(err.status === 400 ? `保存失败：目录不在服务端可用列表内（${err.message}）` : `保存失败：${err.message}`)
  } finally {
    nasState.rootsSaving = false
    renderNasRoots()
  }
}

/** 开始扫描：先同步未保存勾选（PUT 幂等）再 POST scan；400 无根 / 409 已在扫描 */
async function nasStartScan() {
  const checked = $$('#nas-roots input[type="checkbox"]:checked').map((i) => i.value)
  const btn = $('#nas-scan')
  try {
    // 勾选与已保存 selected 不一致时先落盘（用户「勾完直接扫」的直觉路径）
    const cur = new Set((nasState.roots?.selected || []).filter((s) => s && s.enabled !== false).map((s) => s.path))
    const same = checked.length === cur.size && checked.every((p) => cur.has(p))
    if (checked.length && !same) await api.me.setScanRoots(checked)

    await api.library.scan()
    toast('已开始扫描 NAS 音乐目录')
    nasState.scanning = true
    nasState.progress = null
    if (btn) {
      btn.disabled = true
      btn.textContent = '扫描中…'
    }
    nasUpdateProgress()
  } catch (err) {
    if (err.status === 400) toast('请先勾选至少一个扫描目录并保存')
    else if (err.status === 409) {
      toast('扫描正在进行中，请稍候')
      nasState.scanning = true
      nasUpdateProgress()
    } else {
      toast(`扫描启动失败：${err.message}`)
    }
    if (btn && !nasState.scanning) {
      btn.disabled = false
      btn.textContent = '开始扫描'
    }
  }
}

/** SSE scan:progress（全局单连接；扫描完成重拉数据，进行中仅局部更新进度条） */
function onNasScanProgress(d) {
  if (!d) return
  nasState.progress = d
  const done = d.phase === 'done' || (d.total > 0 && (d.scanned || 0) >= d.total)
  if (done && nasState.scanning) {
    nasState.scanning = false
    const summary = `NAS 扫描完成：新增 ${d.added ?? 0} · 更新 ${d.updated ?? 0} · 移除 ${d.removed ?? 0}`
    toast(summary, 4200)
    if (libDim === 'nas') {
      renderNas()
      nasLoadRoots().then(renderNasRoots)
      nasLoadTracks(true)
    }
    return
  }
  if (!done) nasState.scanning = true
  if (libDim === 'nas') nasUpdateProgress()
}

/** NAS 行 HTML（封面 404 → onerror 移除 img 露出渐变占位；点击整行播放） */
function nasRowHtml(t) {
  const tid = String(t.id)
  const pid = `nas:${tid}`
  const dur = t.durationMs ? fmtDur(t.durationMs / 1000) : '--:--'
  const fmt = String(t.format || '').toUpperCase()
  return `
  <div class="nas-row" role="listitem" data-id="${escapeHtml(pid)}" tabindex="0" title="点击播放">
    <div class="nas-cover" aria-hidden="true">
      <img src="${API_BASE}/api/v1/library/tracks/${encodeURIComponent(tid)}/cover" alt="" loading="lazy" onerror="this.remove()" />
      <svg class="nas-note" viewBox="0 0 24 24" width="17" height="17"><path d="M9 18V6l10-2v11.5" stroke="currentColor" stroke-width="1.6" fill="none" stroke-linecap="round" stroke-linejoin="round"/><circle cx="6.5" cy="18" r="2.5" fill="currentColor"/><circle cx="16.5" cy="15.5" r="2.5" fill="currentColor"/></svg>
      <span class="nas-eq" aria-hidden="true"><i></i><i></i><i></i></span>
      <button class="nas-play" type="button" aria-label="播放 ${escapeHtml(t.title || '这首 NAS 曲目')}">
        <svg viewBox="0 0 10 12" width="10" height="12" fill="currentColor" aria-hidden="true"><path d="M0 0l10 6-10 6z"/></svg>
      </button>
    </div>
    <div class="nas-info">
      <div class="nas-name">${escapeHtml(t.title || '未知曲目')}</div>
      <div class="nas-artist">${escapeHtml(t.artist || '未知艺术家')}${t.album ? ` · ${escapeHtml(t.album)}` : ''}</div>
    </div>
    <div class="nas-right">
      ${fmt ? `<span class="nas-fmt">${escapeHtml(fmt)}</span>` : ''}
      <span class="nas-dur">${dur}</span>
    </div>
  </div>`
}

/** NAS 曲目列表渲染（骨架/错误/空态/列表 + 加载更多分页） */
function renderNasTracks() {
  const box = $('#nas-tracks')
  if (!box) return
  const more = $('#nas-more')
  if (more) more.hidden = true

  if (nasState.loading && !nasState.tracks.length) {
    box.innerHTML = `<div class="nas-list" aria-hidden="true">${Array.from({ length: 6 })
      .map(
        () => `
  <div class="nas-row nas-row-sk">
    <div class="hp-sk nas-sk-cover"></div>
    <div class="nas-sk-info"><span class="hp-sk hp-sk-line w60"></span><span class="hp-sk hp-sk-line w32"></span></div>
    <span class="hp-sk nas-sk-dur"></span>
  </div>`,
      )
      .join('')}</div>`
    return
  }
  if (nasState.err && !nasState.tracks.length) {
    box.innerHTML = `<div class="nas-empty">NAS 曲库加载失败：${escapeHtml(nasState.err.message || '未知错误')}<button class="nas-retry" id="nas-retry" type="button">重试</button></div>`
    $('#nas-retry')?.addEventListener('click', () => nasEnsure())
    return
  }
  if (!nasState.tracks.length) {
    const hasSelected = nasState.roots && (nasState.roots.selected || []).some((s) => s && s.enabled !== false)
    box.innerHTML = `
      <div class="nas-empty">
        <div class="nas-empty-icon" aria-hidden="true">
          <svg viewBox="0 0 24 24" width="30" height="30" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M3 7V5.5A1.5 1.5 0 0 1 4.5 4h4l2 2.5h7A1.5 1.5 0 0 1 19 8v1"/><path d="M3 9h17.2a1 1 0 0 1 .98 1.2l-1.5 7A1.6 1.6 0 0 1 18.1 18.4H5.4a1.6 1.6 0 0 1-1.57-1.28L2.2 10.2A1 1 0 0 1 3 9z"/></svg>
        </div>
        <p>${hasSelected ? '所选目录中暂未发现音频文件' : '尚未扫描 NAS 音乐目录'}</p>
        <p class="nas-empty-sub">在飞牛 NAS 部署后可扫描共享目录中的音乐；本地开发环境可通过环境变量 RO_SCAN_ROOTS 指定目录</p>
      </div>`
    return
  }
  box.innerHTML = `<div class="nas-list" role="list">${nasState.tracks.map(nasRowHtml).join('')}</div>`
  nasHighlightNow()
  if (more) {
    more.hidden = nasState.offset >= nasState.total
    more.disabled = nasState.loading
    more.textContent = nasState.loading ? '加载中…' : '加载更多'
  }
}

/** 当前播放 NAS 行高亮（renderNasTracks 尾部调用） */
function nasHighlightNow() {
  const cur = player.currentTask()
  $$('#nas-tracks .nas-row').forEach((row) => {
    row.classList.toggle('now-playing', !!cur && row.dataset.id === cur)
  })
}

/** NAS 行点击：当前已加载曲目入队播放（与歌曲维度 onSongClick 同语义） */
function onNasRowClick(e) {
  const row = e.target.closest('.nas-row')
  if (!row) return
  const q = nasState.tracks.map(nasTrackToPlayer)
  if (!q.length) return
  player.playQueue(q, row.dataset.id)
}

/** NAS 搜索：防抖 350ms 后重置分页重拉（q 变化才发请求） */
function onNasSearchInput(e) {
  clearTimeout(nasSearchTimer)
  const kw = e.target.value.trim()
  nasSearchTimer = setTimeout(() => {
    if (nasState.q === kw) return
    nasState.q = kw
    nasLoadTracks(true)
  }, NAS_SEARCH_DEBOUNCE)
}

/** NAS 面板初始化（init 一次注册） */
function initNas() {
  $('#nas-search')?.addEventListener('input', onNasSearchInput)
  $('#nas-refresh')?.addEventListener('click', () => {
    nasLoadStatus().then(() => {
      renderNas()
      if (!nasState.scanning) nasLoadTracks(true)
    })
    nasLoadRoots().then(renderNasRoots)
  })
  $('#nas-more')?.addEventListener('click', () => nasLoadTracks(false))
  $('#nas-tracks')?.addEventListener('click', onNasRowClick)
  sse.on('scan:progress', onNasScanProgress)
}
