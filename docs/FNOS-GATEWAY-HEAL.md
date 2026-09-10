# Rainbow fnOS 网关字段 heal runbook（root 语境）

> 适用场景：fnOS 上安装/升级 Rainbow（`com.rainbow.music`）后，桌面网关入口或
> `https://<fnOS入口>/app/com.rainbow.music/` 认证后返回 **404「Not Found」（9B，Go 默认格式）**——
> 即「网关收到请求但无上游可转发」的 DB 层未注册形态。
>
> 根因、多轮真机取证与完整版本史见 [FNOS-DEPLOY.md](FNOS-DEPLOY.md)
> 「v0.2.7/v0.2.8 网关 404 第三层根因」章；本文是其中「DB 热修」配方的
> **可执行 runbook**，配套脚本 [`scripts/fnos-gateway-heal.sh`](../scripts/fnos-gateway-heal.sh)。
>
> ⚠️ 本 runbook 的所有 NAS 侧操作必须以 **root 语境**执行（`sudo`）。fpk 生命周期
> 回调内的自动补写已被真机实证否决（回调身份 uid 975，pg peer / sudo / docker.sock
> 三条宿主通道全部关闭，见 FNOS-DEPLOY.md v0.2.9~v0.2.14 段）——**root 语境是唯一
> 被实证成功的补写通道**，不要尝试在回调/应用用户语境重造轮子。

---

## 目录

- [0. 原理速览（为什么这样修）](#0-原理速览为什么这样修)
- [1. 前置条件](#1-前置条件)
- [2. 完整操作序列](#2-完整操作序列)
- [3. 「补写后仍 404」分支排查树](#3-补写后仍-404分支排查树)
- [4. 运维红线（agent/自动化禁止自行执行的动作）](#4-运维红线agent自动化禁止自行执行的动作)
- [4.1 root heal 与 fpk watcher 两通道关系（`self-healed` 假信号）](#41-root-heal-与-fpk-watcher-两通道关系self-healed-假信号)
- [5. 准自动兜底：root 计划任务（cron）变体](#5-准自动兜底root-计划任务cron变体)
- [6. 退出码与结论口径](#6-退出码与结论口径)
- [7. 真机验证记录](#7-真机验证记录)

---

## 0. 原理速览（为什么这样修）

数据流转链（FNOS-DEPLOY.md 已实证）：

```
fpk 安装 → ui/config（含 gatewaySocket/gatewayPrefix）→ fnOS 解析写入 appcenter.app_service
         → trim_sac 周期同步重建 trim_sac.entry → trim_http_cgi sacentry 周期读 entry 注册上游路由
```

- fnOS 对「手动安装的 Docker 形态应用」（`manual_install=t` + `is_docker=t`）**不写入**
  gateway 字段 → 两表 `gateway_socket`/`gateway_prefix` 为空 → sacentry 周期无 socket
  可注册 → 网关 404；
- 修复 = 直接对两库两表做**幂等补写**（只补空字段），SQL 以 FNOS-DEPLOY.md
  「DB 热修（已在真机执行并验证，2026-08-27）」为准；
- SQL 执行通道 = **docker 容器内跑宿主 psql 二进制**（容器 uid 0 → unix socket peer
  凭据为 root → pg_ident `trim_root` 放行），与 `fpk/cmd/_common` 的 `rb_psql()` 同款语法
  （**镜像名后不带 `--` 分隔符**，v0.2.14/t114 三重复现证伪过带 `--` 的写法）；
- **容器命名空间铁律**（ID:148 阻断级修正）：docker run 把宿主 `/usr` `/run` 挂载为
  容器内 `/husr` `/hrun`，`--entrypoint` 与其后所有路径参数在**新容器**命名空间解析；
  而镜像基于 `node:22-bookworm-slim`（不含 postgresql-client），容器侧写 `/usr/...`
  必然找不到文件。真机实证成功的配方（`.qa-tmp/t114/probe-repro.sh` 变体 B，rc=0；
  `probe-heal.sh`）容器侧一律 `/husr/...` 前缀——脚本据此拆分 `HOST_LOADER`/`HOST_PSQLBIN`
  （宿主命名空间，仅供前置存在性校验）与 `LOADER`/`PSQLBIN`（容器命名空间，供
  docker run），并在 preflight 做 `/usr→/husr` 前缀一致性断言；
- **关键时延事实**：DB 直改不触发即时注册。sacentry 周期任务约每 30 分钟读 entry
  重建上游路由（本机锚点约 `HH:00:58` / `HH:01:05`）；网关进程 `trim_http_cgi` 持内存
  路由表，只有周期任务或进程重启才刷新。补写成功 ≠ 立即可访问，**必须等周期**。

写入目标（两库两表，字段与 WHERE 逐字来自已验证 SQL）：

| 库.表 | WHERE | SET |
|---|---|---|
| `appcenter.app_service`（源头表） | `service_name='com.rainbow.music.Application' AND coalesce(gateway_socket,'')=''` | `gateway_socket='/var/apps/com.rainbow.music/target/app.sock'`、`gateway_prefix='/app/com.rainbow.music'`、`updated_at=now()` |
| `trim_sac.entry`（网关注册视图） | `app_name='com.rainbow.music' AND service_name='com.rainbow.music.Application' AND coalesce(gateway_socket,'')=''` | 同上 |

> socket 写的是**逻辑路径**（`/var/apps/<app>/target/app.sock`）；网关按 `appcenter.app`
> 行的 `install_volume_id` 解析到卷路径——宿主物理 socket 实际位于
> `/vol<N>/@appcenter/com.rainbow.music/app.sock`，宿主 `/var/apps/<app>/target/`
> 不存在属正常现象（fygo 亦然，probe61 实证）。

## 1. 前置条件

| # | 条件 | 确认方法 |
|---|---|---|
| 1 | **NAS 可达**：LAN 直连（`ping <NAS_LAN_IP>`）或既有 ssh 通道（如 `ssh nas`，经 fnos-gateway WS 桥接）确认在线 | 全站 530/隧道断联时**先恢复可达性再谈 heal**（530 属第 4 节红线事件，恢复需用户物理介入，不是本 runbook 能修的） |
| 2 | **root 语境**：能在 NAS 宿主 `sudo -i` 或逐条 `sudo` | `sudo id -u` 输出 `0` |
| 3 | **脚本就位（权威副本 root-only）**：脚本随 **git 仓库**分发（`scripts/fnos-gateway-heal.sh`），**不在 fpk 包/镜像内**，需手工拷贝到 NAS。权威副本固定放 `/usr/local/sbin/fnos-gateway-heal.sh`，属主 root、`chmod 700`；`/tmp` 仅作拷贝中转，落位后立即删除中转副本 | `sudo ls -l /usr/local/sbin/fnos-gateway-heal.sh`（`-rwx------ root`）且 `bash <路径> --help` 有输出 |
| 4 | **应用已安装**：`@appcenter/com.rainbow.music` 目录与 compose 落盘文件存在（脚本会自动探测 `/vol*/@appcenter/<app>/docker/docker-compose.yaml` 提取 image 行） | `ls -d /vol*/@appcenter/com.rainbow.music` |
| 5 | docker daemon 正常、宿主 `/usr/lib/x86_64-linux-gnu/ld-linux-x86-64.so.2` 与 `/usr/lib/postgresql/15/bin/psql` 在位（容器侧按 `/usr→/husr` 映射使用，脚本自动断言两组前缀一致性）；compose 引用的镜像**本地存在**（脚本拒绝隐式出网 pull） | 脚本前置校验自动检查，缺失时给中文指引并以退出码 4 终止 |

> **为什么禁止把 `/tmp` 当权威副本**：脚本以 root 执行，而 `/tmp` 是 world-writable
> （含 sticky bit）——在「拷贝到 /tmp」与「sudo bash /tmp/…」之间，任何本地用户都
> 能替换该文件，等价 root 代码执行。故：权威副本只放 root-only 路径（`/usr/local/sbin`，
> 700），`/tmp` 中转用后即删，cron 目标**禁止**指向任何 world-writable 路径（第 5 节）。
>
> 脚本前置校验覆盖上表 2/4/5 全项：任一不满足 → 清晰中文指引 + 非零退出，**绝不静默失败**。

## 2. 完整操作序列

以下命令均在 NAS 宿主执行；ssh 场景先 `ssh nas`（或你的等价通道）进入宿主。
所有示例不含任何凭据；需要密码处一律以 `<密码>` 占位。首次拷入（经 `/tmp`
中转，落位后删除中转副本）：

```bash
sudo install -m 700 -o root -g root /tmp/fnos-gateway-heal.sh /usr/local/sbin/fnos-gateway-heal.sh
rm -f /tmp/fnos-gateway-heal.sh    # /tmp 中转副本用后即删
```

### Step 1 — dry-run（只读回读，零写入）

```bash
sudo bash /usr/local/sbin/fnos-gateway-heal.sh --dry-run
```

核对输出：

- `appcenter.app_service` 与 `trim_sac.entry` 的 rainbow 行是否存在（**0 行 = 行键形态
  错配或应用未安装**，先走第 3 节分支⑤，不要继续实跑）；
- `gateway_socket`/`gateway_prefix` 现值（空 = 待补写；已是期望值 = 无需 heal，404 另找原因）；
- `appcenter.app` 行上下文（`install_volume_id`、`manual_install`/`is_docker` 安装形态）；
- 附加列（如 `install_volume_id`）按列存在性动态适配——某表没有该列时脚本注明跳过，属正常。

### Step 2 — heal（幂等补写 + 落库确认）

```bash
sudo bash /usr/local/sbin/fnos-gateway-heal.sh
echo "exit=$?"
```

预期成功输出（退出码 **10**=本次发生写入，**0**=已是正确状态无写入，见第 6 节）：

- `appcenter.app_service affected rows = 0|1|?（观测值）`、`trim_sac.entry affected rows = 0|1|?（观测值）`
  （0 且结论为「已是正确状态」= 幂等 no-op → exit 0；≥1 = 本次补写 → exit 10；
  `?` = command tag 未解析到，**降级为观测值只告警不终止**，成败判定权在 re-SELECT——
  首次真机实跑请留存一次 UPDATE 原始 stdout 以关闭 command tag 形态悬念）；
- `落库确认：app_service 期望值命中 ≥1 行；entry 期望值命中 ≥1 行`（UPDATE 后立即
  re-SELECT 回读，不靠 UPDATE 返回值单方面宣布成功）；
- 结尾固定提示：等 sacentry 周期 + 红线（见第 4 节）。

非 0 退出 → 按第 6 节口径处置，**stderr 保留 postgres/docker 完整错误链**，直接引用排查。

### Step 3 — 等周期（≤30 分钟）

DB 直改不触发即时注册。等待下一个 sacentry 周期（本机锚点约 `HH:00:58` / `HH:01:05`），
可在 NAS 上观察注册日志：

```bash
sudo zgrep -h 'upstream register' /var/log/syslog* | grep com.rainbow.music | tail -5
```

> 用 `zgrep`（而非 grep）：轮转档 `syslog.*.gz` 为压缩格式，grep 直接扫会漏掉历史注册行。

> 注意日志模式是**带空格的 `upstream register`**（grep `upstream_register` 无匹配，历史教训）。
> 出现 `upstream register app=com.rainbow.music ... /var/apps/com.rainbow.music/target/app.sock`
> 即注册成功。

### Step 4 — LAN 直连复测（绕开 Cloudflare）

在 LAN 内浏览器打开 fnOS 管理台（`http(s)://<NAS_LAN_IP>:<fnOS管理端口>`，登录后进入桌面），
点击 Rainbow 图标；或命令行粗测网关前缀（经 LAN 直连 fnOS 网关入口，不带会话）：

```bash
curl -sk -o /dev/null -w '%{http_code} %{size_download}\n' \
  'https://<NAS_LAN_IP>:<fnOS管理端口>/app/com.rainbow.music/'
```

判读口径（与真机取证一致）：

| 响应 | 含义 |
|---|---|
| 404 且 body ≈ 9B（`Not Found`） | 路由仍未注册 → 第 3 节排查树 |
| 302 / 200 `invalid token` / 登录跳转 | **路由已注册**（未带会话属正常），LAN 侧修复达成 |
| 桌面图标 iframe 内完整加载主界面 | 终态 OK |

### Step 5 — 公网复测

LAN 侧确认注册后，再走公网入口（FN ID 远程访问 / Cloudflare 隧道域名）复测同一前缀。
公网仍异常而 LAN 正常 → 优先怀疑 **CF 边缘缓存/隧道层**（第 3 节分支⑦），不是 DB 层。

### Step 6 — 应用侧交叉确认（可选）

```bash
curl -s 'http://<NAS_LAN_IP>:23330/api/v1/status' | grep -o '"gatewayHealth":{[^}]*}'
```

`status=ok` 需累计到带会话的网关请求；周期注册后从桌面图标进入一次即会转 ok
（`suspected-unregistered` 在升级重建后可能是无流量假阳性，判读见 FNOS-DEPLOY.md R1 观察点）。

## 3. 「补写后仍 404」分支排查树

先固定判据：**404 且 body 9B（Go 默认 `Not Found`）= 网关层无路由**；带会话 200/302 =
路由已在。按命中概率从高到低排查，每个分支给出区分方法：

### ① 没等到 sacentry 周期（最可能）

- **区分**：heal 输出「补写成功/已正确」但距上次周期锚点（`HH:00:58`/`HH:01:05`）不足
  30 分钟；syslog 尚无新的 `upstream register app=com.rainbow.music` 行。
- **处置**：等到下一周期再复测（Step 3 的 grep 出现注册行后）。**不要**因「等不及」
  去重启网关进程——见第 4 节红线。

### ② 网关进程 / 源站不可达

- **区分**：不止 rainbow，**其他微应用（如 fygo）前缀同时 404/异常**；或 `trim_http_cgi`
  进程状态异常；LAN 直连 fnOS 管理台本身打不开。rainbow 单应用 404 而 fygo 正常则
  基本排除本分支。
- **处置**：属 fnOS 平台层故障，超出本 runbook；重启网关进程是红线动作（第 4 节），
  须人工评估。

### ③ entry 被 trim_sac 周期同步回写覆盖

- **区分**：heal 后一段时间（尤其跨过一个同步周期）复查，`trim_sac.entry` 又变空，而
  `appcenter.app_service` 有值 → 正常（entry 会从源头表重建，下一周期自愈）；若
  **app_service 也空** → 源头被重置，常见于期间发生了重装/升级（fnOS 手动升级 =
  完整重装链，`app_service` 行删除重建、entry 清空重建，t111 实证）。
- **处置**：重跑 heal（幂等，安全）。时序上注意：全新安装时 fnOS 写入 `app_service`
  行可能**晚于**安装回调（v0.2.9 实证时序缺口）——安装刚结束就 heal 可能 UPDATE 0 行
  且行不存在，稍后行出现再跑一次即可。

### ④ install_volume_id / socket 路径解析失败

- **区分**：两表值已正确、syslog 有注册行，但网关仍异常；`appcenter.app` 行的
  `install_volume_id` 为空或指向错误卷；宿主物理 socket
  `/vol<N>/@appcenter/com.rainbow.music/app.sock` 不存在（`<N>` 由 install_volume_id 解析）。
- **处置**：核对 app 行与物理 socket；宿主 `/var/apps/<app>/target/` 不存在是**正常现象**
  （逻辑路径由网关解析），不要据此误判。

### ⑤ entry key 形态或写错行

- **区分**：`--dry-run` 两表回读 **0 行**；或 heal 以退出码 2 结束（行存在但值非空且
  非期望）。历史上 v0.2.8 曾把 entry key 后缀从 `.Gateway` 收敛为 `.Application`——
  老现场可能存在旧 key 形态的行。
- **处置**：放宽 WHERE 人工核对（root 语境只读查询）：

  ```sql
  -- appcenter 库
  SELECT id, service_name, gateway_socket, gateway_prefix
    FROM app_service WHERE service_name LIKE 'com.rainbow.music%';
  -- trim_sac 库
  SELECT id, app_name, service_name, gateway_socket, gateway_prefix
    FROM entry WHERE app_name LIKE '%rainbow%';
  ```

  确认实际 key 形态后，若与脚本常量不一致：属包版本/现场形态问题，**先对照
  FNOS-DEPLOY.md 判定该现场装的哪个版本**，不要手改脚本常量硬凑（改错行会把路由
  注册到不存在的 service 上）。

### ⑥ app.sock 未监听

- **区分**：路由已注册（非 9B 404，可能 502/超时/空响应）但应用不应答；容器内
  gateway 实例未启动。检查：

  ```bash
  docker exec rainbow env | grep RO_GATEWAY_SOCK     # 应输出 /app/target/app.sock
  docker exec rainbow ls -l /app/target/              # app.sock 应存在且新鲜
  ls -l /vol*/@appcenter/com.rainbow.music/app.sock   # 宿主侧实体；属主应为应用 uid/gid（chown 生效）
  ```

  `RO_GATEWAY_SOCK` 缺失 = compose 未注入（老版本/降级形态，网关实例根本不启动，
  回落纯端口模式）；socket 属主异常 = chown 失败（v0.2.5 机制，失败仅 warn 不阻塞）。
- **处置**：属容器/compose 层问题，对照 FNOS-DEPLOY.md 双模式章；不要在 heal 层面反复补写。

### ⑦ Cloudflare 边缘缓存

- **区分**：**LAN 直连正常（302/200）而公网域名仍 404**；或公网 404 响应的
  `cf-cache-status` 头为 `HIT`；换 cache-busting 查询串（`?t=<随机数>`）后公网即正常。
- **处置**：等边缘 TTL 过期或按 CF 侧流程清缓存；DB 层无需再动。注意公网 530 是
  **隧道断联**而非缓存（第 4 节红线事件），两者处置完全不同。

## 4. 运维红线（agent/自动化禁止自行执行的动作）

以下动作**只能由用户人工评估并亲自确认执行**，任何 agent、脚本、cron、CI 一律禁止
自动触发（本仓库脚本已按此实现：`fnos-gateway-heal.sh` 只写两表空字段，绝不执行下列任何动作）：

| 禁止动作 | 原因 / 教训 |
|---|---|
| **重启网关进程 `trim_http_cgi`** | 理论上可让路由即时刷新，但**曾导致全站 Cloudflare 隧道断开（530 断联）**，恢复需用户物理介入（NAS 现场操作），远程不可恢复。等 ≤30 分钟周期是零风险替代 |
| **重启 cloudflared / 隧道类应用** | 同上爆炸半径：全站公网入口断联；且隧道重建依赖边缘侧收敛，时间不可控 |
| **reboot NAS** | 打断全部在途服务（下载任务、SSE、数据库写入）；且 `app_service` 补值后的重启持久性**未做专项实测**（FNOS-DEPLOY.md 已知限制第 2 条），重启本身不是验证手段 |
| **重启 Rainbow 应用容器 / `docker compose down && up`** | 打断在途下载任务与 SSE 长连接；对「两表 gateway 字段为空」分支**通常修不了**（容器重启不改变 DB 行，既有实证周期内网关 404 依旧）。唯一可能相关的场景是分支⑥（app.sock 未监听），也须人工确认后执行 |
| **卸载重装应用（适用边界见注）** | fnOS 卸载会**清空应用数据目录**（`@appdata`：下载/音源/SQLite，真机实测 187 任务随卸载消失）；重装必先备份。且对本 runbook 场景（两表 gateway 字段为空）重装**不根治**：重建 `app_service` 行会重新引入空字段 |
| **任何存储写操作**（动 `@appshare`/`@appdata`/卷管理/软链修复） | 数据面无故障时碰存储 = 无收益纯风险；data-share 软链诊断契约本就是「只读、绝不写」（`check_data_share_link()`） |

> **「卸载重装」禁令的适用边界**（与 FNOS-DEPLOY.md 双向交叉引用）：本表仅针对
> 「两表 gateway 字段为空」的 heal 场景——此时重装无收益、有数据清空风险，禁止。
> 但若问题在 **manifest 层**（micro_app / service_port / checkport 等），FNOS-DEPLOY.md
> 已实证「manifest 仅在安装时读取并缓存，热改无效，修复必须进 fpk 包重新安装/升级
> （update/task）」（见其「#95 实测回填」与 v0.2.6 章）——那是另一种场景，不适用
> 本禁令；两个口径勿互相误引。

> **本表非穷举**：凡未列出的**任何写操作 / 进程动作**（restart、stop、kill、compose
> 重建、卷操作……）一律先人工确认；agent/自动化的默认动作集只有「只读观测 +
> 本脚本的幂等补空字段」。

**530 事件教训存档**：网关进程重启与隧道应用重启的爆炸半径是「全站公网入口」，不是
「单应用路由」——为省 30 分钟等待而冒全站断联风险，收益/风险完全不成比例。凡遇
「等周期 vs 重启」的取舍，**一律等周期**。该红线已同步回填到现役操作档案
（FNOS-DEPLOY.md「DB 热修」节与 HANDOFF.md），避免只存在于本文档。

## 4.1 root heal 与 fpk watcher 两通道关系（`self-healed` 假信号）

同一套幂等 SQL 存在**两条执行通道**，判定口径必须分清：

| | root heal 通道（本 runbook） | fpk 生命周期 watcher 通道 |
|---|---|---|
| 载体 | `scripts/fnos-gateway-heal.sh`（人工/cron，root 语境） | `fpk/cmd/_common` 的 `fix_gateway_socket_watch()`：安装/升级回调渲染一次性 watcher，30s×20 轮，日志 `${TRIM_APPDEST}/gateway-watch.log` |
| 执行身份 | root（docker.sock 可写 + pg_ident `trim_root` peer 放行） | 应用专用用户 uid 975（回调身份） |
| 真机实效 | **唯一被实证成功的补写通道** | **恒失败**：uid 975 连 `/var/run/docker.sock` EACCES，20/20 轮全败（t114/t117 实证），只留下逐轮 `psql-err=` 日志 |

**`self-healed` 假信号（必读）**：watcher 的退出判据是「两表 `gateway_socket`
均非空」，命中即写 `round=N c1=… c2=… self-healed`。若 root heal（或任何人工
热修）**先**把值写过，下一次安装/升级触发的 watcher 第 1 轮就会打
`self-healed`——这**不代表**应用侧通道自愈，只是它读到了 root 通道写入的
结果。判读口径：

- 看到 `self-healed` 时，先核对该轮之前的历史轮次与时间线：若安装/升级前
  两表已有值（root heal 写过的现场必然如此），则该信号无信息量；
- 应用侧通道是否真的工作，只看 `updated=A/B` 与 `psql-err=` 行（现网恒为
  EACCES 全败）；
- 两通道 SQL 幂等同源，即使将来 fnOS 修复权限后双通道并发，也只是 no-op，
  无冲突风险。

## 5. 准自动兜底：root 计划任务（cron）变体

> 定位：**准自动兜底**——把「人工发现 404 → 人工跑 heal」变成「root 周期任务自动
> 补空字段」。它**不改变**第 4 节任何红线：不重启任何进程、不碰存储、不触网。

示例（NAS 宿主 root crontab，**默认推荐 `*/30`**，与 sacentry 周期同频已足够；
脚本必须已在 root-only 权威路径，见第 1 节）：

```cron
# Rainbow 网关字段准自动兜底：幂等补写两表空字段（只 SELECT/UPDATE rainbow 行，
# 绝不重启进程/碰存储/隐式出网）。cron 环境 PATH 极简，显式声明后再调脚本。
# 取证窗口内必须先删除本行（见下「取证期禁用」）。日志 append，配合 logrotate。
PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
*/30 * * * * /usr/bin/bash /usr/local/sbin/fnos-gateway-heal.sh >> /var/log/rainbow-gateway-heal.log 2>&1
```

路径约束（硬性）：cron 目标脚本与日志**禁止**位于 world-writable 路径（`/tmp`
等）——root 执行的脚本落在可被任意本地用户替换的路径上，等价 root 代码执行；
权威副本只放 `/usr/local/sbin`（700，root:root）。

**爆炸半径评估（为什么敢自动跑）**：

- 写操作**仅**两条幂等 UPDATE，WHERE 三重限定（`app_name`/`service_name` 精确匹配 +
  `coalesce(gateway_socket,'')=''` 只补空），最坏情况 = 0 行；不 DELETE、不 INSERT、
  不覆盖任何非空值、不触碰其他应用行；
- 其余全部为只读 SELECT（含 information_schema 列探测；列名识别不到时直接跳过，
  不做全表兜底，避免跨应用元数据进日志）；
- 通道失败（docker/psql/PG 异常）→ 退出码 3/4 + stderr 全文进日志，**不静默**，
  不会带病重试写库。

**风险与代价（必须知情后再启用；容器数为实测口径）**：

1. **短命容器开销**：每轮拉起实测 **heal 模式 18 个 / dry-run 模式 6 个**短命
   `docker run` 容器（列探测×3 + 回读 SELECT×3，heal 另有基线/事后两轮全量回读 +
   UPDATE×2 + 落库计数×4）。旧文档「4~8 个」系严重低估：`*/10` 频率即约
   **108 个/小时**，故默认推荐 `*/30`（约 36 个/小时，与 sacentry 周期同频已足够）；
   日志会持续增长，务必配 logrotate；
2. **cron PATH 极简 → 永久失败循环**：cron 环境的 PATH 通常只有
   `/usr/bin:/bin`，若 docker/bash 不在其中，每轮都会 exit 4 并**永久循环失败**
   （不会自愈）——crontab 内必须显式声明 `PATH=`（见上示例），启用后第一轮
   人工核对日志确认非 exit 4；
3. **镜像引用悬空 → 出网拉取/容器抖动风险**：compose 的 image 引用可能是
   `tag@digest` pin 形态，升级后旧引用在本地无对应 RepoDigest 时，docker run 会
   **隐式出网 pull GHCR**（拉取失败则每轮 exit 3 循环，成功也伴随容器创建/销毁
   抖动）。脚本已加 `docker image inspect` 前置校验直接拒绝隐式出网（exit 4），
   启用 cron 前先用 `--dry-run` 人工跑通一轮确认镜像引用在位；
4. **fnOS 升级后硬编码路径永久失败**：脚本硬编码 PG15/x86_64 宿主路径
   （`HOST_PSQLBIN`/`HOST_LOADER`），fnOS 升级 PG16 或迁移 arm 后每轮都会
   exit 4 永久失败循环（不会带病写入，但兜底能力归零）——fnOS 大版本升级后
   须人工核对并按脚本内指引更新路径常量；
5. 与安装/升级窗口的竞态：fnOS 重装链会重建两表行，cron 可能在「行尚未写入」的
   间隙跑到 UPDATE 0 行——幂等语义下无害，下一轮自动补上（这正是兜底价值）；
6. 它治标不治本：根因是 fnOS 安装链不写 gateway 字段（FNOS-FEEDBACK.md 已投递诉求），
   fnOS 侧修复后应**移除**该 cron（下线清单见本节末）；
7. 升级 Rainbow 版本不更新此脚本（它随 **git 仓库**分发，不在 fpk 包/镜像内、
   不在 fpk 生命周期内）——版本升级后如 SQL/表形态变化，需人工同步 NAS 上的
   权威副本。

**取证期禁用（硬性条款）**：对 fnOS 官方取证 / 复现「字段为何为空」的窗口内，
**必须先删除本 cron 行**。UPDATE 会刷新 `updated_at=now()`，反复自动补写会把
「字段自安装以来一直为空」的取证判据冲掉（提交给 fnOS 官方的证据链依赖原始
`updated_at`/空值形态）；取证结束、结论归档后再恢复。

**启用/移除/完整下线清单**：

```bash
sudo crontab -e        # 添加/删除上面那行；启用前先用 --dry-run 人工跑通一轮
sudo crontab -l | grep rainbow-gateway-heal   # 确认在位/已移除
```

完整下线（fnOS 侧修复后，或决定放弃兜底时）逐项执行并逐项确认：

1. 删 crontab 行：`sudo crontab -e` 删除后 `sudo crontab -l | grep -c rainbow-gateway-heal` 应为 0；
2. 删权威副本：`sudo rm /usr/local/sbin/fnos-gateway-heal.sh`；
3. 清理中转残留（如历史上曾拷过）：`ls /tmp/fnos-gateway-heal.sh` 应不存在；
4. 日志处置：`/var/log/rainbow-gateway-heal.log*` 留存归档或删除（自行决定，脚本不自动动日志）。

## 6. 退出码与结论口径

| 退出码 | 含义 | 处置 |
|---|---|---|
| 0 | 两表已是正确状态（幂等 no-op，**本次未发生任何写入**） | 走 Step 3 等周期 |
| 10 | **本次发生写入**且 re-SELECT 确认落库（cron 场景可只筛 10 = 写库事件） | 走 Step 3 等周期；留存本轮输出作取证 |
| 1 | 用法错误（未知参数） | 看 `--help` |
| 2 | 补写结果异常：行键未命中（0 行存在）、或字段非空但非期望值（部分补写/旧值残留/被覆盖）——成因分支按行存在性互斥打印 | 第 3 节分支③⑤；引用脚本打印的回读全文人工核对 |
| 3 | 执行通道失败（docker run / psql / SQL 报错 / 回读非数字），stderr 含**完整错误链**（不压缩、不截尾——tail -1 陷阱曾致 v0.2.13/v0.2.14 两轮误诊）。**状态披露**：若失败发生在 UPDATE 阶段，可能处于「库一已写、库二未写」的半补写中间态——重跑本脚本幂等安全（只补空字段） | 按 stderr 逐行排查：`permission denied ... docker.sock` = 非 root 语境；`Peer authentication failed` = pg_ident 映射异常；`column ... does not exist` = 表形态变化，对照 FNOS-DEPLOY.md；排查后直接重跑（幂等） |
| 4 | 前置校验失败（非 root / docker 不可用 / compose 或镜像引用缺失、多命中未裁决、镜像本地不存在 / 宿主或容器侧 loader、psql 路径异常含前缀一致性断言失败） | 脚本已给中文指引，按指引补齐环境 |
| 5 | 未预期错误（ERR trap 兜底，报出触发行号；不属上面任何已定义分支） | 连同行号与上文输出提 issue/人工排查 |

> 另：UPDATE 的 command tag 解析（`UPDATE <n>`）已降级为**观测值**：解析不到时
> 记 `?` + 告警而不终止，成败判定权归其后的权威 re-SELECT（期望值计数）；`?` 参与
> 成功子码选择时保守归入 10（宁可多报写事件）。

## 7. 真机验证记录

### 2026-09-10 首验（ID:146）

| 项目 | 值 |
|---|---|
| 环境 | fnOS（Debian 12 bookworm / kernel 6.18.18.c1032-trim）x86_64 |
| PG 版本 | PostgreSQL 15（`/usr/lib/postgresql/15/bin/psql`） |
| Rainbow 版本 | v0.2.16（`tag@sha256:6b5021...bcb98` pin） |
| 脚本 sha256 | `0107e35cf25d5b2149b699b1f956b364be4b80df955b83440852af5f09148b47` |
| 验证时间 | 2026-09-10 15:17~15:25 CST |

**验证结果摘要（8 项）**：

1. **preflight 8 项全通过** ✓ — root/docker/compose/image/loader/psql/socket 全部就位
2. **7b 路径前缀一致性断言** ✓ — `HOST_LOADER→LOADER`、`HOST_PSQLBIN→PSQLBIN`、`LIBPATH` 每段 `/husr/` 前缀均通过
3. **6b `docker image inspect`（tag@digest pin）** ✓ — 本地在位，不误拒，未触发出网 pull
4. **compose 探测** ✓ — 单卷命中 `/vol2/@appcenter/com.rainbow.music/docker/docker-compose.yaml`，无多卷告警
5. **`/husr` 通道** ✓ — 宿主 ld.so + psql 经 docker run 成功拉起，SELECT 返回正确数据（本次修复核心验证通过）
6. **`information_schema` 列探测** ⚠️ — 发现两处 bug：(a) `table_columns()` 在命令替换中未将 `RB_OUT` 输出到 stdout，导致调用方 `have` 始终为空；(b) `has_line()` 使用字面 `"\n"` 而非实际换行符做分隔匹配。两者叠加使列探测 100% 走降级路径（最小列集 `id`）。**不影响 heal 核心逻辑**（UPDATE/count(*) 不依赖列探测），但回读信息不完整。`install_volume_id` 仅存在于 `appcenter.app` 表（app_service/entry 均无此列）
7. **psql `-Atc` UPDATE command tag** ✓ — 原始 stdout 逐字为 `UPDATE 0`；`parse_affected` 正确解析，`?` 降级分支在真实环境不触发
8. **幂等 no-op 不产生 `updated_at` 抖动** ✓ — 实跑前后两表 `updated_at` 完全一致（appcenter `12:55:58.910188+08`、trim_sac `15:13:18.853593`）

**实测容器数**（与第 5 节声称对比）：

| 模式 | 文档声称 | 实测 | 差异原因 |
|---|---|---|---|
| dry-run | 6 | **5** | `select_app_context` 因 bug 6a 跳过 SELECT（少 1 容器） |
| heal | 18 | **16** | 同上 × 2 次 readback_all（少 2 容器） |

> 修复 bug 6a/6b 后预期恢复为 6/18。（ID:154 复验已确认 dry-run 恢复执行
> `select_app_context` 的 SELECT，容器数回升；详见下方「2026-09-10 复验（ID:154）」）

**退出码**：dry-run = 0，heal = 0（幂等 no-op）。

**待修复项（不阻塞本轮验证结论）→ 均已于 ID:154 修复 ✓，见下方复验记录**：
- ✓ `table_columns()` 需在 `rb_psql` 调用后追加 `printf '%s' "$RB_OUT"`（实际用 `printf '%s\n'`）
- ✓ `has_line()` 的 `"\n"` 应改为 `"$NL"`（使用脚本已定义的实际换行变量）

---

### 2026-09-10 复验（ID:154）：两处缺陷修复 + dry-run 复验

| 项目 | 值 |
|---|---|
| 环境 | 同首验（fnOS Debian 12 / PG 15 / Rainbow v0.2.16 pin） |
| 首验版 sha256 | `0107e35c...148b47`（修复前） |
| 权威副本 sha256 | `69ad57dab37666bb7bcaa3dd5377c20795295905a7d9001cb355b5759b6ecbe6` |
| 部署 | `/usr/local/sbin/fnos-gateway-heal.sh`，root:root 700，37581B，与仓库版逐字节一致（`/tmp` 中转用后即删） |
| 复验时间 | 2026-09-10 16:45 CST |
| 退出码 | dry-run = 0 |

**修复内容（3 处，均最小 diff、无 bash4 特性、兼容 bash 3.2）**：

1. **缺陷 1 `has_line()`**（首验 bug 6b）——双引号内 `"\n"` 是字面「反斜杠+n」两字符（`case` 不做转义解释，od 实测 `\ n`），与多行文本内真实换行 `0xa` 永不对齐 → 除「单行整体相等」外按行匹配全部失效。改用脚本已定义的真实换行变量 `$NL` 包裹，恢复整行精确匹配。未回退 `grep -q`/`head -1` 管道（继续规避 `pipefail` × SIGPIPE 陷阱）。
2. **缺陷 2 `table_columns()`**（首验 bug 6a）——`rb_psql` 把结果写入全局 `RB_OUT` 而非 stdout，旧版未回显 → 调用方 `have="$(table_columns ...)"` 命令替换恒捕获空串 → 列探测 100% 降级。追加 `printf '%s\n' "$RB_OUT"` 并透传 `rb_psql` 返回码（失败 rc≠0 / 成功但零列 → `have` 仍空 → 降级，语义不变）。
3. **去重 `pick_columns()`**（本轮 dry-run 复验新暴露）——缺陷 1/2 修复后，`select_app_context` 同时传 `$where_col`(=app_name) 与字面 `app_name` 的重复项显形为 SELECT「app_name, app_name」（修复前 `pick_columns` 恒兜底 `id` 掩盖了它）。复用已修复的 `has_line` 按整行判重跳过。属修复直接暴露的回读清洁度瑕疵，非新缺陷、不影响 heal 正确性。

**复验结果**：

- **列探测不再降级** ✓ —— `information_schema` 动态探测生效：`install_volume_id/volume_id` 在 app_service/entry 中被正确识别为「不存在，已跳过」，在 app 表中被正确选入。
- **`install_volume_id` 归属明确（关闭首验待验证项）** ✓ —— 实测归属 `appcenter.app` 表，值 = `2`（app_service/entry 两表均无此列）。
- **回读列完整、无重复列** ✓ —— app_service 回读 7 列、entry 回读 8 列、app 上下文回读 8 列（去重后 `app_name` 仅出现一次：`id, app_name, name, install_volume_id, manual_install, is_docker, is_systemd_uint, source_id`）；两表 gateway_socket/gateway_prefix 均已填充非空。
- **本轮未实跑 heal** —— 两表 gateway 字段均非空（幂等 no-op 前提成立），仅跑 `--dry-run`（纯 SELECT，无任何 DB 写入），符合红线。

**同源核查 `fpk/cmd/_common`**：无同源缺陷，未改动。依据：(1) `_common` 无 `has_line`/`first_line` 按行匹配辅助函数，其 `\n` 均出现在 printf/tr 格式串（会正确解释），无 `case` 字符串比较陷阱；(2) `_common` 的 `rb_psql` 让 docker run stdout 直接透传，调用方 `out=$(rb_psql ...)` 命令替换正常取到输出，无「写全局变量却不回显 stdout」的缺陷。

**静态验证**：`bash -n` ✓；shellcheck 0.11.0（`-s bash -S style`）rc=0 零告警 ✓；bash4 特性 grep 自证（`declare -A`/`mapfile`/`readarray`/`|&`/`${v^^}`）全部 [none] ✓；本机 bash 3.2.57 单测 27 PASS 0 FAIL ✓；四分支复测（`--help` rc=0 / 未知参数 rc=1 / 非 root `--dry-run` rc=4 / 非 root 默认 rc=4，均给中文指引）✓。

---

> 交叉引用：根因链与真机取证史 = [FNOS-DEPLOY.md](FNOS-DEPLOY.md)「v0.2.7/v0.2.8 网关 404
> 第三层根因」章及 v0.2.9~v0.2.14 各段；应用侧诊断（`gatewayHealth` 状态机、前端横幅）=
> 同文档 v0.2.12 段；fnOS 官方反馈诉求 = [FNOS-FEEDBACK.md](FNOS-FEEDBACK.md)；
> 脚本实现 = [`scripts/fnos-gateway-heal.sh`](../scripts/fnos-gateway-heal.sh)（SQL 与
> `fpk/cmd/_common` 的 `rb_psql()`/`fix_gateway_socket()` 逐字同源）。
