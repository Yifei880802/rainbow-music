/**
 * storage.js — localStorage/sessionStorage 统一封装（v0.2.1 模块六 · 多账号数据隔离）
 *
 * - 键自动加前缀 `rainbow.<uid>.<key>`；uid 来自 GET /api/v1/me（应用启动早期由
 *   main.js 顶层 await initUid() 确定，先于首帧与任何页面模块的读写）。
 * - 读顺序（老用户偏好零丢失的迁移语义）：
 *     1. `rainbow.<uid>.<key>`（新前缀键优先）
 *     2. miss 时回落旧无前缀键 `rainbow.<key>`（v0.2.0 及以前的存量值）
 * - 写恒落新前缀键 `rainbow.<uid>.<key>`，从不触碰旧键（旧值原样保留可回退）。
 * - 无 uid（未登录 401 / 网络失败 / 服务端旧版本无 /me）：读写完全走旧无前缀键，
 *   与 v0.2.0 行为逐字节一致。
 * - uid='legacy'（本地模式 admin 的回退身份）：读回落旧键 → 存量偏好直接生效；
 *   新写入落 `rainbow.legacy.<key>`（下次读取优先命中新键）。
 * - 换账号登录（uid 变化）：不清旧数据，只切前缀——各账号数据天然互不可见。
 * - 隐私模式/配额满：所有写操作 try/catch 静默降级（仅本会话内失效，项目惯例）。
 */

/** 内存中的当前身份（null = 未确定/未登录，走旧无前缀键） */
let uid = null
/** /api/v1/me 完整负载缓存（顶栏用户徽章等消费，避免二次请求） */
let meInfo = null

/** 当前 uid（未确定为 null；供登出等场景读取） */
export function currentUid() {
  return uid
}

/** 当前 /me 身份负载（{uid,username,isAdmin,mode} 或 null） */
export function currentUser() {
  return meInfo
}

/**
 * 启动早期确定 uid：main.js 顶层 await 调用（先于首帧与页面模块渲染）。
 * - 成功 → 缓存 uid 与完整 me 负载（含 username/isAdmin，供顶栏徽章消费）
 * - 401/网络失败/超时（3s 防御）/响应异常 → uid=null 回落旧无前缀键
 * - 原生 fetch 而非 api.js：避免 401 时 request() 的登录页跳转副作用
 *   （未登录访问 index.html 的跳转由其他 api 调用按既有路径完成）
 */
export async function initUid() {
  try {
    const resp = await Promise.race([
      fetch('/api/v1/me', { credentials: 'same-origin' }),
      new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), 3000)),
    ])
    if (!resp.ok) return null // 401/404/5xx：回落旧键（未登录或后端为 v0.2.0）
    const data = await resp.json()
    if (data && data.uid) {
      uid = String(data.uid)
      meInfo = data
      return uid
    }
  } catch {
    /* 网络不可用/超时：回落旧键 */
  }
  return null
}

/** 登出时清内存身份（下个会话重新探测；不动 localStorage 中任何账号数据） */
export function resetUid() {
  uid = null
  meInfo = null
}

/** 实际存储键：有 uid 走新前缀命名空间，无 uid 沿用旧无前缀键（v0.2.0 兼容） */
function fullKey(key) {
  return uid ? `rainbow.${uid}.${key}` : `rainbow.${key}`
}

/** 旧无前缀键（v0.2.0 存量；仅读回落与删除清理时使用） */
function legacyKey(key) {
  return `rainbow.${key}`
}

function bindApi(backend) {
  return {
    /** 读：新前缀键优先，miss 回落旧无前缀键（老用户偏好零丢失） */
    get(key) {
      try {
        const v = backend.getItem(fullKey(key))
        if (v !== null) return v
        if (uid) return backend.getItem(legacyKey(key))
      } catch {
        /* 存储不可用：视为无值 */
      }
      return null
    },
    /** 写：恒落新前缀键；uid 为空时与旧键行为一致（fullKey 即旧键） */
    set(key, val) {
      try {
        backend.setItem(fullKey(key), String(val))
      } catch {
        /* 隐私模式/配额满：仅本会话内失效 */
      }
    },
    /** 删：新键必删；有 uid 时连同旧键一并清理（避免残留误导后续读取回落） */
    remove(key) {
      try {
        backend.removeItem(fullKey(key))
        if (uid) backend.removeItem(legacyKey(key))
      } catch {
        /* 存储不可用：忽略 */
      }
    },
  }
}

/** localStorage 封装（跨会话偏好：视图/密度/缓存/最近播放等） */
export const store = bindApi(window.localStorage)

/** sessionStorage 封装（会话内状态：详情返回滚动位置等；同款前缀语义） */
store.session = bindApi(window.sessionStorage)
