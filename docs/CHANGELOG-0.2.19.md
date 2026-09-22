# 变更清单：v0.2.18 → v0.2.19

基线 `3c0311e`（tag `v0.2.18` 指向的提交，与 `origin/main` 同步）→ **本版单个发布提交**（P0/P1/P2 下载与搜索能力强化 + 版本 bump 0.2.19 + 本文）。改动规模 **58 个文件（39 改 / 19 新增，纯 M/A，无删除无重命名）**；39 个修改文件合计 **+4702 / −420**（含版本 bump，不含本文），19 个新增文件中，18 个代码文件共 **3816 行**（服务端产品代码 1264 / 8 个测试文件 2122 / 前端公共模块 430），第 19 个为本文（600 行）。

> **本版为功能发布**：与 v0.2.17/v0.2.18 两版「维护性发布（运维 / CI 门禁 / 文档）」不同，本版是**应用行为发生实质变化**的一版——下载链路与搜索链路两条主线同时强化，新增 **18 个 HTTP 端点（16 条新路径）**、**3 张 SQLite 表**、**4 个 `download_tasks` 列**、**2 个运行时依赖**（`check-disk-space`、`pinyin-pro`），前端新增 2 个公共模块并重写搜索页。升级前请读 §9（配置面）与 §12（已知盲区）。

> **本文是对外可读版本。** 仓库公开，因此不写 NAS 主机名、备份与证据树的具体落盘
> 路径、凭据与内部运维细节——这些属于内部项目档案，不属于这里。技术结论与代码改
> 动本身完整无删减。

> **发布状态**：版本承载点（`fpk/manifest` version= 与面向用户的 changelog= 文案、
> `server/package.json`、`server/package-lock.json`（顶层 + `packages[""]`，并收敛其历史漂移值）、
> `status.ts` 运行时上报、`scrape-detail.ts` MB UA、`API.md` status 示例、
> `verify-image.sh` 默认镜像 tag、`docs/FNOS-DEPLOY.md` 标题与 #155 章前向引用）已
> **全量 bump 至 0.2.19**；本地门禁 `scripts/verify-ci.sh --skip-docker` 结论
> **PASS（可发布）**——heal / meta / build / test（`npm test` **219 / 219**，
> 28 suites，0 fail / 0 skip）/ fpk 五段全绿，docker 段因本机无运行时记 SKIP
> （不影响结论）；fpk 段以官方 `fnpack` 真构建出 `rainbow-0.2.19.fpk`（112K，
> `app.tgz` 官方结构）且包级断言（TAG_CONSISTENCY / DOWNLOAD_MOUNT /
> WIZARD_FIELD / DDIR_CONVERGE / LIBRARY_SHARE）全 PASS。
>
> **本提交只落本地 main，不 push、不打 tag、不触发 CI**：公开发布（经
> `github-release-chain` 逐对象复刻 + annotated tag `v0.2.19` 触发 `build.yml`）
> 是后续独立任务，需检查点确认后另行授权。v0.2.19 的 CI 产物（GHCR 双架构镜像 /
> `.fpk` / GitHub Release）终态以该次发布执行的 `ci-poll` 与 Release 页为准，
> **本文不预断 CI 成功**。

---

## 一、本版总览：工作项编号 → 落点

本版按 P0（可用性底线）/ P1（体验主干）/ P2（性能与高阶）三批推进，工作项沿用既有字母编号（A~O）。关联 issue 以代码注释中已存在的编号为准，未标注 issue 的批次不臆造编号。

| 批次 | 编号 | 内容 | 主要落点 | issue |
|---|---|---|---|---|
| P0 | A1 | 下载状态三态收敛（前端公共模块） | `web/js/download-state.js`（新）、`home.js`、`playlists.js`、`library.js`、`search.js` | — |
| P0 | A2 | 统一下载音质来源 + 顶栏全局控件 | `web/js/api.js`、`web/index.html`、`web/style.css`、`main.js` | — |
| P0 | B1 | 同名文件冲突保护（后缀 / 覆盖 / 跳过） | `core/download/index.ts` `resolveConflictPath` | — |
| P0 | B2 | 下载完整性校验（received vs content-length） | `core/download/index.ts` `streamDownload` | — |
| P0 | C1 | 真实音质回写（码率 / 编码 / 采样率） | `core/download/index.ts`、`core/db/index.ts`（3 新列） | — |
| P0 | D1 | 搜索历史持久化（去重置顶 / 封顶 / 可清空） | `core/db/searchHistory.ts`（新）、`routes/me.ts`、`web/js/pages/search.js` | #186 |
| P0 | D2 | 搜索联想（history + hot + title 三源复合去重） | `core/search/suggest.ts`（新）、`routes/search.ts` | #189 |
| P0 | D3 | 热搜榜（全局近 7 天频次 Top N） | `core/search/suggest.ts`、`routes/search.ts` | #186 |
| P0 | D4 | 聚合超时 / 内存缓存 / in-flight 去重 / 默认 limit 统一 | `core/search/index.ts`、`adapters/{tx,mg}/musicSearch.ts` | #191 |
| P0 | E1/E2/E3 | 分页「加载更多」/ 真实封面 / 批量建单 | `web/js/pages/search.js` | #186 |
| P1 | F1 | HTTP 错误分级（Transient / Permanent） | `core/download/index.ts` | #190 |
| P1 | F2 | 断点续传（Range 206 / 200 / ETag 失配） | `core/download/index.ts` | #190 |
| P1 | G1/G2 | 落盘子目录归类 + 模板占位符渲染 | `core/download/index.ts` | #190 |
| P1 | H1~H5 | 批量入队 / 批次视图 / 队列暂停 / DB 精确计数 / 入队去重 | `core/download/queue.ts`、`routes/download.ts`、`routes/playlists.ts`、`routes/status.ts` | #190 |
| P1 | I1~I4 | 顶栏全局下载指示器 / 队列批量操作 / 行三态补齐 | `web/js/main.js`、`web/js/pages/library.js`、`web/index.html`、`web/style.css` | — |
| P1 | J1~J4 | 跨源合并去重 / 相关度评分 / 拼音首字母 / 双视图前端 | `core/search/{index,scoring,pinyin}.ts`、`routes/search.ts`、`web/js/pages/search.js` | #191 / #193 |
| P1 | K1/K2 | 结果筛选 chips / 多维排序 | `web/js/pages/search.js`、`web/index.html` | #193 |
| P2 | L1/L2/L3 | 音源健康排序 / 熔断 / 音源级令牌桶限速 | `core/source-engine/source-health.ts`（新）、`core/source-engine/index.ts`、`core/orchestrator/index.ts` | — |
| P2 | M1/M2 | 结构化错误码 / `download_attempts` 审计轨迹 | `core/download/errors.ts`（新）、`core/db/index.ts`、`routes/download.ts` | #198 |
| P2 | N1/N2/N3 | 封面音频并行 / SSE 与落盘节流 / 磁盘空间预检 | `core/download/index.ts`、`core/download/queue.ts` | — |
| P2 | O1 | 结果内试听（音源直链流式代理，不落盘） | `routes/preview.ts`（新）、`src/index.ts`、`web/js/pages/search.js` | #201 |
| P2 | O2 | 「我喜欢」收藏（搜索行 + 播放器同源同步） | `web/js/favorites.js`（新）、`routes/me.ts` 复用 | #199 |
| P2 | O3 | 歌手 / 专辑名可点击二次搜索 | `web/js/pages/search.js`、`web/style.css` | #199 |
| P2 | O4 | 错字容错建议（capped Levenshtein，不自动替换原词） | `core/search/correct.ts`（新）、`routes/search.ts` | #200 / #201 |
| P2 | O5 | 相关推荐（搜索共现表 + 冷启动回退 trending） | `core/db/index.ts`（`search_cooccurrence`）、`core/search/correct.ts` 侧编排、`routes/search.ts` | #200 / #201 |
| 修复 | — | `/tasks/owned` 完整性 + `total` + `mergeOwned` 覆盖 | `core/download/queue.ts`、`routes/download.ts`、`web/js/download-state.js` | #196 |
| 修复 | M-1 | 直连取流阶段失败也落 `download_attempts` 审计 | `core/download/queue.ts`、`core/download/errors.ts` | #203 |

---

## 二、P0：下载三态与数据安全兜底（A1 / A2 / B1 / B2 / C1）

### 2.1 A1 —— 前端下载状态三态收敛（新增 `web/js/download-state.js`，202 行）

此前 `home.js` / `playlists.js` / `library.js` 三处**各持一份复制粘贴**的下载态逻辑：owned 映射、状态优先级、三态按钮 HTML、进度环周长常量、SSE 事件名清单。三份实现随迭代已经出现细节漂移（环常量不同、状态优先级判定不同）。

本批抽出公共模块，收敛为单一真源：

- `songKey(platform, songmid)` → `platform:songmid` 作为 owned / 批量去重 / 收藏 ref 的**统一 key 口径**（跨页天然对齐，也是 O2 收藏能复用的前提）；
- `STATUS_RANK`（`done > busy > failed/canceled`，同档取 `updatedAt` 新者）决定一行多任务时的代表任务；
- 三态按钮：未下载 = 下载钮 / 下载中 = 进度环 / 已下载 = 绿勾（hover 切播放三角，点击直接播）；
- 进度环常量 `SMALL_RING_LEN`（28px 行内小环）与 `QUEUE_RING_LEN`（40px 队列环）由模块内部持有，页面不再重造；
- `subscribeTaskEvents` + `connected` 重连对账 helper：SSE 断线重连后主动对账一次，避免漏事件导致按钮永久卡在「下载中」。

**迁移铁律**：各页 DOM 选择器 / 类名 / id / 事件绑定 / 行为完全等价，零功能回归。收益在 numstat 上直接可见——`home.js` **+34 / −64**、`playlists.js` **+21 / −59**（净删代码），`library.js` 的环更新也改为委托 `updateQueueRing`。

### 2.2 A2 —— 统一下载音质来源 + 顶栏全局控件

原状：`home.js` 有一份 `DL_QUALITY` 硬编码，`playlists.js` 跨页读 `$('#quality')` DOM 取值——两条路径互不知晓，用户在搜索页选的音质不会作用于歌单页。

更实质的是一个**死代码缺陷**：`initQualityCache` 原以为 `/settings` 返回顶层 `defaultQuality`，而实际返回嵌套结构 `{ auth, download:{ defaultQuality }, scrape, smokeTest }`，因此该回退分支**永远拿不到值**、顶栏控件也无法播种。本批修正为读 `s.download.defaultQuality`。

统一后单一优先级：**全局控件 `#dl-quality` > `settings.download.defaultQuality` 缓存 > `'flac'`**。顶栏新增 `.topbar-quality` 暗玻璃胶囊（Hume 语系，与搜索 pill 同层），窄屏隐藏以优先保搜索 pill 可用宽度。

### 2.3 B1 —— 同名文件冲突保护（`resolveConflictPath`）

原状直接写目标路径，同名即**静默覆盖既有曲库文件**。现按 `download.onConflict` 三态处置：

- `suffix`（默认）：追加 ` (1)`、` (2)`… 直到空位，**绝不覆盖**；
- `overwrite`：显式覆盖（用户自担）；
- `skip`：跳过写入，任务以既有文件为结果。

### 2.4 B2 —— 下载完整性校验

`streamDownload` 比对实际 received 字节数与响应 `content-length`，不一致记 **warning**（任务落 `completed_with_warnings` 而非假装成功）。针对的是上游直链中途断流却返回 200 的场景——此前会得到一个**截断但被标记为完成**的音频文件。

### 2.5 C1 —— 真实音质回写（3 个新列）

平台标称音质与文件实际内容不一致是长期存在的现象（标称 flac 实为 320k mp3 转档）。下载完成后用 `music-metadata` 的 `parseFile` 读取真实参数，回写 `download_tasks` 三个新列：

| 新列 | 类型 | 含义 |
|---|---|---|
| `actual_bitrate` | INTEGER | 真实码率（bps） |
| `actual_codec` | TEXT | 真实编码格式 |
| `actual_sample_rate` | INTEGER | 真实采样率（Hz） |

开关 `download.detectRealQuality`（默认 `true`）。列由 `initDb()` 以 `ALTER TABLE ... ADD COLUMN` 幂等迁移（老库升级即补列，无需手工介入）。

---

## 三、P0：搜索基础设施（D1~D4）与结果可用性（E1~E3）

### 3.1 D1 —— 搜索历史持久化（新增 `core/db/searchHistory.ts`，176 行）

新表 `search_history`（`id / uid / kw / type / platform / ts`），配 `idx_sh_uid_ts(uid, ts DESC)` 与 `idx_sh_kw(kw)` 两索引。语义要点：

- **去重置顶**：同一 uid 重复搜同一 kw **不新增行**，只把既有行 `ts` 刷到当前时间（`list` 按 `ts DESC` 即等价置顶），同时更新 `type`/`platform` 为最近一次上下文；
- **封顶 200/uid**，同事务修剪（复用 `core/db/users.ts` 的 `historyStore` 范式）；
- **uid 隔离**：口径与 `users.ts` 一致，对外统一 TEXT（网关数字 uid 转字符串，本地模式固定 `'legacy'`）。

三个端点（`routes/me.ts`）：`GET /api/v1/me/search-history?limit=`（clamp 1..200，默认 50）、`POST`（201）、`DELETE`（清空当前 uid）。

前端做**跨设备合并**：页面加载时拉远端历史与本地 `localStorage` merge 去重（同 kw 取 `ts` 新者）；搜索成功后 fire-and-forget `POST`；清空时同步远端（失败静默——下次加载 merge 可能回灌远端残存，可再次清空，这是刻意的弱一致取舍）。

### 3.2 D2 —— 搜索联想（新增 `core/search/suggest.ts`，272 行）

`GET /api/v1/search/suggest?q=&limit=`。三数据源按优先级合并：

1. `history` —— 当前 uid 近期搜索词；
2. `hot` —— 全局近 7 天热搜词；
3. `title` —— 热门榜单标题池的歌曲名 + 歌手。

**复合 key 去重修复了一个老问题**：以 `(text, singer)` 而非单纯 `text` 去重——同名不同歌手**保留为不同条目**（此前会被折叠成一条，用户无法区分），完全相同 `(name, singer)` 跨源只出现一次（保留优先级最高的 type）。

标题池的实现取舍：`routes/hotPlaylists.ts` 的 `getHotPlaylists` 是模块私有且该文件不在本批可改范围，故 `suggest.ts` 直接 import 榜单适配器自建轻量标题池（wy 热歌榜 / tx 巅峰榜·热歌 / kg TOP500），**复刻** hotPlaylists 的 8s 单榜超时 + 5min 内存缓存 + in-flight 去重范式，而非改动既有路由（避免牵连已验证的行为）。取榜平台由 `search.suggestPlatforms` 配置（默认 `[wy, tx, kg]`）。

### 3.3 D3 —— 热搜榜

`GET /api/v1/search/trending?limit=` → 全局搜索历史近 7 天频次 Top N（`{ text, count }`）。前端浮层新增「热门搜索」组，会话级缓存，右侧带计数 badge；拉取失败静默（无热搜组，不影响搜索）。

### 3.4 D4 —— 聚合超时 / 缓存 / in-flight 去重 / limit 统一

`core/search/index.ts` 本批 **+322 / −15**，其中 D4 部分：

- `withAbortTimeout(p, ms, label)`：`/search/aggregate` 单次聚合整体超时（`search.timeoutMs`，默认 8000ms），**超时平台落 `errors` 而不阻塞其余平台**——此前一个慢平台会拖住整个聚合响应；
- 聚合结果内存缓存（`search.cacheTtlMs`，默认 5min）+ **条目上限**（超出按插入序淘汰最旧，防长尾关键词无限堆积内存）；
- **in-flight 去重**：同关键词并发请求共享同一个 Promise，避免用户连点造成上游重复打；
- **默认 limit 统一为 30**：`adapters/tx/musicSearch.ts` 由 50 改 30、`adapters/mg/musicSearch.ts` 由 20 改 30，与 kw/kg/wy 对齐，配置项 `search.defaultLimit` 同源。

### 3.5 E1 / E2 / E3 —— 分页、真实封面、批量建单（#186）

- **E1**：`onSearch` 解除 `page:1` 硬编码，单曲结果区新增「加载更多」追加下一页。**渲染方式由 DOM append 改为数据层累积后统一 rerender**——追加页同平台并入既有分组（等价 #189 的 DOM append 合并，但在数据层做，重渲染零重叠），`hasMorePages` 判定链路保持不变；分页/筛选/排序三者的「加载更多」去留统一由 `rerender()` 按 `activeHasMore()` 决定，不再各写一套。
- **E2**：结果行渲染上游返回的 `item.img` 真实封面，`img` 绝对定位盖在音符渐变占位上，`onerror` 时移除 `img` 露出下层占位（与 `home.js` 的 `.hp-song-cover` 同范式）。
- **E3**：新建歌单走 `POST /playlists/import` **一次往返**批量建单；既有歌单无批量端点，仍逐首（见 §12 遗留）。

---

## 四、P1：下载引擎强化（F / G / H / I，#190）

### 4.1 F1 —— HTTP 错误分级（Transient / Permanent）

按状态码把失败拆为两个子类（`name` 属性区分，**鸭子类型判定跨模块安全**）：

- `TransientHttpError`：429 限流 + 5xx 源站临时故障 → 可退避重试或换源；
- `PermanentHttpError`：其余非 2xx（URL 确定性失效，如 410）→ 队列侧**熔断不重试**，避免对已知死链反复白跑。

导出 `makeHttpError(status)` / `isTransientHttpError(err)` / `isPermanentHttpError(err)`。判定用**双保险**（`name` 或 `httpStatus` 数值命中瞬态集合），因为 errors.ts ↔ download/index.ts ↔ orchestrator/index.ts 之间存在循环导入风险，刻意不用 `instanceof`（详见 §6.4）。

分级（F1）与错误码（M1）**互不替代**：分级决定「是否重试/熔断」，错误码决定「如何呈现/审计」——429 是 `TransientHttpError`（重试），错误码归 `ERR_HTTP_4XX`（呈现）。

### 4.2 F2 —— 断点续传

`streamDownload(url, dest, onProgress, opts)` 支持续传：

- `download.resume`（默认 `true`）开启时，临时名固定为 `.tmp-{taskId}`（持久化，跨重启存活）；
- 旁挂元数据 `.tmp-{id}.meta` 记录首轮的 `ETag` / `Last-Modified`，续传时校验；
- **206** → append 续写；**200**（服务端不支持 Range）→ truncate 从头重下；**ETag 失配**（内容已变更）→ 丢弃临时件重下，绝不拼接两个不同版本的字节流。

### 4.3 G1 / G2 —— 落盘归类与模板渲染

- **G2** `renderTemplate(template, meta, ext)`：文件名与目录模板**共用**同一套占位符渲染与逐段消毒（防路径穿越 / 非法字符）；
- **G1** `buildTargetDir(baseDir, meta)`：按 `download.dirTemplate` 计算落盘子目录，支持 `{singer}/{album}`、`{singerFirstLetter}/{singer}` 等；**未配置或空串 → 平铺返回 `baseDir`，行为与旧版完全一致**（默认零变更，是本批向后兼容的关键取舍）；
- `{singerFirstLetter}`：ASCII 字母取大写，中文用 `Intl` 拼音 collator 近似取首字母，其余归 `'Other'`。

### 4.4 H1~H5 —— 批量入队、批次视图、队列控制、精确计数、入队去重

`core/download/queue.ts` **+299 / −37**，`routes/download.ts` **+127 / −19**：

| 项 | 内容 |
|---|---|
| H1 | `enqueueBatch(inputs)` → 共享单一 `batchId`；新增 `GET /batches`、`GET /batches/:id`、`POST /batches/:id/cancel`（整批取消，返回受影响数）；单次上限 `download.batchMaxItems`（默认 200）。注：`POST /download/batch` **端点本身已存在**，本版新给的是「同批共享 `batchId`」这层身份与批次视图；实现上改为**先全量校验收集合法项、再一次性 `enqueueBatch`**（原为逐项 `enqueue`），响应新增 `batchId` 字段（无合法项时为 `null`） |
| H2 | 新增 `POST /playlists/:id/download-missing`（仅下未拥有项）；既有 `POST /playlists/:id/download`（整单批量下载）改为走 `enqueueBatch`，响应**新增 `batchId`** |
| H3 | `pause()` / `resume()` / `isPaused()` / `queueStatus()`；`POST /queue/pause`、`POST /queue/resume`、`GET /queue/status`（均 admin）。区分**用户暂停** `paused` 与 **RSS 护栏暂停** `memPaused` |
| H4 | `counts()` 改走 **DB 精确计数**——原实现 `list()` 后前端 filter 计数，受 list 分页上限**截断**（大队列下 status 里的数字是错的）。`GET /api/v1/status` 的 `tasks.{pending,active,completed,failed}` 全部改用它 |
| H5 | `enqueue` 去重：`download.dedupePolicy` = `skip`（默认，同曲同音质在途/已完成时**复用既有任务**）/ `replace`（取消在途重复项后新建）/ `always-new`（永不去重） |

`status.ts` 响应另新增两个字段（**契约扩展，非破坏**）：`activationBuffer`（批量背压下等待激活的任务数，超过 `batchActivationSize` 的在此排队，随完成分批激活）与 `queuePaused`。

`download_tasks` 新增 `batch_id TEXT` 列 + `idx_tasks_batch` 索引（`initDb()` 幂等迁移）。

**一处契约变化需注意**：`enqueue()` 由同步改为 **`async`**（因为 N3 磁盘预检与 H5 去重需查库/查磁盘），因此 `POST /api/v1/download` 与 `POST /api/v1/download/batch` 两个既有端点现在**可能返回非 201**：磁盘不足 → **507 + `{error:{code:'ERR_DISK_FULL',message}}`**（批量入队任一预检失败即**整批拒绝，不产生部分入库**），其余按 `errorToStatus(code)` 映射。旧客户端只判 201 的话，会把这类失败当「无响应」而非「明确拒绝」。

### 4.5 I1~I4 —— 前端全局下载指示器与队列批量操作

- **I1** 顶栏全局下载指示器 pill（`#dl-ind`）：任意页面都能看到队列在跑，含**队列聚合进度条**（总完成百分比 + 进行中/失败计数）；
- **I2** 队列批量操作：`暂停/恢复`（图标随态切换）、`全部取消`、`全部重试`、`清空失败`，按钮态随队列状态启停；新增**队列状态筛选 chips**（复用 library 的 `lib-filters` 范式）；
- **I3** 搜索结果行三态接入公共模块（作用域补齐：`.result-right button` 的 `padding:6px 14px` 特异性 (0,1,1) 会压过 `.row-dl` 的 `padding:0` (0,1,0)，需显式复位——这一 CSS 特异性坑在 #193/#199/#201 三批里反复出现，本版一并固化注释）；
- **I4** 已下载行点击 = 直接播（`player.playQueue` 消费 completed 任务，与 home/playlists 同语义）。

---

## 五、P1：搜索合并视图与本地排序（J / K，#191 / #193）

### 5.1 J1 —— 跨源合并去重（`buildMerged`）

新增 `GET /api/v1/search/merged?keyword=&platforms=&page=&limit=`，返回 `MergedTrack[]`（一首「歌」聚合多个平台的同一曲目，含 `sources[]` 供前端「展开看全部来源」逐项直接下载）。

- **去重主键**：`(filterStr(name).lower, filterStr(sortSingle(singer)).lower)`——`sortSingle` 对多歌手按分隔符（`、&;；/,，|`）拆分排序后重组，**消除多歌手顺序差异**（「A、B」与「B、A」视为同一曲目）；
- **辅键 `interval` ±5s**：时长差 > 5s → 拆成两条（不同版本/翻唱不误合并）；≤ 5s → 合并（容忍上游时长抖动）；
- **代表条目**：音质最高者优先，同档取首条（上游/评分原序）；
- **音质并集**：多组 `MusicQualityType` 求并集后按档位降序（`flac24bit > flac > 320k > 128k`）；
- 失败平台（`ok:false`）被忽略，不产生来源。

为复用同一套归一化内核，`adapters/match.ts` 把 `sortSingle` 与 `getIntv` 改为 **export**（仅加 export，`findMusic` 内部行为不变）；`adapters/common.ts` 的 `MusicInfo` 新增可选 `score?: number`（J2 写入，上游不产出）。

### 5.2 J2 —— 本地相关度评分（新增 `core/search/scoring.ts`，161 行）

在 `searchAggregate` / `searchMerged` 返回前对每条结果打分并据此排序，让「最像关键词、音质最好、时长最主流、平台权重最高」的结果排前面——**纯本地计算，不依赖上游排序**（上游排序口径各平台不一，且含商业推广位）。

评分因子：① `filterStr(name) == keyword` 精确命中 → 大额加分；② `filterStr(singer)` 包含 keyword（或拼音命中）→ 中额加分；③ `interval` 与**全结果集中位数**的偏差 → 偏差越大扣分越多（冷门/错版降权，中位数跨全结果集统一计算以保证同基准）；④ 音质档位阶梯加分；⑤ 平台权重乘数。叠加 J3 拼音三通道（name / singer / albumName）命中加分，多关键词按 token 命中率加权。

```
finalScore = (textScore + qualityScore + intervalScore) * platformWeight
```

平台权重默认 `{ kw:1, kg:1, tx:1.1, wy:1, mg:0.9 }`（QQ 音乐曲库全、音质高略加权；咪咕音质/匹配略弱略降权），可经 `search.platformWeights` 覆盖。**纯函数、无 IO**，单测直接注入 `MusicInfo` 夹具验证分值单调性。

### 5.3 J3 —— 拼音 / 首字母匹配（新增 `core/search/pinyin.ts`，136 行）

让关键词支持拼音全拼与首字母命中中文歌名/歌手/专辑：`zjl` → 周杰伦，`qingtian` → 晴天，`zhoujielun` → 周杰伦。依赖 `pinyin-pro`（本版新增运行时依赖）。设计要点：

- 全拼/首字母均按「整串连写小写」做**子串包含**比对，避免分词歧义；
- 结果带 Map 缓存（上限 4000）+ 按插入序淘汰，聚合/合并视图对同批 name/singer 反复求拼音时**零重复计算**；
- `tokenize()` 支持空格切分 + 中文 2-gram，多关键词按 token 命中率加权（供 J2 复用）；
- 与 #190 的 `Intl` 拼音 collator（用于 `{singerFirstLetter}` 目录首字母排序）**目标不同、刻意不复用**——那里要的是排序序，这里要的是匹配命中。

### 5.4 J4 —— 前端合并 / 分组双视图（#193）

`web/js/pages/search.js` 是本版最大单文件改动（**+1528 / −102**）：

- `.search-bar` 内新增胶囊二段视图切换（`按平台分组` 默认 / `按歌曲聚合`），与 `.lib-view-seg` 同语系；
- `renderMerged()` 消费 `/search/merged`，合并视图行默认折叠、点「来源数 + caret」展开 `sources[]` 另起一行（展开态跨 render 记忆）；
- 合并视图 badge：相关度 ★（金）/ 来源数（中性）/ **C4 不可达音质档位灰显**（删除线 + `cursor:help`，`title` 给原因）；
- **视图切换为本地重渲染 / 缓存复用，不丢搜索状态**；合并视图分页追加页 concat 进 `mergedData` 后统一 rerender；
- **降级保护**：`/search/merged` 不可用（旧 dist 未部署 / 5xx）→ **自动回退分组视图，不让搜索页变空壳**；C4 capabilities 端点缺失 → 静默降级为不灰显（零回归）。

### 5.5 K1 / K2 —— 筛选与排序（#193）

- **K1** `#search-filters` chips（来源 / 音质 / 歌手 / 专辑），复用 `library.js #lib-filters` 的 `.lf-label`/`.lf-sep`/`.lib-chip` 范式；组内单选、点击委托；歌手/专辑 chips **最多展示若干条**，长尾不进 chips 以免撑爆工具条；配 `#search-filter-summary`「显示 X / Y」计数摘要（弱化小字 + 等宽数字，切换时宽度不抖动）。
- **K2** `#search-sort`（相关度默认 / 时长 / 音质 / 平台），**纯前端渲染前 sort**：相关度 = 合并视图 `MergedTrack.score` 降序，分组视图 = 后端已排序原序；「平台」在分组视图下语义 = 分组自身顺序（组内条目平台恒定，组内再排无意义）。排序偏好跨搜索保留（更符合直觉），筛选与展开态则随新搜索重置。

---

## 六、P2：音源编排、审计与性能（L / M / N）

### 6.1 L1 —— 音源健康排序（新增 `core/source-engine/source-health.ts`，165 行）

**离线信号**：从 `smoke_results` 聚合每个音源「近 N 次冒烟 run」的整体成功率（`computeSourceHealth`），`orchestrator.resolveSourceOrder()` 据此把「近 N 次全失败」的音源**降权排到候选末尾**（`orderByHealth`），优先尝试健康音源——直接减少每个任务在坏源上白跑 30s。开关 `sources.healthAware`（默认 `true`）。

### 6.2 L2 —— 音源级熔断器

**在线信号**：运行期同一 `sourceId` 在滑动窗口内连续失败累计 ≥ K 次即「打开」，后续任务临时把该源从候选剔除（`filterCircuitOpen`）；窗口内失败自然老化后自动「半开」恢复。阈值 `sources.circuitThreshold`（默认 5）、窗口 `sources.circuitWindowMs`（默认 300000 = 5min）。与 L1 互补：**L1 靠定时冒烟的历史，L2 靠实时下载失败的即时反馈**。

**两个信号都遵循「绝不清空候选」原则**：若剔除后为空则回退原候选（half-open 允许再试），避免把「暂时抖动」放大成 `ERR_NO_SOURCE` 永久失败。

### 6.3 L3 —— 音源级令牌桶限速

`SourceEngine` 内每音源一个桶（`Map<sourceId, {tokens, last}>`），`callAction` 入口先 `acquireSourceToken` 再下发 worker：`tokens` 可透支为负（负值代表排队等待量），按 `sources.ratePerMin` 匀速回填；桶容量 `max(1, ceil(ratePerMin/6))`，允许约 10s 突发量的瞬时并发，其后回归均速。与全局 `rateLimit` 协同防打爆上游风控。

**`ratePerMin <= 0`（默认 0）时 `acquireSourceToken` 立即返回，与 L3 引入前行为完全一致**——默认零变更。为插入 await，`callAction` 由返回 `Promise.reject(...)` 改为 `async` + `throw`（语义等价，调用方一律 await/catch）。

### 6.4 M1 —— 结构化错误码（新增 `core/download/errors.ts`，139 行，#198）

把异构失败原因（DNS / 超时 / HTTP 4xx-5xx / 无音源 / 全源失败 / 标签嵌入 / 磁盘满）归一为一组稳定错误码，供三处消费：

1. `download_tasks.error` 存 `{code, message}` JSON（`decodeError` **向后兼容**旧纯字符串行）；
2. `download_attempts.error_code`（M2 每次换源/重试的审计轨迹）；
3. HTTP 响应（`errorToStatus` 映射状态码：O1 preview / N3 磁盘满 → 507 等）。

**刻意用鸭子类型**（探测 `name` / `httpStatus` / `attempts` 字段）而非 `instanceof`：避免 `errors.ts` ↔ `download/index.ts` ↔ `orchestrator/index.ts` 的循环导入。

### 6.5 M2 —— `download_attempts` 审计轨迹（#198）

新表 `download_attempts`（+ `idx_attempts_task(task_id, ts)`）记录每次换源/降级/重试：哪个源、什么音质、成功与否、错误码、耗时。新端点 `GET /api/v1/tasks/:id/attempts`，随任务级联删除。

前端在队列行提供**「为什么失败」懒加载展开钮**：首次展开才拉 attempts 并缓存，展开态跨 render 记忆、文案随态切换；面板覆盖加载中 / 加载失败 / 空 / 轨迹表四态，`error_code` 经映射转人类可读中文（未命中回退原文，`null`/空 = 该次尝试成功），时间戳兼容秒级兜底。

### 6.6 N1 / N2 / N3 —— 并行、节流、磁盘预检

- **N1** 封面与音频**并行**下载（原为串行）；单测用本地 HTTP 服务**观测到达时序**验证并行性，而非只看结果；
- **N2** SSE `task:progress` 节流：100ms / 1% **双阈值**，与 SQLite 落盘节流**解耦**（两者阈值独立，避免「为了少写库而让前端进度卡顿」或反之）；
- **N3** 入队前磁盘空间预检：`download.diskPrecheck`（默认 `true`）+ `download.minFreeBytes`（默认 104857600 = 100MB），可用空间不足时**拒绝入队**并返回 HTTP **507 + `ERR_DISK_FULL`**（依赖 `check-disk-space`，本版新增运行时依赖）。在入队时刻拒绝而非下载中途失败，是为了不浪费一次完整的取流与用户等待。

---

## 七、P2：体验高阶（O1~O5）

### 7.1 O1 —— 结果内试听（新增 `routes/preview.ts`，77 行，#201）

`GET /api/v1/preview?platform=&songmid=&quality=&name=&singer=`：走 `orchestrator.resolveUrl` 取音源直链，成功 **302 重定向**到该直链（`<audio>` 自动跟随；同源请求自动携带登录 Cookie），**不落地、不占下载配额**；失败给结构化错误码（复用 M1 的 `classifyError` / `errorToStatus`，不另造映射）。

两个刻意取舍：

- **与下载链路共享音源选择/限流**——L1 健康排序、L2 熔断、L3 令牌桶都内建在 `resolveSourceOrder` 与 `sourceEngine.callAction` 里，本路由复用 orchestrator 即**自动继承**，无需另建通道；
- **`allowToggleSource:false`**——试听针对「这一首」，跨平台换源会换成另一首歌，语义不符（下载才需要换源兜底）。故 preview 命中失败即失败，不做换源。

前端行内试听钮（耳机图标，与心形同尺度、强调橙）：播放中实心橙常亮 + 图标切暂停条，加载中半透明 + 旋转环并禁用点击防重复触发；主播放器起播/切歌时**停止试听**（两条音频不叠加）；窄屏同步放大可点区。

### 7.2 O2 —— 「我喜欢」收藏（新增 `web/js/favorites.js`，228 行，#199）

与 `download-state.js` 同范式收敛：搜索结果行（分组视图 / 合并视图 `MergedTrack` / 合并展开区各 source）与 now-playing 播放器**共用同一份收藏态与同一套心形控件**，避免各页各持一份 Set 导致「搜索页点了心形、播放器不同步」。

- `ref` 口径统一走 `songKey(platform, songmid)` → `platform:songmid`（与 owned Map / 批量去重同 key，跨页天然对齐；后端 `ref` 为自由字符串，无自带口径）；`kind` 固定 `'track'`（服务端白名单 `track|playlist|square`）；
- **乐观更新**：先翻本地集合 + 广播事件刷新所有心形，再落库；失败**回滚并 toast**；
- 事件：`document` 上派发 `favorites:changed`，`detail = { ref, favored, reason }`，`reason ∈ 'load'（快照到位）| 'toggle'（本次点击）| 'rollback'（落库失败回滚）`；
- 每次进页**对账收藏快照**（其他页/其他设备新增的收藏在此补齐，到位后自动广播刷新心形）；
- 后端契约（只读确认于 `routes/me.ts`，未改动）：`GET /me/favorites`、`POST /me/favorites {kind,ref}`、`DELETE /me/favorites/:kind/:ref`；护栏 `kind` ∉ 白名单 → 400，`ref` 非空且 ≤1024 字符，`UNIQUE(uid,kind,ref)` 天然去重。

视觉上：底部播放条沿用 `.pb-mode` 的 32px 圆钮尺度、仅换强调色为 `--fav`；np 面板封面卡右下角悬浮心形（毛玻璃背板，不占布局、不挡封面主体）；NAS 扫描曲（无 platform/songmid）**不可收藏、不占视觉重量**；反馈动画一次 pop，**仅用户 toggle 时由 JS 加 `.pop`**（避免重渲染时满屏齐跳）。

### 7.3 O3 —— 歌手 / 专辑名可点击二次搜索（#199）

`.rs-link` 沿用 `.result-artist` 的 12px/弱色文本，hover 转强调色 + 下划线；点击即以该词发起搜索。`#results` 改为**统一点击委托**，一处处理：加载更多 / 歌手专辑二次搜索（O3）/ 试听（O1）/ 收藏心形（O2）/ 展开来源（J4）/ 已下载直接播（I3）/ 行内单首下载——此前是多个分散的 listener。

### 7.4 O4 —— 错字容错（新增 `core/search/correct.ts`，138 行，#200 / #201）

当聚合/合并搜索结果过少（`< search.correctMinResults`，默认 3）时，用**历史成功搜索词**作词典，找出与用户输入编辑距离 ≤ 1 的高频候选，作为**纠错建议**返回（前端提示「已为你搜索 X，仍要搜索 Y?」）。

**绝不自动替换用户原词**——是否改用建议由用户决定（这是明确的产品红线：静默改写查询会让用户以为搜的就是自己输入的词）。

实现要点：词典来源 `search_history` 全时段高频词（`globalTop(0, N)`），以频次作打分权重（越多人搜过的词越可能是正确写法）；**capped Levenshtein（上限 1）**——一旦某行最小值 > max 立即剪枝返回，避免整表 DP；词典带 60s 内存缓存 + LRU 上限（纠错仅在结果稀疏时触发，DB 压力可忽略）；归一化 trim + 小写后比对，但返回的 `corrected` 用词典里的**原词**（保留用户历史的真实写法）。`editDistanceWithin` 为纯函数无 IO，供单测直接验证。

### 7.5 O5 —— 相关推荐（#200 / #201）

`GET /api/v1/search/related?kw=&limit=`：基于**搜索历史共现**推荐「搜过 X 的人也搜 Y」。新表 `search_cooccurrence`（+ `idx_cooc_a(a, count DESC)`）做全局共现统计（`searchCoocStore`）。**冷启动回退 trending**——共现数据不足时返回热搜榜，端点永不空响应。开关 `search.relatedEnabled`（默认 `true`）。

前端在歌曲搜索完成后拉取并渲染为 chips，点击即以该词发起搜索；仅歌曲搜索响应可能带 `corrected`（歌单搜索 `data` 无该字段，`captureCorrect(null)` 静默隐藏）；新一轮搜索清空纠错建议与相关推荐、停止进行中的试听。

---

## 八、缺陷修复（随批次一并交付）

### 8.1 #196 系列：`/tasks/owned` 完整性 + `total` + `mergeOwned` 覆盖

三处相关缺陷，均由 bench/大队列场景暴露：

1. **`/tasks/owned` 不完整**：原实现走带分页的 `list()`，任务数超上限时**终态任务被截断**，前端 owned 判定漏项 → 已下载的歌仍显示「下载」钮。修复：新增 `listOwned()` 轻量数据源——全部终态任务（`completed` / `completed_with_warnings` / `failed`），仅含 owned 判定所需字段（`key/status/quality/hasFile`），**无分页**；
2. **`/tasks` 缺 `total`**：补 `total` 字段（同条件全量计数，来自 H4 的 `queue.counts()` 聚合），供前端分页判定；
3. **`mergeOwned` 状态覆盖**：同一任务 `active → failed` 时未无条件覆盖，导致失败任务在前端仍显示下载中。修复为无条件覆盖（纯逻辑，单测直接验证）。

`#199` 侧另加一道**防御**：`/tasks/owned` 轻量端点以 `filePath:'yes'` 占位「有文件」，前端不得把该占位当真实路径使用。

### 8.2 M-1（#203）：直连取流阶段失败补写审计轨迹

**缺陷**：#198 的 `persistAttempts` 仅覆盖 orchestrator 的 `ResolveAttempt`（换源/降级）路径。当编排**已成功取到 URL**、但实际取流阶段失败（HTTP 410/4xx/5xx、超时、DNS 等，任务级 `error=「下载失败: HTTP 410」`）时，错误不携带 `attempts` → `download_attempts` **无行** → 前端「为什么失败」面板**空态**，用户看不到任何线索。

**修复**：`runOnce` 把 `downloader.download()` 的失败包装为一行 `ok:false` 的 `directAttempt` 挂到 **`err.directAttempts`（独立属性）**，`run()` 的 catch 统一 `persistAttempts`。

用独立属性而非塞进 `attempts` 是关键：`classifyError` 以 `attempts` 作为「全源失败」信号，混入会**污染错误分类**。回归单测（`server/test/download-m1.test.ts`）通过 mock `orchestrator.resolveUrl`（命中）+ `downloader.download`（抛 HTTP 错误）驱动**真实 `queue.run()`**，断言审计行落库且字段/错误码正确，并断言既有编排路径（全源失败）审计**不回归**、任务级 error 文案/码**不变**。独立文件（`node --test` 每文件独立进程，mock 单例不污染其它测试）。

### 8.3 `settings-probe.ts` 输出 flush 时序

`#191` 给 config 加 `search.platformWeights` / `suggestPlatforms` 后，探针输出的 JSON 变大，触发 **`Unterminated string in JSON`**——原实现在 `process.stdout.write(...)` 后立刻 `process.exit(0)`，而 `process.exit` 会**截断尚未 flush 的管道写入**。修复：把 `exit` 放进 `write` 的回调，确保整行 JSON 完整落盘后再退出。**不削弱任何断言，仅修 flush 时序**（`+7 / −3`）。

同批 `config.merge.test.ts`（`+32 / −5`）随 config 新增 `search` 顶层块更新结构完整性总闸断言：顶层块由 **8 个增至 9 个**（`['auth','download','log','rateLimit','scrape','search','server','smokeTest','sources']`），「用户从未写过的字段被写成显式默认值」的新增固化块清单同步加 `search`。

---

## 九、配置面、依赖与打包

### 9.1 新增配置项（全部可选，未配置时代码侧用默认值 → 老 `config.yaml` 零改动可用）

`core/config.ts` **+61 / −2**：新增 `search` 顶层块，并给 `download` / `sources` 两块扩字段。`RoConfig` 顶层块由 8 增至 9。

| 块 | 新键 | 默认值 | 说明 |
|---|---|---|---|
| `download` | `onConflict` | `suffix` | B1 同名冲突策略（`suffix`/`overwrite`/`skip`） |
| `download` | `verifyIntegrity` | `true` | B2 完整性校验 |
| `download` | `detectRealQuality` | `true` | C1 真实音质回写 |
| `download` | `dirTemplate` | `''` | G1 落盘子目录模板（空 = 平铺，行为同旧版） |
| `download` | `dedupePolicy` | `skip` | H5 入队去重（`skip`/`replace`/`always-new`） |
| `download` | `batchMaxItems` | `200` | H1/H5 批量入队单次上限 |
| `download` | `resume` | `true` | F2 断点续传 |
| `download` | `diskPrecheck` | `true` | N3 入队前磁盘预检 |
| `download` | `minFreeBytes` | `104857600` | N3 最小可用字节（100MB） |
| `sources` | `healthAware` | `true` | L1 健康排序 |
| `sources` | `circuitThreshold` | `5` | L2 熔断阈值 |
| `sources` | `circuitWindowMs` | `300000` | L2 熔断滑动窗口 |
| `sources` | `ratePerMin` | `0` | L3 每音源限速（0 = 不限速，行为同旧版） |
| `search` | `timeoutMs` | `8000` | D4 聚合整体超时 |
| `search` | `cacheTtlMs` | `300000` | D4 内存缓存 TTL |
| `search` | `defaultLimit` | `30` | D4 各平台默认条数 |
| `search` | `platformWeights` | `{kw:1,kg:1,tx:1.1,wy:1,mg:0.9}` | J2 平台权重乘数 |
| `search` | `suggestPlatforms` | `[wy,tx,kg]` | D2 联想标题池取榜平台 |
| `search` | `correctEnabled` | `true` | O4 纠错开关 |
| `search` | `correctMinResults` | `3` | O4 触发阈值 |
| `search` | `relatedEnabled` | `true` | O5 相关推荐开关 |

三处同源落地，口径一致：`config.example.yaml`（**+37**，逐项带注释与默认值）、`fpk/cmd/_common` 的 `render_config` 模板（**+27**，新装/重装现场直接拿到显式默认值）、`core/config.ts` 的 `buildDefaultConfig`。

### 9.2 `settings` PATCH 校验（`routes/settings.ts` +143）

新键全部纳入 PATCH 校验（此前新键会被静默写入任意值）：`dirTemplate` 类型、`batchMaxItems` / `minFreeBytes` / `circuitThreshold` / `circuitWindowMs` / `ratePerMin` / `correctMinResults` 数值化、`platformWeights` 逐键数值校验、`suggestPlatforms` 逐项 `isPlatform()` 白名单校验（非法平台名进不来）。`DEFAULT_PLATFORM_WEIGHTS` 与 `DEFAULT_SUGGEST_PLATFORMS` 与 `config.ts` 同源。

### 9.3 `sources/capabilities`（C4，`routes/sources.ts` +24）

新增 `GET /api/v1/sources/capabilities?platform=`，供前端 J4 合并视图**灰显不可达音质档位**（删除线 + `cursor:help` 给原因）。前端对旧 dist 无该端点的情形静默降级为不灰显。

### 9.4 新增运行时依赖（2 个）

| 依赖 | 版本 | 用途 |
|---|---|---|
| `check-disk-space` | ^3.4.0 | N3 磁盘空间预检 |
| `pinyin-pro` | ^3.29.4 | J3 拼音 / 首字母匹配 |

均 MIT，已入 `server/package.json` 与 `server/package-lock.json`（lockfile 版本收敛见 §9.5，registry 归一见 §9.6）。

### 9.5 版本承载点一致 bump 至 0.2.19（8 文件 / 12 处）

| 文件 | 承载点 |
|---|---|
| `server/package.json` | `version` |
| `server/package-lock.json` | 顶层 `version` + `packages[""].version`（2 处）。**注**：基线 `3c0311e` 里这两处长期漂移为 `0.2.1`（与 `package.json` 的 `0.2.18` 不一致，属历史遗留），本版一并收敛为 `0.2.19`，两文件版本首次对齐——故本行实际替换是 `0.2.1 → 0.2.19`，其余 7 文件为 `0.2.18 → 0.2.19` |
| `fpk/manifest` | `version=`；另**重写面向用户的 `changelog=` 文案**（原为 0.2.18 维护性更新文案，现按本版下载/搜索/音源三条主线重写，用用户视角语言、不含内部工作项编号） |
| `server/src/routes/status.ts` | 运行时上报 `version` |
| `server/src/core/adapters/scrape-detail.ts` | MusicBrainz `MB_UA` |
| `API.md` | `/api/v1/status` 响应示例 `version` |
| `scripts/verify-image.sh` | 默认镜像 tag（用法注释 2 处 + `IMAGE` 默认值 1 处） |
| `docs/FNOS-DEPLOY.md` | 标题；另 #155 章「重装验证推迟到」前向引用（沿 `3c0311e` 先例同步前推） |

历史归档中的「自 v0.2.12 起」「v0.2.15 起」等**特性引入标记与真机验证记录按事实保持原版本号不动**（同 `006f797` / `91bf9b8` 先例）；`docs/CHANGELOG-0.2.15.md`、`CHANGELOG-0.2.16.md`、`CHANGELOG-0.2.18.md` 作为历史归档不改写。

12 处承载点的替换统计（`git diff 3c0311e HEAD` 实证，不含本文自身）：删除 **10 行 `0.2.18` + 2 行 `0.2.1`（lockfile 漂移值）→ 写入 12 行 `0.2.19`**。lockfile 与 `package.json` 的版本自此保持一致，后续 bump 须同时改这两处（`npm install` 亦会自动同步）。

### 9.6 发布前修正：lockfile 内网 registry 归一

本版新增的两个依赖是在内网环境安装的，`package-lock.json` 里其 `resolved` 字段被写成内网 npm 镜像主机名（2 处），而 lockfile 其余 **277 处**均为公共镜像 `registry.npmmirror.com`（与 `Dockerfile` 里 `npm_config_registry` 一致）。

这是**必须修的发布阻断项**，两条理由：① CI 的 `npm ci`（`build.yml` 两处）与 GitHub runner 无法解析内网主机名 → docker/fpk/release 三 job 会直接失败；② 仓库公开，内网主机名属不应外泄的内部信息。

修法：把 2 处 `resolved` 主机名归一为 `registry.npmmirror.com`（**URL 路径格式完全相同**，`/<pkg>/-/<pkg>-<version>.tgz`）。安全性已实证：两个包在公共镜像上的 `dist.integrity` 与 lockfile 中现有 `integrity` **逐字节一致**（`check-disk-space@3.4.0`、`pinyin-pro@3.29.4` 均为 `sha512-drVk…`/`sha512-SPXpDT…`），即同一份 tarball，改的只是下载来源主机名。修正后全仓 `resolved` 主机名**单一化**，本地门禁 build/test 段复跑全绿。

---

## 十、测试与门禁

### 10.1 单元测试：100 → **219**（+119，0 fail / 0 skip，28 suites）

新增 8 个测试文件（全部沿用既有 `env-sandbox` 前置：把 `RO_CONFIG` / `RO_DB_DIR` 指向临时目录，**不污染仓库 `data/` 与 `config.yaml`**）：

| 文件 | 行 | 覆盖 suite |
|---|---|---|
| `test/download-hardening.test.ts` | 284 | B1 冲突后缀 / B2 完整性校验 / C1 真实码率解析 |
| `test/download-p1.test.ts` | 293 | F1 错误分级 / F2 断点续传（Range 206/200/ETag 失配）/ H5 入队去重 |
| `test/download-p2.test.ts` | 383 | L1 健康排序 / L2 熔断 / M1 错误码映射 / M2 审计轨迹 / N1 封面音频并行 / N3 磁盘预检 / O1 preview 路由 |
| `test/download-m1.test.ts` | 185 | M-1(#203) 直连取流失败落审计 |
| `test/download-196-fix.test.ts` | 249 | #196-fix2 `/tasks/owned` 完整性 + `total` / #196-fix3 `mergeOwned` 覆盖 |
| `test/search-infra.test.ts` | 268 | D1 历史封顶+去重置顶+uid 隔离 / D2 复合 key 去重 / D4 缓存命中+in-flight |
| `test/search-merged.test.ts` | 262 | J1 跨平台去重+sources+interval 辅键 / J2 评分因子 / J3 拼音全拼+首字母+tokenize |
| `test/search-correct-related.test.ts` | 198 | O4 capped Levenshtein + 词典纠错 / O5 共现统计 + 相关推荐编排 |

既有 `test/config.merge.test.ts` 随 `search` 顶层块更新断言（8 → 9 块），`test/fixtures/settings-probe.ts` 修 flush 时序（§8.3）。

**测试取向**：优先测纯函数与可观测时序，不测实现细节——`scoring` / `pinyin` / `correct` / `buildMerged` 均为无 IO 纯函数，直接注入夹具断言单调性与边界；`N1` 并行性用本地 HTTP 服务**观测到达时序**而非只看结果；`M-1` 用 mock 驱动**真实 `queue.run()`** 走完整链路。

### 10.2 本地门禁 `scripts/verify-ci.sh --skip-docker`

| 段 | 结论 | 说明 |
|---|---|---|
| `heal` | **PASS** | `bash -n` 语法 / `--help`=0、未知参数=1、非 root `--dry-run`=4 退出码契约 / 530 红线关键字在位 / reboot-restart 命中行均为禁止类提示文案 |
| `meta` | **PASS** | `VERSION=0.2.19`（取自 `fpk/manifest`），格式合法，推导 `image_tag=v0.2.19` |
| `build` | **PASS** | `npm run typecheck` + `npm run build` 全绿（`rainbow-server@0.2.19`） |
| `test` | **PASS** | `npm test` **219 / 219**，28 suites，0 fail / 0 skip |
| `docker` | SKIP | 本机无 Docker 运行时（`--skip-docker`），结论未经本门禁验证；正式产物由 CI 的 docker job 构建 |
| `fpk` | **PASS** | 以官方 `fnpack`（`FNPACK_BIN=tools/fnpack`）真构建 `rainbow-0.2.19.fpk`（112K，检出 `app.tgz` 官方结构并二次解包）；`TAG_CONSISTENCY` / `DOWNLOAD_MOUNT` / `WIZARD_FIELD` / `DDIR_CONVERGE` / `LIBRARY_SHARE` 全 PASS；`DIGEST_PIN_SKIP`（未提供 `FPK_IMAGE_DIGEST`，本地门禁正常形态，正式发布由 CI 注入） |

> **汇总：门禁结论 PASS（可发布）**，1 段 SKIP（docker，本机无运行时）。
>
> 注：`tools/fnpack` 未在 `PATH` 中时，`build-fpk.sh` 会走**降级手工 tar 组装**（产物仅供本地验证，包级断言仍会跑）。本版门禁**显式指定 `FNPACK_BIN` 走官方 fnpack 路径**，与 v0.2.17/v0.2.18 的取证强度对齐；降级路径亦已单独跑通（240K 产物，5 项断言同 PASS）。

### 10.3 本版已完成的其它验证（不在本仓库留痕，仅结论）

改动在提交前已通过：219 单测全绿、`verify-ci.sh --skip-docker` PASS、浏览器端 E2E PASS、`bench` 无回归；工作区已清理干净（无 `bench-report.md`、无 QA 残留、无 `*.log` 误入）。

---

## 十一、明确没有做的事

诚实记录边界，避免读者高估本版：

1. **没有 push、没有打 tag、没有触发 CI**。本提交只落本地 `main`（领先 `origin/main` 恰好 1 个 commit）。公开发布是后续独立任务，需检查点确认后另行授权派发。
2. **没有做真机（fnOS）验证**。本机无 Docker 运行时，docker 段 SKIP；`.fpk` 未在飞牛真机安装/升级验证。#155 的「重装验证」继续前推到 v0.2.19（`docs/FNOS-DEPLOY.md` 已同步）。
3. **没有改 `API.md` 的端点契约文档**。本版新增 **18 个端点（16 条新路径）**：`GET /search/merged`、`GET /search/suggest`、`GET /search/trending`、`GET /search/related`、`GET /preview`、`GET /tasks/owned`、`GET /tasks/:id/attempts`、`GET /batches`、`GET /batches/:id`、`POST /batches/:id/cancel`、`POST /queue/pause`、`POST /queue/resume`、`GET /queue/status`、`GET|POST|DELETE /me/search-history`（3 个）、`GET /sources/capabilities`、`POST /playlists/:id/download-missing`；另有 **2 个既有端点的契约变化**（`GET /tasks` 补 `total` 与 `batchId` 筛选；`GET /api/v1/status` 响应补 `activationBuffer` / `queuePaused`）与 **2 个既有端点的新失败态**（`POST /download`、`POST /download/batch` 可返 507，§4.4）——**均未写入 `API.md`**；`API.md` 本次只改了 status 示例里的版本号。契约文档补齐列为下一批工作（§12）。
4. **没有做数据库迁移回滚脚本**。新表/新列均为 `CREATE TABLE IF NOT EXISTS` / `ADD COLUMN` 幂等前向迁移，**不提供降级路径**（与既有 `initDb()` 口径一致）。
5. **没有改既有歌单的批量下载端点**。E3 只让「新建歌单」走 `/playlists/import` 一次往返；**既有歌单仍逐首提交**（§12）。
6. **没有触碰 `data/` 运行时数据、没有重启服务**（服务当前处于停止状态，保持停止）。
7. **没有改 plan 文件**，没有删除或移动任何已 push 的 tag（`v0.2.17` 烧号留档红线继续有效）。
8. **没有引入前端构建链路**。`web/` 仍是原生 ES module + 手写 CSS，新增 2 个公共模块（`download-state.js` / `favorites.js`）靠 import 复用，不引入打包器/框架。

---

## 十二、已知盲区与遗留

1. **`API.md` 契约文档滞后于实现**（§11.3）。这是本版最大的文档债：18 个新端点 + 4 个既有端点的契约变化只有代码注释与本文描述，`API.md` 里没有。**优先级最高**，因为仓库公开、`API.md` 是外部集成的唯一入口；且 `enqueue` 转异步后新增的 507 失败态属于**会被旧客户端误判**的变化，必须成文。
2. **既有歌单缺批量下载端点**：前端只能逐首提交，大歌单会产生 N 次往返。建议后端补 `POST /playlists/:id/batch-download` 或让 `/playlists/import` 支持追加。
3. **`search_cooccurrence` 冷启动期长**：共现数据依赖真实搜索积累，新部署长期回退 trending，O5 的实际收益要到有使用量之后才显现。
4. **O4 词典质量依赖历史搜索词**：词典来自 `search_history` 高频词，冷部署或历史被清空时纠错无候选（此时静默不建议，不会误纠）。
5. **L1 健康度依赖 `smoke_results`**：`smokeTest.enabled=false` 的现场 L1 无数据可聚合，健康排序退化为原序（不报错，但也不生效）。
6. **F2 续传依赖上游支持 Range**：不支持时（返回 200）truncate 重下，用户感知为「续传没生效」，无显式提示。
7. **N3 的 `minFreeBytes` 是静态阈值**：不估算本次下载的实际体积（无损单曲可达数十 MB，批量 200 首可达数 GB），因此「预检通过但下到一半磁盘满」仍可能发生——此时由 M1 的 `ERR_DISK_FULL` 兜底呈现。
8. **CSS 特异性坑反复出现**：`.result-right button{padding:6px 14px}` (0,1,1) 压过 `.row-dl`/`.row-fav`/`.row-preview` (0,1,0)，#193/#199/#201 三批各自踩到并各自加复位。已固化注释，但**根治需要重构该选择器**（改为类名而非元素选择器）。
9. **`web/js/pages/search.js` 体量偏大**（本版 +1528 后成为最大前端文件）。分组视图 / 合并视图 / 筛选 / 排序 / 分页 / 试听 / 收藏 / 纠错 / 推荐九件事集中在一页，后续应考虑按视图拆分模块。
10. **前端无自动化测试**：本版前端验证靠浏览器 E2E 人工执行，未沉淀为可复跑的自动化用例（`download-state.js` / `favorites.js` 的纯逻辑部分其实可测）。

---

## 附录：文件级 numstat（本版发布提交，基线 `3c0311e`）

**39 个修改文件（+4702 / −420，不含本文）+ 19 个新增文件**：

```
1       1       API.md                                        （§9.5 版本承载点）
37      0       config.example.yaml                           （§9.1 新配置项）
2       2       docs/FNOS-DEPLOY.md                           （§9.5 标题 + #155 前向引用）
27      0       fpk/cmd/_common                               （§9.1 render_config 模板）
2       2       fpk/manifest                                  （§9.5 version= + changelog=）
3       3       scripts/verify-image.sh                       （§9.5 默认镜像 tag）
19      2       server/package-lock.json                      （§9.4/§9.5/§9.6 依赖 + 版本 + registry 归一）
3       1       server/package.json                           （§9.4/§9.5 依赖 + 版本）
2       0       server/src/core/adapters/common.ts            （§5.1 MusicInfo.score）
5       2       server/src/core/adapters/match.ts             （§5.1 sortSingle/getIntv 导出）
2       1       server/src/core/adapters/mg/musicSearch.ts    （§3.4 D4 limit 20→30）
1       1       server/src/core/adapters/scrape-detail.ts     （§9.5 MB_UA）
2       1       server/src/core/adapters/tx/musicSearch.ts    （§3.4 D4 limit 50→30）
61      2       server/src/core/config.ts                     （§9.1 search 块 + download/sources 扩字段）
188     4       server/src/core/db/index.ts                   （§3.1/§6.5/§7.5/§2.5/§4.4 3 新表 + 4 新列 + 索引）
401     46      server/src/core/download/index.ts             （§2.3/§2.4/§2.5/§4.1/§4.2/§4.3/§6.6 B1/B2/C1/F1/F2/G1/G2/N1）
299     37      server/src/core/download/queue.ts             （§4.4/§8.1/§8.2 H1~H5 + #196 + M-1）
20      6       server/src/core/orchestrator/index.ts         （§6.1/§6.2 L1/L2 接入 resolveSourceOrder）
322     15      server/src/core/search/index.ts               （§3.4/§5.1/§5.2/§7.4 D4 + J1 + J2 + O4）
39      5       server/src/core/source-engine/index.ts        （§6.3 L3 音源级令牌桶）
2       0       server/src/index.ts                           （§7.1 注册 previewRoutes）
127     19      server/src/routes/download.ts                 （§4.4/§8.1 批次 + 队列控制 + attempts + owned）
56      0       server/src/routes/me.ts                       （§3.1 D1 search-history 三端点）
50      6       server/src/routes/playlists.ts                （§4.4 H2 download-missing）
64      0       server/src/routes/search.ts                   （§3.2/§3.3/§5.1/§7.5 merged/suggest/trending/related）
143     0       server/src/routes/settings.ts                 （§9.2 PATCH 校验）
24      0       server/src/routes/sources.ts                  （§9.3 C4 capabilities）
11      7       server/src/routes/status.ts                   （§4.4 H4 DB 精确计数 + 2 新字段 + §9.5 版本）
32      5       server/test/config.merge.test.ts              （§8.3 8→9 顶层块断言）
7       3       server/test/fixtures/settings-probe.ts        （§8.3 flush 时序修复）
81      0       web/index.html                                （§2.2/§4.5/§5.4/§5.5/§7.2/§7.4/§7.5 新控件与容器）
171     1       web/js/api.js                                 （§2.2 A2 统一音质 + 新端点封装）
83      1       web/js/main.js                                （§4.5 I1 顶栏全局下载指示器）
34      64      web/js/pages/home.js                          （§2.1 A1 迁移到公共模块，净删 30 行）
225     21      web/js/pages/library.js                       （§4.5 I1/I2 队列聚合进度 + 批量操作 + §6.5 失败原因面板）
21      59      web/js/pages/playlists.js                     （§2.1 A1 迁移到公共模块，净删 38 行）
1528    102     web/js/pages/search.js                        （§3.5/§5.4/§5.5/§7.1~§7.5 E1~E3 + J4 + K1/K2 + O1~O5）
59      1       web/js/player.js                              （§7.1/§7.2 试听互斥 + 播放器心形）
548     0       web/style.css                                 （§2.2/§4.5/§5.4/§5.5/§7.1~§7.5 全部新视觉）
```

**19 个新增文件**（`A`）：

```
server/src/core/db/searchHistory.ts            176   §3.1 D1 搜索历史持久化层
server/src/core/download/errors.ts             139   §6.4 M1 结构化错误码中枢
server/src/core/search/correct.ts              138   §7.4/§7.5 O4 纠错 + O5 相关推荐编排
server/src/core/search/pinyin.ts               136   §5.3 J3 拼音 / 首字母匹配内核
server/src/core/search/scoring.ts              161   §5.2 J2 本地相关度评分
server/src/core/search/suggest.ts              272   §3.2/§3.3 D2 联想 + D3 热搜
server/src/core/source-engine/source-health.ts 165   §6.1/§6.2 L1 健康聚合 + L2 熔断器
server/src/routes/preview.ts                    77   §7.1 O1 音源直链流式代理
server/test/download-196-fix.test.ts           249   §8.1 #196 系列回归
server/test/download-hardening.test.ts         284   §2.3/§2.4/§2.5 B1/B2/C1
server/test/download-m1.test.ts                185   §8.2 M-1(#203) 回归
server/test/download-p1.test.ts                293   §4.1/§4.2/§4.4 F1/F2/H5
server/test/download-p2.test.ts                383   §6.1~§6.6/§7.1 L/M/N/O1
server/test/search-correct-related.test.ts     198   §7.4/§7.5 O4/O5
server/test/search-infra.test.ts               268   §3.1/§3.2/§3.4 D1/D2/D4
server/test/search-merged.test.ts              262   §5.1/§5.2/§5.3 J1/J2/J3
web/js/download-state.js                       202   §2.1 A1 三态下载状态公共模块
web/js/favorites.js                            228   §7.2 O2 「我喜欢」收藏公共模块
docs/CHANGELOG-0.2.19.md                       —     本文
```
