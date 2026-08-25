/**
 * 设置页：API Key 管理 / 下载设置 / 元数据刮削 / 冒烟测试 / 告警渠道
 * 密钥类字段服务端永不回传明文（只回布尔），空串视为「不修改」
 */
import { $, escapeHtml, toast, confirmModal, QUALITIES } from '../ui.js'
import { api } from '../api.js'
import * as sse from '../sse.js'

export function init() {
  // #45 刮削进度/结果实时反馈（DOM guard：仅设置页渲染后存在这些节点）
  sse.on('scrape:progress', (d) => {
    const row = $('#set-scrape-prog-row')
    if (!row) return
    if (!d || !d.total) {
      row.hidden = true
      return
    }
    row.hidden = false
    const pct = Math.round((d.done / d.total) * 100)
    const bar = $('#set-scrape-bar')
    if (bar) bar.style.width = `${pct}%`
    const txt = $('#set-scrape-prog-text')
    if (txt) txt.textContent = `${d.done}/${d.total}（${pct}%）`
    if (d.done >= d.total) setTimeout(refreshScrapeStats, 800)
  })
  sse.on('scrape:update', (d) => {
    if (!d) return
    if (d.status === 'success') {
      const f = (d.fieldsWritten || []).join(' / ')
      setLastResult(`✓ 补全字段: ${f || '无（已齐）'}${d.source ? ` · 来源 ${d.source}` : ''}`)
    } else if (d.status === 'failed') {
      setLastResult(`✗ 失败: ${d.error || '未知错误'}${d.attempts ? `（第 ${d.attempts} 次）` : ''}`)
    } else if (d.status === 'skipped') {
      setLastResult(`- 跳过: ${d.error || ''}`)
    }
    if (d.status !== 'running' && d.status !== 'pending') refreshScrapeStats()
  })
}

export function show() {
  loadSettings()
}

async function loadSettings() {
  try {
    renderSettings(await api.settings.get())
  } catch (err) {
    $('#settings-body').innerHTML = `<div class="empty">加载失败: ${escapeHtml(err.message)}</div>`
  }
}

function renderSettings(s) {
  const d = s.download
  const sm = s.smokeTest
  const bark = sm.alert.bark
  const sc = sm.alert.serverChan
  const scr = s.scrape || { enabled: true, autoOnComplete: true }
  const apiKeySet = !!(s.auth && s.auth.apiKeySet)
  const qOpt = (v) => QUALITIES.map((q) => `<option value="${q}" ${q === v ? 'selected' : ''}>${q}</option>`).join('')
  // #73 下载目录：运行态解析路径 ≠ 启动时快照 → 已改待重启，行内显示「待重启」角标
  const dirPending = !!(d.resolvedDir && d.startupResolvedDir && d.resolvedDir !== d.startupResolvedDir)
  $('#settings-body').innerHTML = `
    <div class="set-card">
      <h3>API Key</h3>
      <div class="set-row">
        <label>状态</label>
        <span id="apikey-status" class="hint">${apiKeySet ? '已设置（出于安全，明文不再显示）' : '未设置'}</span>
      </div>
      <div class="set-row" id="apikey-reveal-row" hidden>
        <label>新 Key（请立即复制保存）</label>
        <div class="apikey-reveal">
          <code id="apikey-value"></code>
          <button type="button" id="apikey-copy">复制</button>
        </div>
      </div>
      <div class="set-row">
        <button type="button" id="apikey-gen">${apiKeySet ? '重新生成' : '生成 API Key'}</button>
        ${apiKeySet ? '<button type="button" id="apikey-revoke" class="danger">撤销</button>' : ''}
        <span class="hint">生成后仅本次明文显示一次，之后无法再查看，只能重新生成。</span>
      </div>
    </div>

    <div class="set-card">
      <h3>下载设置</h3>
      <div class="set-row set-dl-dir-row">
        <label>下载目录</label>
        <div class="dl-dir-main">
          <div class="dl-dir-display" id="dl-dir-display">
            <code class="dl-dir-code" id="set-dl-dir" title="${escapeHtml(d.resolvedDir || '')}">${escapeHtml(d.resolvedDir || '—')}</code>
            <span class="dl-dir-pending" id="dl-dir-pending" ${dirPending ? '' : 'hidden'} title="目录已修改，重启服务后生效">待重启</span>
            <button type="button" id="set-dl-dir-edit" title="修改下载目录（支持相对/绝对路径，重启后生效）">修改</button>
          </div>
          <div class="dl-dir-editor" id="dl-dir-editor" hidden>
            <input type="text" id="set-dl-dir-input" maxlength="512" spellcheck="false" autocomplete="off"
              placeholder="相对路径（相对程序目录）或绝对路径" />
            <button type="button" id="set-dl-dir-save">保存</button>
            <button type="button" id="set-dl-dir-cancel" class="danger-lite">取消</button>
          </div>
          <span class="hint">相对路径相对程序根目录解析，绝对路径原样使用；修改后需重启服务生效</span>
        </div>
      </div>
      <div class="set-row"><label>并发数 (1-10)</label><input type="number" id="set-conc" min="1" max="10" value="${d.concurrency}" /></div>
      <div class="set-row"><label>默认音质</label><select id="set-quality">${qOpt(d.defaultQuality)}</select></div>
      <div class="set-row"><label>命名模板</label><input type="text" id="set-tpl" value="${escapeHtml(d.nameTemplate)}" /></div>
      <div class="set-row"><label>封面尺寸 (100-1000)</label><input type="number" id="set-cover" min="100" max="1000" value="${d.coverSize}" /></div>
      <div class="set-row"><label>嵌入封面</label><input type="checkbox" id="set-embed-cover" ${d.embedCover ? 'checked' : ''} /></div>
      <div class="set-row"><label>嵌入歌词</label><input type="checkbox" id="set-embed-lyric" ${d.embedLyric ? 'checked' : ''} /></div>
    </div>

    <div class="set-card">
      <h3>元数据刮削</h3>
      <div class="set-row"><label>启用刮削</label><input type="checkbox" id="set-scrape-en" ${scr.enabled ? 'checked' : ''} /><span class="hint">为已完成下载补全年份/曲目号/碟号/流派等标签，只补缺不覆盖已有内容</span></div>
      <div class="set-row"><label>下载完成后自动刮削</label><input type="checkbox" id="set-scrape-auto" ${scr.autoOnComplete ? 'checked' : ''} /></div>
      <div class="set-row">
        <label>批量刮削</label>
        <button type="button" id="set-scrape-all">刮削全部待处理</button>
        <button type="button" id="set-scrape-reforce" class="danger">强制重刮全部</button>
      </div>
      <div class="set-row" id="set-scrape-prog-row" hidden>
        <label>进度</label>
        <div style="flex:1">
          <div class="progress-bar"><div id="set-scrape-bar" style="width:0%"></div></div>
          <span class="hint" id="set-scrape-prog-text">0/0</span>
        </div>
      </div>
      <div class="set-row">
        <label>状态重置</label>
        <button type="button" id="set-scrape-reset" class="danger-lite">重置刮削状态</button>
        <span class="hint">清空全部刮削记录（含成功/失败/跳过），已写入文件的标签不受影响</span>
      </div>
      <div class="set-row"><label>最近结果</label><span class="hint" id="set-scrape-last">—</span></div>
      <div class="set-row"><label>状态统计</label><span class="hint" id="set-scrape-stats">加载中…</span></div>
    </div>

    <div class="set-card">
      <h3>冒烟测试</h3>
      <div class="set-row"><label>启用</label><input type="checkbox" id="set-smoke-en" ${sm.enabled ? 'checked' : ''} /></div>
      <div class="set-row"><label>Cron 表达式</label><input type="text" id="set-smoke-cron" value="${escapeHtml(sm.cron)}" /></div>
      <div class="set-row"><label>测试关键词</label><input type="text" id="set-smoke-kw" value="${escapeHtml(sm.keyword)}" /></div>
      <div class="set-row"><label>连续失败告警阈值</label><input type="number" id="set-smoke-th" min="1" max="10" value="${sm.alertThreshold}" /></div>
    </div>

    <div class="set-card">
      <h3>告警渠道 · Bark</h3>
      <div class="set-row"><label>启用</label><input type="checkbox" id="set-bark-en" ${bark.enabled ? 'checked' : ''} /></div>
      <div class="set-row"><label>服务器地址</label><input type="text" id="set-bark-url" value="${escapeHtml(bark.serverUrl)}" /></div>
      <div class="set-row"><label>Device Key ${bark.deviceKeySet ? '<span class="hint">(已设置，留空不改)</span>' : ''}</label><input type="text" id="set-bark-key" placeholder="${bark.deviceKeySet ? '••••••' : '未设置'}" /></div>
    </div>

    <div class="set-card">
      <h3>告警渠道 · Server酱</h3>
      <div class="set-row"><label>启用</label><input type="checkbox" id="set-sc-en" ${sc.enabled ? 'checked' : ''} /></div>
      <div class="set-row"><label>SendKey ${sc.sendKeySet ? '<span class="hint">(已设置，留空不改)</span>' : ''}</label><input type="text" id="set-sc-key" placeholder="${sc.sendKeySet ? '••••••' : '未设置'}" /></div>
    </div>

    <div class="set-actions">
      <button id="set-save">保存设置</button>
      <button id="set-test-notify">测试告警推送</button>
    </div>`

  $('#set-save').addEventListener('click', saveSettings)
  $('#set-test-notify').addEventListener('click', testNotify)
  // #73 下载目录：修改入口（行内编辑，保存后 toast + 待重启角标，独立于「保存设置」批量流）
  $('#set-dl-dir-edit')?.addEventListener('click', showDirEditor)
  $('#set-dl-dir-cancel')?.addEventListener('click', hideDirEditor)
  $('#set-dl-dir-save')?.addEventListener('click', saveDownloadDir)
  $('#set-dl-dir-input')?.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') saveDownloadDir()
    if (e.key === 'Escape') hideDirEditor()
  })
  $('#set-scrape-all')?.addEventListener('click', () => scrapeAll(false))
  $('#set-scrape-reforce')?.addEventListener('click', () => scrapeAll(true))
  $('#set-scrape-reset')?.addEventListener('click', resetScrapeStatus)
  refreshScrapeStats()
  $('#apikey-gen')?.addEventListener('click', generateApiKey)
  $('#apikey-revoke')?.addEventListener('click', revokeApiKey)
}

async function generateApiKey() {
  const ok = await confirmModal('生成新 Key 会使旧 Key 立即失效。明文只显示这一次，确定继续？')
  if (!ok) return
  const btn = $('#apikey-gen')
  if (btn) btn.disabled = true
  try {
    const r = await api.settings.generateApiKey()
    $('#apikey-value').textContent = r.apiKey
    $('#apikey-reveal-row').hidden = false
    $('#apikey-status').textContent = '已设置（出于安全，明文不再显示）'
    $('#apikey-copy')?.addEventListener('click', () => {
      navigator.clipboard?.writeText(r.apiKey).then(
        () => toast('已复制到剪贴板'),
        () => toast('复制失败，请手动选择复制'),
      )
    })
    toast('已生成，请立即复制保存')
  } catch (err) {
    toast(`生成失败: ${err.message}`)
  } finally {
    if (btn) btn.disabled = false
  }
}

async function revokeApiKey() {
  const ok = await confirmModal('撤销后使用该 Key 的脚本/自动化将立即失效，确定？', { danger: true, okLabel: '撤销' })
  if (!ok) return
  try {
    await api.settings.revokeApiKey()
    toast('已撤销')
    loadSettings()
  } catch (err) {
    toast(`撤销失败: ${err.message}`)
  }
}

/* ============================================================
   #73 下载目录：只读展示解析后绝对路径 + 行内编辑修改（PATCH { downloadDir }）
   相对/绝对均合法；保存后 yaml 已落盘、新下载实时读到新目录，
   完整一致性由重启兑底 → toast「已保存，重启服务后生效」+「待重启」角标
   （角标依据 GET settings 的 resolvedDir ≠ startupResolvedDir，重启后自动消失）
   ============================================================ */
function showDirEditor() {
  const display = $('#dl-dir-display')
  const editor = $('#dl-dir-editor')
  const input = $('#set-dl-dir-input')
  if (!display || !editor || !input) return
  display.hidden = true
  editor.hidden = false
  input.value = ($('#set-dl-dir')?.textContent || '').trim()
  input.focus()
  input.select()
}

function hideDirEditor() {
  const display = $('#dl-dir-display')
  const editor = $('#dl-dir-editor')
  if (!display || !editor) return
  editor.hidden = true
  display.hidden = false
}

async function saveDownloadDir() {
  const input = $('#set-dl-dir-input')
  const btn = $('#set-dl-dir-save')
  if (!input || !btn) return
  const dir = input.value.trim()
  // 前端双重校验（后端同步兜底：非空/≤512/无控制字符）
  if (!dir) {
    toast('下载目录不能为空')
    input.focus()
    return
  }
  if (dir.length > 512) {
    toast('下载目录过长（>512 字符）')
    return
  }
  btn.disabled = true
  try {
    await api.settings.patch({ downloadDir: dir })
    toast('已保存，重启服务后生效')
    loadSettings() // 重渲染：展示新 resolvedDir + 「待重启」角标
  } catch (err) {
    toast(`保存失败: ${err.message}`)
    btn.disabled = false
  }
}

async function saveSettings() {
  const patch = {
    download: {
      concurrency: parseInt($('#set-conc').value, 10),
      defaultQuality: $('#set-quality').value,
      nameTemplate: $('#set-tpl').value,
      coverSize: parseInt($('#set-cover').value, 10),
      embedCover: $('#set-embed-cover').checked,
      embedLyric: $('#set-embed-lyric').checked,
    },
    scrape: {
      enabled: $('#set-scrape-en').checked,
      autoOnComplete: $('#set-scrape-auto').checked,
    },
    smokeTest: {
      enabled: $('#set-smoke-en').checked,
      cron: $('#set-smoke-cron').value,
      keyword: $('#set-smoke-kw').value,
      alertThreshold: parseInt($('#set-smoke-th').value, 10),
      alert: {
        bark: { enabled: $('#set-bark-en').checked, serverUrl: $('#set-bark-url').value, deviceKey: $('#set-bark-key').value },
        serverChan: { enabled: $('#set-sc-en').checked, sendKey: $('#set-sc-key').value },
      },
    },
  }
  try {
    await api.settings.patch(patch)
    toast('已保存')
    loadSettings()
  } catch (err) {
    toast(`保存失败: ${err.message}`)
  }
}

async function scrapeAll(force) {
  const btn = $(force ? '#set-scrape-reforce' : '#set-scrape-all')
  if (btn) btn.disabled = true
  try {
    const r = await api.scrape.all(force)
    if (!r.queued) {
      toast('没有需要刮削的任务（已全部处理过，可尝试强制重刮）')
    } else {
      const row = $('#set-scrape-prog-row')
      if (row) row.hidden = false
      toast(`已入队 ${r.queued} 个刮削任务${r.skipped ? `，跳过 ${r.skipped} 个` : ''}`)
    }
    refreshScrapeStats()
  } catch (err) {
    toast(`刮削失败: ${err.message}`)
  } finally {
    if (btn) btn.disabled = false
  }
}

/** #47 重置全部刮削状态：confirm 确认 → POST /api/v1/scrape/reset → 统计刷新（待刮数变化） */
async function resetScrapeStatus() {
  const ok = await confirmModal(
    '将全部任务的刮削状态重置为「待刮」（含成功/失败/跳过记录），之后「刮削全部待处理」会重新纳入这些任务。已写入音频文件的标签不会被改动。确定继续？',
    { danger: true, okLabel: '重置' },
  )
  if (!ok) return
  try {
    const r = await api.scrape.reset()
    toast(r.reset ? `已重置 ${r.reset} 首歌曲的刮削状态` : '没有需要重置的刮削状态')
  } catch (err) {
    toast(`重置失败: ${err.message}`)
  }
  refreshScrapeStats()
}

async function refreshScrapeStats() {
  const el = $('#set-scrape-stats')
  if (!el) return
  try {
    const r = await api.scrape.status()
    const s = r.stats || {}
    let txt = `成功 ${s.success || 0} · 失败 ${s.failed || 0} · 跳过 ${s.skipped || 0} · 待刮 ${s.pending || 0} · 未处理 ${s.none || 0}`
    if (r.running) txt += ` · 队列中 ${r.queueSize} 个`
    el.textContent = txt
  } catch {
    el.textContent = '统计加载失败'
  }
}

function setLastResult(text) {
  const el = $('#set-scrape-last')
  if (el) el.textContent = text
}

async function testNotify() {
  const btn = $('#set-test-notify')
  btn.disabled = true
  try {
    const r = await api.settings.testNotify({})
    const active = (r.results || []).filter((x) => !x.skipped)
    if (!active.length) toast('没有启用任何告警渠道')
    else toast(active.map((x) => `${x.channel}: ${x.ok ? '成功' : '失败(' + (x.error || '') + ')'}`).join(' · '), 4000)
  } catch (err) {
    toast(err.message)
  } finally {
    btn.disabled = false
  }
}
