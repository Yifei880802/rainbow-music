# Rainbow 开发说明

面向开发者的架构说明与本地开发/构建/打包指南。用户文档见 [USER-GUIDE.md](./USER-GUIDE.md)，API 参考见 [../API.md](../API.md)。

---

## 目录

- [仓库结构](#仓库结构)
- [后端架构（server/src）](#后端架构serversrc)
- [前端结构（web/）](#前端结构web)
- [fpk 打包层](#fpk-打包层)
- [配置系统与性能加固项](#配置系统与性能加固项)
- [本地开发](#本地开发)
- [构建与发布](#构建与发布)
- [发布前本地门禁](#发布前本地门禁)

---

## 仓库结构

```
rainbow/
├── server/                # Fastify + TypeScript 后端（Node ≥ 20）
├── web/                   # 原生 HTML/CSS/JS 前端（ES Modules，无构建步骤）
├── fpk/                   # 飞牛 NAS .fpk 打包层（manifest、图标、compose 模板）
├── scripts/
│   ├── build-fpk.sh       # fpk 打包脚本（读 FPK_VERSION / FPK_IMAGE / FPK_IMAGE_TAG）
│   ├── verify-ci.sh       # 发布前本地 CI 门禁（一键复跑 workflow 前四段）
│   └── bench.mjs          # 性能基准脚本
├── data/                  # 运行数据（downloads / sources / db，volume 映射）
├── .github/workflows/     # CI：build.yml（tag v* → 镜像 → fpk → Release）
├── Dockerfile             # 多阶段构建（amd64/arm64 buildx）
├── compose.yaml           # 源码构建用 Compose
├── config.example.yaml    # 配置模板
└── API.md                 # REST API 完整参考
```

---

## 后端架构（server/src）

入口 `index.ts`：装配鉴权守卫（**必须注册在根 app 的 `onRequest` hook**，否则会被 Fastify 插件封装隔离）、限流、路由与静态资源。

```
src/
├── index.ts               # 入口装配
├── core/
│   ├── config.ts          # config.yaml 加载 / 首启自动生成 / 运行时 patch（见下节）
│   ├── logger.ts          # pino 日志
│   ├── events.ts          # 事件总线（SSE 数据源）
│   ├── rate-limit.ts      # 内存固定窗口限流（仅 /api/*）
│   ├── auth/              # session（内存）+ API Key 双通道校验
│   ├── source-engine/     # 音源引擎：node:vm + worker_threads 双层沙箱、热重载、音质降级链
│   ├── adapters/          # 5 平台适配器（kw/kg/tx/wy/mg）
│   │   ├── common.ts      # 公共契约
│   │   ├── http.ts        # 出站 HTTP 封装
│   │   ├── match.ts       # findMusic 跨平台匹配（换源兜底核心）
│   │   └── metadata.ts    # 标签嵌入（flac-tagger / node-id3 + sharp）
│   ├── search/            # 搜索服务：单平台 + aggregate 聚合
│   ├── orchestrator/      # 取 URL 两段式编排 + 跨平台换源兜底
│   ├── download/          # 下载队列（p-queue）、tag-worker（元数据嵌入 worker）
│   ├── db/                # better-sqlite3 + drizzle-orm（任务/歌单/冒烟表）
│   ├── notify/            # Bark + Server酱 告警
│   └── smoke/             # 健康冒烟测试 + cron scheduler
└── routes/                # REST 路由（auth/search/download/tasks/playlists/sources/settings/sse/health/status）
```

**关键技术决策：**

| 决策 | 说明 |
|---|---|
| `node:vm` + worker_threads 沙箱 | 部署环境无 g++，不用 isolated-vm（需 node-gyp）；个人自用隔离水位等价 |
| SQLite + p-queue 替代 Redis/BullMQ | 单进程自用，免外部依赖，目标 RSS < 300MB（实测 ≈ 198MB） |
| session 存内存 | 重启失效重登即可，避免持久化 token 复杂度 |
| 原生模块容器内编译 | better-sqlite3 / sharp 在 builder 阶段（node:22-bookworm，含工具链）编译，运行阶段 node:22-bookworm-slim |

**换源兜底流程**（`orchestrator`）：主平台音质降级链 `flac24bit → flac → 320k → 128k` 全失败 → `findMusic` 跨平台匹配同款 → 逐候选平台各试一次（对齐 lx-music 原版 `retryedSource`）。换源命中后：歌词/封面走实际命中平台，曲目信息保留原曲，任务标记 `completed_with_warnings`。

---

## 前端结构（web/）

原生 ES Modules，**无框架、无构建步骤**，由后端 `@fastify/static` 直接伺服：

```
web/
├── index.html             # 主界面（6 页签：搜索/任务/歌单/音源/设置/健康）
├── login.html + login.js  # 登录页
├── style.css              # 全站样式
└── js/
    ├── main.js            # 入口：页签路由 + 登录态 + 移动端导航折叠
    ├── api.js             # REST 封装（fetch + 错误处理）
    ├── sse.js             # EventSource 订阅 + 断线对账
    ├── ui.js              # DOM 工具（$ / $$ 等）
    └── pages/             # 每页一个模块，按需懒初始化（init 只跑一次）
        ├── search.js / tasks.js / playlists.js
        ├── sources.js / settings.js / health.js
```

约定：`pages/*.js` 导出 `init()`（首次进入时执行一次）与可选 `show()`；实时状态统一走 `sse.js` 的事件订阅，断线重连后调 `GET /api/v1/tasks` 全量对账。

---

## fpk 打包层

`.fpk` 是飞牛应用中心的安装包格式，本质是「manifest + 资源 + compose 模板」的打包体，应用本体仍以 Docker 容器运行。

- `fpk/`：包描述文件、图标、compose 模板等打包素材；
- `scripts/build-fpk.sh`：打包入口，**通过环境变量注入版本信息**：

  | 变量 | 含义 | 示例 |
  |---|---|---|
  | `FPK_VERSION` | fpk 版本号（不带 v） | `0.2.0-r1` |
  | `FPK_IMAGE` | 镜像名 | `ghcr.io/<owner>/rainbow-music` |
  | `FPK_IMAGE_TAG` | 镜像 tag，**必须与已推送镜像一致** | `v0.2.0-r1` |
  | `FPK_IMAGE_DIGEST` | 可选。镜像的**多架构 index digest**；给了就把 compose 的 image 钉成 `<image>:<tag>@<digest>`。本地构建但没推送过的镜像不存在 registry digest，所以这个值**只能由 CI 注入** | `sha256:30acda7e…` |

  产物：`dist-fpk/rainbow-${FPK_VERSION}.fpk`。fnpack 二进制不可得时脚本自动走**降级组装路径**（下载失败时的 CI 兜底即此路径）。
  
  - **fnpack 工具**：官方二进制置于 `tools/fnpack`（已加入 .gitignore，不入库），从飞牛官方渠道获取：开发者文档 https://developer.fnnas.com/docs/cli/fnpack ，直链形如 `https://static2.fnnas.com/fnpack/fnpack-1.2.3-<os>-<arch>`（本机为 darwin-arm64，下载后 `chmod +x`）；构建时以 `FNPACK_BIN=$PWD/tools/fnpack` 传入即可走官方打包路径（产物含 app.tgz + checksum 官方结构）。
  - **CI 侧 fnpack 集成**：`build.yml` 的 fpk 作业在调 `build-fpk.sh` 前先从官方直链 `https://static2.fnnas.com/fnpack/fnpack-1.2.3-linux-amd64` 下载二进制（按 runner 架构选 amd64/arm64），`chmod +x` 后以 `FNPACK_BIN` 注入走官方打包路径；下载失败**不中断流水线**，`build-fpk.sh` 自动降级为手工 tar 组装并输出 `::warning::` 醒目提示（与脚本既有降级语义一致）。

- **版本策略**：tag = `vX.Y.Z-rN`（rN 为打包修订号：同一应用版本换包/修包递增）。镜像 tag 与 fpk compose 中的 tag **逐字符一致**，全程禁用 `latest`，保证升级/回滚行为确定。
  - **digest pin**：正式发布时 compose 里的引用还会额外钉上 index digest，形如 `<image>:<tag>@<digest>`。digest 决定实际拉哪个镜像，tag 被重推也拉不到别的东西；tag 同时保留，`docker images` 里仍有可读标签。必须钉 **index** digest（`application/vnd.oci.image.index.v1+json`）而非单平台 digest，否则 arm64 用户会被静默拉到 amd64 镜像。
  - digest 由 CI 的 docker 作业从 buildx `--metadata-file` 读出（多平台 `--push` 下 `containerimage.digest` 即 index digest），经作业 `outputs` 传给 fpk 作业。读不到合法值就**让流水线红掉**：静默退回纯 tag 引用等于悄悄撤销 pin，而且会一路带到已发布的 Release 上，事后极难发现。这与 fnpack 下载失败可降级的语义**故意不同**。

本地打包：

```bash
FPK_VERSION=0.2.0-r1 \
FPK_IMAGE=ghcr.io/<owner>/rainbow-music \
FPK_IMAGE_TAG=v0.2.0-r1 \
scripts/build-fpk.sh
```

本地不传 `FPK_IMAGE_DIGEST`——没推送过的镜像没有 registry digest。因此本地产物恒为纯 tag 引用，仅供验证，不代表正式发布的形态。

---

## 配置系统与性能加固项

`config.ts` 行为要点：

- **首启自动生成**：`config.yaml` 不存在时按内置默认值生成，并**随机生成强密码**（仅日志打印一次），禁止 admin/admin；
- **路径语义**：`download.dir` / `sources.dir` 支持绝对路径（fnOS 常配 `/vol1/1000/downloads`），写回时保持原相对/绝对写法；
- **环境变量覆盖**：`RO_SERVER_PORT` / `RO_SERVER_HOST` / `RO_AUTH_APIKEY` / `RO_LOG_LEVEL` / `RO_CONFIG` / `RO_DB_DIR`；
- **运行时 patch**：设置页 PATCH 走 `patchConfig()` 深合并落盘；`server` / `auth` 等字段只落盘、需重启生效；
- **密钥脱敏**：API 读取只返回「是否已设置」布尔值，绝不回显明文。

### 下载管线性能加固配置项（`download.*`，全部可选，缺省用代码默认值）

| 配置项 | 默认 | 说明 |
|---|---|---|
| `autoConcurrency` | `true` | 并发 = clamp(CPU 核数, 2, 6)；`false` 时以 `concurrency` 手动值优先 |
| `retryMax` | `3` | 任务失败自动重试次数 |
| `retryBaseDelayMs` | `1000` | 重试指数退避基础延迟（1s/2s/4s） |
| `progressFlushIntervalMs` | `500` | 进度落盘节流：时间阈值(ms) |
| `progressFlushPercentStep` | `2` | 进度落盘节流：百分比阈值 |
| `memGuardIntervalMs` | `5000` | RSS 采样周期(ms) |
| `memLimitMB` | `400` | RSS 达阈值时暂停出队（内存护栏）；阈值须低于容器 cgroup 内存上限（经验值 ~83%）：512m → 400、384m → 320、256m → 200，否则内核 OOM kill 会先于护栏生效（死护栏） |
| `batchActivationSize` | `200` | 批量任务分批激活上限 |
| `tagWorkers` | `clamp(floor(CPU/2), 1, 2)` | 元数据嵌入 worker 数 |

其余通用项（`concurrency` / `defaultQuality` / `nameTemplate` / `embedCover` / `embedLyric` / `coverSize` 等）见 `config.example.yaml`。

基准参考（384m 容器实测）：batch 200 任务、容器内存上限 384m 下，内存峰值 110.9MiB（占上限 28.9%），全程无 OOM，吞吐 33.7 任务/分钟。该数据佐证护栏阈值按 ~83% 上限配置后余量充足；同时也说明小容器场景下实际 RSS 远低于默认 400MB 阈值，阈值必须随容器上限收紧才有意义。

---

## 本地开发

前置：Node.js ≥ 20（推荐 22）、npm。

```bash
cd server
npm install                        # better-sqlite3/sharp 会本地编译，需构建工具链
cp ../config.example.yaml ../config.yaml   # 项目根准备配置（首次也可靠应用自动生成）

npm run dev                        # tsx watch 热重载，http://localhost:23330
npm run typecheck                  # tsc --noEmit
npm run build                      # tsc 产出 dist/
npm start                          # node dist/index.js（需先 build）
```

前端改动直接刷新浏览器即可（无构建步骤）。数据落在项目根 `data/`，删库重来：停服务后删 `data/db/`。

---

## 构建与发布

**Docker 镜像**（多阶段，原生模块容器内编译）：

```bash
docker compose build && docker compose up -d

# 多架构构建并推送
docker buildx build --platform linux/amd64,linux/arm64 \
  -t ghcr.io/<owner>/rainbow-music:v0.2.0-r1 --push .
```

**CI 发布流水线**（`.github/workflows/build.yml`）：

```
push tag v*（或 workflow_dispatch 输入 version）
  └─ meta：解析/校验版本号 → version / image_tag / image
       └─ build：node 20，cd server && npm ci && npm run typecheck && npm run build
            └─ docker：buildx amd64+arm64 → 推送 ghcr.io（GITHUB_TOKEN）
                 └─ fpk：scripts/build-fpk.sh（FPK_* 环境变量与推送 tag 严格一致）
                      └─ release：GitHub Release 上传 .fpk + 自动生成变更清单
```

发布步骤：改版本号（`server/package.json`）→ 提交 → 打 tag `vX.Y.Z-rN` 推送，流水线自动完成其余环节。

---

## 发布前本地门禁

`scripts/verify-ci.sh` 一键复跑 `.github/workflows/build.yml` 前四段（meta → build → docker → fpk），作为打 tag 发布前的本地门禁；逐段输出 PASS / FAIL / SKIP，任一 FAIL 退出码 1（SKIP 不影响结论但醒目提示）。

| 段 | 对应 workflow 作业 | 内容 |
|---|---|---|
| meta | `meta` | 版本校验（正则 `^[0-9]+\.[0-9]+\.[0-9]+(-r[0-9]+)?$`，与 workflow 一致）并推导 `image_tag=v${VERSION}` |
| build | `build` | `cd server && npm ci`（仅 node_modules 缺失时）`&& npm run typecheck && npm run build` |
| docker | `docker` | `docker buildx build --platform $PLATFORM -t ${FPK_IMAGE}:${image_tag} --load .`（本地只 load 不推送） |
| fpk | `fpk` | 注入 `FPK_VERSION / FPK_IMAGE / FPK_IMAGE_TAG`（及可选的 `FPK_IMAGE_DIGEST`）调 `scripts/build-fpk.sh`，解包产物（兼容 fnpack 官方 app.tgz 结构与降级 tar 结构），程序化比对 compose 内 image 与**预期引用**逐字符一致（给了 digest 则预期引用带 `@<digest>` 后缀），输出 `TAG_CONSISTENCY_PASS/FAIL`；另按是否传 digest 打印 `DIGEST_PIN_PASS` / `DIGEST_PIN_SKIP` 可读标记 |

用法：

```bash
scripts/verify-ci.sh                            # 全量门禁（需 docker/buildx 可用，默认 linux/arm64）
scripts/verify-ci.sh --skip-docker              # 跳过 buildx 构建与镜像检查
scripts/verify-ci.sh --platform linux/amd64     # 指定构建平台
VERSION=0.2.0-r1 scripts/verify-ci.sh           # 指定版本（默认取 fpk/manifest 的 version）
```

环境变量：`VERSION`（可选）、`FPK_IMAGE`（默认 `rainbow-music`；正式发布时 workflow 注入 `ghcr.io/<owner>/rainbow-music`，本地门禁建议显式传同一全名以校验最终镜像串）、`FPK_IMAGE_DIGEST`（可选；必须为 `sha256:` + 64 位小写 hex，格式非法在进作业链**之前**就报错退出——否则报错点会落到 `build-fpk.sh`，离门禁结论很远）、`FNPACK_BIN`（可选；缺失时 `build-fpk.sh` 自动降级为手工 tar 组装并打印降级警示，降级产物仅供本地验证）。

注意：docker 段不可用时报 FAIL 并提示 `colima start`；fpk 段产物落在 `dist-fpk/`，与正式发布共用目录，注意勿覆盖他人产物（要隔离就传 `FPK_OUT_DIR`）。

门禁盲区（已知，勿误信）：fpk 段比对的「预期引用」与实际 compose 内容**同源于 `FPK_IMAGE_DIGEST` 这一个环境变量**，所以它只能证明 digest 钉对了格式与位置，证明不了这个 digest 真指向正确镜像。真正的防线是 CI 里该值取自 docker 作业刚推送镜像的 buildx metadata，全程不经人手。同理，digest pin 也尚未通过真机 fnOS 安装/升级门禁验证。
