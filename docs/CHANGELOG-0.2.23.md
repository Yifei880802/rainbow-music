# 变更清单：v0.2.22 → v0.2.23

基线 `b89e984`（tag `v0.2.22` 指向的提交，= 当前 `origin/main`）→ **本版发布提交**（sharp 0.35.4 升级 + CHANGELOG-0.2.22 文档订正 + bump 0.2.23 + 本文）。本版是 v0.2.22 之后的**依赖维护 + 文档订正**版本，**不含任何产品逻辑改动**：① `sharp` 0.33.5 → **0.35.4**（内置 libvips 图像引擎随之到 **8.18.6**）② 订正 `docs/CHANGELOG-0.2.22.md` 一处散文笔误（package-lock 净减行数 `1129` → 实测 `1292`）③ 版本承载点全量 bump 0.2.22 → 0.2.23。

> **本版不含产品逻辑改动，是纯维护版**。`server/src` 下仅两处**版本字符串常量**随 bump 更新（`status.ts` 的 `version` 字段、`scrape-detail.ts` 的 MusicBrainz UA 串），sharp 的**唯一调用点** `server/src/core/download/tag-worker.ts` 一行未动，路由 / 队列 / 搜索 / 下载 / 刮削 / DB 层全部未改。对用户而言应用可观测行为与 v0.2.22 等价；GHCR 镜像与 `.fpk` 会随 tag 重新构建并携带新版本号与新版 sharp 预编译二进制。

> **本文是对外可读版本。** 仓库公开，因此不写 NAS 主机名、备份与证据树的具体落盘路径、凭据与内部运维细节——这些属于内部项目档案，不属于这里。技术结论与代码改动本身完整无删减。本机 npm registry 指向内网镜像这一事实需要说明（它直接决定 lockfile 归一的做法，见 §三），但**主机名不写入本文、也绝不写入 lockfile**。

> **发布状态**：版本承载点（**8 文件 / 12 处**，清单见 §四）已**全量 bump 至 0.2.23**；`npm run typecheck` **零错误**；`npm test` **231 / 231 pass、0 fail、0 skipped**（sharp 无专属测试，总数与 v0.2.22 持平）；本地门禁 `FNPACK_BIN=<repo>/tools/fnpack scripts/verify-ci.sh --skip-docker` 结论 **PASS（可发布）、rc=0**——heal / meta / build / test / **isolation（checked=11 / elided=0 / unverifiable=0）** / fpk 六段全绿，docker 段因 `--skip-docker` 记 SKIP（本机无 Docker，不影响结论）；fnpack 官方工具已真构建出 `rainbow-0.2.23.fpk`（112K），包级断言（TAG_CONSISTENCY / DOWNLOAD_MOUNT / WIZARD_FIELD / DDIR_CONVERGE / LIBRARY_SHARE）全 PASS，DIGEST_PIN 为本地门禁的正常形态 SKIP。
>
> **双架构验证的归属（审计诚实）**：`docker buildx build --platform linux/amd64,linux/arm64` 两架构构建 + 容器内 `require('sharp')` + resize + jpeg 运行时冒烟，是由**前序 #224 buildx 预演**验证 PASS 的结论；**本机无 Docker，本次未复跑 buildx**（verify-ci 的 docker 段记 SKIP）。本地亲自跑的是：`npm install` 干净解析（§2.3）、darwin-arm64 上 `require('sharp')` 运行时自报 `sharp 0.35.4 / libvips 8.18.6`（§6.3）、`typecheck` / `npm test` / `verify-ci.sh --skip-docker` 三项门禁（§6.1）。linux 双架构的构建与运行时可用性以 #224 预演为准、并待正式发布 CI 的 docker job 复核。
>
> **本版尚未 push、尚未打 tag、尚未触发 CI**——全部改动收拢为**一个本地 commit**（纯 M / A，无 D / R，满足 `github-release-chain` 逐对象复刻前提）；公开发布（REST 逐对象复刻 + annotated tag `v0.2.23`）另行派发，届时需用户显式确认 `repo + tag + commit` 三元组。

---

## 一、本版内容总览

| 块 | 目标 | 改动文件 | 性质 | 用户可见影响 |
|---|---|---|---|---|
| **sharp 升级** | `sharp` 0.33.5 → **0.35.4**（内置 libvips → **8.18.6**；`@img/sharp-*` 平台包 0.33.5 → 0.35.4、`@img/sharp-libvips-*` 1.0.4/1.0.5 → **1.3.3**），跟进上游维护版本 | `server/package.json`（**+2 / −2**）<br>`server/package-lock.json`（**+257 / −164**） | 依赖维护 | **无**（封面缩放用法未触及 0.35 任何 breaking change） |
| **文档订正** | 订正 `CHANGELOG-0.2.22.md` 散文里 package-lock 净减行数的手写笔误（`1129` → 实测 `1292`） | `docs/CHANGELOG-0.2.22.md`（**+1 / −1**） | 文档 | **无** |
| **版本 bump** | 8 文件 12 处承载点 0.2.22 → 0.2.23（清单见 §四） | `fpk/manifest`、`status.ts`、`scrape-detail.ts`、`verify-image.sh`、`API.md`、`FNOS-DEPLOY.md`、`package.json`、`package-lock.json` | 版本 | 镜像 / 包 tag、`/status` 的 `version`、MusicBrainz UA |

> `server/package.json` 与 `server/package-lock.json` 同文件同时承载「sharp 依赖升级」与「version bump」两类改动，行区间不重叠（依赖声明在 L18–40 / lockfile 的 packages 树，version 在 L3、lockfile 另在 L9），单 commit 内共存、**只 bump 一次**。

---

## 二、sharp 0.33.5 → 0.35.4

### 2.1 唯一调用点与零代码改动

`grep -rn sharp server/src/` 实测：sharp 在整个服务端**只有一个真实调用点**——`server/src/core/download/tag-worker.ts`（下载 worker 子进程内做封面缩放，CPU 密集故移入 worker）。核心一行（L52）：

```ts
return await sharp(raw).resize(size, size, { fit: 'cover' }).jpeg({ quality: 90 }).toBuffer()
```

即「读原始封面 buffer → 居中裁切缩放为 `size × size` 正方形 → 编码 quality=90 的 JPEG → 返回 buffer」。`index.ts` 里出现的 `sharp` 全是注释（说明封面统一由 sharp 缩放、缩放放到 worker 里做），无第二处 API 调用。

sharp 0.33 → 0.35 的 breaking changes（最低 libvips/Node 版本抬升、部分通道与色彩空间 API 收敛、废弃若干旧选项）**均未触及** `resize(…, {fit:'cover'})` + `jpeg(…, {quality})` + `toBuffer()` 这一最常用、最稳定的链路：`fit:'cover'`、`quality`、`toBuffer()` 三个 API 在 0.35 的签名与语义不变。故**无需改动任何源码**，`tag-worker.ts` 一行未动。`typecheck`（sharp 自带 0.35 类型）零错误亦从静态侧印证调用签名兼容（§6.1）。

### 2.2 分发方式：`@img` 预编译平台包代换 install-script 本地编译

sharp 自 0.33 起彻底转为**按平台预编译二进制包**分发：主包 `sharp` 只含 JS 胶水层，真正的原生 libvips + 绑定通过 `optionalDependencies` 里的 `@img/sharp-<platform>`（运行时绑定）与 `@img/sharp-libvips-<platform>`（预编译 libvips）按当前平台**条件安装**。这取代了旧时代「安装时跑 install script + node-gyp 本地编译 libvips」的方式——安装更快、更稳，**不再依赖目标机的编译工具链**（gcc/make/python 等），也消除了本地编译在跨架构/精简基础镜像上常见的 GLIBC / node-gyp 失败面。

本版 lockfile 中 `@img/sharp-*` 运行时平台包**全部 0.35.4**、`@img/sharp-libvips-*` **全部 1.3.3**（旧版为 0.33.5 / 1.0.4–1.0.5）。0.35.4 的平台矩阵比 0.33.5 更宽，新增 `linux-ppc64`、`linux-riscv64`、`freebsd-wasm32`、`webcontainers-wasm32`、`win32-arm64` 等条目（连同对应 libvips 包），是 lockfile 行数不降反升的根因（§2.3）。任务点名的两架构落点已逐一核对：

| 架构 | 运行时绑定包 | 预编译 libvips 包 |
|---|---|---|
| linux/amd64 | `@img/sharp-linux-x64@0.35.4` | `@img/sharp-libvips-linux-x64@1.3.3` |
| linux/arm64 | `@img/sharp-linux-arm64@0.35.4` | `@img/sharp-libvips-linux-arm64@1.3.3` |

### 2.3 依赖树与 lockfile（实测 numstat）

`server/package-lock.json`：**+257 / −164（净 +93 行，2851 → 2944 行）**。净增来自 0.35.4 更宽的平台矩阵（新增 ppc64 / riscv64 / freebsd-wasm32 / webcontainers-wasm32 / win32-arm64 及对应 libvips 条目）；sharp 主包与全部 `@img/*` 条目的 `version` / `resolved` / `integrity` 随 0.33.5 → 0.35.4、1.0.4/1.0.5 → 1.3.3 整体刷新。lockfile 顶部 `version` 与 `packages[""].version` 两处同步为 `0.2.23`（L3 / L9，与 `package.json` 三者一致，已程序化校验）。

本机 `npm install`（在 darwin-arm64 上）实测结论：**added 4 / removed 6 / changed 3**，11s 完成，**无 UNMET（非 optional）/ 无 peer 冲突 / 无 GLIBC / 无 node-gyp 报错**。`npm ls --all` 里的 `UNMET OPTIONAL DEPENDENCY @img/sharp-linux-*` / `@esbuild/*` 等**全部是平台条件性可选依赖**（非本平台即不装，属正常形态，每个跨平台包如 esbuild 同样如此），真实 UNMET（非 optional）计数 = **0**、peer/invalid 计数 = **0**。`@emnapi/runtime` / `tslib` / `@img/sharp-wasm32` 等 `npm ls` 标 extraneous 的包均**确在 lockfile 内**（属 sharp 的 wasm/optional 子树，合法）。

### 2.4 运行时可用性

darwin-arm64 本机 `node -e "require('sharp').versions"` 自报 **`sharp 0.35.4 / libvips 8.18.6`**，`require('sharp')` 加载成功、无符号缺失（§6.3）。linux/amd64 + linux/arm64 两架构的 `docker buildx build` 与容器内 resize+jpeg 冒烟由**前序 #224 预演**验证 PASS（本机无 Docker，未复跑，见头部「双架构验证的归属」）。基础镜像 `node:22-bookworm`（glibc 2.36）满足 sharp 0.35.4 / libvips 8.18.6 的运行要求，**Dockerfile 无需改动**。

---

## 三、lockfile registry 归一（零内网 / 私有 registry 泄漏）

本机 npm 默认 registry 指向**内网镜像**（主机名不写入本文与 lockfile）。若以默认 registry 直接 `npm install`，新增的 sharp / `@img/*` 条目会把内网 URL 写进 `resolved` 字段——这既是内网信息泄漏，也会让公开仓库的 lockfile 在外部无法复现。故本次安装**显式指定公共镜像 registry**（`--registry https://registry.npmmirror.com`），与既有 lockfile 的归一约定对齐。

实测核对（`grep`/解析 lockfile 的 `resolved` 主机名分布）：

| 项 | 结果 |
|---|---|
| `registry.npmmirror.com`（公共镜像） | **202** 条（v0.2.22 为 200，本次净 +2） |
| `registry.npmjs.org`（公共官方） | **3** 条（`fast-uri` ×2、`fastify` ×1，v0.2.22 既有，本次未触及、原样保留） |
| **内网 `*.alibaba-inc.com`** | **0** 条（全文件 `grep -c` = 0） |
| 本次 diff **新增**行的 registry | 28 条全为 `npmmirror`，**0 条 alibaba-inc** |
| 本次 diff **删除**行的 registry | 26 条全为 `npmmirror` |

即：lockfile 的 `resolved` 主机名**只含公共 registry**，零内网 / 私有泄漏；新增 / 删除的 `resolved` 行全部落在 npmmirror 公共镜像，与既有 200 条同构。

---

## 四、版本承载点 bump 清单（0.2.22 → 0.2.23，8 文件 / 12 处）

以 `git grep -n "0\.2\.22"`（仅 tracked、排除历史 `CHANGELOG-0.2.2x.md`）的真实结果为权威，逐一判定「版本承载点」与「历史事件引用」，只 bump 前者：

| # | 文件 | 位置 | 内容 |
|---|---|---|---|
| 1 | `server/package.json` | L3 | `"version": "0.2.23"` |
| 2 | `server/package-lock.json` | L3 | 顶层 `"version": "0.2.23"` |
| 3 | `server/package-lock.json` | L9 | `packages[""].version` = `"0.2.23"`（npm 视角三者一致） |
| 4 | `fpk/manifest` | L2 | `version=0.2.23` |
| 5 | `fpk/manifest` | L25 | `changelog=` 整行改写为 0.2.23 内容（sharp 0.35.4 + libvips 8.18.6 + `@img` 平台包代换 install script + 双架构预演已验证运行时可用 + CHANGELOG-0.2.22 文档订正） |
| 6 | `server/src/routes/status.ts` | L15 | `/status` 响应的 `version: '0.2.23'` |
| 7 | `server/src/core/adapters/scrape-detail.ts` | L295 | MusicBrainz UA 串 `Rainbow/0.2.23 (…)` |
| 8 | `scripts/verify-image.sh` | L7 | 用法示例 `IMAGE=rainbow-music:v0.2.23` |
| 9 | `scripts/verify-image.sh` | L10 | 参数说明默认镜像 `rainbow-music:v0.2.23` |
| 10 | `scripts/verify-image.sh` | L33 | `IMAGE` 默认值 `rainbow-music:v0.2.23` |
| 11 | `API.md` | L1075 | `/status` 响应示例中的 `"version": "0.2.23"` |
| 12 | `docs/FNOS-DEPLOY.md` | L1 | 文档标题版本 `（v0.2.23）` |

**刻意保留 `0.2.22` 字样的均为历史事件引用**，语义上必须指向 v0.2.22 本身、bump 即篡改历史，故一律不动：`.github/workflows/build.yml`（「v0.2.22 移除 drizzle 死依赖」）、`scripts/verify-ci.sh`（isolation 段「v0.2.22 修正 ①②」等 5 处）、`docs/DEVELOPMENT.md` / `docs/SOURCES.md` / `config.example.yaml` / `server/src/core/config.ts` / `server/src/core/smoke/scheduler.ts` / `server/src/core/source-engine/source-health.ts`（「L1 聚合口径 v0.2.22 修正」「node-cron v4（v0.2.22 起）」等机制说明）、`server/test/source-health-l1.test.ts`（「v0.2.22 修复」复现测试注释）、`API.md` L1499/L1508（「v0.2.22 核对」「L1 从 v0.2.22 起不再把 head 计入健康」），以及历史文档 `docs/CHANGELOG-0.2.2x.md`。本文（`CHANGELOG-0.2.23.md`）与 `fpk/manifest` 新 changelog 里出现的 `CHANGELOG-0.2.22.md` 是**被订正的历史文件名引用**，同样保留。

---

## 五、CHANGELOG-0.2.22.md 文档订正（1129 → 1292）

`docs/CHANGELOG-0.2.22.md` 附录的散文段（L777）原写「**净减 1129 行**全部集中在 `server/package-lock.json`（+65 / −1357）」，其中 `1129` 是手写笔误。实测核实（两条独立路径，结论一致）：

1. **行数差**：`git show 8862cf0:server/package-lock.json | wc -l` = **4143**（v0.2.21），`git show b89e984:server/package-lock.json | wc -l` = **2851**（v0.2.22）；4143 − 2851 = **1292**。
2. **numstat**：`git diff --numstat 8862cf0 b89e984 -- server/package-lock.json` = **+65 / −1357**；65 − 1357 = **−1292**（净减 1292）。

故 `1129` → **`1292`**。同段其余散文数字（「除 lockfile 外 15 个 tracked 文件合计 +202 / −39」及其五项拆分）经逐一验算**全部自洽**（15 文件增行 5+48+1+39+1+2+2+65+3+3+1+1+8+22+1 = 202、删行 4+7+1+1+1+1+2+5+3+6+1+1+2+3+1 = 39；五块拆分 33+70+91+3+5 = 202、8+9+11+6+5 = 39），**无同类笔误**，未改。本订正只改行内数字、不改行数（`docs/CHANGELOG-0.2.22.md` 实测 **+1 / −1**）。

---

## 六、验证证据矩阵

### 6.1 本地门禁三项（全绿）

| 门禁 | 命令 | 结果 |
|---|---|---|
| 类型检查 | `cd server && npm run typecheck`（`tsc --noEmit`） | **EXIT=0，0 error**（sharp 0.35 自带类型，`tag-worker.ts` 调用签名兼容） |
| 单元测试 | `cd server && npm test`（`tsx --test`） | **tests 231 / suites 29 / pass 231 / fail 0 / skipped 0 / cancelled 0 / todo 0**（与 v0.2.22 的 231 持平：sharp 无专属测试，升级未增删用例） |
| 本地 CI 门禁 | `FNPACK_BIN=<repo>/tools/fnpack ./scripts/verify-ci.sh --skip-docker` | **rc=0，门禁结论 PASS（可发布）**：heal / meta / build / test / isolation / fpk 六段 PASS，docker 段 SKIP |

`isolation` 段细节：`SANDBOX_ELISION` 用 tsx 自带 esbuild 0.28.1 转译，**checked=11 / elided=0 / unverifiable=0**（11 个 import `fixtures/env-sandbox` 的测试文件，沙箱 import 在转译产物中全部保留）；`DB_CANARY` **PASS**（详见 §6.2）。`fpk` 段：fnpack 官方工具真构建出 `dist-fpk/rainbow-0.2.23.fpk`（112K，`.gitignore` 已排除、不入库），`TAG_CONSISTENCY_PASS`（compose image = `rainbow-music:v0.2.23`）、manifest version 校验 = `0.2.23`、`DOWNLOAD_MOUNT_PASS` / `WIZARD_FIELD_PASS` / `DDIR_CONVERGE_PASS` / `LIBRARY_SHARE_PASS`，`DIGEST_PIN_SKIP`（本地门禁正常形态，正式发布由 CI 注入 index digest）。

### 6.2 真机开发库零触碰

门禁全程（含 `npm test` 与完整 verify-ci 六段）仓库 `data/ro.db` 的 sha256 **恒定不变** = `027ff50ae34af782b2886fc510715ea9acea1c0cb4d020f47b796b508b96bd62`，无 `-wal` / `-shm` 新增——测试全部走沙箱（`RO_DB_DIR` 指向临时目录），未读写真机库。门禁跑完 `git status` 仍只有预期的 9 个 M 文件（`server/dist/`、`dist-fpk/` 均被 `.gitignore` 排除，未脏化任何 tracked 文件）。

### 6.3 sharp 运行时自检

darwin-arm64 本机：`require('./node_modules/sharp/package.json').version` = **0.35.4**；`require('sharp').versions` = **`{ sharp: '0.35.4', vips: '8.18.6' }`**；`npm ls sharp` = `rainbow-server@0.2.23 └── sharp@0.35.4`（依赖树解析正确，无 invalid）。

---

## 七、明确没有做的事

- **没有改动任何产品代码逻辑**：`server/src` 下仅两处**版本字符串常量**随 bump 更新（`status.ts` 的 `version`、`scrape-detail.ts` 的 MB UA 串）；sharp 唯一调用点 `tag-worker.ts` 一行未动，`resize`/`jpeg`/`toBuffer` 链路、下载队列、刮削、搜索、路由、DB 层全部未改。
- **没有改 Dockerfile**：基础镜像 `node:22-bookworm`（glibc 2.36）已满足 sharp 0.35.4 / libvips 8.18.6，无需改动。
- **没有放宽 / 删除任何断言**、没有跳过失败用例（无新增 `.skip`/`todo`）、没有改 CI workflow 让门禁失效；`npm test` 仍 231 全绿。
- **没有让内网 registry 泄漏进 lockfile**：显式用公共镜像安装，`resolved` 主机名 0 条 `alibaba-inc`（§三）。
- **没有 bump 历史事件引用**：`0.2.22` 作为「L1 修复 / drizzle 移除 / node-cron v4」等历史事实的版本锚点原样保留（§四），bump 它们会篡改历史。
- **没有 push、没有打 tag、没有触发 CI、没有 force、没有改 git config、没有删改任何已存在 tag**：本任务只到「单个本地 commit」为止；不碰 NAS，DB 迁移非破坏，凭据不明文落盘。
- 本版**不含**任何新功能、接口变更或数据结构变更。

---

## 八、已知盲区与遗留

1. **本机无 Docker，未在本地复跑 `docker buildx` 双架构构建**。linux/amd64 + linux/arm64 的构建与容器内 sharp 运行时冒烟依赖前序 #224 预演结论，并待正式发布 CI 的 docker job 复核；本地 `verify-ci --skip-docker` 的 docker 段记 SKIP，属已知形态。
2. **sharp 无专属单元 / 集成测试**。封面缩放链路的正确性由 `typecheck`（签名兼容）+ darwin-arm64 运行时 `require` 自检 + #224 双架构冒烟共同覆盖，仓库内没有一条针对 `tag-worker.ts` resize+jpeg 的自动化断言。若将来 sharp 再跨 major 升级，建议补一条「输入已知尺寸原图 → 断言输出为 `size×size` JPEG」的最小回归用例。
3. **`docs/FNOS-DEPLOY.md` 的「重装验证」前向声明**在 v0.2.22 已连续顺延四版且事实失效（见 `CHANGELOG-0.2.22.md` §八.7）；本版按「只做 sharp 升级 + 订正 + bump」的纪律**未处理**该遗留，仍建议在下一个真机窗口直接删除该声明而非继续顺延。
4. **`scrape-detail.ts` L295 的 MB UA 串括号内含空格**（`Rainbow/0.2.23 ( https://… )`）为 v0.2.21 既有形态，功能无碍（RFC 7231 comment 允许空格），本版按「只 bump 版本号」纪律仅改数字、未规整形态，留档待单独处置。
5. **lockfile 仍是 npmmirror + npmjs.org 混合**（202 + 3）。3 条 npmjs.org 是 `fast-uri`/`fastify` 的 v0.2.22 既有解析，本次未触及故原样保留；两者均为公共 registry、不构成泄漏，但「完全归一到单一公共 registry」尚未达成，属可选的后续清理。

---

## 附录：文件级 numstat（本版发布提交，基线 `b89e984`）

下表为 `git diff --numstat b89e984`（提交后等价于 `git diff --numstat origin/main..HEAD`）的逐项实测值（**10 项 = 9 M + 1 A**）。9 个 M 合计 **+269 / −176**，A 文件（本文）另计 **+184**。合计 **10 文件 = 9 M + 1 A，无 D（删除）/ 无 R（重命名）**——满足 `github-release-chain` 逐对象复刻对「纯新增 / 修改 blob」的前提（含删除 / 重命名会被全零 blob sha 守卫 ABORT）。

| 增 | 删 | 文件 | 状态 | 归属章节 |
|---:|---:|---|:--:|---|
| 257 | 164 | `server/package-lock.json` | M | §2.3 — sharp 0.33.5→0.35.4 依赖树（`@img` 平台包换代、矩阵更宽）+ §四 bump L3/L9 version |
| 2 | 2 | `server/package.json` | M | §一 — L32 `sharp: ^0.35.4`（+1/−1）+ §四 bump L3 version（+1/−1） |
| 1 | 1 | `server/src/routes/status.ts` | M | §四 — L15 `/status` 的 `version` |
| 1 | 1 | `server/src/core/adapters/scrape-detail.ts` | M | §四 — L295 MusicBrainz UA 串 |
| 2 | 2 | `fpk/manifest` | M | §四 — L2 `version=` + L25 `changelog=` 整行改写 |
| 3 | 3 | `scripts/verify-image.sh` | M | §四 — L7 / L10 / L33 默认镜像 tag |
| 1 | 1 | `API.md` | M | §四 — L1075 `/status` 响应示例 version |
| 1 | 1 | `docs/FNOS-DEPLOY.md` | M | §四 — L1 标题版本 |
| 1 | 1 | `docs/CHANGELOG-0.2.22.md` | M | §五 — L777 散文笔误订正 1129→1292 |
| 184 | 0 | `docs/CHANGELOG-0.2.23.md` | **A** | 本文（八节 + 附录） |
| **453** | **176** | **合计（10 文件 = 9 M + 1 A）** | | |

> **分块自检**：9 个 M 文件增行之和 `257+2+1+1+2+3+1+1+1 = 269`、删行之和 `164+2+1+1+2+3+1+1+1 = 176`，与 `git diff --numstat b89e984 -- <9 个 M 文件>` 实测逐位相符；本文（A）另计 `+184 / −0`。故合计增行 `269 + 184 = 453`、删行 `176`。
>
> **本文行数的自指说明**：上表 `docs/CHANGELOG-0.2.23.md` 一行的 `184` 即本文件写入完成后的实际总行数（`wc -l`）。因为回填只改行内数字、不改行数，`184` 为**不动点**，一次收敛。该数字由脚本在写盘后从 `wc -l` 与 `git diff --numstat` 实测回填，**不是手填**，避免自指失准。
>
> **M / A 分布核对**：`git diff --name-status -M b89e984`（提交后 `origin/main..HEAD`）输出应为 **10 行 = 9 `M` + 1 `A`**（0 行 `D`、0 行 `R`）。本版**不删除、不重命名任何文件**：sharp 是依赖升级（只改 `package.json` / `package-lock.json` 两个已跟踪文件），文档订正与 bump 均为行内修改，本文是唯一新增（A）文件，因此提交树内不存在任何删除或重命名——逐对象复刻前提成立。
