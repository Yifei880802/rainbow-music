# 变更清单：v0.2.19 → v0.2.20

基线 `4866018`（tag `v0.2.19` 指向的提交）→ **本版发布提交**（bump 0.2.20 + 测试隔离缺陷修复 + 门禁新增 `isolation` 护栏段 + 本文）。tag `v0.2.19` 触发的 CI 在**单元测试门禁**失败（一个测试文件的沙箱 import 在编译期被整行 elide，详见 §二），已按 **fix-forward** 处置：`v0.2.19` 作为「已复刻至远端 `main`、CI 失败、零产物」的诚实烧号留档，**不删除、不重指**，改由 **`v0.2.20`** 承载本次发布。

> **本版为发布通道修复（test-only + 门禁）**：不含任何 `server/src` 应用功能逻辑改动——服务端音乐应用的行为、接口契约与曲库逻辑与 **v0.2.19 的预期内容完全一致**（v0.2.19 的全部功能改动已在 `4866018` 中，且已在远端 `main` 上）。本发布提交只改四类文件：① 测试文件（`server/test/download-196-fix.test.ts`）② 门禁脚本（`scripts/verify-ci.sh`）③ 版本承载常量（`status.ts` / `scrape-detail.ts` 的版本字符串等，不改变运行时行为）④ 本文与部署文档的版本号。因此对用户而言 **v0.2.20 ≡ v0.2.19 的预期功能内容**；GHCR 镜像与 `.fpk` 会随 tag 重新构建并携带新版本号，应用可观测行为与 `4866018` 等价。

> **本文是对外可读版本。** 仓库公开，因此不写 NAS 主机名、备份与证据树的具体落盘
> 路径、凭据与内部运维细节——这些属于内部项目档案，不属于这里。技术结论与代码改
> 动本身完整无删减。

> **发布状态**：版本承载点（**8 文件 / 12 处**，清单见 §五）已**全量 bump 至 0.2.20**；
> 本地门禁 `scripts/verify-ci.sh --skip-docker` 结论 **PASS（可发布）**——heal / meta /
> build / test（`npm test` **222 / 222 pass、0 fail**）/ **isolation（本版新增段）** /
> fpk 六段全绿，docker 段因 `--skip-docker` 记 SKIP（不影响结论）；fnpack 官方工具已
> 真构建出 `rainbow-0.2.20.fpk`，包级断言（TAG_CONSISTENCY / DOWNLOAD_MOUNT /
> WIZARD_FIELD / DDIR_CONVERGE / LIBRARY_SHARE）全 PASS，DIGEST_PIN 为本地门禁的正常
> 形态 SKIP（正式发布由 CI 注入 index digest）。
>
> **fix-forward 说明（审计诚实）**：本批最初以 `v0.2.19` 发布——提交 `4866018` 经
> `github-release-chain` 的 REST 通道逐对象复刻至远端 `main`（tree hash 与本地逐字符
> 一致）并创建 annotated tag `v0.2.19`（tag object `7fb6652`）触发 `build.yml`；该 run
> （`35726769721`，attempt=1）在**单元测试 job** 失败（conclusion=failure，
> docker / fpk / release 三 job 全部 skipped，**零产物泄漏**）。按 fix-forward：
> `v0.2.19` tag **不删除、不重指**，作为诚实烧号留档（§一）；测试隔离修复 + 门禁护栏
> 连同版本 bump 0.2.20 提交入 `main`，另打 annotated tag **`v0.2.20`** 重新触发
> `build.yml`（`on.push.tags: v*`）。v0.2.20 的 CI 产物终态以发布执行的 `ci-poll` 与
> Release 页为准。

---

## 一、v0.2.19 烧号留档（不删除、不重指）

### 1.1 发布事实（已完成的部分）

| 项 | 结果 |
|---|---|
| 远端 `main` | `4866018`（REST 逐对象复刻；**tree hash 与本地逐字符一致** = `0ef51c1…`） |
| annotated tag `v0.2.19` | tag object `7fb66524aae642fb805028f4afd529d00c85e54f` → target `4866018` |
| 触发的 CI run | `35726769721`，attempt=1，conclusion=**failure** |
| 单元测试 job | **FAIL**（`tests 219 / suites 28 / pass 210 / fail 1 / skipped 8`） |
| docker / fpk / release job | 全部 **skipped**（依赖链上游失败） |

复刻通道与 SHA 守卫本身**全程无异常**：blob / tree / commit / ref / tag 五步返回的 sha 均与本地对应 git 对象逐字符相等，`main` 为 fast-forward 前移、**未 force**。失败发生在 CI 侧，不在发布通道侧。

### 1.2 零产物确认（烧号无残留）

| 产物 | v0.2.19 | 对照 v0.2.18 |
|---|---|---|
| GitHub Release | **404（不存在）** | 存在，1 个 `.fpk` 资产 |
| GHCR 镜像 manifest | **404 `MANIFEST_UNKNOWN`** | 200，双架构 `amd64` + `arm64` |
| `.fpk` 包 | **无** | 有 |

即：**没有任何带 v0.2.19 标记的可安装产物进入公开分发面**。用户不可能装到 v0.2.19，因此本次烧号对用户零影响——这是「不删除 tag、诚实留档」得以成立的前提。

### 1.3 处置决定

沿用 v0.2.17 的既有先例（见 `CHANGELOG-0.2.18.md` 头部与 §3.4）：**tag 保留、不 force 重指、不删远端任何对象**，把失败与其根因完整记录在案，改由下一个版本号承载发布。`v0.2.17` 与 `v0.2.19` 因此成为本项目两个同构的烧号：tag 在、Release 404、docker/fpk/release 全 skipped。

> **两次烧号的类别不同**（这点很重要，说明门禁在拦不同类型的病）：`v0.2.17` 是**测试脚手架对平台 tmpdir 的错误假设**（macOS `/var→/private/var` 符号链接 vs Linux `/tmp` 真实目录）；`v0.2.19` 是**编译期 import elision 导致沙箱根本未加载**（§二）。前者是「跨平台语义差异」，后者是「转译器把未使用的 import 删掉」，二者无共同根因，也不是同一处修复的回归。

---

## 二、根因：未使用的具名 import 被 elide → 测试沙箱整体失效

### 2.1 缺陷代码

`server/test/download-196-fix.test.ts` 的首个 import 曾写作：

```ts
import { SANDBOX_ROOT } from './fixtures/env-sandbox.js'   // SANDBOX_ROOT 全文件从未被使用
```

`test/fixtures/env-sandbox.ts` 是**靠副作用工作**的：它在模块求值时 `mkdtempSync` 建临时沙箱，并设置 `RO_CONFIG` / `RO_DB_DIR` / `RO_LOG_LEVEL=silent` 三个环境变量，退出时清理。测试文件必须**真的执行到它**，沙箱才存在。

TypeScript 语义下「未使用的具名 import」可能只是类型，因此 **esbuild / tsx 在转译时会把整条 import 语句删掉**（import elision）。删除后 `env-sandbox` 永不求值 → 三个环境变量全部未设 → `initDb()` 走 fallback 分支：

```ts
process.env.RO_DB_DIR ? path.resolve(process.env.RO_DB_DIR) : path.join(ROOT_DIR, 'data')
```

于是测试**打开并读写了仓库真机 `data/ro.db`**。

### 2.2 六步证据链

1. **静态**：`SANDBOX_ROOT` 在该文件中只出现 1 次 —— 就是 import 语句自身，无任何使用点。
2. **编译期铁证**：`esbuild --format=esm test/download-196-fix.test.ts` 的转译产物中，**首行直接是 `import { test, describe, … } from "node:test"`，env-sandbox 那条 import 整行消失**；对照组 `download-m1.test.ts`（裸副作用 import `import './fixtures/env-sandbox.js'`）的转译产物中该行**完整保留**。
3. **运行期旁证**：本地跑该文件时 stdout 出现 `SQLite ready at <仓库>/data/ro.db` —— 真机库路径，且 pino 未被 `silent` 抑制（证明 `RO_LOG_LEVEL` 也没设上）。
4. **全量扫描**：对 `server/test/*.test.ts` 共 10 个文件逐一转译比对，**仅此 1 个被 elide**，其余 9 个的沙箱 import 均保留 → 孤例，非系统性问题。
5. **数据面**：本地真机 `data/ro.db` 有 **141 条真实任务**；CI runner 上 `data/*.db` 被 `.gitignore` 排除，库是**空的**。
6. **失败机理**：该文件内 suite1 的 `after()` 会把自己插入的 78 行**硬删**（`DELETE`）；node:test 同文件内 top-level suite 顺序执行，故 suite1 的 `after()` 必在 suite2 之前跑完。空库 + 78 行被删 → suite2 看到的 `counts()` 汇总 `total = 0`。

### 2.3 为什么本地假绿、CI 真败

suite2 的断言是 `assert.ok(total > 0, 'total should be > 0 (DB has tasks)')` —— 注释里那句 **"DB has tasks" 就是对外部既有数据的隐式依赖**。

| 环境 | 库内容 | `total > 0` | 结论 |
|---|---|---|---|
| 本地 macOS | 真机 141 条真实任务 | 成立 | **假绿**（缺陷被真实数据掩盖，且顺带污染了开发库） |
| CI Linux runner | 空库，且 suite1 已删净自己那 78 行 | 不成立 | **真败**（`ERR_ASSERTION`，expected true / actual false） |

同一份代码、同一条断言，只因**库里有没有别人的数据**而结论相反——这正是「测试未隔离」的教科书症状。

### 2.4 非产品缺陷

被测的 `queue.counts()` 行为**完全正确**：它按状态精确计数，并把 `completed_with_warnings` 并入 `completed`；`queue.list()` 的默认 `limit=50` 也符合契约。失败纯粹是**测试脚手架**问题：沙箱未加载 + 断言依赖外部数据。修复不涉及任何产品逻辑。

---

## 三、修复（test-only，`server/test/download-196-fix.test.ts`）

### 3.1 a) 沙箱 import 改为裸副作用形式

```ts
import './fixtures/env-sandbox.js'      // 与 download-m1.test.ts 一致；裸副作用 import 永不被 elide
```

并在文件头补了 ⚠️ 注释块，写明「为什么必须裸副作用形式」「写成未使用的具名 import 会怎样」，把这次的教训固化在离缺陷最近的地方。

### 3.2 b) `#196-fix2: /tasks 响应含 total` suite 改为完全自足

| 维度 | 修复前 | 修复后 |
|---|---|---|
| 数据来源 | 隐式依赖「库里已有任务」 | 自己的 `before()` 插入 **61 条** fixture，`after()` 逐条清理 |
| 状态覆盖 | 无 | 覆盖全部 **6 个** `TaskStatus` 取值：pending 12 / active 8 / completed 20 / completed_with_warnings 6 / failed 10 / canceled 5 |
| 断言强度 | `total > 0`（空库即假失败，脏库即假通过） | **精确等值**：五个状态字段逐一 `assert.equal`；`completed === 20 + 6`（显式验证 `completed_with_warnings` 的合并语义）；`total === 61` |
| 分页断言 | `total >= tasks.length`（库里只有几条时**恒真**，是空断言） | fixture 总量刻意 **> 默认 limit 50**，故 `list().length === 50` 且 `total(61) > 50` 才成立 —— 「`counts()` 不受分页上限截断」成为**被真正验证过**的结论 |
| 用例数 | 2 | 4 |

### 3.3 新增「沙箱前置守卫」用例

在文件所有 suite 之前插入一个顶层 `test`，直接断言沙箱**确实生效**：`RO_DB_DIR` 已设且含 `env-sandbox` 的 `mkdtemp` 前缀 `rb-test-`、`RO_CONFIG` 已设、`RO_LOG_LEVEL === 'silent'`。断言消息里写明了失败时的根因与修法。

价值：一旦首行沙箱 import 再次被 elide，**这个用例第一个失败并直接说明根因**，不必再从 `total = 0` 这类间接症状反推一整条证据链（本次定位花了 6 步）。

---

## 四、门禁新增 `isolation` 段（`scripts/verify-ci.sh`，防回归护栏）

作业链由 `heal → meta → build → test → docker → fpk` 变为
**`heal → meta → build → test → isolation → docker → fpk`**。

该段与 workflow 无对应 job，是**本地门禁独有的前移防线**，用编译期 + 运行期两类互不重叠的证据把「沙箱失效」机械化拦住。返回码沿用既有约定（`0=PASS / 1=FAIL / 2=SKIP`）。

### 4.1 ① `SANDBOX_ELISION`：编译期证据

遍历 `server/test/*.test.ts`，**只挑源文件里真的 import 了 `fixtures/env-sandbox` 的**（并非所有测试都用沙箱，这是不误红的关键），对每个跑 `esbuild --format=esm` 转译，断言转译产物中该 import 行**仍然存在**。

源文件判定与产物判定使用**同一个正则模式** `^[[:space:]]*import[[:space:]].*fixtures/env-sandbox` —— 「源里怎么写的，转译后就该还在」，语义自洽，且不依赖 esbuild 的注释处理行为。

失败时输出后果链与具体修法（改回裸副作用 import），可直接照做。

### 4.2 ② `DB_CANARY`：运行期证据

在 **test 段之前**对仓库真机 `data/ro.db` 打 sha256 基线快照（`isolation_snapshot`，恒定返回 0，快照失败只降级不中断门禁），test 段跑完后比对：

- 原本存在 → sha256 必须**逐字符不变**；
- 原本不存在 → 跑后**不得被创建**（被创建即 FAIL）；原本存在 → 跑后**不得消失**；
- 不得**新增** `ro.db-wal` / `ro.db-shm`（即使本体字节未变，新增 sidecar 也说明有连接开到了真机库）。

sha256 工具 GNU `sha256sum` / BSD `shasum` 双兼容（CI 是 Linux、本地是 macOS）。

### 4.3 防误红设计（三条降级路径）

| 情形 | 行为 |
|---|---|
| `server/node_modules/.bin/esbuild` 不可执行（未 `npm ci`） | `SANDBOX_ELISION_SKIP` |
| esbuild 对某文件转译失败（给不出结论） | 该文件记 `ISOLATION_UNVERIFIABLE`，不计 FAIL（语法问题由 test 段的 tsx 另行暴露） |
| 有进程正持有 `data/ro.db`（开发者本地跑着服务，库会被合法写入） | `DB_CANARY_SKIP`，用 `lsof -t` 精确检出持有者 pid |
| 系统既无 `sha256sum` 也无 `shasum` | `DB_CANARY_SKIP` |
| `--skip-test` 已指定 | `DB_CANARY_SKIP`（test 未跑，比对无意义） |

`isolation` 段**不提供跳过开关**：它秒级完成、无外部服务依赖，没有正当的跳过理由；依赖缺失时自动降级 SKIP，既不阻塞也不误红。

### 4.4 护栏自证（四用例，全部符合预期）

护栏本身若不能抓出真缺陷，就只是装饰。用临时构造的假仓库树做反向注入（**零风险，不改动仓库任何文件**）：

| 用例 | 注入内容 | `SANDBOX_ELISION` | `DB_CANARY` | 段 RC |
|---|---|---|---|---|
| ① 反向注入 elide | 造 `bad.test.ts` 用**未使用的具名 import**（= v0.2.19 的缺陷写法），另置 `good.test.ts`（裸副作用）与 `plain.test.ts`（不用沙箱） | **FAIL —— 精确点名 `bad.test.ts`**；`good` 放行；`plain` 未被检查（`checked=2`） | PASS | **1** |
| ② 反向注入污染 | 假仓库只放正确写法，模拟 test 段**改动** `data/ro.db` | PASS | **FAIL —— 打印跑前/跑后两个 sha256** | **1** |
| ③ 正向真跑 | 真仓库 + 真跑 `download-196-fix.test.ts` | PASS（**10 / 10** 全保留） | PASS（真机库 sha 未变、无 sidecar） | **0** |
| ④ 库被占用 | 后台进程持有 `data/ro.db` 的 fd | PASS | **SKIP（降级，检出 pid）** | **0** |

即：**能抓出**（①②）、**不误红**（③④）。

---

## 五、版本承载点 bump 清单（0.2.19 → 0.2.20，8 文件 / 12 处）

| 文件 | 位置 | 内容 |
|---|---|---|
| `fpk/manifest` | L2 | `version=0.2.20` |
| `server/package.json` | L3 | `"version": "0.2.20"` |
| `server/package-lock.json` | L3 / L9 | 顶层 `version` 与 `packages[""].version` 同步（npm 视角三者一致，已程序化校验） |
| `server/src/routes/status.ts` | L15 | `/status` 响应的 `version` 字段 |
| `server/src/core/adapters/scrape-detail.ts` | L295 | MusicBrainz UA 串 `Rainbow/0.2.20 (…)` |
| `scripts/verify-image.sh` | L7 / L10 / L33 | 默认镜像 tag `rainbow-music:v0.2.20`（注释两处 + `IMAGE` 默认值） |
| `API.md` | L678 | `/status` 响应示例中的 `version` |
| `docs/FNOS-DEPLOY.md` | L1 / L371 | 文档标题版本；「重装验证推迟到 v0.2.20」的前向声明（v0.2.19 因 CI 失败未产出 `.fpk`，实机重装验证顺延至本版） |

**刻意保留 `0.2.19` 字样**的 5 处均为**历史事件引用**，指向失败版本本身，语义上必须是 v0.2.19：`scripts/verify-ci.sh` 的 isolation 段注释与 `DB_CANARY_FAIL` 文案（3 处）、`server/test/download-196-fix.test.ts` 的文件头注释与守卫断言消息（2 处）。`docs/CHANGELOG-0.2.19.md` 为历史文档，同样不 bump。

---

## 六、验证证据矩阵

### 6.1 干净库复现（本版不再 CI 失败的核心证据）

用 `RO_DB_DIR` 指向**空的临时目录**忠实模拟 CI runner 的干净库条件（不动真机 `data/ro.db`），单独跑 `download-196-fix.test.ts`：

| | 场景 A：自然本地（真机库 141 条） | 场景 B：干净库（空目录） |
|---|---|---|
| **修前** | exit=0，**9 pass / 0 fail**；stdout 泄露 `SQLite ready at <仓库>/data/ro.db` → **假绿**，且真机库 sha 被改写 | exit=1，**8 pass / 1 fail**；`error: 'total should be > 0 (DB has tasks)'` → **逐字复现 CI run `35726769721`** |
| **修后** | exit=0，**12 pass / 0 fail**；`SQLite ready` 输出消失（`RO_LOG_LEVEL=silent` 生效 = 沙箱已接管） | exit=0，**12 pass / 0 fail**；外部注入的空目录**跑完仍完全为空**（env-sandbox 覆盖之，测试走沙箱） |

结论：**同一份缺陷代码在空库上必败、修复后在空库上必过**——CI 的失败条件已被消除，而非被掩盖。

### 6.2 真机开发库零触碰

修复后，无论是单跑该文件、跑全量 `npm test`（222 用例）、还是跑完整门禁六段，仓库 `data/ro.db` 的 sha256 **恒定不变**，且无 `-wal` / `-shm` 新增。修前同一操作会改写该文件（缺陷测试向真机库插入 78 行合成数据再硬删，导致 SQLite 页回收、字节变化）。

修复过程中的真机库完整性已核验：任务总数 141 条不变、状态分布不变、`test-196-*` 合成数据残留 **0** 条、`PRAGMA integrity_check = ok` —— **无数据损坏**。

### 6.3 全量套件与门禁

- `cd server && npm test`：**tests 222 / suites 28 / pass 222 / fail 0 / skipped 0**（219 → 222：+1 沙箱前置守卫、suite2 由 2 个用例增至 4 个）。macOS 本地 `skipped 0`；Linux runner 上 scanner 的 8 个 macOS firmlink 专用用例按既有设计平台条件跳过，故 CI 预期为 `pass 214 / skipped 8 / fail 0`。
- `npm run typecheck`（`tsc --noEmit`）：**exit 0**。
- `scripts/verify-ci.sh --skip-docker`（`FNPACK_BIN` 指向官方 fnpack，真构建）：**门禁结论 PASS（可发布）**，heal / meta / build / test / isolation / fpk 六段 PASS，docker 段 SKIP；产出 `dist-fpk/rainbow-0.2.20.fpk`（`.gitignore` 已排除，不入库）。

---

## 七、明确没有做的事

- **没有删除或重指 `v0.2.19` tag**，没有删除远端任何对象，没有 force push `main`。
- **没有改动任何产品代码逻辑**：`server/src` 下仅两处**版本字符串常量**随 bump 更新（`status.ts` 的 `version` 字段、`scrape-detail.ts` 的 MB UA 串），`queue.counts()` / `queue.list()` / `initDb()` / `taskStore` 等被测实现**一行未动**。
- **没有放宽或删除任何既有断言**来「让测试变绿」：suite2 的断言是**加强**（不等式 → 精确等值），不是削弱。
- **没有跳过失败用例**（无 `.skip` / `todo` 新增），也没有修改 CI workflow 让门禁失效。
- **没有给 `isolation` 段加跳过开关**（见 §4.3 末）。
- 本版**不含**任何新功能、接口变更或数据结构变更。

---

## 八、已知盲区与遗留

1. **`isolation` 段只在本地门禁，未进 `build.yml`**。CI 侧仍靠 `npm test` 本身兜底——但兜底能力已经变强：新增的「沙箱前置守卫」用例在 CI 的空库环境下**必然第一个失败并直接指名根因**，不会再出现「症状离根因六步远」的定位成本。把 `SANDBOX_ELISION` 也搬进 workflow 是可选的后续增强（需要 CI 侧装 esbuild，收益是更早失败）。
2. **`DB_CANARY` 在 CI 上作用有限**：runner 的 `data/ro.db` 本就不存在（`.gitignore` 排除），此时 canary 的语义退化为「跑完测试后仓库里不得凭空出现 `data/ro.db`」——仍然有效（正是 elision 的后果），但比本地弱。
3. **elision 是转译器行为，不是 lint 规则**。当前护栏用 esbuild 转译比对来检测，属**事后**发现；更前置的做法是引入能识别「带副作用模块的未使用具名 import」的 lint 规则。本版未引入新依赖，故未做。
4. **其余 9 个测试文件的沙箱 import 形态**已全量扫描确认保留，但其中部分依赖具名导出（`SANDBOX_ROOT` / `writeSandboxConfig`）被真实使用——一旦将来重构删掉那些使用点，同样的 elision 会再次发生。`SANDBOX_ELISION` 护栏即为这一情形而设。
