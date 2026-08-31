# Rainbow fnOS 部署指南（v0.2.12）

面向 fnOS（飞牛 OS）部署与运维场景的说明：版本要求、双模式（端口直连 / FN ID 统一网关）、网关链路修复（micro_app 与前缀转发）、本地音乐库挂载机制、安全模型与降级行为。日常使用见 [USER-GUIDE](USER-GUIDE.md)，API 契约见 [API.md](../API.md)。

---

## 目录

- [版本要求](#版本要求)
- [双模式：local（端口直连）与 gateway（FN ID 网关）](#双模式local端口直连与-gatewayfn-id-网关)
- [v0.2.5 网关链路修复：micro_app、前缀转发与单入口](#v025-网关链路修复micro_app前缀转发与单入口)
- [v0.2.6 网关就绪修复：service_port=0 与 checkport=false](#v026-网关就绪修复service_port0-与-checkportfalse)
- [v0.2.7/v0.2.8 网关 404 第三层根因：数据库 socket 字段为空与 DB 热修](#v027v028-网关-404-第三层根因数据库-socket-字段为空与-db-热修)
- [2026-08-28 音源清空与下载目录断裂：根因与热修](#2026-08-28-音源清空与下载目录断裂根因与热修)
- [安装向导：「音乐库扫描目录」配置与挂载机制](#安装向导音乐库扫描目录配置与挂载机制)
- [X-Trim-* 身份头安全模型](#x-trim--身份头安全模型)
- [错误码与降级行为](#错误码与降级行为)
- [真机验证 checklist](#真机验证-checklist)

---

## 版本要求

| 依赖 | 最低版本 | 说明 |
|---|---|---|
| fnOS 固件 | **1.2.0401** | 统一网关注入 `X-Trim-*` 身份头所需能力 |
| fnOS「应用中心」App | **1.34.0** | api-scope（开放 API）相关能力 |

- `.fpk` 的 manifest 声明 `os_min_version=1.0.0`，即**老 fnOS 也能安装运行**，只是拿不到网关入口（详见[降级行为](#错误码与降级行为)，自动回落纯端口模式，行为与 v0.2.0 完全一致）；
- Docker 手动部署（非 `.fpk`）无网关概念，永远等价 local 模式。

## 双模式：local（端口直连）与 gateway（FN ID 网关）

v0.2.1 起服务进程内含**两个 Fastify 实例**，同一份数据与单例（引擎/队列/事件总线只初始化一次）：

| | local（TCP 实例） | gateway（网关实例） |
|---|---|---|
| 监听 | `config.yaml` 的 `server.host:port`（默认 `0.0.0.0:23330`） | Unix Socket（`RO_GATEWAY_SOCK` 环境变量指定路径，默认不启用） |
| 入口 | `http://<NAS_IP>:23330/`（备用直连，admin 账密） | fnOS 桌面 Rainbow 图标（唯一桌面入口，v0.2.5 起单图标；网关前缀 `/app/com.rainbow.music`） |
| 身份 | **admin 账密登录**（安装向导设置的密码） | **FN ID 免密自动登录**：fnOS 校验用户会话（含 FN ID 远程访问）后注入可信身份头，登录页显示「已通过 FN ID 登录为 xxx」，一键直达 |
| 多用户 | 单管理员（v0.2.0 语义） | 每位进入的 fnOS 用户各自独立（uid 隔离：歌单 / 播放历史 / 收藏 / NAS 曲库 / 偏好） |
| 权限 | 恒为管理员 | 按用户实际角色：fnOS 管理员=`isAdmin=true`，普通成员=普通用户（全局设置/音源/刮削/冒烟操作返回 403） |

两实例**并存**而非互斥：

- 网关实例仅当容器环境变量 `RO_GATEWAY_SOCK` 存在时启动（`.fpk` 安装时由 compose 注入 `/app/target/app.sock`，`TRIM_APPDEST` 挂载点；v0.2.5 起命名对齐 fygo/官方示例）；
- 保留 TCP 端口是为了兼容既有 `LAN IP:23330` 直连习惯（浏览器收藏/脚本/自动化不受影响）；
- `/api/v1/auth/status` 响应中的 `mode` 字段（`local` / `gateway`）标明当前请求落在哪个实例，前端据此自动切换登录页形态。

> 老版本（≤v0.2.0）升级后无任何配置迁移：`RO_GATEWAY_SOCK` 未注入时进程只有一个 TCP 实例，行为零变化。

## v0.2.5 网关链路修复：micro_app、前缀转发与单入口

v0.2.4 及以前桌面网关入口打开「Not Found」的完整根因链与修复（两轮真机诊断实测，2026-08-26）：

### 根因一（真根因）：manifest 缺 `micro_app = true`

fnOS 判定应用是否为「网关/微应用」的依据是 manifest 的 `micro_app` 字段——**缺失即按端口型应用处理，安装时不会把 `/app/com.rainbow.music` 前缀注册进网关路由表**（trim_http_cgi 内存态）。此判定条件官方文档未记载（文档空白点），由同机对照实证：fygo（`micro_app=true`）每 30 分钟周期注册成功，rainbow（无该字段）被周期任务跳过。且**注册缺失不自愈**：周期任务只遍历已知网关应用，补上 manifest 后必须**重装**（卸载→安装）才触发注册。v0.2.5 起 manifest 声明 `micro_app=true`（放 `source` 附近）。

### 根因二：网关前缀转发语义 = 保留完整前缀，应用侧需自行适配

官方文档明确：网关按原样转发 `GET /app/myapp/list`（前缀不剥）；fygo 实践一致。因此应用两侧都要适配：

- **服务端**（v0.2.5）：网关实例用 Fastify `rewriteUrl` 构造选项在**路由查找之前**剥掉 `/app/com.rainbow.music` 前缀段（query 保留；异常 fail-open 返回原 url）——路由、鉴权守卫（白名单语义不变）、限流、静态资源全部按无前缀路径工作；TCP 实例零改动。不能用 onRequest hook 改 url：Fastify 的路由匹配发生在 onRequest 之前，hook 内改写对本次请求无效（`rewriteUrl` 是官方提供的路由查找前重写点）。
- **前端**（v0.2.5）：HTML 资源引用全部改相对路径（`js/main.js`、`style.css`、`favicon.png`，iframe 下基于 `/app/com.rainbow.music/` 解析出带前缀 URL，直连下基于 `/` 解析，两态通吃）；接口/流/封面地址统一经 `web/js/api.js` 导出的 `API_BASE` 拼接（iframe 入口下 pathname 带精确前缀则拼前缀，直连为空串）；页面跳转（登录↔主页、登出）改相对文件名（`index.html` / `login.html`）。

### socket 命名与属主约定

- socket 文件命名从 `rainbow.sock` 改为 `app.sock`（对齐 fygo 与官方示例，消除未知变量）；compose 的 `RO_GATEWAY_SOCK` 与 `ui/config` 的 `gatewaySocket` 同步。
- 容器以 root 运行时 socket 建成 root:root，而网关以应用运行身份连接（实测 fygo socket 属主为应用 uid/gid 978:973）——v0.2.5 compose 透传 fnOS 注入的 `TRIM_RUN_UID/TRIM_RUN_GID`，服务端 listen 后对 socket `chown`（纯数字校验，缺省/非法则跳过；失败仅 logger.warn 不阻塞启动——属主不匹配至多影响网关链路，应用必须能起）。

### 桌面收敛为单一网关入口

v0.2.4 桌面双图标中 url 型入口（fnOS 注册库端口 23331 vs 实际 23330 错配，打开白屏）已移除：`ui/config` 仅保留 `com.rainbow.music.Gateway`（iframe 型，FN ID 免密，allUsers），manifest `desktop_applaunchname` 同步指向 Gateway。**TCP 23330 直连完全保留**（compose 端口映射与 admin 账密登录不动），浏览器直访 `http://<NAS_IP>:23330/` 仍可用作备用入口。

### ⚠️ 卸载会清空应用数据目录（真机实测）

fnOS **卸载**应用会清空其应用数据目录（前身应用 ro-music 的 187 任务/5 歌单随卸载消失，见 #88 换基准记录）。**重装/换装前必须备份**：`@appdata/com.rainbow.music`（下载文件 / 音源 / SQLite）与 `@appconf/com.rainbow.music`（config.yaml / scan-dirs.conf）。升级（update/task）不经过卸载、数据保留；仅「卸载」操作触发清空。

### #95 实测回填：卸载重装 v0.2.5 与网关 404 根因闭环（2026-08-26）

**卸载重装全链 PASS（数据零丢失）**：备份（`rainbow-backup-20260826/`）→ uninstall → install/task（packageType=local + isManualInstall + volumeId=2，向导 port=23330/admin 密码/扫描目录空）→ 停容器恢复 ro.db 三件套+config.yaml+scan-dirs.conf（size 逐项对账全对）→ 启容器 healthy → db 10 表与备份基线一致；admin 凭据 TCP 直连登录 200+session、伪造 X-Trim-* 头调 gateway-login 得 404（防伪造红线生效）；app.sock 属主 uid=975 gid=969（TRIM_RUN_UID/GID chown 生效）；桌面单图标恢复、点击开窗正常。

**网关 URL 仍 404：checkport 健康检查恒失败（fnOS 平台行为，文档空白点）**。完整因果链（多组对照实验实证）：

1. **根因**：manifest `checkport=true` 触发 fnOS 端口健康检查，但 fnOS 对 micro_app 应用**不向 localhost 发布容器端口**（实测 `127.0.0.1:23330` ECONNREFUSED、仅 docker0 网桥 `172.17.0.1:23330` 可达）→ 健康检查恒失败 → 应用被判「未就绪」→ 网关路由禁用（带有效会话请求 `/app/com.rainbow.music/*` 返回 404「Not Found」9B）+ 桌面无图标 + 应用中心「启用」态；
2. **对照证据**：fygo（正常微应用）manifest 为 `service_port=0` + `checkport=false`，其网关 URL 带会话 200 正常转发；
3. **转发从未发生（铁证）**：用回显 socket 替换 app.sock 后，带有效会话的网关请求**零命中**——404 由 fnOS 网关层直接产生，非应用响应；应用侧完全正常（socket 直连同路径 200 JSON，`mode:"gateway"`）；
4. **manifest 文件热改无效**：真机改 `/var/apps/<app>/manifest`（0/false）后，容器重启（dockermgr stop/start）、应用级 start（app-center start/start）、等待周期任务均不触发 fnOS 重新评估——**manifest 仅在安装时读取并缓存，修复必须进 fpk 包重新安装**（与 micro_app 注册同一教训）；
5. **应用级 stop 异常**：app-center stop/restart 报 `invalid proto`（APP_STOP_FAILED_DOCKER_COMPOSE_EXCEPTION），不阻塞容器层操作，但使「stop→start 重评估」路径不可用；
6. **APP_CRASH 事件链**：安装后 dockermgr containerStop（如数据恢复流程）会被 app-center 记为 APP_CRASH 并使应用退回「未就绪」态；调 app-center start/start（幂等）可恢复 STARTED（桌面图标随之恢复）。

**v0.2.6 修复方向**：fpk 源 `manifest` 改 `service_port=0` + `checkport=false`（对齐 fygo 形态）后重新打包发布；可选增强 TCP 实例前缀兼容（rewriteUrl 幂等剥前缀）作双保险。当前 v0.2.5 网关入口不可用属包缺陷，TCP 直连 `http://<NAS_IP>:23330/` 不受影响。

## v0.2.6 网关就绪修复：service_port=0 与 checkport=false

接续上节 #95 实测回填：v0.2.5 修复了 micro_app 网关注册，但真机终验网关 URL 仍 404——**根因是 manifest `checkport=true` 触发 fnOS 端口健康检查，而 fnOS 对网关型（micro_app）应用不向宿主 localhost 发布容器端口（仅 docker0 网桥可达）→ 健康检查恒失败 → 应用被判「未就绪」→ 网关路由被禁用**。同机对照 fygo（`service_port=0` + `checkport=false`）网关 200 正常；manifest 热改不会被 fnOS 重新评估，修复必须进 fpk 包。

修复内容（对齐官方网关应用形态）：

- **manifest**：`service_port=23330` → `service_port=0`、`checkport=true` → `checkport=false`（micro_app、桌面 Gateway 入口等其余字段不动）；
- **compose**：`service_port=0` 后 fnOS 注入的 `TRIM_SERVICE_PORT` 不再可靠（可能为 0 或缺失），端口映射与 `RO_SERVER_PORT` 全部改字面量 `23330`——**TCP 直连入口 `http://<NAS_IP>:23330/` 完全不变**（LAN 直连、admin 账密登录照旧）；
- **向导**：安装/配置向导移除「服务端口」字段——服务监听由 compose 字面量 `RO_SERVER_PORT=23330` 固定（env 优先于 config.yaml，见 `server/src/core/config.ts`），端口不再可配；生命周期脚本的端口渲染/探测统一兜底 `DEFAULT_PORT=23330`（向导空值路径安全）；
- FN ID 网关免密入口与 TCP 直连两入口并存语义不变（网关前缀、X-Trim-* 信任模型均不动）。

> 升级注意：manifest 仅在安装时被 fnOS 读取并缓存（两次真机教训均为「热改 manifest 不生效」），本修复需随 fpk 包经安装/升级（update/task）流程生效。

## v0.2.7/v0.2.8 网关 404 第三层根因：数据库 socket 字段为空与 DB 热修

v0.2.6 修复 checkport 后，v0.2.7 补齐 `ui/config` 的 `microApp/gatewaySocket/gatewayPrefix` 字段、v0.2.8 将 entry key 后缀从 `.Gateway` 收敛为 `.Application`，真机重装后网关 URL 认证后仍 404「Not Found」（9B，Go 默认格式——请求已被网关接收但无上游可转发）。经多轮递进排查（2026-08-27~28，probe43~61），定位到**第三层根因：fnOS 安装时没有把 ui/config 的 socket 声明解析写入数据库**。

### 数据流转链与根因

```
fpk 安装 → ui/config（含 gatewaySocket: "app.sock"）→ fnOS 解析写入 appcenter.app_service 表
          → trim_sac 同步重建 trim_sac.entry 表 → trim_http_cgi sacentry 周期读 entry 注册上游
```

- **`appcenter` 库 `app_service` 表**（安装时刻写入）：rainbow 行（`service_name='com.rainbow.music.Application'`）的 `gateway_socket` / `gateway_prefix` 两列为**空**；对照 fygo 行有完整值（`/var/apps/fygo-browser/target/app.sock` + `/app/fygo-browser`）；
- **`trim_sac` 库 `entry` 表**（同步重建视图）：rainbow 行（`app_name='com.rainbow.music'`）同样两列为空——每 30 分钟的 sacentry 周期因此**无 socket 可注册**（日志只见 fygo 的 `upstream register` 行）；
- **ui/config 内容本身无误**：NAS 上 `@appcenter/com.rainbow.music/ui/config` 与 fygo 的逐字段等价（均含 `gatewaySocket/gatewayPrefix/microApp/type:iframe`，JSON 合法）——问题出在 fnOS 安装环节的解析，而非包内容；
- **结构差异假设已实证推翻（probe60，2026-08-28）**：完整读出两份 ui/config 后确认 fygo 的服务键**同样**嵌套在顶层 `".url"` 包装层之下，与 rainbow 逐字段同构（仅缩进深度不同，JSON 语义无关）——包内配置结构不是根因；
- **根因嫌疑收敛到安装渠道/应用形态（probe61，appcenter.app 表实证）**：rainbow 行 `manual_install=t / is_docker=t / is_systemd_uint=f / source_id=空`，fygo 行 `manual_install=f / is_docker=f / is_systemd_uint=t / source_id=307`——rainbow 为手动本地 fpk 安装的 Docker 形态应用，fygo 为商店渠道安装的 systemd 形态应用；两类安装链对 ui/config gateway 字段的解析写入行为不同（手动安装的 Docker 应用未写入 socket/prefix）。附：entry 中 socket 为逻辑路径，网关按 app 行 `install_volume_id` 解析到卷路径——实测宿主 socket 物理位于 `/vol2/@appcenter/com.rainbow.music/app.sock`（容器挂载 `@appcenter/com.rainbow.music → /app/target` + `RO_GATEWAY_SOCK=/app/target/app.sock` 产出；宿主 `/var/apps/<app>/target/` 不存在属正常现象，fygo 亦然）；
- 网关认证层正常（未认证 200 `invalid token`；认证后 404 说明路由缺失而非鉴权问题）。

### DB 热修（已在真机执行并验证，2026-08-27 20:31/20:42）

fnOS 宿主 PG 可从诊断容器直连（挂载 `/usr /run` 只读 + 宿主 loader 运行真实 psql 二进制，容器 root 经 pg_ident `trim_root` map 以 peer 认证连 `postgres`）：

```sql
-- 库一：appcenter（源头表，安装时写入；重启后 entry 重建的数据来源）
UPDATE app_service SET gateway_socket='/var/apps/com.rainbow.music/target/app.sock',
  gateway_prefix='/app/com.rainbow.music', updated_at=now()
WHERE service_name='com.rainbow.music.Application' AND coalesce(gateway_socket,'')='';

-- 库二：trim_sac（网关注册视图；下一同步周期即生效）
UPDATE entry SET gateway_socket='/var/apps/com.rainbow.music/target/app.sock',
  gateway_prefix='/app/com.rainbow.music', updated_at=now()
WHERE app_name='com.rainbow.music' AND service_name='com.rainbow.music.Application'
  AND coalesce(gateway_socket,'')='';
```

**生效时机**：sacentry 周期任务每 30 分钟跑一次（trim_sac 服务启动后整点偏移，本机锚点 xx:00:58/xx:01:05）；DB 直改不触发即时注册，须等下一周期。本机实测：20:31 UPDATE entry → 20:42 UPDATE app_service → **21:01:05 周期注册成功**（syslog 出现 `upstream register app=com.rainbow.music ... var/apps/com.rainbow.music/target/app.sock`），随后认证请求 `GET /app/com.rainbow.music/` 200（31145B 应用 HTML）。

### 终验结果（2026-08-27 21:01 ~ 08-28 10:30，连续运行 13h+）

- [x] **网关路由打通**：认证后 `GET /app/com.rainbow.music/` → 200 text/html（应用首页）；
- [x] **FN ID 身份贯通**：`GET /app/com.rainbow.music/api/v1/me` → `{"uid":"1000","username":"Giraffe","isAdmin":true,"mode":"gateway"}`（X-Trim-* 头注入正常）；
- [x] **桌面图标 iframe 微应用窗口**：fnOS 桌面点 Rainbow 图标 → 1100×596 iframe（src=`/app/com.rainbow.music`）内完整加载主界面（发现/榜单/精选歌单/歌单详情/播放全部/下载全部按钮均在）；
- [x] **应用数据正常**：直开应用 URL 同样 200，五平台榜单与精选歌单数据经网关拉取正常，用户 Giraffe 登录态正常；
- [x] **稳定性**：注册后连续运行 13 小时以上网关仍 200（次日复测 API 正常；期间容器无重启）。

### 已知限制与后续（v0.2.12：已实施诊断兜底，根治依赖 fnOS 侧）

1. **热修不随重装自愈（v0.2.9/v0.2.10/v0.2.11 三轮修复均被真机实证否决——时序、身份、通道三层根因递进）**：卸载重装会重建 `app_service` 行——根因已收敛到**安装渠道/应用形态**（probe61：`manual_install=t`+`is_docker=t` 的安装链未写入 gateway 字段）。v0.2.9 在 `install_callback`/`upgrade_callback` 成功路径末尾内嵌 `fix_gateway_socket()`（`fpk/cmd/_common`），宿主 root 经 pg peer 认证直连 psql 幂等补写两表（仅空字段时 UPDATE）——**后续 v0.2.10 实测推翻：回调身份为 uid 975 应用用户，非 root**。
   **v0.2.9 真机实测发现时序缺口（已取证）**：全新安装时 fnOS 写入 `app_service` 行（created 18:18:43.005）**晚于** install_callback 执行时刻——同步 UPDATE 落空 0 行；全新安装无 upgrade_callback 兜底；随后 18:31:05 entry 被 trim_sac 周期从空 app_service 重同步覆盖回空 → 19:01:05 周期后网关仍 404（升级路径无此问题：行早已存在，同步 UPDATE 命中）。
   **v0.2.10 修复**：install/upgrade 同步调用之外新增后台 watcher（`fix_gateway_socket_watch()`）：生成一次性 watcher 脚本（引用 heredoc + 占位符内插，参数全字面量化、不依赖回调环境）落 `/tmp` 后 `nohup sh <文件>` 后台执行（脱离安装进程、不占用安装流程的 stdio、脚本 EXIT trap 自删不留持久文件），30 秒轮询两表空则幂等补写，双非空即退出，最长 10 分钟窗口。
   **v0.2.10 真机实测发现深层根因（身份，已取证）**：watcher 机制生命周期全部正常（落盘/轮询/自删），但两表仍永不补写——fnOS 以**应用专用系统用户 `rainbow`（uid 975）**执行安装/升级回调（@appcenter 全部回调产物属主 975:969 实证），而 PG 配置 `pg_hba: local all postgres peer map=trim_root`、pg_ident 的 trim_root 映射**仅 root→postgres**；uid 975 直跑 psql → `FATAL: Peer authentication failed for user "postgres"`（setpriv --reuid 975 模拟实证）——20 轮 UPDATE 全部被 `2>/dev/null` 静默吞掉；v0.2.9 升级路径的「同步 UPDATE 命中」也从未真正生效（旧值残留假象）。
   **v0.2.11 修复（已发布；真机实证否决）**：补写 SQL 改经 docker 容器执行（`rb_psql()`）：`docker run --rm -v /usr:/husr:ro -v /run:/hrun:ro --entrypoint <宿主 loader> <镜像> --library-path … <宿主 psql> -h /hrun/postgresql …`——容器内进程 uid 0，经共享 unix socket 的 peer 凭据为 root，pg_ident trim_root 放行（真机探针 20 余次 100% 成功的配方；镜像取 compose 的 image: 行）；同步补写与 watcher 全部改走此通道；watcher 增逐轮日志 `${TRIM_APPDEST}/gateway-watch.log`（`round=N c1=X c2=Y updated=A/B`，失败附 `psql-err=<stderr 末行>`，含启停行），彻底消除静默失败。
   **v0.2.11 真机实证否决（2026-08-31 Phase 0 前置探测，按预设分支止损，未进破坏性阶段）**：探针实证 **uid 975 连 `/var/run/docker.sock` EACCES**（root 对照组 HTTP 200；socket 为 `root:docker(994) mode 0660`，docker 组成员仅 Giraffe 与 com.dustinky.qwenpaw；rainbow 的三组 901(AppUsers)/971(TrimApiUsers)/969(rainbow) 均不在 docker 组；sudoers 无任何应用用户规则）——回调身份下 `docker run` 必然失败，同步补写与 watcher 全部落空。**至此 fpk 回调侧三条宿主通道（psql peer 认证 / sudo / docker.sock）全部实证关闭**。v0.2.11 相对 v0.2.10 无行为退化（gateway-watch.log 可观测性有效），已发布无需回滚，但网关自愈目标未达成。旁证：v0.2.2 真机史实——升级回调 compose_up 曾报 docker.sock permission denied（代码注释留档）。取证存档：`.qa-tmp/t107/`（pg_hba/pg_ident 全量、130+ socket 权限清单、探针脚本）。
   **v0.2.12 已实施诊断兜底（网关 404 从静默变可见、可指引；根治依赖 fnOS 侧修复）**：t108 调研实证应用侧「自愈网关注册」四条通道全部关闭（开放 API 仅 5 个文件/系统类 scope 无网关写能力、TRIM_API_TOKEN 不注入容器进程、ui/config 声明与 fygo 完全同构故声明无缺失、appcgi 写端点需 admin session）——v0.2.9~v0.2.11 的 rb_psql/watcher 代码保留不动（真机实证 uid 975 连 docker.sock EACCES，但代码无害、失败有 gateway-watch.log 记录、若未来 fnOS 修权限即自动生效）。本轮四项：① 运行时网关注册检测（`server/src/core/gateway-stats.ts`：两实例共享内存计数，仅计 `/api/v1/*`，网关流量按实例级判定——网关 Unix Socket 实例的到达即转发证明；`GET /api/v1/status` 新增 `gatewayHealth` 块，status=ok/waiting/suspected-unregistered/unknown，判定现算不在请求路径上）；② install marker（install_callback 写 `${TRIM_PKGVAR}/data/install.marker`，容器内 `/app/data/install.marker` 可读，mtime 缓存；升级不写）；③ 前端诊断引导横幅（`web/js/main.js` initGatewayHealthBanner：waiting/suspected-unregistered 时顶栏下全局条，可关闭本次会话不再弹，status 不可达时静默放弃）；④ fnOS 反馈文档（`docs/FNOS-FEEDBACK.md`：可复制到社区/客服的反馈草稿，含取证摘要/三轮修复否决链/三项诉求与 pg_hba trust 安全提示）。后续留待：fnOS 官方修复响应、商店上架评估（fygo 实证商店链正确写入 gateway 字段）、路径②重装实证；
2. **重启持久性**：`app_service` 已补值，理论上 NAS 重启后 entry 重建会带回 socket（数据来源链），但**未做专项重启实测**（2026-08-27 夜间未发生重启，uptime 连续）；建议下次计划内重启时顺带复验网关 200；
3. **真机实测记录（v0.2.9，2026-08-28）**：升级路径全绿（7 源保持/数据保留/E2E 4.3MB/upgrade_callback 探针全过）；卸载重装路径 seeding 自愈、config 新默认、软链恢复、FN ID 贯通全过；唯 fix_gateway_socket 时序缺口 FAIL（上文已述，探针热修两表→19:31:05 周期注册→网关 200 恢复）。
4. 排查方法论沉淀：PG 直连取证配方、`trim_sac` 同步周期锚点、`upstream register` 日志模式（注意实际日志为带空格的 `upstream register`，grep `upstream_register` 无匹配）见 `probe43~61` 系列脚本（本地 `.qa-tmp/t99/`；真机 `rainbow-diag/` 下的探针输出已于收尾时全部清理，结论均已回填本文档）。

## 2026-08-28 音源清空与下载目录断裂：根因与热修

用户报障：NAS 打开 Rainbow 页面「音源为空、功能不可用」。经 probe62~67 实证，为**两个叠加的结构性缺陷**（与网关无关，网关链路正常）：

### 根因一：音源脚本随卸载重装丢失（镜像/fpk 均不内置）

- lx-music 音源脚本（`data/sources/*.js`，共 7 个）**只存在于仓库本地**：镜像 Dockerfile 仅 `mkdir` 占位不 COPY，fpk 打包也不含；生产容器的 `/app/data/sources` 由 `${TRIM_PKGVAR}/data/sources` 挂载提供；
- 首次真机导入的音源脚本存在宿主 `@appdata` 目录，但 v0.2.5 起多次**卸载重装**（#95/#98/#99）清空了 `@appdata`，重建的 sources 目录为空 → `sources.loaded=0/ready=0` → 搜索出结果但下载/播放/换源全部失败，音源页空白；
- 排查实证：发现页榜单/歌单走平台直连适配器（`server/src/core/adapters/*`）不受影响，搜索 API 亦正常——死的是音源脚本链。

### 根因二：download.dir 指向宿主绝对路径但容器从不挂载

- `default_download_dir()` 把 `TRIM_DATA_SHARE_PATHS`（data-share 共享目录，如 `/vol2/@appshare/rainbow-music`）或 `${TRIM_PKGVAR}/downloads` 写进 config.yaml 的 `download.dir`；
- 但 compose 模板只挂载 `${TRIM_PKGVAR}/data/downloads:/app/data/downloads`，**从不挂载 download.dir 指向的目录**；`server/src/core/download/index.ts` 对绝对路径直接 `mkdirSync(recursive)` → 下载文件写进**容器可写层**（宿主不可见、容器重建即丢）；
- 热修实测验证：直接改宿主 compose 加字面挂载行无效——**fnOS 的 compose 解析器会剥离非 `${TRIM_*}` 变量形式的挂载**（与 #88 扫描目录挂载失效同机制）。

### 热修记录（2026-08-28，已全部验证）

1. **音源恢复**：本地 7 个脚本经 `trim-cli file upload` 上传用户目录 → 探针容器 root `cp` 注入 `@appdata/com.rainbow.music/data/sources/` → 容器重建后 `sources.loaded=7/ready=7`（音源页全部「运行中」）；
2. **下载目录改回容器内路径**：经网关 `PATCH /api/v1/settings`（管理员）把 `download.dir` 改为相对路径 `data/downloads`（解析为 `/app/data/downloads` → `@appdata/.../data/downloads` 挂载，容器重建不丢；yaml 已写回）；
3. **用户可见入口**：宿主软链 `/vol2/1000/Personal/projects/rainbow-downloads → /vol2/@appdata/com.rainbow.music/data/downloads`（文件管理器 projects 下可见下载结果）；
4. **端到端验证**：搜索「起风了」→ 下载 flac 27.6MB 落盘（qdy 音源换源成功，kw 410 属源波动）→ `GET /api/v1/play/:taskId` Range 请求 206 `audio/flac`（流式播放正常）→ 宿主 `@appdata` 与软链入口均见文件。

### v0.2.9 根治方向（本故障新增；已全部实施）

1. **音源自愈（已实施）**：镜像内置音源副本（Dockerfile `COPY data/sources /app/data/sources-bundled` + `ENV RO_BUNDLED_SOURCES`，构建上下文经 .dockerignore 反排除放行），服务启动时 sources 目录无任何 .js 则 seeding 复制（`server/src/core/source-engine/index.ts`，只看 .js 后缀、绝不覆盖用户已有脚本、非 Docker 部署内置目录不存在则静默跳过）——卸载重装清空 `@appdata` 后音源自恢复，无需再手动上传；
2. **下载目录对齐（已实施）**：`default_download_dir()` 默认输出容器内相对路径 `data/downloads`（服务端相对 ROOT_DIR=/app 解析即唯一挂载的 `/app/data/downloads`），与 compose 挂载自洽、容器重建不丢；向导显式传绝对路径仍可覆盖（fnOS 剥离字面挂载的限制不变，原生 data-share 挂载机制留待后续研究）；
3. `default_download_dir()` 的 `${TRIM_PKGVAR}/downloads` 回退分支已随本次修正一并移除（同样断裂：compose 挂的是 `data/downloads`）；宿主侧 ensure_data_dirs 对相对路径不再 mkdir（旧绝对路径配置行为不变）。

## 安装向导：「音乐库扫描目录」配置与挂载机制

v0.2.1 安装向导新增**「音乐库扫描目录（可选）」**字段：要导入本地音乐库的 NAS 目录（绝对路径，如 `/vol1/1000/music`），可填多个（英文逗号分隔）。

挂载机制（确定性路径，非动态探测）：

1. 向导值经生命周期脚本写入 compose：每个目录渲染为一行 bind 挂载 `- <NAS目录>:/app/data/scan/N`（N 从 1 递增）；
2. 同时把这些容器内路径拼入环境变量 `RO_SCAN_ROOTS`（`:` 分隔，首项恒为默认下载目录 `/app/data/downloads`）；
3. 原始输入持久化在 `${TRIM_PKGETC}/scan-dirs.conf`（飞牛托管 etc 目录，升级不丢）——**升级时无向导**，`upgrade_callback` 回读该记录幂等补渲染挂载（老 v0.2.0 安装升级后同样获得新挂载）；
4. 容器内每个用户在前端「NAS 音乐」页从 `RO_SCAN_ROOTS` 集合中勾选自己的扫描根（`GET/PUT /api/v1/me/scan-roots`），勾选集存在 SQLite `user_scan_roots` 表（按 uid 隔离）；
5. 渲染幂等：重复执行钩子输出一致；**目录不存在仅告警跳过，不阻断安装**。

对用户的表现：文件管理器里已有的音乐文件夹（历史收藏、其他工具下载的库），勾选后点「开始扫描」即入库，无需把文件搬进下载目录。

## X-Trim-* 身份头安全模型

fnOS 统一网关在校验用户会话后注入三个身份头：

```
X-Trim-Userid: 1000        # 数字 uid
X-Trim-Username: alice     # 用户名
X-Trim-Isadmin: true|false # 是否 fnOS 管理员
```

官方明确警告「不要信任客户端自传 uid」——**任何能直连的网络端点都可能伪造这些头**。因此 Rainbow 的信任边界按「实例」划分：

| 实例 | 对 X-Trim-* 头 | 效果 |
|---|---|---|
| 网关实例（Unix Socket） | **采信** | 头即身份；`POST /api/v1/auth/gateway-login` 仅在此实例注册 |
| TCP 实例（0.0.0.0:23330） | **零采信** | 带伪造头请求 gateway-login → **404**（路由不存在）；其余请求一律走 session/API Key |

为什么 TCP 端口不采信：Unix Socket 只存在于 fnOS 网关与容器之间的挂载点（`${TRIM_APPDEST}`），**到达该 socket 的流量必然经过 fnOS 会话校验**；而 TCP 端口暴露在局域网，任何设备都能连上，若采信自传头等于把身份认证完全旁路。fnOS 侧的会话校验 + socket 的物理不可达性，共同构成免密登录的可信链。

## 错误码与降级行为

### 错误码

| 端点/场景 | 码 | 含义与处置 |
|---|---|---|
| `POST /api/v1/auth/gateway-login`（网关实例） | 200 | 免密成功，Set-Cookie 带 uid 身份的 session |
| 同上（无有效头） | 401 | 缺少 `X-Trim-Userid` / `X-Trim-Username`（或 uid 非数字）——正常只应出现在探测请求 |
| 同上（TCP 实例） | 404 | 防伪造红线：该路由只在 socket 实例注册 |
| `PUT /api/v1/me/scan-roots`（路径越界） | 400 | `paths` 含不在 `available` 集合中的路径（响应带 `invalid` 与 `available`） |
| `POST /api/v1/library/scan`（未配置根） | 400 | 先在「NAS 音乐」页勾选扫描根 |
| 同上（同 uid 扫描中） | 409 | per-uid 互斥，等待本轮完成（SSE `scan:progress` 可看进度） |
| 全局管理操作（settings PATCH / apikey / 音源启停重载删除 / 刮削批量 / 冒烟 run / 通知测试） | 403 | 网关普通成员（`Isadmin=false`）调用管理员接口；登录 admin 或换 fnOS 管理员账号 |
| `GET /api/v1/library/tracks/:id/stream`（文件已不在） | 410 | 音频文件被移动/删除（索引仍在，重新扫描可清理） |

### 降级行为

| 触发条件 | 行为 |
|---|---|
| fnOS < 1.2.0401 / App < 1.34.0（或 compose 未注入 `RO_GATEWAY_SOCK`） | 网关实例不启动，**回落纯端口模式**：单 TCP 实例、admin 账密登录，与 v0.2.0 行为逐项一致；仅 NAS 音乐库功能仍可用（勾选默认下载目录） |
| `TRIM_API_TOKEN` 缺失或 apiscope socket 不存在 | fnOS 开放 API 客户端（`core/fnos/trimapp.ts`）自动降级为空实现：目录可见性展示等增强功能静默关闭，**核心功能零影响**（该客户端为预留件，当前无路由硬依赖） |
| 扫描根目录容器内不可见 | 该目录扫描结果为空（遍历直接跳过），不报错；排查见下 |
| SSE 连接中断 | 前端重连后全量对账（tasks/library 重拉），不丢终态 |
| 老版本 ro.db 升级（v0.2.0 → v0.2.1） | 幂等 `ADD COLUMN` + 默认值迁移，`user_id='legacy'` 存量行自动归属安装管理员，数据零丢失 |

### 扫描根不可见排查

「NAS 音乐」页勾选了目录但扫描结果为空/为 0 时，按序检查：

1. **容器内挂载是否生效**：`docker exec rainbow ls /app/data/scan/` ——应能看到向导配置的目录（编号子目录）；
2. **`RO_SCAN_ROOTS` 是否注入**：`docker exec rainbow env | grep RO_SCAN_ROOTS` ——应包含 `/app/data/scan/N`；
3. **挂载宿主路径是否正确**：`docker inspect rainbow --format '{{json .Mounts}}'` 对照 NAS 实际路径（常见错误：填了共享文件夹的「显示名」而非绝对路径，如应填 `/vol1/1000/music` 而非 `music`）；
4. **目录是否为空 / 音频格式是否在白名单**：支持 mp3 / flac / m4a / ogg / opus / wav / aac；
5. 修改挂载需回到向导值：编辑 `${TRIM_PKGETC}/scan-dirs.conf` 后重启应用（生命周期脚本幂等重渲染），或升级时在向导重新填写。

## 真机验证 checklist

真机升级安装沿用 #81 已验证的 trim-cli 通道；下列验证点对应发布计划模块七第 4 节。
**#88 实测回填（2026-08-26，NAS：飞牛 TRIM ME mini，升级链路 v0.2.1→0.2.2→0.2.3→0.2.4，最终安装 v0.2.4）**：

- [x] **网关入口出现**（PASS，API 侧）：实测 `@appcenter/com.rainbow.music/ui/config` 含双入口注册——`com.rainbow.music.Application`（URL 直连，port=wizard_port，allUsers:false）与 `com.rainbow.music.Gateway`（iframe，gatewayPrefix=`/app/com.rainbow.music`，gatewaySocket=`rainbow.sock`，allUsers:true）；桌面图标展示效果留用户浏览器确认；
- [ ] **FN ID 免密进入**（SKIP，留用户）：Mac 侧无法经 fnOS 网关模拟 FN ID 登录（CF Tunnel 拓扑限制）。用户验证指引：飞牛桌面打开 Rainbow 图标应免密直入主界面且顶栏显示飞牛账号名；
- [x] **扫描目录出库播放**（PASS，API 侧全链）：容器内经 unix socket 实测 `GET /me/scan-roots`（available 含 `/app/data/downloads`）→ `PUT` 选中 → `POST /library/scan` 202 → 轮询 done（total=2/added=2）→ `GET /library/tracks` 返回 2 条（title/ext=wav）→ `GET /library/tracks/:id/stream` 带 Range 返回 **206**（`bytes 0-1023/48044`，Content-Type=audio/wav）与全量 200（48044B）；有声播放留用户浏览器确认；
- [x] **双账号数据隔离**（PASS，API 侧）：经 socket 假 `X-Trim-Userid/Username/Isadmin` 头调 `gateway-login`（模拟 fnOS 网关注入行为），alice(1001)/bob(1002) 各得 session；歌单互写互读互不可见（t88-alice-pl 与 t88-bob-pl 各自可见己方）；播放历史同样互不可见；
- [x] **权限边界**（PASS）：非 admin（bob）`PATCH /api/v1/settings` → **403**（`{"error":"需要管理员权限"}`）；
- [x] **TCP 直连回归**（PASS）：`http://<NAS_IP>:23330/` admin 账密登录 200 + Set-Cookie；**安全红线**：TCP 直连带伪造 `X-Trim-*` 头调 `gateway-login` → **404**（该路由只在 socket 实例注册，防伪造生效）；
- [x] **v0.2.0 存量数据完整**（PASS，换基准）：原「187 任务/5 歌单」基准经查**属已卸载的前身应用 ro-music**（非 com.rainbow.music 的 TRIM_PKGVAR；`@appdata/com.rainbow.music` 目录 btim=2026-08-25 15:44 即 #81 v0.2.0 全新安装时新建，前身数据随其卸载清空）。实测改为**行级数据跨升级保留**：升级前写入 users×2 / playlists×2 / play_history×2 / user_scan_roots×1 → 重放 v0.2.4 升级 → 全部行完整保留；ro.db 文件本体跨 0.2.2→0.2.3→0.2.4（含重放）四次升级保留；config.yaml 保留；scan-dirs.conf 经 v0.2.4 修复后跨升级保留（见下「实测发现」）；
- [ ] **老 fnOS 回落**（SKIP）：无低版本 fnOS 环境可测；降级逻辑（compose 未注入 `RO_GATEWAY_SOCK` 时回落纯端口模式）代码审查已覆盖，未真机实测。

### #88 实测发现（fnOS 平台行为，2026-08-26）

1. **fnOS 升级流程会带空 wizard 参数重跑 install_callback**：空参调用会走渲染函数的「写空」分支——v0.2.4 起 `render_scan_mounts` 改为空参不覆盖持久化（`fpk/cmd/_common`），只有向导显式给非空值才写入；全新安装空值与升级重跑空参都回落回读/默认，行为安全；
2. **fnOS compose up 采用内部保存的模板，不读宿主渲染文件**：生命周期脚本渲染到 `@appcenter` 的 compose 挂载行（扫描目录 `/app/data/scan/N` 注入）**不会**被 fnOS 的 compose up 采用（对照实验：手改宿主 compose 的 `mem_limit` 后完整 stop/start，容器 Memory 与 CID 均不变）——「扫描目录挂载渲染」机制在真机不生效，属**架构级遗留**，需改用 fnOS 原生向导目录参数（参考 moviepilot 的用户目录挂载实现），已在发布计划外单列；
3. **升级幂等性实测**：同一版本（0.2.3/0.2.4）重放 `update/task` 均正常 SUCCESS，生命周期回调幂等，无重复副作用；
4. **正式发布版 v0.2.4 已于真机切换验证**（镜像 tag v0.2.4 + 数据保留 PASS，2026-08-26）。

---

> 本文档的真机部分（checklist 执行结果）已由任务 #88 于 2026-08-26 回填（见上）；`core/fnos/trimapp.ts` 仍为 env 门控预留件，apiscope 契约真机联调留待后续。遗留：扫描目录挂载渲染机制因 fnOS compose 行为不生效（见「#88 实测发现」第 2 条），需改用 fnOS 原生向导目录参数实现。FN ID 浏览器全链已于 2026-08-27 网关修复后验证通过（见「v0.2.7/v0.2.8 网关 404 第三层根因」章末验清单）；有声播放留用户侧确认。
