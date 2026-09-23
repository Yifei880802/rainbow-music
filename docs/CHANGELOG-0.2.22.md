# 变更清单：v0.2.21 → v0.2.22

基线 `8862cf0`（tag `v0.2.21` 指向的提交，= 当前 `origin/main`）→ **本版发布提交**（五块内容 + bump 0.2.22 + 本文）。本版是 v0.2.21 之后的**质量修复 + 依赖维护**版本：① 修复 L1 音源健康排序把健康源误降权的真缺陷（本版核心，唯一的产品逻辑改动）② 文档对账订正 ③ 移除 drizzle 死依赖 ④ `@fastify/static` 8.3.0 → 10.1.4 ⑤ `node-cron` 3.0.3 → 4.6.0（连带移除 `@types/node-cron`）。

> **本版含一处真实的产品逻辑修复，不是纯维护版**。`server/src` 下除两处版本字符串常量（`status.ts` 的 `version`、`scrape-detail.ts` 的 MusicBrainz UA 串）外，只有 **两个文件**被改动：`source-engine/source-health.ts`（item1 修复，**+22 / −3**）与 `core/smoke/scheduler.ts`（batch2 的 node-cron v4 类型形态适配，**+8 / −2**，运行时行为不变）。路由、队列、搜索、下载、刮削、DB 层一行未动。

> **本文是对外可读版本。** 仓库公开，因此不写 NAS 主机名、备份与证据树的具体落盘路径、凭据与内部运维细节——这些属于内部项目档案，不属于这里。技术结论与代码改动本身完整无删减。本机 npm registry 指向内网镜像这一事实需要说明（它直接决定 lockfile 归一的做法，见 §八），但**主机名不写入本文、也绝不写入 lockfile**。

> **发布状态**：版本承载点（**8 文件 / 12 处**，清单见 §九）已**全量 bump 至 0.2.22**；`npm run typecheck` **零错误**；`npm test` **231 / 231 pass、0 fail、0 skipped**（含本版新增的 L1/L2 回归测试 9 例）；本地门禁 `FNPACK_BIN=<repo>/tools/fnpack scripts/verify-ci.sh --skip-docker` 结论 **PASS（可发布）、rc=0**——heal / meta / build / test / **isolation** / fpk 六段全绿，docker 段因 `--skip-docker` 记 SKIP（本机无 Docker，不影响结论）；fnpack 官方工具已真构建出 `rainbow-0.2.22.fpk`（112K），包级断言全 PASS。逐段证据见 §10.3。**本版尚未 push、尚未打 tag、尚未触发 CI**——五块内容与 bump 收拢为**一个本地 commit**（纯 M/A，无 D/R），公开发布（走 `github-release-chain` 的 REST 逐对象复刻 + annotated tag `v0.2.22`）另行派发为 #220，届时需用户显式确认 `repo + tag + commit` 三元组。

---

## 一、本版五块内容总览

| 块 | 目标 | 改动文件 | 性质 | 用户可见影响 |
|---|---|---|---|---|
| **item1** | 修复 L1 音源健康排序把「诊断性 `head` 探测失败」计入健康度、导致实际 100% 可用的音源被误判 `allRecentFailed` 降到候选末尾的真缺陷 | `server/src/core/source-engine/source-health.ts`（**+22 / −3**）<br>`server/test/source-health-l1.test.ts`（**新增 278 行 / 9 例**） | **产品逻辑修复** | **有**：下载更少绕远路走次优音源 |
| **item2** | 文档对账：把 living 文档里与真实实现不符的 L1/L2/L3 与 settings 契约描述订正为真实机制 | `API.md`（**+47 / −6**）<br>`docs/DEVELOPMENT.md`（**+39 / −1**）<br>`docs/SOURCES.md`（**+2 / −1**）<br>`server/src/core/config.ts`（**+1 / −1**）<br>`config.example.yaml`（**+1 / −1**） | 文档 | **无** |
| **batch0** | 移除 `drizzle-orm`（dependency）+ `drizzle-kit`（devDependency）两个**死依赖** | `server/package.json`<br>`server/package-lock.json`<br>**连带**：`scripts/verify-ci.sh`（**+65 / −5**）、`.github/workflows/build.yml`（**+5 / −4**） | 依赖 | **无**（但连带修好了一道会静默失效的门禁护栏，见 §4.2） |
| **batch1** | `@fastify/static` 8.3.0 → **10.1.4**：跨 major 升级，修掉 2 条 high 公告（目录列表路径穿越、编码绕过路由守卫） | `server/package.json`、`server/package-lock.json` | 依赖（安全） | **无**（唯一 breaking 涉及的 `setHeaders` 回调本项目未使用） |
| **batch2** | `node-cron` 3.0.3 → **4.6.0**（新版零运行时依赖，`uuid` 传递依赖随之消失）+ 移除 v4 已自带类型因而冗余的 `@types/node-cron` | `server/package.json`、`server/package-lock.json`、`server/src/core/smoke/scheduler.ts`（**+8 / −2**） | 依赖（安全）+ 类型适配 | **无**（`validate` → `schedule` → `stop` 逻辑一字未改） |

**同文件改动合并**（任务书明确要求「合并进同一 commit，勿冲突/勿重复 bump」）：

| 文件 | 被谁改 | 合并方式 |
|---|---|---|
| `API.md` | item2（+47/−6）**和** bump（L1075 status 示例 +1/−1） | 行区间不重叠（item2 落在 L946–1006 与 L1497 段，bump 落在 L1075）→ 单 commit 内共存，**只 bump 一次** |
| `server/package.json` | batch0/1/2（+2/−5）**和** bump（L3 +1/−1） | 同上（依赖声明在 L18–40，version 在 L3） |
| `server/package-lock.json` | batch0/1/2（+63/−1355）**和** bump（L3 / L9，+2/−2） | 同上；两处 `version` 已用脚本断言一致 |
| `docs/FNOS-DEPLOY.md` | 仅 bump（L1 标题） | — |
| `scripts/verify-ci.sh` | 仅 batch0 连带（isolation 段三级候选 **+ 兜底语义硬红**） | L24 的「v0.2.21 及之前由 drizzle-kit 传递带入」是**有意保留的历史说明**，不是漏 bump |

---

## 二、item1：L1 音源健康聚合排除诊断性步骤（本版核心）

### 2.1 ground truth 核实（不盲信任何既有描述）

任务书要求「第一步重新核实 ground truth，以真实 schema 为准」。核实结论：

**① `step` 列的真实取值**（`server/src/core/db/smoke.ts` L10，与任务书假设**完全一致**，无命名差异）：

```ts
export type SmokeStep = 'search' | 'musicUrl' | 'head' | 'lyric' | 'pic'
```

**② `smoke_results` 表真实 schema**（同文件 L29–42，9 列 + 3 索引）：

```sql
CREATE TABLE IF NOT EXISTS smoke_results (
  id TEXT PRIMARY KEY, run_id TEXT NOT NULL, source_id TEXT NOT NULL,
  platform TEXT NOT NULL, step TEXT NOT NULL, ok INTEGER NOT NULL,
  ms INTEGER NOT NULL DEFAULT 0, error TEXT, created_at INTEGER NOT NULL);
CREATE INDEX IF NOT EXISTS idx_smoke_run     ON smoke_results(run_id);
CREATE INDEX IF NOT EXISTS idx_smoke_created ON smoke_results(created_at);
CREATE INDEX IF NOT EXISTS idx_smoke_sp      ON smoke_results(source_id, platform, created_at);
```

写入侧唯一入口是 `smokeStore.newRow(runId, sourceId, platform, step, ok: boolean, ms, error?)` → `id = randomUUID()`、`ok = ok ? 1 : 0`、`created_at = Date.now()`，再由 `insertMany()` 批量落库。

**③ `computeSourceHealth()` 修复前的真实 SQL**（关键：**没有任何 `WHERE` 子句**）：

```ts
// 按 (source_id, run_id) 聚合：MIN(ok)=0 表示该 run 内任一步骤失败即整 run 失败
const rows = db
  .prepare(
    `SELECT source_id, run_id, MIN(ok) AS all_ok, MAX(created_at) AS ts
     FROM smoke_results
     GROUP BY source_id, run_id`,
  )
  .all() as { source_id: string; run_id: string; all_ok: number; ts: number }[]
```

**④ 唯一消费者**（`grep` 全仓核实）：`server/src/core/orchestrator/index.ts` L102–104，别无他处。

```ts
if (config.sources.healthAware === false) return base
const health = computeSourceHealth()
return filterCircuitOpen(orderByHealth(base, health))
```

### 2.2 缺陷面比任务书描述的更宽

任务书说的是「诊断性 `head` 步骤污染健康」。核实后发现真实缺陷面是**三步污染**：由于 SQL 无 `WHERE`，`MIN(ok)` 是在 `search`/`musicUrl`/`head`/`lyric`/`pic` **全部五步 × 全部平台**上取最小值。因此：

- `head` 失败（mg/tx 的 CDN 常拒 HEAD 返回 405/410/502，而 GET 完全正常）→ 整 run 判失败；
- `lyric` 失败（上游无歌词，与取链能力无关）→ 整 run 判失败；
- `pic` 失败（上游无封面）→ 整 run 判失败。

任一情形连续 5 轮（`HEALTH_SAMPLE_RUNS = 5`）即触发：

```ts
allRecentFailed = recent.length >= sampleRuns && okCount === 0
```

`orderByHealth()` 随后用「装饰-排序-还原」把 `allRecentFailed` 的源移到候选末尾。**净效果是：健康排序把最健康的源排到了最后。**

实测后果（任务书给出的生产数据）：承载 **90% 生产流量**、`musicUrl` **95/95 零失败**、实际下载 **127/127 全成功**的 `qdy`，仅因 `head` 在 mg/tx 被拒就被判 `allRecentFailed=YES` 并降到候选末尾。

因此采纳任务书推荐的 `WHERE step IN ('search','musicUrl')` —— 它一并排除了 `head`/`lyric`/`pic` 三步，正好覆盖真实缺陷面，无需额外改动。

### 2.3 最小修复（`source-health.ts`，+22 / −3）

只加**一个常量**和**一个 `WHERE` 子句**，阈值、`orderByHealth`、缓存 TTL、熔断器全部一字未动。

```ts
/** 健康聚合的 run 采样深度（近 N 次冒烟） */
const HEALTH_SAMPLE_RUNS = 5
/**
 * 参与健康聚合的冒烟步骤白名单（v0.2.22）：只有这两步能代表「源是否真能解析出可下载
 * 的直链」。诊断性 head 与附属 lyric/pic 一律排除，见文件头「聚合口径」。
 * 取值必须与 db/smoke.ts 的 SmokeStep 联合类型一致。
 */
const HEALTH_STEPS = ['search', 'musicUrl'] as const
```

```ts
// 按 (source_id, run_id) 聚合：MIN(ok)=0 表示该 run 内任一**关键步骤**失败即整 run 失败。
// step 白名单以参数绑定传入（不用字符串拼接，取值恒来自本模块常量，无注入面）。
const rows = db
  .prepare(
    `SELECT source_id, run_id, MIN(ok) AS all_ok, MAX(created_at) AS ts
     FROM smoke_results
     WHERE step IN (${HEALTH_STEPS.map(() => '?').join(', ')})
     GROUP BY source_id, run_id`,
  )
  .all(...HEALTH_STEPS) as { source_id: string; run_id: string; all_ok: number; ts: number }[]
```

**为什么用占位符 + 参数绑定而不是字符串拼接**：`${...}` 里插值的是 `HEALTH_STEPS.map(() => '?').join(', ')`，即**只生成问号**，真实取值走 `.all(...HEALTH_STEPS)` 的绑定参数通道。即便将来有人把 `HEALTH_STEPS` 改成含引号的值，也不会形成 SQL 注入面。拼接字面量（`WHERE step IN ('search','musicUrl')`）在当前取值下同样安全，但绑定形式让「常量即数据」这条不变量由驱动强制，而不是靠 review 记住。

**同时更新的文档性改动**（不改行为）：文件头新增「聚合口径（v0.2.22 修正）」段，`computeSourceHealth` 的 jsdoc 补一条边界语义：

> 只统计 `HEALTH_STEPS` 白名单内的步骤：某源若只有 `head`/`lyric`/`pic` 行（关键步骤从未跑过），则不产生快照 → 消费侧视为中性、不降权（**缺数据绝不等于坏源**）。

这条边界很重要：白名单过滤会让「只跑过附属步骤」的源从结果集里消失，而 `orderByHealth` 对 `health.get(id) === undefined` 的源天然按 `deprioritized = 0` 处理，即**不降权**。语义自洽，无需额外兜底代码。

### 2.4 复现测试（`server/test/source-health-l1.test.ts`，新增 278 行 / 9 例）

沿用 `search-infra.test.ts` / `download-p2.test.ts` 的风格：真 SQLite（沙箱目录）、真 `initDb()`、真 `smokeStore`，不打桩。

**沙箱 import 用裸副作用形式且为文件第一条 import**（v0.2.19 烧号教训，任务书特别点名）：

```ts
import './fixtures/env-sandbox.js'
```

**数据构造**：`insertRun(sourceId, runIdx, stepOk)` 按「5 平台 × 5 步骤 = 25 行/run」造满 5 轮，`stepOk(step, platform)` 是逐例定制的判定函数；`created_at` 用 `base + i` 递增覆盖 `newRow()` 里的 `Date.now()`，保证 run 间排序确定（否则同一毫秒内 125 行的 `MAX(created_at)` 无法区分轮次）。

| # | 用例名 | 关键断言 | 修前 | 修后 |
|---|---|---|---|---|
| 1 | `qdy 场景复现：search+musicUrl 全过、head 在 mg/tx 被拒 → 不判 allRecentFailed、不降权` | `runs === 5`、`rate === 1`、`allRecentFailed === false`、`orderByHealth([SRC,'other-a','other-b'])` 保持原序 | **FAIL** | PASS |
| 2 | `head 在**全部**平台失败也不降权（qdy 情形的上界）` | 同上（`stepOk = (step) => step !== 'head'`） | **FAIL** | PASS |
| 3 | `lyric/pic 缺失同样不参与聚合（附属元数据不影响取链与下载）` | `rate === 1`、`allRecentFailed === false` | **FAIL** | PASS |
| 4 | `对照组：musicUrl 真失败的源仍被判 allRecentFailed 并降到末尾（修复未把 L1 打哑）` | 坏源 `rate === 0`、`allRecentFailed === true`；`orderByHealth([BAD, GOOD]) === [GOOD, BAD]` | PASS | PASS |
| 5 | `对照组：search/musicUrl 等关键步骤失败的源同样被判 allRecentFailed` | 同上 | PASS | PASS |
| 6 | `阈值语义未变：5 轮里 1 轮 musicUrl 真失败 → rate=0.8 且 allRecentFailed=false` | `runs === 5`、`rate === 0.8`、`allRecentFailed === false` | PASS | PASS |
| 7 | `边界：某源只有 head 行（无 search/musicUrl）→ 无健康快照，按中性不降权` | `health.get(SRC) === undefined`、`orderByHealth([SRC,'peer'])` 原序 | **FAIL** | PASS |
| 8 | `L2 熔断器与 L1 聚合解耦：L1 判健康的源仍可被熔断（阈值 5 / 窗口 5min 未变）` | 4 次 `recordFailure` → `isOpen === false` 且 `failCount === 4`；第 5 次 → `isOpen === true`、`filterCircuitOpen([SRC,'other-a']) === ['other-a']`；`recordSuccess` → `isOpen === false`；`filterCircuitOpen([SRC]) === [SRC]`（此时熔断**已被 recordSuccess 关闭**，走的是「未熔断源正常保留」路径，**并非**回退分支） | **FAIL** | PASS |
| 9 | `L2 回退分支：全部候选均熔断 → filterCircuitOpen 剔空后回退原候选（绝不清空成 ERR_NO_SOURCE）` | A/B 各 5 次 `recordFailure` → 两者 `isOpen === true`；`filterCircuitOpen([A,B,'never-failed']) === ['never-failed']`（kept 非空 → 不回退，作对照）；`filterCircuitOpen([A,B]) === [A,B]` 且 `filterCircuitOpen([A]) === [A]`（**kept 被剔空 → 真回退分支**） | PASS | PASS |

**TDD 双向证据**（任务书要求「修复前会失败、修复后通过」）：

```
修复前：ℹ tests 9 / ℹ pass 4 / ℹ fail 5      ← 失败的正是 1/2/3/7/8
修复后：ℹ tests 9 / ℹ pass 9 / ℹ fail 0 / ℹ skipped 0
```

修前**通过的 4 个**是两个对照组（4/5）、阈值语义（6）与新增的 L2 回退分支（9）。前三例证明缺陷**只**在「附属步骤污染」这一条路径上，修复精准、没有把 L1 打哑、也没有动阈值语义；第 9 例修前修后都通过是**预期**的——它只操作 `sourceCircuit` 的进程内存态、完全不查 `smoke_results`，与 L1 聚合口径无关（它守的是 L2 的回退语义，不是 item1）。上表「修前」一列由**两种独立逆向手法交叉验证**得到同一组数字（`ℹ tests 9 / ℹ pass 4 / ℹ fail 5`，失败的正是用例 1/2/3/7/8）：① `t223-scratch/tdd-remeasure.sh` 外科式逆向——只删 `WHERE` 白名单那一行、并把 `.all(...HEALTH_STEPS)` 换回 `.all()`，注释与常量保留（`tsx --test` 不做类型检查，未使用常量无碍）；② `t223-scratch/tdd-before-9cases.sh` 整文件换回基线 commit 的版本（连 `HEALTH_STEPS` 常量与相关注释一并消失，脚本内先断言 `grep -c HEALTH_STEPS` 为 0 以确证修复特征真的不在了）。**两者一致**才说明「修前形态」的定义不敏感于逆向粒度、这组数字不是靠挑手法挑出来的。两次还原均以 sha256 与 `git status` 双重校验：还原后该文件与 HEAD 逐字节相同、工作区回到原有 5 个 M（`build.yml` / 本文 / `fpk/manifest` / `verify-ci.sh` / L1 测试文件），无逆向残留。另注：①的原始输出固化在 `/tmp/t223-tdd-before.log`，②刻意写独立日志 `/tmp/t223-tdd-before-wholefile.log`，不覆盖前者。

用例 8 修前失败于**前提断言** `assert.equal(health.get(SRC)?.allRecentFailed, false, '前提：L1 认为它健康')`（实际 `true`）——即修前连「L1 判它健康」这个前提都成立不了，谈不上验证解耦；修后前提成立，熔断链路的 6 条断言全部通过（原文写 5 条系漏数 `failCount === 4` 那一条，本次订正）。用例 7 修前失败于 `actual: { rate: 0, runs: 5, allRecentFailed: true }` vs `expected: undefined`——修前 `head` 行会被计入，凭空产生一个「全败」快照。

### 2.5 不破坏熔断器与其它消费者（逐项核实）

- **L2 熔断器与 `computeSourceHealth()` 零耦合**：`SourceCircuitBreaker` 只读写自己的 `private fails = new Map<string, number[]>()`，`threshold()` / `windowMs()` 实时读 `config.sources.*`，**从不查 `smoke_results`、从不调 `computeSourceHealth()`**。因此 item1 对 L2 无任何影响。测试用例 8 把这条解耦关系机械化固定下来。
- **`filterCircuitOpen` 的回退语义未动**：剔空后仍回退原候选（`kept.length > 0 ? kept : ids`），绝不因熔断把候选清成 `ERR_NO_SOURCE`。
- **唯一消费者 `orchestrator/index.ts` L102–104 一行未改**：接口签名 `computeSourceHealth(sampleRuns = HEALTH_SAMPLE_RUNS): Map<string, SourceHealth>` 与 `SourceHealth` 结构（`{ rate, runs, allRecentFailed }`）完全不变，消费侧无需任何适配。
- **`orderByHealth` 一字未动**：仍是「装饰-排序-还原」的稳定排序。
- **首启/无冒烟历史的降级路径未动**：表不存在或查询异常仍返回空 `Map`，消费侧视为全中性。

### 2.6 刻意未改的相邻口径（避免修复扩大化）

`db/smoke.ts` 里另有两处消费 `smoke_results` 的口径，**本版一律未动**：

| 口径 | 实现 | step 范围 | 为什么不动 |
|---|---|---|---|
| 「连续失败」告警 | `recentRunsOutcome(sourceId, platform, limit)` | **五步全算**（同样是无 step 过滤的 `MIN(ok)`） | 它是**告警**而非**排序**。告警的失败成本不对称：多报一条通知 vs 漏报一个真坏掉的源。宽口径宁可多报。改动它会让「head 持续被拒」这类真实上游变化静默不报，属于用修复的名义削弱可观测性。 |
| 趋势图 | `trend(days)` | **仅 `head`** | 它的口径本来就是「直链可用性」，与 L1 的「解析+取链能力」是两个问题，且只用于展示。 |
| 矩阵三色 | `routes/health.ts` L24–28 | `search`/`musicUrl`/`head` 任一失败 = `red`；仅 `lyric`/`pic` 失败 = `yellow` | 展示层要如实呈现「head 探测失败了」这个事实，不该因为 L1 不再采信它就把它藏起来。 |

**这带来一个需要在文档里讲清的表象**：修复后一个源可以「健康页矩阵显示 `red` / 触发连续失败告警」却仍被 L1 当作健康源优先使用。这是**有意为之**，不是不一致——已在 `API.md` §11 与 `docs/SOURCES.md`「已知限制与运维提示」双处写明（见 §3.2）。

---

## 三、item2：文档对账订正

### 3.1 核实方法

对 `docs/CHANGELOG-0.2.20.md`、`API.md`、`docs/SOURCES.md`、`docs/DEVELOPMENT.md`、`README.md` 逐文件读全文 + 关键词 `grep`（`429`、`403`、`drizzle`、`令牌桶`、`熔断`、`降并发`、`source_health`、`半开`），再与代码逐条对账。**真实机制基线**（以代码为准，本版重新核过一遍）：

- **L1** = `source-engine/source-health.ts` 基于 `smoke_results` 的健康排序，开关 `config.sources.healthAware`（默认 `true`），采样深度 `HEALTH_SAMPLE_RUNS = 5`，缓存 `HEALTH_CACHE_TTL_MS = 30_000`；
- **L2 熔断器** = `SourceCircuitBreaker` + 全局单例 `sourceCircuit`，**进程内存态**（`Map<string, number[]>`）、阈值 `circuitThreshold` 默认 **5**、窗口 `circuitWindowMs` 默认 **300000**、**无持久化**、**无 `source_health` 表**、**无独立半开计时**（半开由「`filterCircuitOpen` 剔空后回退原候选」+「`isOpen` 顺带老化窗口外时间戳」两个副作用合成）；
- **L3** = `source-engine/index.ts` 的 `acquireSourceToken()`，每音源一个令牌桶，容量 `max(1, ceil(ratePerMin/6))`，`ratePerMin <= 0` 直接放行，**默认 0 = 禁用**；
- **错误码真实枚举**（`core/download/errors.ts`，10 值）：`ERR_DNS` / `ERR_TIMEOUT` / `ERR_HTTP_4XX` / `ERR_HTTP_5XX` / `ERR_NO_SOURCE` / `ERR_ALL_SOURCES_FAILED` / `ERR_TAG_EMBED` / `ERR_DISK_FULL` / `ERR_BAD_REQUEST` / `ERR_UNKNOWN`；`errorToStatus`：`DISK_FULL`→507、`NO_SOURCE`→503、`TIMEOUT`→504、`BAD_REQUEST`→400、default→502。

### 3.2 订正清单（改了哪些文件、哪些描述）

| # | 文件 | 原描述（误） | 订正为（真） | 类别 |
|---|---|---|---|---|
| 1 | `docs/DEVELOPMENT.md` L64 | `│   ├── db/  # better-sqlite3 + drizzle-orm（任务/歌单/冒烟表）` | `# better-sqlite3 直连（任务/歌单/冒烟表；无 ORM，SQL 写在 db/*.ts）` | **事实错误**（batch0 后 drizzle-orm 已不存在） |
| 2 | `docs/SOURCES.md` L12 | 冒烟链路写作**三步** `search → musicUrl(128k) → HEAD 探测` | **五步** `search → musicUrl(128k) → HEAD 探测 → lyric → pic`，并给出 `SmokeStep` 出处 | **事实错误**（漏两步） |
| 3 | `API.md` `GET /api/v1/settings` 响应示例 | 只有 `auth`/`download`(6 字段)/`scrape`/`smokeTest` 四块，却自称「结构完整」 | 补齐为真实 `safeView()` 的**六块**：`download` 补 8 个字段（`resolvedDir`/`startupResolvedDir`/`dirTemplate`/`dedupePolicy`/`batchMaxItems`/`resume`/`diskPrecheck`/`minFreeBytes`），新增整块 **`sources`**（4 字段）与整块 **`search`**（5 字段），并加「字段说明」注 | **契约缺漏**（前端按此文档取值会漏两个块） |
| 4 | `API.md` `PATCH /api/v1/settings` 校验规则 | 只列 `download` 三条（`concurrency`/`defaultQuality`/`coverSize`） | 补齐 `settings.ts` 里**全部 16 条**校验（含 `sources.*` 四条：`healthAware` 布尔 / `circuitThreshold` 1–100 / `circuitWindowMs` 1000–3600000 / `ratePerMin` 0–100000），并新增「**未做服务端校验的字段**」注：`smokeTest.*` 与 `scrape.*` 不做强校验，非法 `cron` **不返回 400**，而是被 `scheduler.ts` 的 `cron.validate()` 拦下 → 该次不启动调度器、只记 `warn`（旧任务已在入口被 `stopSmokeScheduler()` 停掉，净效果是「定时冒烟静默不跑」） | **契约缺漏 + 行为误解**（原写法暗示 cron 会被 400 拒绝，实际不会） |
| 5 | `API.md` §11 健康冒烟开篇 | 只说「五步探测、结果落库、可查趋势」 | 新增**四个消费口径对照表**（L1 仅 `search`+`musicUrl` / 矩阵三色 / 告警五步全算 / 趋势仅 `head`），并明确「一个源可以矩阵 `red` 却被 L1 优先使用」是有意为之 | **本版新机制的必要说明** |
| 6 | `docs/DEVELOPMENT.md` 新增 §「音源质量闸门 L1/L2/L3」（+38 行） | 全文**原本没有任何 L1/L2/L3 机制描述**（只有目录树里两行模块名与「换源兜底流程」一段） | 新增权威章节：三层对照表（实现/数据来源/默认值/语义）、L2 熔断器的**三条常被误述的事实**（纯内存无持久化、无独立半开计时、与 L1 完全解耦）、L1 聚合口径的 v0.2.22 修正与 qdy 实测后果、已知盲区（`recentRunsOutcome` 宽口径）、**不存在的机制**（没有「429/403 自动降并发」）；同步加入文首目录 | **缺失补全**（把散落在代码注释里的机制收敛成单一真源） |
| 7 | `docs/SOURCES.md`「已知限制与运维提示」新增一条 | 无 | 「**HEAD 探测失败 ≠ 真实下载能力**」：mg/tx CDN 常拒 HEAD（405/410/502）而 GET 正常；自 v0.2.22 起 L1 只算 `search`/`musicUrl`；矩阵与告警口径仍含 head；指向 `docs/DEVELOPMENT.md` 权威章节 | **缺失补全**（正好解释本页矩阵里 qdy 的 mg/tx HEAD 失败记录该怎么读） |
| 8 | `server/src/core/config.ts` L54 注释 | `// L1: 按 smoke_results 近期成功率对候选音源排序（全失败源降权），默认 true` | 补「成功率只算 `search`/`musicUrl` 两个关键步骤（v0.2.22）」 | **代码注释口径同步** |
| 9 | `config.example.yaml` L72 注释 | `# healthAware: true # L1: 按 smoke_results 近 N 次成功率对候选音源排序（全失败源降权）` | 补「只算 `search`/`musicUrl` 两步，`head`/`lyric`/`pic` 不计入（v0.2.22）」 | **配置样例口径同步** |

### 3.3 原文其实是准确的、**未改**的清单

任务书要求「报告里列清楚哪些原文其实是准确的」。以下经逐条对账确认**准确，一字未改**：

| 文件 / 位置 | 描述 | 对账结论 |
|---|---|---|
| `API.md` L683（`GET /api/v1/play/:taskId`，O1 结果内试听） | 「与下载链路**共享**音源选择与限流（L1 健康排序 / L2 熔断 / L3 令牌桶都内建在 `resolveSourceOrder` 与 `sourceEngine.callAction` 里，本端点复用 orchestrator 自动继承）」 | **准确**。L1/L2 确实在 `orchestrator` 的候选筛选里（L102–104），L3 确实在 `SourceEngine.callAction` 路径的 `acquireSourceToken()` 里 |
| `API.md` §11 开篇（改动前） | 「`search → musicUrl → head → lyric → pic` **五步**探测」 | **准确**（与 `SmokeStep` 逐字符一致）。反倒是 `docs/SOURCES.md` 写的三步是错的 |
| `API.md` L1528（三色判定） | 「`search`/`musicUrl`/`head` 任一失败 → `red`；关键步骤全通但 `lyric`/`pic` 失败 → `yellow`；全通 → `green`」 | **准确**（对 `routes/health.ts` L24–28 逐条核过） |
| `API.md` L1534（趋势口径） | 「按天 × 平台聚合，**只统计 `head` 步骤**——即『直链可用性』口径」 | **准确**（`trend()` 的 SQL 确有 `AND step = 'head'`） |
| `API.md` 错误约定章（L1580 起） | 结构化错误体 + 10 个错误码 + HTTP 状态映射（含 507/`ERR_DISK_FULL`） | **准确**（与 `errors.ts` 的枚举与 `errorToStatus` 逐值一致） |
| `README.md` L33 / L156 | 「健康冒烟测试：定时跑真实下载链路，平台 × 音源矩阵 + Bark/Server酱 告警」及排错条目 | **准确**，且 README 全文**无 drizzle 提法**、无 L1/L2/L3 机制细节 → **不改**（用户向文档不该承载熔断器实现细节） |
| `docs/CHANGELOG-0.2.19.md` §6.1–6.3 | L1/L2/L3 的引入说明 | **准确**（阈值 5、窗口 5min、`ratePerMin` 默认 0=禁用、进程内存态，全部与代码一致） |
| `docs/CHANGELOG-0.2.20.md` §4.3 表格 | 「`server/node_modules/.bin/esbuild` 不可执行 → `SANDBOX_ELISION_SKIP`」 | **准确**——这是 v0.2.20 当时实现的如实记录（当时确为单候选硬编码）。v0.2.22 改的是实现，不是订正历史记录 |
| `docs/DEVELOPMENT.md` L79「换源兜底流程」 | 音质降级链 `flac24bit → flac → 320k → 128k` → `findMusic` 跨平台匹配 → 逐候选平台各试一次 → `completed_with_warnings` | **准确**（与 `orchestrator` / `adapters/match.ts` 一致），保留原样，新章节紧随其后 |

### 3.4 `docs/CHANGELOG-0.2.20.md` 是否追加勘误指针 → **否**

任务书指示：「已发布的 CHANGELOG-0.2.20.md **不改写正文历史**；**若确有实质性误述**，以『v0.2.22 勘误』形式追加简短更正指针」。

**核实结论：没有实质性误述，因此不追加勘误指针。** 证据：

```
$ grep -c "429\|drizzle\|令牌桶\|熔断\|降并发\|source_health\|半开" docs/CHANGELOG-0.2.20.md
0
```

该文件全文 250 行，主题是 v0.2.19 的 CI 失败根因（未使用具名 import 被 elide → 测试写真机库）与 v0.2.20 的隔离修复 + `isolation` 段，**完全没有涉及 L1/L2/L3 机制**，唯一相关的是 §4.3 表格里对 `SANDBOX_ELISION_SKIP` 触发条件的如实记录（见 §3.3）。往一份没写错的文件里追加「勘误」，本身就是在制造虚假的更正记录。

`docs/CHANGELOG-0.2.20.md` 本版**零改动**（`git diff` 无该文件）。真实机制的准确描述放在**本文 §3.1 与 `docs/DEVELOPMENT.md` 新章节**里，符合任务书「并在 CHANGELOG-0.2.22 里准确描述真实机制」的要求。

### 3.5 任务书列的两个假想误述在文档中根本不存在

任务书提示要核实「不存在『429/403 自动降并发』」与「无 `source_health` 表」。全仓 `grep`（排除 `node_modules` / `.git`）结论：

- **`降并发` / `自动降并发`**：**0 命中**。全仓没有任何文档声称存在此机制。
- **`source_health`**：**0 命中**。没有文档声称存在此表，代码里也确实没有（`db/` 下只有 tasks / playlists / smoke_results / meta 等表）。

即：这两条是**任务书为防误述而设的核对项，不是实际存在的误述**。本版把它们写进 `docs/DEVELOPMENT.md` 新章节的「**不存在的机制**」小节，作为**前瞻性防误述锚点**——将来若有人凭印象写下这类描述，文档里已有一条明确的反证可直接引用。

---

## 四、batch0：移除 drizzle 死依赖

### 4.1 死依赖取证

| 取证项 | 命令 | 结果 |
|---|---|---|
| 源码/测试是否 import | `grep -rn "drizzle" server/src server/test` | **0 命中** |
| 是否存在 drizzle 配置文件 | `find . -name "drizzle.config.*" -o -name "drizzle" -type d`（排除 node_modules） | **0 命中** |
| 是否有 migration 目录 | `ls server/drizzle server/migrations` | **不存在** |
| `package.json` 声明 | — | `dependencies.drizzle-orm = ^0.38.0`、`devDependencies.drizzle-kit = ^0.30.0` |

结论：**纯死依赖**（声明了但从未被任何代码路径引用）。按任务书「不升级、直接删声明」处理——升级它需要跨 major 且会引入本项目根本不用的 ORM 行为变化，删除是唯一正确动作。

`server/package.json` 净变更 **+2 / −5**（删除 3 行声明 + 2 行版本号变更，见 §五 §六）。

### 4.2 连带发现：本地门禁的 isolation 护栏会**静默变成装饰**（本版最重要的次生修复）

删掉 `drizzle-kit` 之后，`server/node_modules/.bin/esbuild`（那份 **0.19.12** 正是 drizzle-kit 的传递依赖）**随之消失**。而 `scripts/verify-ci.sh` 的 `stage_isolation()` 当时是**单候选硬编码**：

```bash
local esbuild="$REPO_ROOT/server/node_modules/.bin/esbuild"
if [[ ! -x "$esbuild" ]]; then
    log "SANDBOX_ELISION_SKIP：未找到 esbuild …"    # ← 会走到这里
else
    …
fi
```

危险之处在于**失败模式是静默的**：

1. `SANDBOX_ELISION_SKIP` 只是一行黄色 `log`，**不置 `rc_iso=1`**；
2. 它**也不增加 `SKIP_COUNT`**（`SKIP_COUNT` 只在段级 SKIP 时递增，isolation 段整体仍会跑 `DB_CANARY`）；
3. 于是 isolation 段**返回码仍是 0**，汇总里照样打印 `门禁结论：PASS（可发布）`。

净效果：v0.2.19 烧号根因（沙箱 import 被 elide → 测试写真机库）的**编译期护栏彻底失效，而门禁仍报全绿**。任务书要求「`verify-ci.sh --skip-docker`（含 isolation 段）全绿」——如果只做 batch0 而不修这里，这条要求就会变成一句空话。

对照之下，`.github/workflows/build.yml` 的同名护栏**本来就是三级候选**（v0.2.21 项1 的成果），且三级全落空时 `::error::` + `exit 1`（**不静默跳过**）。两处护栏的健壮性不对称，正是本地这道会静默降级的原因。

### 4.3 `scripts/verify-ci.sh` 三级候选 **+ 兜底语义硬红**改造（+65 / −5）

本节改动分**两步**落地，第二步由发布前 CodeReview 补出（它指出第一步的「同构」是**过度声明**）：

- **① 候选解析**（首版）：单候选硬编码 → 三级候选，并打印实际选中的转译器与版本作为证据行；
- **② 兜底语义**（CodeReview 后补）：三级候选**全落空时 `rc_iso=1` 硬红**，另补 `build.yml` 的汇总证据行。

**为什么只做 ① 不构成同构**：`run_stage()` 的口径是「`rc==2` 才记 SKIP、`rc==0` 记 PASS」，而 `SKIP_COUNT` 只在 `record` 收到 `SKIP` 时递增。改前那条全落空分支只 `log SANDBOX_ELISION_SKIP` 却**不置 `rc_iso`**（仍为 0）→ 本段被记为 **PASS**，连「N 个作业被跳过」的告警都不触发；而 `build.yml` 同场景是 `::error::` + `exit 1` **硬红**。也就是说 ① 只**降低了触发这条分支的概率**，并没有改变 §4.2 自己点名为 bug 的「缺失即静默 PASS」语义——护栏仍会变装饰，只是更难触发（与 v0.2.19 烧号同一类漏检面）。

改后的兜底分支（与 `build.yml` 逐点对齐）：

```bash
# esbuild 三级候选（与 build.yml 的 SANDBOX_ELISION 护栏**真同构**：候选顺序、证据行、汇总行、
# 以及「全落空即硬红」的兜底语义四项全部对齐，详见上方 v0.2.22 修正 ①②）。
# 选中结果存进数组 esb_cmd（③ 是多词的 npx 调用，故用数组而非字符串，避免引号/分词坑）。
local -a esb_cmd=()
local esbuild_label="" c
for c in \
    "$REPO_ROOT/server/node_modules/tsx/node_modules/esbuild/bin/esbuild" \
    "$REPO_ROOT/server/node_modules/.bin/esbuild"; do
    if [[ -x "$c" ]]; then esb_cmd=("$c"); esbuild_label="${c#"$REPO_ROOT"/}"; break; fi
done
if [[ ${#esb_cmd[@]} -eq 0 ]] && (cd "$REPO_ROOT/server" && npx --no-install esbuild --version >/dev/null 2>&1); then
    esb_cmd=(npx --no-install esbuild); esbuild_label="npx --no-install esbuild"
fi
```

```bash
if [[ ${#esb_cmd[@]} -eq 0 ]]; then
    # 与 build.yml **真同构**的兜底：三级候选全落空 = npm ci 没装 devDependencies = 环境异常
    # → rc_iso=1 硬红（对齐 build.yml 的 ::error:: + exit 1）。
    log "SANDBOX_ELISION_FAIL：三级候选均未找到可执行的 esbuild，护栏无法执行 → 按环境异常硬红"
    log "    后果：沙箱 elision 无从判定，v0.2.19 烧号根因（测试写进真机 data/ro.db）失去编译期拦截"
    log "    修法：cd server && npm ci —— 一级候选即 tsx 自带的 node_modules/tsx/node_modules/esbuild/bin/esbuild"
    rc_iso=1
fi
```

**「真同构」的准确边界**（避免把同构做成过度硬红）：需对齐的是**四项**——候选顺序、证据行、汇总行（`checked=/elided=/unverifiable=`，首版缺失，本次补上）、全落空即硬红。而以下三种情形**仍保留 SKIP**，因为 `build.yml` 同场景也只 `::warning::`，语义是「护栏**无从行使**」而非「护栏被静默跳过」：① 无 sha256 工具；② 有进程正持有真机 `data/ro.db`（会被其合法写入，比对无意义）；③ `server/test` 不存在、或其中没有任何文件 import `fixtures/env-sandbox`（`checked=0`，`build.yml` 同场景打印「护栏本轮为空转」）。

三级候选的语义（已同步写进文件头注释）：

| 级 | 路径 | v0.2.22 后的状态 |
|---|---|---|
| ① | `server/node_modules/tsx/node_modules/esbuild/bin/esbuild` | **命中**，版本 **0.28.1**。这是与 `npm test`（= `tsx --test`）**实际使用的转译器同源**的那一份，判定最忠实 |
| ② | `server/node_modules/.bin/esbuild` | **恒落空**（原本由 drizzle-kit 传递带入 0.19.12）。保留只为兼容显式装了 esbuild 的现场 |
| ③ | `npx --no-install esbuild` | 兜底，只用已装好的，**绝不联网拉包** |

两处实现细节：

- **用数组而非字符串存命令**：候选 ③ 是 `npx --no-install esbuild` 三个词，字符串形式在 `"$esbuild" --format=esm` 里会被当成单个（含空格的）可执行文件名。数组 `"${esb_cmd[@]}"` 才能正确分词。
- **转译时 `cd "$REPO_ROOT/server"`**：候选 ③ 的 `npx` 需在该目录才能解析到本地 `node_modules`；候选 ①② 是绝对路径不受影响；被转译的 `$f` 也是绝对路径。

同步新增的注释（`stage_isolation()` 上方）把这条**为什么会静默失效**的推理完整留档，避免将来有人又把候选链简化回单路径。

改造后自检（四项，全部实测）：

1. `bash -n scripts/verify-ci.sh` → rc=0（SYNTAX OK）；`grep -c '\$esbuild'` → **0 处残留**（旧单数变量已彻底消除）；`esb_cmd` / `esbuild_label` 引用点集中在 L366–437。
2. **`usage()` 的 sed 范围未被破坏**：`usage() { sed -n '2,51p' "$0" …; }` 硬依赖 header 区行数，故本次对 header 的改动刻意做成 **L21–22 两行原地替换（2 行 → 2 行）**；脚本校验 L2–L51 全为注释/空行、`--help` rc=0 且输出 50 行含新措辞。
3. **`$VAR` + 非 ASCII 字节扫描**：bash 3.2 在 UTF-8 locale 下会把紧跟 `$IDENT` 的多字节首字节吞进变量名（有 `set -u` → rc=127 中断；无 `set -u` → **静默打印空值+乱码**）。用字节正则 `\$[A-Za-z_][A-Za-z_0-9]*[\x80-\xff]` 扫 `verify-ci.sh` 与 `build.yml` → **两文件 0 命中**；新增行一律用 `${VAR}` 花括号形式。
4. **A/B 隔离 harness 负向实测**（证明是行为差异而非文案差异）：把 `verify-ci.sh` 的 L1–L761（infra + 全部 stage 函数 + `run_stage` 定义，不含作业链）原样截出为 harness，在「`server/test` 有真沙箱测试文件但**无 `node_modules`**」的隔离根下只跑 isolation 段，同一场景分别用**改前（HEAD）**与**改后**两版脚本：

| 版本 | 输出 | `[isolation]` | 门禁 |
|---|---|---|---|
| BEFORE（`a0ee445` 改前） | `SANDBOX_ELISION_SKIP` | **PASS** | `FAIL_COUNT=0` → **exit 0**（静默放行） |
| AFTER（本次改动） | `SANDBOX_ELISION_FAIL` + 后果/修法两行 | **FAIL** | `FAIL_COUNT=1` → **exit 1**（禁止发布） |

   同 harness 的正向对照（把 `server/node_modules` 软链到真仓库）→ 一级候选命中、`SANDBOX_ELISION_PASS`、`[isolation] PASS`，证明硬红**不是一律红**、不会误红正常门禁。

### 4.4 `.github/workflows/build.yml` 文案订正 **+ 一处潜伏的 `$BIN` 花括号缺失**（+5 / −4）

CI 侧护栏的**逻辑本来就是对的**（三级候选 + 全落空即红，本次 §4.3 ② 正是向它对齐），但有两处文案在 batch0 后过时（属 batch0 的连带文档一致性）；另在 §4.3 自检第 3 项的字节扫描过程中**顺带发现并修掉一处与 batch0 无关的潜伏缺陷**：

| 行 | 原文 | 订正为 |
|---|---|---|
| L120–121 注释 | 「其次 `node_modules/.bin/esbuild`（**drizzle-kit 的传递依赖**）」 | 「其次 `node_modules/.bin/esbuild`（**v0.2.21 及之前**由 drizzle-kit 传递带入 0.19.12；**v0.2.22 移除 drizzle 死依赖后此候选恒落空**，保留只为兼容显式装了 esbuild 的现场）」 |
| L133 `::error::` 文案 | 「未找到 esbuild 可执行文件（npm ci 应已随 **tsx / drizzle-kit** 装入）」 | 「未找到 esbuild 可执行文件（npm ci 应已随 **tsx 装入其嵌套副本**）」 |
| **L250 `fpk` job 诊断输出** | `…将走官方 fnpack 打包路径（FNPACK_BIN=$BIN）` | `…（FNPACK_BIN=${BIN}）`——`$BIN` 后紧跟全角右括号 `）`（首字节 `EF`），bash 在 UTF-8 locale 下会把它吞进变量名。该 step **没有** `set -u`，且 GitHub Actions 默认 shell 是 `bash -e {0}`（也无 `-u`），故发作形态不是崩溃而是**静默打印 `FNPACK_BIN=` + 一串乱码**——诊断行本身成了错误信息。本地用 `locale × shell` 矩阵实测定性：`LANG=C` 与 zsh 正常；`LANG=C.UTF-8/en_US.UTF-8/UTF-8` 下 bash 有 `set -u` 则 rc=127、无 `set -u` 则静默丢值；`${BIN}` 加花括号后**全 locale 恒正常** |

**这同时兑现了 `docs/CHANGELOG-0.2.21.md` §八.2 的一条遗留预警**：

> 若将来 `tsx` 换成不内置 esbuild 二进制的版本、且 `drizzle-kit` 也被移除，三级候选会全落空 → 护栏**直接红**。

本版正好移除了 `drizzle-kit`。核实结论：**一级候选 `tsx/node_modules/esbuild` 0.28.1 仍在**（`tsx ^4.19.0` 仍内置 esbuild 二进制），护栏可用、**不会红**；且本地门禁这道原本会**静默降级**的护栏已补齐为**真同构**的三级候选 + 全落空即硬红（§4.3）。这条遗留因此从「预警」变为「已处置」，本文 §十二 记录其当前状态。

`build.yml` L95 那条指向 `docs/CHANGELOG-0.2.20.md §八.1` 的 **v0.2.20 历史注刻意保留未动**（是版本演进留档，不是承载点）。

---

## 五、batch1：`@fastify/static` 8.3.0 → 10.1.4

### 5.1 用法面核实（全仓仅一处）

```ts
// server/src/index.ts L3
import fastifyStatic from '@fastify/static'
// server/src/index.ts L114-118
// Web 后台静态资源（web/ 目录），放最后避免抢占 /api 路由
await app.register(fastifyStatic, {
  root: path.join(ROOT_DIR, 'web'),
  prefix: '/',
})
```

`grep -rn "@fastify/static" server/src server/test web/` → 仅上述 import + register 两处。

### 5.2 breaking change 影响判定

v8 → v10 的唯一 breaking 是 **`setHeaders` 回调签名变更**（改为 `onSend` 风格的钩子形态）。本项目**根本没传 `setHeaders`**（options 只有 `root` 与 `prefix`）→ **不触及**。`root` + `prefix` 这两个 option 的语义在 v8/v9/v10 三版间保持不变，静态资源伺服逻辑（含「放最后避免抢占 `/api` 路由」的注册顺序）**一字未改**。

### 5.3 升级动机（安全）

修掉 2 条 **high** 公告（`npm audit` 的 `via` 标题原文）：

- `@fastify/static vulnerable to path traversal in directory listing`
- `@fastify/static vulnerable to route guard bypass via encoded …`

公告影响范围 `<=10.1.1`，**10.1.4 已在其之外**。这正是 v0.2.21 §4.4 里被 DEFER 的 4 项 prod high 之一（当时理由：`isSemVerMajor=true`，不在维护版本里动）。本版单开升级窗口兑现。

### 5.4 lockfile 连带

`@fastify/static` 10.1.4 引入了自己嵌套的 `fastify-plugin@6.0.0`（本版 lockfile 里**唯一新增**的包），并把 `content-disposition` 从 0.5.4 带到 3.0.0、`glob` 从 11.1.0 带到 13.0.6、`brace-expansion` 5.0.9→5.0.12、`lru-cache` 11.5.2→11.5.3（详见 §八）。

---

## 六、batch2：`node-cron` 3.0.3 → 4.6.0

### 6.1 用法面核实（全仓仅一处）

`server/src/core/smoke/scheduler.ts`（41 行），用到 4 个 API：`cron.validate(expr)`、`cron.schedule(expr, fn)`、`task.stop()`、`cron.ScheduledTask` 类型。`grep -rn "node-cron" server/` → 仅此文件（另 `test/fixtures/settings-probe.ts` L98 有一条纯注释提及）。

### 6.2 v4 的 API 保留情况与**唯一需要的适配**

核实 `node_modules/node-cron/dist/node-cron.d.ts`（v4.6.0）：

```ts
export { createTask, nodeCron as default, getTask, getTasks, nodeCron, parse, schedule,
         setLogger, setRunCoordinator, shutdown, solvePath, validate, validateDetailed };
export type { CronFieldError, DetailedValidation, LastRun, Logger, NodeCron, ParsedFields,
              RunCoordinator, ScheduledTask, SkipReason, TaskContext, TaskFn, TaskOptions };
```

- **默认导出保留** ✅ → `import cron from 'node-cron'` 不变；
- `NodeCron` 接口含 `schedule: typeof schedule` 与 `validate: typeof validate` ✅ → `cron.validate()` / `cron.schedule()` 不变；
- `ScheduledTask.stop(): void | Promise<void>` ✅ → `task.stop()` 不变（返回值本来就被丢弃）；
- **唯一 breaking（类型层）**：`ScheduledTask` 在 v3 是默认导出的**命名空间成员**（`cron.ScheduledTask`），在 v4 变成**独立的具名类型导出**。原写法直接编译失败：

```
src/core/smoke/scheduler.ts(10,11): error TS2503: Cannot find namespace 'cron'.
```

适配（**+8 / −2**，其中 6 行是解释性注释，代码只动 2 行）：

```ts
import cron, { type ScheduledTask } from 'node-cron'
…
let task: ScheduledTask | null = null
```

用**内联 `type` 修饰符**而非独立的 `import type { … }` 语句：内联形式在转译时会被正常 elide（这是**应该的**——它确实是纯类型），而默认导入 `cron` 本身被 `cron.validate` / `cron.schedule` 实际使用，**不会被删**。运行时行为与 v3 完全一致。

> 这里刻意多写了几行注释说明 elision 语义：v0.2.19 的烧号根因正是「未使用的具名 import 被 esbuild 整行 elide」。虽然那条教训只适用于**带副作用的模块**（`env-sandbox`），而 `node-cron` 的类型导入被 elide 是正确行为，但把「为什么这里 elide 是安全的」写在现场，能防止将来有人误以为这也是隐患而改成裸副作用 import（那反而会引入不必要的运行时耦合）。

`validate` → `schedule` → `stop` 的**validate-then-schedule 逻辑一字未改**：非法表达式仍是「`logger.warn` + 不启动调度器 + 直接 return」，不抛异常。

### 6.3 移除 `@types/node-cron`

v4 **自带类型**（`types: ./dist/node-cron.d.ts`）。`@types/node-cron@^3.0.11` 若共存会与自带类型冲突（同名模块的两份声明），必须移除。已删。

### 6.4 `uuid` 传递依赖自动消失

v3.0.3 依赖 `uuid@8.3.2`（该版本有 `Missing buffer bounds check in v3/v5/v6 when buf is provided` 公告）。v4.6.0 的 `package.json` 里 **`dependencies` 为 `null`（零运行时依赖）** → `uuid` 随 `npm install` 自动消失，**无需单独处理**（与任务书判断一致）。lockfile 审计已确认 `node_modules/uuid` 不在 after 树中。

---

## 七、`npm audit`：11 → 3

三批依赖变更的合并安全收益（`npm audit --registry=https://registry.npmjs.org`，before 用变更前的 `package.json` + `package-lock.json` 快照独立跑）：

| | before（v0.2.21） | after（v0.2.22） | Δ |
|---|---|---|---|
| 总公告数 | **11** | **3** | **−8** |
| high | **4** | **2** | −2 |
| moderate | **7** | **1** | −6 |
| 包总数（lock `packages`） | **280** | **204** | **−76** |

**本版消掉的 8 项**（按批归因）：

| 包 | 严重度 | 公告 | 由哪批消掉 |
|---|---|---|---|
| `@fastify/static` | **high** | 目录列表路径穿越；编码绕过路由守卫 | **batch1**（→ 10.1.4，超出 `<=10.1.1`） |
| `drizzle-orm` | **high** | SQL injection via improperly escaped SQL identifiers | **batch0**（整包移除） |
| `drizzle-kit` | moderate | 传递引入 `@esbuild-kit/esm-loader` 与 `esbuild` | **batch0** |
| `@esbuild-kit/esm-loader` | moderate | 传递引入 `@esbuild-kit/core-utils` | **batch0**（连带） |
| `@esbuild-kit/core-utils` | moderate | 传递引入 `esbuild` | **batch0**（连带） |
| `esbuild` 0.19.12 | moderate | dev server 允许任意网站发请求 | **batch0**（连带；`tsx` 自带的 0.28.1 不在受影响范围 `<=0.24.2` 内） |
| `node-cron` 3.0.3 | moderate | 传递引入 `uuid` | **batch2**（→ 4.6.0 零依赖） |
| `uuid` 8.3.2 | moderate | v3/v5/v6 缺 buffer 边界检查 | **batch2**（连带） |

**仍留在册的 3 项**（均需跨 major，本版**不动**）：

| 包 | 严重度 | 修复需要 | 为什么本版不动 |
|---|---|---|---|
| `sharp` `<=0.35.4-rc.0` | **high** | `sharp@0.35.4`（breaking） | 原生模块，跨 major 涉及 libvips ABI 与容器内编译链，必须单独窗口 + 真机回归（封面缩放/嵌入路径） |
| `music-metadata` `<=11.12.1` | **high** | `music-metadata@11.16.0`（breaking） | 标签解析是下载管线的核心路径（FLAC/MP3 元数据读写），跨 major 需专门验证 |
| `file-type` `13.0.0 - 21.3.0` | moderate | 随 `music-metadata` 升级 | 上一项的传递依赖，无独立修复动作 |

**对比 v0.2.21 的 DEFER 清单**：当时 DEFER 的 11 项里，prod high 4 项（`@fastify/static` / `drizzle-orm` / `music-metadata` / `sharp`）本版**消掉 2 项**（正是任务书点名的 batch0/batch1），剩余 2 项（`music-metadata` / `sharp`）继续 DEFER，理由同上。

---

## 八、lockfile 归一与 integrity 逐字节校验

### 8.1 为什么必须显式指定 registry

本机 `~/.npmrc` 的 `registry` 指向**内网镜像**。该文件**不在仓库内、也不入 git**（仓库根与 `server/` 下均无 `.npmrc`），但若直接 `npm install`，写进 `package-lock.json` 的 `resolved` 字段就会带上内网主机名——**公开发布的仓库里泄漏内网基础设施地址**，且 CI runner 与任何第三方克隆都无法解析这些 URL（`npm ci` 直接失败）。

因此安装命令显式覆盖：

```bash
npm install --registry=https://registry.npmmirror.com --no-audit --no-fund
```

（沿用 #213 的做法。`--no-audit` 是因为安装时的 audit 会走同一 registry，而内网镜像的 audit 端点不可靠；审计单独用公网 registry 跑，见 §七。）

### 8.2 七段程序化审计（一次性脚本，**未入库**）

| 段 | 检查项 | 结果 |
|---|---|---|
| ① | `resolved` 主机白名单（只允许 `registry.npmmirror.com` / `registry.npmjs.org`） | **200 npmmirror + 3 npmjs = 203**，全部在白名单 ✅（before：276 + 3 = 279） |
| ② | 内网 / 失效 registry 字面扫描（内网 anpm 主机、`alibaba-inc`、`npm.alibaba`、已停服的 `registry.npm.taobao.org`） | **0 命中** ✅ |
| ③ | `integrity` **逐字节**比对（同 key 同 version 的条目，before vs after） | 可比 **196** 条，漂移 **0** 条 ✅ |
| ④ | `resolved` URL 漂移（同版本条目的 URL 是否被改写） | **0** 条 ✅ |
| ⑤ | 变更集合审计 | removed **77** / added **1** / version-changed **6**；280 → 204 |
| ⑥ | 目标断言 | `@fastify/static` = **10.1.4** ✅、`node-cron` = **4.6.0** ✅、`drizzle-orm` / `drizzle-kit` / `@types/node-cron` / `uuid` **均已移除** ✅、`tsx/node_modules/esbuild` **仍在 = 0.28.1**（护栏一级候选）✅、`node_modules/esbuild` **不存在**（二级候选如期消失）✅ |
| ⑦ | `lockfileVersion` 与顶层 version 一致性 | `lockfileVersion = 3`（未变）；顶层 `version` = `packages[""].version` = **0.2.22** ✅（bump 已同步改这两处） |

**`integrity` 零漂移是关键结论**：它证明本版对 lockfile 的改动**纯粹是依赖树的增删**，没有把任何已有包换成不同来源的产物——`resolved` 主机归一没有以牺牲校验和为代价。

**3 条 npmjs `resolved` 的来源**：v0.2.21 §4.5 已留档，是 `npm audit fix` 的固有副作用（audit fix 从公网 registry 取元数据后回写 `resolved`）。本版未触碰这 3 条（段④ 漂移 0），**也不做人为改写**——改写 `resolved` 会让它与实际取包来源不一致，比「混用两个公网 registry」更糟。两个都是公网可达的正规 registry，CI 与第三方克隆均可正常 `npm ci`。

### 8.3 removed 的 77 个包（按来源归并）

| 来源 | 包 |
|---|---|
| `drizzle-orm` 本体 | `drizzle-orm` 0.38.4 |
| `drizzle-kit` 本体及其直接依赖 | `drizzle-kit` 0.30.6、`@drizzle-team/brocli`、`esbuild-register`、`gel`、`env-paths`、`get-tsconfig`、`resolve-pkg-maps`、`source-map`、`source-map-support`、`buffer-from`、`cross-spawn`、`which`、`isexe`、`jackspeak`、`@isaacs/cliui`、`foreground-child`、`shebang-command`、`shebang-regex`、`signal-exit`、`path-key`、`shell-quote`、`package-json-from-dist`、`@petamoriken/float16` |
| `@esbuild-kit/*` 链 | `@esbuild-kit/core-utils` 3.3.2、`@esbuild-kit/esm-loader` 2.6.5，及其嵌套 `esbuild` 0.18.20 + 18 个平台包 |
| `esbuild` 0.19.12 及其平台包 | `esbuild` 0.19.12 + 22 个 `@esbuild/*` 平台包 |
| `node-cron` v3 的依赖 | `uuid` 8.3.2 |
| devDependency | `@types/node-cron` 3.0.11 |

added 的 1 个：`@fastify/static/node_modules/fastify-plugin` 6.0.0（见 §5.4）。

version-changed 的 6 个：`<root>` 0.2.21→0.2.22（bump）、`@fastify/static` 8.3.0→10.1.4、`node-cron` 3.0.3→4.6.0、`brace-expansion` 5.0.9→5.0.12、`content-disposition` 0.5.4→3.0.0、`glob` 11.1.0→13.0.6、`lru-cache` 11.5.2→11.5.3（后四项为 `@fastify/static` v10 的传递依赖）。

---

## 九、版本承载点 bump 清单（0.2.21 → 0.2.22，8 文件 / 12 处）

| # | 文件 | 行 | 承载点 | 改法 |
|---|---|---|---|---|
| 1 | `server/package.json` | L3 | `"version": "0.2.22"` | 脚本按行号整行替换 |
| 2 | `server/package-lock.json` | L3 | 顶层 `"version": "0.2.22"` | 同上 |
| 3 | `server/package-lock.json` | L9 | `packages[""].version` | 同上 |
| 4 | `server/src/routes/status.ts` | L15 | `GET /api/v1/status` 的 `app.version` | 同上 |
| 5 | `server/src/core/adapters/scrape-detail.ts` | L295 | MusicBrainz UA 串 `Rainbow/0.2.22` | 同上 |
| 6 | `fpk/manifest` | L2 | `version=0.2.22` | 同上 |
| 7 | `fpk/manifest` | L25 | `changelog=` 文案**整体改写**为 0.2.22 说明（首版 788 字符；本次 amend 订正为 **797** 字符，仍单行） | python 整行替换 |
| 8 | `docs/FNOS-DEPLOY.md` | L1 | 标题 `# Rainbow fnOS 部署指南（v0.2.22）` | 脚本按行号整行替换 |
| 9 | `scripts/verify-image.sh` | L7 | 用法注释里的默认镜像 tag | 同上 |
| 10 | `scripts/verify-image.sh` | L10 | 参数说明里的默认镜像 tag | 同上 |
| 11 | `scripts/verify-image.sh` | L33 | `IMAGE="${1:-${IMAGE:-rainbow-music:v0.2.22}}"` | 同上 |
| 12 | `API.md` | L1075 | `GET /api/v1/status` 响应示例的 `"version"` | 同上 |

**改法纪律**（沿用 v0.2.21 §6.6 的踩坑留档）：机械版本号走**按行号整行替换的脚本**，且替换前**断言旧行内容与预期逐字符相等**——任何一处不匹配则**整体不落盘**。这条纪律本版当场生效了一次：`scrape-detail.ts` L295 的断言失败，暴露出该行的括号内侧**已含空格**（`Rainbow/0.2.21 ( https://… )`）。用字节级 `repr()` 复核确认这是 **v0.2.21 既有形态、非终端渲染假象**，属既有 UA 串的细节（RFC 7231 的 comment 允许空格，功能无碍）。本版**只改版本号、不顺手动 UA 形态**（改它属于无关的出站请求头变更），在此留档供将来单独处置。

**收口自检**（脚本化，三段全 PASS）：

- **① 12 处承载点逐处核对**：用**带上下文的正则**（不是裸版本号计数——本版 item1/item2 的散文里也写了「v0.2.22」字样，裸计数会把说明文字误当承载点）→ 合计 **12 / 12**，逐条 OK。
- **② 残留旧版本号逐行核对**：全仓（排除 `node_modules` / `.git` / `dist` / `dist-fpk` / `data`）共 **61 行**含 `0.2.21`，**越界 0 行**——按文件分布（均为合法引用）：

  | 文件 | 行数 | 为何允许 |
  |---|---:|---|
  | `docs/CHANGELOG-0.2.22.md` | 29 | **本文自身**通篇合法引用上一版：标题「v0.2.21 → v0.2.22」、before/after 对比表、对「v0.2.21 §八.2 遗留」与「v0.2.21 §6.6 踩坑留档」的交叉引用，以及 **② 小节自身的 6 行**（本分布表 5 行 + 上文那句统计口径说明） |
  | `docs/CHANGELOG-0.2.21.md` | 23 | **已发布历史文件**，铁律：不改写正文历史 |
  | `API.md` | 5 | L408 / L465 / L1192 / L1580 / L1612 的「v0.2.21 起」行为变更说明，是历史事实陈述，改了就是篡改契约演进记录 |
  | `.github/workflows/build.yml` | 2 | L93 指向 v0.2.20 §八.1 的历史注、L120「v0.2.21 及之前由 drizzle-kit 传递带入」（§4.4 本版新写的版本边界说明） |
  | `docs/FNOS-DEPLOY.md` | 1 | L371 的前向声明（§十二.7 已连续顺延四版，建议下个真机窗口直接删除） |
  | `scripts/verify-ci.sh` | 1 | L24 的同款「v0.2.21 及之前由 drizzle-kit 传递带入」历史说明（§4.3） |

  > **为何从 32 变成 61（以及为何 61 就是收敛值）**：本文写成**之前**跑过一次同一脚本，当时残留 32 行（本文尚不存在）；本文入库后自身贡献 29 行合法引用，故为 61 行。而这 29 行里有 **6 行来自 ② 小节自身**——**描述残留分布的表格，其单元格内必然要写出被统计的字面版本号**，与 §10.4「把黑名单列出来作踩坑留档」是同一类自指。好在这里对**「残留行数」这个指标是收敛的**：本次订正新增的两行留档（即下一段）不含任何字面版本号，改完重跑脚本仍得 **61**（已实测复核，非推算）。但注意**附录的自指行数是另一个独立指标**——它确实因这 2 行而变化（T 从 732 变为 734），故同步用 `t219-scratch/fix-appendix-selfref.py` **幂等重算**而非手填；两个指标不得混用同一句「不变」。**本次 amend 后追加实测**：正文又长了（§4.3 的两步叙事与 A/B 自检、§10.3 的证据行、§十二.4 的订正留档、§10.4 的字典扩充与转义踩坑留档），T 由 734 进一步变为 **781**，仍由 `t223-scratch/fill-appendix-t223.py` **幂等重算**（连跑两次 sha256 逐字节相同，已实测）；而**「残留 61 行」这个指标依旧不变**——新增行文只引用 `v0.2.19` / `v0.2.22`，**不含被统计的那个旧版本号字面量**（本句刻意用指代而不写出字面量：写一下就会让「残留合计」+1，从而把它自己声称的「不变」推翻；这与 §10.4「把黑名单列出来作踩坑留档」是同一类自指，区别在于留档是**有意**自指并由检查器显式排除，而这里是**无意**自指、且没有任何排除机制，只能靠不写字面量来避免）（重跑 `bump-verify-t223.py` 实测：残留合计 61 行、越界 0 行，非推算）。检查器的允许清单已相应纳入本文（整文件允许）；承载点数（①）与 `fpk/manifest` 结构（③）**不受影响**，越界判定也不变。
  >
  > **微型踩坑留档（两条，对后续维护者有用）**：① **自检脚本的白名单必须把「描述本次变更的文档」算进去**，否则文档写得越完整、自检越红（本节与 §10.4 双双因此误红过一次）；② **凡是把自检结果写进文档，就要预期该文档本身会改变下一次自检结果**——只有当订正是「行内改数字」时才收敛于不动点，若订正需要新增行，就必须迭代到稳定或改用「见脚本输出」这类不落数字的写法。**本次 amend 又实测到一次 ②**：追加的那句「新增行文……不含被统计的那个旧版本号字面量」**自己就写出了该字面量**，于是残留计数由 61 变 62、当场推翻了同一句里声称的「不变」（脚本改前改后各跑一次实测，非推算）；修法是把字面量换成指代——这也是为什么本句同样只用「那个旧版本号」指代、不复述字面量。
- **③ `fpk/manifest` 结构自检**：17 个活跃键、无重复键、无非法行；`changelog` 单行 **797** 字符（本次 amend 由 788 变为 797：例数 8 → 9，且「L1 健康聚合」扩为「L1 健康聚合与 L2 熔断回退」以涵盖第 8/9 两例的 L2 语义）、不含旧版本号；12 个关键文案锚点（`search 与 musicUrl` / `@fastify/static` / `8.3.0 到 10.1.4` / `node-cron` / `3.0.3 到 4.6.0` / `drizzle-orm` / `drizzle-kit` / `@types/node-cron` / `进程内存态` / `429/403 自动降并发` / `三级 esbuild 候选` / `回归测试 9 例`）全部命中。

---

## 十、验证证据矩阵

### 10.1 类型检查（batch1 / batch2 的兼容性实证）

```
$ cd server && npm run typecheck
> rainbow-server@0.2.22 typecheck
> tsc --noEmit
（无输出，rc=0）
```

这一步是 batch1/batch2 的**关键实证**：`@fastify/static` v10 与 `node-cron` v4 的类型契约均由 `tsc --noEmit` 全量校验。过程中 `node-cron` v4 暴露了唯一一处类型形态 breaking（`TS2503 Cannot find namespace 'cron'`），已在 §6.2 处置；处置后**零错误**。

环境：Node **v23.10.0** / npm **10.9.2** / TypeScript `^5.7.0`。

### 10.2 单元测试（含本版新增 9 例）

```
$ cd server && npm test
ℹ tests 231
ℹ suites 29
ℹ pass 231
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 60998.645542
```

- **231 / 231 pass、0 fail、0 skipped、0 todo**（v0.2.21 是 222 / 222，本版 **+9** 正是 `source-health-l1.test.ts` 的 9 例）；
- 新增 suite 输出：`✔ L1 修复：诊断性 head 步骤不得参与音源健康聚合 (47.437042ms)`，**9 例全 ✔**（第 9 例「L2 回退分支」与其余 8 例同住这一个 `describe`，共用沙箱 fixture 与造数辅助函数；suite 名沿用首版未改，故它虽含一例 L2 语义仍叫「L1 修复」——用例名本身已写明 L2）；
- **无新增 `.skip` / `todo`，无放宽或删除任何既有断言**；
- 全部 231 例在**沙箱**内运行（`fixtures/env-sandbox.ts` 改写 `RO_CONFIG` / `RO_DB_DIR` / `RO_LOG_LEVEL`），真机 `data/ro.db` 未被触碰（由 isolation 段的 `DB_CANARY` 机械化验证，见 §10.3）。

### 10.3 本地门禁 `scripts/verify-ci.sh --skip-docker`（含 isolation 段）

```
$ FNPACK_BIN=<repo>/tools/fnpack ./scripts/verify-ci.sh --skip-docker
[verify-ci] Rainbow 本地 CI 门禁启动：作业链 heal → meta → build → test → isolation → docker → fpk
…
  PASS     heal
  PASS     meta
  PASS     build
  PASS     test
  PASS     isolation
  SKIP     docker
  PASS     fpk

⚠ 注意：1 个作业被跳过（SKIP），其结论未经本门禁验证
[verify-ci] 门禁结论：PASS（可发布）          rc=0
```

| 段 | 结论 | 关键证据行 |
|---|---|---|
| heal | PASS | `HEAL_SYNTAX_PASS`（`bash -n`）、`HEAL_EXITCODE_PASS`（`--help`=0 / 未知参数=1 / 非 root `--dry-run`=4 契约在位）、`HEAL_REDLINE_PASS`（530 断联红线关键字 5 条全部在位）、`HEAL_DANGER_PASS`（reboot/restart 命中行均为禁止类提示文案，无真实重启动作） |
| meta | PASS | `VERSION 未指定，取 fpk/manifest：0.2.22`、`version=0.2.22  image=rainbow-music:v0.2.22  platform=linux/arm64`（bump 已由门禁独立复核） |
| build | PASS | `tsc --noEmit` + `tsc -p tsconfig.json` 均零输出零错误（与 §10.1 同源） |
| test | PASS | `ℹ tests 231 / ℹ suites 29 / ℹ pass 231 / ℹ fail 0 / ℹ skipped 0 / ℹ todo 0`（门禁内独立重跑一次，与 §10.2 的**六项计数**逐位一致；`duration_ms` 不在其列——两次是相互独立的进程，耗时必然不同，故 §10.2 与 §10.3 各引各自的实测值，本文不声称二者相同） |
| **isolation** | **PASS** | ① `SANDBOX_ELISION_PASS`：**11 个**沙箱测试文件的 `env-sandbox` import 在 esbuild 转译产物中全部保留（不可验证 **0 个**）；证据行「SANDBOX_ELISION 使用转译器：`server/node_modules/tsx/node_modules/esbuild/bin/esbuild`（**0.28.1**）」→ 本版改造后的**一级候选真实命中**；以及本次 §4.3 ② 新补的汇总证据行 `SANDBOX_ELISION 汇总：checked=11 elided=0 unverifiable=0`（与 `build.yml` 的同名输出逐项对齐，使本地与 CI 两侧日志可对照）。受检**文件**数从 10 增至 11，新增的正是 `source-health-l1.test.ts`；**第 9 例加在同一个文件内，故 `checked` 仍是 11 而不是 12**——该指标数的是文件数、不是用例数。② `DB_CANARY_PASS`：基线快照 `ro.db exists=1 sha256=027ff50a…96bd62 wal=1 shm=1`，test 段跑完后 sha256 **逐字符一致**、无 `-wal` / `-shm` **新增** |
| docker | SKIP | `--skip-docker 已指定，跳过 buildx 构建与镜像检查`（本机无 Docker），不影响门禁结论 |
| fpk | PASS | fnpack 官方工具真构建出 `rainbow-0.2.22.fpk`（**112K**）；`TAG_CONSISTENCY_PASS`（compose image 实际值 = 预期值 = `rainbow-music:v0.2.22`）、manifest version 校验通过 `0.2.22`、`DOWNLOAD_MOUNT_PASS`、`WIZARD_FIELD_PASS`、`DDIR_CONVERGE_PASS`、`LIBRARY_SHARE_PASS`；`DIGEST_PIN_SKIP`（未提供 `FPK_IMAGE_DIGEST`，本地门禁的正常形态，正式发布由 CI 注入 index digest） |

**isolation 段正是 §4.3 改造的验收点**。改造前它是**单候选硬编码**（只找 `node_modules/.bin/esbuild`），而那个二进制是 `drizzle-kit` 传递带入的——batch0 一移除它就消失，护栏会走 SKIP 分支但 `rc_iso` 仍为 0、也不增 `SKIP_COUNT` → **护栏静默变装饰而门禁仍报 PASS**。这与 v0.2.19 烧号属同一类漏检面，§4.2 已把它点名为 bug。

本次改动分两步，**两步都合上才叫同构**：① 首版把单候选换成三级候选 + 证据行，只**降低了触发那条分支的概率**，没有改变它的语义（全落空时依旧 `rc_iso=0` → 记 PASS）；发布前 CodeReview 据此判定首版注释里的「与 build.yml 同构」是**过度声明**。② 本次 amend 补上「全落空即 `rc_iso=1` 硬红」与 `build.yml` 的汇总证据行，四项（候选顺序 / 证据行 / 汇总行 / 兜底语义）全部对齐，才真正同构。

**A/B 隔离 harness 实测**（同一场景、同一 harness，唯一变量是脚本版本；场景 = `server/test` 里有真沙箱测试文件但**无 `node_modules`**，故三级候选必全落空）：BEFORE（`a0ee445` 改前）→ `SANDBOX_ELISION_SKIP`、`[isolation] PASS`、`FAIL_COUNT=0`、进程 **exit 0**（静默放行）；AFTER（本次改动）→ `SANDBOX_ELISION_FAIL` + 后果/修法两行、`[isolation] FAIL`、`FAIL_COUNT=1`、进程 **exit 1**（禁止发布）。逐项对照表已在 §4.3 自检第 4 项给出，此处不重复。

同 harness 的正向对照（把 `server/node_modules` 软链到真仓库）→ 一级候选命中 0.28.1、`SANDBOX_ELISION_PASS`、`[isolation] PASS`，证明硬红**不是一律红**、不会误红正常门禁。本次正式门禁运行同样**实证命中一级候选**（tsx 嵌套 esbuild 0.28.1）、**11 / 11 全过、不可验证 0 个**、汇总 `checked=11 elided=0 unverifiable=0`，即护栏是真实生效而非跳过。

**门禁产物未污染工作区**：`dist-fpk/rainbow-0.2.22.fpk` 与 `server/dist/` 均在 `.gitignore` 内（`git check-ignore -v` 实测分别命中 `.gitignore:24` 的 `dist-fpk/` 与 `.gitignore:3` 的 `server/dist/`），故门禁跑完不产生任何 `??` 未跟踪产物；amend 后的最终树上再跑一次门禁，`git status --porcelain` **输出为空**（跑前跑后逐项一致，均为干净）。

### 10.4 中文字节完整性（防编辑工具形近字损坏）

对本版三个中文密度最高的文件（`source-health.ts` 的新增注释、`source-health-l1.test.ts` 全文、**本文**）跑字节级校验：

- **必现词字典**（合计 **78 / 78** 命中）：`source-health.ts` **15 / 15**、`source-health-l1.test.ts` **23 / 23**、`docs/CHANGELOG-0.2.22.md` **40 / 40**（字典含「门禁结论：PASS（可发布）」「无 D（删除）/ 无 R（重命名）」「护栏静默变装饰而门禁仍报 PASS」等**硬声明句**，防止它们被静默改写）；本次 amend 把字典由 43 条扩到 **78 条**：测试文件 **+10 条**逐字锚定三个 nit（改后的用例名、订正后的断言消息、新增第 9 例的前提/断言/说明各句），本文 **+26 条**锚定兜底语义修复的硬声明与附录数字，其中附录的 **10 条是动态锚点**——由 `t223-scratch/cn_dict.py` 现场跑 `git diff --numstat` / `--name-status` 与文件行数**重算出应有的数字**、再要求文档逐字含有它（这才是真交叉校验：文档声称的值必须等于 git 与文件系统的实测值，而不是「文档自己说自己对」）；三个计数一律取自 `len(MUST[rel])`，**本文与脚本共用同一个字典模块，故不存在两地手改失准**；
- **黑名单**（历史损坏形态：`拒绍`、`颉`、`跳平台`、`跳越`、`诊断姓`、`附熟`，本次 amend 补入 `继不清空`、`字节扇描`，合计 **9 条**）：**非自指行 0 命中**。本文 §10.4 自身把黑名单列出来作为踩坑留档（反引号与直角引号两种形式），按「命中子串被 `X` 或 「X」 包裹」判据**显式排除**——否则检查器会把自己写的文档当成损坏（首次跑确实因此误报 6 项全命中）。**补入的两条刻意取完整词组而非单字**，正是被该判据逼出来的：留档行文写的是「字节扇描」，若黑名单只收单字 `扇描`，则该行内并不存在字面 `「扇描」`（左包裹符后面紧跟的是「字节」二字），排除判据失效、检查器会把**自己刚写的留档**报成损坏；取完整词组后 `「字节扇描」` 恰好自包含，判据成立。
- **「汉字 + 半角空格 + 汉字」形态**（折行假警报的真实来源）：全量扫描 8 个本版改动文件，**源码与脚本侧 6 个文件全 0 命中**；文档侧的命中逐处字节级裁决为**合法内容**，归为三类：① 产品名 `Server酱 告警`——`README.md` 原文字节即 `b'Server\xe9\x85\xb1 \xe5\x91\x8a\xe8\xad\xa6'`（酱后一个 `0x20`），`docs/DEVELOPMENT.md` 的目录树注释同形且**不在本版 diff 内**，属原作者行文风格、本文引用逐字节忠实；② 章节号与中文词之间的**有意可读性空格**（如 `§十二 记录`、`§八 依赖树`）；③ **本条自身**为说明折行假警报而引用的形态——描述该现象必然复现该现象，与黑名单自指同源。三类均非损坏，故不计入 rc；
- **SQL 片段字面校验**：`WHERE step IN` 占位、`HEALTH_STEPS` 常量、绑定参数三项 **3 / 3**；
- 结论 **RESULT=PASS**（rc=0）。本节与 §九的三个自检脚本（均在**仓库外**的工作目录，不入库、不进提交树）为：`t223-scratch/check-cn-t223.py`（本节，字典与文档共用 `cn_dict.py` 故计数不会两地失准）、`t223-scratch/bump-verify-t223.py`（§九的 12 处承载点 + 残留行数 + manifest 结构 + **[4] 段对本次兜底硬红的结构化断言**：不只看字符串在不在，而是核对 `rc_iso=1` 是否真紧跟在「三级候选均未找到」那条 FAIL 分支之后、以及该分支代码窗口内确无 `SANDBOX_ELISION_SKIP` / `return 2`）、`t219-scratch/lock-audit.py`（依赖树与 lock 一致性，本次原样复用，其中「tsx 嵌套 esbuild 仍在 = 0.28.1」正是 §4.3 硬红不误红的前提）。三者**均实测 RESULT=PASS**。

> **踩坑留档（对后续维护者有用，与 v0.2.21 §6.6 同源）**：编辑工具写入中文时出现过**形近字替换**（「拒绝」→「拒绍」、「跨音源」→「跳音源」）且**不报错**；更隐蔽的是用「正确字形」作 `original_text` 去修时，工具返回 success 却**只应用了部分替换**。另一类是**假警报**：终端渲染长 CJK 行时在折行处插入视觉空格，`grep` / `git diff` 输出里看似「冒 烟」「源 排到」，按字节核对为 0 处真实空格。
>
> **判断中文问题只能信 python `repr()`，不能信终端渲染。** 本版因此对全部中文改动做了两道复核：① 逐次 review diff；② 字节级脚本终裁。机械版本号一律走按行号替换的脚本（§九），不经编辑工具的中文写入路径。
>
> **另两类本版实际踩到的坑**：① zsh 下 glob 无匹配（如 `server/Dockerfile*`）会报 `zsh: no matches found` 并**中断整条命令**，导致同一命令里的 `grep` 完全没执行、输出为空被误读为「无命中」——必须显式列真实文件；② `node:test` 的 TAP 汇总行前缀是 `ℹ` 而非 `#`，`grep -E "^# (tests|pass|fail)"` 恒空且 rc=1，会被误读为测试没跑。
>
> **本版 amend 又踩到同一类坑两次，但根因不同**：不是编辑工具静默替换，而是**我在脚本里手写 Unicode 转义序列**时打错形近字——「绝不清空」被写成「继不清空」（`\u7ee7` 应为 `\u7edd`）、「字节扫描」被写成「字节扇描」（`\u6247` 应为 `\u626b`）。两次都在编辑工具返回的 diff 输出里被当场看见、用 python `repr()` 复核字节后修正，**未流入 commit**；黑名单因此补入这两条形态（见上一条对「为何取完整词组」的说明）。根治办法是**一律直接写汉字、不手写转义序列**——转义序列把「肉眼可校的字形」变成「必须心算码位才能校的数字」，正好绕过了本节所有字节级检查赖以工作的可读性前提。

---

## 十一、明确没有做的事

- **没有 push、没有打 tag、没有触发 CI**。本版只产出**一个本地 commit**；公开发布（REST 逐对象复刻 + annotated tag `v0.2.22`）是 **#220**，届时需用户显式确认 `repo + tag + commit` 三元组。
- **没有改动 L1 的阈值与排序算法**：`HEALTH_SAMPLE_RUNS = 5`、`HEALTH_CACHE_TTL_MS = 30_000`、`allRecentFailed` 判定式、`rate` 计算式、`orderByHealth` 的装饰-排序-还原，全部一字未动。item1 只加了**一个常量**和**一个 `WHERE` 子句**。
- **没有改动 L2 熔断器与 L3 令牌桶的任何一行代码**：阈值 5、窗口 300000、连续失败语义、剔空回退、桶容量 `max(1, ceil(ratePerMin/6))`、`ratePerMin <= 0` 直接放行，全部保持原样。
- **没有改动 `recentRunsOutcome()`（告警口径）与 `trend()`（趋势口径）**，也**没有改动 `routes/health.ts` 的矩阵三色判定**——理由见 §2.6。
- **没有改写 `docs/CHANGELOG-0.2.20.md` / `0.2.21.md` / `0.2.19.md` 的任何一行**（已发布历史）；`CHANGELOG-0.2.20.md` **不追加勘误指针**（核实无误述，理由见 §3.4）。
- **没有动 v0.2.19 / v0.2.20 / v0.2.21 的已发 tag 与烧号留档**，没有删除或重指任何远端对象，没有 force push。
- **没有跑 `npm audit fix --force`**，没有动 `music-metadata` 与 `sharp`（均需跨 major，理由见 §七）。
- **没有修改 `~/.npmrc`**、没有把任何 registry 配置提交进仓库（仓库内**无 `.npmrc`**，lock 内 3 条 npmjs `resolved` 是 v0.2.21 遗留的 audit fix 副作用，见 §8.2）。
- **没有改 `README.md`**（对账结论：无 drizzle 提法、无 L1/L2/L3 机制细节、既有描述准确，见 §3.3）。用户向文档不该承载熔断器实现细节。
- **没有改 `Dockerfile`**（`RUN npm install` + `RUN npm prune --omit=dev` 无 drizzle 特化步骤，依赖增删对它透明）。
- **没有改 `build.yml` 的护栏逻辑与六 job 结构**（只订正 2 处过时文案 + 1 处 `$BIN` 花括号缺失，见 §4.4）；`meta` / `build` / `docker` / `release` 四个 job 一行未动，`fpk` job 只动了 L250 那行**诊断输出**（`$BIN` → `${BIN}`，不改任何控制流、不改 `GITHUB_ENV` 写入）。
- **没有放宽或删除任何断言**、没有跳过任何用例（无新增 `.skip` / `todo`）。
- **没有碰 NAS**（不做任何实机部署、重启、配置变更）。
- **没有改 plan 文件**。
- **没有重跑 fpk 真构建**：`docs/` 不进 fpk 包（`build-fpk.sh` 的 STAGE 由 `cp -R "$FPK_SRC/."` 填充，`FPK_SRC` = `fpk/` 目录），本文与 item2 的文档改动对包内容零影响；`fpk/manifest` 的两处改动由本地门禁 fpk 段的包级断言覆盖。

---

## 十二、已知盲区与遗留

1. **告警口径与 L1 口径现在刻意不一致**（§2.6）。`recentRunsOutcome()` 仍把 `head`/`lyric`/`pic` 计入「连续失败」告警，因此可能出现「L1 判某源健康并优先使用，同时健康页对它发连续失败告警」。这是**有意的不对称**（排序要求精准、告警要求宁多报不漏报），已在 `API.md` §11 与 `docs/SOURCES.md` 双处写明。但**告警文案本身没有区分是哪一步失败**——收到告警的人需要自己去 `GET /api/v1/health/smoke` 看矩阵才能判断严重性。给告警文案加上「失败步骤」维度是可选的后续增强。

2. **`healthAware` 是全开/全关，没有「只信 search」或「按源定制」的中间档**。若将来出现某个源确实连 `head` 都该计入（例如它的 CDN 从不拒 HEAD，`head` 失败就等于真坏），当前无法表达。引入 per-source 白名单会显著增加配置面，本版不做。

3. **`HEALTH_STEPS` 与 `SmokeStep` 之间没有编译期约束**。`HEALTH_STEPS` 用 `as const` 声明为 `readonly ['search','musicUrl']`，但类型是字面量而非 `SmokeStep[]`，因此若将来 `SmokeStep` 重命名（如 `musicUrl` → `musicurl`），`HEALTH_STEPS` 会**静默失配**（SQL 查不到行 → 该源无快照 → 按中性不降权 → L1 静默失效）。已用注释「取值必须与 `db/smoke.ts` 的 `SmokeStep` 联合类型一致」标注，并靠测试用例 1–6 兜底（它们造满五步数据，失配会立刻让断言失败）。更强的做法是写成 `const HEALTH_STEPS: readonly SmokeStep[] = ['search','musicUrl']`——本版未改，因为那需要 `source-health.ts` 新增一条对 `db/smoke.js` 的类型 import，把当前的**运行时单向依赖**变成编译期耦合，收益不抵风险。

4. **护栏对 `tsx` 内置 esbuild 的依赖仍在**（v0.2.21 §八.2 的遗留，本版**部分处置**）。`drizzle-kit` 已移除，二级候选 `node_modules/.bin/esbuild` 恒落空，因此 `SANDBOX_ELISION` 现在**实质上依赖一级候选**——即 `tsx` 自带嵌套 esbuild 二进制。若将来 `tsx` 换成不内置 esbuild 的版本，一级落空 → 三级 `npx --no-install` 也落空（没装就没有）→ **CI 侧与本地门禁侧现在都直接红**：`build.yml` 是 `::error::` + `exit 1`；`verify-ci.sh` 是 `rc_iso=1` → `[isolation] FAIL` → `FAIL_COUNT>0` → `门禁结论：FAIL（N 个作业失败，禁止发布）` + `exit 1`。两侧同构（§4.3 ②）。

   > **本条在 v0.2.22 首版（amend 前）的写法已被订正**。首版写的是「CI 侧直接红、**本地侧打 SKIP 但段仍 PASS**（本地门禁刻意不误红），两处行为不对称是既有设计，本版只把本地侧从「单候选静默降级」提升到「三级候选 + 证据行」，没有改成硬红」。发布前 CodeReview 指出这与 §4.3 的「同构」声明**自相矛盾**：「缺失即静默 PASS」正是 §4.2 自己点名为 bug、且与 v0.2.19 烧号同一类的漏检面，不能一边声称同构、一边把它留档成「刻意设计」。故本次 amend 改为硬红，本条随之改写；A/B 实测证据见 §10.3。

   **这条盲区并没有被完全关闭**，剩余的真依赖是：一级候选来自 `tsx` 的**未声明传递依赖**——`server/package.json` 里**没有** `esbuild` 条目，护栏能否行使取决于 `tsx` 是否继续内置嵌套副本。彻底解法是显式加一个 `esbuild` devDependency（把它变成声明依赖），本版未做：那会引入一个只为门禁服务的直接依赖，并需重新评估 lockfile 与镜像体积。**硬红只是把「静默失效」变成「显式失败」，不等于消除了失效的可能。**

5. **`music-metadata` 与 `sharp` 的 2 项 high 公告仍在册**（§七）。两项都在下载管线的核心路径上（元数据解析、封面处理），跨 major 升级必须单独窗口 + 真机回归。这是本版**最大**的已知安全遗留。

6. **`API.md` 与实现之间仍没有机械化的一致性门禁**（v0.2.21 §八.5 顺延）。本版 item2 补齐的 settings 契约（`safeView()` 六块 + 16 条校验）是用一次性脚本 + 人工对账证明的，脚本**没有入库**。下次 `settings.ts` 加字段时同样会滞后。把「`safeView()` 键集 → 文档示例键集」做成常驻门禁是可选增强。

7. **`docs/FNOS-DEPLOY.md` L371 的前向声明已连续顺延四版**（v0.2.19 → v0.2.20 → v0.2.21 → v0.2.22）：「重装验证」始终未做（本机无 Docker、且未对 NAS 做任何实机操作）。v0.2.21 §八.6 已明确写「下一次真机窗口应**直接兑现或删掉**，而不是再顺延第四次」——**本版又顺延了一次（第四次）**，该声明事实上已失效。建议在下一个真机窗口**直接删除**这条前向声明，而不是继续顺延。

8. **`scrape-detail.ts` L295 的 MB UA 串括号内含空格**（`Rainbow/0.2.22 ( https://… )`，§九）。v0.2.21 既有形态，功能无碍（RFC 7231 comment 允许空格），但形态不规范。本版按「只做 bump」的纪律未动，留档待单独处置。

9. **本版新增测试对 `created_at` 做了人工覆盖**（`insertRun` 里 `row.created_at = base + i`），因为 `smokeStore.newRow()` 用 `Date.now()`，同一毫秒内造 125 行会让 `MAX(created_at)` 无法区分轮次。这属于**测试侧的合理确定性处理**，但它意味着测试没有覆盖「同一毫秒内多 run」这个真实可能出现的边界。生产侧 `computeSourceHealth` 用 `MAX(created_at)` 排序取近 5 轮，同毫秒多 run 会导致轮次选取不确定——真实场景下冒烟是每日一次的批量写入，同一次 run 内所有行同毫秒是**常态**，但**跨 run** 同毫秒几乎不可能（两轮冒烟至少间隔数分钟）。故不构成实际风险，留档说明。

---

## 附录：文件级 numstat（本版发布提交，基线 `8862cf0`）

下表为 `git diff --numstat 8862cf0` 的逐项实测值（**18 项 = 16 M + 2 A**；其中 16 个 M 合计 **+267 / −1396**，两个 A 文件另计 `+278` 与 `+781`）。合计 **18 文件 = 16 M + 2 A，无 D（删除）/ 无 R（重命名）** —— 满足发布通道对「纯新增/修改 blob」的前提（`sync-release.sh` 步骤 1 检出全零 blob sha 即 ABORT）。

| 增 | 删 | 文件 | 状态 | 归属章节 |
|---:|---:|---|:--:|---|
| 22 | 3 | `server/src/core/source-engine/source-health.ts` | M | §2.3 — item1 核心修复（新增常量 + `WHERE` 子句 + 文件头口径说明） |
| 8 | 2 | `server/src/core/smoke/scheduler.ts` | M | §6.2 — batch2 的 node-cron v4 类型形态适配（运行时行为不变） |
| 48 | 7 | `API.md` | M | §3.2 item2（+47 / −6）+ §九 bump L1075（+1 / −1） |
| 39 | 1 | `docs/DEVELOPMENT.md` | M | §3.2 — 新增「音源质量闸门 L1/L2/L3」权威章 + 目录锚点 + L64 去 drizzle |
| 2 | 1 | `docs/SOURCES.md` | M | §3.2 — 冒烟三步订正为五步 + 新增「HEAD 探测失败 ≠ 真实下载能力」运维条 |
| 1 | 1 | `server/src/core/config.ts` | M | §3.2 — L54 `healthAware` 注释口径同步 |
| 1 | 1 | `config.example.yaml` | M | §3.2 — L72 `healthAware` 注释口径同步 |
| 3 | 6 | `server/package.json` | M | §四/五/六 依赖声明（+2 / −5）+ §九 bump L3（+1 / −1） |
| 65 | 1357 | `server/package-lock.json` | M | §八 依赖树（+63 / −1355，移除 77 包 / 新增 1 包）+ §九 bump L3、L9（+2 / −2） |
| 65 | 5 | `scripts/verify-ci.sh` | M | §4.3 — isolation 段三级 esbuild 候选解析 **+ 全落空即 `rc_iso=1` 硬红 + 汇总证据行**（batch0 连带 + 发布前 CodeReview 订正） |
| 5 | 4 | `.github/workflows/build.yml` | M | §4.4 — 两处过时 drizzle-kit 文案订正（batch0 连带）+ L250 `$BIN` → `${BIN}`（花括号缺失，字节扫描时顺带修掉，与 batch0 无关） |
| 1 | 1 | `server/src/routes/status.ts` | M | §九 — L15 `app.version` |
| 1 | 1 | `server/src/core/adapters/scrape-detail.ts` | M | §九 — L295 MusicBrainz UA 串 |
| 2 | 2 | `fpk/manifest` | M | §九 — L2 `version=` + L25 `changelog=` 整行改写 |
| 1 | 1 | `docs/FNOS-DEPLOY.md` | M | §九 — L1 标题 |
| 3 | 3 | `scripts/verify-image.sh` | M | §九 — L7 / L10 / L33 默认镜像 tag |
| 278 | 0 | `server/test/source-health-l1.test.ts` | **A** | §2.4 — L1 健康聚合与 L2 熔断回退回归测试 9 例 |
| 781 | 0 | `docs/CHANGELOG-0.2.22.md` | **A** | 本文（十二节 + 附录） |

**按块归并**（同文件被多块触及的，按其块内行数拆分计入；故「触及文件」列之和 21 > 去重后 18，重叠文件为 `API.md`、`server/package.json`、`server/package-lock.json`）：

| 块 | 触及文件 | 增 | 删 | 净 |
|---|---:|---:|---:|---:|
| item1 — L1 健康聚合修复 | 1 | 22 | 3 | +19 |
| item1 — 回归测试（新增文件） | 1 | 278 | 0 | +278 |
| item2 — 文档对账订正 | 5 | 90 | 10 | +80 |
| batch0 — 连带门禁护栏改造 | 2 | 70 | 9 | +61 |
| batch0/1/2 — 依赖声明 + lockfile | 2 | 65 | 1360 | −1295 |
| batch2 — node-cron v4 类型适配 | 1 | 8 | 2 | +6 |
| bump 0.2.21 → 0.2.22 | 8 | 12 | 12 | +0 |
| 本文（新增文件） | 1 | 781 | 0 | +781 |
| **合计（去重后）** | **18** | **1326** | **1396** | **−70** |

> **分块自检**：各块增行之和 `22 + 90 + 70 + 65 + 8 + 12 = 267`、删行之和 `3 + 10 + 9 + 1360 + 2 + 12 = 1396`，与 tracked 实测 **+267 / −1396** 逐位相符（拆分无遗漏、无重复计数；本版由 `fill-appendix-t223.py` 直接从 `git diff --numstat` 推导各块，并对「拆分之和 == tracked 合计」做 assert，不自洽即 ABORT 不写盘）。
>
> **净减 1292 行全部集中在 `server/package-lock.json`**（+65 / −1357），即 batch0 移除 drizzle-orm + drizzle-kit 死依赖与 batch2 的 node-cron v4 零依赖化共同带走的 **77 个包**（含 `uuid` 传递依赖链与 `@esbuild-kit/*`）。除 lockfile 外的 15 个 tracked 文件合计 **+202 / −39**，是**净增**的，拆开为：`server/src` 五文件 +33 / −8、门禁护栏两文件 +70 / −9、文档与配置样例五文件 +91 / −11、`server/package.json` +3 / −6、版本承载脚本与清单两文件（`fpk/manifest`、`scripts/verify-image.sh`）+5 / −5。
>
> **本文行数的自指说明**：上表 `docs/CHANGELOG-0.2.22.md` 一行的 **781** 就是本文件写入完成后的实际总行数，算式是「附录块之前的正文行数 + 附录块行数 K」，故 T = 735 + 46 = 781。因为回填只改行内数字、不改行数，T 即为**不动点**，一次收敛。该数字与附录合计值均由 `t219-scratch/fill-appendix.py`（首填）、`t219-scratch/fix-appendix-selfref.py`（§10.3 扩写后重算）与 `t223-scratch/fill-appendix-t223.py`（本次 amend 后重算）从 `git diff --numstat` 实测计算后回填，**不是手填**，避免自指失准。**注意公式在 #223 变过**：首版填写时两个 A 文件还是 `??` 未跟踪，`numstat` 只返回 16 项，故 A = tracked + 测试行数 + T 需要把两者**额外加上**；本次 amend 时它们已入树、`numstat` 返回 18 项并已含其行数，沿用旧式会**双重计数**——新脚本改为先按 `name-status` 剔除 2 个 A 项得到 16 个 M 的合计（+267 / −1396），再加回 `+278` 与 `+781`。

**M / A 分布核对**：`git diff --name-status 8862cf0` 输出 **18 行 = 16 `M` + 2 `A`**（0 行 `D`、0 行 `R`；脚本对每行断言只有 2 列，`R`/`C` 会因多列而 ABORT）。两个 `A`（`server/test/source-health-l1.test.ts`、`docs/CHANGELOG-0.2.22.md`）在 v0.2.22 首版提交时是 `git status` 的 `??` 未跟踪项、由首版 commit 入库，本次 `--amend` 后已在树内，故本项现在直接从 `diff --name-status` 读出，不再依赖 `git status` 的 `??` 计数。**drizzle 是依赖而非源码文件**，移除只改 `package.json` / `package-lock.json` 两个已跟踪文件，因此本版提交树内**不存在任何删除或重命名**。
