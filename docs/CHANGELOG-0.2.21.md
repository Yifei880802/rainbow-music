# 变更清单：v0.2.20 → v0.2.21

基线 `588f4e9`（tag `v0.2.20` 指向的提交，= 当前 `origin/main`）→ **本版发布提交**（三项维护内容 + bump 0.2.21 + 本文）。本版**不含任何功能变更**，是 v0.2.20 之后的维护版本：① 把 v0.2.20 只在本地门禁的沙箱隔离护栏搬进 CI ② 补齐滞后于实现的 `API.md` 契约 ③ 对 `npm audit` 做**非破坏性**依赖治理。

> **本版为维护更新（无功能变更）**：`server/src` 下**没有一行功能逻辑改动**——只有两处**版本字符串常量**随 bump 更新（`status.ts` 的 `version` 字段、`scrape-detail.ts` 的 MusicBrainz UA 串）。服务端音乐应用的行为、接口实现与曲库逻辑与 **v0.2.20 完全一致**。改动落在四类文件：① CI 工作流（`.github/workflows/build.yml`，test job 内部）② 文档（`API.md` 契约补齐、`docs/FNOS-DEPLOY.md` 版本号）③ 依赖锁（`server/package-lock.json`，2 个包的 minor/patch 升级）④ 版本承载常量与本文。`API.md` 的补齐是**把已存在的实现记录下来**，不是新增实现。

> **本文是对外可读版本。** 仓库公开，因此不写 NAS 主机名、备份与证据树的具体落盘
> 路径、凭据与内部运维细节——这些属于内部项目档案，不属于这里。技术结论与代码改
> 动本身完整无删减。

> **发布状态**：版本承载点（**8 文件 / 12 处版本号 + 1 处 `fpk/manifest` changelog 文案**，清单见 §五）已**全量 bump 至 0.2.21**；本地门禁 `scripts/verify-ci.sh --skip-docker` 结论 **PASS（可发布）**——heal / meta / build / test（`npm test` **222 / 222 pass、0 fail、0 skipped**）/ isolation / fpk 六段全绿，docker 段因 `--skip-docker` 记 SKIP（不影响结论）；fnpack 官方工具已真构建出 `rainbow-0.2.21.fpk`（112K），包级断言（TAG_CONSISTENCY / DOWNLOAD_MOUNT / WIZARD_FIELD / DDIR_CONVERGE / LIBRARY_SHARE）全 PASS，DIGEST_PIN 为本地门禁的正常形态 SKIP（正式发布由 CI 注入 index digest）。
>
> **本版尚未 push、尚未打 tag、尚未触发 CI。** 三项内容与 bump 收拢为**一个本地 commit**（纯 M/A，无 D/R），公开发布（走 `github-release-chain` 的 REST 逐对象复刻 + annotated tag `v0.2.21`）另行派发，届时需用户显式确认 `repo + tag + commit` 三元组。

---

## 一、本版三项内容总览

| 项 | 目标 | 改动文件 | 性质 | 用户可见影响 |
|---|---|---|---|---|
| **项1** | 把 v0.2.20 只在本地门禁的 `SANDBOX_ELISION` 编译期护栏搬进 CI，让「沙箱 import 被 elide」的回归在 CI 侧**秒级红** | `.github/workflows/build.yml`（**+69 / −3**） | CI 工作流 | **无** |
| **项2** | `API.md` 契约补齐：HEAD 版对 `server/src/routes/` 的 85 个 method+path 组合缺 **20 个**（涉及 **18 条全新路径**），并滞后于本版的 507 / 结构化错误码 / 纠错字段 / 尝试审计等改动 | `API.md`（项2 **+585 / −15**，另 bump **+1 / −1**） | 文档 | **无**（文档） |
| **项3** | `npm audit` 非破坏性治理：13 → 11 项，只做 `npm audit fix`（**不带 `--force`**），11 项 `isSemVerMajor=true` 一律 DEFER | `server/package-lock.json`（项3 **+10 / −10**，另 bump **+2 / −2**） | 依赖 | 理论上**无**（论证见 §4.3） |

**同文件改动合并**：项2 与 bump 都改 `API.md`、项3 与 bump 都改 `server/package-lock.json`。两处均合并进同一 commit，**无冲突、无重复 bump**——bump 只动 `version` 字段（lock 的 L3 / L9），audit fix 只动 `fastify` / `fast-uri` 三个条目（lock 的 L2259 之后），行区间不重叠。

---

## 二、项1：CI 侧沙箱隔离护栏（`.github/workflows/build.yml`）

### 2.1 为什么把本地护栏搬进 CI

v0.2.20 的 `CHANGELOG-0.2.20.md` §八.1 记了一条明确的遗留：

> **`isolation` 段只在本地门禁，未进 `build.yml`**。CI 侧仍靠 `npm test` 本身兜底……把 `SANDBOX_ELISION` 也搬进 workflow 是可选的后续增强（需要 CI 侧装 esbuild，收益是更早失败）。

本版兑现这条。动机是**定位成本**：v0.2.19 的 CI 失败，症状是「`total should be > 0 (DB has tasks)`」，根因是「未使用的具名 import 被 esbuild 整行 elide → `env-sandbox` 未执行 → 测试落到真机库」，症状离根因**六步远**。护栏前移后，CI 会在跑测试**之前**直接输出根因与修法，并点名到具体文件。

### 2.2 test job step 结构：3 → 5

| # | 改前 | 改后 |
|---|---|---|
| 0 | `actions/checkout@v4` | 同 |
| 1 | `actions/setup-node@v4`（node 20 + npm cache） | 同 |
| 2 | 「运行测试套件」`run: npm ci` **&&** `npm test` | 拆为「**安装依赖**」`run: npm ci` |
| 3 | — | **新增「沙箱隔离护栏 SANDBOX_ELISION」** |
| 4 | — | 「运行测试套件」`run: npm test` |

把 `npm ci` 拆成独立 step 有两个原因：护栏需要 `node_modules` 已就位；拆开后「装依赖失败 / 护栏红 / 测试红」三种失败在 Actions UI 上**分别定位**，不再混在一个 step 里。

**六 job 结构与依赖链一行未改**：`meta → build → test → docker → fpk → release`，改动全部落在 test job 内部（详见 §6.5 的 YAML 解析复核）。

### 2.3 护栏脚本逻辑（55 行，`working-directory: server`）

1. **解析 esbuild**（三级候选，见 §2.4），全无则 `::error::` + `exit 1`
2. **同形正则** `PAT='^[[:space:]]*import[[:space:]].*fixtures/env-sandbox'` —— 源文件判定与转译产物判定**共用同一个模式**，语义即「源里怎么写的，转译后就该还在」，不依赖 esbuild 的注释处理行为。这与 `scripts/verify-ci.sh` 的 isolation 段**同形**，两处判定口径不会漂移。
3. **遍历 `test/*.test.ts`**，先用 `grep -Eq "$PAT"` 筛出「源里真的 import 了 env-sandbox」的文件（**并非所有测试都用沙箱，这是不误红的关键**）
4. 对每个入选文件跑 `$ESBUILD --format=esm "$f"`，把 stdout 再跑同一 PAT
5. **三计数汇总**（`checked` / `elided` / `unverifiable`）+ 判定

### 2.4 esbuild 从哪来（任务书前提校准）

任务书写「esbuild 已随 tsx 为传递依赖」——**实测需要修正**：`server/node_modules/.bin/esbuild` 是 **0.19.12，来自 `drizzle-kit`**；`tsx` 自带的是**嵌套副本 0.28.1**（`node_modules/tsx/node_modules/esbuild`）。而 `npm test` = `tsx --test`，真正转译测试文件的正是那份 **0.28.1**。因此护栏按「与实际转译器同源优先」排序：

| 优先级 | 候选 | 本机实测 | 说明 |
|---|---|---|---|
| 1 | `node_modules/tsx/node_modules/esbuild/bin/esbuild` | **0.28.1 ✓ 命中** | 与 `npm test` 实际使用的转译器**同源**，判定最忠实 |
| 2 | `node_modules/.bin/esbuild` | 0.19.12（`drizzle-kit` 传递） | 兜底；版本较旧但 elision 语义一致 |
| 3 | `npx --no-install esbuild` | — | 只用已装好的，**绝不联网拉包** |
| 全无 | `::error::` + `exit 1` | — | **不静默跳过**：`npm ci` 刚跑完还没有 esbuild = 环境异常 |

### 2.5 失败即红 / 防误红的边界

| 情形 | 行为 | 理由 |
|---|---|---|
| 某文件源里有沙箱 import、转译产物里没有 | `::error file=$f::SANDBOX_ELISION_FAIL …` + 末尾 `exit 1` | 这就是 v0.2.19 的根因，**必须红**；错误文案自带后果链与修法（改回裸副作用 import） |
| 某文件 esbuild 转译失败 | `::warning file=$f::` + 记 `unverifiable`，**不红** | 给不出结论；语法错误由下一步 `npm test` 暴露 |
| `checked=0`（没有任何文件用沙箱） | `::warning::` 空转提示，**不红** | 将来若全部测试改用别的隔离方式，不该误红 |
| 找不到 esbuild | `::error::` + `exit 1` | 与本地门禁的 SKIP 降级**刻意不同**：CI 里 `npm ci` 刚跑完，缺 esbuild 就是异常，静默跳过等于护栏形同虚设 |

### 2.6 本地模拟验证（原样抽出 CI 脚本，不是另写等价脚本）

用项目自带的 `yaml` 模块解析 `build.yml`，把 test job 里名字含 `SANDBOX_ELISION` 的 step 的 `run` 字段**原样落盘**（**2659 bytes / 55 行**），再在三个目录里执行——这样证明「本地跑的就是 CI 要跑的那段字节」：

| 场景 | 目录 | 期望 | 实测 |
|---|---|---|---|
| **A 正向** | 真仓库 `server/` | RC=0 | **RC=0**；转译器 = tsx 自带 **0.28.1**；`checked=10 elided=0 unverifiable=0`；10 个文件逐个 `ok` |
| **B 反向注入** | 临时假树：`bad.test.ts`（未使用的具名 import，= v0.2.19 缺陷写法）+ `good.test.ts`（裸副作用）+ `plain.test.ts`（不用沙箱） | RC=1 且点名 bad | **RC=1**；`checked=2 elided=1`；`::error file=test/bad.test.ts::SANDBOX_ELISION_FAIL …` **精确点名**；`good` 放行；`plain` **未被检查** |
| **C 空转** | 只有 `plain.test.ts` 的假树 | RC=0 + warning | **RC=0**；`checked=0`；输出空转 `::warning::` 后 `SANDBOX_ELISION_PASS` |

假树通过软链真仓库 `node_modules` 解析 esbuild，**未改动仓库任何文件**，跑完即删。结论：**能抓出**（B）、**不误红**（A / C）。

### 2.7 与本地门禁的关系（是新增第二道，不是替代）

`scripts/verify-ci.sh` 的 isolation 段**一行未动**，仍是 `SANDBOX_ELISION`（编译期）+ `DB_CANARY`（运行期：真机 `data/ro.db` sha256 前后一致 + 无 `-wal`/`-shm` 新增）双证据。CI 侧只搬了**编译期那半**——`DB_CANARY` 在 runner 上语义退化（`data/ro.db` 本就被 `.gitignore` 排除，不存在「跑前基线」可比），v0.2.20 §八.2 已记录，本次不搬。

---

## 三、项2：`API.md` 契约补齐

### 3.1 缺口与取证方式

补齐前 `API.md`（HEAD 版 **1029 行**）对 `server/src/routes/` 的 **85 个 method+path 组合 / 75 条去重路径**缺 **20 个组合**（涉及 **18 条全新路径**）。

取证方式：**逐个路由文件精读**（18 个文件共 3056 行），按真实实现记录方法 / 路径 / Query / Body / 响应结构 / 状态码 / 错误体，**不臆造**。取证深入到路由之下的实现层——`core/search/index.ts`、`core/search/suggest.ts`、`core/download/queue.ts`、`core/db/{index,smoke,searchHistory}.ts`——因此字段语义（`total` 的计算口径、健康冒烟的三色判定阈值、搜索历史的去重键与共现窗口）都有源码依据，而不是从字段名猜。

### 3.2 新覆盖的 18 条路径 / 20 个组合

| 路径 | 方法 | 特性 | 记录要点（均取自实现） |
|---|---|---|---|
| `/api/v1/search/merged` | GET | #191 J1/J2 | 去重主键 `name+singer`、辅键 `interval` ±5s；`sources[]`；`score` 降序；`total` = 去重后条数 |
| `/api/v1/search/suggest` | GET | P0 D2 | history / hot / title 三源；**q 为空直接返回空 `items`**（不是默认推荐）；**`includes` 包含匹配**（非前缀）；标题池 5min 缓存；单榜 8s 超时；**不报错** |
| `/api/v1/search/trending` | GET | P0 D3 | 近 7 天（`TRENDING_WINDOW_MS`）；**不做内存缓存** |
| `/api/v1/search/related` | GET | P2 O5 | `search_cooccurrence` 共现表；冷启动回退 trending；`relatedEnabled === false` 或 kw 空 → `{related:[]}` |
| `/api/v1/tasks/owned` | GET | #196-fix2 | 无分页；`key = "<platform>:<songmid>"`；`quality` = `requested_quality` |
| `/api/v1/tasks/:id/attempts` | GET | M2 | `download_attempts` 行结构（见 §3.6）；**无尝试 → 空数组，不是 404**；任务不存在才 404 |
| `/api/v1/batches` | GET | H1 | `completed` 计数**含** `completed_with_warnings`；`created_at`=MIN、`updated_at`=MAX；只统计 `batch_id` 非空 |
| `/api/v1/batches/:id` | GET | H1 | 上限 500；空批 404 `'batch not found or empty'` |
| `/api/v1/batches/:id/cancel` | POST | H1 | 仅取消 pending/active；**admin 限定**（非管理员 403）；同步清理激活缓冲 |
| `/api/v1/queue/pause` | POST | H3 | admin 限定；只停调度，不影响在途任务 |
| `/api/v1/queue/resume` | POST | H3 | `userPaused` 与 `memPaused`（RSS 护栏）**独立**，恢复时不得覆盖用户暂停意图 |
| `/api/v1/queue/status` | GET | H3 | 运行态全字段：`paused` / `memPaused` / `concurrency` / `scheduled` / `activationBuffer` / `running` + 五个计数 |
| `/api/v1/preview` | GET | O1 | **302 + `Location` + `Cache-Control: no-store`，无响应体**；`allowToggleSource: false` **刻意不换源**；共享 L1/L2/L3 取链；前端用 `<audio src>` |
| `/api/v1/sources/capabilities` | GET | C4 | `platform` **必填**（缺则 400）；过滤 `status==='ready' && enabled && s.sources[platform]`；四档 qualities **固定全量回传**（并集）；无匹配 → 全 false + 空数组**不报错** |
| `/api/v1/me/search-history` | GET / POST / DELETE | P0 D1 | 去重键 `(uid, kw.trim())` **保留原 id**；`ts = max(Date.now(), MAX(ts)+1)` **严格递增**；封顶 `SEARCH_HISTORY_KEEP`=200；POST 时上一条不同且间隔 ≤30min（`COOC_WINDOW_MS`）记一对共现（双向 upsert）→ 即 `/search/related` 的数据源 |
| `/api/v1/playlists/:id/download-missing` | POST | H2 | `findCompletedWithFile` 判拥有；**201（有入队）/ 200（全跳过）双响应**；`skipped[].reason='already-owned'` |
| `/api/v1/health/smoke` | GET | R9 | 五步探测（search→musicUrl→head→lyric→pic）；`summary{total,green,yellow,red}`；**三色判定**：search/musicUrl/head 失败 → red，仅 lyric/pic 失败 → yellow，否则 green；从未跑过 → null |
| `/api/v1/health/smoke/trend` | GET | R9 | `days` clamp 1..30 默认 7；**只统计 `head` 步**；`date(created_at/1000,'unixepoch','localtime')` 本地时区；day 倒序 |

### 3.3 改写扩充（HEAD 已有该端点字符串，但描述滞后于实现）

`POST /download`、`POST /download/batch`、`GET /tasks`、`GET /tasks/:id`、`DELETE /tasks/:id`、`GET /search/aggregate`、`POST /playlists/:id/download`、`POST /health/smoke/run`，以及 `## 错误约定` **整章重写**。其中：

- `GET /tasks/:id` 由残缺示例扩为**完整 24 字段** JSON + 8 行字段表（含 M1 的 `error` / `errorCode` 双字段与旧数据兼容说明）
- `GET /tasks` 补 H4 分页表（`status` / `batchId` / `limit` clamp 1..500 默认 50 / `offset`）与 `total` 的计算口径（`completed_with_warnings` 归入 `completed`）
- `GET /search/aggregate` 补 D4 超时/缓存/in-flight 说明与 #200 O4 纠错字段
- `## 错误约定` 新增 **11. 健康冒烟** 章的目录项，状态码表由 9 行扩为 **15 行**

### 3.4 507 / `ERR_DISK_FULL` 新失败态

源码依据（`server/src/routes/download.ts`）：

```ts
const code = classifyError(err)
const message = err instanceof Error ? err.message : String(err)
return reply.code(isDiskFullError(err) ? 507 : errorToStatus(code)).send({ error: { code, message } })
```

文档补齐的语义：

- `enqueue` 已转 **async**，入队阶段的失败**不再被吞掉**，而是以结构化错误码返回
- **N3 磁盘预检**：开关 `download.diskPrecheck`；阈值 `download.minFreeBytes` 默认 `104857600`（100MB）；`check-disk-space` 动态 import + 2s 缓存；**fail-open**（探测本身失败不拦下载）
- **H5 去重命中时不触发预检**（不产生磁盘写入，无需预检）
- `POST /download/batch`：**任一歌曲预检失败 → 整批驳回**，不产生部分入库；响应新增 `batchId`；全部条目非法时 `batchId = null` 但**仍 201**；`download.batchMaxItems` 默认 200；`rejected[] = {index, error}`
- `errorToStatus` 映射表：`DISK_FULL`→**507** / `NO_SOURCE`→503 / `TIMEOUT`→504 / `BAD_REQUEST`→400 / default→502
- 错误响应体结构：`{ "error": { "code": "ERR_DISK_FULL", "message": "磁盘可用空间不足（free … bytes < required … bytes）" } }`
- `POST /playlists/:id/download` 同样可返回 507（整单不入队）

### 3.5 `corrected` / `correctedFrom` 语义（#200 O4）

- **触发条件**：仅当结果数 `count < search.correctMinResults`（默认 **3**）且 `search.correctEnabled !== false` 时才尝试纠错
- **不自动替换用户原词**，只回建议字段（`corrected` = 建议词，`correctedFrom` = 原词）
- 词典 = **搜索历史全时段高频前 500 词** + 60s 缓存
- 只有 `c.corrected !== keyword.trim()` 才回（纠错结果与原词相同则不回）
- 纠错过程抛错**静默降级**——不影响主搜索结果

### 3.6 `download_attempts` 行结构（M2）

7 列：`task_id` / `attempt_no` / `source_id` / `platform` / `quality` / `error_code` / `ts`；索引 `idx_attempts_task(task_id, ts)`。

- `attempt_no` = **队列重试轮次**（从 1 起）；同一轮内的**换源 / 换音质共享同一 `attempt_no`**（不是每次尝试都 +1）
- 命中（成功）那一条 `error_code = null`
- 排序 `ORDER BY ts ASC, id ASC`
- `DELETE /tasks/:id` **级联清理**该任务的尝试记录
- 写入为 **best-effort**（审计写入失败不影响下载主流程）

### 3.7 错误约定章重写：两种形态并存

| 形态 | 结构 | 适用 |
|---|---|---|
| **A（历史）** | `{ "error": "<描述字符串>" }`，部分端点附 `valid` 数组列出合法取值 | 多数历史端点；`GET /preview` 的 400 也是结构化体但用 `{error:{code,message}, valid}` |
| **B（M1，本版文档化）** | `{ "error": { "code": "ERR_*", "message": "…" } }` | 下载 / 试听链路的失败 |

给出客户端健壮写法 `typeof body.error === 'string' ? body.error : body.error.message`，并列出 **ErrorCode 十值枚举**。状态码表扩为 15 行（新增 `200` / `302` / `502` / `503` / `504` / `507`；`403` 补 `queue/*` 与 `batches/:id/cancel`；`404` 补批次；`409` 补冒烟已在跑）。

### 3.8 机械化覆盖率校验

两个一次性脚本，都以 `server/src/routes/*.ts` 里的 `app.<method>('…')` 为**唯一真源**：

| 脚本 | 判据 | 补齐前 | 补齐后 |
|---|---|---|---|
| 宽松版 | 路径字符串是否出现在 `API.md` | 缺 17 路径 / 19 组合 | **缺失 0** |
| 严格版 | `"METHOD /path"` 是否**同现**（防「路径提到但方法写错」） | 缺 **20 组合** | **85 / 85 全命中** |

`API.md`：**1029 → 1599 行**（净 +570）。

### 3.9 与任务书的四处偏差校准（一律以真实 routes 为准）

| 任务书表述 | 真实实现 | 处置 |
|---|---|---|
| `GET /playlists/:id/download/preview` | **不存在**；真实为 `POST /api/v1/playlists/:id/download-missing` | 按真实实现记录 |
| `POST /search/merged` | 真实为 **GET** | 按 GET 记录 |
| `GET/POST/DELETE /me/favorites` | `API.md` **已有**且与实现一致 | 核对无误，**未新增** |
| 「18 个端点（16 条新路径）」 | 实测缺 **20 个组合 / 18 条新路径**；另发现 `GET /health/smoke` 与 `GET /health/smoke/trend` 此前**完全未记录**（只有 `POST /health/smoke/run` 在册） | 一并补齐，health 三端点全录 |

---

## 四、项3：依赖漏洞治理（保守，非破坏）

### 4.1 修复前后计数

`cd server && npm audit`（**必须带 `--registry=https://registry.npmjs.org`**：npmmirror 与内网 anpm 都不提供 audit 端点，会 E404 / EBADF）：

| 视角 | 修复前 | 修复后 | 变化 |
|---|---|---|---|
| 全量 | **13**（8 moderate / 5 high / 0 critical） | **11**（7 moderate / 4 high / 0 critical） | **−2** |
| 生产（`--omit=dev`） | 9 | **7**（3 moderate / 4 high） | **−2** |

「修复前」基线是**用 HEAD（`588f4e9`）的 `package.json` + `package-lock.json` 在临时目录重跑 audit 复现**的，不是引用旧记录——两份 JSON 都留了档，包级差异由脚本比对得出（`已消除 = ['fast-uri', 'fastify']`，`新增 = []`）。

### 4.2 已修：2 包 / 6 条 GHSA（`npm audit fix`，**未带 `--force`**）

| 包 | 类型 | 版本 | 消除的 GHSA | 严重度 |
|---|---|---|---|---|
| `fastify` | **direct runtime** | 5.11.3 → **5.12.5**（minor） | `GHSA-w2qp-rph6-63g4`（root primitive coercion 不匹配导致 schema 校验绕过）<br>`GHSA-3m5p-2c4r-xxw2`（`trustProxy` hop-count 下 `X-Forwarded-*` 伪造） | moderate ×2 |
| `fast-uri` | **transitive runtime** | 根副本 3.1.5 → **3.1.8**<br>`fast-json-stringify` 下嵌套副本 4.1.2 → **4.2.1** | `GHSA-5jgf-p345-68v8`（scheme-relative 引用跳过 IDN 规范化 → host 混淆）<br>`GHSA-f65p-4m7j-42xc`（IPv6 规范化不当 → SSRF）<br>`GHSA-fph4-wmhf-6fwf`（hostname 重复百分号解码 → SSRF）<br>`GHSA-jqff-g426-hqxp`（百分号编码 scheme 规范化 → host 混淆） | **high** ×4 |

`server/package.json` **一行未改**：`fastify` 声明为 `^5.2.0`，5.12.5 已在范围内；`fast-uri` 是传递依赖，不在直接依赖表里。变更全部落在 `package-lock.json`（**+10 / −10**）。

附带一处 lock 内的依赖声明同步：fastify 对 `process-warning` 的声明由 `^5.0.0` → `^5.1.0`；实装 `process-warning@5.1.0` **已满足**，未产生新的安装动作。

### 4.3 runtime vs dev 判定 + 行为变化风险论证（**这是 #215 范围判断的依据**）

**两项都是 runtime（生产）依赖，不是 dev**：

- `fastify` 是 HTTP 服务框架本体，`npm ls --omit=dev --depth=0` 在册（direct）
- `fast-uri` 被 `@fastify/ajv-compiler`（声明 `^3.0.0`）、`ajv`（`^3.0.1`）、`fast-json-stringify`（`^4.0.0`）依赖，三者都是 fastify 的 schema 校验 / 序列化机制，同样在生产依赖树内

**但行为变化风险论证为零**——两条 advisory 的代码路径在本项目**均不可达**：

| advisory | 触发前提 | 本项目实测 | 结论 |
|---|---|---|---|
| `GHSA-w2qp-rph6-63g4`（schema 校验绕过） | 路由需声明**运行时 JSON schema** | `grep -rnE "\bschema\b" src/` 仅命中 `core/db/playlists.ts` 的一行注释（「零 schema 改动方案」）；`grep -rn "schema:" src/routes/` **无匹配**——路由全部用 TS 泛型标注响应类型，**不注册运行时 schema** | ajv / fast-json-stringify / fast-uri 的校验与序列化路径**从不被调用** |
| `GHSA-3m5p-2c4r-xxw2`（`X-Forwarded-*` 伪造） | 需开启 `trustProxy` | `grep -rn "trustProxy" src test ../fpk ../Dockerfile ../docker-compose.yml` **无匹配** | 该分支**不可达** |

补充证据：`grep -rnE "require\(['\"](ajv|fast-uri|fast-json-stringify)|from ['\"](ajv|fast-uri|fast-json-stringify)" src/` **无直接引用**——三个包都不是本项目直接 import 的，只可能经 fastify 内部间接触达。

**版本跨度也支持零风险**：fastify 5.11.3 → 5.12.5 是同一 major 内的 minor 递进（semver 契约下不破坏 API）；fast-uri 3.1.5 → 3.1.8 与 4.1.2 → 4.2.1 都是 **patch** 级。

**→ 对 #215 真机验证范围的建议：轻量（冒烟级）即可。**

理由：本版**没有一行 `server/src` 功能逻辑改动**（只有两处版本字符串常量），依赖变更是 minor/patch 且受影响代码路径经上面逐项论证**不可达**。建议 #215 做冒烟级验证而非完整回归：

1. 容器起来、`GET /api/v1/status` 返回 `version: 0.2.21`
2. 一次搜索（走 fastify 路由 + 响应序列化，覆盖 fastify 升级的**主干路径**）
3. 一次下载到底（覆盖写盘、刮削、`download_attempts` 落库）
4. 一次 `POST /download` 参数错误 → 确认错误体形态与 §3.7 的形态 B 一致
5. fpk 能装、能起、共享目录挂载正常（本地门禁已真构建出 `rainbow-0.2.21.fpk` 并通过 5 项包级断言，实机只需确认安装链路）

**不建议**做完整回归的理由：完整回归的成本应留给 DEFER 的那 11 项——它们才是 major 跨度、真会改行为的升级（§4.4）。

### 4.4 DEFER 11 项（全部 `isSemVerMajor=true`，一律不在维护版本里动）

| # | 包 | 严重度 | dev/prod | 当前 → 修复版 | 直接? | DEFER 原因 |
|---|---|---|---|---|---|---|
| 1 | `@fastify/static` | **high** | prod | 8.3.0 → 10.1.4 | direct | **跨 2 个 major**。4 条 advisory：`GHSA-83w8-p2f5-377r`（high，路径穿越绕过路由守卫）、`GHSA-pr96-94w5-mx2h`（目录列举路径穿越）、`GHSA-x428-ghpx-8j92`（编码路径分隔符绕过守卫）、`GHSA-8pvw-jcv7-9cmj`（非规范 URL 路径鉴权绕过）。本项目用它托管前端 UI，major 升级可能改 `root` / `prefix` / `wildcard` 语义与**网关前缀转发**（`micro_app` 链路）行为，必须单独验证 |
| 2 | `drizzle-orm` | **high** | prod | 0.38.4 → 0.45.3 | direct | `GHSA-gpj5-g38j-94v9`（SQL 标识符转义不当 → SQL 注入）。0.38 → 0.45 跨 7 个 minor，drizzle 在 0.x 阶段 minor 即可能破坏；本项目手写 SQL 为主、drizzle 用得浅，但升级仍需回归全部 DB 路径 |
| 3 | `music-metadata` | **high** | prod | 7.14.0 → 11.16.0 | direct | `GHSA-v6c2-xwv6-8xf7`（ASF 解析器死循环）。**跨 4 个 major**，7→11 之间 API 与 ESM/CJS 形态都有变化；它是刮削链路（读回真实码率/编码/采样率，C2 特性）的核心依赖，破坏即影响下载后的元数据回写 |
| 4 | `file-type` | moderate | prod | 16.5.4（经 `music-metadata`） | transitive | `GHSA-5v7r-6r5c-r473`（ASF 零长子头死循环）。修复只能随 `music-metadata@11.16.0` 一起进来，**与第 3 项同批**，不单独处置 |
| 5 | `sharp` | **high** | prod | 0.33.5 → 0.35.4 | direct | `GHSA-f88m-g3jw-g9cj`（继承 libvips 的 CVE-2026-33327 / 33328 / 35590 / 35591）、`GHSA-rgj7-g3m4-5g8c`（libheif 的 `GHSA-g89c-p67h-r497` / `GHSA-2jg2-4ch7-h545`）。**原生模块**，随 Node ABI 与目标架构编译（CI 是 amd64 + arm64 双架构）；升级有构建失败与跨架构产物不一致的风险，必须在能跑 buildx 的环境单独验 |
| 6 | `node-cron` | moderate | prod | 3.0.3 → 4.6.0 | direct | major 升级，v4 改了调度 API 与 ESM 形态；本项目用它跑**每日健康冒烟**（R9），破坏即静默失去定时自检 |
| 7 | `uuid` | moderate | prod | 8.3.2（经 `node-cron`） | transitive | `GHSA-w5hq-g745-h8pq`（v3/v5/v6 传入 `buf` 时缺少边界检查）。**本项目不使用该调用形态**，且修复只能随 `node-cron@4.6.0` 进来，**与第 6 项同批** |
| 8 | `drizzle-kit` | moderate | **dev** | 0.30.6 → 0.31.11 | direct | 只在开发期用（schema 迁移工具），**不进生产镜像** |
| 9 | `esbuild` | moderate | **dev** | ≤0.24.2（经 `drizzle-kit`） | transitive | `GHSA-67mh-4wv8-2f99` 只影响 **`esbuild dev server` 的 CORS**（任意网站可读开发服务器响应）。本项目把 esbuild 当**一次性转译器**用（`--format=esm` 转译到 stdout，不起 server），**该漏洞不可利用**。注意：项1 的 CI 护栏也用 esbuild，同样是「转译到 stdout」形态 |
| 10 | `@esbuild-kit/core-utils` | moderate | **dev** | 3.3.2（经 `drizzle-kit`） | transitive | 经由 `esbuild` 报出，与第 9 项**同源同批** |
| 11 | `@esbuild-kit/esm-loader` | moderate | **dev** | 2.6.5（经 `drizzle-kit`） | transitive | 经由 `@esbuild-kit/core-utils` 报出，与第 9 / 10 项**同源同批** |

**DEFER 结构总结**：11 项 = **prod 7 项（3 moderate / 4 high）+ dev-only 4 项（全 moderate）**。

- dev-only 那 4 项**全部溯源到 `drizzle-kit` 一条链**（`drizzle-kit` → `esbuild` / `@esbuild-kit/esm-loader` → `@esbuild-kit/core-utils`），修一个 `drizzle-kit@0.31.11` 即可全清；但它是 major 且属开发期工具，本次一并 defer。
- prod 7 项里，`file-type` ↔ `music-metadata`、`uuid` ↔ `node-cron` 各是**同批绑定**（传递依赖只能随宿主升级），所以真实待办是 **5 个升级动作**：`@fastify/static`、`drizzle-orm`、`music-metadata`（带 `file-type`）、`sharp`、`node-cron`（带 `uuid`）。

**为什么一律 defer（v0.2.19 烧号教训）**：任务书铁律「任何可能破坏 CI 的改动，宁可 defer 也不冒险」。这 5 个动作全是 `isSemVerMajor=true`，其中 `sharp` 是原生模块 + 双架构构建、`music-metadata` 跨 4 个 major、`@fastify/static` 关系网关前缀转发。在维护版本（补丁号递进）里塞 major 升级，一旦 CI 红就是**又一次烧号**；而 deferred 的漏洞在本项目的实际暴露面经上面逐项论证后**都很窄**。正确做法是单开一个升级窗口，逐个升 + 逐个跑完整门禁 + 真机回归。

### 4.5 lockfile 副作用：registry 混用（留档，非缺陷）

`npm audit fix` 会把它改动过的包的 `resolved` 字段**重写为 npmjs 官方源**（audit 端点只有官方源支持）。结果：

| registry | 修复前 | 修复后 |
|---|---|---|
| `registry.npmmirror.com` | 279 | **276** |
| `registry.npmjs.org` | 0 | **3**（`fastify`、`fast-uri` ×2 副本） |
| 合计 `resolved` 条目 | 279 | 279 |

**这不是缺陷**：`resolved` 只是下载来源提示，`integrity`（sha512）才是校验依据；两个源上同一版本的 tarball 内容一致，CI 的 `npm ci` 对混用源无感（且 CI 走默认官方源）。**未修改 `~/.npmrc`、未提交任何 registry 配置**。留档是因为它会出现在 lock 的 diff 里，避免下次有人误判为「谁偷偷换了源」。

### 4.6 一致性核对

- **实装版本 = lock 声明**（`node -p "require('./node_modules/<p>/package.json').version"` 逐个核对）：`fastify 5.12.5`、`fast-uri 3.1.8`、嵌套 `fast-uri 4.2.1`、`process-warning 5.1.0` ✓
- `npm ls --omit=dev --depth=0`：**无 UNMET / invalid**，root 显示 `rainbow-server@0.2.21` ✓
- **直接生产依赖版本全部未变**（= DEFER 生效的正面证据）：`@fastify/static 8.3.0`、`drizzle-orm 0.38.4`、`music-metadata 7.14.0`、`node-cron 3.0.3`、`sharp 0.33.5` ✓

---

## 五、版本承载点 bump 清单（0.2.20 → 0.2.21，8 文件 / 12 处版本号 + 1 处 changelog 文案）

| 文件 | 位置 | 内容 |
|---|---|---|
| `fpk/manifest` | L2 | `version=0.2.21` |
| `fpk/manifest` | L25 | `changelog=` 文案改写为 **0.2.21 维护更新**说明（541 → **576** 字符；单行、无换行、无 `=`，不破坏 INI 解析） |
| `server/package.json` | L3 | `"version": "0.2.21"` |
| `server/package-lock.json` | L3 / L9 | 顶层 `version` 与 `packages[""].version` 同步（npm 视角一致，`npm ls` 已验证） |
| `server/src/routes/status.ts` | L15 | `/status` 响应的 `version` 字段 |
| `server/src/core/adapters/scrape-detail.ts` | L295 | MusicBrainz UA 串 `Rainbow/0.2.21 ( … )` |
| `scripts/verify-image.sh` | L7 / L10 / L33 | 默认镜像 tag `rainbow-music:v0.2.21`（注释两处 + `IMAGE` 默认值） |
| `API.md` | **L1045**（v0.2.20 时为 L678，因项2 插入内容而**漂移**） | `/status` 响应示例中的 `version` |
| `docs/FNOS-DEPLOY.md` | L1 / L371 | 文档标题版本；「重装验证推迟到 v0.2.21」的前向声明（见 §八.6） |

**改法**：全部用**按行号定位的 `sed`**（机械版本号替换不经编辑工具的中文写入路径，规避 §6.6 记录的形近字风险）；`fpk/manifest` 的 changelog 文案用 python 按 `changelog=` 前缀定位整行替换，替换后校验「行数不变、只有一行变化」。改完用 `grep -rn "0\.2\.20"` 全仓复核。

**刻意保留 `0.2.20` 字样**的 **7 处**（精确计数口径：`git grep -n "0\.2\.20" HEAD -- . ':!docs/CHANGELOG-*'`，已在本版发布提交上复核）均为历史事件引用，语义上必须指向 v0.2.20 本身：

- `.github/workflows/build.yml` L95（项1 新增注释里指向 `docs/CHANGELOG-0.2.20.md §八.1`）
- `scripts/verify-ci.sh` L14 / L271 / L279（isolation 段的「v0.2.20 新增」说明 + CHANGELOG 引用）
- `server/test/download-196-fix.test.ts` L15 / L60 / L190（文件头注释与守卫说明）

历史文档**永不 bump**，不计入上表：`docs/CHANGELOG-0.2.20.md`（内含 14 行 `0.2.20`）、`docs/CHANGELOG-0.2.19.md`（不含 `0.2.20` 字样，已核对）。

`server/dist/` 下的编译产物（`routes/status.js`、`core/adapters/scrape-detail.js`）已被 `.gitignore` 排除、不入库；门禁 build 段跑完 `npm run build` 后已重新生成为 `0.2.21`（已核对）。

---

## 六、验证证据矩阵

### 6.1 本地门禁 `scripts/verify-ci.sh --skip-docker`

`FNPACK_BIN` 指向仓内 `tools/fnpack`（**真构建**，不走降级组装）：

| 段 | 结论 |
|---|---|
| heal | **PASS** |
| meta | **PASS**（版本 `0.2.21` 通过 `^[0-9]+\.[0-9]+\.[0-9]+(-r[0-9]+)?$`，推导 `image_tag=v0.2.21`） |
| build | **PASS**（`npm run typecheck` exit 0 + `npm run build`） |
| test | **PASS**（222 / 222） |
| **isolation** | **PASS** —— `SANDBOX_ELISION_PASS`：**10 个**沙箱测试文件的 env-sandbox import 在 esbuild 转译产物中**全部保留**，不可验证 0 个；`DB_CANARY_PASS`：真机 `data/ro.db` sha256 `027ff50a…96bd62` 跑前跑后**逐字符一致**，无 `-wal` / `-shm` 新增 |
| docker | **SKIP**（`--skip-docker`，不影响结论） |
| fpk | **PASS** |
| **门禁结论** | **PASS（可发布）** |

### 6.2 fpk 真构建与包级断言

产出 `dist-fpk/rainbow-0.2.21.fpk`（**112K**，`.gitignore` 已排除、不入库）。fnpack 官方结构（`app.tgz`）二次解包后：

| 断言 | 结论 | 内容 |
|---|---|---|
| `TAG_CONSISTENCY` | **PASS** | compose image 实际值 `rainbow-music:v0.2.21` 与预期**逐字符一致** |
| `DIGEST_PIN` | SKIP | 未提供 `FPK_IMAGE_DIGEST`，compose 为纯 tag 引用（本地门禁的**正常形态**，正式发布由 CI 注入 index digest） |
| manifest version | **PASS** | `0.2.21` |
| `DOWNLOAD_MOUNT` | **PASS** | 下载目录挂 data-share 软链（`…/shares/rainbow-music` → `/app/data/downloads`） |
| `WIZARD_FIELD` | **PASS** | 向导 / 回调均无 `wizard_download_dir` 残留 |
| `DDIR_CONVERGE` | **PASS** | 安装 / 升级回调均收敛遗留 `download.dir`（改前备份、限定 download 块） |
| `LIBRARY_SHARE` | **PASS** | 导入共享 `rainbow-library` 已声明并字面挂载，与下载共享平级不嵌套，`RO_SCAN_ROOTS='/app/data/downloads:/app/data/library'` |

### 6.3 单元测试与类型检查

- `cd server && npm test`：**tests 222 / suites 28 / pass 222 / fail 0 / skipped 0 / cancelled 0 / todo 0**（duration ≈ 61.5s）。与 v0.2.20 的 222 **完全持平**——本版不增不减测试，符合「维护更新」定位。macOS 本地 `skipped 0`；Linux runner 上 scanner 的 8 个 macOS firmlink 专用用例按既有设计平台条件跳过，故 CI 预期 `pass 214 / skipped 8 / fail 0`。
- `npm run typecheck`（`tsc --noEmit`）：**exit 0**。

### 6.4 CI 护栏 step 模拟

见 §2.6：三场景 A（真仓库 RC=0）/ B（反向注入 RC=1 且精确点名）/ C（空转 RC=0 + warning）**全部符合预期**，且跑的是从 `build.yml` **原样抽出**的那 2659 bytes。

### 6.5 workflow 结构校验

用项目自带的 `yaml` 模块解析 `.github/workflows/build.yml`：

- jobs 顺序 `meta → build → test → docker → fpk → release`（**六 job 未增未减**）
- test job step 数 **5**（原 3），`working-directory: server` 三个 step 均正确
- `on.push.tags`、`permissions`、`docker.outputs` 等关键字段完好，needs 依赖链未变

### 6.6 文档与中文字符静态校验

- **覆盖率双脚本**：宽松版缺失 **0**、严格版 **85 / 85** 全命中（§3.8）
- **中文字符完整性**：对全部改动文件跑「汉字 + 半角空格 + 汉字」与「半角空格 + 全角标点」两类正则——`build.yml` / `fpk/manifest` / `verify-image.sh` 均 **0 命中**；`API.md` 本次新增的 **586 行中 0 命中**（文件内 6 处历史命中全部位于 JSON 示例的**真实值**，如 `"周杰伦 晴天"`、`"纯音乐｜专注 放松 清新 氛围"`，属正确内容）；`verify-ci.sh` 的 6 处 ` ：` 为历史注释对齐格式，**本版未动该文件**。

> **踩坑留档（对后续维护者有用）**：编辑工具写入中文时出现过**形近字替换**——「拒绝」被写成「拒绍」、「跨音源」被写成「跳音源」，且**工具不报错**。更隐蔽的是：第一次尝试用「正确字形」作 `original_text` 去修，工具返回 success 但实际**只应用了部分替换**，其余静默无操作。因此本版所有中文改动都做了两道复核：① 逐次 review diff；② 用 python `repr()` 做**字节级终裁**。
>
> 另一类**假警报**：终端渲染长 CJK 行时会在折行处插入视觉空格，`grep` / `git diff` 的输出里看似「本 地」「语义自 洽」，用 python 按字节核对为 **0 处真实空格**。**判断中文空格问题只能信 `repr()`，不能信终端渲染。**
>
> 规避手法：① 机械的版本号替换改走「按行号 `sed`」，不经编辑工具的中文写入路径；② 中文措辞遇到高风险字时**改用同义词**（拒绍 → 驳回、跨音源 → 换音源）；③ 改完必 grep 复核，**不依赖工具报错来发现不匹配**。

---

## 七、明确没有做的事

- **没有 push、没有打 tag、没有触发 CI**。本版只产出**一个本地 commit**；公开发布（REST 逐对象复刻 + annotated tag `v0.2.21`）另行派发，届时需用户显式确认 `repo + tag + commit` 三元组。
- **没有改动任何产品代码逻辑**：`server/src` 下仅两处**版本字符串常量**随 bump 更新（`status.ts` 的 `version`、`scrape-detail.ts` 的 MB UA 串）。路由、队列、搜索、下载、刮削、DB 层**一行未动**。
- **没有跑 `npm audit fix --force`**，没有做任何 `isSemVerMajor=true` 的升级，没有改 `server/package.json` 的依赖声明。
- **没有修改 `~/.npmrc`**、没有提交任何 registry 配置（lock 内 3 条 npmjs `resolved` 是 `npm audit fix` 的固有副作用，见 §4.5）。
- **没有改动六 job 结构与 needs 依赖链**：`build.yml` 的改动全部落在 test job 内部（+69 / −3），`meta` / `build` / `docker` / `fpk` / `release` 五个 job 一行未动。
- **没有改动 `scripts/verify-ci.sh`**：本地门禁的 isolation 段与 v0.2.20 完全一致，CI 护栏是**新增的第二道**，不是替代。
- **没有放宽或删除任何断言**、没有跳过任何用例（无新增 `.skip` / `todo`），没有修改 CI workflow 让门禁失效。
- **没有动 v0.2.19 / v0.2.20 的烧号留档与已发 tag**，没有删除或重指任何远端对象，没有 force push。
- **没有碰 NAS**（不做任何实机部署、重启、配置变更）。
- 本版**不含**任何新功能、接口实现变更或数据结构变更——`API.md` 的补齐是**把已存在的实现记录下来**，不是新增实现。

---

## 八、已知盲区与遗留

1. **CI 护栏只覆盖编译期证据，且只在 `npm ci` 之后生效**。运行期的 `DB_CANARY`（真机库 sha256 前后一致）没有搬进 CI——runner 上 `data/ro.db` 本就不存在，没有「跑前基线」可比，语义退化为「跑完不得凭空出现该文件」，价值有限（v0.2.20 §八.2 已记录）。本地门禁仍是双证据，CI 是单证据。
2. **护栏依赖 esbuild 的可执行形态**。若将来 `tsx` 换成不内置 esbuild 二进制的版本、且 `drizzle-kit` 也被移除，三级候选会全落空 → 护栏**直接红**（§2.5 的刻意设计，不静默跳过）。届时需要显式加一个 esbuild devDependency。
3. **elision 仍是转译器行为、不是 lint 规则**。CI 护栏与本地门禁都属**事后**检测（写完才转译比对）。更前置的做法是引入能识别「带副作用模块的未使用具名 import」的 lint 规则；本版不引入新依赖，故未做（与 v0.2.20 §八.3 同）。
4. **DEFER 的 11 项漏洞仍在册**，其中 prod **4 项 high**（`@fastify/static` / `drizzle-orm` / `music-metadata` / `sharp`）。逐项暴露面论证见 §4.4，但「暴露面窄」**不等于「已修复」**。建议单开升级窗口，按 §4.4 归纳的 **5 个升级动作**逐个做，每个都跑完整门禁 + 真机回归。
5. **`API.md` 与实现之间没有机械化的一致性门禁**。本版用一次性脚本证明了 85 / 85 覆盖，但脚本**没有入库、也没有进 `verify-ci.sh`**；下次新增端点时同样会滞后。把「路由 → 文档覆盖率」做成常驻门禁是可选的后续增强（需要先决定契约的单一真源是文档还是代码）。
6. **`docs/FNOS-DEPLOY.md` L371 的前向声明已连续顺延三版**（v0.2.19 → v0.2.20 → v0.2.21）：「重装验证」始终未做，因为本机无 Docker、且未对 NAS 做任何实机操作。这条声明本身已接近失效——下一次真机窗口应**直接兑现或删掉**，而不是再顺延第四次。
7. **`fpk/manifest` 的 changelog 文案在 v0.2.20 未随版更新**（沿用了 v0.2.19 的功能强化说明），本版已改写为 0.2.21 维护更新说明。后续**每个发布版都应同步该字段**——它是 App Center 里用户唯一能看到的版本说明。
8. **CI 护栏在真 runner 上的首次执行尚未观测**。本地三场景模拟用的是从 `build.yml` 原样抽出的脚本（字节相同），但 runner 是 Linux、`actions/setup-node@v4` 装的是 Node 20，与本机 macOS 存在平台差异。护栏本身只用 `grep` / `esbuild` / POSIX shell，不含平台相关路径假设（`sha256sum` vs `shasum` 那类双兼容问题只存在于本地门禁的 `DB_CANARY`，不在 CI 护栏里），但**首次 tag 触发后应确认该 step 在 Actions 上确实 PASS 且 `checked=10`**（若 `checked=0` 说明 glob 未命中，会输出 warning 而非红）。

---

## 附录：文件级 numstat（本版发布提交，基线 `588f4e9`）

**10 个文件：9 个修改（M）+ 1 个新增（A），无删除（D）、无重命名（R）**：

```
69      3       .github/workflows/build.yml               （§二 项1：test job 插入 SANDBOX_ELISION 护栏 step，3 step → 5 step）
586     16      API.md                                    （§三 项2 +585/−15，§五 bump +1/−1）
441     0       docs/CHANGELOG-0.2.21.md                  （本文，新增）
2       2       docs/FNOS-DEPLOY.md                       （§五 L1 标题 + L371 前向声明）
2       2       fpk/manifest                              （§五 L2 version= + L25 changelog=）
3       3       scripts/verify-image.sh                   （§五 L7/L10/L33 默认镜像 tag）
12      12      server/package-lock.json                  （§四 项3 +10/−10，§五 bump +2/−2）
1       1       server/package.json                       （§五 L3 version）
1       1       server/src/core/adapters/scrape-detail.ts （§五 L295 MB_UA）
1       1       server/src/routes/status.ts               （§五 L15 /status 的 version）
```

**按项归并**：项1 = `build.yml`（+69/−3）；项2 = `API.md`（+585/−15）；项3 = `package-lock.json`（+10/−10）；bump = 8 文件 13 处（+12/−12，其中 `API.md` 与 `package-lock.json` 的 bump 行数已含在上面两项的文件里）；本文 = +441。**合计 +1118 / −41**。

**`server/package.json` 的依赖声明一行未改**（§4.2），它的 1+/1− 纯粹是 version 字段。
