# 变更清单：v0.2.14 → v0.2.15（含 digest pin）

基线 `3642093`（v0.2.14）→ `933fbe7`，2026-09-01 至 2026-09-04。
仓库改动共 **2 个提交、21 个文件、+401 / −83**，另有已发布产物与两轮真机验证。

> **本文是对外可读版本。** 仓库公开，因此不写 NAS 主机名、备份与证据树的具体落盘
> 路径、凭据轮换待办、以及本机开发环境的传输限制——这些属于内部项目档案，不属于
> 这里。技术结论与代码改动本身完整无删减。

---

## 一、提交总览

| 提交 | 时间 | 说明 | 规模 | 状态 |
|---|---|---|---|---|
| `0dd5ed2` | 2026-09-04 10:34 | `feat(fpk): v0.2.15 下载目录改挂 fnOS data-share，遗留 download.dir 自动收敛` | 18 文件 +301/−66 | **已发布**（tag `v0.2.15`） |
| `933fbe7` | 2026-09-04 16:17 | `ci(release): 发布的 fpk compose 钉住镜像 index digest` | 7 文件 +100/−17 | 已提交，**未推送、未打 tag**〔#126 时点限定：此为撰写时（2026-09-04）状态；该 commit 已于 2026-09-05 经 GitHub REST API 推送至远端 main，tag 仍未打〕 |

---

## 二、`0dd5ed2` — v0.2.15：下载目录改挂 data-share

目标：让下载文件直接出现在飞牛「文件管理」里。做法是**只换挂载的宿主源**，容器内
路径与配置值一律不动，因此对服务端完全透明。

### 2.1 核心行为变更（1 行）

| 文件 | 改动 |
|---|---|
| `fpk/app/docker/docker-compose.yaml` | downloads 挂载源 `${TRIM_PKGVAR}/data/downloads` → `/var/apps/com.rainbow.music/shares/rainbow-music`（卷号无关的稳定软链，由 fnOS 维护，指向 `@appshare/rainbow-music`）。容器内路径恒为 `/app/data/downloads`，`config.yaml` 的 `download.dir` 保持相对值 `data/downloads` |

该行必须留在**包内模板**：fnOS 从它自己保存的模板运行容器，回调期动态渲染的挂载行
不被采用。

### 2.2 生命周期脚本（+124 / −23）

| 文件 | 改动 |
|---|---|
| `fpk/cmd/_common` | +92/−7。新增 `normalize_download_dir()`：把遗留的宿主绝对路径收敛回 `data/downloads`。改前 `cp -p` 备份到 `config.yaml.bak-<UTC ts>`；awk 限定在 `download:` 块内，绝不碰 `sources.dir`；用 `cat >` 覆写以保住 inode（`config.yaml` 是单文件 bind mount）；恒 `return 0`，不阻断安装/升级。另新增 `check_data_share_link()`：对 data-share 软链的只读诊断，恒不阻断、绝不改动该路径 |
| `fpk/cmd/upgrade_callback` | +13。接入上述两函数，发 `04b-sharelink` / `04c-normalize-ddir` 探针 |
| `fpk/cmd/install_callback` | +9/−1。接入同两函数（不发探针标签）。`normalize` 必须排在 `ensure_data_dirs` **之前**，否则陈旧的绝对路径会触发 `case "$ddir" in /*) mkdir -p` 分支，在宿主侧凭空建目录 |
| `fpk/cmd/config_callback` | +6/−16。撤 `wizard_download_dir` 分支 |

`normalize_download_dir()` 是必需项，不是加固项：`render_config` 幂等跳过（config.yaml
已存在就不渲染），而 `upgrade_callback` 原先完全不碰 config.yaml——**只改挂载修不了
已装现场**。

### 2.3 撤销危险向导输入（−14）

| 文件 | 改动 |
|---|---|
| `fpk/wizard/install` | −7，删 `wizard_download_dir` 字段 |
| `fpk/wizard/config` | −7，同上 |

理由：该输入允许把**未挂载**的宿主绝对路径写进 `download.dir`，下载随即落进容器可写
层、重建即丢。真机实测到 4.93 MB 数据丢失。

### 2.4 门禁（+76）

| 文件 | 改动 |
|---|---|
| `scripts/verify-ci.sh` | 新增三项包级断言：`DOWNLOAD_MOUNT_PASS`（挂载源正确且无 `${TRIM_PKGVAR}/data/downloads` 回归）、`WIZARD_FIELD_PASS`（双向导均无该字段）、`DDIR_CONVERGE_PASS`（收敛函数在 6 种输入形态下行为正确且不改动无关键） |

### 2.5 版号口径（纯字符串，无逻辑变更）

`fpk/manifest`（`version` + `changelog`）、`server/package.json`、
`server/src/routes/status.ts`、`server/src/core/adapters/scrape-detail.ts`（`MB_UA`）、
`scripts/verify-image.sh`（默认镜像名）、`API.md`（示例响应）。

> 本轮 `server/src` 只有 2 处版号字符串变化，**服务端逻辑零改动**。

### 2.6 文档

| 文件 | 改动 |
|---|---|
| `docs/FNOS-DEPLOY.md` | +79/−3。新增 v0.2.15 章节：源→容器路径映射、模板约束、guard 契约、收敛说明与回滚、「扫描目录」重叠的潜伏态、运维手动 copy-only（no-clobber）迁移流程与校验 |
| `docs/USER-GUIDE.md` | +9/−13。版本口径与下载目录说明同步 |
| `README.md` | +1/−1 |
| `docs/screenshots/nas-v0.2.13-waiting-banner.png` | 新增 459 KB。补上 t114 段落里原本悬空的图片引用，使「每张入库截图都被引用」的约定重新成立（23 tracked / 23 referenced / 0 orphan） |

---

## 三、`933fbe7` — 发布的 compose 钉住镜像 index digest

问题：纯 tag 引用下，tag 一旦被重推，**已发布的 `.fpk` 就会拉到另一个镜像**，而失败
点在用户安装现场、离打包现场极远。本提交让 CI 产出的 compose 引用带上 registry
digest，把发布产物钉死在 CI 实际推送的那个 index 上。

| 文件 | 改动 |
|---|---|
| `.github/workflows/build.yml` | +25/−2。`docker` 作业加 `--metadata-file`，取 `containerimage.digest`（回退 `containerimage.descriptor.digest`）作为 job output `image_digest`；`fpk` 作业经 `FPK_IMAGE_DIGEST` 注入。**取不到合法值直接让流水线红掉**（`::error::` + 打印 metadata 全文 + `exit 1`） |
| `scripts/build-fpk.sh` | +25/−1。新增可选 `FPK_IMAGE_DIGEST`，格式（`^sha256:<64 hex>$`）在打包**之前**校验；compose 渲染为 `<image>:<tag>@<digest>` |
| `scripts/verify-ci.sh` | +31/−7。预期引用同步带 `@digest` 后缀，仍逐字符比对；另打印 `DIGEST_PIN_PASS` / `DIGEST_PIN_SKIP` 便于日志检索；digest 格式非法在进作业链前即退出；`usage()` 的 `sed` 行范围随头部注释增长同步修正（29 → 33） |
| `fpk/app/docker/docker-compose.yaml` | +4。`image:` 行上方补渲染契约注释 |
| `docs/DEVELOPMENT.md` | +10/−3。环境变量表加 `FPK_IMAGE_DIGEST` 行、版本策略加 digest pin 段、本地打包段说明为何不传、fpk 段说明更新，并**新增「门禁盲区」** |
| `README.md` | +4/−3 |
| `docs/USER-GUIDE.md` | +1/−1 |

### 三个设计取舍

1. **必须是 index digest，不是单平台 digest。** 多平台 `--push` 下 buildx 的
   `containerimage.digest` 即 index digest。钉单平台 digest 会让 arm64 用户被静默拉到
   amd64 镜像。
2. **保留 tag，而不是换成纯 `@digest`。** digest 决定实际拉取，tag 决定本地
   `docker images` 里是否还有可读标签。两者并存是 OCI 引用语法允许的。
3. **取不到 digest 就红掉，不降级。** 这与 fnpack 下载失败可降级为手工 tar 的语义
   **故意不同**：静默退回纯 tag 引用等于悄悄撤销 pin，而且会一路带到已发布的 Release
   上，事后极难发现。

### sed 顺序是承重的

`build-fpk.sh` 的三个替换表达式必须**组合占位先于单独占位**：

```bash
sed -i.bak \
    -e "s|__FPK_IMAGE__:__FPK_IMAGE_TAG__|${IMAGE_REF}|" \
    -e "s|__FPK_IMAGE__|${FPK_IMAGE}|" \
    -e "s|__FPK_IMAGE_TAG__|${FPK_IMAGE_TAG}|" \
    "$COMPOSE_FILE"
```

顺序反了，`__FPK_IMAGE__` 会先被吃掉，组合形式永远匹配不上，**digest pin 静默失效**。

### 本地不传 digest

本地构建的镜像从未 push，不存在 registry digest。因此本地闸门产物恒为纯 tag 引用
（`DIGEST_PIN_SKIP`），这是正常形态，不代表正式发布的形态。

### fnOS 侧兼容性（实测，非推断）

- 运行容器的 `com.docker.compose.*` label 证明：fnOS 把包模板渲染到自己的
  `@appcenter/<app>/docker/docker-compose.yaml`，然后跑 **stock Docker Compose v2.40.3**。
- 该文件的 `image:` 行与包模板渲染结果**逐字符一致** → fnOS 对 image 串原样透传，
  不做任何改写。
- `dockermgr` 与 `trim_app_center` 中 `@sha256` **零命中** → fnOS 完全没有 digest
  感知，既不会帮你校验，也不会破坏它。
- 真机 Compose v2.40.3 上 `docker compose config --images` 对 `tag`、`@digest`、
  `tag@digest` 三种形式均 rc=0，且原样回显。

---

## 四、已发布产物

| 项目 | 值 |
|---|---|
| tag | `v0.2.15` → commit `0dd5ed2` |
| Release | `Rainbow v0.2.15`（非 draft、非 prerelease），1 个资产 `rainbow-0.2.15.fpk`，108,241 B |
| CI | run `33842243089`，`completed/success`，5/5 作业绿，约 6 分钟 |
| GHCR | `v0.2.15` = OCI index `sha256:30acda7e…`，含 `linux/amd64` `sha256:d8eea619…`、`linux/arm64` `sha256:d20cfb39…`，另有 2 个 `unknown/unknown` 条目（buildx provenance/SBOM attestation，良性，拉取时跳过） |
| 打包路径 | **官方 fnpack 1.2.3**，非降级。判据是作业日志里的 `Packing successfully.`，不是绿色勾选——fnpack 失败也会 exit 0 |
| 三方一致性 | `cmd/_common`、`install_callback`、`upgrade_callback`、`config_callback` 四个文件的 md5 在「Release 下载的 CI 产物」「本地构建并通过双闸门的产物」「`git show HEAD:fpk/cmd/<f>`」三处**完全相同** |

### GHCR digest 曾被替换，并已实测证伪漂移风险

发布链先推的是本地构建的 **amd64-only** 镜像（digest `sha256:0ff37021…`，即通过两轮
真机闸门、NAS 当前容器实际运行的那个）；CI 跑完后同一 tag 改指 multi-arch index
`sha256:30acda7e…`。两者是否等价，用**合并 rootfs 逐文件比对**回答，而非假设：

- 下载全部差异层，按序应用并完整处理 AUFS whiteout / `.wh..wh..opq`，再比对合并后的 rootfs；
- 结果：两侧各 **15268** 个路径，**0 个**为单侧独有，**0 个**尺寸不同；
- `/app` 子树（7463 个路径：`node_modules` 含原生编译的 `better_sqlite3.node` 与全部
  `@img/sharp-*` 预编译件、`dist`、`web`、`package.json`、`sources-bundled`）
  **0 处内容差异**；
- 配置项 `Env` / `Cmd` / `Entrypoint` / `Healthcheck` / `ExposedPorts` / `WorkingDir`
  逐字节相同；21 条 `history` 中 20 条相同，第 21 条只差 HEALTHCHECK 的序列化形式
  （legacy builder 的 Go 结构体 dump vs buildkit 的字段名），命令与 30s/5s/15s 参数一致；
- 仅两类残留差异，均无效：(a) 4 个同尺寸的 apt/dpkg 构建日志，只差内嵌时间戳；
  (b) 28 个 `/app` 下的权限位——容器以 **root** 运行（`Config.User` 为空），DAC 不适用，
  且 CI 的 `0644`/`0755` 是更可移植的选择（若将来加了非 root `user:`，本地构建的那个
  会坏，CI 的不会）。
- 附带核过从未上过闸门的 **arm64** 变体：5 个原生二进制均为真正的 `AArch64` ELF64，
  `dist`/`web`/`package.json`/`sources-bundled` 与 amd64 逐字节相同，`node_modules`
  差异只有 32 个预期内的 `@img/sharp-*-x64` ↔ `@img/sharp-*-arm64` 路径与一个不同架构的
  `better_sqlite3.node`。**它结构完好，但从未实际运行过。**

---

## 五、真机验证结论（fnOS ME mini，vol2）

两轮闸门，均在真机上走完整安装/升级路径：

**全新安装**：37/37 断言通过。`normalize_download_dir()` 修好了一个**真实**现场——
`config.yaml` 41 → 41 行、只有 `dir:` 一行变化、mode 644 → 600、原配置备份留存、
`sources.dir`/`server.port`/`apiKey`/auth 全部未动。容器可写层 **4.93 MB → 0 B**，
在途数据丢失缺陷消除。经 fnOS 自己的文件 API 看到共享目录 94 项。

**v0.2.14 → v0.2.15 升级**：35 PASS / 4 FAIL，4 项均已证伪为非缺陷。

- `scan/1` 挂载缺失：在 v0.2.14、全新安装的 v0.2.15、升级后的 v0.2.15 三态下
  **逐字节一致**——fnOS 从不采用回调渲染的 compose 行，只采用包模板行。且现已无害：
  `/app/data/downloads` 本身就是持有全部 94 个文件的共享目录。
  **顺带得到一个产品结论：「音乐库扫描目录」向导字段经 `.fpk` 路径永不生效。**
- 3 处 `callback_log_missing`：断言过严。`log_info` 只写 stderr，只有 `log_error` 写
  `$TRIM_TEMP_LOGFILE`，因此**成功时 `outputText` 为空是设计如此**。

升级路径确证执行：探针目录 10 个 `step-*` 全在、0 个 `*FAILED*`、35 个 `key-TRIM_*`
标记。`config.yaml` inode 保住。挂载双向同一（inode 4597 / dev 54），无需写测试文件
即可证明。

**未触发任何音乐库扫描**（见下节）。

---

## 六、明确没有做的事

- **未触发音乐库扫描。** `library_tracks` 里有一行的路径指向旧 `@appdata` 下的文件，
  改挂后该路径悬空；而扫描器会清掉连续 2 轮未出现的行。所以必须**先**把那个文件
  拷进共享目录，**再**扫描——顺序反了会白丢一条记录。
- **未自动迁移**旧 `@appdata` 下的历史下载（按用户选择）。改为在 `docs/FNOS-DEPLOY.md`
  提供运维手动 copy-only（no-clobber）流程与校验步骤。
- **未改动服务端逻辑**，`fpk/manifest` 也未因 digest pin 而 bump 版本——版本由 git tag
  推导，bump 会谎称存在一次并未发生的发布。
- **未推送 `933fbe7`**，未为其打 tag，未产生新的 Release。〔时点限定（#126 补注）：此为本文撰写（2026-09-04）时的状态；该 commit 已于 2026-09-05 经 GitHub REST API 推送至远端 main。〕

---

## 七、已知盲区与遗留

### 7.1 digest pin 的两个盲区（已写入 `docs/DEVELOPMENT.md`）

1. **闸门证明不了 digest 指向正确镜像。** `verify-ci.sh` 比对的「预期引用」与实际
   compose 内容**同源于 `FPK_IMAGE_DIGEST` 这一个环境变量**，所以它只能证明 digest
   钉对了格式与位置。真正的防线是：CI 里该值取自 docker 作业刚推送镜像的 buildx
   metadata，全程不经人手。
2. **pin 尚未通过真机 fnOS 安装/升级验证。** 本地四形态闸门全绿（含两种 armed 失败
   形态），但飞牛真机去拉一个 `tag@digest` 引用装应用，还没跑过。**下次实际发布前
   建议补一次。**

> 关于 armed 检查：曾加过一条「`FPK_IMAGE_DIGEST` 未设置时 compose 内不得出现
> `@sha256:`」的断言，armed 测试确实返回了 rc=1——但走的是 `TAG_CONSISTENCY_FAIL`，
> 新分支**根本没被执行到**。推导确认它不可达（预期值与实际值同源，任何写死的后缀都会
> 先触发 TAG_CONSISTENCY；唯一绕法是把 `@` 塞进 `FPK_IMAGE_TAG`，而 CI 的 meta 段用
> `^v[0-9]+\.[0-9]+\.[0-9]+(-r[0-9]+)?$` 挡住了），遂删除。**教训：断言某个值「从不
> 出现」之前，必须先证明闸门是 armed 的，否则该断言毫无证明力。**

### 7.2 代码层遗留（均为既有问题，非本轮引入）

> 下表为本文撰写时点（2026-09-04）的快照：除第一行两处用〔#126 订正〕标出的事实错误已就地订正外，正文（含「未修、待决策」等当时状态）保留不改；**三项均已在后续批次处置**，落地结果与剩余尾巴见**表末「后记」**（#126 补）。

| 位置 | 问题 | 状态 |
|---|---|---|
| `server/src/routes/settings.ts` 的 `safeView()` | `safeView()` 里 `config.smokeTest.alert.bark.enabled` 无可选链，而紧邻的 PATCH 路径**有**。〔#126 订正一：原写「类型也声明两个子树皆可选」与 `server/src/core/config.ts` 不符——`RoConfig` 的 `smokeTest` 与其 `alert` 子树均为**必选**，全类型仅 `scrape?` 可选；正因类型声称必选，编译器不会提醒运行时缺失，可选链才是唯一防线。订正二：原文引用的行号（`settings.ts:70`、PATCH「149–150 行」）已随后续修复漂移，改为符号引用〕任何带 `smokeTest` 但无 `alert:` 子树的 config 会让 `/api/v1/settings` 500 | 自 v0.2.1 存在，两轮闸门均未触发；**未修**，待决策 |
| `fpk/cmd/_common` | v0.2.11 的注释声称 docker 化的 `rb_psql`（容器内 uid 0）是网关补写的可行配方。实测 40/40 轮全部 `permission denied … /var/run/docker.sock` | 注释**与事实相反**；回调以 uid 975 运行，永远拿不到 docker.sock。良性（fail-safe），但注释该改 |
| `fpk/wizard/install`、`fpk/wizard/config` | `wizard_scan_dirs` 仍在随包发布，但经 `.fpk` 路径**永不生效**（fnOS 不采用回调渲染的挂载行） | 要么删字段，要么停止暗示它有用 |

#### 后记（后续批次已处置，#126 于 2026-09-05 补）

三维评审（任务 #126）复核上表三项的修复时发现：三项本身已落地，但修复过程又引入了归因错误并暴露出三处同型的新缺陷，一并记此。

**一、上表三项的落地结果**

| 表内项 | 落地 | 结果 |
|---|---|---|
| `safeView()` 的 `smokeTest.alert.bark` 无可选链 | `e0b0786` | 已补可选链兜底（`?.` + `?? false`），缺 `alert:` 子树的 config 不再 500 |
| `_common` 的 `rb_psql` 注释与事实相反 | `e0b0786` | `rb_psql` docstring 已改写为「适用边界」如实注释（docker 通道仅 root 语境有效；回调 uid 975 对 `/var/run/docker.sock` EACCES，t114/t117 实证）。#126 又清掉同仓剩余两处同型措辞：`_common` 内 `fix_gateway_socket_watch` 的 watcher heredoc 头注释（`<<'WATCH'` 内的注释会**落盘到 NAS 产物**）与 `docs/FNOS-DEPLOY.md` 的「真机探针 20 余次全部成功的配方」表述；现全仓检索该措辞已归零（本行故意不自引用原串，否则该检索永远无法归零） |
| `wizard_scan_dirs` 随包发布但永不生效 | `e6e6452` | **未删字段**（与 install/config/upgrade 三个回调及 `scan-dirs.conf` 持久化共用，且默认 `RO_SCAN_ROOTS` 仍被 `server/src/routes/me.ts` 消费，强删有安装/升级断链风险）；改为在 `fpk/wizard/install`、`fpk/wizard/config` 的 helpText 标注不生效 + `_common.render_scan_mounts` 注释订正归因 |

**二、#126 修正的上批遗留（归因错误）**

`e6e6452` 写的 helpText 与 `_common` 注释把不生效的原因归为「fnOS 剥离渲染的挂载锚点、故走 else 分支」，与仓内已有取证相矛盾：`docs/FNOS-DEPLOY.md` 早已明文更正「剥离说系误诊」，且真机取证证实 **fnOS 保存的 compose 里确有渲染行**（`- …:/app/data/scan/1` 挂载行与拼接后的 `RO_SCAN_ROOTS` 均在位），真因是 **fnOS compose up 采用安装时保存的内部模板、不读宿主渲染文件**（架构级遗留 #88，见该文档「#88 实测发现」第 2 条）。因 helpText 随 `.fpk` 分发后不发版就无法更正，#126 已把 `wizard/install`、`wizard/config`、`_common`（含 `upgrade_callback` 头注释）四处归因统一改为已实证表述，并删除「锚点被剥离 / else 分支」字样；「额外扫描目录当前不生效」的结论保留。同时按评审 M7 给 `docs/USER-GUIDE.md`（安装向导章、「NAS 本地音乐库」章）与 `docs/FNOS-DEPLOY.md`（「配置与挂载机制」章、「扫描根不可见排查」章）补上同口径 caveat 标注与指向 #88 实测发现的交叉引用（只加标注，未重写章节）。

**三、#126 新发现并修复的同型缺陷（三维评审的影响面维度）**

- **布尔字段兜底语义背离**（评审认定为影响面最重要发现）：`safeView()` 里 `enabled` / `checkLyric` / `checkPic` 原用 `?? true` 兜底，而运行时消费方是 truthiness 判定（`server/src/core/smoke/scheduler.ts` 的 `if (!config.smokeTest.enabled) return`、`server/src/core/smoke/index.ts`）。YAML 空值（`enabled:` → `null`）场景下 UI 显示「已勾选」而调度器实际禁用，且前端全量 PATCH 会把伪造的 `true` 落盘、静默开启每日 06:00 冒烟任务。已改为 `=== true`（`null` / 缺失一律回落 `false`，与消费方语义严格一致）；字符串/数值字段（`cron` / `keyword` / `alertThreshold` / `bark.serverUrl`）保留 `??` 兜底不动（消费方用 `||` 同款默认值，已核实一致）。契约已补进 `API.md` 的 GET /api/v1/settings 示例旁。
- **`safeView()` 的 `config.auth.apiKey` 裸访问**：`loadConfig()` 从不访问 `cfg.auth`（仅 `RO_AUTH_APIKEY` 存在时才在 `applyEnvOverrides` 里触碰，而 fpk compose 未设置该变量），故旧 config 缺顶层 `auth:` 块时进程可正常启动、但 GET /settings 抛 TypeError → 500（与本表第一行同型）。已改 `config.auth?.apiKey`。（对比：`download` / `sources` 因 `loadConfig()` 内部无可选链地访问其子字段而结构性保证存在，缺则启动即失败，不属同类风险。）
- **`server/src/core/notify/index.ts` 同类裸访问**：`config.smokeTest.alert.bark` / `.serverChan`。上两项修好后 GET 恢复 200，设置页「测试告警推送」按钮变为可达，点击即 POST /settings/notify/test → notify 500（**新可达崩溃面**）。已补可选链，子树缺失等价于「该渠道未启用」→ `skipped`，不改业务语义。

**四、仍未处置的尾巴**

- `server/src/core/config.ts` 的 `loadConfig()` 仍只做 `YAML.parse(raw) as RoConfig`、**不与 `buildDefaultConfig()` 深合并**——本批所有兜底都是在消费侧打补丁，根治需在加载层合并（属行为变更，需单独授权）。〔#127 已处置：该合并已获授权并落地。`loadConfig()` 现按「YAML 显式 null 视为未提供」的口径深合并默认值，`auth.webLogin.password` 的合并默认值恒为空串（不注入随机密码），三项「来源标记」仍取自原始 YAML，`RO_*` 环境变量覆盖排在合并之后。消费侧的 `?.` / `=== true` 保留为冗余防线。副作用：手工精简过的 config 里「缺字段/留空」的有效值由「禁用」变「内置默认值」（`smokeTest.enabled` 默认 `true`），真机 fpk 模板恒写全、零影响。语义与依据见 `docs/DEVELOPMENT.md` 的「配置系统」节与 `API.md` 的 GET /api/v1/settings 契约注。〕
- 7.3 数据层遗留（曲库翻倍风险、`@appdata` 历史文件）属 NAS 运维，已另行处置。
- 向导字段是否隐藏需同步 `verify-ci.sh` 断言，另行决策；本批只做到「不误导」，未做到「不暴露」。

### 7.3 数据层遗留

- 旧 `@appdata` 下仍有 1 个历史文件（31,048,697 B）未拷入共享目录；其 DB 行在改挂后
  悬空。**拷贝必须先于首次扫描。**
- 扫描目录配置里有一行冗余的共享目录绝对路径。由于 `scan/1` 挂载根本不被 fnOS 采用，
  它当前是惰性的；但若用户将来在设置里同时启用两个扫描根，`scanner.ts` 只按**路径字符串**
  去重（不做 `realpath`），**音乐库会整个翻倍**。

---

## 附录：文件级 numstat（`3642093..933fbe7`）

| +增 | −删 | 文件 |
|---|---|---|
| 107 | 7 | `scripts/verify-ci.sh` |
| 92 | 7 | `fpk/cmd/_common` |
| 79 | 3 | `docs/FNOS-DEPLOY.md` |
| 25 | 1 | `scripts/build-fpk.sh` |
| 25 | 2 | `.github/workflows/build.yml` |
| 13 | 0 | `fpk/cmd/upgrade_callback` |
| 12 | 3 | `fpk/app/docker/docker-compose.yaml` |
| 10 | 3 | `docs/DEVELOPMENT.md` |
| 9 | 1 | `fpk/cmd/install_callback` |
| 9 | 13 | `docs/USER-GUIDE.md` |
| 6 | 16 | `fpk/cmd/config_callback` |
| 5 | 4 | `README.md` |
| 3 | 3 | `scripts/verify-image.sh` |
| 2 | 2 | `fpk/manifest` |
| 1 | 1 | `API.md` |
| 1 | 1 | `server/package.json` |
| 1 | 1 | `server/src/core/adapters/scrape-detail.ts` |
| 1 | 1 | `server/src/routes/status.ts` |
| 0 | 7 | `fpk/wizard/config` |
| 0 | 7 | `fpk/wizard/install` |
| — | — | `docs/screenshots/nas-v0.2.13-waiting-banner.png`（新增 459,140 B） |
