# fnOS 反馈：手动安装的 Docker 应用（fpk）网关字段缺失（v0.2.12）

> 本文是可直接复制到飞牛社区/客服工单的反馈草稿。取证来自开发者本地与真机
> 只读探针（存档路径见附录），全部结论均有证据链支撑；应用侧 v0.2.9~v0.2.11
> 三轮自愈修复已逐一尝试并被真机实证否决（详见第 3 节），故转向官方反馈。

---

## 1. 问题描述

通过**手动本地安装**（fpk 包，应用中心 → 手动安装）的 **Docker 形态**应用，
安装后 fnOS 统一网关（FN ID 登录后经 `/app/<appid>/` 前缀访问）返回 **404 Not Found**
（Go 默认 9 字节错误页——请求已被网关接收但无上游可转发）。

根因（数据库取证）：fnOS 安装链解析了应用 `ui/config` 并写入
`appcenter.app_service` 表的 type/url/icon/control/auth 等字段，**唯独不写
`gateway_socket` / `gateway_prefix` 两个字段**——尽管 `ui/config` 中的
gatewaySocket/gatewayPrefix/microApp 声明完整且合法。

对照：**商店渠道安装的应用写入正常**（同为 Docker 声明结构时）。同一份
`ui/config` 声明，两类安装渠道的写入行为不同。

受影响链路：

```
app_service（gateway_socket 为空）→ trim_sac.entry 同步重建（同样为空）
  → trim_http_cgi sacentry 周期（30 分钟）无 socket 可注册
  → 网关 404，且无任何系统侧提示
```

## 2. 复现步骤与环境

- 环境：飞牛 TRIM ME mini，fnOS 固件 1.2.0401（`os_min_version` 满足）、
  应用中心 App 1.34.0；
- 步骤：
  1. 构造含网关声明的 fpk（`ui/config` 的服务键含 `gatewaySocket: "app.sock"`、
     `gatewayPrefix: "/app/<appid>"`、`microApp`、`type: iframe`——与商店应用
     fygo-browser 逐字段同构）；
  2. 应用中心手动安装该 fpk；
  3. 查询 `appcenter` 库 `app_service` 表该应用行：`gateway_socket` /
     `gateway_prefix` 为**空**（对照 fygo 行有完整值）；`app` 表该行
     `manual_install=t / is_docker=t / is_systemd_uint=f / source_id=空`；
  4. 等待 sacentry 周期（≤30 分钟）后经网关访问 `/app/<appid>/` → 404；
  5. 对照组：商店安装的 fygo-browser（`manual_install=f / is_systemd_uint=t`），
     其 `app_service` 行 gateway 字段完整，网关访问 200。

## 3. 取证摘要

### 3.1 表行字段对比（appcenter 库，只读 SELECT）

| | fygo-browser（商店安装） | rainbow（手动 fpk 安装） |
|---|---|---|
| app_service.gateway_socket | `/var/apps/fygo-browser/target/app.sock` | **空** |
| app_service.gateway_prefix | `/app/fygo-browser` | **空** |
| created_at == updated_at | **是**（安装时刻一次性写入） | 否（gateway 值为开发者人工热修 UPDATE 痕迹） |
| app.manual_install / is_docker | f / f | **t / t** |
| ui/config 网关声明 | 含（同构） | 含（同构，逐字段一致） |

关键推理：rainbow 行的 type/url/icon/control/auth **均被手动安装链写入**
（说明 fnOS 确实解析了这份 ui/config），唯独跳过 gateway 两个字段——解析代码
存在，gateway 写入分支被 `manual_install`/`is_docker` 等条件守卫或产品决策排除。

### 3.2 应用侧三轮自愈修复均被实证否决（证明无合法通道）

| 版本 | 方案 | 真机实测结果 |
|---|---|---|
| v0.2.9 | install/upgrade 回调内直接跑宿主 psql 幂等补写两表 | **时序缺口**：全新安装时 fnOS 写 `app_service` 行**晚于**回调执行，UPDATE 落空 0 行；随后 entry 被同步周期覆盖回空 |
| v0.2.10 | 后台 watcher 轮询 30s×20 轮补写 | **身份根因**：fnOS 以**应用专用系统用户（uid 975）**执行回调（非 root），宿主 psql 被 `pg_hba: local all postgres peer map=trim_root` 拒绝（pg_ident 仅映射 root→postgres），`FATAL: Peer authentication failed`，且当时实现把错误静默吞掉 |
| v0.2.11 | SQL 改经 `docker run` 容器内 uid 0 执行宿主 psql（共享 /run socket 过 peer 认证） | **通道根因**：uid 975 连 `/var/run/docker.sock` **EACCES**（socket 为 root:docker 0660，应用用户不在 docker 组，sudoers 无应用用户规则）；v0.2.2 升级回调报 docker.sock permission denied 的真机史实佐证 |

结论：应用侧（回调身份 uid 975 + 容器运行时）**不存在任何合法的网关字段写入
通道**；DB 直写热修仅能作为管理员人工运维手段，无法随重装自愈。

### 3.3 开放 API / token 注入体系现状

- fnOS 开放 API（api-scope）全集仅 5 个能力：`trim.file.sharedAccess /
  userAccess / userAcl / path` + `trim.system.getPlatformConfig`——**无网关注册
  或 app_service 写能力**；
- `TRIM_API_TOKEN` 官方定义为「系统调用应用脚本时自动注入（如 cmd/main 等后端
  脚本）」——**仅注入生命周期脚本，不注入容器常驻进程**（docker inspect 实证
  容器 Env 无此变量），Docker 应用后端永远拿不到 token；
- 官方文档《gateway-registration》称注册方式为 ui/config 声明 + 安装时自动注册，
  未说明手动安装与商店安装在写入行为上的差异（文档缺口）。

## 4. 诉求

1. **修复手动安装链的 gateway 字段写入**：`manual_install=t`（尤其 Docker 形态）
   的应用，安装时与商店渠道同样解析 ui/config 并写入 `app_service` 的
   `gateway_socket`/`gateway_prefix`；若属刻意限制，请给出手动安装应用的官方
   网关注册途径；
2. **开放网关注册/查询类 api-scope**：如 `trim.app.gateway.register` /
   `query`——apiscope socket 基础设施对应用用户（TrimApiUsers 组）已可达，
   开放后应用可自检/自注册，也能彻底解决本问题；
3. **为 Docker 应用提供 TRIM_API_TOKEN 容器注入机制**（如 compose env 渲染）：
   当前后端 API 对 Docker 形态应用形同虚设。

## 5. 附带安全提示（独立事项，建议评估）

真机取证过程中发现 `/etc/postgresql/15/main/pg_hba.conf` 存在：

```
host ai_manager postgres 127.0.0.1/32 trust
```

即本机 TCP 直连即可**无密码**以 postgres 超级用户身份访问数据库（仅提示存在
该入口，未做任何利用；应用产品代码亦不含任何依赖此通道的逻辑）。建议评估该
trust 认证面的必要性与暴露范围。

## 6. 附录：证据存档清单

以下为开发者本地取证存档（非公开链接，如需原始输出可联系提供）：

| 存档 | 内容 |
|---|---|
| `.qa-tmp/t108/final-report.md` | 四条自愈通道可行性调研总报告（开放 API/manifest/appcgi/运行时自检） |
| `.qa-tmp/t108/p212b-rebuilt/` | app/app_service/entry 表行只读 SELECT、fygo 与 rainbow ui/config 对比、compose 渲染、apiscope socket 连通性实测 |
| `.qa-tmp/t108/fnnas-docs/` | 官方文档镜像（gateway-registration / api calling / environment-variables 等） |
| `.qa-tmp/t107/final-report.md` | v0.2.11 真机验证报告（Phase 0 实证否决，根因链闭环） |
| `.qa-tmp/t107/evidence-phase0.md` | docker.sock EACCES 实证、pg_hba/pg_ident 全量、/run socket 权限清单（130+ 条） |
| `.qa-tmp/t99/`（probe43~61） | 早期网关 404 三层根因递进取证（DB 热修配方、sacentry 周期锚点、`upstream register` 日志模式） |

关联文档：应用侧问题全景与修复史见仓库 [FNOS-DEPLOY.md](FNOS-DEPLOY.md)
「v0.2.7/v0.2.8 网关 404 第三层根因」章。
