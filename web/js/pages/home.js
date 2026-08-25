/**
 * 发现页（#60 热门歌单聚合首页 + 歌单详情 drill；#62 P1 首页核心增强；
 * #67 精选歌单广场分区 + 广场歌单详情 drill）
 * - 数据源：GET /api/v1/hot-playlists（5 平台 10 榜聚合，含酷狗 5 榜，
 *   songs[].songInfo 与搜索结果同构 → 下载/刮削链路零转换）
 * - 缓存：localStorage `rainbow.hot-playlists`（24h TTL；含 errors 平台 5min
 *   短 TTL 重试；写入 try/catch 防御隐私模式/配额满——library.js 同款范式；
 *   #71 结构版本 v 字段：不符/缺失→视为过期强制重拉）
 * - SWR：新鲜缓存直接渲染 + 静默预取，成功且不在 drill 态才重渲染（不打断浏览）
 * - 平台失败隔离：errors 平台渲染橙色警告占位卡（每平台一张，不影响其他平台）
 * - #62 P1：平台分组 tab（单选过滤 + rainbow.hpTab 记忆，内存即时过滤不重拉）/
 *   横幅推荐位（固定「热歌榜·网易云」，缺则取首榜）/ 骨架屏 shimmer
 *   （首次加载可见，缓存命中直出不闪）/ 卡片 stagger 入场 + 详情返回滚动恢复
 * - drill 详情（#57 范式）：blur(24) 大封面横幅 + 排名列榜单列表 + 歌名/艺人
 *   过滤 + 首屏 30 行分块加载；榜单歌曲无本地文件 → 行点击提示下载、
 *   「播放全部/下载全部」走 api.download.batch（P0-6 现状语义，如实呈现）
 * - #69 详情行三态 + 已入库直接播：行状态位按任务实时渲染
 *   （未下载=下载钮 / 下载中=28px 进度环脉冲 / 已下载=绿勾 hover 播放三角）；
 *   进详情拉 GET /tasks 建 ownedMap（platform:songmid → 代表任务，
 *   done>busy>failed 优先、同档取 updatedAt 新），SSE task 事件/progress
 *   局部更新对应行（不整表重渲染，订阅在 init 一次注册 + drillId 守卫，
 *   全局单连接复用 library.js 范式，天然无泄漏）；已下载行/播放全部直接
 *   player.playQueue 入队（榜位序），now-playing 高亮联动 player:trackchange。
 * - #67 精选歌单广场：榜单区之下独立分区（不受 tab 影响，取舍见 index.html 注释），
 *   GET /api/v1/playlist-square（wy/tx 交错轻量列表，24h localStorage 页码快照缓存 +
 *   服务端 5min 缓存）；换一批翻页（到底回第 1 页）、wy 分类下拉重拉；
 *   广场卡点进 → 复用现有详情 drill（拉 /search/songlist/detail 转 HotPlaylist
 *   同构 → 过滤/收藏/下载全部零改造）；tx 详情约 75% 成功（推荐位空 cdlist）→
 *   失败 toast + 详情区错误占位可重试，不阻塞其它卡片
 */
import { $, $$, escapeHtml, toast, PLATFORM_NAME, confirmModal } from '../ui.js'
import { api } from '../api.js'
import * as sse from '../sse.js'
import * as player from '../player.js'

const CACHE_KEY = 'rainbow.hot-playlists'
const CACHE_TTL = 24 * 60 * 60 * 1000 // 24h
/**
 * #71 缓存结构版本：v:2 = kg 榜单封面修复后的数据（#66 前 v 缺失的存量缓存
 * coverUrl 为 null，且 SWR 预取依赖 fetchedAt 变化检测，自愈不确定性高）。
 * 版本不符/缺失 → readCache 返回 null → 强制重拉，一次修复让所有存量旧缓存立即失效。
 */
const CACHE_VERSION = 2
const ERRORS_RETRY_TTL = 5 * 60 * 1000 // errors 平台 5min 短 TTL 重试
const RENDER_CHUNK = 30 // 详情首屏行数（「加载更多」分块）
const DL_QUALITY = 'flac' // 榜单下载音质（与搜索页默认档一致）
const TAB_KEY = 'rainbow.hpTab' // #62 P1：平台分组 tab 记忆
const SCROLL_KEY = 'rainbow.hpScrollY' // #62 P1：详情返回滚动位置（sessionStorage）
const TAB_PLATFORMS = ['all', 'wy', 'tx', 'kg', 'kw', 'mg'] // 分组 tab：全部/网易云/QQ/酷狗/酷我/咪咕
// #67 广场：缓存（24h 同 hot-playlists 范式，含 cat/page 快照）与 wy 分类词（tx 无分类体系）
const SQ_CACHE_KEY = 'rainbow.playlist-square'
const SQ_CACHE_TTL = 24 * 60 * 60 * 1000
const SQ_CATS = ['全部', '华语', '流行', '摇滚', '电子']
const SQ_SKELETON_N = 10 // 分区骨架卡数

/** 期望榜单序（与后端 BOARDS 一致，平台交错；errors 占位卡按此定位；#62 P1 kg 扩为 5 榜） */
const BOARD_ORDER = [
  'wy-3778678', 'tx-26', 'kg-top500', 'tx-62', 'kg-soar', 'kw-hot-hits',
  'kg-new', 'mg-hot-hits', 'kg-webhot', 'kg-eur',
]

const state = {
  data: null, // { fetchedAt, playlists, errors }
  loading: false,
  drillId: null, // 当前详情榜单/歌单 id（广场为 sq:platform:nativeId）
  drillPl: null, // #67：当前详情歌单对象（广场详情异步填充；榜单为 null 走 data 查找）
  drillShown: RENDER_CHUNK, // 已渲染行数
  filter: '', // 详情过滤词
  tab: readTab(), // #62 P1：当前平台分组（'all' | 'wy' | …，localStorage 记忆）
  sq: { data: null, page: 1, cat: '全部', loading: false }, // #67 广场分区
  owned: new Map(), // #69 详情行状态：platform:songmid → 代表任务视图（拉取/SSE 增量维护）
}

// ---------- 工具 ----------

function todayStr() {
  const d = new Date()
  const p = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
}

/** #62 P1：读取记忆的平台分组 tab（非法值/隐私模式回退 'all'） */
function readTab() {
  try {
    const v = localStorage.getItem(TAB_KEY)
    if (TAB_PLATFORMS.includes(v)) return v
  } catch {
    /* 隐私模式：本会话回退全部 */
  }
  return 'all'
}

function greetWord() {
  const h = new Date().getHours()
  if (h < 5) return '夜深了'
  if (h < 9) return '早上好'
  if (h < 12) return '上午好'
  if (h < 14) return '中午好'
  if (h < 18) return '下午好'
  return '晚上好'
}

const isToday = (pl) => pl.updateTime === todayStr()

// ---------- #69 详情行三态（ownedMap / SSE 联动 / 直接播放） ----------

/** 任务终态（可播） */
const isDoneT = (t) => !!t && (t.status === 'completed' || t.status === 'completed_with_warnings')
/** 任务进行态（下载中：环脉冲） */
const isBusyT = (t) => !!t && (t.status === 'pending' || t.status === 'active')
/** 行状态代表任务优先级：done > busy > failed/canceled（同档取 updatedAt 新） */
const STATUS_RANK = { completed: 3, completed_with_warnings: 3, active: 2, pending: 2, failed: 1, canceled: 0 }

/** 28px 进度环 r=9 周长（2πr≈56.55；与 library 40px 环同范式小号版） */
const HP_RING_LEN = 56.55

const songKey = (s) => `${s.platform}:${s.songmid}`

/** owned map 代表任务合并：新视图优先于旧值（同曲多任务时保留最高优先级） */
function ownedUpsert(map, view) {
  if (!view || !view.id) return
  const key = `${view.platform}:${view.songmid}`
  const prev = map.get(key)
  if (!prev) {
    map.set(key, view)
    return
  }
  const pr = STATUS_RANK[prev.status] ?? 0
  const nr = STATUS_RANK[view.status] ?? 0
  if (nr > pr || (nr === pr && (view.updatedAt || 0) >= (prev.updatedAt || 0))) map.set(key, view)
}

/** 拉全量任务快照重建 state.owned（进详情/重连对账/播放全部前兑底） */
async function reconcileOwned() {
  try {
    const r = await api.tasks.list()
    const map = new Map()
    for (const t of r.tasks || []) ownedUpsert(map, t)
    state.owned = map
  } catch {
    /* 拿不到任务列表：保持现状（行为回退为全下载态，SSE 增量仍可补齐） */
  }
}

/** SSE 重连/进入详情后：全行状态局部刷新（不重建列表，不打断入场动画） */
function refreshAllRowStates() {
  $$('#hp-songs .hp-song-row[data-key]').forEach((row) => {
    applyRowState(row, state.owned.get(row.dataset.key))
  })
}

const NOTE_SVG =
  '<svg viewBox="0 0 24 24" width="16" height="16"><path d="M9 18V6l10-2v11.5" stroke="currentColor" stroke-width="1.6" fill="none" stroke-linecap="round" stroke-linejoin="round"/><circle cx="6.5" cy="18" r="2.5" fill="currentColor"/><circle cx="16.5" cy="15.5" r="2.5" fill="currentColor"/></svg>'

/** 封面 onerror：移除 img 露出下层 M5 径向渐变占位（音符常驻渐变位之上） */
const COVER_ERR = "this.remove()"

// ---------- 缓存 ----------

function readCache() {
  try {
    const c = JSON.parse(localStorage.getItem(CACHE_KEY) || 'null')
    // #71：v 不符（含旧结构无 v）视为过期 → 走重拉路径（load 内 cached=null）
    if (c && c.v === CACHE_VERSION && c.resp && Array.isArray(c.resp.playlists)) return c
  } catch {
    /* 损坏缓存视为无 */
  }
  return null
}

function writeCache(resp) {
  try {
    localStorage.setItem(CACHE_KEY, JSON.stringify({ v: CACHE_VERSION, savedAt: Date.now(), resp }))
  } catch {
    /* 隐私模式/配额满：仅本会话内失效 */
  }
}

// ---------- #67 精选歌单广场（缓存/加载/渲染） ----------

/** 播放数格式化：万/亿（125852 → 12.6万；55474084 → 5547.4万 → 0.6亿） */
function fmtSqPlay(n) {
  const v = Number(n) || 0
  if (v >= 1e8) return `${(v / 1e8).toFixed(1).replace(/\.0$/, '')}亿`
  if (v >= 1e4) return `${(v / 1e4).toFixed(1).replace(/\.0$/, '')}万`
  return String(v)
}

/** 广场缓存（24h；快照含 cat/page，分类或页码不匹配视为 miss） */
function readSqCache() {
  try {
    const c = JSON.parse(localStorage.getItem(SQ_CACHE_KEY) || 'null')
    if (
      c &&
      c.resp &&
      Array.isArray(c.resp.playlists) &&
      c.resp.cat === state.sq.cat &&
      c.resp.page === state.sq.page &&
      Date.now() - c.savedAt < SQ_CACHE_TTL
    ) {
      return c
    }
  } catch {
    /* 损坏缓存视为无 */
  }
  return null
}

function writeSqCache(resp) {
  try {
    localStorage.setItem(SQ_CACHE_KEY, JSON.stringify({ savedAt: Date.now(), resp }))
  } catch {
    /* 隐私模式/配额满：仅本会话内失效 */
  }
}

/** 广场卡（hp-card 形态：封面 + scrim 标题 + 平台徽标 + 播放数/创建者两行小字） */
function squareCard(item, i) {
  const plat = PLATFORM_NAME[item.platform] || item.platform
  const id = `sq:${item.platform}:${item.nativeId}`
  const plays = fmtSqPlay(item.playCount)
  return `
    <button class="hp-card sq-card" type="button" data-id="${escapeHtml(id)}" style="--hp-i:${i}" title="查看歌单：${escapeHtml(item.title)}">
      <span class="hp-cover">
        <span class="hp-fallback" aria-hidden="true"><svg viewBox="0 0 24 24" width="40" height="40"><path d="M9 18V6l10-2v11.5" stroke="currentColor" stroke-width="1.5" fill="none" stroke-linecap="round" stroke-linejoin="round"/><circle cx="6.5" cy="18" r="2.5" fill="currentColor"/><circle cx="16.5" cy="15.5" r="2.5" fill="currentColor"/></svg></span>
        ${item.coverUrl ? `<img src="${escapeHtml(item.coverUrl)}" alt="" loading="lazy" referrerpolicy="no-referrer" onerror="${COVER_ERR}" />` : ''}
        <span class="hp-scrim">
          <b class="hp-scrim-title">${escapeHtml(item.title)}</b>
          <small class="hp-scrim-meta"><i class="hp-scrim-plat">${escapeHtml(plat)}</i><i class="hp-scrim-tag sq">广场</i></small>
        </span>
        <span class="hp-play-fab" aria-hidden="true"><svg viewBox="0 0 20 20" width="15" height="15" fill="currentColor"><path d="M6.5 3.5v13l11-6.5z"/></svg></span>
      </span>
      <small class="hp-card-sub sq-plays"><svg viewBox="0 0 20 20" width="10" height="10" fill="currentColor" aria-hidden="true"><path d="M6.5 3.5v13l11-6.5z"/></svg> ${plays}${item.trackCount ? ` · ${item.trackCount}首` : ''}</small>
      <small class="hp-card-sub sq-creator" title="${escapeHtml(item.creator || '')}">${escapeHtml(item.creator || '—')}</small>
    </button>`
}

/** 平台失败占位行（不阻塞另一平台；同 hp 卡错误范式但为整行小条） */
function sqPlatErrorRow(platform) {
  const plat = PLATFORM_NAME[platform] || platform
  return `<div class="sq-plat-err" role="note">${escapeHtml(plat)}广场暂不可用 · 稍后自动重试</div>`
}

function renderSquareSkeleton() {
  $('#sq-grid').innerHTML = Array.from(
    { length: SQ_SKELETON_N },
    () => '<div class="hp-card hp-card-sk" aria-hidden="true"><span class="hp-cover hp-sk"></span><span class="hp-sk hp-sk-line w60"></span></div>',
  ).join('')
}

function renderSquare() {
  const d = state.sq.data
  if (!d) return
  const rows = []
  for (const e of d.errors || []) rows.push(sqPlatErrorRow(e.platform))
  d.playlists.forEach((it, i) => rows.push(squareCard(it, i)))
  if (!rows.length) {
    rows.push(
      `<div class="hp-error"><div class="hp-error-body"><p>歌单广场暂不可用</p><button id="sq-retry" type="button">重试</button></div></div>`,
    )
  }
  $('#sq-grid').innerHTML = rows.join('')
  $('#sq-retry')?.addEventListener('click', () => loadSquare(true))
  // 副信息：分平台总数 + 当前页/分类（tabular 数字）
  const parts = []
  if (d.totals?.wy != null) parts.push(`网易云 ${d.totals.wy}`)
  if (d.totals?.tx != null) parts.push(`QQ ${d.totals.tx}`)
  const seg = parts.length ? parts.join(' · ') : `${d.total || 0} 个歌单`
  $('#sq-sub').textContent = `${seg} · 第 ${d.page} 页${d.cat && d.cat !== '全部' ? ` · ${d.cat}` : ''}`
}

/**
 * 加载广场：缓存命中直出（不打断）；miss/force → 骨架 → 拉取 → 渲染 + 写缓存。
 * 换一批/切分类仅改 page/cat 后 force 重拉（服务端 5min 缓存内同键秒回）。
 */
async function loadSquare(force = false) {
  if (state.sq.loading) return
  if (!force) {
    const cached = readSqCache()
    if (cached) {
      state.sq.data = cached.resp
      renderSquare()
      return
    }
  }
  state.sq.loading = true
  renderSquareSkeleton()
  const btn = $('#sq-more')
  const btnTxt = btn.textContent
  btn.disabled = true
  btn.textContent = '加载中…'
  try {
    const resp = await api.playlistSquare({ platform: 'all', cat: state.sq.cat, page: state.sq.page })
    state.sq.data = resp
    writeSqCache(resp)
    renderSquare()
  } catch (err) {
    // 端点整体不可用（网络/鉴权）：保留骨架位置换错误占位 + 重试
    $('#sq-grid').innerHTML = `<div class="hp-error"><div class="hp-error-body"><p>歌单广场加载失败：${escapeHtml(err.message || '网络错误')}</p><button id="sq-retry" type="button">重试</button></div></div>`
    $('#sq-retry')?.addEventListener('click', () => loadSquare(true))
    $('#sq-sub').textContent = ''
  } finally {
    state.sq.loading = false
    btn.disabled = false
    btn.textContent = btnTxt
  }
}

/** 换一批：翻页拉取（hasMore=false 应回第 1 页循环） */
function onSqRefresh() {
  const d = state.sq.data
  state.sq.page = d?.hasMore ? d.page + 1 : 1
  loadSquare(true)
}

/** 分类切换（wy 分类词透传；tx 固定推荐位不受影响）→ 重拉第一页 */
function onSqCatChange(e) {
  state.sq.cat = e.target.value || '全部'
  state.sq.page = 1
  loadSquare(true)
}

// ---------- 数据加载（含 SWR + 缓存兜底） ----------

async function load() {
  if (state.loading) return
  const cached = readCache()
  const age = cached ? Date.now() - cached.savedAt : Infinity
  const hasErrors = !!(cached && cached.resp.errors && cached.resp.errors.length)

  // 新鲜缓存（<24h 且无 errors；或 errors 但 <5min）→ 直接渲染 + 静默预取
  if (cached && age < CACHE_TTL && (!hasErrors || age < ERRORS_RETRY_TTL)) {
    state.data = cached.resp
    renderHome()
    prefetch()
    return
  }

  // 过期/无缓存/errors 到期：请求端点；期间先渲染旧缓存（有则不打断）
  if (cached) {
    state.data = cached.resp
    renderHome()
  } else {
    renderLoading()
  }
  state.loading = true
  try {
    const resp = await api.hotPlaylists()
    state.data = resp
    writeCache(resp)
    renderHome()
  } catch (err) {
    if (cached) {
      toast('榜单数据为缓存（网络不可用）')
    } else {
      renderError(err)
    }
  } finally {
    state.loading = false
  }
}

/** SWR 静默预取：成功且不在 drill 态才重渲染（避免打断浏览） */
async function prefetch() {
  try {
    const resp = await api.hotPlaylists()
    if (state.drillId) return
    const old = state.data
    if (
      !old ||
      resp.playlists.length !== old.playlists.length ||
      resp.fetchedAt !== old.fetchedAt ||
      JSON.stringify(resp.errors) !== JSON.stringify(old.errors)
    ) {
      state.data = resp
      writeCache(resp)
      renderHome()
    }
  } catch {
    /* 预取失败静默（下次进页再试） */
  }
}

// ---------- 首页渲染 ----------

/** #62 P1 骨架屏：横幅骨架 + tab 骨架 + 10 张卡片骨架（shimmer 扫光，缓存命中不经过此路径） */
function renderLoading() {
  $('#hp-meta').textContent = ''
  const banner = $('#hp-banner')
  banner.hidden = false
  banner.innerHTML = `
    <div class="hp-banner-inner hp-banner-sk" aria-hidden="true">
      <span class="hp-sk hp-sk-banner-cover"></span>
      <span class="hp-banner-info">
        <span class="hp-sk hp-sk-line w32"></span>
        <span class="hp-sk hp-sk-line w64"></span>
        <span class="hp-sk hp-sk-cta"></span>
      </span>
    </div>`
  $('#hp-tabs').innerHTML = Array.from({ length: 4 }, () => '<span class="hp-sk hp-sk-pill" aria-hidden="true"></span>').join('')
  $('#hp-grid').innerHTML = Array.from(
    { length: 10 },
    () => '<div class="hp-card hp-card-sk" aria-hidden="true"><span class="hp-cover hp-sk"></span><span class="hp-sk hp-sk-line w60"></span></div>',
  ).join('')
}

function renderError(err) {
  $('#hp-meta').textContent = ''
  $('#hp-banner').hidden = true
  $('#hp-tabs').innerHTML = ''
  $('#hp-grid').innerHTML = `
    <div class="hp-error">
      <div class="hp-error-body">
        <p>榜单加载失败：${escapeHtml(err.message || '网络错误')}</p>
        <button id="hp-retry" type="button">重试</button>
      </div>
    </div>`
  $('#hp-retry')?.addEventListener('click', load)
}

/** #62 P1：平台分组 tab 计数（榜单卡 + 每平台一张错误占位卡） */
function tabCounts(list, errPlatforms) {
  const counts = { all: 0, wy: 0, tx: 0, kg: 0, kw: 0, mg: 0 }
  for (const pl of list) if (counts[pl.platform] != null) counts[pl.platform] += 1
  for (const p of errPlatforms) if (counts[p] != null) counts[p] += 1
  counts.all = list.length + errPlatforms.length
  return counts
}

function renderTabs(counts) {
  $('#hp-tabs').innerHTML = TAB_PLATFORMS.map((t) => {
    const label = t === 'all' ? '全部' : PLATFORM_NAME[t] || t
    const active = state.tab === t
    return `<button type="button" class="hp-tab${active ? ' active' : ''}" data-plat="${t}" aria-pressed="${active}"${counts[t] === 0 ? ' disabled' : ''}>${escapeHtml(label)}<span class="hp-tab-count">${counts[t]}</span></button>`
  }).join('')
}

/** #62 P1：横幅推荐位（固定「热歌榜·网易云」，wy 缺失则取首榜；不随 tab 过滤） */
function renderBanner(list) {
  const el = $('#hp-banner')
  const pl = list.find((p) => p.id === 'wy-3778678') || list[0]
  if (!pl) {
    el.hidden = true
    el.innerHTML = ''
    return
  }
  const plat = PLATFORM_NAME[pl.platform] || pl.platform
  const updated = isToday(pl)
  const desc =
    pl.description || `${plat} · ${pl.source === 'virtual' ? '关键词精选' : '官方榜单'} · 共 ${pl.total || pl.songs.length} 首 · 更新于 ${pl.updateTime || '—'}`
  el.hidden = false
  el.innerHTML = `
    <button type="button" class="hp-banner-inner" data-id="${escapeHtml(pl.id)}" title="查看榜单：${escapeHtml(pl.title)}">
      <span class="hp-banner-bg" aria-hidden="true">${pl.coverUrl ? `<img src="${escapeHtml(pl.coverUrl)}" alt="" referrerpolicy="no-referrer" onerror="${COVER_ERR}" />` : ''}</span>
      <span class="hp-banner-cover" aria-hidden="true">
        <svg viewBox="0 0 24 24" width="34" height="34"><path d="M9 18V6l10-2v11.5" stroke="currentColor" stroke-width="1.5" fill="none" stroke-linecap="round" stroke-linejoin="round"/><circle cx="6.5" cy="18" r="2.5" fill="currentColor"/><circle cx="16.5" cy="15.5" r="2.5" fill="currentColor"/></svg>
        ${pl.coverUrl ? `<img src="${escapeHtml(pl.coverUrl)}" alt="" referrerpolicy="no-referrer" onerror="${COVER_ERR}" />` : ''}
      </span>
      <span class="hp-banner-info">
        <span class="hp-banner-kicker">每日推荐 · ${escapeHtml(plat)}${updated ? ' · 今日更新' : ''}${pl.source === 'virtual' ? ' · 精选' : ''}</span>
        <span class="hp-banner-title">${escapeHtml(pl.title)}</span>
        <span class="hp-banner-desc">${escapeHtml(desc.slice(0, 90))}</span>
        <span class="hp-banner-cta">立即收听
          <svg viewBox="0 0 12 12" width="11" height="11" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M2 6h7M6 2.5L9.5 6 6 9.5"/></svg>
        </span>
      </span>
    </button>`
}

/** i = 可见序号（stagger 入场 --hp-i，每卡 30ms 递增） */
function playlistCard(pl, i) {
  const plat = PLATFORM_NAME[pl.platform] || pl.platform
  const updated = isToday(pl)
  return `
    <button class="hp-card" type="button" data-id="${escapeHtml(pl.id)}" style="--hp-i:${i}" title="查看榜单：${escapeHtml(pl.title)}">
      <span class="hp-cover">
        <span class="hp-fallback" aria-hidden="true"><svg viewBox="0 0 24 24" width="40" height="40"><path d="M9 18V6l10-2v11.5" stroke="currentColor" stroke-width="1.5" fill="none" stroke-linecap="round" stroke-linejoin="round"/><circle cx="6.5" cy="18" r="2.5" fill="currentColor"/><circle cx="16.5" cy="15.5" r="2.5" fill="currentColor"/></svg></span>
        ${pl.coverUrl ? `<img src="${escapeHtml(pl.coverUrl)}" alt="" loading="lazy" referrerpolicy="no-referrer" onerror="${COVER_ERR}" />` : ''}
        <span class="hp-scrim">
          <b class="hp-scrim-title">${escapeHtml(pl.title)}</b>
          <small class="hp-scrim-meta"><i class="hp-scrim-plat">${escapeHtml(plat)}</i>${pl.source === 'virtual' ? '<i class="hp-scrim-tag">精选</i>' : ''}${updated ? '<i class="hp-scrim-tag acc">今日更新</i>' : ''}</small>
        </span>
        <span class="hp-play-fab" aria-hidden="true"><svg viewBox="0 0 20 20" width="15" height="15" fill="currentColor"><path d="M6.5 3.5v13l11-6.5z"/></svg></span>
      </span>
      <small class="hp-card-sub">${escapeHtml(plat)} · ${pl.total || pl.songs.length} 首${updated ? ' · 今日更新' : ''}</small>
    </button>`
}

/** 平台失败占位卡（橙色警告；每平台一张，定位=该平台首个期望榜单位） */
function errorCard(platform, i) {
  const plat = PLATFORM_NAME[platform] || platform
  return `
    <div class="hp-card hp-card-err" role="note" style="--hp-i:${i}" aria-label="${escapeHtml(plat)}音源暂不可用">
      <span class="hp-cover hp-fallback">
        <svg viewBox="0 0 24 24" width="26" height="26" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 3 2.5 20h19L12 3z"/><path d="M12 9.5v4.5"/><circle cx="12" cy="17.2" r=".4" fill="currentColor"/></svg>
        <b class="hp-err-txt">该音源暂不可用</b>
      </span>
      <small class="hp-card-sub">${escapeHtml(plat)} · 稍后自动重试</small>
    </div>`
}

function renderHome() {
  if (state.drillId) return // drill 态不打断（返回时再渲染）
  $('#hp-greet').textContent = greetWord()
  const data = state.data
  const list = data?.playlists ?? []
  const errPlatforms = (data?.errors ?? []).map((e) => e.platform)
  $('#hp-meta').textContent = list.length ? `${todayStr()} · ${list.length} 个榜单${errPlatforms.length ? ` · ${errPlatforms.length} 个音源不可用` : ''}` : ''
  renderTabs(tabCounts(list, errPlatforms))
  renderBanner(list)
  if (!list.length && !errPlatforms.length) {
    renderError(new Error('暂无榜单数据'))
    return
  }
  const tab = state.tab
  const byId = new Map(list.map((p) => [p.id, p]))
  const errSet = new Set(errPlatforms)
  const rows = []
  const seen = new Set()
  const errShown = new Set() // #62 P1：kg 多榜同挂时每平台只渲染一张错误卡
  const push = (html) => rows.push(html)
  for (const id of BOARD_ORDER) {
    const pl = byId.get(id)
    if (pl) {
      seen.add(id)
      if (tab === 'all' || pl.platform === tab) push(playlistCard(pl, rows.length))
    } else {
      const plat = id.split('-')[0]
      if (errSet.has(plat) && !errShown.has(plat)) {
        errShown.add(plat)
        if (tab === 'all' || tab === plat) push(errorCard(plat, rows.length))
      }
    }
  }
  // 防御：后端新增榜单（不在 BOARD_ORDER）追加渲染，不丢数据（同 tab 过滤）
  for (const pl of list) {
    if (!seen.has(pl.id) && (tab === 'all' || pl.platform === tab)) push(playlistCard(pl, rows.length))
  }
  $('#hp-grid').innerHTML = rows.join('') || '<div class="hp-empty-tab">该平台暂无榜单</div>'
}

// ---------- 详情 drill ----------

function currentPlaylist() {
  // #67：广场详情异步拉取后存 drillPl（榜单态恒 null → 走 data 查找，兼容不动）
  return state.drillPl ?? state.data?.playlists.find((p) => p.id === state.drillId) ?? null
}

function openDetail(id) {
  // #67：广场卡 id 形如 sq:platform:nativeId → 走广场详情（复用同一 drill 模板）
  if (id.startsWith('sq:')) {
    const [, platform, ...rest] = id.split(':')
    if (platform && rest.length) openSquareDetail(platform, rest.join(':'))
    return
  }
  const pl = state.data?.playlists.find((p) => p.id === id)
  if (!pl) return
  enterDetail(pl)
}

/** 进入详情 drill 的公共路径（榜单/广场共用；pl.songs 空时 renderDetail 自动走骨架） */
function enterDetail(pl) {
  state.drillId = pl.id
  // #67：广场详情 source='square' → drillPl 先置占位（songs 空 → 骨架），
  // 避免 renderDetail 时 currentPlaylist 落空误触 closeDetail；榜单恒 null 走 data 查找
  state.drillPl = pl.source === 'square' ? pl : null
  state.filter = ''
  state.drillShown = RENDER_CHUNK
  // #62 P1：记录首页滚动位置，返回时恢复
  try {
    sessionStorage.setItem(SCROLL_KEY, String($('.main-wrap')?.scrollTop ?? 0))
  } catch {
    /* 隐私模式：跳过记忆 */
  }
  const input = $('#hp-filter')
  input.value = ''
  $('#hp-home').hidden = true
  $('#hp-detail').hidden = false
  // #66：进入新榜单时重置收藏钮状态（允许对另一榜单再保存；重名由后端自动加序号）
  const saveBtn = $('#hp-save-pl')
  if (saveBtn) {
    saveBtn.disabled = false
    saveBtn.classList.remove('done')
    saveBtn.textContent = '☆ 收藏歌单'
    saveBtn.title = '将当前榜单保存为本地歌单'
  }
  renderDetail()
  // #69：进详情拉全量任务建 ownedMap → 全行状态局部刷新（不重建列表，
  // 与广场异步详情互不干扰：songs 后到时 renderDetail 直接带状态渲染）
  void reconcileOwned().then(() => {
    if (state.drillId) refreshAllRowStates()
  })
  $('.main-wrap')?.scrollTo({ top: 0 })
}

/**
 * #67 广场歌单详情：卡片元数据先上横幅（songs 空 → 骨架），再异步拉
 * /search/songlist/detail 转 HotPlaylist 同构（songs[].songInfo 可进下载/收藏链路，
 * 与榜单详情完全同体验）；tx 推荐位详情约 25% 空 cdlist → 后端抛错 → 容错占位可重试。
 */
async function openSquareDetail(platform, nativeId) {
  const nid = String(nativeId)
  const id = `sq:${platform}:${nid}`
  const meta = state.sq.data?.playlists.find((p) => p.platform === platform && String(p.nativeId) === nid)
  const placeholder = {
    id,
    platform,
    nativeId: nid,
    title: meta?.title || '加载中…',
    description: meta?.creator ? `by ${meta.creator}` : '',
    coverUrl: meta?.coverUrl ?? null,
    updateTime: todayStr(),
    updatedAt: todayStr(),
    total: meta?.trackCount || 0,
    source: 'square',
    songs: [],
  }
  enterDetail(placeholder) // 占位元数据上横幅 + 骨架（songs 空）
  await fetchSquareDetail(platform, nid, placeholder)
}

async function fetchSquareDetail(platform, nid, fallback) {
  const id = `sq:${platform}:${nid}`
  try {
    const d = await api.search.songlistDetail({ platform, id: nid })
    if (state.drillId !== id) return // 用户已返回：丢弃
    state.drillPl = {
      id,
      platform,
      nativeId: nid,
      title: d.info?.name || fallback.title,
      description: d.info?.desc || fallback.description,
      coverUrl: d.info?.img || fallback.coverUrl,
      updateTime: todayStr(),
      updatedAt: todayStr(),
      total: d.total || d.list.length,
      source: 'square',
      songs: d.list.map((m) => ({
        platform,
        songmid: m.songmid,
        title: m.name,
        artist: m.singer,
        album: m.albumName ?? '',
        interval: m.interval || undefined,
        coverUrl: m.img ?? null,
        songInfo: m,
      })),
    }
    renderDetail()
  } catch (err) {
    if (state.drillId !== id) return
    // tx 推荐位 dissid 详情空 cdlist（无鉴权可破，调研 §1.3）→ 统一容错文案 + 可重试
    console.warn('[playlist-square] detail failed:', err?.message)
    toast('该歌单暂时无法获取详情，可能为平台推荐位限制', 4200)
    $('#hp-filter-count').textContent = ''
    $('#hp-more').hidden = true
    $('#hp-songs').innerHTML = `
      <div class="hp-error">
        <div class="hp-error-body">
          <p>该歌单暂时无法获取详情，可能为平台推荐位限制</p>
          <button id="sq-dl-retry" type="button">重试</button>
        </div>
      </div>`
    $('#sq-dl-retry')?.addEventListener('click', () => fetchSquareDetail(platform, nid, fallback))
  }
}

function closeDetail() {
  state.drillId = null
  state.drillPl = null
  $('#hp-detail').hidden = true
  $('#hp-home').hidden = false
  renderHome() // 缓存预取期间可能已更新数据
  // #62 P1：恢复进详情前的首页滚动位置
  let y = 0
  try {
    y = Number(sessionStorage.getItem(SCROLL_KEY)) || 0
  } catch {
    /* 隐私模式：回到顶部 */
  }
  $('.main-wrap')?.scrollTo({ top: y })
}

function filteredSongs(pl) {
  const kw = state.filter.trim().toLowerCase()
  if (!kw) return pl.songs
  return pl.songs.filter(
    (s) => (s.title || '').toLowerCase().includes(kw) || (s.artist || '').toLowerCase().includes(kw),
  )
}

/** #69 行状态位控件：未下载=下载钮 / 下载中=28px 进度环（脉冲）/ 已下载=绿勾 hover 播放三角 */
function rowStateCtl(s, t) {
  if (isDoneT(t)) {
    return `
        <button class="row-dl done" data-play="${escapeHtml(String(t.id))}" type="button" aria-label="播放已下载的 ${escapeHtml(s.title)}" title="已下载到本地 · 点击播放">
          <svg class="ic-ok" viewBox="0 0 12 12" width="12" height="12" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M2 6.5l2.6 2.6L10 3.5"/></svg>
          <svg class="ic-go" viewBox="0 0 12 12" width="11" height="11" fill="currentColor" aria-hidden="true"><path d="M3 1.5v9l7.5-4.5z"/></svg>
        </button>`
  }
  if (isBusyT(t)) {
    const pct = t.progress || 0
    return `
        <button class="row-dl hp-dl-ing" data-task="${escapeHtml(String(t.id))}" type="button" disabled title="下载中 ${pct}%">
          <svg class="hp-ring" viewBox="0 0 28 28" width="16" height="16" aria-hidden="true">
            <circle class="hp-ring-track" cx="14" cy="14" r="9" />
            <circle class="hp-ring-fill" cx="14" cy="14" r="9" style="stroke-dasharray:${HP_RING_LEN};stroke-dashoffset:${(HP_RING_LEN * (1 - pct / 100)).toFixed(2)}" />
          </svg>
        </button>`
  }
  // 未下载（含 failed/canceled 代表任务：回到可下载态，可再次提交新任务）
  const failed = t && (t.status === 'failed' || t.status === 'canceled')
  return `
        <button class="row-dl" data-dl="${escapeHtml(String(s.songmid))}" type="button" aria-label="下载 ${escapeHtml(s.title)}" title="${failed ? '上次下载未完成，点击重试' : '下载这首'}">
          <svg viewBox="0 0 12 12" width="11" height="11" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M6 1.5v7M3 6l3 3 3-3M2 10.5h8"/></svg>
        </button>`
}

/** SSE 事件局部更新：只替换 .hp-row-state 内容 + 行 title（不重建行、不动入场动画） */
function applyRowState(row, t) {
  const box = row.querySelector('.hp-row-state')
  if (!box) return
  const pl = currentPlaylist()
  const song = pl?.songs.find((s) => songKey(s) === row.dataset.key)
  if (!song) return
  box.innerHTML = rowStateCtl(song, t)
  row.title = isDoneT(t) ? '已下载 · 点击播放' : isBusyT(t) ? '下载中…' : ''
}

/** animate=true 时带 stagger 序号入场（.in 标记 + --hp-i，12ms 递增封顶 24 行）
 *  #69：行带 data-key（platform:songmid，SSE 局部更新定位用）；rank 位内嵌三柱
 *  eq（now-playing 时序号→均衡器动画，本地收藏同款语系） */
function songRow(s, rank, animate) {
  const plat = PLATFORM_NAME[s.platform] || s.platform
  const key = songKey(s)
  const t = state.owned.get(key)
  return `
    <div class="hp-song-row${animate ? ' in' : ''}${isDoneT(t) ? ' owned' : ''}"${animate ? ` style="--hp-i:${Math.min(rank - 1, 24)}"` : ''} data-song="${s.songmid}" data-key="${escapeHtml(key)}"${isDoneT(t) ? ' title="已下载 · 点击播放"' : ''}>
      <span class="hp-rank${rank <= 3 ? ' top' : ''}"><i class="hp-rank-num">${rank}</i><span class="song-eq" aria-hidden="true"><i></i><i></i><i></i></span></span>
      <span class="result-cover hp-song-cover" aria-hidden="true">
        ${NOTE_SVG}
        ${s.coverUrl ? `<img src="${escapeHtml(s.coverUrl)}" alt="" loading="lazy" referrerpolicy="no-referrer" onerror="${COVER_ERR}" />` : ''}
      </span>
      <span class="result-info">
        <span class="result-name">${escapeHtml(s.title)}</span>
        <span class="result-artist">${escapeHtml(s.artist)}${s.album ? ' · ' + escapeHtml(s.album) : ''}</span>
      </span>
      <span class="result-right">
        ${s.interval ? `<span class="result-dur">${escapeHtml(String(s.interval))}</span>` : ''}
        <span class="song-plat">${escapeHtml(plat)}</span>
        <span class="hp-row-state">${rowStateCtl(s, t)}</span>
      </span>
    </div>`
}

/** #62 P1：详情歌曲行骨架（songs 尚未就绪的等待态，shimmer 同款） */
function renderSongSkeleton() {
  $('#hp-songs').innerHTML = Array.from(
    { length: 6 },
    () => `
    <div class="hp-song-row hp-song-sk" aria-hidden="true">
      <span class="hp-sk hp-sk-row-num"></span>
      <span class="hp-sk hp-sk-row-cover"></span>
      <span class="hp-song-sk-info">
        <span class="hp-sk hp-sk-line w40"></span>
        <span class="hp-sk hp-sk-line w70"></span>
      </span>
    </div>`,
  ).join('')
  $('#hp-more').hidden = true
  $('#hp-filter-count').textContent = ''
}

function renderDetail() {
  const pl = currentPlaylist()
  if (!pl) return closeDetail()
  const plat = PLATFORM_NAME[pl.platform] || pl.platform
  const sourceTxt = pl.source === 'square' ? '歌单广场' : pl.source === 'virtual' ? '关键词精选' : '官方榜单'

  // 横幅（封面 + blur 铺底）
  $('#hp-crumb-txt').textContent = `${pl.title} · ${plat} · ${pl.songs.length} 首`
  $('#hp-hero-title').textContent = pl.title
  $('#hp-hero-plat').textContent = plat
  $('#hp-hero-update').hidden = !isToday(pl)
  // #67：复用既有 virtual pill 展示来源徽标（square=歌单广场；virtual 保持精选）
  const virtualPill = $('#hp-hero-virtual')
  virtualPill.textContent = pl.source === 'square' ? '歌单广场' : '精选'
  virtualPill.hidden = pl.source !== 'virtual' && pl.source !== 'square'
  $('#hp-hero-meta').textContent = `${plat} · ${sourceTxt} · 更新于 ${pl.updateTime || '—'} · ${pl.songs.length} 首${pl.description ? ' · ' + pl.description.slice(0, 60) : ''}`
  const heroImg = $('#hp-hero-img')
  const heroBg = $('#hp-hero-bgimg')
  for (const img of [heroImg, heroBg]) {
    if (pl.coverUrl) {
      img.src = pl.coverUrl
      img.hidden = false
      img.onerror = () => {
        img.hidden = true
        img.removeAttribute('src')
      }
    } else {
      img.hidden = true
      img.removeAttribute('src')
    }
  }

  renderSongList(0)
}

/** animFrom：仅第 animFrom 行起播入场动画（首屏全量；「加载更多」只动新增行） */
function renderSongList(animFrom = 0) {
  const pl = currentPlaylist()
  if (!pl) return
  if (!pl.songs.length) {
    renderSongSkeleton()
    return
  }
  const songs = filteredSongs(pl)
  const shown = songs.slice(0, state.drillShown)
  $('#hp-songs').innerHTML = shown.map((s, i) => songRow(s, i + 1, i >= animFrom)).join('') || '<div class="empty">无匹配歌曲</div>'
  const rest = songs.length - shown.length
  const more = $('#hp-more')
  more.hidden = rest <= 0
  if (rest > 0) more.textContent = `加载更多（剩 ${rest} 首）`
  $('#hp-filter-count').textContent = state.filter.trim() ? `${songs.length} / ${pl.songs.length} 首` : ''
}

// ---------- 播放 / 下载 / 收藏（#66：下载全部批量入队 + 一键收藏歌单；#69：直接播放） ----------

/* ============================================================
   #69 · SSE 联动（订阅在 init() 一次性注册，drillId 守卫拦截非详情态：
   全局单连接复用 library.js 范式，无重复订阅/退订生命周期，天然无泄漏）
   ============================================================ */

/** task 事件（created/pending/active/completed、completed_with_warnings/failed/canceled，负载=完整任务视图）：
 *  upsert owned → 命中行局部更新（下载中→已下载跃迁即时可见） */
function onTaskEvent(view) {
  if (!state.drillId || !view || !view.id) return
  ownedUpsert(state.owned, view)
  const key = `${view.platform}:${view.songmid}`
  const row = document.querySelector(`#hp-songs .hp-song-row[data-key="${CSS.escape(key)}"]`)
  if (row) applyRowState(row, state.owned.get(key))
}

/** task:progress（负载 {id, received, total, percent}）：只推进度环 + title，免整行重渲染 */
function onTaskProgress(p) {
  if (!state.drillId || !p || !p.id) return
  for (const t of state.owned.values()) {
    if (t.id === p.id) {
      t.progress = p.percent
      break
    }
  }
  const btn = document.querySelector(`#hp-songs .hp-row-state [data-task="${CSS.escape(p.id)}"]`)
  if (!btn) return
  const fill = btn.querySelector('.hp-ring-fill')
  if (fill) fill.style.strokeDashoffset = (HP_RING_LEN * (1 - (p.percent || 0) / 100)).toFixed(2)
  btn.title = `下载中 ${p.percent || 0}%`
}

/** SSE 重连成功（服务端约定：首包 connected → 全量对账）：详情态重拉任务快照 */
function onSseConnected() {
  if (!state.drillId) return
  void reconcileOwned().then(() => {
    if (state.drillId) refreshAllRowStates()
  })
}

/** player:trackchange 联动：当前播放行橙色高亮（本地收藏同款语系；
 *  taskId 经 owned 反查 platform:songmid 后按 data-key 匹配行） */
function highlightNowPlaying(taskId) {
  let key = null
  if (taskId) {
    for (const [k, t] of state.owned) {
      if (t.id === taskId) {
        key = k
        break
      }
    }
  }
  $$('#hp-songs .hp-song-row').forEach((row) => {
    row.classList.toggle('now-playing', !!key && row.dataset.key === key)
  })
}

/** 已下载曲目构建播放队列（当前过滤视图内 completed 任务，榜位序）并从 startTaskId 播起 */
function playOwnedQueue(startTaskId) {
  const pl = currentPlaylist()
  if (!pl) return
  const q = ownedDoneQueue(pl)
  if (!q.length) {
    toast('当前列表还没有已下载歌曲，先点行内 ⬇ 下载')
    return
  }
  player.playQueue(q, startTaskId)
}

/** 行内单首下载（复用搜索行 .row-dl 交互与 api.download.batch；
 *  #69：batch 响应带 accepted[].id → 乐观置行「下载中」环态，后续由 SSE 接管） */
async function onRowDownload(e) {
  const btn = e.target.closest('button[data-dl]')
  if (!btn || btn.disabled) return
  const pl = currentPlaylist()
  if (!pl) return
  const song = pl.songs.find((s) => String(s.songmid) === btn.dataset.dl)
  if (!song) return
  btn.disabled = true
  try {
    const r = await api.download.batch({ items: [{ platform: song.platform, musicInfo: song.songInfo }], quality: DL_QUALITY })
    if (r.acceptedCount) {
      const tid = r.accepted?.[0]?.id
      if (tid) {
        // 乐观入 owned（pending 态）：行立即变进度环；task:created/active/progress SSE 随后接管
        ownedUpsert(state.owned, {
          id: tid,
          platform: song.platform,
          songmid: String(song.songmid),
          name: song.title,
          singer: song.artist,
          status: 'pending',
          progress: 0,
          updatedAt: Date.now(),
        })
        const row = btn.closest('.hp-song-row')
        if (row) applyRowState(row, state.owned.get(songKey(song)))
      } else {
        btn.classList.add('done')
        btn.title = '已入队'
      }
      toast(`已提交下载：${song.title}`)
    } else {
      toast('该曲目下载被拒')
      btn.disabled = false
    }
  } catch (err) {
    toast(`下载失败: ${err.message}`)
    btn.disabled = false
  }
}

/** #69 已下载行绿勾钮（data-play=taskId）点击 → 直接播放 */
function onRowPlay(e) {
  const btn = e.target.closest('button[data-play]')
  if (!btn || btn.disabled) return
  playOwnedQueue(btn.dataset.play)
}

/** 榜单歌曲行点击（非按钮区）三态分流（#69）：
 *  已下载→直接播（本地收藏同款整行播放语义）；下载中→提示；未下载→下载引导 */
function onSongRowClick(e) {
  if (e.target.closest('button')) return // 下载/播放等控件钮不触发
  const row = e.target.closest('.hp-song-row')
  if (!row) return
  const t = state.owned.get(row.dataset.key)
  if (isDoneT(t)) return playOwnedQueue(t.id)
  if (isBusyT(t)) return toast('下载中…完成后点击行即可播放')
  toast('未下载歌曲点击行内 ⬇ 下载；已下载歌曲点击即播')
}

/** 播放全部（#69 升级）：已下载曲目（completed）直接入队播放（榜位序）；
 *  全部未下载时保留引导批量下载；混合时播已下载部分并 toast 说明 */
async function onPlayAll() {
  const pl = currentPlaylist()
  if (!pl?.songs.length) return
  await reconcileOwned() // 兑底最新快照（进详情拉过则秒回，SSE 增量已实时维护）
  const songs = filteredSongs(pl)
  const q = ownedDoneQueue(pl)
  if (!q.length) {
    const ok = await confirmModal(
      `榜单歌曲尚未下载到本地。是否将「${pl.title}」全部 ${pl.songs.length} 首加入下载队列？下载完成后即可在本页点击直接播放。`,
      { okLabel: '下载全部' },
    )
    if (ok) downloadAll()
    return
  }
  player.playQueue(q)
  const miss = songs.length - q.length
  if (miss) toast(`已播 ${q.length} 首（${miss} 首未下载可点行内 ⬇ 下载）`, 4200)
}

/** #69 详情内已下载行直接播 / 播放全部共用：当前过滤视图的 completed 队列（榜位序） */
function ownedDoneQueue(pl) {
  return filteredSongs(pl)
    .map((s) => state.owned.get(songKey(s)))
    .filter((t) => isDoneT(t))
}

/**
 * #66 P0-4 下载全部：本地去重（已完成任务同曲跳过，#69 复用 owned 快照）+
 * 分批并发入队（15 首/批，上限 200 内）+ 逐批进度反馈；任务级进度由 SSE 推送，
 * #69 起详情行同步呈现下载中环态→已下载绿勾的跃迁（无需切去本地收藏查看）。
 * 现状口径（如实）：后端 download/batch 的 enqueue 不查重——同一首重复入队会生成
 * 新任务重复下载，故去重在前端完成（已在库 → 跳过）。
 */
const DL_ENQUEUE_BATCH = 15

async function downloadAll() {
  const pl = currentPlaylist()
  if (!pl?.songs.length) return
  const btn = $('#hp-dl-all')
  const original = btn.textContent
  btn.disabled = true
  try {
    await reconcileOwned() // #69：拉最新快照建 owned（SSE 增量之外的兑底）
    const owned = new Set(
      [...state.owned].filter(([, t]) => isDoneT(t)).map(([k]) => k),
    )
    const pending = pl.songs.filter((s) => !owned.has(songKey(s)))
    const skipped = pl.songs.length - pending.length
    if (!pending.length) {
      toast(`全部 ${pl.songs.length} 首已在本地收藏，无需重复下载`)
      return
    }
    btn.textContent = `入队中 0/${pending.length}…`
    let accepted = 0
    let rejected = 0
    let done = 0
    const batches = []
    for (let i = 0; i < pending.length; i += DL_ENQUEUE_BATCH) batches.push(pending.slice(i, i + DL_ENQUEUE_BATCH))
    await Promise.all(
      batches.map(async (batch) => {
        const r = await api.download.batch({
          items: batch.map((s) => ({ platform: s.platform, musicInfo: s.songInfo })),
          quality: DL_QUALITY,
        })
        accepted += r.acceptedCount
        rejected += r.rejectedCount
        done += batch.length
        btn.textContent = `入队中 ${done}/${pending.length}…`
      }),
    )
    const parts = [`已入队 ${accepted} 首`]
    if (skipped) parts.push(`跳过已在库 ${skipped} 首`)
    if (rejected) parts.push(`${rejected} 首被拒`)
    toast(parts.join('，') + '，进度见「本地收藏」下载队列', 4200)
  } catch (err) {
    toast(`批量下载失败: ${err.message}`)
  } finally {
    btn.disabled = false
    btn.textContent = original
  }
}

/**
 * #66 P0-3 一键收藏歌单：当前榜单 → 本地个人歌单（POST /api/v1/playlists/import
 * 单请求事务建单；songs[].songInfo 与 musicInfo 同构零转换）。重名后端自动加序号；
 * 保存中 loading 态，完成 toast 附「去查看」入口（模拟点击侧栏 tab 切到歌单页）。
 */
async function onSavePlaylist() {
  const pl = currentPlaylist()
  if (!pl?.songs.length) return
  const btn = $('#hp-save-pl')
  if (btn.classList.contains('done')) {
    toast('该榜单已保存过，可在「歌单」页查看')
    return
  }
  const original = btn.textContent
  btn.disabled = true
  btn.textContent = '保存中…'
  try {
    const r = await api.playlists.importSongs({
      title: pl.title,
      description: `来自发现页 · ${PLATFORM_NAME[pl.platform] || pl.platform} · ${todayStr()}`,
      songs: pl.songs.map((s) => ({ platform: s.platform, musicInfo: s.songInfo })),
    })
    btn.classList.add('done')
    btn.textContent = '✓ 已收藏'
    btn.title = `已保存为歌单「${r.name}」`
    toast(
      `已保存歌单「${r.name}」· ${r.count} 首${r.renamed ? '（同名歌单已存在，自动加序号）' : ''}${r.rejectedCount ? ` · ${r.rejectedCount} 首无效跳过` : ''}`,
      {
        ms: 5000,
        actionLabel: '去查看',
        onAction: () => $('.tab[data-tab="playlists"]')?.click(),
      },
    )
  } catch (err) {
    toast(`保存失败: ${err.message}`)
    btn.textContent = original
    btn.disabled = false
  }
}

// ---------- 初始化 ----------

export function init() {
  $('#hp-grid').addEventListener('click', (e) => {
    const card = e.target.closest('.hp-card[data-id]')
    if (card) openDetail(card.dataset.id)
  })
  // #62 P1：横幅推荐位 → 进榜单详情
  $('#hp-banner').addEventListener('click', (e) => {
    const btn = e.target.closest('.hp-banner-inner[data-id]')
    if (btn) openDetail(btn.dataset.id)
  })
  // #62 P1：平台分组 tab（单选过滤；数据已在内存，即时重渲染不重拉）
  $('#hp-tabs').addEventListener('click', (e) => {
    const btn = e.target.closest('button.hp-tab[data-plat]')
    if (!btn || btn.disabled || state.tab === btn.dataset.plat) return
    state.tab = btn.dataset.plat
    try {
      localStorage.setItem(TAB_KEY, state.tab)
    } catch {
      /* 隐私模式：本会话内生效 */
    }
    renderHome()
  })
  $('#hp-back')?.addEventListener('click', closeDetail)
  $('#hp-filter')?.addEventListener('input', (e) => {
    state.filter = e.target.value
    state.drillShown = RENDER_CHUNK
    renderSongList(0)
  })
  $('#hp-more')?.addEventListener('click', () => {
    const from = state.drillShown // 仅新增行动画
    state.drillShown += RENDER_CHUNK
    renderSongList(from)
  })
  $('#hp-songs').addEventListener('click', (e) => {
    onRowDownload(e)
    onRowPlay(e)
    onSongRowClick(e)
  })
  $('#hp-play-all')?.addEventListener('click', onPlayAll)
  $('#hp-dl-all')?.addEventListener('click', downloadAll)
  // #69 SSE 联动：详情行三态实时刷新（订阅一次性注册 + drillId 守卫，全局单连接
  // 复用 library.js 范式；非详情态事件被守卫拦截，无泄漏无重复订阅）
  for (const ev of ['task:created', 'task:pending', 'task:active', 'task:completed', 'task:completed_with_warnings', 'task:failed', 'task:canceled']) {
    sse.on(ev, onTaskEvent)
  }
  sse.on('task:progress', onTaskProgress)
  sse.on('connected', onSseConnected) // 断线重连 → 详情态全量对账刷新
  // #69 播放联动：当前曲目变化 → 详情行 now-playing 高亮（player 模块全局派发）
  document.addEventListener('player:trackchange', (e) => highlightNowPlaying(e.detail?.taskId ?? null))
  // #66 P0-3：一键收藏当前榜单为本地个人歌单
  $('#hp-save-pl')?.addEventListener('click', onSavePlaylist)
  // #67 精选歌单广场：卡片点击进详情 drill（sq: 前缀在 openDetail 分流）
  $('#sq-grid').addEventListener('click', (e) => {
    const card = e.target.closest('.hp-card[data-id]')
    if (card) openDetail(card.dataset.id)
  })
  $('#sq-more')?.addEventListener('click', onSqRefresh)
  // wy 分类下拉（切分类重拉第一页；选项静态填充）
  const catSel = $('#sq-cat')
  if (catSel) {
    catSel.innerHTML = SQ_CATS.map((c) => `<option value="${escapeHtml(c)}">${escapeHtml(c)}</option>`).join('')
    catSel.value = state.sq.cat
    catSel.addEventListener('change', onSqCatChange)
  }
}

export function show() {
  if (!state.data) load()
  else if (!state.drillId) renderHome() // 问候语跨时段刷新 + 数据可能被预取更新
  if (!state.sq.data && !state.sq.loading) loadSquare() // #67 广场分区（独立缓存，首次进页拉取）
}
