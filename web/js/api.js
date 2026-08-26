/**
 * Rainbow REST API 封装（浏览器端）
 *
 * - 全部走 /api/v1/*（契约见仓库 API.md，不臆造端点）
 * - v0.2.5 网关适配：fnOS iframe 入口在 /app/com.rainbow.music 前缀下，所有接口
 *   调用经 API_BASE 拼接前缀（服务端 rewriteUrl 会剥前缀，两态——网关前缀/直连根——
 *   均命中同一批路由）；API_BASE 是全前端唯一的前缀来源（sse.js/storage.js/各页面
 *   模块拼封面/流地址均 import 本常量，login.js 为非模块脚本内联同源探测逻辑）
 * - 鉴权：同源请求自动携带会话 Cookie（HttpOnly ro_sess，登录后由服务端设置）；
 *   浏览器端不使用 API Key（那是给脚本/程序的方式）
 * - 收到 401 一律跳 login.html（相对路径，网关/直连两态均可正确解析）重新登录
 */

/** 网关前缀探测：仅在 fnOS 统一网关入口（iframe，pathname 带精确前缀）时非空。
 *  严格匹配 前缀 或 前缀+'/'，防止误匹配其他 /app/* 应用路径 */
export const API_BASE = (() => {
  const p = location.pathname
  return p === '/app/com.rainbow.music' || p.startsWith('/app/com.rainbow.music/') ? '/app/com.rainbow.music' : ''
})()

const BASE = API_BASE + '/api/v1'

/** 把对象拼成 query string（忽略 undefined/null/空串） */
function qs(params) {
  const sp = new URLSearchParams()
  for (const [k, v] of Object.entries(params || {})) {
    if (v !== undefined && v !== null && v !== '') sp.set(k, String(v))
  }
  const s = sp.toString()
  return s ? `?${s}` : ''
}

/** 统一请求：JSON 解析 + 错误归一 + 401 跳登录 */
async function request(path, opts = {}) {
  let resp
  try {
    resp = await fetch(BASE + path, { credentials: 'same-origin', ...opts })
  } catch (err) {
    throw new Error('网络错误，无法连接服务: ' + (err && err.message ? err.message : err))
  }
  if (resp.status === 401) {
    location.href = 'login.html'
    throw new Error('未授权')
  }
  const data = await resp.json().catch(() => ({}))
  if (!resp.ok) {
    const e = new Error(data.error || `HTTP ${resp.status}`)
    e.status = resp.status
    e.data = data
    throw e
  }
  return data
}

const withJson = (method) => (path, body) =>
  request(path, { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body ?? {}) })
const post = withJson('POST')
const patchReq = withJson('PATCH')
const putReq = withJson('PUT')
const del = (path) => request(path, { method: 'DELETE' })
const enc = encodeURIComponent

export const api = {
  // ---------- 1. 认证 ----------
  auth: {
    status: () => request('/auth/status'),
    logout: () => post('/auth/logout'),
    /** v0.2.1 模块六：网关实例 FN ID 免密登录（本地实例 404；仅 login.js 网关分支消费） */
    gatewayLogin: () => post('/auth/gateway-login'),
  },

  // ---------- 1.5 用户身份与个性化（v0.2.1 模块六：FN ID 多用户） ----------
  me: {
    get: () => request('/me'),
    scanRoots: () => request('/me/scan-roots'),
    /** PUT {paths:[...]}；越界路径 400 */
    setScanRoots: (paths) => putReq('/me/scan-roots', { paths }),
    /** GET ?limit= → {history:[...]} */
    history: (limit) => request(`/me/history${qs({ limit })}`),
    /** POST {track:任意JSON}（播放上报，前端节流防刷） */
    addHistory: (track) => post('/me/history', { track }),
    favorites: () => request('/me/favorites'),
    addFavorite: (kind, ref) => post('/me/favorites', { kind, ref }),
    removeFavorite: (kind, ref) => del(`/me/favorites/${enc(kind)}/${enc(ref)}`),
  },

  // ---------- 1.6 本地音乐库（v0.2.1 模块六：NAS 扫描曲库） ----------
  library: {
    /** POST 扫描 → 202 {ok,jobId}（无根 400 / 扫描中 409） */
    scan: () => post('/library/scan'),
    /** → {scanning,last?,progress?{phase,scanned,total,added,updated,removed,currentRoot}} */
    scanStatus: () => request('/library/scan/status'),
    /** ?limit&offset&q&artist&album&sort → {tracks,total,offset,limit} */
    tracks: (p) => request(`/library/tracks${qs(p)}`),
  },

  // ---------- 2. 搜索 ----------
  search: {
    song: (p) => request(`/search${qs(p)}`),
    aggregate: (p) => request(`/search/aggregate${qs(p)}`),
    songlist: (p) => request(`/search/songlist${qs(p)}`),
    songlistAggregate: (p) => request(`/search/songlist/aggregate${qs(p)}`),
    songlistDetail: (p) => request(`/search/songlist/detail${qs(p)}`),
  },

  // ---------- 热门歌单（#60 首页聚合：5 平台 7 榜，平台失败进 errors 不阻塞） ----------
  hotPlaylists: () => request('/hot-playlists'),

  // ---------- 歌单广场（#67 发现页「精选歌单」：wy/tx 轻量列表 + 翻页/分类） ----------
  playlistSquare: (p) => request(`/playlist-square${qs(p)}`),

  // ---------- 3. 下载与任务 ----------
  download: {
    submit: (body) => post('/download', body),
    batch: (body) => post('/download/batch', body),
  },
  tasks: {
    list: (status) => request(`/tasks${qs({ status })}`),
    get: (id) => request(`/tasks/${enc(id)}`),
    retry: (id) => post(`/tasks/${enc(id)}/retry`),
    cancel: (id) => post(`/tasks/${enc(id)}/cancel`),
    remove: (id) => del(`/tasks/${enc(id)}`),
  },

  // ---------- 歌词（P2：np 面板歌词 sidecar） ----------
  lyric: {
    /** 取任务歌词原始 lrc；无歌词时 throw（err.status === 404） */
    get: (taskId) => request(`/lyric/${enc(taskId)}`),
  },

  // ---------- 歌单 ----------
  playlists: {
    list: () => request('/playlists'),
    create: (body) => post('/playlists', body),
    /** #66 批量导入建单（发现页榜单一键保存）：body { title, description?, songs:[{platform,musicInfo}] } */
    importSongs: (body) => post('/playlists/import', body),
    get: (id) => request(`/playlists/${enc(id)}`),
    rename: (id, body) => patchReq(`/playlists/${enc(id)}`, body),
    remove: (id) => del(`/playlists/${enc(id)}`),
    addItem: (id, body) => post(`/playlists/${enc(id)}/items`, body),
    removeItem: (id, itemId) => del(`/playlists/${enc(id)}/items/${enc(itemId)}`),
    /** #57 拖拽排序落库：body { itemIds: [...] } 幂等重排（契约见 API.md §8） */
    orderItems: (id, itemIds) => putReq(`/playlists/${enc(id)}/items/order`, { itemIds }),
    download: (id, body) => post(`/playlists/${enc(id)}/download`, body),
  },

  // ---------- 4. 音源管理 ----------
  sources: {
    list: () => request('/sources'),
    importUrl: (body) => post('/sources/import/url', body),
    importContent: (body) => post('/sources/import/content', body),
    /** multipart/form-data 上传 */
    upload: (file) => {
      const fd = new FormData()
      fd.append('file', file)
      return request('/sources/upload', { method: 'POST', body: fd })
    },
    setEnabled: (id, enabled) => patchReq(`/sources/${enc(id)}/enabled`, { enabled }),
    reload: (id) => post(`/sources/${enc(id)}/reload`),
    remove: (id) => del(`/sources/${enc(id)}`),
    /** #56 一键快速冒烟：同步返回音源×平台矩阵（≤60s；409 = 已有冒烟在跑） */
    smoke: () => post('/sources/smoke'),
  },

  // ---------- 5. 设置 ----------
  settings: {
    get: () => request('/settings'),
    patch: (body) => patchReq('/settings', body),
    generateApiKey: () => post('/settings/apikey/generate'),
    revokeApiKey: () => del('/settings/apikey'),
    testNotify: (body) => post('/settings/notify/test', body ?? {}),
  },

  // ---------- 元数据刮削（#45，#47 增补 reset） ----------
  scrape: {
    /** 单任务刮削/重刮；返回 202 {id, scrapeStatus} */
    task: (taskId, force) => post(`/tasks/${enc(taskId)}/scrape${qs({ force: force ? 'true' : '' })}`),
    /** 一键刮削全部；返回 {queued, skipped} */
    all: (force) => post(`/scrape/all${qs({ force: force ? 'true' : '' })}`),
    /** #47 重置全部刮削状态；返回 {reset} 受影响行数 */
    reset: () => post('/scrape/reset'),
    /** 运行态概览 + 状态分布 */
    status: () => request('/scrape/status'),
  },

  // ---------- 健康 / 冒烟 ----------
  health: {
    smoke: () => request('/health/smoke'),
    runSmoke: () => post('/health/smoke/run'),
  },

  // ---------- 7. 状态 ----------
  status: () => request('/status'),
}
