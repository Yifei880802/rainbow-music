/**
 * 底部播放器：单个全局 <audio>，src 指向 /api/v1/play/:taskId（同源 Cookie 自动携带）
 * - 外部入口：playQueue(queue, taskId?) —— queue 为 completed 任务列表（含 id/name/singer/filePath）
 * - ended 自动下一首；进度/音量滑杆支持点击与拖动；关闭即收起并停止
 * - 曲目名/艺术家取任务 name/singer，缺失时回退解析文件名「名字 - 歌手.ext」
 * - 最近播放：loadAt 时记 taskId+歌名+艺术家到 localStorage（去重、保留 20 条），
 *   派发 recent:changed 事件供侧边栏快捷入口（main.js）重渲染
 */
import { $, toast, escapeHtml } from './ui.js'
import { api } from './api.js'
import { store } from './storage.js'

let audio = null
let bar = null
let els = {}

let queue = []   // 当前播放队列（completed 任务列表顺序；shuffle 开启时为洗牌序）
let index = -1   // 当前曲目下标
let currentTaskId = null // 当前播放任务 id（供视图联动）
let inited = false
let closed = true

// ---------- 播放模式（P1 纯前端状态机） ----------
let shuffleOn = false   // shuffle：洗牌队列次序（开时保留洗牌基线，关时恢复原序）
let repeatMode = 'off'  // repeat：'off' 不循环 | 'all' 列表循环 | 'one' 单曲循环（audio.loop）
let baseQueue = []      // shuffle 开启前的原始队列
let npOpen = false      // Now Playing 面板开合

// ---------- 最近播放（localStorage，纯前端；v0.2.1 模块六改走 storage.js：uid 前缀隔离） ----------
const RECENT_KEY = 'recent'
const RECENT_MAX = 20

// ---------- P0 · localStorage 记忆键（音量 / np 面板开合 / FLAC 提示；同改 storage.js） ----------
const VOL_KEY = 'volume'
const NP_OPEN_KEY = 'npOpen'
const FLAC_TIP_KEY = 'flac-tip-shown'

/** 读取最近播放列表（损坏/缺失一律安全回退空数组） */
export function recentList() {
  try {
    const list = JSON.parse(store.get(RECENT_KEY) || '[]')
    return Array.isArray(list) ? list.filter((it) => it && it.id) : []
  } catch {
    return []
  }
}

function writeRecent(list) {
  try {
    store.set(RECENT_KEY, JSON.stringify(list))
  } catch {
    /* 隐私模式/配额满：忽略，仅本轮会话内失效 */
  }
  document.dispatchEvent(new CustomEvent('recent:changed', { detail: { list } }))
}

/** 记录一首：置顶去重，截断保留最近 RECENT_MAX 条；
 *  v0.2.1 模块六：NAS 曲目（kind='nas'）附带 playUrl/coverUrl 存档，
 *  侧边栏最近播放点击时免 tasks 校验直接重建播放对象 */
function recordRecent(task) {
  const name = els.title.textContent
  if (!task.id || !name) return
  const entry = { id: task.id, name, singer: els.artist.textContent || '', ts: Date.now() }
  if (task.kind === 'nas') {
    entry.kind = 'nas'
    entry.album = task.album || ''
    entry.playUrl = task.playUrl
    entry.coverUrl = task.coverUrl
  }
  writeRecent([entry, ...recentList().filter((it) => it.id !== task.id)].slice(0, RECENT_MAX))
}

/* ============================================================
   v0.2.1 模块六 · 服务端播放历史上报（POST /api/v1/me/history）
   - 时机：loadAt 记录 recent 的同一时机（每次切歌/起播）
   - 防刷：同曲目 30s 内不重复上报（seek 重载/快速切回不刷屏）
   - 原生 fetch fire-and-forget：失败静默（旧后端 404 / 离线均不打扰用户，
     且避免 api.js request() 的 401 跳转副作用）
   ============================================================ */
const HISTORY_THROTTLE_MS = 30000
const historyLastAt = new Map() // taskId → 上次上报时间戳

function reportHistory(task) {
  const now = Date.now()
  const last = historyLastAt.get(task.id) || 0
  if (now - last < HISTORY_THROTTLE_MS) return
  historyLastAt.set(task.id, now)
  const meta = metaOf(task)
  const track = {
    kind: task.kind === 'nas' ? 'nas' : 'task',
    id: task.id,
    name: meta.name,
    singer: meta.singer,
    album: task.album || '',
    playedAt: now,
  }
  if (task.kind === 'nas') track.trackId = String(task.id).replace(/^nas:/, '')
  fetch('/api/v1/me/history', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    credentials: 'same-origin',
    body: JSON.stringify({ track }),
  }).catch(() => {
    /* 离线/旧后端：静默 */
  })
}

/** 删除一条最近播放（任务不存在时由侧边栏入口调用） */
export function removeRecent(taskId) {
  writeRecent(recentList().filter((it) => it.id !== taskId))
}

/** 当前播放任务 id；未在播放时为 null */
export function currentTask() {
  return currentTaskId
}

/** 派发曲目变化事件（视图侧高亮联动用） */
function emitTrackChange() {
  document.dispatchEvent(new CustomEvent('player:trackchange', { detail: { taskId: currentTaskId } }))
}

/** 派发音频元数据事件（loadedmetadata 后可知总时长；视图侧回填时长用） */
function emitMetadata() {
  const dur = audio.duration
  if (!currentTaskId || !Number.isFinite(dur) || dur <= 0) return
  document.dispatchEvent(new CustomEvent('player:metadata', { detail: { taskId: currentTaskId, duration: dur } }))
}

/** 秒 → m:ss */
function fmt(sec) {
  if (!Number.isFinite(sec) || sec < 0) sec = 0
  const m = Math.floor(sec / 60)
  const s = Math.floor(sec % 60)
  return `${m}:${String(s).padStart(2, '0')}`
}

/** 文件名回退解析：去掉扩展名后按「 - 」拆成 名字/歌手 */
function fromFileName(filePath) {
  const base = String(filePath || '').split('/').pop().replace(/\.[^.]+$/, '')
  const at = base.indexOf(' - ')
  if (at > 0) return { name: base.slice(0, at), singer: base.slice(at + 3) }
  return { name: base, singer: '' }
}

function clamp01(v) {
  return Math.min(1, Math.max(0, v))
}

function setOpen(open) {
  // 关闭前：若焦点仍在播放栏内先 blur，避免 Chromium「descendant retained focus」a11y 警告
  if (!open && document.activeElement && bar.contains(document.activeElement)) {
    document.activeElement.blur()
  }
  bar.classList.toggle('open', open)
  bar.setAttribute('aria-hidden', open ? 'false' : 'true')
  document.body.classList.toggle('player-open', open)
}

function updateMeta(task) {
  const name = task.name || ''
  const singer = task.singer || ''
  const fb = name ? null : fromFileName(task.filePath)
  els.title.textContent = name || (fb && fb.name) || '未知曲目'
  els.artist.textContent = singer || (fb && fb.singer) || ''
  document.title = `${els.title.textContent} · Rainbow`
}

/** #52 SVG 的 .hidden property 赋值在 Chromium 不反射为 attribute（CDP 实证：
 *  svg.hidden=true 后 hasAttribute('hidden')===false），而 CSS [hidden] 选择器
 *  只认 attribute —— 必须走 setAttribute/removeAttribute；末尾的 property 赋值
 *  为反射型实现（如 Firefox）提供兼容，两者不冲突 */
function setHiddenIcon(el, hide) {
  if (!el) return
  if (hide) el.setAttribute('hidden', '')
  else el.removeAttribute('hidden')
  el.hidden = hide
}

function syncToggleIcon() {
  const playing = !audio.paused && !audio.ended
  setHiddenIcon(els.icPlay, playing)
  setHiddenIcon(els.icPause, !playing)
  // #52 np 面板播放钮同步（同一套 ic-play/ic-pause hidden 切换语系；CSS 层交叉淡化过渡）
  setHiddenIcon(els.npIcPlay, playing)
  setHiddenIcon(els.npIcPause, !playing)
  if (els.npPlay) {
    const label = playing ? '暂停' : '播放'
    els.npPlay.title = label
    els.npPlay.setAttribute('aria-label', label)
  }
}

function syncProgress() {
  const dur = audio.duration || 0
  const pct = dur > 0 ? clamp01(audio.currentTime / dur) * 100 : 0
  els.fill.style.width = `${pct}%`
  els.cur.textContent = fmt(audio.currentTime)
  els.dur.textContent = fmt(dur)
  // seek 滑杆 aria 同步（屏幕阅读器可读）
  els.seek.setAttribute('aria-valuenow', String(Math.round(pct)))
  els.seek.setAttribute('aria-valuetext', `${fmt(audio.currentTime)} / ${fmt(dur)}`)
}

/** 队列首/尾时禁用上一首/下一首（#52 np 面板控制组同步联动） */
function syncNav() {
  const empty = !queue.length || index < 0
  els.prev.disabled = empty || index <= 0
  els.next.disabled = empty || index >= queue.length - 1
  if (els.npPrev) els.npPrev.disabled = els.prev.disabled
  if (els.npNext) els.npNext.disabled = els.next.disabled
}

/** 音量记忆写入（P0-4：debounce 300ms；隐私模式/配额满静默忽略） */
let volSaveTimer = 0
function saveVolume(v) {
  clearTimeout(volSaveTimer)
  volSaveTimer = setTimeout(() => {
    try {
      store.set(VOL_KEY, String(v))
    } catch {
      /* 隐私模式/配额满：仅本会话内生效 */
    }
  }, 300)
}

/** P0-4：启动音量恢复（localStorage 优先，缺省 0.8；注意 Number(null)===0 需先判空） */
function readVolume() {
  try {
    const raw = store.get(VOL_KEY)
    if (raw !== null) {
      const v = Number(raw)
      if (Number.isFinite(v) && v >= 0 && v <= 1) return v
    }
  } catch {
    /* 存储不可用：走缺省 */
  }
  return 0.8
}

/** 设置音量（0~1）：同步填充宽度与 aria 状态；P0-4 debounce 记忆 */
function setVolume(r) {
  const v = clamp01(r)
  audio.volume = v
  els.volfill.style.width = `${v * 100}%`
  els.voltrack.setAttribute('aria-valuenow', String(Math.round(v * 100)))
  els.voltrack.setAttribute('aria-valuetext', `${Math.round(v * 100)}%`)
  saveVolume(v)
}

function loadAt(i, autoplay = true) {
  if (i < 0 || i >= queue.length) return
  index = i
  const task = queue[i]
  currentTaskId = task.id
  emitTrackChange()
  updateMeta(task)
  // P0-1：系统媒体面（锁屏/媒体键）元数据同步；P0-6：FLAC 兼容一次性提示
  syncMediaSession(task)
  maybeFlacTip(task)
  recordRecent(task)
  reportHistory(task) // v0.2.1 模块六：服务端播放历史上报（同 recent 时机，30s 节流防刷）
  syncCover(task)
  syncNp(task)
  syncProgress()
  syncNav()
  // v0.2.1 模块六：NAS 曲目携带自定义 stream 地址（library/tracks/:id/stream），
  // 本地任务维持既有 /api/v1/play/:taskId 端点（契约不变）
  audio.src = task.playUrl || `/api/v1/play/${encodeURIComponent(task.id)}`
  if (autoplay) {
    audio.play().catch(() => {
      /* 非用户手势等播放失败，静默；error 事件会提示 */
    })
  }
}

/** 播放栏封面：NAS 曲目用 library cover 端点，本地任务用 /api/v1/cover/:taskId；
 *  成功盖上唱片位，失败回退装饰位 */
function syncCover(task) {
  if (!els.cover) return
  els.cover.hidden = true // 先复位，load 事件再展示（避免上一首封面残影）
  els.cover.src = task.coverUrl || `/api/v1/cover/${encodeURIComponent(task.id)}`
}

/* ============================================================
   P1 增量：Now Playing 面板同步 + 播放模式 + 氛围取色
   （全部新增函数/绑定，不改既有签名与数据流）
   ============================================================ */

/** 队列条目展示元信息（同 updateMeta 的回退解析规则） */
function metaOf(task) {
  const name = task.name || ''
  const singer = task.singer || ''
  if (name) return { name, singer: singer || '未知艺术家' }
  const fb = fromFileName(task.filePath)
  return { name: fb.name || '未知曲目', singer: fb.singer || '未知艺术家' }
}

/** 封面平均色采样（16×16 canvas）→ body.style --ambient（r,g,b）；仅氛围光消费 */
function sampleAmbient(img) {
  try {
    const c = document.createElement('canvas')
    c.width = 16
    c.height = 16
    const ctx = c.getContext('2d', { willReadFrequently: true })
    if (!ctx) return resetAmbient()
    ctx.drawImage(img, 0, 0, 16, 16)
    const d = ctx.getImageData(0, 0, 16, 16).data
    let r = 0
    let g = 0
    let b = 0
    const n = d.length / 4
    for (let i = 0; i < d.length; i += 4) {
      r += d[i]
      g += d[i + 1]
      b += d[i + 2]
    }
    document.body.style.setProperty('--ambient', `${Math.round(r / n)},${Math.round(g / n)},${Math.round(b / n)}`)
  } catch {
    resetAmbient() // 画布不可用/污染 → 回退默认橙（:root 定义）
  }
}

function resetAmbient() {
  document.body.style.removeProperty('--ambient')
}

/** shuffle/repeat 按钮态同步（audio.loop 单曲循环在此统一生效） */
function syncModeButtons() {
  audio.loop = repeatMode === 'one'
  if (els.shuffle) {
    els.shuffle.classList.toggle('on', shuffleOn)
    els.shuffle.setAttribute('aria-pressed', String(shuffleOn))
    els.shuffle.title = shuffleOn ? '随机播放（开）' : '随机播放'
  }
  if (els.repeat) {
    els.repeat.classList.toggle('on', repeatMode !== 'off')
    els.repeat.classList.toggle('mode-one', repeatMode === 'one')
    els.repeat.setAttribute('aria-pressed', String(repeatMode !== 'off'))
    const label = repeatMode === 'one' ? '单曲循环' : repeatMode === 'all' ? '列表循环' : '循环播放'
    els.repeat.setAttribute('aria-label', label)
    els.repeat.title = label
  }
}

/** shuffle：Fisher–Yates 洗牌队列（当前曲不动位）；关闭恢复原序 */
function toggleShuffle() {
  if (!queue.length) return
  shuffleOn = !shuffleOn
  if (shuffleOn) {
    baseQueue = queue.slice()
    for (let i = queue.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1))
      ;[queue[i], queue[j]] = [queue[j], queue[i]]
    }
    toast('随机播放：已打乱队列')
  } else {
    if (baseQueue.length) queue = baseQueue.slice()
    baseQueue = []
    toast('随机播放：已恢复原序')
  }
  resyncIndex()
  syncNav()
  syncModeButtons()
  renderNpQueue()
}

/** repeat：off → all（列表循环）→ one（单曲循环）→ off */
function cycleRepeat() {
  repeatMode = repeatMode === 'off' ? 'all' : repeatMode === 'all' ? 'one' : 'off'
  syncModeButtons()
  toast(repeatMode === 'one' ? '单曲循环' : repeatMode === 'all' ? '列表循环' : '循环已关闭')
}

/** 洗牌/恢复后：index 重新指向当前曲 */
function resyncIndex() {
  if (!currentTaskId) return
  const cur = queue.findIndex((t) => t.id === currentTaskId)
  if (cur >= 0) index = cur
}

/** 面板队列列表（渲染语系同 .sb-recent-item：40px 封面槽 + 双行文字） */
function renderNpQueue() {
  if (!els.npQueue) return
  if (!queue.length) {
    els.npQueue.innerHTML = '<div class="np-empty">队列为空<br />到「本地收藏」点 ▶ 开始播放</div>'
    return
  }
  els.npQueue.innerHTML = queue
    .map((t, i) => {
      const cur = t.id === currentTaskId
      const m = metaOf(t)
      return `
      <button class="np-item${cur ? ' now-playing' : ''}" type="button" data-id="${escapeHtml(t.id)}" title="${escapeHtml(m.name)}${m.singer && m.singer !== '未知艺术家' ? ' - ' + escapeHtml(m.singer) : ''}">
        ${cur ? '<span class="np-eq" aria-hidden="true"><i></i><i></i><i></i></span>' : `<span class="np-item-num">${i + 1}</span>`}
        <span class="np-item-cover" aria-hidden="true">
          <svg viewBox="0 0 24 24" width="13" height="13"><path d="M9 18V6l10-2v11.5" stroke="currentColor" stroke-width="1.8" fill="none" stroke-linecap="round" stroke-linejoin="round"/><circle cx="6.5" cy="18" r="2.5" fill="currentColor"/><circle cx="16.5" cy="15.5" r="2.5" fill="currentColor"/></svg>
          <img src="${escapeHtml(t.coverUrl || `/api/v1/cover/${encodeURIComponent(t.id)}`)}" alt="" loading="lazy" onerror="this.remove()" />
        </span>
        <span class="np-item-meta"><b>${escapeHtml(m.name)}</b><small>${escapeHtml(m.singer)}</small></span>
      </button>`
    })
    .join('')
}

/** 面板头部同步：标题/歌手/大封面（load 成功展示，失败保持装饰位） */
function syncNp(task) {
  if (els.npTitle) els.npTitle.textContent = els.title.textContent
  if (els.npArtist) els.npArtist.textContent = els.artist.textContent || '未知艺术家'
  if (els.npCover) {
    els.npCover.hidden = true
    els.npCover.src = task.coverUrl || `/api/v1/cover/${encodeURIComponent(task.id)}`
  }
  renderNpQueue()
}

/** 面板开合（body.np-open 驱动 main 让位）；P0-7 开合记忆 localStorage */
function setNpOpen(open) {
  npOpen = open
  try {
    store.set(NP_OPEN_KEY, open ? '1' : '0')
  } catch {
    /* 隐私模式/配额满：仅本会话内生效 */
  }
  if (els.npPanel) {
    els.npPanel.classList.toggle('open', open)
    els.npPanel.setAttribute('aria-hidden', open ? 'false' : 'true')
  }
  document.body.classList.toggle('np-open', open)
  if (els.expand) {
    els.expand.classList.toggle('on', open)
    els.expand.setAttribute('aria-expanded', String(open))
    els.expand.title = open ? '收起面板' : '展开正在播放面板'
  }
}

/* ============================================================
   P2 增量：歌词 sidecar + 频谱可视化 + 黑胶播放态
   （全部新增函数/绑定，不改既有签名与数据流；歌词拉取由既有
    player:trackchange 事件驱动，切歌/关闭自动重拉）
   ============================================================ */

// ---------- P2-2 · 歌词 sidecar ----------
const REDUCED_MOTION = window.matchMedia('(prefers-reduced-motion: reduce)')
const LRC_TIME = /\[(\d{1,3}):(\d{1,2})(?:[.:](\d{1,3}))?\]/g

// ---------- #52 · 歌词区拖拽滚动 + 用户交互暂停自动跟随 ----------
// 拖拽/滚轮/触摸滚动后 LYRIC_FOLLOW_DELAY 内 syncLyric 提前返回（不推进不高亮不滚动），
// 之后的首个 timeupdate 自动恢复跟随（指针 while 追赶直接落到当前行）。
const LYRIC_FOLLOW_DELAY = 3000
let lyricUserHold = 0    // 最近一次用户滚动交互时间戳（0 = 从未）
let lyricDragging = false // 拖拽中（cursor grabbing / scroll-behavior 兜底 auto）

/** 歌词区鼠标按住拖拽滚动（pointer capture 跟手；滚轮/触摸滚动亦暂停自动跟随） */
function bindLyricDrag() {
  const box = els.npLyricScroll
  if (!box) return
  let startY = 0
  let startScroll = 0
  box.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return
    if (e.pointerType === 'touch') return // 触摸交给原生滚动（touchmove 监听负责暂停跟随）
    // 鼠标点在纵向滚动条上：让浏览器原生接管滚动条拖拽
    if (e.pointerType === 'mouse' && e.offsetX >= box.clientWidth) return
    lyricDragging = true
    startY = e.clientY
    startScroll = box.scrollTop
    lyricUserHold = Date.now()
    box.classList.add('dragging')
    try {
      box.setPointerCapture(e.pointerId)
    } catch {
      /* 捕获失败不影响基础拖拽 */
    }
    e.preventDefault() // 防拖选文本（歌词区无按钮/链接，无默认点击行为可损失）
  })
  box.addEventListener('pointermove', (e) => {
    if (!lyricDragging) return
    box.scrollTop = startScroll - (e.clientY - startY) // 1:1 跟手
    lyricUserHold = Date.now()
  })
  const endDrag = () => {
    if (!lyricDragging) return
    lyricDragging = false
    box.classList.remove('dragging')
    lyricUserHold = Date.now() // 从松手起重新计时 3s
  }
  box.addEventListener('pointerup', endDrag)
  box.addEventListener('pointercancel', endDrag)
  // 滚轮 / 触摸滚动：同样暂停自动跟随（passive 不阻塞原生滚动）
  box.addEventListener('wheel', () => {
    lyricUserHold = Date.now()
  }, { passive: true })
  box.addEventListener('touchmove', () => {
    lyricUserHold = Date.now()
  }, { passive: true })
}

/** @type {{taskId:string|null, timed:Array<{t:number,text:string}>, plain:string[], status:'idle'|'loading'|'ok'|'plain'|'empty'|'error'}} */
let lyricState = { taskId: null, timed: [], plain: [], status: 'idle' }
let lyricLineEls = []   // 歌词行元素缓存（渲染时填充）
let lyricPrevEl = null  // 上一高亮行（增量 class 切换，免全量扫描）
let lyricCursor = -1    // 时间轴指针（前进 O(1)，seek 回退时重扫）

/**
 * 解析 lrc，返回双结构：
 * - timed：带 ≥1 个有效时间标签的行（[mm:ss.xx]/[mm:ss.xxx]/[mm:ss]、一行多标签）→ 滚动高亮模式
 * - plain：无有效时间标签、但剥掉所有 [..] 标签后仍有正文的行 → 纯文本降级模式
 *   （脏时间轴如 [NaN:NaN.NaN] 不被时间正则命中，剥标签后正文得以保留）
 * 两者皆空 = 无可用歌词。
 */
function parseLrc(text) {
  const timed = []
  const plain = []
  for (const raw of String(text || '').split(/\r?\n/)) {
    const tags = []
    LRC_TIME.lastIndex = 0
    let m
    while ((m = LRC_TIME.exec(raw))) {
      const t = Number(m[1]) * 60 + Number(m[2]) + (m[3] ? Number(m[3].padEnd(3, '0')) / 1000 : 0)
      if (Number.isFinite(t)) tags.push(t)
    }
    if (tags.length) {
      const words = raw.replace(LRC_TIME, '').trim()
      if (!words) continue // 纯时间戳行（元数据）跳过
      for (const t of tags) timed.push({ t, text: words })
    } else {
      const words = raw.replace(/\[[^\]]*\]/g, '').trim() // 剥所有 [..] 标签（脏时间戳/元数据）
      if (words) plain.push(words)
    }
  }
  timed.sort((a, b) => a.t - b.t)
  return { timed, plain }
}

/** 渲染歌词区（滚动高亮列表 / 纯文本降级列表 / 加载中 / 暂无歌词空态） */
function renderLyric() {
  const box = els.npLyricScroll
  if (!box) return
  lyricLineEls = []
  lyricPrevEl = null
  lyricCursor = -1
  // #52 切歌/重渲染重置用户交互锁定：恢复自动跟随 + 清拖拽态（scroll-behavior/cursor 复位）
  lyricUserHold = 0
  lyricDragging = false
  box.classList.remove('dragging')
  const plainMode = lyricState.status === 'plain' && lyricState.plain.length > 0
  box.classList.toggle('plain', plainMode) // 纯文本态：CSS 收拢上下留白（无居中滚动需求）
  if (lyricState.status === 'ok' && lyricState.timed.length) {
    box.innerHTML = lyricState.timed.map((l) => `<p class="np-lyric-line">${escapeHtml(l.text)}</p>`).join('')
    lyricLineEls = Array.from(box.children)
    box.scrollTop = 0
  } else if (plainMode) {
    // 纯文本降级：无时间轴 → 无高亮、无滚动跟随；顶部提示行 + 可手动滚动的静态列表
    box.innerHTML =
      '<p class="np-lyric-note">纯文本歌词 · 无时间轴</p>' +
      lyricState.plain.map((t) => `<p class="np-lyric-line np-lyric-plain">${escapeHtml(t)}</p>`).join('')
    box.scrollTop = 0
  } else if (lyricState.status === 'loading') {
    box.innerHTML = '<div class="np-lyric-tip">歌词加载中…</div>'
  } else {
    // idle（未播放）/ empty（无歌词）/ error 汇归空态，error 附提示
    const err = lyricState.status === 'error' ? '<small>稍后切歌会重试</small>' : ''
    box.innerHTML = `<div class="np-lyric-tip np-lyric-none">♪<br />${lyricState.status === 'error' ? '歌词加载失败' : '暂无歌词'}${err}</div>`
  }
}

/** 切歌/关闭时拉取歌词（trackchange 驱动；异步竞态以 taskId 比对拦截） */
async function loadLyric(taskId) {
  if (!taskId) {
    lyricState = { taskId: null, timed: [], plain: [], status: 'idle' }
    renderLyric()
    return
  }
  lyricState = { taskId, timed: [], plain: [], status: 'loading' }
  renderLyric()
  try {
    const data = await api.lyric.get(taskId)
    if (lyricState.taskId !== taskId) return // 已切歌，丢弃旧响应
    const { timed, plain } = parseLrc(data.lyric)
    // timed 优先（滚动高亮）；timed=0 且 plain>0 → 纯文本降级；皆空 → 暂无歌词
    lyricState = { taskId, timed, plain, status: timed.length ? 'ok' : plain.length ? 'plain' : 'empty' }
  } catch (err) {
    if (lyricState.taskId !== taskId) return
    lyricState = { taskId, timed: [], plain: [], status: err && err.status === 404 ? 'empty' : 'error' }
  }
  renderLyric()
  syncLyric()
}

/** timeupdate 驱动：指针推进当前行 + 居中滚动（reduce 动效时瞬移） */
function syncLyric() {
  // 纯文本（plain）/空态：无时间轴指针，不推进不高亮不滚动，直接返回（seek 亦无害）
  if (lyricState.status !== 'ok' || !lyricState.timed.length) return
  // #52 用户拖拽/滚轮后 3s 内暂停自动跟随（不动指针不高亮不滚动；窗口过后首个 timeupdate 自动恢复）
  if (lyricUserHold && Date.now() - lyricUserHold < LYRIC_FOLLOW_DELAY) return
  const lines = lyricState.timed
  const cur = audio ? audio.currentTime : 0
  if (lyricCursor >= lines.length || (lyricCursor >= 0 && cur < lines[lyricCursor].t)) {
    lyricCursor = -1 // seek 回退：从头重扫
  }
  while (lyricCursor + 1 < lines.length && lines[lyricCursor + 1].t <= cur) lyricCursor++
  if (!lyricLineEls.length) return
  const line = lyricCursor >= 0 ? lyricLineEls[lyricCursor] : null
  if (line === lyricPrevEl) return
  if (lyricPrevEl) lyricPrevEl.classList.remove('cur')
  lyricPrevEl = line
  if (line) {
    line.classList.add('cur')
    const box = els.npLyricScroll
    if (box) {
      // rect 差分算法：不依赖 offsetParent 语义（容器布局再变也稳），scrollTop + 视口内相对偏移 = 行在内容流中的绝对位置
      const top = Math.max(0, box.scrollTop + line.getBoundingClientRect().top - box.getBoundingClientRect().top - box.clientHeight / 2 + line.offsetHeight / 2)
      box.scrollTo({ top, behavior: REDUCED_MOTION.matches ? 'auto' : 'smooth' })
    }
  }
}

/** np 面板「歌词 / 队列」tab 切换（data-tab 驱动 CSS 显隐，面板结构不动） */
function setNpTab(tab) {
  if (els.npPanel) els.npPanel.dataset.tab = tab
  if (els.npTabLyric) {
    els.npTabLyric.classList.toggle('active', tab === 'lyric')
    els.npTabLyric.setAttribute('aria-selected', String(tab === 'lyric'))
  }
  if (els.npTabQueue) {
    els.npTabQueue.classList.toggle('active', tab === 'queue')
    els.npTabQueue.setAttribute('aria-selected', String(tab === 'queue'))
  }
}

// ---------- P2-3 · 频谱可视化（Web Audio AnalyserNode） ----------
const SPEC_BARS = 20
let audioCtx = null      // AudioContext（模块级单例，随首个用户手势创建）
let mediaSrc = null      // MediaElementSource（同 audio 元素只允许创建一次）
let analyserNode = null
let specData = null      // 频域复用缓冲
let specBars = []        // 柱元素缓存（reduce 动效时为空 = 静态三柱降级）
let specRaf = 0
let spectrumDisabled = false // 创建失败后不再重试（静默降级）

/** 频谱柱 DOM：常规 20 根；prefers-reduced-motion 时降级为静态三柱均衡器 */
function initSpectrumDom() {
  const box = els.npSpec
  if (!box) return
  if (REDUCED_MOTION.matches) {
    box.classList.add('static')
    box.innerHTML = '<i></i><i></i><i></i>'
    specBars = []
    return
  }
  const frag = document.createDocumentFragment()
  specBars = Array.from({ length: SPEC_BARS }, () => {
    const i = document.createElement('i')
    frag.appendChild(i)
    return i
  })
  box.appendChild(frag)
}

/**
 * 创建分析链（同源 /api/v1/play 无跨域污染）。MediaElementSource 只能创建一次，
 * 模块级单例；任何一步失败静默降级（不再重试），已建的 source 直连 destination 保底有声。
 */
function ensureAnalyser() {
  if (mediaSrc || spectrumDisabled || !audio) return
  let ctx = null
  let src = null
  try {
    const AC = window.AudioContext || window.webkitAudioContext
    if (!AC) throw new Error('AudioContext unavailable')
    ctx = new AC()
    src = ctx.createMediaElementSource(audio)
    const an = ctx.createAnalyser()
    an.fftSize = 128
    an.smoothingTimeConstant = 0.78
    src.connect(an)
    an.connect(ctx.destination)
    audioCtx = ctx
    analyserNode = an
    mediaSrc = src
    specData = new Uint8Array(an.frequencyBinCount)
  } catch {
    try {
      if (src && ctx) src.connect(ctx.destination) // 保底：不经分析器也必须有声
    } catch {
      /* noop */
    }
    audioCtx = null
    analyserNode = null
    mediaSrc = null
    specData = null
    spectrumDisabled = true
  }
}

function specLoop() {
  if (!analyserNode || !specBars.length || !specData) {
    specRaf = 0
    return
  }
  analyserNode.getByteFrequencyData(specData)
  const n = specBars.length
  const usable = Math.max(1, Math.floor(specData.length * 0.7)) // 高频段常年空置，只用前 70% bins
  for (let i = 0; i < n; i++) {
    // 低频→高频近似对数采样：中低频占更多柱位，视觉分布更均匀
    const bin = Math.min(specData.length - 1, Math.floor(Math.pow((i + 1) / n, 1.6) * usable))
    const v = specData[bin] / 255
    specBars[i].style.height = `${Math.max(4, Math.round(v * 100))}%`
  }
  specRaf = requestAnimationFrame(specLoop)
}

function startSpectrum() {
  if (!specBars.length || specRaf) return
  specRaf = requestAnimationFrame(specLoop)
}

/** 暂停/停止：柱体归零（CSS transition 平滑落下） */
function stopSpectrum() {
  if (specRaf) cancelAnimationFrame(specRaf)
  specRaf = 0
  specBars.forEach((b) => {
    b.style.height = '4%'
  })
}

/** 首个用户手势时初始化分析链（手势栈内创建，AudioContext 直接 running，避免自动播放策略静音） */
function primeAudioGraph() {
  if (REDUCED_MOTION.matches) return
  ensureAnalyser()
  if (audioCtx && audioCtx.state === 'suspended') audioCtx.resume().catch(() => {})
  if (audio && !audio.paused) startSpectrum()
}

// ---------- P2-4 · 黑胶播放态（body.is-playing 驱动 CSS 旋转/停转） ----------
function syncPlayingState() {
  if (!audio) return
  document.body.classList.toggle('is-playing', !audio.paused && !audio.ended)
}

/* ============================================================
   P0 增量：MediaSession / 全局快捷键 / FLAC 提示 / seek 气泡
   （全部新增函数与挂载，不改既有签名与数据流）
   ============================================================ */

/** 播放/暂停切换（#pb-toggle、全局 Space、MediaSession play/pause 共用语义） */
function togglePlayPause() {
  if (!queue.length) return
  if (audio.paused) audio.play().catch(() => {})
  else audio.pause()
}

/** 相对 seek：delta 秒（负值回退）；MediaSession seek* / 全局方向键 / seek 轨键盘共用 */
function seekBy(delta) {
  const dur = audio.duration
  if (!Number.isFinite(dur) || dur <= 0) return
  audio.currentTime = Math.min(Math.max(0, audio.currentTime + delta), dur)
  syncProgress()
}

// ---------- P0-1 · MediaSession（锁屏/系统媒体控件，存在性检测渐进增强） ----------

/** 切歌时同步系统媒体面元数据（artwork：NAS 曲目走 library cover，本地走 /api/v1/cover/:taskId） */
function syncMediaSession(task) {
  if (!('mediaSession' in navigator)) return
  try {
    const m = metaOf(task)
    navigator.mediaSession.metadata = new MediaMetadata({
      title: m.name,
      artist: m.singer,
      album: task.album || '',
      artwork: [{ src: task.coverUrl || `/api/v1/cover/${encodeURIComponent(task.id)}`, sizes: '512x512' }],
    })
  } catch {
    /* MediaMetadata 不可用（旧浏览器）：静默降级 */
  }
}

function syncPlaybackState() {
  if (!('mediaSession' in navigator)) return
  try {
    navigator.mediaSession.playbackState = !audio.paused && !audio.ended ? 'playing' : 'paused'
  } catch {
    /* noop */
  }
}

/** 进度位置同步（duration/playbackRate/position；play/pause/loadedmetadata/seeked/ratechange 驱动） */
function syncPositionState() {
  if (!('mediaSession' in navigator) || !navigator.mediaSession.setPositionState) return
  const dur = audio.duration
  if (!Number.isFinite(dur) || dur <= 0) return
  try {
    navigator.mediaSession.setPositionState({
      duration: dur,
      playbackRate: audio.playbackRate || 1,
      position: Math.min(audio.currentTime, dur),
    })
  } catch {
    /* 非法状态（如 position 越界）：忽略本次 */
  }
}

function bindMediaSession() {
  if (!('mediaSession' in navigator)) return
  const ms = navigator.mediaSession
  const on = (action, fn) => {
    try {
      ms.setActionHandler(action, fn)
    } catch {
      /* 该 action 不受支持：逐个独立降级 */
    }
  }
  on('play', () => {
    if (queue.length && audio.paused) audio.play().catch(() => {})
  })
  on('pause', () => {
    if (!audio.paused) audio.pause()
  })
  on('previoustrack', () => next(-1))
  // 单曲循环语义保持：nexttrack 手动触发仍走 next() 切歌（audio.loop 只拦 ended，不拦手动切歌）
  on('nexttrack', () => next(1))
  on('seekto', (d) => {
    const dur = audio.duration
    if (!d || !Number.isFinite(d.seekTime) || !Number.isFinite(dur) || dur <= 0) return
    audio.currentTime = Math.min(Math.max(0, d.seekTime), dur)
    syncProgress()
    syncPositionState()
  })
  on('seekbackward', (d) => seekBy(-((d && d.seekOffset) || 5)))
  on('seekforward', (d) => seekBy((d && d.seekOffset) || 5))
}

// ---------- P0-6 · FLAC 兼容提示（canPlayType 双检测；首次播 FLAC 提示一次） ----------

/** 双 mime 检测：任一非空即视为可播 */
function canPlayFlac() {
  try {
    return !!(audio.canPlayType('audio/flac') || audio.canPlayType('audio/x-flac'))
  } catch {
    return true // 检测异常按可播处理，避免误报打扰
  }
}

function maybeFlacTip(task) {
  if (canPlayFlac() || !/\.flac$/i.test(String(task.filePath || ''))) return
  try {
    if (store.get(FLAC_TIP_KEY)) return // 已提示过：不再打扰
    store.set(FLAC_TIP_KEY, '1')
  } catch {
    /* 存储不可用：本会话内可能重复提示，可接受 */
  }
  toast('当前浏览器不支持 FLAC 直接播放，建议 Chrome/Edge 或下载后本地播放', 5200)
}

// ---------- P0-2 · 全局键盘快捷键（Space 播放/暂停 · ←→ ±5s · ↑↓ ±5%） ----------

function bindHotkeys() {
  document.addEventListener('keydown', (e) => {
    if (e.ctrlKey || e.metaKey || e.altKey) return // 修饰键组合留给浏览器/系统
    const t = e.target
    if (t) {
      const tag = t.tagName
      // 表单输入豁免：不劫持正文输入
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || t.isContentEditable) return
    }
    const arrow =
      e.key === 'ArrowLeft' || e.key === 'ArrowRight' || e.key === 'ArrowUp' || e.key === 'ArrowDown'
    if (arrow && t && t.closest) {
      // 歌词滚动区方向键 = 手动滚动歌词；滑杆聚焦时本地键盘行为优先（±5%/±5s/Shift ±30s）
      if (t.closest('.np-lyric-scroll') || t.closest('.pb-seek') || t.closest('.pb-voltrack')) return
    }
    switch (e.key) {
      case ' ':
      case 'Spacebar':
        if (e.repeat) return // 按住不连发
        e.preventDefault() // 防页面滚动/聚焦按钮默认激活
        togglePlayPause()
        break
      case 'ArrowLeft':
        e.preventDefault()
        seekBy(-5)
        break
      case 'ArrowRight':
        e.preventDefault()
        seekBy(5)
        break
      case 'ArrowUp':
        e.preventDefault()
        setVolume(audio.volume + 0.05)
        break
      case 'ArrowDown':
        e.preventDefault()
        setVolume(audio.volume - 0.05)
        break
    }
  })
}

// ---------- P0-5 · 进度条悬停/拖拽时间气泡 + seek 键盘 ----------

function bindSeekTip() {
  const track = els.seek
  const tip = document.createElement('span')
  tip.className = 'pb-seek-tip'
  tip.setAttribute('aria-hidden', 'true')
  track.appendChild(tip)

  const dur = () => (Number.isFinite(audio.duration) && audio.duration > 0 ? audio.duration : 0)
  const place = (clientX) => {
    const rect = track.getBoundingClientRect()
    if (rect.width <= 0) return
    const r = clamp01((clientX - rect.left) / rect.width)
    tip.textContent = fmt(r * dur())
    tip.style.left = `${Math.min(Math.max(r * rect.width, 18), rect.width - 18)}px`
  }

  track.addEventListener('pointerenter', (e) => {
    if (!dur()) return
    place(e.clientX)
    track.classList.add('show-tip')
  })
  track.addEventListener('pointermove', (e) => {
    if (!dur()) return
    place(e.clientX)
    if (!track.classList.contains('show-tip')) track.classList.add('show-tip')
  })
  track.addEventListener('pointerleave', () => {
    if (track.classList.contains('dragging')) return // 拖拽中保持（capture 下边界事件不可靠）
    track.classList.remove('show-tip')
  })
  // 拖拽态：把手常放大 + 气泡保持（与 bindSlider 通用逻辑并行，互不侵入）
  track.addEventListener('pointerdown', () => track.classList.add('dragging', 'show-tip'))
  const endDrag = () => track.classList.remove('dragging')
  track.addEventListener('pointerup', endDrag)
  track.addEventListener('pointercancel', endDrag)

  // seek 键盘：←/→ ±5s、Shift+←/→ ±30s（与音量条键盘同范式；全局方向键已豁免本轨）
  track.addEventListener('keydown', (e) => {
    let delta = 0
    if (e.key === 'ArrowRight') delta = e.shiftKey ? 30 : 5
    else if (e.key === 'ArrowLeft') delta = e.shiftKey ? -30 : -5
    else return
    e.preventDefault()
    seekBy(delta)
  })
}

/**
 * 播放队列入口。
 * @param {Array<{id:string,name?:string,singer?:string,filePath?:string}>} list completed 任务列表
 * @param {string} [startId] 从该任务开始；缺省播第一首
 */
export function playQueue(list, startId) {
  if (!inited) init()
  if (!Array.isArray(list) || !list.length) return
  queue = list.slice()
  baseQueue = [] // 新队列：清除旧洗牌基线
  shuffleOn = false
  syncModeButtons()
  let i = 0
  if (startId) {
    const hit = queue.findIndex((t) => t.id === startId)
    if (hit >= 0) i = hit
  }
  closed = false
  setOpen(true)
  syncNav()
  loadAt(i)
}

function next(step) {
  if (!queue.length) return
  let ni = index + step
  if (ni < 0) {
    if (repeatMode !== 'all') {
      // 到头了：停住并复位，不自动循环
      loadAt(Math.max(0, Math.min(index, queue.length - 1)), false)
      audio.pause()
      return
    }
    ni = queue.length - 1 // 列表循环：队首 prev → 队尾
  }
  if (ni >= queue.length) {
    if (repeatMode !== 'all') {
      // 到头了：停住并复位，不自动循环
      loadAt(Math.max(0, Math.min(index, queue.length - 1)), false)
      audio.pause()
      return
    }
    ni = 0 // 列表循环：队尾 → 队首（repeat one 由 audio.loop 原生拦截，ended 不触发）
  }
  loadAt(ni)
}

/** 通用滑杆交互：点击定位 + 按住拖动（指针事件） */
function bindSlider(trackEl, onRatio) {
  const apply = (clientX) => {
    const rect = trackEl.getBoundingClientRect()
    if (rect.width <= 0) return
    onRatio(clamp01((clientX - rect.left) / rect.width))
  }
  trackEl.addEventListener('pointerdown', (e) => {
    e.preventDefault()
    trackEl.setPointerCapture(e.pointerId)
    apply(e.clientX)
    const move = (ev) => apply(ev.clientX)
    const up = (ev) => {
      apply(ev.clientX)
      trackEl.removeEventListener('pointermove', move)
      trackEl.removeEventListener('pointerup', up)
      trackEl.removeEventListener('pointercancel', up)
    }
    trackEl.addEventListener('pointermove', move)
    trackEl.addEventListener('pointerup', up)
    trackEl.addEventListener('pointercancel', up)
  })
}

export function init() {
  if (inited) return
  inited = true
  bar = $('#player-bar')
  audio = $('#pb-audio')
  els = {
    title: $('#pb-title'),
    artist: $('#pb-artist'),
    cover: $('#pb-cover'),
    cur: $('#pb-cur'),
    dur: $('#pb-dur'),
    seek: $('#pb-seek'),
    fill: $('#pb-fill'),
    voltrack: $('#pb-voltrack'),
    volfill: $('#pb-volfill'),
    prev: $('#pb-prev'),
    next: $('#pb-next'),
    icPlay: $('#pb-toggle .ic-play'),
    icPause: $('#pb-toggle .ic-pause'),
    shuffle: $('#pb-shuffle'),
    repeat: $('#pb-repeat'),
    expand: $('#pb-expand'),
    npPanel: $('#np-panel'),
    npClose: $('#np-close'),
    npCover: $('#np-cover'),
    npTitle: $('#np-title'),
    npArtist: $('#np-artist'),
    npQueue: $('#np-queue'),
    npSpec: $('#np-spec'),
    npLyricScroll: $('#np-lyric-scroll'),
    npTabLyric: $('#np-tab-lyric'),
    npTabQueue: $('#np-tab-queue'),
    // #52 np 面板播放控制组（与底部播放条同步联动）
    npPrev: $('#np-prev'),
    npPlay: $('#np-play'),
    npNext: $('#np-next'),
    npIcPlay: $('#np-play .ic-play'),
    npIcPause: $('#np-play .ic-pause'),
  }

  // P0-4：音量记忆恢复（localStorage `rainbow.volume`，缺省 0.8）
  const v0 = readVolume()
  audio.volume = v0
  els.volfill.style.width = `${v0 * 100}%`
  els.voltrack.setAttribute('aria-valuenow', String(Math.round(v0 * 100)))
  els.voltrack.setAttribute('aria-valuetext', `${Math.round(v0 * 100)}%`)

  audio.addEventListener('play', syncToggleIcon)
  audio.addEventListener('pause', syncToggleIcon)
  // P2-4：黑胶播放态同步（body.is-playing 驱动封面旋转/停转）；频谱启停同步启停
  audio.addEventListener('play', () => {
    syncPlayingState()
    if (audioCtx && audioCtx.state === 'suspended') audioCtx.resume().catch(() => {})
    startSpectrum()
  })
  audio.addEventListener('pause', () => {
    syncPlayingState()
    stopSpectrum()
  })
  audio.addEventListener('ended', () => {
    syncPlayingState()
    stopSpectrum()
  })
  audio.addEventListener('emptied', syncPlayingState) // 关闭播放器清 src 时复位
  // 封面：加载成功盖上唱片位；失败（无嵌入/无直链）保持装饰位；成功同时取色写 --ambient
  if (els.cover) {
    els.cover.addEventListener('load', () => {
      els.cover.hidden = false
      sampleAmbient(els.cover)
    })
    els.cover.addEventListener('error', () => {
      els.cover.hidden = true
      resetAmbient()
    })
  }
  audio.addEventListener('timeupdate', syncProgress)
  // P0-1：MediaSession 播放状态与进度位置同步（独立追加监听，不动既有）
  audio.addEventListener('play', () => {
    syncPlaybackState()
    syncPositionState()
  })
  audio.addEventListener('pause', () => {
    syncPlaybackState()
    syncPositionState()
  })
  audio.addEventListener('ended', syncPlaybackState)
  audio.addEventListener('loadedmetadata', syncPositionState)
  audio.addEventListener('seeked', syncPositionState)
  audio.addEventListener('ratechange', syncPositionState)
  // P2-2：歌词逐行推进（新增监听，不影响既有 syncProgress）
  audio.addEventListener('timeupdate', syncLyric)
  audio.addEventListener('loadedmetadata', () => {
    syncProgress()
    emitMetadata()
  })
  audio.addEventListener('ended', () => next(1))
  audio.addEventListener('error', () => {
    if (closed || !audio.src) return
    syncToggleIcon()
    toast('播放失败：音频不可用或会话已过期')
  })

  $('#pb-toggle').addEventListener('click', togglePlayPause)
  $('#pb-prev').addEventListener('click', () => next(-1))
  $('#pb-next').addEventListener('click', () => next(1))

  // P1 增量挂载：shuffle / repeat / 面板开合与队列切歌
  if (els.shuffle) els.shuffle.addEventListener('click', toggleShuffle)
  if (els.repeat) els.repeat.addEventListener('click', cycleRepeat)
  if (els.expand) els.expand.addEventListener('click', () => setNpOpen(!npOpen))
  if (els.npClose) els.npClose.addEventListener('click', () => setNpOpen(false))
  // #52 np 面板播放控制组（与底部播放条同一套行为：切换/上/下一首）
  if (els.npPlay) els.npPlay.addEventListener('click', togglePlayPause)
  if (els.npPrev) els.npPrev.addEventListener('click', () => next(-1))
  if (els.npNext) els.npNext.addEventListener('click', () => next(1))
  if (els.npQueue) {
    els.npQueue.addEventListener('click', (e) => {
      const btn = e.target.closest('.np-item')
      if (!btn) return
      const i = queue.findIndex((t) => t.id === btn.dataset.id)
      if (i >= 0) loadAt(i)
    })
  }
  if (els.npCover) {
    els.npCover.addEventListener('load', () => {
      els.npCover.hidden = false
    })
    els.npCover.addEventListener('error', () => {
      els.npCover.hidden = true
    })
  }

  // P2 增量挂载：歌词 sidecar + 频谱 + tab 切换
  // 歌词拉取由既有 player:trackchange 事件驱动（loadAt/关闭时派发），切歌自动重拉
  document.addEventListener('player:trackchange', (e) => {
    loadLyric(e.detail && e.detail.taskId)
  })
  renderLyric()
  initSpectrumDom()
  // #52 歌词区拖拽滚动 + 用户交互暂停自动跟随
  bindLyricDrag()
  if (els.npTabLyric) els.npTabLyric.addEventListener('click', () => setNpTab('lyric'))
  if (els.npTabQueue) els.npTabQueue.addEventListener('click', () => setNpTab('queue'))
  // 频谱分析链在首个用户手势（pointerdown 捕获阶段）初始化，确保 AudioContext 在手势栈内创建
  document.addEventListener('pointerdown', primeAudioGraph, { capture: true })

  // 进度滑杆：点击/拖动定位
  bindSlider(els.seek, (r) => {
    if (!Number.isFinite(audio.duration) || audio.duration <= 0) return
    audio.currentTime = r * audio.duration
    syncProgress()
  })

  // 音量滑杆（小号同款）
  bindSlider(els.voltrack, (r) => setVolume(r))

  // 音量键盘支持：左右方向键 ±5%
  els.voltrack.addEventListener('keydown', (e) => {
    let delta = 0
    if (e.key === 'ArrowRight' || e.key === 'ArrowUp') delta = 0.05
    else if (e.key === 'ArrowLeft' || e.key === 'ArrowDown') delta = -0.05
    else return
    e.preventDefault()
    setVolume(audio.volume + delta)
  })

  // P0 增量挂载：进度气泡 + seek 键盘 / 全局快捷键 / MediaSession handlers
  bindSeekTip()
  bindHotkeys()
  bindMediaSession()

  // 关闭：停止播放并收起
  $('#pb-close').addEventListener('click', () => {
    closed = true
    queue = []
    index = -1
    currentTaskId = null
    audio.pause()
    audio.removeAttribute('src')
    audio.load()
    if (els.cover) {
      els.cover.removeAttribute('src')
      els.cover.hidden = true
    }
    els.title.textContent = '未在播放'
    els.artist.textContent = ''
    els.fill.style.width = '0%'
    els.cur.textContent = '0:00'
    els.dur.textContent = '0:00'
    // P1：播放模式 / 面板 / 氛围色复位
    shuffleOn = false
    repeatMode = 'off'
    baseQueue = []
    syncModeButtons()
    resetAmbient()
    setNpOpen(false)
    if (els.npTitle) els.npTitle.textContent = '未在播放'
    if (els.npArtist) els.npArtist.textContent = '从「本地收藏」选一首开始吧'
    if (els.npCover) {
      els.npCover.removeAttribute('src')
      els.npCover.hidden = true
    }
    renderNpQueue()
    syncToggleIcon()
    syncNav()
    emitTrackChange()
    setOpen(false)
    document.title = 'Rainbow 音乐播放器'
    // P0-1：关闭播放器时清系统媒体面元数据与状态
    if ('mediaSession' in navigator) {
      try {
        navigator.mediaSession.metadata = null
        navigator.mediaSession.playbackState = 'none'
      } catch {
        /* noop */
      }
    }
  })

  // P0-7：np 面板开合记忆恢复（仅 ≥1280px；窄屏面板整体隐藏不恢复，遵守现有隐藏逻辑）
  if (window.innerWidth >= 1280) {
    let npSaved = '0'
    try {
      npSaved = store.get(NP_OPEN_KEY) || '0'
    } catch {
      /* 存储不可用：不恢复 */
    }
    if (npSaved === '1') setNpOpen(true)
  }
}
