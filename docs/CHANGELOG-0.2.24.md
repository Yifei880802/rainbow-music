# 变更清单：v0.2.23 → v0.2.24

基线 `284e34a`（tag `v0.2.23` 指向的提交，= 当前 `origin/main`）→ **本版发布提交**（music-metadata 11.16.0 升级 + CI Node 20→22 + 文档订正/清理 + bump 0.2.24 + 本文）。本版是 v0.2.23 之后的**依赖维护 + 安全清零**版本，**不含任何产品逻辑改动**：① `music-metadata` 7.14.0 → **11.16.0**（连带传递依赖 `file-type` 16.5.4 → **21.3.4**），清除该链上的 **2 个生产环境安全漏洞**，`npm audit --omit=dev` 由 **2 → 0** ② CI `build.yml` 的 `node-version` **20 → 22**（build + test 两 job），与 `node:22-bookworm` 运行镜像对齐 ③ `server/package.json` 的 `engines.node` `>=20` → `>=22` ④ 文档订正与失效前向声明清理 ⑤ 版本承载点全量 bump 0.2.23 → 0.2.24。

> **本版是 5 个 DEFER major 依赖升级的最后一个，落地后生产依赖 DEFER 清单正式清空**（总销账见 §七）。`server/src` 下仅两处**版本字符串常量**随 bump 更新（`status.ts` 的 `version` 字段、`scrape-detail.ts` 的 MusicBrainz UA 串），music-metadata 的**全部真实调用点**（`download/index.ts` 的 `detectRealQuality`、`scanner-worker.ts` 的标签/封面解析）**一行未动**；`server/test` 仅**新增 1 条**封面写入路径回归用例（不改任何现有用例）。对用户而言应用可观测行为与 v0.2.23 等价；GHCR 镜像与 `.fpk` 会随 tag 重新构建并携带新版本号与新版 music-metadata。

> **本文是对外可读版本。** 仓库公开，因此不写 NAS 主机名、备份与证据树的具体落盘路径、凭据与内部运维细节——这些属于内部项目档案，不属于这里。技术结论与代码改动本身完整无删减。本机 npm registry 指向内网镜像这一事实需要说明（它直接决定 lockfile 归一的做法，见 §四），但**主机名不写入本文、也绝不写入 lockfile**。

> **发布状态**：版本承载点（**8 文件 / 12 处**，清单见 §五）已**全量 bump 至 0.2.24**；`npm run typecheck` **零错误**；`npm run build` tsc emit 成功、`dist` 为原生 ESM；`npm test` **232 / 232 pass、0 fail、0 skipped**（较 v0.2.23 的 231 净 +1，即本版新增的封面回归用例）；本地门禁 `FNPACK_BIN=<repo>/tools/fnpack scripts/verify-ci.sh --skip-docker` 结论 **PASS（可发布）、rc=0**——heal / meta / build / test / **isolation（SANDBOX_ELISION checked=11 / elided=0 / unverifiable=0 + DB_CANARY 真机 ro.db 字节未变）** / fpk 六段全绿，docker 段因 `--skip-docker` 记 SKIP（本机无 Docker，不影响结论）；fnpack 官方工具已真构建出 `rainbow-0.2.24.fpk`（112K），包级断言（TAG_CONSISTENCY / manifest version=0.2.24 / DOWNLOAD_MOUNT / WIZARD_FIELD / DDIR_CONVERGE / LIBRARY_SHARE）全 PASS，DIGEST_PIN 为本地门禁的正常形态 SKIP。
>
> **双架构验证的归属（审计诚实）**：`docker buildx build --platform linux/amd64,linux/arm64` 两架构构建 + 容器内运行时冒烟，本机无 Docker、**本次未复跑**（verify-ci 的 docker 段记 SKIP）。music-metadata 是**纯 JS 包（无原生编译）**， Unlike sharp 不存在跨架构原生二进制问题，故双架构风险面远低于 v0.2.23 的 sharp；linux 双架构的构建可用性待正式发布 CI 的 docker job 复核。本地亲自跑的是：`npm install` 干净解析（§2.2 / §四）、`typecheck` / `build` / `npm test` / `verify-ci.sh --skip-docker` 四项门禁（§八）、以及在 darwin-arm64 上用真实音频对 v7/v11 做的封面 sha256 与 bitrate 逐文件对比取证（§2.4 / §2.5）。
>
> **本版尚未 push、尚未打 tag、尚未触发 CI**——全部改动收拢为**一个本地 commit**（纯 M / A，无 D / R，满足 `github-release-chain` 逐对象复刻前提）；公开发布（REST 逐对象复刻 + annotated tag `v0.2.24`）另行派发，届时需用户显式确认 `repo + tag + commit` 三元组。

---

## 一、本版内容总览

| 块 | 目标 | 改动文件 | 性质 | 用户可见影响 |
|---|---|---|---|---|
| **music-metadata 升级** | `music-metadata` 7.14.0 → **11.16.0**（传递依赖 `file-type` 16.5.4 → **21.3.4** 等），清除该链 2 个 prod 漏洞，`npm audit --omit=dev` **2 → 0** | `server/package.json`（music-metadata 声明）、`server/package-lock.json`（依赖树刷新） | 依赖维护 + **安全** | **无**（全部调用点用法与 v7 兼容，封面字节逐字节相同，源码零改动） |
| **CI Node 对齐** | `build.yml` 的 `node-version` **20 → 22**（build + test 两 job），消除 `content-disposition@3.0.0` 的 EBADENGINE(>=22) 告警、与 `node:22-bookworm` 运行镜像对齐 | `.github/workflows/build.yml`（**+4 / −4**） | CI | **无**（仅 CI 运行时 Node 版本） |
| **engines 声明对齐** | `server/package.json` 的 `engines.node` `>=20` → `>=22`，与运行时镜像 + `content-disposition@3` 现实要求一致 | `server/package.json` | 声明 | **无** |
| **封面回归测试** | C1 describe 内新增 1 条：合成带 ID3v2.3 APIC 帧的最小 MP3，断言 v11 `picture[0].data` 为 `Uint8Array`、`writeFile` 落盘后 magic=`ffd8ff`（覆盖 Buffer→Uint8Array 唯一破坏点） | `server/test/download-hardening.test.ts`（**+58 / −0**） | 测试 | **无**（测试总数 231 → 232） |
| **文档订正/清理** | 删除 `docs/FNOS-DEPLOY.md` 中已连续顺延多版、事实失效的「重装验证推迟到 v0.2.21」前向声明（落实 `CHANGELOG-0.2.23.md` §八.3 建议） | `docs/FNOS-DEPLOY.md` | 文档 | **无** |
| **版本 bump** | 8 文件 12 处承载点 0.2.23 → 0.2.24（清单见 §五） | `fpk/manifest`、`status.ts`、`scrape-detail.ts`、`verify-image.sh`、`API.md`、`FNOS-DEPLOY.md`、`package.json`、`package-lock.json` | 版本 | 镜像 / 包 tag、`/status` 的 `version`、MusicBrainz UA |

> `server/package.json` 同文件承载「music-metadata 依赖升级 + engines.node + version bump」三类改动，行区间不重叠（依赖 L25 / engines L9 / version L3），单 commit 内共存、**只 bump 一次**。`docs/FNOS-DEPLOY.md` 同文件承载「标题 bump（L1）+ 失效声明删除（L371）」，故 numstat 为 **+2 / −2**。

---

## 二、music-metadata 7.14.0 → 11.16.0

### 2.1 触点与源码零改动

`grep -rn 'music-metadata\|parseFile\|\.picture' server/src server/test` 实测，music-metadata 在整个服务端的**真实调用点只有两处**（其余均为注释或 DB 列命名说明）：

| 调用点 | 代码 | 用途 |
|---|---|---|
| `src/core/download/index.ts` | L20 `import * as musicMetadata`；L645 `parseFile(filePath, { duration: false })` | C1：下载完成后读回真实码率/编码/采样率（`detectRealQuality`） |
| `src/core/library/scanner-worker.ts` | L30 `import * as musicMetadata`；L199 `parseFile(f.path, { duration: true })`；L202 `common.picture?.[0]`；L206 `writeFile(…, pic.data)` | 媒体库扫描：解析标签（title/artist/album/duration/format）+ 封面落缓存 |

测试侧 `test/download-hardening.test.ts` 的 C1 describe 有 **5 处** `await import('music-metadata')` + `parseFile`（合成最小 MP3 夹具）。**`tag-worker.ts` / `covers.ts` / `routes/cover.ts` 用的是 `flac-tagger` / `node-id3` / 手写 FLAC 解析，均不碰 music-metadata**（`grep music-metadata\|parseFile` 于这三个文件实测为空）。

music-metadata v7 → v11 跨越 4 个 major，其间 API 与 ESM/CJS 形态都有变化，但**本项目用到的 `parseFile(path, opts)` + `common.{title,artist,album,picture}` + `format.{bitrate,codec,sampleRate,bitsPerSample,duration}` 这一最常用子集，签名与语义在 v11 保持不变**。唯一的类型层变化是 `IPicture.data` 由 `Buffer` 变为 `Uint8Array`——而其**唯一消费者**是 `scanner-worker.ts:206` 的 `fs.promises.writeFile(…, pic.data)`，Node 的 `writeFile` 对 `Uint8Array`（`ArrayBufferView`）天然兼容，无需任何转换。故**升级本身源码零改动**：`git status` 实测 `server/src` 下只有 `status.ts` / `scrape-detail.ts` 两个文件因**版本号 bump**而修改（§五），无任何逻辑改动；`typecheck` 零错误从静态侧印证 v11 类型（含 `Uint8Array` 的 `picture.data`）与现有调用完全兼容。

> 项目**本就是原生 ESM**（`package.json` `type=module`、`tsconfig` `module`/`moduleResolution=NodeNext`、`target=ES2022`、`dist` 产物为原生 ESM），music-metadata v11 的 ESM-only 形态**不构成 `ERR_REQUIRE_ESM` 风险**——这是本版能「源码零改动」直接升级的前提。

### 2.2 传递依赖 delta（实测）

本机 `npm install --registry https://registry.npmmirror.com`（darwin-arm64）实测结论：**added 4 / removed 8 / changed 6**，<1s 完成，**无真实 UNMET（非 optional）/ 无 peer 冲突 / 无 GLIBC / 无 node-gyp 报错**（music-metadata 是纯 JS 包，无原生编译）。

| 类别 | 包 | v7 侧 | v11 侧 |
|---|---|---|---|
| **升级** | `music-metadata` | 7.14.0 | **11.16.0** |
| | `file-type` | 16.5.4 | **21.3.4** |
| | `strtok3` | 6.3.0 | **10.3.5** |
| | `token-types` | 4.2.1 | **6.1.2** |
| | `content-type` | 1.0.5 | **2.1.0** |
| | `media-typer` | 1.1.1 | **2.0.0** |
| **新增（4）** | `@borewit/text-codec` | — | 0.2.2 |
| | `@tokenizer/inflate` | — | 0.4.1 |
| | `uint8array-extras` | — | 1.5.0 |
| | `win-guid` | — | 0.2.1 |
| **移除（8）** | `abort-controller` / `event-target-shim` / `events` / `process` / `peek-readable` / `readable-web-to-node-stream` 等 | 存在 | **absent** |

上述升级/新增/移除的共享包经反查**仅被 music-metadata 链依赖**（`file-type` / `strtok3` / `token-types` / `content-type` / `media-typer` 在本项目无第二消费者），无爆炸半径。移除的 8 个多为 v7 时代为「在旧 Node 上 polyfill `AbortController`/`ReadableStream`」而引入的垫片，v11 直接依赖 Node 18+ 原生能力故不再需要——这也从侧面印证 v11 的 `engines.node` 下限（§2.6）。

### 2.3 安全收益：`npm audit --omit=dev` 2 → 0（本版核心价值）

升级前后 `npm audit --omit=dev`（官方 registry 审计端点）实测：

| | v0.2.23（music-metadata 7.14.0） | v0.2.24（music-metadata 11.16.0） |
|---|---|---|
| prod 漏洞总数 | **2** | **0** |
| 明细 | `music-metadata <=11.12.1` **high**（`GHSA-v6c2-xwv6-8xf7`，ASF 解析器死循环）<br>`file-type` **moderate**（`GHSA-5v7r-6r5c-r473`，ASF 零长子死循环） | 全部清除 |

`npm audit --omit=dev --json` 的 `metadata.vulnerabilities` 实测为 `{info:0, low:0, moderate:0, high:0, critical:0, total:0}`。这正是 `CHANGELOG-0.2.22.md` §七 记为「本版最大的已知安全遗留」的最后一项——`file-type` 的修复只能随 `music-metadata@11.16.0` 一起进来（传递依赖），故两项同批清零。

### 2.4 封面写入路径：sha256 与 v7 逐字节相同（128/128 实测）

`IPicture.data` 由 `Buffer`→`Uint8Array` 是 v7→v11 唯一的类型层破坏点，其唯一落地点是 `scanner-worker.ts:206` 的封面落盘 `writeFile`。为取证「落盘字节是否逐字节保真」，本版在 darwin-arm64 上对 `data/downloads` 的**全部 133 个真实音频**（只读，不改原文件）分别用 v7.14.0 与 v11.16.0 `parseFile` 取 `common.picture[0].data`，按 scanner-worker 原样 `writeFile` 落盘后读回算 sha256 对比：

| 指标 | 实测值 |
|---|---|
| 两版均解析出封面的文件 | **128** |
| sha256 **逐字节相同** | **128 / 128** |
| sha256 不同 | **0** |
| 仅 v7 有封面 / 仅 v11 有封面 | **0 / 0** |
| v7 `picture.data` 构造器 | `Buffer` |
| v11 `picture.data` 构造器 | **`Uint8Array`** |

即：**尽管 v11 的 `data` 类型由 `Buffer` 变为 `Uint8Array`，落盘后的封面字节与 v7 逐字节完全一致**（128 张真实封面 sha256 全等，无一例外、无单边缺失）。`fs.promises.writeFile` 对 `Uint8Array` 的兼容性得到真实数据验证。此结论另有仓库内**常驻回归用例**兜底（§一「封面回归测试」，测试总数 231→232）。

### 2.5 M4A `format.bitrate` 浮点末位差异（实测 + 不可观测论证）

对同一批 133 个真实音频逐文件对比 v7/v11 的 `format.bitrate`（`duration:false`），实测差异分布：

| 格式 | 文件数 | bitrate 有差异 | 最大相对差 |
|---|---|---|---|
| FLAC | 96 | **0** | 0 |
| MP3 | 36 | **0** | 0 |
| M4A | 1 | **1** | **1.024e-5** |

**差异仅出现在 M4A**（唯一样本 `晴天 - 吉拉朵.m4a`：v7 = `47792.67297324281`、v11 = `47792.183755990416`，绝对差 `0.489` bps、相对差 `1.024e-5`）；**FLAC / MP3 两版 bitrate 完全一致（相对差 0）**。该浮点末位差异源于 v11 对 MP4/M4A 容器 bitrate 的计算路径与 v7 略有不同（浮点舍入末位），**无任何功能或可观测影响**，论证如下（均经源码核实）：

1. **`bitrate` 的唯一消费链是纯展示**：`detectRealQuality`（`download/index.ts:647` `bitrate: mm.format.bitrate ?? null`）→ `realQuality.bitrate` → `queue.ts:487` 写入 DB 列 `actual_bitrate` → `queue.ts:133` 读出映射为 API 字段 `actualBitrate` → 经 SSE `task:completed` 推送前端。该链**不参与任何逻辑判断、决策、过滤或计算**，是纯展示字段。
2. **前端当前无消费者**：`grep -rn 'actualBitrate\|actual_bitrate' web/` 实测为空——仓库前端未渲染该字段，差异对用户完全不可见。
3. **DB 列为 INTEGER 亲和性**：`db/index.ts:246` `ALTER TABLE download_tasks ADD COLUMN actual_bitrate INTEGER`，落库即向整数收敛。
4. **扫描器路径完全不含 bitrate**：`scanner-worker.ts` 的 `MetaItemResult`（L213–223）字段为 `id/ok/title/artist/album/durationMs/format/hasCover`，**不含 bitrate**——媒体库扫描链路对该差异零暴露。
5. **差异幅度** `0.489` bps（相对 `1e-5`）远低于任何可感知/可显示阈值。

> **对预演论证的诚实修正**：前序预演曾以「下载器只产 mp3/flac，M4A 到不了该路径」论证 bitrate 差异不可达。本版亲自核实 `download/index.ts:128–133` 的 `guessFormat` **明确支持 `.m4a`**（`ext='m4a'`），且 `data/downloads` 内确有真实 M4A 样本——故「M4A 结构性不可达」**不成立**。本文改用上列**实测支撑且更强**的论证：差异仅限 M4A、bitrate 为纯展示字段、前端无消费者、DB INTEGER 收敛、扫描器不含 bitrate、幅度 1e-5——结论「无功能/可观测影响」不变，但依据更准确。

### 2.6 engines 订正：music-metadata v11 实为 `>=18`（非 `>=22`）

`node_modules/music-metadata/package.json` 实测 `engines.node = ">=18"`。此前口头/预演语境中「music-metadata v8+ 要求 Node≥22」的说法**与实测不符**：v11 的真实引擎下限是 **Node 18**。这也是本项目能在 `node:22-bookworm` 运行时（远高于 18）无障碍升级、且 music-metadata 升级**本身并不强制** CI 提到 Node 22 的原因——CI Node 20→22 的动因是 §三的镜像对齐与 `content-disposition@3` 告警消除，与 music-metadata 引擎要求无关。

> **文档订正核实结论**：任务要求订正 `docs/CHANGELOG-0.2.21.md`（约 §4.4）中「music-metadata v8+ 要求 Node≥22」的说法。经 `grep -n 'Node\|engines\|要求\|v8\|22' docs/CHANGELOG-0.2.21.md` 及全 `docs/` 检索实测，**该说法在 CHANGELOG-0.2.21.md 中并不存在**——§4.4（L268）对 music-metadata 的描述是「跨 4 个 major，7→11 之间 API 与 ESM/CJS 形态都有变化」，未涉及任何 Node 引擎版本要求。按「不制造虚假更正」的纪律，**不改动 CHANGELOG-0.2.21.md**，并将 `>=18` 的实测订正记录于本节。

---

## 三、CI `node-version` 20 → 22 + `engines.node` `>=22`

### 3.1 build.yml（+4 / −4）

`.github/workflows/build.yml` 两处 `actions/setup-node@v4` 的 `node-version: 20 → 22`（build job L80、test job L109），连同两处注释文案「Node 20」→「Node 22」（L67 build 段标题、L87 test 段说明）。改完实测：

- `grep -c 'node-version: 20' build.yml` = **0**（残留清零）；两处 `node-version` 均为 `22`。
- `setup-node` 仅出现在 build + test 两 job；其余 job（meta / docker / fpk / release）**不含 setup-node**，无需改。
- 全仓 `grep 'Node 20\|Node20' build.yml` = 空（文案无残留）。

**动因**：① 消除既有的 `content-disposition@3.0.0` EBADENGINE(要求 >=22) 告警——该依赖是 fastify 生态的传递依赖，Node 20 下 `npm install` 会打印 EBADENGINE 警告，Node 22 下清零；② 让 CI 与 `node:22-bookworm` 运行时镜像对齐，消除长期存在的「Node 20 CI vs Node 22 镜像」错配（CI 用 20 编译/测试、产物却跑在 22 上）。

### 3.2 Dockerfile 无需改动

`Dockerfile` 实测已是 `FROM node:22-bookworm AS builder`（L4）+ `FROM node:22-bookworm-slim AS runtime`（L33），运行时本就是 Node 22，本版 CI 提级正是**向运行时看齐**，Dockerfile 一行未动。

### 3.3 `engines.node` `>=20` → `>=22`

`server/package.json` 的 `engines.node` 由 `">=20"` 提到 `">=22"`，使**声明**与「`node:22` 运行时镜像 + `content-disposition@3` 要求 >=22」的**现实**对齐（此前声明 >=20 但实际依赖链已要求 22，属声明滞后）。此为低风险顺带项，不改变任何运行时行为。

---

## 四、lockfile registry 归一（零内网 / 私有 registry 泄漏）

本机 npm 默认 registry 指向**内网镜像**（主机名不写入本文与 lockfile）。若以默认 registry 直接 `npm install`，新增/刷新的 music-metadata 链条目会把内网 URL 写进 `resolved` 字段——既是内网信息泄漏，也让公开仓库的 lockfile 在外部无法复现。故本次安装**显式指定公共镜像 registry**（`--registry https://registry.npmmirror.com`），与既有 lockfile 归一约定对齐。

实测核对（`grep`/解析 lockfile 的 `resolved` 主机名分布）：

| 项 | v0.2.23 | v0.2.24 |
|---|---|---|
| `registry.npmmirror.com`（公共镜像） | 202 | **198**（music-metadata 链精简，净 −4） |
| `registry.npmjs.org`（公共官方） | 3（`fast-uri` ×2、`fastify` ×1） | **3**（同前，未触及、原样保留） |
| **内网 `*.alibaba-inc.com` / `anpm`** | 0 | **0**（`grep -c` = 0） |

`npm audit` 的审计端点 npmmirror 未实现（返回 `NOT_IMPLEMENTED`），故 §2.3 的 audit 用官方 registry 执行——audit 只依据依赖树、不依据 `resolved` 主机名，**不影响 lockfile 已归一到 npmmirror 的事实**。lockfile 顶层 `version`、`packages[""].version` 与 `package.json` 三者已程序化校验一致为 **0.2.24**（L3 / L9 / L3）；`JSON.parse` 合法，`packages` 计数 202。

---

## 五、版本承载点 bump 清单（0.2.23 → 0.2.24，8 文件 / 12 处）

以 `git grep -n "0\.2\.23"`（仅 tracked、排除历史 `CHANGELOG-0.2.2x.md`）的真实结果为权威，逐一判定「版本承载点」与「历史事件引用」，只 bump 前者：

| # | 文件 | 位置 | 内容 |
|---|---|---|---|
| 1 | `server/package.json` | L3 | `"version": "0.2.24"` |
| 2 | `server/package-lock.json` | L3 | 顶层 `"version": "0.2.24"` |
| 3 | `server/package-lock.json` | L9 | `packages[""].version": "0.2.24"` |
| 4 | `fpk/manifest` | L2 | `version=0.2.24` |
| 5 | `fpk/manifest` | L25 | `changelog=` 整行改写为 0.2.24 内容（music-metadata 升级 + 安全清零 + CI Node 对齐） |
| 6 | `server/src/routes/status.ts` | L15 | `/status` 响应的 `version: '0.2.24'` |
| 7 | `server/src/core/adapters/scrape-detail.ts` | L295 | MusicBrainz UA 串 `Rainbow/0.2.24 ( … )` |
| 8 | `scripts/verify-image.sh` | L7 | 用法示例注释 `IMAGE=rainbow-music:v0.2.24` |
| 9 | `scripts/verify-image.sh` | L10 | 参数说明注释「默认 `rainbow-music:v0.2.24`」 |
| 10 | `scripts/verify-image.sh` | L33 | `IMAGE="${1:-${IMAGE:-rainbow-music:v0.2.24}}"` |
| 11 | `API.md` | L1075 | `/status` 响应示例 `"version": "0.2.24"` |
| 12 | `docs/FNOS-DEPLOY.md` | L1 | 文档标题「Rainbow fnOS 部署指南（v0.2.24）」 |

bump 后 `git grep -n "0\.2\.23"`（排除历史 CHANGELOG）实测**残留 = 0**；历史 `CHANGELOG-0.2.2x.md` 内作为「历史事件版本锚点」的 `0.2.23` 一律**不动**（bump 它们会篡改历史）。`scrape-detail.ts` L295 的 MB UA 串括号内空格为 v0.2.21 既有形态，本版按「只 bump 版本号」纪律仅改数字、未规整形态（沿 `CHANGELOG-0.2.23.md` §八.4 先例）。

---

## 六、文档订正与遗留清理

### 6.1 `docs/FNOS-DEPLOY.md`：删除失效的「重装验证」前向声明

L371（#155 处置章）原文含「……不破坏安装优先于前向声明（本机无 Docker、**重装验证推迟到 v0.2.21**，无法实机确认未知键行为；且当前解析器已实证忽略该键，活跃声明零收益）」。该「重装验证推迟到 v0.2.21」是**已连续顺延多版、事实失效**的前向声明：`grep` 实测它在 `CHANGELOG-0.2.18/0.2.19/0.2.20/0.2.21.md` 中被逐版顺延记录（0.2.19→0.2.20→0.2.21），而 v0.2.21/0.2.22/0.2.23 均未兑现该「重装验证」；且同章 L366 已用「`trim_app_center` 的 manifest INI 解析键全集不含 tags/category」的**解析器实证**取代了「靠重装验证确认未知键行为」的需求——声明的验证前提已消失。

按 `CHANGELOG-0.2.23.md` §八.3「建议在下一个真机窗口直接删除该声明而非继续顺延」（前序 Kevin/Owen 同建议），本版**删除**「、重装验证推迟到 v0.2.21」这一失效子句，**保留**仍成立的依据（本机无 Docker 无法实机确认 / 解析器已实证忽略该键 / 活跃声明零收益）与 #155 的处置结论（仅以注释留档、不注入活跃未知键）。改动为行内精准删除（该文件 numstat **+2 / −2** 中的 L371 一处，另一处为 L1 标题 bump）。历史 CHANGELOG 内的顺延记录属历史事件引用，一律不动。

### 6.2 `docs/CHANGELOG-0.2.21.md`：核实后不改动

如 §2.6 所述，任务点名要订正的「music-metadata v8+ 要求 Node≥22」说法经 `grep` 实测**在 CHANGELOG-0.2.21.md 中不存在**，按「不制造虚假更正」纪律**不改动该文件**，`>=18` 的实测订正记录于本文 §2.6。

---

## 七、DEFER 清单总销账（5 个 major 全部落地，prod DEFER 清空）

`CHANGELOG-0.2.21.md` §4.4 因「v0.2.19 烧号教训」将 7 项 prod 漏洞归并为 **5 个升级动作**一律 DEFER（`isSemVerMajor=true`，不在维护版本里冒险）。经三个升级窗口逐个落地，至本版**全部销账**：

| # | DEFER 升级动作 | 落地版本 | 说明 |
|---|---|---|---|
| 1 | `drizzle-orm` | **v0.2.22** | 直接**移除**（改用 better-sqlite3 原生），非升级 |
| 2 | `@fastify/static` | **v0.2.22** | major 升级落地 |
| 3 | `node-cron`（带 `uuid`） | **v0.2.22** | major 升级落地（传递依赖 uuid 随之） |
| 4 | `sharp` | **v0.2.23** | 0.33.5 → 0.35.4，原生模块双架构 buildx 预演验证 |
| 5 | `music-metadata`（带 `file-type`） | **v0.2.24（本版）** | 7.14.0 → 11.16.0，跨 4 major，源码零改动 |

**至此生产依赖 DEFER 清单正式清空**：`npm audit --omit=dev` = **0**，无任何在册的 prod 依赖 major 升级待办。这是自 v0.2.21 立下「单开升级窗口逐个做」纪律以来，跨 v0.2.22 / v0.2.23 / v0.2.24 三版完成的收官。dev 侧的 `esbuild`（经 `drizzle-kit`）在 v0.2.21 已论证「本项目当一次性转译器用、不起 dev server，CORS 漏洞不可利用」，且 drizzle 已于 v0.2.22 移除，该 dev 项亦随之消解。

---

## 八、门禁结论（四项全绿）

本机 darwin-arm64、Node v23.10.0、npm 10.9.2 实测：

| 门禁 | 命令 | 结果 |
|---|---|---|
| ① typecheck | `cd server && npm run typecheck`（`tsc --noEmit`） | **0 error**（含新增封面测试用例的类型检查） |
| ② build | `npm run build`（`tsc -p tsconfig.json`） | emit 成功；`dist/index.js` 为**原生 ESM**（`import fs from 'node:fs'` …） |
| ③ test | `npm test`（`tsx --test test/*.test.ts`） | **232 / 232 pass、0 fail、0 cancelled、0 skipped、0 todo**（基线 231 → 232，净 +1 = 本版封面回归用例） |
| ④ verify-ci | `FNPACK_BIN=<repo>/tools/fnpack ./scripts/verify-ci.sh --skip-docker` | **PASS（可发布）、rc=0** |

verify-ci 分段实测：**heal PASS / meta PASS / build PASS / test PASS（232 pass）/ isolation PASS / docker SKIP（--skip-docker）/ fpk PASS**。

- **isolation 段**：`SANDBOX_ELISION` 用 esbuild 0.28.1 转译 11 个沙箱测试文件，**checked=11 / elided=0 / unverifiable=0**（全部保留 env-sandbox import）；`DB_CANARY_PASS`——test 段跑完后真机 `data/ro.db` 字节未变（sha256 = `027ff50ae34af782b2886fc510715ea9acea1c0cb4d020f47b796b508b96bd62`），无 `-wal`/`-shm` 新增。
- **fpk 段**：fnpack 官方工具真构建出 `dist-fpk/rainbow-0.2.24.fpk`（112K），二次解包校验——`TAG_CONSISTENCY_PASS`（compose image = `rainbow-music:v0.2.24`）、`manifest version` 校验通过（0.2.24）、`DOWNLOAD_MOUNT_PASS` / `WIZARD_FIELD_PASS` / `DDIR_CONVERGE_PASS` / `LIBRARY_SHARE_PASS` 全 PASS、`DIGEST_PIN_SKIP`（未提供 FPK_IMAGE_DIGEST，本地门禁正常形态，正式发布由 CI 注入）。
- verify-ci 产物 `server/dist/` 与 `dist-fpk/` 均被 `.gitignore` 覆盖（L3 / L24），**不进入 commit**。

---

## 九、已知盲区与遗留

1. **本机无 Docker，未在本地复跑 `docker buildx` 双架构构建**。music-metadata 是纯 JS 包（无原生编译），双架构风险面远低于 v0.2.23 的 sharp；linux/amd64 + arm64 的构建可用性待正式发布 CI 的 docker job 复核，本地 `verify-ci --skip-docker` 的 docker 段记 SKIP，属已知形态。
2. **封面回归用例基于合成最小夹具**（带 ID3v2.3 APIC 帧的 1307 字节 MP3），断言 `data instanceof Uint8Array` + `writeFile` 落盘 magic=`ffd8ff` + 字节守恒。它覆盖的是 Buffer→Uint8Array 的类型/落盘兼容性；真实多格式封面的逐字节保真另由 §2.4 的 128/128 真实样本 sha256 对比取证（该对比是本次一次性取证脚本，未固化为常驻用例，因需引入 v7 对照依赖与大体积二进制夹具，按「保持最小、不阻断发布」纪律不纳入测试套件）。
3. **M4A `format.bitrate` 浮点末位差异**（§2.5，相对 1e-5）为 v11 的 MP4 容器计算路径差异，经论证无功能/可观测影响（纯展示字段、前端无消费者、DB INTEGER 收敛、扫描器不含 bitrate）。若将来前端开始渲染 `actualBitrate`，建议显示层对 bps 取整，彻底屏蔽该末位差异。
4. **lockfile 仍是 npmmirror + npmjs.org 混合**（198 + 3）。3 条 npmjs.org 是 `fast-uri`/`fastify` 的既有解析，本次未触及故原样保留；两者均为公共 registry、不构成泄漏，「完全归一到单一公共 registry」属可选的后续清理。
5. **`scrape-detail.ts` L295 的 MB UA 串括号内含空格**为 v0.2.21 既有形态，功能无碍（RFC 7231 comment 允许空格），本版仅 bump 数字未规整，留档待单独处置。
6. 本版**不含**任何新功能、接口变更或数据结构变更；DB 无迁移（`actual_bitrate` 等列为 v0.2.21 既有，本版未触碰 schema）。

---

## 附录：文件级 numstat（本版发布提交，基线 `284e34a`）

下表为 `git diff --numstat 284e34a`（提交后等价于 `git diff --numstat origin/main..HEAD`）的逐项实测值（**11 项 = 10 M + 1 A**）。10 个 M 合计 **+177 / −168**，A 文件（本文）另计 **+267 / −0**。合计 **11 文件 = 10 M + 1 A，无 D（删除）/ 无 R（重命名）**——满足 `github-release-chain` 逐对象复刻对「纯新增 / 修改 blob」的前提（含删除 / 重命名会被全零 blob sha 守卫 ABORT）。

| 增 | 删 | 文件 | 状态 | 归属章节 |
|---:|---:|---|:--:|---|
| 102 | 151 | `server/package-lock.json` | M | §2.2 — music-metadata 7→11 依赖树刷新（链精简净 −49）+ §五 bump L3/L9 version |
| 58 | 0 | `server/test/download-hardening.test.ts` | M | §一 — C1 describe 新增封面写入路径回归用例（纯新增，不改现有用例） |
| 4 | 4 | `.github/workflows/build.yml` | M | §3.1 — build/test 两 job `node-version` 20→22 + 两处注释文案 |
| 3 | 3 | `server/package.json` | M | §2.2 music-metadata 声明 + §3.3 engines.node >=22 + §五 bump L3 version |
| 3 | 3 | `scripts/verify-image.sh` | M | §五 — L7 / L10 / L33 默认镜像 tag |
| 2 | 2 | `fpk/manifest` | M | §五 — L2 `version=` + L25 `changelog=` 整行改写 |
| 2 | 2 | `docs/FNOS-DEPLOY.md` | M | §五 L1 标题 bump + §6.1 L371 失效前向声明删除 |
| 1 | 1 | `server/src/routes/status.ts` | M | §五 — L15 `/status` 的 `version` |
| 1 | 1 | `server/src/core/adapters/scrape-detail.ts` | M | §五 — L295 MusicBrainz UA 串 |
| 1 | 1 | `API.md` | M | §五 — L1075 `/status` 响应示例 version |
| 267 | 0 | `docs/CHANGELOG-0.2.24.md` | **A** | 本文（九节 + 附录） |
| **444** | **168** | **合计（11 文件 = 10 M + 1 A）** | | |

> **分块自检**：10 个 M 文件增行之和 `102+58+4+3+3+2+2+1+1+1 = 177`、删行之和 `151+0+4+3+3+2+2+1+1+1 = 168`，与 `git diff --numstat 284e34a -- <10 个 M 文件>` 实测逐位相符；本文（A）另计 `+267 / −0`。
>
> **本文行数的自指说明**：上表 `docs/CHANGELOG-0.2.24.md` 一行的 `267` 即本文件写入完成后的实际总行数（`wc -l`）。因为回填只改行内数字、不改行数，`267` 为**不动点**，一次收敛。该数字与合计 `444`（= `177 + 267`）由写盘后从 `wc -l` 与 `git diff --numstat` 实测回填，**不是手填**，避免自指失准。
>
> **M / A 分布核对**：`git diff --name-status -M 284e34a`（提交后 `origin/main..HEAD`）输出应为 **11 行 = 10 `M` + 1 `A`**（0 行 `D`、0 行 `R`）。本版**不删除、不重命名任何文件**：music-metadata 是依赖升级（只改 `package.json` / `package-lock.json`），封面测试是行内新增，文档订正与 bump 均为行内修改，本文是唯一新增（A）文件——逐对象复刻前提成立。
