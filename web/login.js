'use strict'

const $ = (s) => document.querySelector(s)

// 已登录则直接跳首页；未配密码则提示；
// v0.2.1 模块六：网关模式（飞牛 FN ID）→ 账密表单替换为身份直达卡
async function init() {
  try {
    const r = await fetch('/api/v1/auth/status').then((x) => x.json())
    if (r.authenticated) { location.href = '/'; return }
    // 模块六：网关实例——身份由飞牛 NAS 网关注入，不走账密
    if (r.mode === 'gateway') {
      showGateway(r.user || null)
      return
    }
    if (!r.passwordConfigured) {
      const h = $('#login-hint')
      h.hidden = false
      h.textContent = '尚未设置登录密码，请在 config.yaml 的 auth.webLogin.password 配置后重启服务。'
      $('#login-btn').disabled = true
    }
  } catch { /* ignore */ }
}

/* ============================================================
   v0.2.1 模块六 · 网关模式登录卡（window.showGateway 可直接调用，
   供 CDP fetch-mock / DOM 注入测试 gateway 分支渲染）
   - NAS 已登录（user.username 存在）→ 「已通过飞牛账号登录为 {username}」
     + 「进入 Rainbow」按钮（POST /api/v1/auth/gateway-login → 跳首页）
   - NAS 未登录 → 提示「请先登录飞牛 NAS」，无进入按钮
   - local 模式（status.mode='local'）不进入本函数，账密表单零变化
   ============================================================ */
function showGateway(user) {
  const gw = $('#login-gateway')
  if (!gw) return
  gw.hidden = false
  const form = $('#login-form')
  if (form) form.hidden = true
  const text = $('#login-gw-text')
  const btn = $('#login-gw-btn')
  if (user && user.username) {
    if (text) text.textContent = `已通过飞牛账号登录为 ${user.username}`
    if (btn) {
      btn.hidden = false
      btn.onclick = async () => {
        btn.disabled = true
        btn.textContent = '正在进入…'
        try {
          const resp = await fetch('/api/v1/auth/gateway-login', { method: 'POST' })
          const data = await resp.json().catch(() => ({}))
          if (!resp.ok) throw new Error(data.error || `HTTP ${resp.status}`)
          location.href = '/'
        } catch (e) {
          btn.disabled = false
          btn.textContent = '进入 Rainbow'
          if (text) text.textContent = `进入失败：${e.message}，请重试或重新登录飞牛 NAS`
        }
      }
    }
  } else {
    if (text) text.textContent = '请先登录飞牛 NAS，再访问 Rainbow'
    if (btn) btn.hidden = true
  }
}

$('#login-form').addEventListener('submit', async (e) => {
  e.preventDefault()
  const username = $('#login-user').value.trim()
  const password = $('#login-pass').value
  const err = $('#login-err')
  err.hidden = true
  $('#login-btn').disabled = true
  try {
    const resp = await fetch('/api/v1/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, password }),
    })
    const data = await resp.json().catch(() => ({}))
    if (!resp.ok) throw new Error(data.error || `HTTP ${resp.status}`)
    location.href = '/'
  } catch (e2) {
    err.hidden = false
    err.textContent = e2.message
    $('#login-btn').disabled = false
  }
})

init()
