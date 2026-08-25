/**
 * Rainbow 音乐播放器 · 入口：侧边栏导航路由 + 登录态 + 移动端抽屉
 * 各页面拆为独立 ES 模块（pages/*.js），按需懒初始化
 */
import { $, $$, escapeHtml, toast } from './ui.js'
import { api } from './api.js'
import * as searchPage from './pages/search.js'
import * as homePage from './pages/home.js'
import * as libraryPage from './pages/library.js'
import * as playlistsPage from './pages/playlists.js'
import * as sourcesPage from './pages/sources.js'
import * as settingsPage from './pages/settings.js'
import * as healthPage from './pages/health.js'
import * as player from './player.js'

const PAGES = {
  home: homePage,       // 发现（#60 热门歌单聚合首页，默认视图）
  search: searchPage,     // 搜索（#60 独立置首）
  library: libraryPage,   // 本地收藏（曲库 + 下载队列）
  playlists: playlistsPage,
  sources: sourcesPage,
  settings: settingsPage,
  health: healthPage,
}

const initialized = new Set()

function closeDrawer() {
  $('#sidebar')?.classList.remove('open')
  $('#sb-backdrop')?.classList.remove('show')
  $('#nav-toggle')?.classList.remove('open')
}

function showTab(name) {
  const page = PAGES[name]
  if (!page) return
  $$('.tab[data-tab]').forEach((t) => t.classList.toggle('active', t.dataset.tab === name))
  $$('.view').forEach((v) => v.classList.toggle('active', v.id === `view-${name}`))
  if (!initialized.has(name)) {
    page.init?.()
    initialized.add(name)
  }
  page.show?.()
  // 移动端：切页后收起抽屉
  closeDrawer()
  // 切页回顶
  $('.main-wrap')?.scrollTo({ top: 0 })
}

// ---------- 侧边栏导航 ----------
$$('.tab[data-tab]').forEach((tab) => {
  tab.addEventListener('click', (e) => {
    e.preventDefault()
    showTab(tab.dataset.tab)
  })
})

// ---------- 移动端抽屉 ----------
$('#nav-toggle')?.addEventListener('click', () => {
  const open = $('#sidebar')?.classList.toggle('open')
  $('#sb-backdrop')?.classList.toggle('show', !!open)
  $('#nav-toggle')?.classList.toggle('open', !!open)
})
$('#sb-backdrop')?.addEventListener('click', closeDrawer)

/* ============================================================
   #63 D1 · 顶栏全局搜索 pill（SPOTIFY-REDESIGN-PLAN §1.1/T2）
   入口语义、保持轻量：pill 自身不做联想（联想+历史集中在搜索页主框 #keyword）
   - 任意视图回车 → 跳搜索页 + 关键词带过去 + 执行完整搜索
   - 点击/Tab 聚焦（且不在搜索页）→ 跳搜索页并聚焦主搜索框（完整联想+历史体验）
   - '/' 快捷键 → 程序聚焦 pill（不触发入口跳转，留在 pill 直接打字）
   豁免规则与 player.js bindHotkeys 一致：输入框聚焦/修饰键时不触发
   ============================================================ */
const topbarSearch = $('#topbar-search')

/** 跳搜索页并聚焦主搜索框（主框 focus 自然带出历史/联想面板） */
function gotoSearchPage(focusKeyword = true) {
  showTab('search')
  if (focusKeyword) $('#keyword')?.focus()
}

if (topbarSearch) {
  let topbarProgFocus = false // '/' 程序聚焦标志：跳过入口跳转，留在 pill 直接打字

  topbarSearch.addEventListener('focus', () => {
    if (topbarProgFocus) return
    // 用户点击/Tab 聚焦且不在搜索页 → 入口语义：送去功能完整的主搜索框
    if (!$('#view-search')?.classList.contains('active')) gotoSearchPage()
  })

  // Esc 收起焦点（键盘用户退出 pill）
  topbarSearch.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') topbarSearch.blur()
  })

  $('#topbar-search-form')?.addEventListener('submit', (e) => {
    e.preventDefault()
    const kw = topbarSearch.value.trim()
    if (!kw) return gotoSearchPage() // 空词回车 = 与点击入口同语义
    $('#keyword').value = kw // 关键词带给搜索页主框
    topbarSearch.value = ''
    topbarSearch.blur()
    showTab('search') // 首次进入时 showTab 内部先 init（挂 submit 监听），再派发完整搜索
    $('#search-form').dispatchEvent(new Event('submit'))
  })

  // '/' 全局快捷聚焦（豁免：输入框聚焦/可编辑区/修饰键不劫持，对齐 player.js bindHotkeys）
  document.addEventListener('keydown', (e) => {
    if (e.key !== '/' || e.ctrlKey || e.metaKey || e.altKey) return
    const t = e.target
    if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable)) return
    e.preventDefault()
    topbarProgFocus = true
    topbarSearch.focus()
    topbarProgFocus = false
  })
}

/* ============================================================
   P2 · 侧栏窄图标模式（body.sidebar-compact）
   仅 ≥1280px 生效（CSS 媒体查询限定，窄屏抽屉行为不变）；
   localStorage 记忆用户偏好，跨断点 resize 自动同步。
   ============================================================ */
const SB_COMPACT_KEY = 'rainbow.sidebar-compact'

function readCompactPref() {
  try {
    return localStorage.getItem(SB_COMPACT_KEY) === '1'
  } catch {
    return false
  }
}

/** 只切 class + 钮态（不写记忆，供初始同步与 resize 复用） */
function setCompactClass(compact) {
  document.body.classList.toggle('sidebar-compact', compact)
  const btn = $('#sb-collapse')
  if (btn) {
    btn.setAttribute('aria-expanded', String(!compact))
    const label = compact ? '展开侧栏' : '折叠侧栏'
    btn.title = label
    btn.setAttribute('aria-label', label)
  }
}

function toggleSidebarCompact() {
  const next = !document.body.classList.contains('sidebar-compact')
  setCompactClass(next)
  try {
    localStorage.setItem(SB_COMPACT_KEY, next ? '1' : '0')
  } catch {
    /* 隐私模式/配额满：仅本会话内生效 */
  }
}

$('#sb-collapse')?.addEventListener('click', toggleSidebarCompact)

/** <1280px 不应用折叠态（记忆保留，回宽屏自动恢复） */
function syncCompactFromViewport() {
  setCompactClass(window.innerWidth >= 1280 && readCompactPref())
}
syncCompactFromViewport()
window.addEventListener('resize', syncCompactFromViewport)

// ---------- 登录态：鉴权开启时显示「登出」 ----------
async function initAuth() {
  try {
    const r = await api.auth.status()
    if (r.enabled) {
      const btn = $('#logout-btn')
      btn.hidden = false
      btn.addEventListener('click', async (e) => {
        e.preventDefault()
        try {
          await api.auth.logout()
        } catch {
          /* ignore */
        }
        location.href = '/login.html'
      })
    }
  } catch {
    /* ignore */
  }
}

// ---------- 最近播放（player.js 写 localStorage，这里渲染侧边栏快捷入口） ----------
function renderRecent() {
  const list = player.recentList()
  const box = $('#sb-recent')
  const label = $('#sb-recent-label')
  if (!box || !label) return
  label.hidden = list.length === 0
  box.hidden = list.length === 0
  box.innerHTML = list
    .map(
      (it) => `
      <button class="sb-recent-item" type="button" data-id="${escapeHtml(it.id)}" title="播放 ${escapeHtml(it.name)}${it.singer ? ' - ' + escapeHtml(it.singer) : ''}">
        <span class="sb-recent-cover" aria-hidden="true">
          <svg viewBox="0 0 24 24" width="13" height="13"><path d="M9 18V6l10-2v11.5" stroke="currentColor" stroke-width="1.8" fill="none" stroke-linecap="round" stroke-linejoin="round"/><circle cx="6.5" cy="18" r="2.5" fill="currentColor"/><circle cx="16.5" cy="15.5" r="2.5" fill="currentColor"/></svg>
          <img src="/api/v1/cover/${encodeURIComponent(it.id)}" alt="" loading="lazy" onerror="this.remove()" />
        </span>
        <span class="sb-recent-meta"><b>${escapeHtml(it.name)}</b><small>${escapeHtml(it.singer || '')}</small></span>
      </button>`,
    )
    .join('')
}

/** 点击最近播放项：校验任务仍存在且已完成 → 单曲播放；不存在则移除并提示 */
async function onRecentClick(e) {
  const btn = e.target.closest('.sb-recent-item')
  if (!btn) return
  closeDrawer() // 与主导航一致：移动端切页后收起抽屉
  const id = btn.dataset.id
  try {
    const t = await api.tasks.get(id)
    if (t.status !== 'completed' && t.status !== 'completed_with_warnings') {
      return toast(`「${t.name}」尚未完成下载，暂不能播放`)
    }
    player.playQueue([t])
  } catch (err) {
    if (err && err.status === 404) {
      player.removeRecent(id)
      toast('该歌曲的任务已不存在，已从最近播放移除')
    } else {
      toast((err && err.message) || '播放失败')
    }
  }
}

document.addEventListener('recent:changed', renderRecent)
$('#sb-recent')?.addEventListener('click', onRecentClick)
renderRecent()

initAuth()
player.init() // 底部播放器（默认隐藏，本地收藏点 ▶ 后滑入）
showTab('home') // #60：登录后默认落首页（热门歌单聚合）
