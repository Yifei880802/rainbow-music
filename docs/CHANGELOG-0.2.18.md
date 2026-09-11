# 变更清单：v0.2.16 → v0.2.18

基线 `b0c5776`（tag `v0.2.16` 指向的提交）→ **2 个功能提交**（`0e9f24a`、`61aeaf6`，2026-09-10，共改动 **10 个文件、+1217 / −20**）→ **发布提交 `91bf9b8`**（bump 0.2.17 + 本 CHANGELOG 初稿，已 fast-forward 推送并打 annotated tag `v0.2.17`）→ **本版发布提交**（bump 0.2.18 + test 可移植性修复 + 本文改名为 `CHANGELOG-0.2.18.md`）。tag `v0.2.17` 触发的 CI 在**单元测试门禁**失败（Linux 上 1 项既有测试的平台假设不成立，详见 §3.4），已按 **fix-forward** 处置：`v0.2.17` 作为「已 push、CI 失败、零产物」的诚实烧号留档，**不删除、不重指**，改由 **`v0.2.18`** 承载本次发布。

> **本版为维护性发布（运维 / CI 门禁 / 文档）**：两个功能提交**不含任何 `server/src` 应用功能代码改动**——服务端音乐应用的行为、接口契约与曲库逻辑与 v0.2.16 **完全一致**。发布提交仅 bump 版本承载常量（`status.ts` / `scrape-detail.ts` 的版本字符串等），不改变运行时行为。因此 GHCR 镜像会随 tag 重新构建（携带新版本号），但**应用可观测行为与 v0.2.16 等价**。本版另含一处 **test-only 可移植性修复**（`server/test/scanner.normalize.test.ts`，§3.4），仅改测试、不动任何 `server/src` 产品代码，对镜像与 `.fpk` 的运行时行为零影响。

> **本文是对外可读版本。** 仓库公开，因此不写 NAS 主机名、备份与证据树的具体落盘
> 路径、凭据与内部运维细节——这些属于内部项目档案，不属于这里。技术结论与代码改
> 动本身完整无删减。

> **发布状态**：版本承载点（`fpk/manifest`、`server/package.json`、`status.ts`、
> `scrape-detail.ts` MB UA、`API.md` status 示例、`verify-image.sh` 默认镜像 tag、
> `docs/FNOS-DEPLOY.md` 标题）已**全量 bump 至 0.2.18**；本地门禁
> `scripts/verify-ci.sh --skip-docker` 结论 **PASS（可发布）**——heal / meta / build /
> test（`npm test` **100 / 100**）/ fpk 五段全绿，docker 段因本机无运行时记 SKIP
> （不影响结论），fnpack 官方工具已真构建出 `rainbow-0.2.18.fpk` 且包级断言
> （TAG_CONSISTENCY / DOWNLOAD_MOUNT / WIZARD_FIELD / DDIR_CONVERGE /
> LIBRARY_SHARE）全 PASS。
>
> **fix-forward 说明（审计诚实）**：本批最初以 `v0.2.17` 发布——提交 `91bf9b8`
> 经 **Xcode-beta git 2.54.0** fast-forward 推送至远端 `main` 并打 annotated tag
> `v0.2.17` 触发 `build.yml`；但该 run 在**本版新增的单元测试门禁**上失败
> （conclusion=failure，docker/fpk/release 三 job 全部 skipped，**零产物泄漏**）：
> 唯一失败用例 `scanner.normalize.test.ts` A2 的前提假设「fixture 路径经符号链接」
> 只在 macOS 成立（`os.tmpdir()` 经 `/var→/private/var`），Linux runner 的 `/tmp`
> 是真实目录 → 前提守卫假失败（根因与修复见 §3.4）。这是 v0.2.16/#135 批次的既有
> 测试，因本版 #140 首次把 `npm test` 纳入 CI 才在 Linux 暴露——**门禁正确拦截了
> 一次带病发布**。按 fix-forward：`v0.2.17` tag **不删除、不重指**，作为诚实烧号
> 留档；test 修复连同版本 bump 0.2.18 提交入 main，打 annotated tag **`v0.2.18`**
> 重新触发 `build.yml`（`on.push.tags: v*`）。v0.2.18 的 CI 产物（GHCR 双架构镜像 /
> `.fpk` / GitHub Release）终态以本次发布执行的 `ci-poll` 与 Release 页为准。
> 发布通道说明：本机多个 git 的 push 写方向断裂（坑 5），仅 Xcode-beta git 经
> `push --dry-run` 实证可用，通道选择由 `github-release-chain` skill 的
> `git-push-preflight.sh` 探测——**该 push 通道修复属 skill 侧、不在本仓库，故不计入
> 本 CHANGELOG 的仓库改动**。

---

## 一、提交总览

| 提交 | 时间 | 说明 | 规模 |
|---|---|---|---|
| `0e9f24a` | 2026-09-10 17:03 | `feat(ops): 新增 fnOS 网关字段 heal 运维脚本与 runbook，配套 530 红线回填与 _common /husr 同源修正` | 6 文件（含 2 新增）+1194/−8 |
| `61aeaf6` | 2026-09-10 19:00 | `ci(gate): 门禁补 test/heal 两段断言；留档 App Center 手装分类根因（#140/#155）` | 5 文件 +153/−8 |
| `91bf9b8` | 2026-09-10 | `chore(release): bump version to 0.2.17 并撰写 CHANGELOG-0.2.17`（tag `v0.2.17` → CI 测试门禁失败，fix-forward 烧号，见 §3.4） | 8 文件（含本文初稿）版本承载点一致 bump |
| （本发布提交） | 2026-09-11 | `chore(release): bump version to 0.2.18 + 修复 test 平台可移植性（scanner.normalize A2，#156）` | test 修复 + 7 承载点 0.2.17→0.2.18 + 本文改名 |

本批工作分三条主线：**A. 网关字段 heal 运维脚本与 runbook 正式入库**（§二）、**B. CI 发布门禁增强——单元测试作业 + heal 脚本机械化断言**（§三）、**C. App Center 手装应用分类/版本不显示的根因留档**（§四）；另有 `fpk/cmd/_common` 的 `/husr` 同源修正（§五）。本版发布提交另含 B 线直接引出的一处 **test 平台可移植性修复**（§3.4，#156）。

---

## 二、A 线：网关字段 heal 运维脚本与 runbook 入库（`0e9f24a`）

### 2.1 背景与动机

v0.2.7~v0.2.8 坐实的**网关 404 第三层根因**（`@appcenter` 库中 socket / entry 字段为空，导致 FN ID 统一网关未注册应用路由）此前只在 `docs/FNOS-DEPLOY.md` 里以「SQL 片段 + 手修叙述」形态存在：既不可执行、也不可复跑，且缺退出码口径，每次真机处置都要重新推导。更关键的是**运维红线从未成文**——历史上为求「即时生效」重启网关进程 `trim_http_cgi`，导致全站 Cloudflare 隧道断开（公网入口全部 **530**）、远程通道全断，恢复需到 NAS 现场物理介入；其爆炸半径是**全站公网入口**而非单应用路由。这类教训必须落成可被 agent / 自动化直接读到的禁令，而不是留在聊天记录里。

本批把该配方正式化为 **root 语境的可执行幂等脚本 + runbook**，并把红线回填到最容易被先读到的部署文档正文。

### 2.2 逐文件改动

| 文件 | 改动 |
|---|---|
| `scripts/fnos-gateway-heal.sh` | **新增（680 行）**。root 语境幂等补写 `appcenter.app` / `app_service` / `entry` 的空字段；`--dry-run` 只读回读、零写入。退出码区分「已是正确状态」与「本次发生写入」两种成功语义，避免调用方误判是否需等下一个 sacentry 周期；内含列探测降级（`information_schema` 不可用时退到最小列集）、整行精确匹配辅助函数与「补写后仍 404」的分支排查支撑。**530 断联红线内置为护栏**：脚本只提示、绝不执行任何 `reboot` / 重启网关进程 / 重启隧道类动作。 |
| `docs/FNOS-GATEWAY-HEAL.md` | **新增（481 行）**。完整 runbook——原理速览、前置条件、Step 1~6 操作序列（dry-run → heal → 等周期 ≤30 分钟 → LAN 直连复测 → 公网复测 → 应用侧交叉确认）、「补写后仍 404」七分支排查树、**运维红线清单（第 4 节）**、root heal 与 fpk watcher 两通道关系（self-healed 假信号）、cron 准自动兜底变体、退出码与结论口径；第 7 节含真机验证记录。 |
| `docs/FNOS-DEPLOY.md` | +36。v0.2.7/v0.2.8 节正文回填 **530 运维红线**（禁止重启 `trim_http_cgi` / `cloudflared` 隧道类应用 / `reboot` NAS；DB 直改后一律等下一个 sacentry 周期约 30 分钟），并指明本节 SQL 已正式化为可执行 runbook + 幂等脚本；目录同步入链 `FNOS-GATEWAY-HEAL.md` 与 `scripts/fnos-gateway-heal.sh`。 |
| `docs/DEVELOPMENT.md` | +1。`scripts/` 结构树补 `fnos-gateway-heal.sh` 一行。 |
| `docs/CHANGELOG-0.2.16.md` | +8/−5。订正过时的发布状态口径：原文两处仍写「尚未推送 / 尚未打 tag / 未产生 Release」，与已只读核实的事实不符（远端 `refs/tags/v0.2.16` 存在、Release「Rainbow v0.2.16」已产出、build workflow conclusion=success），改为「已于 2026-09-09 发布」并保留原有变更清单不动。 |
| `fpk/cmd/_common` | +24/−4。`/husr` 同源修正，见 §五。 |

### 2.3 入库前缺陷修复（首验暴露，均在本批脚本内）

- **缺陷 1 `has_line()`**：双引号内 `"\n"` 是字面「反斜杠 + n」两字符（`case` 不做转义解释），与多行文本内真实换行 `0xa` 永不对齐 → 除「单行整体相等」外按行匹配全部失效。改用脚本已定义的真实换行变量 `$NL` 包裹，恢复整行精确匹配；未回退 `grep -q`/`head -1` 管道，继续规避 pipefail × SIGPIPE 陷阱。
- **缺陷 2 `table_columns()`**：`rb_psql` 把结果写入全局 `RB_OUT` 而非 stdout，旧版未回显 → 调用方命令替换恒捕获空串 → 列探测 100% 降级到最小列集。追加 `printf '%s\n' "$RB_OUT"` 并透传 `rb_psql` 返回码（失败 / 零列 → 仍空 → 降级，语义不变）。
- **去重 `pick_columns()`**：缺陷 1/2 修复后，`select_app_context` 同时传 `$where_col`(=`app_name`) 与字面 `app_name` 的重复项显形为 `SELECT「app_name, app_name」`（修复前恒兜底 `id` 掩盖了它）。复用已修复的 `has_line` 按整行判重跳过——属修复直接暴露的回读清洁度瑕疵，非新缺陷、不影响 heal 正确性。
- **同源核查 `fpk/cmd/_common`**：无同源缺陷（`_common` 无按行匹配辅助函数，其 `\n` 均出现在会正确解释的 `printf`/`tr` 格式串；其 `rb_psql` 让 docker run stdout 直接透传，命令替换正常取到输出）。

---

## 三、B 线：CI 发布门禁增强（`61aeaf6`，#140）

### 3.1 动机

两件事同批入库，都源于「已核实的结论没有被机械化 / 成文」：

1. 本地门禁 `scripts/verify-ci.sh` 此前只复跑 workflow 的 `meta/build/docker/fpk` 四段，而 **workflow 侧一直没有单元测试作业**：`server` 已有 **100 项常驻测试**（Node 内置 test runner，v0.2.16 §五交付），却既不在 CI 里跑、也不在本地门禁里跑，等于「测试通过」全靠人工记得手跑。
2. A 线入库 heal 脚本时明确指出：本次人工核实的项（`bash -n`、退出码口径、530 红线关键字在位）应当**机械化**，否则下次改动 heal 脚本时这些约束会静默失效。

### 3.2 逐文件改动

| 文件 | 改动 |
|---|---|
| `.github/workflows/build.yml` | +24/−3。新增 **test job**（Node 20，`needs: meta`，与 `build` 并行）：checkout → setup-node（`cache: npm`）→ `cd server && npm ci && npm test`。`docker` job 的 `needs` 由 `[meta, build]` 扩为 `[meta, build, test]`——**测试不过不会推镜像、不会出包，门禁语义前移到镜像之前**。作业链注释同步为「meta → build + test（并行）→ docker → fpk → release」。 |
| `scripts/verify-ci.sh` | +121/−8。新增 **c. test 段**（`stage_test`）：对应 workflow test job，`cd server` 后 `npm ci`（仅 `node_modules` 缺失时）+ `npm test`，任一用例失败 → 该段 FAIL、门禁不通过。新增 **0. heal 段**（`stage_heal`，见 §3.3）。两个跳过旗标 `--skip-test` / `--skip-heal`（与既有 `--skip-docker` 同语义：记 SKIP、不影响结论）；段号重排（docker c→d、fpk d→e、汇总 e→f）；`usage()` 取行范围随头部注释增长调整。 |

### 3.3 heal 段四组机械化断言（把 A 线人工核实项固化）

heal 段不依赖 `VERSION` / `node_modules` / `docker`，故排在作业链**最前**跑（秒级完成、坏了立刻暴露）：

1. **HEAL_SYNTAX**：`bash -n` 语法门禁；
2. **HEAL_EXITCODE**：退出码口径契约（runbook 第 6 节同口径）——`--help`=0 / 未知参数=1 / 非 root `--dry-run`=4。`--dry-run` 断言仅在非 root 语境成立（preflight 首条即 root 检查 → exit 4，先于 docker 探测、不碰 daemon）；root 语境降级为告警不断言，**门禁本身绝不触碰数据库**；
3. **HEAL_REDLINE**：530 红线关键字在位（`530` / `trim_http_cgi` / `禁止】重启网关进程` / `必须人工确认` / `恢复需`），字面取自 heal 脚本现行文案；
4. **HEAL_DANGER**：`reboot`/`restart` 命中行必须带「禁止」标记（注释或 heredoc 提示文案），其余命中一律视为真实重启动作违规——**heal 脚本只允许提示、绝不允许执行**。

### 3.4 门禁首次上线即拦截的 test 平台可移植性缺陷（#156，本版发布提交修复）

B 线把 `npm test` 首次纳入 CI（#140）后，tag `v0.2.17` 触发的 run 立即在 Linux runner 上暴露一个**既有测试的平台假设缺陷**——这正是门禁前移的价值：过去只在 macOS 本地手跑，缺陷被平台的符号链接特性掩盖。

- **失败用例**：`server/test/scanner.normalize.test.ts` A2「保留值为 realpath 规范化形态」。该用例属 v0.2.16/#135 批次的既有回归（固化 #129 的 M3 扫描根规范化验证），非本版新写。
- **根因**：A2 用 `assert.notEqual(realpath 形态, 字面路径)` 作**前提守卫**，证明 fixture 路径确实经过符号链接（否则「realpath 改写字面路径」的断言无证明力）。fixture 根取自 `os.tmpdir()`：macOS 的 `/var/folders/...` 经 `/var→/private/var` 符号链接，字面≠realpath，守卫成立；而 **Linux runner 的 `/tmp` 是真实目录**，字面==realpath，守卫**假失败**（`ERR_ASSERTION`，expected 与 actual 字面相同）。
- **非产品缺陷**：被测的 `normalizeScanRoots()` 行为完全正确；失败纯粹是**测试脚手架**对平台 tmpdir 的错误假设。CI 结果 pass 91 / fail 1 / skip 8（skip 8 为 dev:ino 跨视角用例在 Linux 的诚实跳过，属既有设计）。
- **修复（test-only）**：A2 不再依赖平台 tmpdir，改为测试**自建符号链接** `a2-link → roots`，用经该链接的字面路径喂入 `normalizeScanRoots()`——前提「字面经符号链接」在**所有平台恒成立**，且保留断言证明力（仍验证 realpath 规范化会改写符号链接字面路径）。本地在「默认 macOS tmpdir」与「TMPDIR 指向非符号链接真实目录（复现 Linux）」两种条件下，全量套件均 **100 / 100 pass、0 fail**。
- **归因**：该用例是 #135 既有测试，因 #140 首次纳入 CI 才暴露；本次修复挂 **#156**。修复不改任何 `server/src` 产品代码，对镜像与 `.fpk` 运行时行为零影响。

---

## 四、C 线：App Center 手装应用分类/版本不显示的根因留档（`61aeaf6`，#155）

### 4.1 现象与取证结论

v0.2.16 真机观察（#151 只读复测坐实）：飞牛 App Center「已安装」列表里 Rainbow 卡片的**分类副标题为空、版本号不显示**，而同列商店应用显示「影音娱乐」「实用效率」「开发工具」等分类。此现象极易被误判为「manifest 少写了字段」的包缺陷；若不留档，下一轮很可能有人往 manifest 里塞一个解析器根本不认的 `tags` 键，白担未知键破坏安装的风险。

经真机只读取证，根因锁定为 **fnOS 平台对手动安装应用的元数据行为，非 Rainbow 包缺陷**：

- 「已安装」卡片的分类副标题数据源是 `appcenter` 库 `app.tags` 列（fnOS 规范分类键、逗号分隔多值，前端本地化后以「/」连接）。只读 `SELECT` 实证：商店应用（有 `source_id`）其 `tags` 由商店源元数据写入（如 `Audio,Video Entertainment`→影音娱乐、`Development_Tools`→开发工具），而手动安装应用（`manual_install=t`、`source_id` 空）一律 **NULL**。
- 决定性对照：`trim_app_center` 的 manifest INI 解析键全集（struct tag 提取，49 键）**不含 `tags` 也不含 `category`**；有分类的商店应用其已安装 manifest 里同样没有任何 `tags`/`category` 键 → 分类来自商店源、不来自 manifest。
- 版本号一项：`app.version` 已正确落库，是「已安装」卡片设计上只渲染 名称 + tags 副标题 + 动作按钮（版本出现在详情 / 确认弹窗，AppStore 前端 JS 实证），同样非包缺陷。

### 4.2 逐文件改动

| 文件 | 改动 |
|---|---|
| `fpk/manifest` | +8。**仅以 `#` 注释留档**预期分类取值（Rainbow 属音乐类，应对齐 `Audio,Video Entertainment`），**不注入活跃未知键**——本机无 Docker、重装验证推迟，无法实机确认未知键行为；且解析器已实证忽略该键，活跃声明零收益，不值得拿安装链路去赌。 |
| `docs/FNOS-DEPLOY.md` | +24。新增「App Center「已安装」卡片分类/版本不显示：根因（#155）」章（数据源与取证链表格 / 为什么 manifest 修不了分类三点 / 处置），目录同步入链。 |
| `docs/FNOS-FEEDBACK.md` | +10。向 fnOS 增诉求 #4（手装应用支持 manifest 声明分类并在「已安装」卡片显示 manifest 版本），证据索引表补真机只读取证两行。 |

---

## 五、`fpk/cmd/_common` 的 `/husr` 同源修正（`0e9f24a`，潜在正确性修复）

**不改变现网可观测行为**，属正确性修复：

- `rb_psql` 的 `docker run --entrypoint` 与其后路径参数在**「新容器」命名空间**解析，而宿主 `/usr` 是以 `-v /usr:/husr:ro` 挂进容器的；镜像基于 `node:22-bookworm-slim`（不含 `postgresql-client`），旧写法用 `/usr/...` 在容器内**必然找不到文件**。拆出 `cloader`/`cpsqlbin` 容器命名空间变量（`/husr/...` 前缀），宿主侧 `loader`/`psqlbin` 仅供存在性预检。
- `render_gateway_watch_script` 的 `@LOADER@`/`@PSQL@` 内插同步改 `/husr/...` 前缀；宿主 `/husr` 不存在时照旧走 `reason=loader-or-psql-missing` 早退分支，与现网结局等价，均不产生任何写入。
- 该函数旧写法从未在真机执行到过 `ld.so`（回调 uid 975 卡在 `docker.sock` EACCES，历轮全败），故本修正不改变现网行为；真正被验证的网关修复载体是 §二 的 root 语境 heal 脚本。

---

## 六、明确没有做的事

- **未改任何应用功能代码**：本版无 `server/src` 功能逻辑改动，应用行为、接口契约、曲库逻辑与 v0.2.16 完全一致；发布提交仅 bump 版本承载常量，另含一处 **test-only** 可移植性修复（`server/test/`，§3.4），不属产品代码、不影响运行时。
- **未做字面 #88 根治**：Track B（转 native_app）/ Track C（文件开放 API）属架构级重写，独立立项（沿用 v0.2.16 §八口径）。
- **未往 manifest 注入活跃 `tags`/`category` 键**：解析器已实证忽略该键，且本机无 Docker 无法实机验证未知键行为，仅以注释留档（§四）。
- **heal 脚本不执行任何重启类动作**：脚本只在注释 / heredoc 提示文案中出现 `reboot`/`restart`（带「禁止」标记），绝不真实重启网关进程 / 隧道 / NAS；此约束由 verify-ci heal 段的 HEAL_DANGER 断言卡死（§3.3）。
- **本文不预断 v0.2.18 CI 成功**：v0.2.17 的 CI 已如实记为 failure（§3.4）；v0.2.18 的 CI 产物终态以本次发布执行的 `ci-poll` 与 Release 页为准，不在本文预写「已产出」。

---

## 七、已知盲区与遗留

1. **workflow test job 的真实 Actions 执行已首次观测**：tag `v0.2.17` 的 run 已实证 test job 在 Linux runner 上运行并**拦截**了 §3.4 的平台可移植性缺陷（conclusion=failure）；修复后 `v0.2.18` 的 test job 预期 pass 92 / skip 8 / fail 0（skip 8 为 dev:ino 跨视角用例在 Linux 的诚实跳过），终态以 `ci-poll` 为准。
2. **manifest 未知键行为**：因本机无 Docker 未实机验证，故本版刻意不注入活跃 `tags` 键；待飞牛支持 manifest 声明分类或 Rainbow 走商店上架时再启用（见 `fpk/manifest` 注释与 `docs/FNOS-DEPLOY.md` #155 章）。
3. **网关 heal 的真机执行**：heal 脚本已在 root 语境 dry-run 复验（列探测恢复、退出码与结论口径未变），但真实补写（heal 写路径）与「等 sacentry 周期后网关前缀转 302」的端到端闭环留待 NAS 侧运维按 runbook 执行——**不在本仓库发布链范围**。
4. **服务端修复的真机验证 / digest pin**：沿用 v0.2.16 §八遗留（M3 代码级去重、loadConfig 深合并的真机端到端验证、`tag@digest` 真机拉取），随后续真机升级复验覆盖。

---

## 附录：文件级 numstat（`b0c5776..61aeaf6`，两个功能提交，不含发布 bump 提交）

| +增 | −删 | 文件 |
|---|---|---|
| 680 | 0 | `scripts/fnos-gateway-heal.sh`（新增） |
| 481 | 0 | `docs/FNOS-GATEWAY-HEAL.md`（新增） |
| 121 | 8 | `scripts/verify-ci.sh` |
| 36 | 0 | `docs/FNOS-DEPLOY.md` |
| 24 | 3 | `.github/workflows/build.yml` |
| 24 | 4 | `fpk/cmd/_common` |
| 10 | 0 | `docs/FNOS-FEEDBACK.md` |
| 8 | 5 | `docs/CHANGELOG-0.2.16.md` |
| 8 | 0 | `fpk/manifest` |
| 1 | 0 | `docs/DEVELOPMENT.md` |

> 发布 bump 提交（`91bf9b8` 初版 0.2.17 → 本版 0.2.18）另改 7 个版本承载点（`server/package.json`、`fpk/manifest` version=、`server/src/routes/status.ts`、`server/src/core/adapters/scrape-detail.ts`、`API.md` status 示例、`scripts/verify-image.sh` 默认镜像 tag、`docs/FNOS-DEPLOY.md` 标题），并新增本文（由 `docs/CHANGELOG-0.2.17.md` 改名为 `docs/CHANGELOG-0.2.18.md`，v0.2.17 从未产 Release 故不保留其独立 changelog）；本版发布提交另含 test-only 修复 `server/test/scanner.normalize.test.ts`（§3.4，#156）。历史归档中的「自 v0.2.16 起」等特性引入标记与真机验证记录按事实保持 `0.2.16` 不动。
