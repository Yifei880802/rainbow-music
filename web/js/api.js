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

/** P2 O1 试听失败文案：按 HTTP 状态 + 结构化错误码映射为友好提示（附原文兜底） */
function previewErrMsg(status, code, message) {
  if (status === 400) return '试听参数有误，无法播放'
  if (status === 502 || status === 503 || status === 504) {
    return code === 'ERR_NO_SOURCE' || code === 'ERR_ALL_SOURCES_FAILED'
      ? '暂无可用音源，试听失败'
      : '暂时无法获取试听链接（音源不可用），请稍后再试'
  }
  if (message) return `试听失败：${message}`
  if (code) return `试听失败（${code}）`
  return `试听失败（HTTP ${status}）`
}

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
    // ---------- P2 O2：「我喜欢」收藏（契约见 server/src/routes/me.ts，按 uid 隔离） ----------
    /** kind 白名单：track | playlist | square；ref 为非空字符串且 ≤1024 字符；UNIQUE(uid,kind,ref) 天然去重 */
    /** GET → { favorites:[{ kind, ref, createdAt }] }（该 uid 全部收藏，无分页） */
    favorites: () => request('/me/favorites'),
    /** POST { kind, ref } → { ok:true, added:boolean }（added=false 表示已存在，幂等） */
    addFavorite: (kind, ref) => post('/me/favorites', { kind, ref }),
    /** DELETE /:kind/:ref → { ok:true, deleted:boolean }（deleted=false 表示原本就不在收藏中） */
    removeFavorite: (kind, ref) => del(`/me/favorites/${enc(kind)}/${enc(ref)}`),
    /** GET + 按 kind 过滤 → ref 的 Set（各页免重复 reduce；kind 缺省 'track'） */
    favoriteRefs: async (kind = 'track') => {
      const r = await request('/me/favorites')
      const set = new Set()
      for (const f of r?.favorites || []) if (f && f.kind === kind && f.ref) set.add(String(f.ref))
      return set
    },
    // ---------- P0 D1：搜索历史跨设备同步（服务端按 uid 隔离，去重置顶、封顶 200/uid） ----------
    /** GET ?limit=（服务端 clamp 1..200，默认 50）→ { items:[{ id, kw, type, platform, ts }] } */
    getSearchHistory: (limit) => request(`/me/search-history${qs({ limit })}`),
    /** POST { kw, type?, platform? } → 201 { id, kw, type, platform, ts }（kw 空→400） */
    postSearchHistory: (body) => post('/me/search-history', body),
    /** DELETE → 200 { ok:true }（清空当前 uid 全部搜索历史） */
    clearSearchHistory: () => del('/me/search-history'),
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
    /** P0 D2 联想：GET /search/suggest?q=&limit= → { q, items:[{ text, singer?, type:'history'|'hot'|'title' }] }
     *  （后端已按 (text,singer) 复合 key 去重；title 池冷启动首拉 ≤8s，调用侧需防抖+loading+失败静默降级） */
    suggest: (q, limit) => request(`/search/suggest${qs({ q, limit })}`),
    /** P0 D3 热搜：GET /search/trending?limit= → { items:[{ text, count }] }（实时 DB 无缓存） */
    trending: (limit) => request(`/search/trending${qs({ limit })}`),
    /**
     * P2 O5 相关推荐：GET /search/related?kw=&limit= → { related:[{ kw:string, score:number }] }
     * 基于搜索历史共现（搜过 X 的人也搜 Y），冷启动后端回退 trending；relatedEnabled=false 或 kw 空 → 空数组。
     * 调用侧失败/空数组一律静默降级，不阻断搜索。
     */
    related: (kw, limit) => request(`/search/related${qs({ kw, limit })}`),
    /**
     * P1 J1/J4 合并视图：GET /search/merged?keyword=&platforms=&page=&limit=
     * → MergedSearchResult { keyword, page, total, list: MergedTrack[] }
     *   MergedTrack  { name, singer, albumName, img|null, interval?:string|0,
     *                  qualities:Quality[]（并集按档位降序）, sources:MergedSource[], score（≥0，2 位）}
     *   MergedSource { platform:'kw'|'kg'|'tx'|'wy'|'mg', songmid, qualities:Quality[], songInfo:MusicInfo }
     *   Quality = '128k'|'320k'|'flac'|'flac24bit'
     * 服务端跨平台去重（主键 name+singer、辅键 interval±5s）后按 score 降序；
     * platforms 缺省 = 全平台（逗号分隔字符串）；limit 透传底层聚合作为各平台默认条数。
     */
    merged: (keyword, { platforms, page, limit } = {}) => request(`/search/merged${qs({ keyword, platforms, page, limit })}`),
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
    /** GET /tasks?status&batchId&limit&offset → { tasks, limit, offset, count, total } */
    list: (params) => request(`/tasks${qs(typeof params === 'string' ? { status: params } : params)}`),
    /** #196-fix2: GET /tasks/owned → { owned:[{ key, taskId, status, quality, hasFile }] } 覆盖全部终态任务（无分页） */
    owned: () => request('/tasks/owned'),
    get: (id) => request(`/tasks/${enc(id)}`),
    /**
     * M 错误可观测：GET /tasks/:id/attempts → { attempts: DownloadAttemptRow[] }
     * 每行 = { task_id, attempt_no:number, source_id, platform, quality, error_code:string|null, ts:number }
     * attempt_no = 重试轮次（从 1 起，同轮跨音源/音质多次尝试共享同号），按 ts 升序。
     * 任务不存在 404；存在但无尝试返回空数组。
     */
    attempts: (id) => request(`/tasks/${enc(id)}/attempts`),
    retry: (id) => post(`/tasks/${enc(id)}/retry`),
    cancel: (id) => post(`/tasks/${enc(id)}/cancel`),
    remove: (id) => del(`/tasks/${enc(id)}`),
  },

  // ---------- 3.5 批次管理（P1-I2） ----------
  batches: {
    /** GET /batches → { batches:[{batch_id,total,pending,active,completed,failed,canceled,created_at,updated_at}] } */
    list: () => request('/batches'),
    /** GET /batches/:id → { batchId,total,pending,active,completed,failed,canceled,tasks:[...] } */
    get: (id) => request(`/batches/${enc(id)}`),
    /** POST /batches/:id/cancel (admin) → { batchId, canceled } */
    cancel: (id) => post(`/batches/${enc(id)}/cancel`),
  },

  // ---------- 3.6 队列控制（P1-I2） ----------
  queue: {
    /** POST /queue/pause (admin) → queueStatus 快照 */
    pause: () => post('/queue/pause'),
    /** POST /queue/resume (admin) → queueStatus 快照 */
    resume: () => post('/queue/resume'),
    /** GET /queue/status (admin) → { paused,memPaused,concurrency,scheduled,activationBuffer,running,pending,active,completed,failed,canceled } */
    status: () => request('/queue/status'),
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
    /** POST /playlists/:id/download-missing → { batchId, acceptedCount, skippedCount, accepted, skipped } */
    downloadMissing: (id, body) => post(`/playlists/${enc(id)}/download-missing`, body ?? {}),
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
    /**
     * P1 C4 音质能力：GET /sources/capabilities?platform=（platform 必填，缺失 400）
     * → { platform, qualities:{ flac24bit:bool, flac:bool, '320k':bool, '128k':bool },
     *     sources:[{ id, name, qualities:string[] }] }
     * 聚合 ready+enabled 音源；搜索合并视图据此灰显不可达音质档位（调用侧失败静默降级为不灰显）。
     */
    capabilities: (platform) => request(`/sources/capabilities${qs({ platform })}`),
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

  // ---------- P2 O1 结果内试听（音源直链流式代理） ----------
  preview: {
    /**
     * 构造试听直链：GET /preview?platform=&songmid=&quality=&name=&singer=
     * 成功 → 302 Location=音源直链（<audio> 自动跟随重定向；同源请求自动携带登录 Cookie）。
     * quality 缺省 'flac'，合法档 128k/320k/flac/flac24bit。返回可直接作 audio.src 的绝对路径。
     */
    url: ({ platform, songmid, quality = 'flac', name, singer }) =>
      BASE + `/preview${qs({ platform, songmid, quality, name, singer })}`,
    /**
     * 试听预检（不下载音频体）：以 redirect:'manual' 请求 preview 端点——
     *   · 302 → 响应被过滤为 opaqueredirect（status 0），表示后端已定位到音源直链 → resolve(直链URL)；
     *   · 直接 2xx（理论不发生，preview 成功走 302）→ 同样 resolve；
     *   · 400/502/503/504 等 → 读结构化错误 { error:{ code, message } } 抛友好错误（reject）；
     *   · 401 → 会话失效，与 request() 一致跳 login.html。
     * manual 只影响 3xx 跟随，非 3xx 响应仍可正常读取 status/body，因此能精确区分成功与失败。
     */
    async check(params) {
      const url = api.preview.url(params)
      let resp
      try {
        resp = await fetch(url, { method: 'GET', redirect: 'manual', credentials: 'same-origin' })
      } catch {
        throw new Error('网络错误，无法连接试听服务')
      }
      if (resp.status === 401) {
        location.href = 'login.html'
        throw new Error('未授权')
      }
      // 302 成功：opaqueredirect（status 0，无法读 Location，但直链已由后端定位，交 audio 跟随）
      if (resp.type === 'opaqueredirect' || resp.status === 0 || resp.ok) return url
      const data = await resp.json().catch(() => ({}))
      const code = data?.error?.code || ''
      const e = new Error(previewErrMsg(resp.status, code, data?.error?.message))
      e.status = resp.status
      e.code = code
      throw e
    },
  },

  // ---------- 7. 状态 ----------
  status: () => request('/status'),
}

// ---------- P0-A2：统一下载音质来源 ----------

/** 缓存的 settings.download.defaultQuality（main.js 启动时经 initQualityCache 写入） */
let _cachedDefaultQuality = null

/**
 * 启动时从 GET /settings 读取默认音质并缓存（main.js 调用一次）。
 * P0 D4：/settings 实际返回嵌套结构 { auth, download:{ defaultQuality }, scrape, smokeTest }，
 * 此前误读顶层 s.defaultQuality → 永远拿不到值，本回退分支为死代码、顶栏 #dl-quality 也无法播种。
 * 失败静默（回退 'flac'）。
 */
export async function initQualityCache() {
  try {
    const s = await api.settings.get()
    const q = s?.download?.defaultQuality
    if (q) _cachedDefaultQuality = q
  } catch {
    /* 拿不到设置：回退 'flac' */
  }
  // 同步全局控件初始值（若 DOM 已就绪）
  const sel = document.getElementById('dl-quality')
  if (sel && _cachedDefaultQuality) sel.value = _cachedDefaultQuality
}

/**
 * 统一下载音质读取（单一优先级）：
 *   全局控件 #dl-quality > settings.download.defaultQuality 缓存 > 'flac'
 *
 * 替代原 home.js DL_QUALITY 硬编码 / playlists.js 跨页读 $('#quality')。
 */
export function getDownloadQuality() {
  const sel = document.getElementById('dl-quality')
  if (sel && sel.value) return sel.value
  if (_cachedDefaultQuality) return _cachedDefaultQuality
  return 'flac'
}
