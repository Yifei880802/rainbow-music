import fs from 'node:fs'
import Fastify from 'fastify'
import fastifyStatic from '@fastify/static'
import fastifyMultipart from '@fastify/multipart'
import path from 'node:path'
import { config, ROOT_DIR } from './core/config.js'
import { logger } from './core/logger.js'
import { statusRoutes } from './routes/status.js'
import { searchRoutes } from './routes/search.js'
import { hotPlaylistsRoutes } from './routes/hotPlaylists.js'
import { playlistSquareRoutes } from './routes/playlistSquare.js'
import { downloadRoutes } from './routes/download.js'
import { playRoutes } from './routes/play.js'
import { coverRoutes } from './routes/cover.js'
import { lyricRoutes } from './routes/lyric.js'
import { sseRoutes } from './routes/sse.js'
import { sourceRoutes } from './routes/sources.js'
import { playlistRoutes } from './routes/playlists.js'
import { settingsRoutes } from './routes/settings.js'
import { scrapeRoutes } from './routes/scrape.js'
import { healthRoutes } from './routes/health.js'
import { authRoutes, registerAuthGuard, GATEWAY_URL_PREFIX } from './routes/auth.js'
import { meRoutes } from './routes/me.js'
import { libraryRoutes } from './routes/library.js' // v0.2.1 模块四：本地音乐库扫描/流播/封面
import { createRateLimiter } from './core/rate-limit.js'
import { createGatewayStatsHook } from './core/gateway-stats.js' // v0.2.12：网关注册诊断计数（两实例共享单例）
import { startSmokeScheduler } from './core/smoke/scheduler.js'
import { sourceEngine } from './core/source-engine/index.js'
import { downloadQueue } from './core/download/queue.js'
import { cleanupTmpResidue } from './core/download/index.js'
import { wireEvents } from './core/events.js'
import { scrapeService } from './core/scrape.js'

/** buildApp 选项：per-instance 信任门（模块二核心安全设计）
 *  - false → TCP 实例：忽略 X-Trim-* 头，admin 账密登录（v0.2.0 行为）
 *  - true  → 网关实例：采信 fnOS 统一网关注入的可信 X-Trim-* 头 */
interface BuildAppOptions {
  trustGatewayHeaders: boolean
}

/**
 * 网关前缀剥离（v0.2.5）：fnOS 统一网关按官方语义**保留完整前缀**转发——
 * `GET /app/com.rainbow.music/api/v1/...` 原样到达应用 socket（fygo 实践一致）。
 * 网关实例用 Fastify 的 rewriteUrl 构造选项在**路由查找之前**剥掉前缀段，
 * 使路由/鉴权守卫/限流/静态资源全部按无前缀路径工作；TCP 实例零改动。
 *
 * 注意不能用 onRequest hook 改 url：Fastify 的路由匹配发生在 onRequest 之前，
 * hook 里改写对本次请求的路由结论无效；rewriteUrl 是官方提供的路由查找前
 * 重写点（直接改写 raw req.url，守卫/限流读的 req.raw.url 同步生效）。
 * 纯字符串操作不经 URL 对象解析（req.url 是相对形态）；任何异常 fail-open
 * 返回原 url（等价无前缀行为，由静态兜底/404 自然接管）。
 */
function stripGatewayPrefix(req: { url?: string }): string {
  try {
    const url = req.url ?? ''
    // 前缀根（无尾斜杠）：重写为 /；带 query 时保留 query 部分
    if (url === GATEWAY_URL_PREFIX) return '/'
    if (url.startsWith(GATEWAY_URL_PREFIX + '?')) return '/' + url.slice(GATEWAY_URL_PREFIX.length)
    // 前缀 + 路径：去掉前缀段，保留 / 起始的剩余部分与 query
    if (url.startsWith(GATEWAY_URL_PREFIX + '/')) return url.slice(GATEWAY_URL_PREFIX.length)
    return url
  } catch {
    return req.url ?? '/'
  }
}

/**
 * 构建 Fastify 实例（插件/路由/静态资源注册；不含任何单例初始化——
 * sourceEngine/downloadQueue/wireEvents/scrapeService/startSmokeScheduler/
 * cleanupTmpResidue 均在 main() 顶层只跑一次，两实例共享，绝不能进本函数）。
 */
async function buildApp(opts: BuildAppOptions) {
  const app = Fastify({
    loggerInstance: opts.trustGatewayHeaders ? logger.child({ inst: 'gateway' }) : logger,
    // 仅网关实例启用前缀重写（v0.2.5）；TCP 实例无此选项，行为不变
    ...(opts.trustGatewayHeaders ? { rewriteUrl: stripGatewayPrefix } : {}),
  })

  await app.register(fastifyMultipart, { limits: { fileSize: 5 * 1024 * 1024 } })

  // 应用层限流（放在鉴权之前，先挡住洪水；仅 /api/* 生效；每实例独立分桶）
  if (config.rateLimit.enabled) {
    app.addHook('onRequest', createRateLimiter({ windowMs: config.rateLimit.windowMs, max: config.rateLimit.max }))
  }

  // v0.2.12 网关注册诊断：被动统计 /api/v1/* 流量来源（网关实例的到达即网关转发
  // 证明；仅计业务 API，静态资源减噪）。挂限流之后——被限流拒绝的洪水不进统计。
  // 结果经 GET /api/v1/status 的 gatewayHealth 块暴露，前端据此展示引导横幅。
  app.addHook('onRequest', createGatewayStatsHook(opts.trustGatewayHeaders))

  // 鉴权守卫必须在所有业务路由/静态资源之前装到根 app（全局生效）
  registerAuthGuard(app, { trustGatewayHeaders: opts.trustGatewayHeaders })
  await app.register(authRoutes, { trustGatewayHeaders: opts.trustGatewayHeaders })
  await app.register(meRoutes, { trustGatewayHeaders: opts.trustGatewayHeaders })
  await app.register(libraryRoutes) // 模块四：库路由自身按 req.user.uid 隔离，无需实例级选项

  await app.register(statusRoutes)
  await app.register(searchRoutes)
  await app.register(hotPlaylistsRoutes) // #60 热门歌单聚合（首页数据源）
  await app.register(playlistSquareRoutes) // #67 歌单广场聚合（wy/tx 轻量列表，详情复用 songlist/detail）
  await app.register(downloadRoutes)
  await app.register(playRoutes)
  await app.register(coverRoutes)
  await app.register(lyricRoutes)
  await app.register(sseRoutes)
  await app.register(sourceRoutes)
  await app.register(playlistRoutes)
  await app.register(settingsRoutes)
  await app.register(scrapeRoutes)
  await app.register(healthRoutes)

  // Web 后台静态资源（web/ 目录），放最后避免抢占 /api 路由
  await app.register(fastifyStatic, {
    root: path.join(ROOT_DIR, 'web'),
    prefix: '/',
  })

  return app
}

async function main(): Promise<void> {
  // ── 单例初始化（进程级，只跑一次，两实例共享）──
  // 音源引擎 + 下载队列启动（引擎先起，队列依赖它取 URL）
  await sourceEngine.start()
  // #73 下载目录 .tmp-* 残留清理：刻意放在 downloadQueue.init() 之前 await——
  // init 恢复 pending 任务后即可能产生新的在途 .tmp 文件，先清理可避免误删；
  // 函数内部全量 try/catch，任何失败都不阻塞启动
  await cleanupTmpResidue()
  downloadQueue.init()
  wireEvents() // 事件总线接线（供 SSE 广播）
  scrapeService.init() // #45 刮削：重启后在途 running 归 failed（可重试）
  scrapeService.wire(downloadQueue) // #45 刮削：订阅下载完成事件旁路触发（fire-and-forget）
  startSmokeScheduler() // 冒烟测试定时器

  if (config.rateLimit.enabled) {
    logger.info({ windowMs: config.rateLimit.windowMs, max: config.rateLimit.max }, 'rate limit enabled')
  }

  // ── TCP 实例（v0.2.0 行为：admin 账密登录，忽略 X-Trim-* 头）──
  const apps: Array<{ close(): Promise<unknown> }> = []
  const tcpApp = await buildApp({ trustGatewayHeaders: false })
  apps.push(tcpApp)
  await tcpApp.listen({ host: config.server.host, port: config.server.port })
  logger.info(`Rainbow server listening on http://${config.server.host}:${config.server.port}`)

  // ── 网关实例（仅当 RO_GATEWAY_SOCK 存在：Unix Socket + 采信 X-Trim-* 头 +
  //    v0.2.5 前缀重写；未设置该环境变量时行为与 v0.2.0 完全一致，单 TCP 实例）──
  const sockPath = process.env.RO_GATEWAY_SOCK
  if (sockPath) {
    const gwApp = await buildApp({ trustGatewayHeaders: true })
    apps.push(gwApp)
    // 监听前清掉上次进程残留的 socket 文件（否则 EADDRINUSE）
    try {
      fs.unlinkSync(sockPath)
    } catch {
      /* 首次启动无旧文件，忽略 */
    }
    await gwApp.listen({ path: sockPath })
    try {
      fs.chmodSync(sockPath, 0o660)
    } catch (err) {
      logger.warn({ err: (err as Error).message }, `[gateway] chmod ${sockPath} failed (ignored)`)
    }
    // v0.2.5：socket 属主对齐应用运行身份（fygo 实践：网关以应用 uid/gid 连接 socket；
    // 容器以 root 运行时 socket 建成 root:root，属主不匹配时网关可能连不上）。
    // TRIM_RUN_UID/TRIM_RUN_GID 由 fnOS 渲染 compose 注入（纯数字校验，非法/缺省跳过）；
    // chown 失败仅告警不阻塞启动——属主问题至多影响网关链路，应用本身必须能起。
    const runUid = /^\d+$/.test(process.env.TRIM_RUN_UID ?? '') ? Number(process.env.TRIM_RUN_UID) : null
    const runGid = /^\d+$/.test(process.env.TRIM_RUN_GID ?? '') ? Number(process.env.TRIM_RUN_GID) : null
    if (runUid !== null && runGid !== null) {
      try {
        fs.chownSync(sockPath, runUid, runGid)
        logger.info(`[gateway] socket owner set to ${runUid}:${runGid}`)
      } catch (err) {
        logger.warn({ err: (err as Error).message }, `[gateway] chown ${sockPath} failed (ignored)`)
      }
    }
    logger.info(`Rainbow gateway instance listening on unix socket ${sockPath} (X-Trim-* headers trusted, prefix ${GATEWAY_URL_PREFIX} stripped)`)
  }

  registerGracefulShutdown(apps)
}

/**
 * 优雅停机（SIGTERM/SIGINT，覆盖全部已监听实例）：
 *  1. 队列停止出队新任务，在途 active 置回 pending 并写干净停机标记
 *     （下次启动 init() 据此不计数熔断 → 正常重启/发版不误伤健康任务）；
 *  2. 关闭 HTTP 服务（TCP + 网关两实例，停止收新请求，限时等待，
 *     避免 SSE 长连接卡死停机）；
 *  3. exit 0（tag worker 已 unref，不阻塞退出）。
 */
function registerGracefulShutdown(apps: Array<{ close(): Promise<unknown> }>): void {
  let shuttingDown = false
  const shutdown = (signal: string): void => {
    if (shuttingDown) return
    shuttingDown = true
    logger.warn({ signal }, 'graceful shutdown initiated')
    try {
      downloadQueue.shutdown()
    } catch (err) {
      logger.error({ err: (err as Error).message }, 'queue shutdown failed (continuing)')
    }
    // 限时关闭：SSE/keep-alive 长连接可能卡住 app.close()，5s 后强制退出
    const forceExit = setTimeout(() => {
      logger.warn('app.close() timed out (5s), forcing exit')
      process.exit(0)
    }, 5000)
    forceExit.unref()
    void Promise.allSettled(apps.map((a) => a.close()))
      .catch((err) => logger.warn({ err: (err as Error).message }, 'app.close() error (ignored)'))
      .finally(() => {
        logger.info('shutdown complete')
        process.exit(0)
      })
  }
  process.on('SIGTERM', () => shutdown('SIGTERM'))
  process.on('SIGINT', () => shutdown('SIGINT'))
}

main().catch((err) => {
  logger.error(err)
  process.exit(1)
})
