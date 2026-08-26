/**
 * SSE (Server-Sent Events) 封装 — GET /api/v1/sse/subscribe
 *
 * - 全局单条 EventSource，多页面共享；首个订阅者触发建连
 * - 断线自动重连：浏览器原生重试优先，连接被彻底关闭(CLOSED)时按
 *   指数退避（1s → 2s → … 上限 15s）手动重建
 * - 每次（重）连成功，服务端首包 `connected` 事件会透传给订阅者；
 *   按 API.md 约定，业务侧应借此调 GET /api/v1/tasks 做一次全量对账，
 *   避免断线期间漏掉的事件
 * - 会话鉴权走同源 Cookie，EventSource 自动携带
 * - v0.2.5：URL 经 api.js 的 API_BASE 拼接网关前缀（iframe 入口下同源可达）
 */

import { API_BASE } from './api.js'

const URL_PATH = API_BASE + '/api/v1/sse/subscribe'
const MAX_RETRY_DELAY = 15000

/** 服务端可能推送的事件名（与 server/src/routes/sse.ts 保持一致） */
const EVENT_NAMES = [
  'connected',
  'task:created',
  'task:pending',
  'task:active',
  'task:progress',
  'task:completed',
  'task:completed_with_warnings',
  'task:failed',
  'task:canceled',
  'source:changed',
  'source:update-alert',
  'smoke:completed',
  'smoke:failed',
  'scrape:update',
  'scrape:progress',
  'scan:progress', // v0.2.1 模块六：本地音乐库扫描进度（SSE 按 uid 过滤，前端无需处理 uid 字段）
]

const listeners = new Map() // event -> Set<fn>
let es = null
let retryDelay = 1000
let reconnectTimer = null

function emit(event, data) {
  const set = listeners.get(event)
  if (!set || !set.size) return
  for (const fn of [...set]) {
    try {
      fn(data)
    } catch (err) {
      console.error(`[sse] 事件 ${event} 监听器执行出错`, err)
    }
  }
}

function bindEvents() {
  for (const name of EVENT_NAMES) {
    es.addEventListener(name, (e) => {
      let data = null
      try {
        data = JSON.parse(e.data)
      } catch {
        /* data 保持 null */
      }
      emit(name, data)
    })
  }
  es.onopen = () => {
    retryDelay = 1000 // 连上了，重置退避
    emit('sse:state', 'online')
  }
  es.onerror = () => {
    emit('sse:state', 'offline')
    // readyState === CONNECTING：浏览器会自行重连，无需干预；
    // CLOSED（服务端长时间不可用等）：由我们按退避节奏重建。
    if (es && es.readyState === EventSource.CLOSED) scheduleReconnect()
  }
}

function scheduleReconnect() {
  if (reconnectTimer) return
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null
    retryDelay = Math.min(retryDelay * 2, MAX_RETRY_DELAY)
    connect()
  }, retryDelay)
}

function connect() {
  if (es) {
    try {
      es.close()
    } catch {
      /* ignore */
    }
  }
  es = new EventSource(URL_PATH)
  bindEvents()
}

/**
 * 订阅事件，返回取消订阅函数。
 * @param {string} event 事件名（含 'connected' / 'sse:state'）
 * @param {(data: any) => void} fn
 */
export function on(event, fn) {
  let set = listeners.get(event)
  if (!set) {
    set = new Set()
    listeners.set(event, set)
  }
  set.add(fn)
  if (!es && !reconnectTimer) connect()
  return () => off(event, fn)
}

export function off(event, fn) {
  const set = listeners.get(event)
  if (set) set.delete(fn)
}

/** 关闭连接（页面卸载等场景） */
export function close() {
  if (reconnectTimer) {
    clearTimeout(reconnectTimer)
    reconnectTimer = null
  }
  if (es) {
    es.close()
    es = null
  }
}
