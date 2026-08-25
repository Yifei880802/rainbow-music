/**
 * 通用 UI 工具：DOM 快捷方式 / toast / 模态弹窗 / 常量与格式化
 * 弹窗用于替代原生 prompt/confirm（移动端体验更好）
 */

export const $ = (sel) => document.querySelector(sel)
export const $$ = (sel) => Array.from(document.querySelectorAll(sel))

export const PLATFORM_NAME = { kw: '酷我', kg: '酷狗', tx: 'QQ音乐', wy: '网易云', mg: '咪咕' }
export const QUALITIES = ['flac24bit', 'flac', '320k', '128k']
export const QUALITY_LABEL = { flac24bit: 'Hi-Res', flac: '无损', '320k': '320k', '128k': '128k' }

const STATUS_LABEL = {
  pending: '等待',
  active: '下载中',
  completed: '完成',
  completed_with_warnings: '完成(有警告)',
  failed: '失败',
  canceled: '已取消',
}
export const statusLabel = (s) => STATUS_LABEL[s] || s

export function escapeHtml(str) {
  return String(str ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]))
}

/** 字节数 → 可读文本（进度展示用） */
export function formatBytes(n) {
  if (!Number.isFinite(n) || n <= 0) return ''
  const units = ['B', 'KB', 'MB', 'GB']
  let i = 0
  let v = n
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024
    i++
  }
  return `${v.toFixed(v >= 100 || i === 0 ? 0 : 1)} ${units[i]}`
}

// ---------- toast ----------
let toastTimer = null
/**
 * 全局 toast（#66 增量：支持可选动作钮，向后兼容——第二参为数字时仍视为时长）。
 * @param {string} msg 消息文本（textContent 安全渲染，不解析 HTML）
 * @param {number|{ms?:number, actionLabel?:string, onAction?:Function}} [msOrOpts]
 *   传对象时可附动作钮（如「去查看」）；点钮/超时后自动消隐，旧钮随新 toast 重建
 */
export function toast(msg, msOrOpts = 2600) {
  const el = $('#toast')
  if (!el) return
  const opts = typeof msOrOpts === 'number' ? { ms: msOrOpts } : msOrOpts || {}
  const { ms = 2600, actionLabel, onAction } = opts
  const hide = () => {
    el.hidden = true
    clearTimeout(toastTimer)
  }
  el.textContent = msg
  el.querySelectorAll('button').forEach((b) => b.remove()) // 旧动作钮清理
  if (actionLabel && typeof onAction === 'function') {
    const btn = document.createElement('button')
    btn.type = 'button'
    btn.className = 'toast-act'
    btn.textContent = actionLabel
    btn.addEventListener('click', () => {
      hide()
      onAction()
    })
    el.appendChild(btn)
  }
  el.hidden = false
  clearTimeout(toastTimer)
  toastTimer = setTimeout(hide, ms)
}

// ---------- 模态弹窗 ----------

/**
 * 通用模态框。
 * @param {object} opt
 * @param {string} opt.title 标题（纯文本）
 * @param {string} opt.bodyHtml 内容 HTML（调用方自行 escape）
 * @param {Array<{label:string, value:any, primary?:boolean, danger?:boolean}>} opt.buttons
 *   value 为函数时以 (modalEl) => any 求值作为返回值
 * @param {(modalEl:HTMLElement, finish:(v:any)=>void) => void} [opt.onMount] 挂载后钩子（用于绑定内部交互）
 * @returns {Promise<any>} 点击按钮对应的 value；点遮罩/Esc 返回 null
 */
export function showModal({ title = '', bodyHtml = '', buttons = [{ label: '确定', value: true, primary: true }], onMount } = {}) {
  return new Promise((resolve) => {
    const overlay = document.createElement('div')
    overlay.className = 'modal-overlay'
    overlay.innerHTML = `
      <div class="modal" role="dialog" aria-modal="true">
        <h3 class="modal-title"></h3>
        <div class="modal-body"></div>
        <div class="modal-btns"></div>
      </div>`
    const modal = overlay.querySelector('.modal')
    modal.querySelector('.modal-title').textContent = title
    modal.querySelector('.modal-body').innerHTML = bodyHtml
    const btnWrap = modal.querySelector('.modal-btns')

    let done = false
    const finish = (v) => {
      if (done) return
      done = true
      document.removeEventListener('keydown', onKey)
      overlay.remove()
      resolve(v)
    }
    const onKey = (e) => {
      if (e.key === 'Escape') finish(null)
    }
    document.addEventListener('keydown', onKey)

    for (const b of buttons) {
      const btn = document.createElement('button')
      btn.type = 'button'
      btn.textContent = b.label
      btn.className = b.danger ? 'danger' : b.primary ? 'primary' : ''
      btn.addEventListener('click', () => finish(typeof b.value === 'function' ? b.value(modal) : b.value))
      btnWrap.appendChild(btn)
    }
    overlay.addEventListener('click', (e) => {
      if (e.target === overlay) finish(null)
    })

    document.body.appendChild(overlay)
    if (onMount) onMount(modal, finish)
  })
}

/** 确认弹窗（替代 confirm） */
export async function confirmModal(message, { okLabel = '确定', danger = false } = {}) {
  const r = await showModal({
    title: '请确认',
    bodyHtml: `<p class="modal-msg">${escapeHtml(message)}</p>`,
    buttons: [
      { label: '取消', value: false },
      { label: okLabel, value: true, danger, primary: !danger },
    ],
  })
  return r === true
}

/**
 * 歌单选择弹窗（替代 prompt）：点选已有歌单，或输入新名称创建。
 * @param {Array<{id:string,name:string,count?:number}>} playlists
 * @returns {Promise<{id:string}|{newName:string}|null>}
 */
export function pickPlaylistModal(playlists, { title = '选择歌单' } = {}) {
  const opts = (playlists || [])
    .map(
      (p) => `
      <button type="button" class="modal-opt" data-id="${escapeHtml(String(p.id))}">
        <span class="modal-opt-name">${escapeHtml(p.name)}</span>
        <span class="modal-opt-hint">${p.count ?? 0} 首</span>
      </button>`,
    )
    .join('')
  return showModal({
    title,
    bodyHtml: `
      <div class="modal-opts">${opts || '<div class="modal-msg">暂无歌单，可在下方输入名称新建</div>'}</div>
      <div class="modal-newrow">
        <input type="text" id="modal-new-playlist" placeholder="输入新歌单名称…" maxlength="60" autocomplete="off" />
      </div>`,
    buttons: [
      { label: '取消', value: null },
      {
        label: '新建并选中',
        primary: true,
        value: (modal) => {
          const v = modal.querySelector('#modal-new-playlist').value.trim()
          return v ? { newName: v } : null
        },
      },
    ],
    onMount: (modal, finish) => {
      modal.querySelectorAll('.modal-opt').forEach((b) =>
        b.addEventListener('click', () => finish({ id: b.dataset.id })),
      )
      const input = modal.querySelector('#modal-new-playlist')
      input.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
          e.preventDefault()
          const v = input.value.trim()
          if (v) finish({ newName: v })
        }
      })
      setTimeout(() => input.focus(), 30)
    },
  })
}
