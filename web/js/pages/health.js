/**
 * 健康页：冒烟测试矩阵（音源 × 平台）+ 手动触发 + SSE 结果通知
 */
import { $, escapeHtml, toast, PLATFORM_NAME } from '../ui.js'
import { api } from '../api.js'
import * as sse from '../sse.js'

export function init() {
  $('#refresh-health').addEventListener('click', loadHealth)
  $('#run-smoke').addEventListener('click', runSmoke)
  // 冒烟完成/失败事件 → 自动刷新矩阵
  sse.on('smoke:completed', loadHealth)
  sse.on('smoke:failed', loadHealth)
}

export function show() {
  loadHealth()
}

async function runSmoke() {
  const btn = $('#run-smoke')
  btn.disabled = true
  try {
    await api.health.runSmoke()
    toast('冒烟测试已启动，结果将实时更新')
  } catch (err) {
    toast(err.message)
  } finally {
    setTimeout(() => {
      btn.disabled = false
    }, 3000)
  }
}

async function loadHealth() {
  try {
    renderHealth(await api.health.smoke())
  } catch (err) {
    $('#health-matrix').innerHTML = `<div class="empty">加载失败: ${escapeHtml(err.message)}</div>`
  }
}

function renderHealth(h) {
  const s = h.summary
  const when = h.lastRunAt ? new Date(h.lastRunAt).toLocaleString('zh-CN') : '从未运行'
  $('#health-summary').innerHTML = `最近: ${escapeHtml(when)} · <i class="hdot green hdot-sm"></i>${s.green} <i class="hdot yellow hdot-sm"></i>${s.yellow} <i class="hdot red hdot-sm"></i>${s.red}${h.running ? ' · 运行中…' : ''}`
  const c = $('#health-matrix')
  if (!h.cells.length) {
    c.innerHTML = '<div class="empty">暂无冒烟数据，点「立即冒烟测试」</div>'
    return
  }

  // 按音源分组，平台为列
  const bySource = {}
  const platforms = new Set()
  for (const cell of h.cells) {
    ;(bySource[cell.sourceId] ??= {})[cell.platform] = cell
    platforms.add(cell.platform)
  }
  const plats = [...platforms]
  const dot = (state) => ({ green: 'green', yellow: 'yellow', red: 'red' }[state] || 'gray')
  let html = '<div class="table-wrap"><table><thead><tr><th>音源 \\ 平台</th>' + plats.map((p) => `<th>${PLATFORM_NAME[p] || escapeHtml(p)}</th>`).join('') + '</tr></thead><tbody>'
  for (const [sid, row] of Object.entries(bySource)) {
    html += `<tr><td><b>${escapeHtml(sid)}</b></td>`
    for (const p of plats) {
      const cell = row[p]
      if (!cell) {
        html += '<td>—</td>'
        continue
      }
      const steps = cell.steps || {}
      const stepStr = ['search', 'musicUrl', 'head', 'lyric', 'pic']
        .filter((k) => steps[k])
        .map((k) => `${k}:${steps[k].ok ? '✓' : '✗'}`)
        .join(' ')
      const title = `${stepStr}${cell.error ? ' | ' + cell.error : ''}`
      html += `<td title="${escapeHtml(title)}"><i class="hdot ${dot(cell.state)}"></i></td>`
    }
    html += '</tr>'
  }
  html += '</tbody></table></div>'
  c.innerHTML = html
}
