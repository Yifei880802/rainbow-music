# Rainbow fnOS 部署指南（v0.2.1）

面向 fnOS（飞牛 OS）部署与运维场景的说明：版本要求、双入口（端口直连 / FN ID 统一网关）双模式、本地音乐库挂载机制、安全模型与降级行为。日常使用见 [USER-GUIDE](USER-GUIDE.md)，API 契约见 [API.md](../API.md)。

---

## 目录

- [版本要求](#版本要求)
- [双模式：local（端口直连）与 gateway（FN ID 网关）](#双模式local端口直连与-gatewayfn-id-网关)
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
| 入口 | `http://<NAS_IP>:23330/` | fnOS 桌面/应用列表的 Rainbow 图标（网关前缀 `/app/com.rainbow.music`） |
| 身份 | **admin 账密登录**（安装向导设置的密码） | **FN ID 免密自动登录**：fnOS 校验用户会话（含 FN ID 远程访问）后注入可信身份头，登录页显示「已通过 FN ID 登录为 xxx」，一键直达 |
| 多用户 | 单管理员（v0.2.0 语义） | 每位进入的 fnOS 用户各自独立（uid 隔离：歌单 / 播放历史 / 收藏 / NAS 曲库 / 偏好） |
| 权限 | 恒为管理员 | 按用户实际角色：fnOS 管理员=`isAdmin=true`，普通成员=普通用户（全局设置/音源/刮削/冒烟操作返回 403） |

两实例**并存**而非互斥：

- 网关实例仅当容器环境变量 `RO_GATEWAY_SOCK` 存在时启动（`.fpk` 安装时由 compose 注入 `/app/target/rainbow.sock`，`TRIM_APPDEST` 挂载点）；
- 保留 TCP 端口是为了兼容既有 `LAN IP:23330` 直连习惯（浏览器收藏/脚本/自动化不受影响）；
- `/api/v1/auth/status` 响应中的 `mode` 字段（`local` / `gateway`）标明当前请求落在哪个实例，前端据此自动切换登录页形态。

> 老版本（≤v0.2.0）升级后无任何配置迁移：`RO_GATEWAY_SOCK` 未注入时进程只有一个 TCP 实例，行为零变化。

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

真机升级安装沿用 #81 已验证的 trim-cli 通道；下列验证点对应发布计划模块七第 4 节（真机执行由后续任务 #88 完成，本清单为其基线）：

- [ ] **网关入口出现**：fnOS 桌面/应用列表出现 Rainbow 图标（网关前缀 `/app/com.rainbow.music` 生效）；
- [ ] **FN ID 免密进入**：fnOS 已登录用户点图标直达主界面，登录页出现「已通过 FN ID 登录为 <用户名>」；远程（FN ID 外网）访问同样免密；
- [ ] **扫描目录出库播放**：向导填入的 NAS 音乐目录可在「NAS 音乐」页勾选 → 扫描出曲目 → 行点击播放（Range 流式）有声、封面正常；
- [ ] **双账号数据隔离**：两个 fnOS 用户先后进入，各自的歌单/播放历史/收藏/NAS 曲库互不可见；
- [ ] **权限边界**：普通成员打开设置页可读，改配置/触发冒烟返回 403 提示；fnOS 管理员可正常操作；
- [ ] **TCP 直连回归**：`http://<NAS_IP>:23330/` 仍可 admin 账密登录，老书签/脚本不受影响；
- [ ] **v0.2.0 存量数据完整**：升级前已有的下载任务记录、歌单、音源脚本、`config.yaml` 全部保留；老歌单对 admin（legacy 归属）全部可见；
- [ ] **老 fnOS 回落**（如可找低版本环境）：无网关入口时纯端口模式正常。

---

> 本文档的真机部分（checklist 执行结果、apiscope 契约实测校准）由后续任务 #88 补充；当前实现中 `core/fnos/trimapp.ts` 为 env 门控预留件，接口路径按官方约定实现，真机联调时校准。
