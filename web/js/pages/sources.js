/**
 * 音源管理页：URL 导入 / 文件上传 / 启停 / 重载 / 删除
 * 附带 SSE source:changed 自动刷新
 * #56：一键快速冒烟（POST /api/v1/sources/smoke 同步返回矩阵，
 *     每格 搜索/取链 双态；冒烟全败的音源联动提示建议禁用）
 */
import { $, escapeHtml, toast, confirmModal, PLATFORM_NAME } from '../ui.js'
import { api } from '../api.js'
import * as sse from '../sse.js'

export function init() {
  $('#refresh-sources').addEventListener('click', loadSources)
  $('#src-url-btn').addEventListener('click', onImportUrl)
  $('#src-file-btn').addEventListener('click', onUploadFile)
  $('#sources').addEventListener('click', onCardAction)
  $('#sources').addEventListener('change', onToggle)
  $('#src-smoke').addEventListener('click', onQuickSmoke)
  // 音源目录有变动（导入/删除/热重载）时自动刷新
  sse.on('source:changed', loadSources)
}

export function show() {
  loadSources()
}

async function onImportUrl() {
  const url = $('#src-url').value.trim()
  const name = $('#src-url-name').value.trim()
  if (!url) return toast('请输入 URL')
  const btn = $('#src-url-btn')
  btn.disabled = true
  try {
    const r = await api.sources.importUrl({ url, name: name || undefined })
    toast(`已导入: ${r.name}`)
    $('#src-url').value = ''
    $('#src-url-name').value = ''
    loadSources()
  } catch (err) {
    toast(`导入失败: ${err.message}`)
  } finally {
    btn.disabled = false
  }
}

async function onUploadFile() {
  const f = $('#src-file').files[0]
  if (!f) return toast('请选择 .js 文件')
  const btn = $('#src-file-btn')
  btn.disabled = true
  try {
    const r = await api.sources.upload(f)
    toast(`已上传: ${r.name}`)
    $('#src-file').value = ''
    loadSources()
  } catch (err) {
    toast(`上传失败: ${err.message}`)
  } finally {
    btn.disabled = false
  }
}

async function loadSources() {
  try {
    const r = await api.sources.list()
    renderSources(r.sources || [])
  } catch (err) {
    $('#sources').innerHTML = `<div class="empty">加载失败: ${escapeHtml(err.message)}</div>`
  }
}

/** P1b：脚本状态中文标签（脚本 ready ≠ 链路可用，以冒烟矩阵为准） */
const SRC_STATUS_LABEL = { ready: '运行中', error: '不可用', loading: '加载中' }

function renderSources(sources) {
  $('#sources-summary').textContent = `共 ${sources.length} 个音源`
  const container = $('#sources')
  if (!sources.length) {
    container.innerHTML = '<div class="empty">暂无音源，请从上方导入</div>'
    return
  }
  container.innerHTML = ''
  for (const s of sources) {
    const card = document.createElement('div')
    // P1b：失效（error）或已禁用的音源卡片整体降透明度 + 左侧红条，一眼识别不可用
    const dead = s.status === 'error' || !s.enabled
    card.className = `src-card${dead ? ' src-card--dead' : ''}`
    const platforms = (s.platforms || [])
      .map((p) => `<span class="badge q">${escapeHtml(p.platform)}: ${escapeHtml((p.qualitys || []).join('/') || (p.actions || []).join('/'))}</span>`)
      .join(' ')
    const statusCls = s.status === 'ready' ? 'completed' : s.status === 'error' ? 'failed' : 'pending'
    card.innerHTML = `
      <div class="src-head">
        <div>
          <b>${escapeHtml(s.name)}</b>
          <span class="badge">v${escapeHtml(s.version || '?')}</span>
          <span class="st ${statusCls}">${escapeHtml(SRC_STATUS_LABEL[s.status] || s.status)}</span>
          ${s.enabled ? '' : '<span class="st canceled">已禁用</span>'}
        </div>
        <div class="src-act">
          <label class="switch"><input type="checkbox" data-toggle="${escapeHtml(s.id)}" ${s.enabled ? 'checked' : ''}/> 启用</label>
          <button data-reload="${escapeHtml(s.id)}">重载</button>
          <button data-del="${escapeHtml(s.id)}" class="danger-lite">删除</button>
        </div>
      </div>
      ${s.description ? `<div class="src-desc">${escapeHtml(s.description)}${s.author ? ' · ' + escapeHtml(s.author) : ''}</div>` : ''}
      ${s.errorMessage ? `<div class="src-err">错误: ${escapeHtml(s.errorMessage)}</div>` : ''}
      <div class="src-plats">${platforms}</div>`
    container.appendChild(card)
  }
}

/** 启停开关（change 事件委托） */
async function onToggle(e) {
  const cb = e.target.closest('input[data-toggle]')
  if (!cb) return
  try {
    await api.sources.setEnabled(cb.dataset.toggle, cb.checked)
    toast(cb.checked ? '已启用' : '已禁用')
  } catch (err) {
    toast(err.message)
    cb.checked = !cb.checked
  }
}

/** 卡片按钮（click 事件委托） */
async function onCardAction(e) {
  const btn = e.target.closest('button[data-reload], button[data-del]')
  if (!btn) return
  try {
    if (btn.dataset.reload) {
      await api.sources.reload(btn.dataset.reload)
      toast('已重载')
      loadSources()
    } else if (btn.dataset.del) {
      if (!(await confirmModal('确认删除该音源？', { danger: true, okLabel: '删除' }))) return
      await api.sources.remove(btn.dataset.del)
      toast('已删除')
      loadSources()
    }
  } catch (err) {
    toast(err.message)
  }
}

/* ============================================================
   #56 · 一键快速冒烟（同步等待 ≤60s；loading 态 + 结果矩阵）
   矩阵每格两态：搜索（平台官方 API）/ 取链（musicUrl+HEAD 探测），
   绿✓ / 红✗ / 灰−；hover title 展示延迟与错误详情。
   ============================================================ */

async function onQuickSmoke() {
  const btn = $('#src-smoke')
  const box = $('#src-smoke-result')
  btn.disabled = true
  btn.classList.add('busy')
  btn.innerHTML = '<i class="sm-spin" aria-hidden="true"></i>冒烟中…'
  try {
    const r = await api.sources.smoke()
    if (!r.matrix || !r.matrix.length) {
      box.hidden = false
      box.innerHTML = '<div class="sm-note">没有启用中的就绪音源可测：先在上方启用至少一个「运行中」音源</div>'
      return
    }
    renderSmokeMatrix(r)
  } catch (err) {
    toast(`冒烟失败: ${err.message}`)
    box.hidden = false
    box.innerHTML = `<div class="sm-note sm-note--err">冒烟失败: ${escapeHtml(err.message)}</div>`
  } finally {
    btn.disabled = false
    btn.classList.remove('busy')
    btn.textContent = '一键冒烟测试'
  }
}

/** 单格双态徽标：搜/链 各一枚（✓ 绿 / ✗ 红 / − 灰），title 汇总详情 */
function smCell(cell) {
  if (!cell) return '<td>—</td>'
  if (cell.search === '-' && cell.url === '-') {
    const title = cell.error ? `未测试\n${cell.error}` : '该平台未被此音源声明'
    return `<td title="${escapeHtml(title)}"><span class="sm-cell sm-nd">—</span></td>`
  }
  const glyph = (st) => (st === 'ok' ? '✓' : st === 'fail' ? '✗' : '−')
  const cls = (st) => (st === 'ok' ? 'ok' : st === 'fail' ? 'fail' : 'nd')
  const lines = [
    `搜索: ${cell.search === 'ok' ? '通过' : cell.search === 'fail' ? '失败' : '未测'}`,
    `取链: ${cell.url === 'ok' ? '通过' : cell.url === 'fail' ? '失败' : '未测'}`,
    cell.latencyMs ? `链路耗时: ${cell.latencyMs}ms` : '',
    cell.error ? `错误: ${cell.error}` : '',
  ].filter(Boolean)
  return `<td title="${escapeHtml(lines.join('\n'))}"><span class="sm-cell"><b class="${cls(cell.search)}">${glyph(cell.search)}</b><b class="${cls(cell.url)}">${glyph(cell.url)}</b></span></td>`
}

function renderSmokeMatrix(r) {
  const box = $('#src-smoke-result')
  box.hidden = false

  // 按音源分组（保持返回顺序），平台取并集（固定列序 kw/kg/tx/wy/mg + 未知靠后）
  const PLAT_ORDER = ['kw', 'kg', 'tx', 'wy', 'mg']
  const bySource = new Map()
  const plats = new Set()
  for (const c of r.matrix) {
    if (!bySource.has(c.source)) bySource.set(c.source, [])
    bySource.get(c.source).push(c)
    plats.add(c.platform)
  }
  const platList = [...plats].sort((a, b) => {
    const ia = PLAT_ORDER.indexOf(a)
    const ib = PLAT_ORDER.indexOf(b)
    return (ia === -1 ? 99 : ia) - (ib === -1 ? 99 : ib)
  })

  // dead 联动：非 '−' 格子中没有任何取链通过且至少一个失败 → 建议禁用
  const suggestDisable = []
  for (const [sid, cells] of bySource) {
    const meaningful = cells.filter((c) => c.search !== '-' || c.url !== '-')
    if (meaningful.length && !meaningful.some((c) => c.url === 'ok') && meaningful.some((c) => c.url === 'fail' || c.search === 'fail')) {
      suggestDisable.push(sid)
    }
  }

  const when = r.finishedAt ? new Date(r.finishedAt).toLocaleString('zh-CN') : ''
  const summaryHtml = `
    <div class="sm-head">
      <span class="sm-title">冒烟矩阵</span>
      <span class="sm-meta">关键词「${escapeHtml(r.keyword || '')}」 · ${escapeHtml(when)} · 耗时 ${((r.durationMs || 0) / 1000).toFixed(1)}s${r.timeout ? ' · <b class="sm-to">整体超时截断</b>' : ''}</span>
      <span class="sm-count"><i class="hdot green hdot-sm"></i>${r.passed ?? 0} <i class="hdot red hdot-sm"></i>${r.failed ?? 0} / ${r.total ?? 0}</span>
    </div>
    <div class="sm-legend">每格两态：左 <b>搜</b>（平台搜索）· 右 <b>链</b>（取 URL+探测）；✓ 通过 · ✗ 失败 · − 未测；hover 看详情</div>`

  let html = summaryHtml + '<div class="table-wrap"><table><thead><tr><th>音源 \\ 平台</th>'
  html += platList.map((p) => `<th>${escapeHtml(PLATFORM_NAME[p] || p)}</th>`).join('') + '</tr></thead><tbody>'
  for (const [sid, cells] of bySource) {
    const dead = suggestDisable.includes(sid)
    html += `<tr><td class="sm-src"><b>${escapeHtml(sid)}</b>${dead ? '<span class="sm-dead" title="全部可测平台均失败，建议禁用">建议禁用</span>' : ''}</td>`
    for (const p of platList) html += smCell(cells.find((c) => c.platform === p))
    html += '</tr>'
  }
  html += '</tbody></table></div>'
  if (suggestDisable.length) {
    html += `<div class="sm-note sm-note--warn">${escapeHtml(suggestDisable.join('、'))} 的全部可测平台均未通过（含搜索/取链失败，与卡片 dead 态判定同源）：若多次冒烟均如此，建议在上方关闭其启用开关。</div>`
  }
  box.innerHTML = html

  if (suggestDisable.length) toast(`冒烟完成：${suggestDisable.length} 个音源全败，建议禁用`, 4200)
  else toast(`冒烟完成：${r.passed ?? 0}/${r.total ?? 0} 格通过`, 3000)
}
