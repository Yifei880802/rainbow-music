/**
 * 歌单页：创建 / 查看 / 整单下载 / 删除；详情内单曲下载与移除
 * 行内 .row-dl 单首下载钮复用 search.js 模式（api.download.batch 单元素提交）。
 * #69 详情行三态 + 已入库直接播（与 home.js #69 同构的表格行版）：
 * 进详情拉 GET /tasks 建 owned map（platform:songmid → 代表任务，
 * done>busy>failed 优先、同档取 updatedAt 新），行状态实时三态
 * （未下载=下载钮 / 下载中=进度环 / 已下载=绿勾 hover 播放三角）；
 * SSE task 事件/progress 局部更新对应行（订阅在 init 一次注册 +
 * plViewActive 守卫，全局单连接复用 library.js 范式无泄漏）；已下载行
 * 点击（或绿勾钮）直接 player.playQueue 入队（DOM 行序），now-playing
 * 高亮联动 player:trackchange。
 * #53 P1a 封面强化：卡片 .am-mosaic 取前 4 首关联任务封面 /api/v1/cover/:taskId
 * 2×2 拼贴（无封面回退 CSS 渐变）；详情行封面三级优先：
 * 任务匹配 cover 接口 → musicInfo.img 直链 → 音符装饰位。
 * #57 拖拽排序：每行手柄（≡，hover 显示）mousedown 置 tr.draggable，
 * HTML5 dragstart/dragover/drop 重排（目标位指示线）；drop 后乐观更新
 * DOM + PUT /items/order 落库，失败 openPlaylist 重拉回滚 + toast；
 * ≤900px 触屏隐藏手柄（触屏拖拽后续迭代）。
 */
import { $, $$, escapeHtml, toast, PLATFORM_NAME, confirmModal } from '../ui.js'
import { api } from '../api.js'
import * as sse from '../sse.js'
import * as player from '../player.js'

const isDone = (t) => t.status === 'completed' || t.status === 'completed_with_warnings'

// ---------- #69 详情行三态（owned map / SSE 联动 / 直接播放；与 home.js 同构） ----------
/** 任务进行态（下载中：环脉冲） */
const isBusy = (t) => !!t && (t.status === 'pending' || t.status === 'active')
/** 行状态代表任务优先级：done > busy > failed/canceled（同档取 updatedAt 新） */
const PL_STATUS_RANK = { completed: 3, completed_with_warnings: 3, active: 2, pending: 2, failed: 1, canceled: 0 }
/** 28px 进度环 r=9 周长（2πr≈56.55，同 home.js HP_RING_LEN） */
const PL_RING_LEN = 56.55
/** SSE task 事件清单（负载=完整任务视图，sse.js EVENT_NAMES 同源子集） */
const PL_TASK_EVENTS = [
  'task:created', 'task:pending', 'task:active', 'task:completed',
  'task:completed_with_warnings', 'task:failed', 'task:canceled',
]

/** 歌单项匹配键（platform:songmid，与任务视图对齐） */
const plItemKey = (it) => `${it.platform}:${it.musicInfo?.songmid}`

/** 详情会话期状态：owned map（key → 代表任务视图）+ 行序曲目快照（反查 name/singer 用） */
let plOwned = new Map()
let plItems = []

/** 代表任务合并入 map（新视图优先于旧值，同曲多任务保留最高优先级） */
function plMerge(map, view) {
  if (!view || !view.id || !view.platform || !view.songmid) return
  const key = `${view.platform}:${view.songmid}`
  const prev = map.get(key)
  if (!prev) {
    map.set(key, view)
    return
  }
  const pr = PL_STATUS_RANK[prev.status] ?? 0
  const nr = PL_STATUS_RANK[view.status] ?? 0
  if (nr > pr || (nr === pr && (view.updatedAt || 0) >= (prev.updatedAt || 0))) map.set(key, view)
}

const plUpsert = (view) => plMerge(plOwned, view)

/** 详情可见守卫（歌单页激活且详情面板展开；离开视图零开销） */
function plViewActive() {
  return !$('#playlist-detail').hidden && !!$('#view-playlists')?.classList.contains('active')
}

let dragRow = null // 拖拽中的行（tr[data-item]）

export function init() {
  $('#refresh-playlists').addEventListener('click', loadPlaylists)
  $('#create-playlist').addEventListener('click', onCreate)
  $('#playlists').addEventListener('click', onCardAction)
  $('#playlist-detail').addEventListener('click', onDetailAction)
  // #57 拖拽排序（事件委托：详情容器固定，tbody 每次 openPlaylist 重建）
  const detail = $('#playlist-detail')
  detail.addEventListener('mousedown', onDragHandleDown)
  detail.addEventListener('dragstart', onDragStart)
  detail.addEventListener('dragover', onDragOver)
  detail.addEventListener('drop', onDrop)
  detail.addEventListener('dragend', onDragEnd)
  detail.addEventListener('mouseup', () => {
    // mousedown 后未启动拖拽（点了没拖）：复位 draggable
    if (!dragRow) resetDraggable()
  })
  // #69 SSE 联动（init 一次性注册 + plViewActive 守卫，全局单连接复用 library.js 范式无泄漏）
  for (const ev of PL_TASK_EVENTS) sse.on(ev, onPlTaskEvent)
  sse.on('task:progress', onPlTaskProgress)
  sse.on('connected', onPlSseConnected)
  document.addEventListener('player:trackchange', (e) => highlightPlNowPlaying(e.detail?.taskId ?? null))
}

export function show() {
  loadPlaylists()
}

async function onCreate() {
  const name = $('#new-playlist-name').value.trim()
  if (!name) return toast('请输入歌单名称')
  try {
    await api.playlists.create({ name })
    $('#new-playlist-name').value = ''
    toast('已创建')
    loadPlaylists()
  } catch (err) {
    toast(err.message)
  }
}

async function loadPlaylists() {
  $('#playlist-detail').hidden = true
  plItems = [] // #69：离开详情清快照（SSE 守卫兜底，双保险）
  plOwned = new Map()
  try {
    const r = await api.playlists.list()
    await renderPlaylists(r.playlists || [])
  } catch (err) {
    $('#playlists').innerHTML = `<div class="empty">加载失败: ${escapeHtml(err.message)}</div>`
  }
}

/** 封面拼贴 img：onerror 逐张移除并重算 data-n（槽位自动坍缩：4→3→…→0 全回退渐变） */
const MOSAIC_ERR = "const m=this.closest('.am-mosaic');this.remove();if(m)m.dataset.n=String(m.querySelectorAll('img').length)"

async function renderPlaylists(pls) {
  $('#playlists-summary').textContent = `共 ${pls.length} 个歌单`
  const c = $('#playlists')
  if (!pls.length) {
    c.innerHTML = '<div class="empty">暂无歌单，点上方创建</div>'
    return
  }
  // #53 拼贴取材：任务映射 + 每单详情（list 不带 items，需逐单 get；
  // 单拿失败仅该单回退渐变，不影响整页）
  const [owned, details] = await Promise.all([
    ownedTaskMap(),
    Promise.all(pls.map((p) => api.playlists.get(String(p.id)).catch(() => null))),
  ])
  c.innerHTML = ''
  for (let i = 0; i < pls.length; i++) {
    const p = pls[i]
    // #66 拼贴取材增强：已收藏任务 → /api/v1/cover/:taskId（APIC/FLAC PICTURE/302 直链）
    // 优先；未收藏（榜单保存的歌单歌曲多未下载）→ musicInfo.img 直链补位——
    // 保存即有封面拼贴，不依赖先下载；两者皆无/加载失败回退渐变（onerror 坍缩）
    const srcs = []
    for (const it of details[i]?.items || []) {
      const t = owned.get(plItemKey(it)) // #69 map 值升级为任务视图：拼贴仍只取 done 任务封面
      const tid = t && isDone(t) ? t.id : ''
      const img = it.musicInfo?.img
      const pic = typeof img === 'string' && /^https?:\/\//i.test(img) ? img : ''
      const src = tid ? `/api/v1/cover/${encodeURIComponent(tid)}` : pic
      if (src && !srcs.includes(src)) srcs.push(src)
      if (srcs.length >= 4) break
    }
    const mosaic = `<div class="am-mosaic" data-n="${srcs.length}">${srcs
      .map(
        (src) =>
          `<img src="${escapeHtml(src)}" alt="" loading="lazy" referrerpolicy="no-referrer" onerror="${MOSAIC_ERR}" />`,
      )
      .join('')}</div>`
    const card = document.createElement('div')
    card.className = 'src-card'
    card.innerHTML = `
      ${mosaic}
      <div class="src-head">
        <div><b>${escapeHtml(p.name)}</b> <span class="badge">${p.count} 首</span></div>
        <div class="src-act">
          <button data-open="${escapeHtml(String(p.id))}">查看</button>
          <button data-dl="${escapeHtml(String(p.id))}">整单下载</button>
          <button data-del="${escapeHtml(String(p.id))}" class="danger-lite">删除</button>
        </div>
      </div>
      ${p.description ? `<div class="src-desc">${escapeHtml(p.description)}</div>` : ''}`
    c.appendChild(card)
  }
}

/** 歌单卡片操作（事件委托） */
async function onCardAction(e) {
  const btn = e.target.closest('button[data-open], button[data-dl], button[data-del]')
  if (!btn) return
  const id = btn.dataset.open || btn.dataset.dl || btn.dataset.del
  try {
    if (btn.dataset.open !== undefined) {
      openPlaylist(id)
    } else if (btn.dataset.dl !== undefined) {
      const r = await api.playlists.download(id, { quality: $('#quality').value })
      toast(`已提交 ${r.acceptedCount} 首`)
    } else if (btn.dataset.del !== undefined) {
      if (!(await confirmModal('确认删除该歌单？其中的歌曲记录一并删除。', { danger: true, okLabel: '删除' }))) return
      await api.playlists.remove(id)
      toast('已删除')
      loadPlaylists()
    }
  } catch (err) {
    toast(err.message)
  }
}

/** 任务映射（platform:songmid → 代表任务视图；#69 由 key→taskId 升级为
 * 全量状态——拼贴/封面处自行过滤 isDone，详情行三态用完整视图；
 * 拿不到任务列表时返回空 Map，仅失去拼贴/置灰/三态，行为回退全可下载） */
async function ownedTaskMap() {
  try {
    const r = await api.tasks.list()
    const m = new Map()
    for (const t of r.tasks || []) plMerge(m, t)
    return m
  } catch {
    return new Map()
  }
}

async function openPlaylist(id) {
  try {
    const [p, owned] = await Promise.all([api.playlists.get(id), ownedTaskMap()])
    const detail = $('#playlist-detail')
    detail.hidden = false
    detail.dataset.pid = id
    // #69：详情会话快照（owned map 全量状态 + 行序曲目，SSE 增量/播放队列共用）
    plOwned = owned
    plItems = p.items || []
    const rows = plItems
      .map(
        (it, idx) => {
          const t = plOwned.get(plItemKey(it))
          // #53 封面三级优先：已收藏任务 → /api/v1/cover/:taskId（嵌入 APIC / musicInfo.img 302 直链）；
          // 未收藏 → musicInfo.img 直链（与 cover 同源字段）；都无 / 加载失败回退音符装饰位
          const taskId = isDone(t) ? t.id : ''
          const img = it.musicInfo?.img
          const pic = typeof img === 'string' && /^https?:\/\//i.test(img) ? img : ''
          const coverSrc = taskId ? `/api/v1/cover/${encodeURIComponent(taskId)}` : pic
          return `
      <tr data-item="${escapeHtml(String(it.id))}" data-key="${escapeHtml(plItemKey(it))}"${isDone(t) ? ' title="已下载 · 点击播放"' : ''}>
        <td class="pd-drag"><span class="pd-handle" title="拖拽调整顺序" aria-hidden="true"><svg viewBox="0 0 12 12" width="12" height="12" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" aria-hidden="true"><path d="M2 3h8M2 6h8M2 9h8"/></svg></span></td>
        <td class="pd-num">${idx + 1}</td>
        <td class="pd-cover">
          <span class="pd-cover-slot" aria-hidden="true">
            <svg class="pd-note" viewBox="0 0 24 24" width="15" height="15"><path d="M9 18V6l10-2v11.5" stroke="currentColor" stroke-width="1.6" fill="none" stroke-linecap="round" stroke-linejoin="round"/><circle cx="6.5" cy="18" r="2.5" fill="currentColor"/><circle cx="16.5" cy="15.5" r="2.5" fill="currentColor"/></svg>
            ${coverSrc ? `<img src="${escapeHtml(coverSrc)}" alt="" loading="lazy" referrerpolicy="no-referrer" onerror="this.remove()" />` : ''}
          </span>
        </td>
        <td class="pd-song">
          <div class="pd-name">${escapeHtml(it.name)}</div>
          <div class="pd-artist">${escapeHtml(it.singer || '未知艺术家')}</div>
        </td>
        <td class="pd-plat">${PLATFORM_NAME[it.platform] || escapeHtml(it.platform)}</td>
        <td class="act">
          ${plStateBtn(it, t)}
          <button data-rm="${escapeHtml(String(it.id))}">移除</button>
        </td>
      </tr>`
        },
      )
      .join('')
    detail.innerHTML = `
      <h3 class="detail-title">${escapeHtml(p.name)} · ${p.items.length} 首</h3>
      ${
        p.items.length
          ? `<div class="table-wrap"><table><thead><tr><th class="th-drag"></th><th class="th-num">#</th><th class="th-cover"></th><th>歌曲</th><th>平台</th><th>操作</th></tr></thead><tbody>${rows}</tbody></table></div>`
          : '<div class="empty">空歌单，去搜索页勾选歌曲「加入歌单」</div>'
      }`
  } catch (err) {
    toast(err.message)
  }
}

/** 歌单详情操作（事件委托；#69：状态钮三态 + 行点击直接播） */
async function onDetailAction(e) {
  const detail = $('#playlist-detail')
  const pid = detail.dataset.pid
  if (!pid) return
  const btn = e.target.closest('button[data-song], button[data-rm], button[data-play]')
  if (btn) {
    if (btn.disabled) return
    try {
      if (btn.dataset.play) {
        // #69 已下载绿勾钮：直接播放（与行点击同链路）
        playPlQueue(btn.dataset.play)
      } else if (btn.dataset.song) {
        // 单首下载：复用 search.js 的 onRowDownload 模式（batch 单元素提交）
        const payload = JSON.parse(decodeURIComponent(btn.dataset.song))
        btn.disabled = true
        try {
          const r = await api.download.batch({ items: [payload], quality: $('#quality').value })
          if (r.acceptedCount) {
            const tid = r.accepted?.[0]?.id
            const key = `${payload.platform}:${payload.musicInfo?.songmid}`
            if (tid) {
              // #69 乐观入 owned（pending 态）：行立即变进度环；SSE task:* 随后接管
              const it = plItems.find((x) => plItemKey(x) === key)
              plUpsert({
                id: tid,
                platform: payload.platform,
                songmid: String(payload.musicInfo?.songmid ?? ''),
                name: it?.name || payload.musicInfo?.name || '',
                singer: it?.singer || payload.musicInfo?.artist || '',
                status: 'pending',
                progress: 0,
                updatedAt: Date.now(),
              })
              const row = btn.closest('tr[data-item]')
              if (row) applyPlRowState(row, plOwned.get(key))
            } else {
              btn.title = '已入队，下载中…'
            }
            toast('已提交下载')
          } else {
            toast('该曲目下载被拒绝')
            btn.disabled = false
          }
        } catch (err) {
          toast(`下载失败: ${err.message}`)
          btn.disabled = false
        }
      } else if (btn.dataset.rm) {
        await api.playlists.removeItem(pid, btn.dataset.rm)
        toast('已移除')
        openPlaylist(pid)
      }
    } catch (err) {
      toast(err.message)
    }
    return
  }
  // #69 行点击（非按钮/拖拽手柄区）三态分流：已下载→直接播；下载中→提示；未下载→下载引导
  if (e.target.closest('.pd-handle')) return
  const row = e.target.closest('tr[data-item]')
  if (!row || !row.dataset.key) return
  const t = plOwned.get(row.dataset.key)
  if (isDone(t)) return playPlQueue(t.id)
  if (isBusy(t)) return toast('下载中…完成后点击行即可播放')
  toast('未下载歌曲点击行内 ⬇ 下载；已下载歌曲点击即播')
}

/* ============================================================
   #69 · 详情行三态控件 + SSE 联动 + 直接播放（与 home.js 同构的表格行版）
   ============================================================ */

/** 行状态位控件：未下载=下载钮 / 下载中=进度环脉冲 / 已下载=绿勾 hover 播放三角 */
function plStateBtn(it, t) {
  if (isDone(t)) {
    return `<button class="row-dl done" data-play="${escapeHtml(String(t.id))}" type="button" aria-label="播放已下载的 ${escapeHtml(it.name)}" title="已下载到本地 · 点击播放"><svg class="ic-ok" viewBox="0 0 12 12" width="12" height="12" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M2 6.5l2.6 2.6L10 3.5"/></svg><svg class="ic-go" viewBox="0 0 12 12" width="11" height="11" fill="currentColor" aria-hidden="true"><path d="M3 1.5v9l7.5-4.5z"/></svg></button>`
  }
  if (isBusy(t)) {
    const pct = t.progress || 0
    return `<button class="row-dl hp-dl-ing" data-task="${escapeHtml(String(t.id))}" type="button" disabled title="下载中 ${pct}%"><svg class="hp-ring" viewBox="0 0 28 28" width="16" height="16" aria-hidden="true"><circle class="hp-ring-track" cx="14" cy="14" r="9" /><circle class="hp-ring-fill" cx="14" cy="14" r="9" style="stroke-dasharray:${PL_RING_LEN};stroke-dashoffset:${(PL_RING_LEN * (1 - pct / 100)).toFixed(2)}" /></svg></button>`
  }
  const failed = t && (t.status === 'failed' || t.status === 'canceled')
  const payload = encodeURIComponent(JSON.stringify({ platform: it.platform, musicInfo: it.musicInfo }))
  return `<button class="row-dl" data-song="${escapeHtml(payload)}" type="button" aria-label="下载 ${escapeHtml(it.name)}" title="${failed ? '上次下载未完成，点击重试' : '下载这首'}"><svg viewBox="0 0 12 12" width="11" height="11" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M6 1.5v7M3 6l3 3 3-3M2 10.5h8"/></svg></button>`
}

/** SSE 事件局部更新：只替换操作列状态钮 + 行 title（不重建表格行） */
function applyPlRowState(row, t) {
  const it = plItems.find((x) => plItemKey(x) === row.dataset.key)
  if (!it) return
  const btn = row.querySelector('td.act .row-dl')
  if (btn) btn.outerHTML = plStateBtn(it, t)
  row.title = isDone(t) ? '已下载 · 点击播放' : isBusy(t) ? '下载中…' : ''
}

/** 详情内已下载曲目构建播放队列（DOM 行序，拖拽排序后即时生效）并从 startTaskId 播起 */
function playPlQueue(startTaskId) {
  const q = $$('#playlist-detail tr[data-key]')
    .map((row) => plOwned.get(row.dataset.key))
    .filter((t) => isDone(t))
  if (!q.length) return toast('当前歌单还没有已下载歌曲，先点行内 ⬇ 下载')
  player.playQueue(q, startTaskId)
}

/** task 事件（负载=完整任务视图）：upsert owned → 命中行局部更新（下载中→已下载跃迁即时可见） */
function onPlTaskEvent(view) {
  if (!plViewActive() || !view || !view.id) return
  plUpsert(view)
  const key = `${view.platform}:${view.songmid}`
  const row = document.querySelector(`#playlist-detail tr[data-key="${CSS.escape(key)}"]`)
  if (row) applyPlRowState(row, plOwned.get(key))
}

/** task:progress（负载 {id, received, total, percent}）：只推进度环 + title，免整行重渲染 */
function onPlTaskProgress(p) {
  if (!plViewActive() || !p || !p.id) return
  for (const t of plOwned.values()) {
    if (t.id === p.id) {
      t.progress = p.percent
      break
    }
  }
  const btn = document.querySelector(`#playlist-detail [data-task="${CSS.escape(p.id)}"]`)
  if (!btn) return
  const fill = btn.querySelector('.hp-ring-fill')
  if (fill) fill.style.strokeDashoffset = (PL_RING_LEN * (1 - (p.percent || 0) / 100)).toFixed(2)
  btn.title = `下载中 ${p.percent || 0}%`
}

/** SSE 重连成功（服务端约定 connected → 全量对账）：详情态重拉任务快照刷新全行 */
function onPlSseConnected() {
  if (!plViewActive()) return
  void ownedTaskMap().then((m) => {
    plOwned = m
    if (plViewActive()) $$('#playlist-detail tr[data-key]').forEach((row) => applyPlRowState(row, plOwned.get(row.dataset.key)))
  })
}

/** player:trackchange 联动：当前播放行高亮（taskId 经 owned 反查 key 后按 data-key 匹配） */
function highlightPlNowPlaying(taskId) {
  let key = null
  if (taskId) {
    for (const [k, t] of plOwned) {
      if (t.id === taskId) {
        key = k
        break
      }
    }
  }
  $$('#playlist-detail tr[data-key]').forEach((row) => {
    row.classList.toggle('now-playing', !!key && row.dataset.key === key)
  })
}

/* ============================================================
   #57 · 歌单拖拽排序（HTML5 DnD，事件委托在 #playlist-detail 上）
   - 仅手柄 mousedown 置 tr.draggable=true，行内下载/移除等交互不受影响；
   - dragover 依鼠标在目标行上/下半部计算插入位，指示线 drop-before/after；
   - drop：乐观 DOM 重排 + 重编号 → PUT /items/order 落库；
     失败 openPlaylist 重拉渲染回滚 + toast；零首/一首歌单自然无操作。
   ============================================================ */
function resetDraggable() {
  $('#playlist-detail tbody')?.querySelectorAll('tr[draggable]').forEach((r) => (r.draggable = false))
}

function clearDropMarks() {
  $('#playlist-detail tbody')?.querySelectorAll('tr.drop-before, tr.drop-after').forEach((r) => {
    r.classList.remove('drop-before', 'drop-after')
  })
}

/** 拖拽后重编行号（.pd-num） */
function renumberRows(tbody) {
  tbody.querySelectorAll('tr[data-item]').forEach((tr, i) => {
    const num = tr.querySelector('.pd-num')
    if (num) num.textContent = i + 1
  })
}

function onDragHandleDown(e) {
  const handle = e.target.closest('.pd-handle')
  if (!handle) return
  const tr = handle.closest('tr[data-item]')
  if (tr) tr.draggable = true // 仅手柄按下允许整行拖拽
}

function onDragStart(e) {
  const tr = e.target.closest('tr[data-item]')
  if (!tr || !tr.draggable) return
  dragRow = tr
  tr.classList.add('dragging')
  e.dataTransfer.effectAllowed = 'move'
  e.dataTransfer.setData('text/plain', tr.dataset.item) // Firefox 需 setData 才启动拖拽
}

function onDragOver(e) {
  if (!dragRow) return
  e.preventDefault() // 允许放置
  e.dataTransfer.dropEffect = 'move'
  const over = e.target.closest('tr[data-item]')
  clearDropMarks()
  if (!over || over === dragRow) return
  const rect = over.getBoundingClientRect()
  over.classList.add(e.clientY < rect.top + rect.height / 2 ? 'drop-before' : 'drop-after')
}

async function onDrop(e) {
  if (!dragRow) return
  e.preventDefault()
  const tr = dragRow
  const tbody = tr.parentNode
  const over = e.target.closest('tr[data-item]')
  const pid = $('#playlist-detail').dataset.pid
  const dragId = tr.dataset.item
  const prevIds = [...tbody.querySelectorAll('tr[data-item]')].map((r) => r.dataset.item) // 拖拽前快照（失败回滚用，不依赖重拉）
  // 计算新顺序（ids）；目标无效（拖到表格外/自身）则保持原序
  const ids = [...prevIds]
  let moved = false
  if (over && over !== tr) {
    const before = over.classList.contains('drop-before')
    ids.splice(ids.indexOf(dragId), 1)
    let to = ids.indexOf(over.dataset.item)
    if (!before) to++
    ids.splice(to, 0, dragId)
    moved = true
  }
  cleanupDrag()
  if (!moved || !pid || ids.length < 2) return
  // 乐观 DOM 重排（按 ids 顺序重新 append）+ 重编号
  const rowMap = new Map([...tbody.querySelectorAll('tr[data-item]')].map((r) => [r.dataset.item, r]))
  const applyOrder = (order) => {
    for (const id of order) {
      const r = rowMap.get(id)
      if (r) tbody.appendChild(r)
    }
    renumberRows(tbody)
  }
  applyOrder(ids)
  try {
    await api.playlists.orderItems(pid, ids)
    toast('顺序已保存')
  } catch (err) {
    toast(`顺序保存失败，已回滚: ${err.message}`)
    applyOrder(prevIds) // 本地恢复拖拽前顺序（重拉可能同样失败，如离线）
  }
}

function onDragEnd() {
  cleanupDrag()
}

function cleanupDrag() {
  if (dragRow) dragRow.classList.remove('dragging')
  dragRow = null
  clearDropMarks()
  resetDraggable()
}
