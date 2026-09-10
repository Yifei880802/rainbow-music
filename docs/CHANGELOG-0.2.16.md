# 变更清单：v0.2.15 → v0.2.16

基线 `933fbe7`（远端 main 现状）→ 本地领先 **8 个提交**（撰写本文的 #131 文档提交将追加为第 9 个），2026-09-07 至 2026-09-08。仓库改动共 **24 个文件、+2070 / −146**（不含 #131 文档提交），另有发布前 R1 真机预验证（判决 **PASS**）。

> **本文是对外可读版本。** 仓库公开，因此不写 NAS 主机名、备份与证据树的具体落盘
> 路径、凭据与内部运维细节——这些属于内部项目档案，不属于这里。技术结论与代码改
> 动本身完整无删减。

> **发布状态（已于 2026-09-09 发布）**：版本承载点（`fpk/manifest`、
> `server/package.json` 等）已**全量 bump 至 0.2.16**（提交 `006f797`），本地门禁
> `scripts/verify-ci.sh` 完整段 **PASS**，fnpack 官方工具已真构建出
> `rainbow-0.2.16.fpk`。本批提交已 fast-forward 推送至远端 `main`，并打 annotated
> tag **`v0.2.16`**（tag 对象 `81e1ca7` → 提交 `b0c5776`）触发 CI：build workflow
> （event=push、head_branch=`v0.2.16`）conclusion=**success**，GHCR 镜像、
> `rainbow-0.2.16.fpk` 与 Release「Rainbow v0.2.16」（published_at
> 2026-09-09T09:11:10Z）全部产出。发布通道即此前裁决的普通 git push
> （fast-forward）+ annotated tag `v0.2.16`。截至
> `3a014a0`，本批提交状态位**全部为 A/M，无 rename/delete**（`git show --raw`
> 核对）；发布不再走逐对象复刻式发布链（该链仅适用单 commit，已沉淀为
> `github-release-chain` skill）。

---

## 一、提交总览

| 提交 | 时间 | 说明 | 规模 |
|---|---|---|---|
| `e0b0786` | 2026-09-07 21:15 | `fix(server): settings smokeTest 全块补可选链兜底，防旧 config 缺 alert 块 GET /settings 500` | 1 文件 +15/−11 |
| `e6e6452` | 2026-09-07 21:15 | `docs(fpk): 入库 CHANGELOG-0.2.15 并核正截图计数；修正 _common 证伪注释；wizard_scan_dirs 标注当前不生效` | 4 文件 +301/−9 |
| `811c514` | 2026-09-07 22:04 | `fix(server): 冒烟布尔兜底改严格相等并补 auth/告警渠道可选链，消除 UI 与调度器语义背离` | 2 文件 +24/−9 |
| `096ebc5` | 2026-09-07 22:04 | `docs(fpk): 扫描目录失效归因订正为 #88 实证表述，消除向导文案自相矛盾` | 8 文件 +82/−27 |
| `d26c63a` | 2026-09-07 23:38 | `fix(server): loadConfig 深合并内置默认值，根治 config 子树缺失导致的 500` | 6 文件 +122/−20 |
| `48922ff` | 2026-09-08 00:12 | `feat(fpk): 新增 rainbow-library 导入共享，废弃回调渲染挂载（#88 Track A）` | 9 文件 +216/−114 |
| `896438f` | 2026-09-08 00:12 | `fix(server): 扫描根 realpath 与 dev/ino 同源去重加嵌套剪枝，根治曲库翻倍（M3）` | 2 文件 +193/−8 |
| `3a014a0` | 2026-09-08 00:47 | `test(server): 固化 config 深合并与扫描根规范化断言，并文档化 PATCH 回写语义（#135）` | 6 文件 +1090/−1 |

本批工作分三条主线：**A. settings 500 修复链与三维评审订正**（§二）、**B. 架构级遗留 #88 的 Track A 根治与配套 M3 去重**（§三、§四）、**C. 服务端首批常驻回归测试**（§五）。发布前 R1 真机预验证见 §六。

---

## 二、settings 500 修复链与三维评审订正

### 2.1 P1 修复：`GET /api/v1/settings` 500 与语义背离（`e0b0786` → `811c514` → `d26c63a`）

三个提交是同一条缺陷链的递进根治，前两步在消费侧堵漏、第三步在加载层根治：

1. **`e0b0786`（消费侧兜底）**：`safeView()` 的 `smokeTest` 整块（`enabled` / `cron` / `keyword` / `checkLyric` / `checkPic` / `alertThreshold` 与 `alert.bark` / `alert.serverChan` 子树）统一补 `?.` 与 `??` 兜底，默认值逐一取自 `buildDefaultConfig()`。修复对象：`loadConfig()` 从不与默认值合并，旧 config 缺 `smokeTest.alert` 子树时链式裸访问抛 TypeError → 500（自 v0.2.1 存在的潜伏缺陷，#122 接手审查发现）。
2. **`811c514`（语义对齐 + 同型裸访问清零，#126 三维评审驱动）**：
   - **布尔字段兜底由 `?? true` 改严格 `=== true`**（评审认定的影响面最重要发现）：运行时消费方全是 truthiness 判定（`smoke/scheduler.ts` 的 `if (!config.smokeTest.enabled) return`、`smoke/index.ts`）。YAML 空值（`enabled:` → `null`）下 `?? true` 会让 **UI 显示「已勾选」而调度器实际禁用**，且前端全量 PATCH 会把伪造的 `true` 落盘、静默开启每日 06:00 冒烟任务。`=== true` 使 `null` 与缺失一律回落 `false`，与消费方语义严格一致。字符串/数值字段（`cron` / `keyword` / `alertThreshold` / `bark.serverUrl`）保留 `??` 兜底——消费方用 `||` 取同款默认值，已逐一核实一致；
   - `!!config.auth.apiKey` → `!!config.auth?.apiKey`：旧 config 缺顶层 `auth:` 块时进程可正常启动（`loadConfig()` 从不访问 `cfg.auth`）、GET /settings 却 500，与上一条同型；
   - `core/notify/index.ts` 的 `pushBark` / `pushServerChan` 补可选链：settings 修好 200 后「测试告警推送」按钮变为可达，点击即触发 notify 的同型裸访问 500（**修复打开的新可达崩溃面**）。子树缺失等价于「该渠道未启用」→ `skipped`，不改业务语义。
3. **`d26c63a`（加载层根治）**：`loadConfig()` 重写为与 `buildDefaultConfig()` **深合并**，合并后 `config.*` 各子树恒完整，任何新增消费点不再重新引入同一风险面。消费侧的 `?.` / `=== true` 保留为冗余防线（回收只省几个字符，却把端点重新绑死在加载层实现上）。

### 2.2 loadConfig 深合并的**行为变更**（升级必读）

`d26c63a` 不只是加固，含一项有意的行为变更：

- **null 语义 = 「未提供 → 回落默认值」**：YAML 显式 `null`（含 `key:` 空值写法）一律回落内置默认值。因此**手工精简过的 config，其缺省项的有效值由「禁用/空」变为「内置默认值」**——多个布尔项默认变为**启用**（如 `smokeTest.enabled` 设计默认值为 `true`，`config.example.yaml` / `buildDefaultConfig()` / fpk `render_config()` 三处口径一致）。**如需关闭某项，必须显式写 `false`，留空等于用默认值。**
- **影响面**：仅影响手工编辑的精简 config 或第三方旧 config。**真机 `.fpk` 部署零变化**——`config.yaml` 由 `fpk/cmd/_common` 的 `render_config()` heredoc 渲染，恒输出完整块且值与 `buildDefaultConfig()` 逐项相同。
- 关键例外与决策：
  - `auth.webLogin.password` 的合并默认值**恒为空串**而非随机强密码——否则 `isPasswordConfigured()` 由 false 变 true，「尚未设置登录密码」的 400 明确提示退化为静默不可登录，且随机密码会随首次 PATCH 静默落盘；
  - 三项「来源标记」（`downloadDirWasRelative` / `sourcesDirWasRelative` / `downloadConcurrencyExplicit`）取自**原始 YAML**，不被合并结果污染（后者被污染会恒为 true、永久关闭自适应并发 clamp）；
  - `applyEnvOverrides` 排在深合并**之后**，`RO_*` 环境变量优先级不变；
  - 空文件/全注释文件（`YAML.parse` 返回 `null`）按「什么都没提供」处理，旧写法在此即崩；
  - `patchConfig()` 用的既有 `deepMerge`（null 视为覆盖）与加载期 `mergeInto`（null 视为未提供）语义**刻意不同**，已加注释防互相替换。

### 2.3 PATCH 回写语义文档化（`3a014a0` 回写审计）

追踪 `PATCH /api/v1/settings` → `patchConfig()` → `saveConfig()` → YAML 落盘全链，三条结论已写入 `saveConfig` / `patchConfig` 注释并以测试钉住：

1. **固化确实存在，且范围随深合并扩大**：#127 之后 config 恒为全量深合并结果，**首次 PATCH 会把用户从未写过的字段全部写成显式默认值**（实测：只含 3 个顶层块的精简配置，PATCH 一次后落盘 8 个块全部在位）。代价是将来调整 `buildDefaultConfig()` 默认值对已 PATCH 过的用户不再生效。真机 fpk 路径零影响（`render_config()` 本就显式写全、逐项同值）。
2. **password 恒为用户实设值或空串**，绝不固化随机强密码（探针以 sha256 指纹比对坐实，不回传明文）。
3. **注释与排版被抹掉属既有行为**，非本批引入（`saveConfig` 在 `d26c63a` 前后逐字节相同）；改成保留注释需 YAML CST 级改写，风险大于收益，按「记录但不扩大改动」处置。

附带记录：`applyEnvOverrides` 生效过的字段（`RO_SERVER_PORT` 等）同样会被固化成 yaml 显式值；真机 compose 所设变量与模板同值，无危害。

### 2.4 helpText 归因纠偏与文档口径统一（`e6e6452` → `096ebc5`）

- `e6e6452`（#122 卫生项）：`docs/CHANGELOG-0.2.15.md` 入库（此前 untracked）并核正截图计数 22→23；`_common` 的 `rb_psql` docstring 由「真机探针 20 余次 100% 成功的配方」改写为如实的「适用边界」（docker 通道仅 root 语境有效；回调 uid 975 对 `/var/run/docker.sock` EACCES，20/20 轮实际全败）；`wizard_scan_dirs` 标注当前不生效（选「标注不删」：字段被三个回调消费并持久化，强删有断链风险）。
- `096ebc5`（#126 三维评审订正）：**删除已撤回的「锚点被剥离 / else 分支」误诊表述**——与仓内已有明文更正相矛盾，且真机取证证实 fnOS 保存的 compose 里**确有**渲染行（挂载行与拼接后的 `RO_SCAN_ROOTS` 均在位）；归因统一改为 **#88 实证表述：fnOS compose up 采用安装时保存的内部模板、不读宿主渲染文件**。改动覆盖 `fpk/wizard/{install,config}` helpText、`_common` 的 `render_scan_mounts` 注释、`upgrade_callback` 头注释（`fpk/` 下检索「剥离」归零），并消除向导文案自相矛盾（config 向导页级 tips 与扫描目录字段的「提交后重启生效」承诺打架，改为改写而非追加告警句）；`fix_gateway_socket_watch` 的 watcher heredoc 头注释同步如实化（该注释会随 watcher 脚本落盘到 NAS 产物）；`docs/USER-GUIDE.md` / `docs/FNOS-DEPLOY.md` 四处补同口径 caveat；`API.md` 补 GET /settings 契约注；`CHANGELOG-0.2.15.md` §7.2 追加后记并就地订正两处事实错误（类型必选性、行号漂移改符号引用）。
- `d26c63a` 同步：`API.md` 契约注按深合并新口径重写、`docs/DEVELOPMENT.md` 新增「加载期默认值深合并」条目、`CHANGELOG-0.2.15.md` 后记「四」首条标注已处置。

---

## 三、#88 Track A：`rainbow-library` 导入共享（`48922ff`）

### 3.1 背景与调研结论（#128）

#88 的字面诉求——安装向导手填任意 NAS 绝对路径 → 自动挂载进容器扫描——在 fnOS 的 Docker micro_app 模型下**无法低风险实现**：官方文档与真机实证一致表明，fnOS 的 compose up 只采用「包内模板字面行 + 封闭的 `${TRIM_*}` 占位集合」，向导自定义字段与用户授权目录均无法被替换进包内 compose 成为动态挂载；Docker 形态下用户目录进容器的**唯一原生通道是 data-share 固定共享**（官方「任选已有目录」体验只存在于 native_app 宿主 root 直读）。字面根治的两条路线（Track B 转 native / Track C 文件开放 API）均为架构级重写，独立立项，不入本版。

### 3.2 **UX 契约变更**（产品语义，必读）

> **「导入本地音乐」的交互契约从「扫描目录指向任意已有目录」变更为「把文件放入固定的 `rainbow-library` 导入共享」。**

- v0.2.15 及以前：向导「音乐库扫描目录」承诺填任意 NAS 路径即可扫描（实际经 `.fpk` 路径永不生效，#88）；
- 本版起：新增与下载共享 `rainbow-music` **平级、独立顶层名**的 data-share `rainbow-library`，用户在飞牛文件管理器把要导入的音乐**放入（或移动到）**该共享 → 容器内 `/app/data/library` 真实可见 → 前端「NAS 音乐」页勾选导入根 → 扫描入库。向导原字段降级为「音乐库导入目录备注（可选）」，仅作留档、不产生挂载；
- 局限（如实声明）：不能直接指向用户既有的任意目录（如 `/vol1/1000/music`）；软链到共享外的目标在容器内不可解析，故实际是「放入/移动」语义。#88 由此从「架构级缺陷（功能性死代码）」降级为「UX 限制」。

### 3.3 逐文件改动

| 文件 | 改动 |
|---|---|
| `fpk/config/resource` | +8。`data-share.shares` 新增 `rainbow-library`（`permission.rw:["rainbow"]`，与 `rainbow-music` 完全同构）；`docker-project` 与 `api-scope` 一字未动 |
| `fpk/app/docker/docker-compose.yaml` | +17/−6。volumes 增**字面挂载行** `/var/apps/com.rainbow.music/shares/rainbow-library:/app/data/library`（源用卷号无关稳定软链，不硬编码 `/volN`）；`RO_SCAN_ROOTS` 由单根改**模板字面双根** `"/app/data/downloads:/app/data/library"`；删除已失去意义的 `rainbow-scan-volumes-anchor` 回调渲染锚点 |
| `fpk/cmd/_common` | +81/−89。`render_scan_mounts()` 降级为「仅把向导原始输入持久化到 `SCAN_DIRS_FILE`」（方案 b：函数名保留——三个回调与多份历史文档交叉引用该名，名实不符由函数头注释显式说明），**不再触碰 compose 一个字节**；留档前做同源过滤（realpath 等于下载共享 realpath 或位于其内的条目跳过，防误导后续消费诱发 M3；软链缺失时跳过过滤、全部留档，fail-safe）；`SCAN_DIRS_FILE` 改**只写不读**（删 `upgrade_callback` 回读补渲染分支，文件保留不删，留作诊断痕迹与将来 Track B 输入参考）；`check_data_share_link()` 扩展为循环诊断**两个**软链（ok/broken/realdir/unexpected/missing 五态）并记录 `TRIM_DATA_SHARE_PATHS`，契约不变：恒 `return 0`、绝不创建/修复/删除/移动/替换任何路径（回调 uid 975 改不动 root 托管软链） |
| `fpk/cmd/{install,upgrade,config}_callback` | 调用点注释同步「仅留档」语义；`config_callback` 去掉 `changed=1`——留档不产生运行时变化，为它重启容器只会白白打断在途下载与 SSE 长连接（密码/端口等真实变更仍各自置位并重启） |
| `fpk/wizard/{install,config}` | 字段名 `wizard_scan_dirs` 保持不变（改名会与回调变量名失配），label 改「音乐库导入目录备注（可选）」，helpText 如实描述新机制（导入用 `rainbow-library` 共享、本输入框不产生挂载也不改变扫描范围、同源路径自动跳过），沿用 #126 已订正的实证口径，不承诺未经真机验证的效果 |
| `scripts/verify-ci.sh` | +79。`stage_fpk` 新增 `LIBRARY_SHARE` 包级断言五组，把「命名一旦嵌套立即翻倍」的评审红线**机械化**：① resource 声明两个共享；② 共享名不含斜杠且两名互不为前缀；③ compose 恰好 1 条 library 字面挂载行且源为稳定软链；④ 容器内两挂载点互不嵌套互不重合；⑤ `RO_SCAN_ROOTS` 为模板字面值、含双根、不残留 `/app/data/scan`、无废弃锚点 |

### 3.4 命名红线（M3 防翻倍，评审强制项）

`rainbow-library` 必须是与 `rainbow-music` **平级的独立顶层共享名**。若写成 `rainbow-music/library` 这类嵌套名，其宿主路径落在下载共享内部，会被 `/app/data/downloads` 与 `/app/data/library` 各扫一遍，曲库立即翻倍。两名互不为前缀、宿主路径与容器挂载点双向互不嵌套，已由 `verify-ci.sh` 断言卡死；服务端另有 §四 的 `normalizeScanRoots` 兜底。

### 3.5 服务端零改动即兼容

`server/src/routes/me.ts` 的 `availableScanRoots()` / `DEFAULT_SCAN_ROOT` 无需改：仍读 `RO_SCAN_ROOTS`，模板字面双根天然解析出两个可选项；前端「NAS 音乐」页自动出现「下载目录 + 导入目录」两个可勾选根。老用户已有勾选（`user_scan_roots` 按 path 字符串存）跨升级保留，新根默认未勾选，行为向后兼容。

---

## 四、M3：扫描根规范化根治曲库翻倍（`896438f`）

### 4.1 缺陷与动机

曲库去重键自始至终是**路径字符串**（表约束 `UNIQUE(uid,path)` 与扫描期 `st.seenPaths`）。两个 enabled 扫描根一旦指向同一物理目录（不同挂载视角、软链或嵌套），walk 出的路径字符串不同，两道去重同时失效，同一文件索引两行、**曲库翻倍**，且后果用户不可自行恢复（需清库重扫）。v0.2.15 时该风险因 #88（第二根恒不生效）不可达；Track A 让第二根真正生效后**必须同批根治**。

### 4.2 实现

- 新增导出 `normalizeScanRoots(roots)`，返回规范化后的根与被丢弃根的取证明细，三步：
  1. 逐根 `path.resolve` + `fs.realpathSync`（realpath 失败仅告警并保留 resolve 结果，不阻断其余根，交 worker 按既有容错跳过）；
  2. **`dev:ino` 物理同源去重**，辅以 realpath 字符串去重，按首次出现顺序保序（首项恒为下载根，语义不变）；
  3. **嵌套剪枝：两遍法**，去重完成后按祖先关系偏序统一判定，只丢严格后代、不会父子俱丢。
- `startScan` 在建快照与发 walk 之前接入规范化：`st.roots`、`currentRoot`、`worker.postMessage` 全部改用规范化后的根，使 **DB 落库路径、进度展示、`isPathAllowed` 鉴权集合三者同一口径**；
- 取证日志：仅当发生剪枝时 warn 打印 requested / effective / dropped（含原因）——真机核对「两个扫描根是否物理同源」只能看这条；
- `isPathAllowed` 同口径改造：对 `download.dir` 与每个 enabled 根同做 realpath 后再前缀比对；realpath 形态未命中时再用原始写法比一次，**兼容升级前入库的旧字符串路径行**，避免存量曲目升级后播放 403。

### 4.3 对 #128 调研设计的两处补全（偏离说明，实测驱动）

1. **同源判定不能只靠 realpath，必须补 `dev:ino`**：调研假设「容器内 bind mount 的 realpath 会解析到同一底层」被实测证伪——`fs.realpathSync` 只解析符号链接，bind mount 不是符号链接、容器内也看不到宿主路径，两个 bind 到同一宿主目录的挂载点 realpath 完全不同，只有 `statSync` 的 `st_dev`/`st_ino` 相同（本机以 macOS firmlink 作等价构造坐实：两视角 realpath 各异而 dev:ino 全同）。
2. **祖先判定必须走 `dev:ino` 祖先链，且顺序无关**：`path.relative` 字符串判定对跨挂载视角的嵌套（即命名红线被破坏、共享名写成 `rainbow-music/library` 的场景）**完全漏检**——两根 realpath 之间既无字符串祖先关系、dev:ino 也不相同；只有逐级向上 stat 祖先目录并比对 dev:ino 才能识别。字符串判定保留为 stat 不可用时的兜底。原文「rootB 在 rootA 之内则丢 rootB」隐含父根先到的假设，子在前、父在后时仍会翻倍；改为偏序统一判定后两种输入收敛到同一结果。

---

## 五、服务端首批常驻回归测试（`3a014a0`）

### 5.1 动机与框架

深合并（#127）与 M3（#129）交付时的断言只存在于一次性临时脚本与人工核对里，脚本用完即删、无常驻载体——将来任何人改动合并规则或去重剪枝都不会有任何东西变红。本批固化为**仓库首批常驻测试**：用 node 内置 `node:test` 配合**既有 devDependency `tsx`** 运行，**零新增依赖**；`package.json` 只加一行 `"test": "tsx --test test/*.test.ts"`，版本号与既有四个脚本未动；`tsconfig.json` 未改（include 仍为 `["src"]`，测试不进 dist 产物）。

### 5.2 `test/config.merge.test.ts`（65 项）

10 个场景（s1 缺 `smokeTest.alert` 子树 / s2 缺整个 `auth` 块 / s3 `enabled` 为 YAML 空值 / s4 全注释文件 / s5 完整显式配置对照组 / s6 两个 dir 留空 / s7 手工精简配置 + PATCH 回写主场景 / s8 配置文件不存在 + PATCH 首启路径 / s9 PATCH 显式关闭 / s10 完整配置 + PATCH 零固化对照组），每场景三项通用断言：`loadConfig` 不抛错、GET /settings 200 且视图 22 个字段路径逐一比对、**展示层 `enabled` 与调度器 `!enabled` 判定恒同真假**（#126 M1 防线的机械化）。每场景 spawn 一次 `fixtures/settings-probe.ts` 子进程（config.ts 在模块求值期固化 CONFIG_PATH，一个进程只能加载一份配置），探针内注册**真实** settingsRoutes 并 inject，不复刻 `safeView`，避免测试与实现脱钩。

### 5.3 `test/scanner.normalize.test.ts`（35 项）

把 M3 交付时用完即删的 31 项断言转为常驻回归并补 4 项契约性质断言，A~H 八组：独立目录不误剪 / 符号链接同源去重 / bind 与 firmlink 同源靠 dev:ino / 同视角嵌套剪枝（含逆序、三层、兄弟不误剪、父子不俱丢）/ 跨挂载视角嵌套（字符串判定必漏检的三种输入）/ 混合输入 / 异常输入不阻断（空数组、不存在路径、`.`/`..`、尾斜杠、相对路径）/ 契约性质（幂等、不改入参、dropped 结构）。仅 import `normalizeScanRoots`，未改 scanner 本体。

**skip 语义红线**：dev:ino 组需要「realpath 不同而 dev:ino 相同」的目录对，无特权环境下只有 macOS firmlink 能天然提供；探测不到该视角时记为 **skip 而非 pass**，绝不把「没测到」伪装成「测过了」。

### 5.4 沙箱前置

`test/fixtures/env-sandbox.ts` 必须是测试文件的**第一个 import**：先把 `RO_CONFIG` / `RO_DB_DIR` / `RO_LOG_LEVEL` 指向 mkdtemp 沙箱，否则 `ensureConfigFile` 会在仓库根生成 config.yaml 并打印随机密码、db 会在仓库根建 SQLite 污染既有真机数据副本。沙箱在进程退出时无条件清理。

验证：`npm test` → **tests 100 / pass 100 / fail 0 / skipped 0**；`tsc --noEmit`（含 `--strict` 单独检查测试文件）exit 0；`npm run build` 产物无 test 文件；仓库根无沙箱残留。

---

## 六、发布前 R1 真机预验证（#134，判决 PASS）

Track A 的唯一实质未知点（调研风险表 R1）：**fnOS 在「升级已安装应用」时，是否为新声明的 data-share 自动建目录 + 软链 + 正确挂载**。已在真机（fnOS，vol2）以本地构建的 manifest `0.2.16` fpk **刻意引用 v0.2.15 GHCR 镜像**做升级预验证，6 点取证全绿、STOP 红线全部未命中，判决 **PASS**：

| # | 取证点 | 结果 |
|---|---|---|
| ① | 升级前基线：单共享 `rainbow-music`、无 `rainbow-library` | 确认 `rainbow-library` 为本次升级**新增**声明，判决点成立 |
| ② | 经 fnOS Web 应用中心 `update` 端点执行升级 | 正确识别为对现有应用的升级（非全新安装），升级特有环境 `TRIM_OLD_APPVER` 佐证走完整升级链 |
| ③ | **核心判决点**：`rainbow-library` 软链与 `@appshare` 目录 | **ok**——fnOS 自动创建 `@appshare/rainbow-library` 目录与 `/var/apps/<app>/shares/rainbow-library` 软链，compose 双根 + library 挂载被正确采用，`RO_SCAN_ROOTS=/app/data/downloads:/app/data/library` 字面生效，`upgrade_callback` 探针全链成功（无任何 FAILED） |
| ④ | 容器健康度 | running / healthy / restarts=0，manifest 0.2.16、config/resource 双共享 |
| ⑤ | `GET /api/v1/me/scan-roots` | **available = 2 个独立、不嵌套的根**（downloads + library） |
| ⑥ | M3 端到端：放 1 个测试音频入导入共享 → 双根扫描 | 曲库 **91 → 92（精确 +1）**，downloads 根 91 行**未翻倍**，标签正确解析；清理后恢复 91 行干净态——独立物理共享天然不重叠（Track A 设计正确性端到端验证） |

**范围限定（避免误读）**：R1 判决范围 = **打包机制**（fpk 声明驱动的 data-share 升级创建行为）。容器跑的仍是 v0.2.15 应用代码，本批服务端修复（M3 `dev:ino` 代码级去重、loadConfig 深合并等）**不在该容器内**，留待 #133 用真实 CI 构建的 v0.2.16 镜像验证；⑥ 验证的是「独立共享天然不翻倍」（设计层）。

**供 #133 留意的两个观察点**（不影响 R1 判决）：

1. **v0.2.15 镜像 digest 漂移**：升级重拉后 ImageID 由基线 `941837b0…` 变为 `f39b8b45…`（RepoDigest `30acda7e…`）——GHCR 上 v0.2.15 tag 的镜像 digest 在两次部署间已变（疑 CI 重建/re-tag）。tag 与应用代码版本不变、容器 healthy、曲库完整；#133 升级真实 v0.2.16 镜像时须留意 tag→digest 对应。
2. **gatewayHealth `suspected-unregistered` 为应用侧假阳性**：升级重建后进程重启、网关流量计数归零，窗口内恰无带会话的网关请求，应用据此「怀疑未注册」；实测网关前缀 302（路由已注册、非 404）、公网入口 302、app.sock 新鲜、应用 HTTP 正常——网关实际可用，属既知 fnOS 手动安装/升级网关注册时序现象（用 v0.2.15 官方 fpk 升级同样会重现），**非 Track A 回归**。

---

## 七、明确没有做的事

- **撰写本文时点（#131）未 bump 任何版本字段**——该项已由发布执行完成：版本承载点已全量 bump 至 0.2.16（提交 `006f797`），此前「提前 bump 会谎称存在一次尚未发生的发布」的口径随之闭环。
- **本版已推送、已打 tag、已产生 Release**（2026-09-09）：本地 main 领先 `origin/main`（`933fbe7`）的提交已一次性 fast-forward 推送，annotated tag `v0.2.16`（`81e1ca7` → `b0c5776`）触发 CI 成功产出 GHCR 镜像、`rainbow-0.2.16.fpk` 与 Release「Rainbow v0.2.16」——即此前「未推送、未打 tag、未产生 Release」口径已闭环。
- **未做字面 #88 根治**：Track B（转 native_app）/ Track C（文件开放 API）属架构级重写，独立立项（见 §八）。
- **未删 `wizard_scan_dirs` 字段**：与三个回调及 `scan-dirs.conf` 持久化共用，强删有安装/升级断链风险；本版处置为「label 改备注 + helpText 如实 + 只写不读」。是否隐藏/删除字段需同步 `verify-ci.sh` 断言，另行决策——本批做到「不误导」，未做到「不暴露」。
- **未自动迁移任何用户数据**：旧 `scan-dirs.conf` 非空值不被消费、无副作用，文件保留不删。
- **R1 预验证未触碰生产数据**：测试音频与索引行用后即清，曲库恢复 91 行；PASS 后按判决语义不自行回滚，生产保持 Track A 构建等待 #132/#133。

---

## 八、已知盲区与遗留

1. **字面 #88（任意目录扫描）**：Track A 上线后 #88 从「架构级缺陷」降级为「UX 限制（不能指向任意外部目录）」。字面根治（Track B native 化 / Track C 文件开放 API，后者当前被 `TRIM_API_TOKEN` 不注入容器阻塞）需独立立项与真机网关回归。
2. **服务端修复的真机验证**：M3 代码级去重与 loadConfig 深合并已入库并通过 100 项常驻测试，但真机 v0.2.16 镜像内的端到端验证留待 #133。
3. **digest pin 真机验证**（v0.2.15 遗留盲区）：飞牛真机拉 `tag@digest` 引用装应用仍未跑过，#133 升级时一并覆盖。
4. **config.yaml 注释在首次 PATCH 后被抹掉**：既有行为（非本批引入），已文档化并被测试钉住现状；改成保留注释需 YAML CST 级改写，风险大于收益，未做。
5. **`applyEnvOverrides` 字段被 PATCH 固化**：正确修复需逐字段来源追踪，会侵入核心写路径，本批只记录不做。
6. **数据层遗留核销**（对照 v0.2.15 §7.3）：「扫描根同源致曲库翻倍」已由 M3 根治 + Track A 命名红线双保险；「scan-dirs.conf 冗余行」已在 NAS 侧清空（0 字节）且 Track A 下该文件停止驱动挂载，问题自然消解。旧 `@appdata` 历史文件仍按 v0.2.15 的运维手动 copy-only 流程处置（可选，包本身永不触碰）。

---

## 附录：文件级 numstat（`933fbe7..3a014a0`，不含 #131 文档提交）

| +增 | −删 | 文件 |
|---|---|---|
| 690 | 0 | `server/test/config.merge.test.ts` |
| 308 | 0 | `docs/CHANGELOG-0.2.15.md` |
| 299 | 0 | `server/test/scanner.normalize.test.ts` |
| 180 | 7 | `server/src/core/library/scanner.ts` |
| 123 | 10 | `server/src/core/config.ts` |
| 100 | 81 | `fpk/cmd/_common` |
| 100 | 0 | `server/test/fixtures/settings-probe.ts` |
| 79 | 0 | `scripts/verify-ci.sh` |
| 59 | 0 | `server/test/fixtures/env-sandbox.ts` |
| 31 | 12 | `server/src/routes/settings.ts` |
| 17 | 6 | `fpk/app/docker/docker-compose.yaml` |
| 14 | 7 | `fpk/cmd/upgrade_callback` |
| 13 | 1 | `server/src/routes/me.ts` |
| 12 | 4 | `server/src/core/notify/index.ts` |
| 8 | 3 | `fpk/cmd/install_callback` |
| 8 | 0 | `fpk/config/resource` |
| 7 | 3 | `docs/FNOS-DEPLOY.md` |
| 6 | 4 | `fpk/cmd/config_callback` |
| 4 | 0 | `docs/USER-GUIDE.md` |
| 3 | 3 | `fpk/wizard/install` |
| 3 | 3 | `fpk/wizard/config` |
| 2 | 1 | `server/package.json` |
| 2 | 1 | `docs/DEVELOPMENT.md` |
| 2 | 0 | `API.md` |
