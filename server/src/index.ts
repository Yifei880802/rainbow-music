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
import { authRoutes, registerAuthGuard } from './routes/auth.js'
import { createRateLimiter } from './core/rate-limit.js'
import { startSmokeScheduler } from './core/smoke/scheduler.js'
import { sourceEngine } from './core/source-engine/index.js'
import { downloadQueue } from './core/download/queue.js'
import { cleanupTmpResidue } from './core/download/index.js'
import { wireEvents } from './core/events.js'
import { scrapeService } from './core/scrape.js'

async function main(): Promise<void> {
  const app = Fastify({ loggerInstance: logger })
  registerGracefulShutdown(app)

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

  await app.register(fastifyMultipart, { limits: { fileSize: 5 * 1024 * 1024 } })

  // 应用层限流（放在鉴权之前，先挡住洪水；仅 /api/* 生效）
  if (config.rateLimit.enabled) {
    app.addHook('onRequest', createRateLimiter({ windowMs: config.rateLimit.windowMs, max: config.rateLimit.max }))
    logger.info({ windowMs: config.rateLimit.windowMs, max: config.rateLimit.max }, 'rate limit enabled')
  }

  // 鉴权守卫必须在所有业务路由/静态资源之前装到根 app（全局生效）
  registerAuthGuard(app)
  await app.register(authRoutes)

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

  startSmokeScheduler() // 冒烟测试定时器

  await app.listen({ host: config.server.host, port: config.server.port })
  logger.info(`Rainbow server listening on http://${config.server.host}:${config.server.port}`)
}

/**
 * 优雅停机（SIGTERM/SIGINT）：
 *  1. 队列停止出队新任务，在途 active 置回 pending 并写干净停机标记
 *     （下次启动 init() 据此不计数熔断 → 正常重启/发版不误伤健康任务）；
 *  2. 关闭 HTTP 服务（停止收新请求，限时等待，避免 SSE 长连接卡死停机）；
 *  3. exit 0（tag worker 已 unref，不阻塞退出）。
 */
function registerGracefulShutdown(app: { close(): Promise<unknown> }): void {
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
    void app
      .close()
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
