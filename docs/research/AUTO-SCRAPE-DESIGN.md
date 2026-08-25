# Rainbow 自动刮削（Auto-Scraping / Auto-Tagging）技术设计与选型调研

> 任务 #44 · 状态：设计定稿（未实施） · 日期：2026-08-20
> 范围：技术调研 + 数据源选型 + 方案设计。本文档不伴随任何代码改动。
> 环境：Node.js ≥20 + TypeScript + Fastify 5，ESM（`server/package.json` `"type": "module"`）。

---

## 0. 结论速览（TL;DR）

| 决策点 | 推荐结论（各一句） |
|---|---|
| **触发时机** | 下载完成后异步自动触发（订阅 `task:completed` / `task:completed_with_warnings` 事件）+ 设置页手动「一键刮削全部」双模式，刮削走独立并发 1 的小队列、fire-and-forget，任何失败完全旁路、不影响任务状态与下载管线。 |
| **匹配策略** | 以「实际命中平台的 platform+songmid」精确直查为主（换源场景以 `actual_source` 记录的平台为准），title+artist 归一化模糊匹配为辅（直接复用已移植的 `match.ts findMusic()`），音频指纹（AcoustID/fpcalc）明确不做。 |
| **降级策略** | 平台接口 8s 超时/网络失败 → `scrape_status=failed`（限次 2 次重试）；空结果/平台不符/无法定位歌曲 → `skipped`（不自动重试）；全链路 best-effort，与 tag-worker 的 part-fail 语义一致。 |
| **存储方式** | 写回文件嵌入标签：MP3 用 node-id3、FLAC 用 flac-tagger（两者均已在依赖与 tag-worker 打通，零新增依赖；采用 read-merge-write 只补缺不覆盖）；数据库新增 `scrape_status` + `scrape_info` 两列记录刮削结果（明确不放入 `warnings`）。 |

**数据源推荐组合**：内部适配器 / 平台公开接口（songmid 直查，零新依赖零鉴权）为主 → MusicBrainz Web Service 作兜底 → Last.fm / Discogs / AcoustID 全部排除（理由见 §3.2）。

---

## 1. 代码现状调研（选型依据）

### 1.1 依赖清单（`server/package.json`）

| 依赖 | 版本 | 用途现状 |
|---|---|---|
| `music-metadata` | ^7.14.0 | **声明但未使用**——全仓 `src/` 无任何 import（grep 仅命中 package.json 与 package-lock.json）。npm 最新 11.15.0（2026-08-18 发布）。可视为「预留给读取场景」的空置依赖。 |
| `node-id3` | ^0.2.9 | MP3 ID3v2 写入（`tag-worker.ts:52` `NodeID3.write`），纯 JS，依赖 iconv-lite。 |
| `flac-tagger` | ^1.0.8 | FLAC Vorbis Comment 写入（`tag-worker.ts:58-72` `writeFlacTags`），ESM-only（v1 支持 CJS）。npm 最新 2.0.0（2026-01-06），API 签名兼容（`writeFlacTags({tagMap, picture}, path)`）。 |
| `sharp` | ^0.33.5 | 封面缩放（`tag-worker.ts:33-38`）。 |
| `needle` | ^3.3.1 | 适配器 HTTP 客户端（`adapters/http.ts` 的 `httpFetch` 封装，支持 `timeout` 选项，默认 15s，`http.ts:18,27,30`）。 |

**关键事实**：MP3 与 FLAC 的标签写入通道均已存在且在生产路径上跑通，刮削功能的写入层是「扩展字段」而非「新建通道」。

### 1.2 tag-worker 现状：写了哪些字段、何时触发

**写入字段**（`server/src/core/download/tag-worker.ts`）：
- MP3（`embedMp3`，44-54 行）：`title` / `artist` / `album`；可选 `unsynchronisedLyrics`（language: chi）；可选 `image`（front cover, JPEG，sharp 缩放）。
- FLAC（`embedFlac`，57-72 行）：`TITLE` / `ARTIST` / `ALBUM`；可选 `LYRICS`；可选 `picture`。
- **未写的字段**（刮削的增量价值所在）：年份（MP3 `TYER`/FLAC `DATE`）、曲目号（`TRCK`/`TRACKNUMBER`）、流派（`TCON`/`GENRE`）、专辑艺术家（`TPE2`/`ALBUMARTIST`）、碟号（`TPOS`/`DISCNUMBER`）。

**触发时机**（`server/src/core/download/index.ts`）：
- 在 `downloader.download()` 内部、临时文件 rename 到最终路径之后调用（377-384 行）；
- 受 `config.download.embedCover` / `embedLyric` 开关控制（365-372 行）；
- 执行于 worker_threads 小池（`TagWorkerPool`，224-322 行，1-2 个 worker，60s 超时）；
- **part-fail 语义**：标签/封面失败只产出 `warnings`，绝不改变下载成功状态（9-12 行注释，`queue.ts:334` 据此判定 `completed_with_warnings`）。

### 1.3 `download_tasks.music_info` 结构

`music_info` 列存的是**入队 payload 的 JSON 序列化**（`server/src/core/download/queue.ts:173-175`）：

```
music_info = JSON.stringify({ ...EnqueueInput })
EnqueueInput = { platform, musicInfo, quality, primarySourceId?, sourceIds? }   // queue.ts:31-37
```

`MusicInfo`（`server/src/core/adapters/common.ts:71-92`）字段盘点：

| 字段 | 说明 | 对刮削的价值 |
|---|---|---|
| `name` / `singer` | 歌名 / 歌手（多歌手 `、` 连接） | 已写入标签；模糊匹配输入 |
| `songmid` | 平台歌曲 ID（kg 可能是 32 位 hash） | **精确直查的主键** |
| `albumName` / `albumId` | 专辑名 / 专辑 ID | 已写入标签；详情接口的查询键 |
| `interval` | 时长 `mm:ss` | 模糊匹配的 ±5s 一票否决依据 |
| `img` | 封面直链（wy/tx/mg 搜索即带 500x500；kw/kg 需另查） | 封面补全 |
| `lrc` | 歌词（常为 null，下载时另取） | — |
| `types` / `_types` / `typeUrl` | 音质档位信息 | — |
| 平台专有 | `hash`(kg)、`strMediaMid`/`albumMid`(tx)、`copyrightId`/`lrcUrl`(mg) 等 | 详情接口的补充查询键 |

**入队校验保证**（`server/src/routes/download.ts:38`）：`musicInfo.songmid` 与 `name` 必填 → **每个任务都拥有 platform+songmid**，精确直查的先决条件恒成立。

**注意（换源场景）**：跨平台换源后实际命中的歌曲对象是 `result.musicInfo`（`queue.ts:262-263`），与入队时不同；实际命中平台已持久化在 `actual_source` 列（格式 `sourceId@platform`，`queue.ts:339`）。刮削直查应以**实际命中平台**优先。

### 1.4 内部适配器能力盘点（决定性输入）

**已有、可直接复用的能力**：

| 能力 | 位置 | 说明 |
|---|---|---|
| 五平台搜索 | `search/index.ts:54-57` `searchService.searchPlatform(platform, keyword, page, limit)`；`Platform = 'kw'\|'kg'\|'tx'\|'wy'\|'mg'`（19 行） | songmid 之外的通用检索入口 |
| 歌词获取 | `adapters/metadata.ts:31-51` `fetchLyric(platform, musicInfo)` | **全 5 平台已实现**（kw/kg/tx/wy/mg） |
| 封面获取 | `adapters/metadata.ts:54-70` `fetchCoverUrl(platform, musicInfo)` | kw（`kw/pic.ts:7-16` artistpicserver 按 rid 查）、kg（`kg/pic.ts:14-50` get_res_privilege）专有接口；tx/wy/mg 用搜索结果 `img` 直链 |
| **跨平台模糊匹配** | `adapters/match.ts:89-171` `findMusic(query)` | **完整移植 lx-music**：`filterStr` 归一化（60-64 行）、多歌手排序去序（36-41 行）、时长 ±5s 否决（97 行）、三档匹配（116-134 行）+ 9 级精度排序（148-159 行）。**模糊匹配兜底已现成，零新代码** |
| wy eapi 加密基建 | `wy/musicSearch.ts:8-18` `eapiRequest` | 可低成本扩展 song/detail 类接口 |
| tx 签名基建 | `tx/musicSearch.ts:13-25` `signRequest`（zzcSign） | 同上；且已内置限流退避先例（98-101 行） |
| HTTP 层 | `adapters/http.ts:20-75` `httpFetch(url, {timeout})` | 支持 per-call 超时（默认 15s）——刮削 8s 超时可直接传参 |

**缺口（如实盘点）**：
- **没有任何平台有「按 songmid 查歌曲详情」的现成函数**——唯一按 songmid 直查的先例是 kw/kg 的封面专用接口。搜索结果即当前唯一详情来源。
- `MusicInfo` 里**没有**年份 / 曲目号 / 流派 / 专辑艺术家字段；即「零新代码」能刮到的只有专辑名+封面+时长（且大多在下载时已写入）。
- 结论：**「零外部依赖补全」可行但增量有限**。要拿到年份/曲目号/流派，需为各平台**新增少量详情接口适配函数**（复用现有签名/HTTP 基建，无需新依赖、无需鉴权）。分级见 §4.2。

### 1.5 下载完成 hook 点（自动触发的插入点）

事件链（全部已存在）：

```
queue.run() 完成
  → queue.ts:336-344  setStatus(id, 'completed' | 'completed_with_warnings', {...})
  → queue.ts:237-244  setStatus 内 this.emit(`task:${status}`, toTaskView(row))
  → events.ts:32-41   wireEvents() 把 task:created/active/progress/pending/completed/
                       completed_with_warnings/failed/canceled forward 到 eventBus
  → routes/sse.ts     eventBus 事件全部经 GET /api/v1/sse/subscribe 广播给前端
```

**插入点结论**：刮削模块在服务启动时（`index.ts` 装配处，参考 `events.ts:29-43` 的接线模式）直接 `downloadQueue.on('task:completed', …)` 与 `downloadQueue.on('task:completed_with_warnings', …)` 订阅即可——无需改动 queue 任何代码。刮削自身的新事件经 `emitEvent()`（`events.ts:46-48`）或同款 forward 接入同一总线。

### 1.6 数据库存储与迁移范式

- 列迁移已有成熟范式（`db/index.ts:86-91`）：`PRAGMA table_info` 检测缺列 → `ALTER TABLE … ADD COLUMN`（`requeue_count` 先例），幂等可重复执行。
- **`warnings` 列语义已被明确限定为「只存面向用户的提示，不放内部簿记」**（`db/index.ts:35` 注释），且历史上有过「内部簿记（熔断计数）写入 warnings 后被迫专项清理迁移」的教训（`db/index.ts:97-120` `stripLegacyRequeueBookkeeping`）。
- `taskStore.update(id, patch)` 支持任意列子集更新（`db/index.ts:139-146`），新增列后即用。

---

## 2. 刮削库对比（外部调研）

数据来源：npm registry API 与 npmjs.com，**采集于 2026-08-20**。

| 库 | 最新版 / 最近发布 | 周下载量 | ESM / Node ≥20 | MP3 | FLAC | 读/写 | 维护状态 | 评注 |
|---|---|---|---|---|---|---|---|---|
| **music-metadata** | 11.15.0 / 2026-08-18 | ~1,660,000 | 原生 ESM | ✓ | ✓ | **只读** | 非常活跃（312 版本/10 年） | 格式覆盖最全（mp3/flac/ogg/m4a/wav/ape/dsd/opus…）。读取现有标签、刮削后校验的首选。项目已声明 ^7.14.0（未使用），启用时建议升到 11.x |
| **node-id3** | 0.2.9 / 2025-04-03 | ~29,200 | CJS（ESM 下 default import 可用，**项目已在用**） | ✓ | ✗ | 读+写（ID3v2） | 缓慢但健康（41 版本） | MP3 写入零迁移成本。注意 `write` 是**替换式**（移除既有标签再写），重写需 read-merge-write |
| **flac-tagger** | 2.0.0 / 2026-01-06 | ~300 | ESM-only（v1 支持 CJS） | ✗ | ✓ | 读+写（Vorbis Comment + PICTURE） | 活跃 | FLAC 写入**零迁移成本**（项目现用 ^1.0.8；v2 API 签名兼容，升级可选） |
| jsmediatags | 3.9.7 / 2021-04-15 | ~8,400 | CJS | ✓ | ✗ | 只读（ID3/MP4） | **停滞 ~5 年** | 浏览器向（依赖 xhr2）；被 music-metadata 全面碾压，排除 |
| music-tag-lib | — | — | — | — | — | — | **npm 不存在（registry 404）** | 候选名实际不存在，无法评估，排除 |
| flac-metadata | 0.1.1 / 2014-07-29 | ~25 | CJS | ✗ | ✓ | 读+写（Transform 流） | **废弃 12 年** | 排除 |
| flacord | — | — | — | — | — | — | **npm 不存在（registry 404）** | 候选名实际不存在，排除 |
| ffmpeg / ffprobe（子进程） | 持续更新 | — | 需外部二进制 | ✓ | ✓ | 读+写 | 活跃 | 能力最强但引入原生二进制依赖，与本项目「纯 JS、fpk/Docker 单镜像」现状冲突（`tools/fnpack`、`fpk/` 分发），且重写标签需 `-c copy` 有容器兼容风险。排除 |

**写入层结论**：MP3 复用 node-id3、FLAC 复用 flac-tagger——两者已在依赖树与 tag-worker 生产路径中验证，**零新增依赖**即可覆盖刮削写入。读取场景（展示/校验已嵌入标签）用 music-metadata（需 7→11 升级，同为 ESM）。jsmediatags / flac-metadata / music-tag-lib / flacord / ffmpeg 全部排除。

---

## 3. 数据源对比（外部调研）

### 3.1 对比表

| 数据源 | 鉴权 | 限流 | 字段覆盖（专辑 / 年份 / 曲目号 / 流派 / 封面） | 集成成本 | 中文曲库覆盖 |
|---|---|---|---|---|---|
| **内部适配器 / 平台公开接口**（wy/tx/kg/kw/mg，本项目音源场景） | **无**（请求签名均已移植：wy eapi `wy/musicSearch.ts:8-18`、tx zzcSign `tx/musicSearch.ts:13-25`） | 宽松（公开接口无公布配额；tx 有限流但适配器已内置退避先例 `tx/musicSearch.ts:98-101`） | 专辑✓ 封面✓ 时长✓（`MusicInfo` 已有）；**年份/曲目号需新增详情接口**（如 wy eapi song/detail，含专辑发行时间）；流派基本✗ | **最低**：复用 `httpFetch`/eapi/signRequest 基建与 `MusicInfo` 数据结构 | **最优**（歌曲本身就是从这些平台搜到的） |
| **MusicBrainz Web Service** | **无鉴权**，但要求有意义的 User-Agent（应用名+版本+联系方式，官方 API 文档） | **平均 1 req/s**（官方 Rate Limiting 文档，突发不豁免） | **全✓**：release/date/track number/genre（tags）；封面经 Cover Art Archive（**无鉴权**，另需遵守其限流） | 低：REST+JSON，needle 直调即可；需自实现 1 req/s 节流 | 一般（华语流行有条目但命中率有限） |
| Last.fm API | **需 API key**（免费注册，人工步骤） | 无官方硬性公布（建议合理使用） | track.getInfo/album.getInfo：专辑✓ 标签✓ 封面✓（artwork 多尺寸）；**年份/曲目号弱** | 中：key 的配置项+生成/脱敏展示（可复用 `settings.ts:22-24` apiKeySet 范式） | 一般 | 
| Discogs | **需 personal access token** | 60 req/min（带 token）/ 25 req/min（匿名） | 全✓：year / genre / style / tracklist / images | 中：token 管理；数据库 search + releases 两段调用 | **弱**（华语流行覆盖率低） |
| AcoustID | **需 client API key + fpcalc（Chromaprint 原生 C++ 二进制）** | — | 指纹 → MusicBrainz ID 映射（本质是 MB 的前置查询） | **高**：原生二进制需随 fnOS/fpk/Docker 分发，跨平台编译负担大 | — |

### 3.2 选型结论与理由

**推荐组合：内部适配器/平台接口（主）→ MusicBrainz（兜底）；Last.fm / Discogs / AcoustID 排除。**

1. **内部平台接口为主**——这是本项目独有的结构性优势：歌曲均源自五平台搜索，platform+songmid 恒已知（`routes/download.ts:38` 入队强校验），「刮削」退化为「按主键回查详情」，命中率天然 100%（只要详情接口活着）。零新依赖、零鉴权、零 key 管理，且中文曲库覆盖最优。代价只是为各平台补少量详情适配函数（§4.2 分级）。
2. **MusicBrainz 兜底**——唯一无需任何鉴权的国际通用数据源，字段覆盖最全（年份/曲目号/流派一步到位），REST+JSON 集成成本最低。其 1 req/s 限流对「兜底」定位（低频触发）完全够用；UA 要求用一个固定字符串即可满足。**定位明确为兜底**：仅当内部直查拿不到目标字段（典型：老歌/港台专辑缺年份）且用户开启 `scrape.mbFallback` 时触发。需对中文命中率有预期管理（§5）。
3. **Last.fm 排除**——增量价值主要在标签（tags≈流派近似）与封面，而这两者内部源+MB 已覆盖；引入 API key 注册/配置/脱敏一整套管理成本，收益不成比例。
4. **Discogs 排除**——字段虽全但需 token，且对华语流行曲库覆盖弱，与本项目主力曲库（中文流行）错配。
5. **AcoustID 排除**——其唯一不可替代的价值是「完全没有任何元信息时靠指纹认歌」，而本项目 songmid 恒已知，该前提不成立；却要承担 fpcalc 原生二进制在 fnOS/fpk/Docker 的分发与维护成本。**明确不做。**

---

## 4. 方案设计

### 4.1 触发时机（推荐：双模式）

**模式 A —— 下载完成后异步自动触发（默认开启）**
- 订阅 `downloadQueue` 的 `task:completed` 与 `task:completed_with_warnings` 事件（§1.5 事件链，无需改 queue 代码）；
- fire-and-forget：处理函数只做「登记待刮削任务 + 入刮削队列」，立即返回；
- **不阻塞下载管线**：刮削使用自己的 `PQueue({ concurrency: 1 })`（独立于下载 p-queue），写标签的 CPU 工作复用既有 `TagWorkerPool`（`download/index.ts:224-322`）——worker 池天然串行化且已 unref，不与下载争抢主线程；
- **失败不影响任务状态**：刮削任何异常只写 `scrape_status=failed` + `scrape_info.error`，绝不动 `download_tasks.status` / `warnings`（part-fail 语义的延伸）。

**模式 B —— 设置页手动「一键刮削全部」**
- 扫描 `status IN ('completed','completed_with_warnings')` 且 `file_path` 非空且 `scrape_status IS NULL OR != 'success'` 的任务，批量入刮削队列；
- 提供 `?force=true` 重刮已 success 的任务。

**并发 / 重试 / 去重设计**：
- 并发：默认 1（`scrape.concurrency` 可配 1-4）。取 1 的理由：MB 兜底必须遵守 1 req/s；平台接口低压力可降低风控风险；刮削为后台任务无时延要求；
- 去重：内存 `Set<taskId>` 拦截在途重复 + DB `scrape_status='running'` 持久化（进程重启后在途任务按 failed 处理、可重试——对齐 `requeueInterrupted` 的恢复思想但更简单：刮削无需续跑，重启后状态归 failed 由用户/自动重试接管）；
- 重试：`failed` 状态限次自动重试（`scrape.retryMax` 默认 2，间隔 5s/15s 轻量退避）+ 手动重试入口（`POST /api/v1/tasks/:id/scrape`）。`skipped` 不参与自动重试（语义为「确定性不刮」，见 §4.3）；
- 开关：`scrape.enabled`（总开关）+ `scrape.autoOnComplete`（仅控制模式 A）。两者分离，允许「只手动刮」。

### 4.2 匹配策略（推荐：三级，指纹明确不做）

**第 1 级（主）：platform + songmid 精确直查**
- 平台取值优先级：`actual_source` 解析出的实际命中平台（`queue.ts:339`，换源场景）→ 入队 `platform`；songmid 取 `music_info.musicInfo.songmid`；
- 实现分级（如实评估，见 §1.4 缺口）：
  - **L0（零新代码）**：`MusicInfo` 已有字段（albumName/img/interval）+ `fetchLyric`/`fetchCoverUrl` 现成接口——补全下载时缺失的专辑名/封面/歌词；
  - **L1（少量新适配函数，本设计的主张）**：各平台按 songmid 查详情。wy：复用 `eapiRequest` 新增 song/detail 调用（响应含专辑信息与发行时间，具体字段映射实现时验证，见 §5）；tx：复用 `signRequest`；kg：扩展 `get_res_privilege` 的响应解析（该接口已按 hash/album_audio_id 查询，`kg/pic.ts:14-50`）；kw/mg：各补一个按 rid 的信息接口。全部复用 `httpFetch`（8s 超时直接传 `timeout: 8000`，`http.ts:27`）；
  - **L2（可选兜底）**：MusicBrainz 查询（`inc=releases+media`），仅 `scrape.mbFallback=true` 且 L1 字段仍缺失时触发；
- 目标字段：年份、曲目号、流派、专辑艺术家、碟号（L1 各平台能提供的子集「有则写，无则跳过」；流派普遍缺，由 L2 MB 补）。

**第 2 级（次）：title + artist 归一化模糊匹配**
- **直接复用 `match.ts findMusic()`**（`match.ts:89-171`）：输入 `{name, singer, albumName?, interval?, source}`，已实现 filterStr 归一化、多歌手排序、时长 ±5s 否决、三档匹配与 9 级精度排序；
- 适用场景：换源下载后 musicInfo 最小化（原平台字段缺失）、直查详情接口对该平台未实现或失败；
- 匹配成功后对候选首位（或人工/自动置信度最高者）再走第 1 级直查补全字段；匹配失败 → `skipped`。

**第 3 级：不做音频指纹**
- AcoustID 排除理由见 §3.2；设计上不留接口，避免半吊子预留。

### 4.3 降级策略

`scrape_status` 状态机：

```
NULL(未刮削) ──触发──> running ──成功──> success
                          │
                          ├─平台接口失败/8s 超时/风控 403 ──> failed（attempts+1，≤retryMax 自动重试，超限停在 failed）
                          ├─查无结果/匹配失败            ──> skipped（确定性，不自动重试，可手动 force）
                          └─平台不符/音源场景不适用       ──> skipped
```

- **超时**：平台接口调用统一 `httpFetch(url, { timeout: 8000 })`（`http.ts:27` 现成支持；MB 兜底同参）；
- **音源禁用 ≠ 刮削失败**：刮削走平台官方接口、不走 lx 音源脚本（对齐 `metadata.ts:4-5` 的既有架构约定「歌词与封面不走音源」），因此音源引擎状态与刮削解耦；只有平台接口本身被风控/失效时才 failed；
- **平台不符**：`actual_source` 无法解析、`music_info` JSON 损坏、或换源后既无原平台 songmid 也无实际平台 songmid → skipped；
- **文件缺失**：`file_path` 为空或文件已被用户删除（fs.access 校验）→ skipped（error 信息说明原因）；
- **写标签失败**：与 tag-worker 一致降级为刮削记录里的 warning（`scrape_info.warnings`），状态仍可 success-with-warnings（沿用 part-fail 语义，不引入新状态值，避免前端状态爆炸）。

### 4.4 存储方式

**（a）写回文件嵌入标签**
- MP3（node-id3，`tag-worker.ts:44-54` 扩展）：新增 `year(TYER)`、`trackNumber(TRCK)`、`genre(TCON)`、`albumArtist(TPE2)`、`contentNum(TPOS)`；
- FLAC（flac-tagger，`tag-worker.ts:57-72` 扩展）：新增 `DATE`、`TRACKNUMBER`、`GENRE`、`ALBUMARTIST`、`DISCNUMBER`；
- **范围建议（如实）**：MP3 与 FLAC **一并支持**。理由：两者写入通道均已存在，扩展只是 `TagJobMessage.meta` 增加可选字段（`tag-worker.ts:20`），边际成本近零；不存在「先仅 MP3」的技术必要性。其他格式维持现状「未知格式跳过」（`download/index.ts:389-391` 同款语义）；
- **只补缺不覆盖（默认）**：node-id3 `write` 是替换式，刮削重写必须 **read-merge-write**——先 `NodeID3.read`（或 `readFlacTags`）读现有标签，仅对空缺字段填入刮削值（含封面 buffer 的往返格式适配，实现时验证，见 §5），再整体写回；`scrape.overwrite=true` 或手动 force 时才允许覆盖非空字段。此策略保证刮削幂等且不破坏下载时已嵌入的歌词/封面。

**（b）数据库记录刮削结果**
- **推荐：新增两列**，迁移复用 `db/index.ts:86-91` 范式（幂等 `ALTER TABLE`）：

```sql
ALTER TABLE download_tasks ADD COLUMN scrape_status TEXT;  -- running/success/failed/skipped；NULL=从未刮削
ALTER TABLE download_tasks ADD COLUMN scrape_info TEXT;    -- JSON：{attempts, error, warnings[], matched:{platform,songmid}, fieldsWritten[]}
```

- **为什么不复用 `warnings`**：该列语义被明确限定为「面向用户的提示」（`db/index.ts:35`），历史上内部簿记混入 warnings 后专门做过清理迁移（`db/index.ts:97-120`）——前车之鉴，刮削状态属于内部簿记；
- **为什么不全塞进 `music_info` JSON**：music_info 是「入队 payload 的不可变快照」（§1.3），混入刮削结果会破坏其语义且无法建索引/条件查询（「一键刮削全部」需要 `WHERE scrape_status IS NULL OR scrape_status != 'success'`）；
- `scrape_status` 独立列 + `scrape_info` JSON 的组合兼顾「可查询」与「可扩展」，且对现有 `toTaskView`（`queue.ts:61-81`）的扩展只是加两个字段。

### 4.5 模块设计

**核心模块：`server/src/core/scrape.ts`**

```
职责边界（单文件模块，预估 ~300 行）：
  1. 事件接线   wire(downloadQueue)     —— 订阅 task:completed*，模式 A 入口
  2. 队列调度   PQueue(concurrency=1)   —— 去重（内存 Set + DB running 状态）
  3. 元数据解析 resolveMetadata(task)   —— §4.2 匹配策略（L0 现有字段 / L1 平台直查 / L2 MB / 第2级 findMusic）
  4. 标签写回   writeTags(task, meta)   —— 复用 TagWorkerPool（导出 getTagPool 或抽公共 embedTags）
                                          read-merge-write，失败降级 warnings
  5. 状态持久化 taskStore.update(id, {scrape_status, scrape_info})
  6. 事件广播   emitEvent('scrape:*')   —— 经 events.ts:46-48 emitEvent 上总线

依赖注入（构造函数注入，便于单测 mock——当前仓库无测试基建，按可测结构预留）：
  new ScrapeService({ config, taskStore, scrapeSources, tagWriter, emitter, logger })
  - scrapeSources: { resolve(platform, songmid, musicInfo): Promise<ScrapedMeta|null> }   // 平台详情接口集合
  - tagWriter:     { embed(filePath, meta): Promise<{warnings}> }                          // 复用 tag 池
```

**与 queue/任务的集成点**：
- 只读集成：`downloadQueue.on('task:completed'|'task:completed_with_warnings', …)`；从任务行读 `music_info`/`actual_source`/`file_path`；
- 唯一写点：`taskStore.update(id, { scrape_status, scrape_info })`（新列，不触碰既有列）；
- 启动接线：`index.ts` 的装配段调用 `scrapeService.wire(downloadQueue)`（与 `wireEvents()` 相邻），停机随进程退出（PQueue 无持久任务，无需 shutdown 编排）。

**SSE 事件**（命名对齐现有 `task:*` / `source:*` 风格，经 `events.ts` 转发后自动出现在 `/api/v1/sse/subscribe` 流中，前端 `web/js/sse.js` 现成订阅机制）：

| 事件 | payload | 说明 |
|---|---|---|
| `scrape:started` | `{taskId}` | 单任务开始 |
| `scrape:progress` | `{done, total, taskId?}` | 批量模式进度（模式 B 主用） |
| `scrape:completed` | `{taskId, status, fieldsWritten[], warnings[]}` | 单任务结束（含 success/skipped） |
| `scrape:failed` | `{taskId, error, attempts}` | 单任务失败 |

**API 契约**（对齐 `routes/download.ts` 既有风格：`/api/v1/` 前缀、`:id` 路径参数、错误返回 `{error}` + 恰当 HTTP 码；建议新建 `routes/scrape.ts` 并在 index.ts 注册）：

```
POST /api/v1/tasks/:id/scrape        单任务刮削/重刮（?force=true 覆盖已 success）
   → 202 {id, scrapeStatus:'pending'}   （任务不存在 404；无文件/不可刮 409 {error}）
POST /api/v1/scrape/all              一键刮削全部（?force=true）
   → 202 {queued: <n>, skipped: <n>}
GET  /api/v1/scrape/status            运行态概览
   → 200 {running: bool, activeTaskId?: string,
          stats: {pending: n, running: n, success: n, failed: n, skipped: n}}
GET  /api/v1/tasks/:id                既有接口扩展：响应增加 scrapeStatus / scrapeInfo 字段
                                      （toTaskView 扩展，queue.ts:61-81）
```

**config 新增项**（对齐 #6 可选字段模式：`config.ts:26-35` 的「全部可选、缺省用代码默认值」惯例；`RoConfig` 接口与 `buildDefaultConfig`（`config.ts:101-109`）同步扩展；设置页经既有 PATCH `/api/v1/settings` + `safeView`（`settings.ts:19-53, 81-104`）读写）：

```yaml
scrape:
  enabled: true        # 总开关（false 时零行为变化）
  autoOnComplete: true # 下载完成后自动刮削（模式 A）
  concurrency: 1       # 刮削并发（1-4）
  timeoutMs: 8000      # 平台接口超时
  retryMax: 2          # failed 自动重试上限
  mbFallback: true     # MusicBrainz 兜底
  overwrite: false     # 覆盖已有标签字段（默认只补缺）
```

**默认值理由**：`enabled: true` 与既有 `embedCover: true` / `embedLyric: true`（`config.ts:106-107`）的「默认 enrich 文件」哲学一致，且刮削失败无副作用、默认只补缺不覆盖，风险可控；不愿自动改文件的用户可关 `autoOnComplete` 或总开关。

**前端交互**（`web/js/pages/settings.js` 现成范式）：
- 设置页新增「自动刮削」区块：`enabled`/`autoOnComplete` checkbox（对齐 `set-embed-cover` 行，`settings.js:56-57`）+ 其余数值项，保存走 `saveSettings` 的 PATCH 聚合（`settings.js:128-137`）；
- 「一键刮削全部」按钮 + 进度条：按钮对齐 `set-test-notify` 模式（`settings.ts:122-127`）；点击后 `POST /api/v1/scrape/all`，订阅 `scrape:progress` SSE 更新进度，完成后展示 `{success, failed, skipped}` 汇总与「重试失败项」链接；
- 库页（`web/js/pages/library.js`）任务行增加刮削状态小徽标（复用 `library.js:40-45` 的 SSE 订阅机制，监听 `scrape:completed`/`scrape:failed` 局部刷新）；
- `web/js/api.js` 新增三个方法（对齐现有 fetch 封装风格）。

**验收清单**：
1. `scrape.enabled=false` 时：下载行为、任务状态、SSE 事件流与现状逐字节一致（零回归基线）；
2. 下载完成的 MP3（有数据时）含 TYER/TRCK/TCON/TPE2；FLAC 含 DATE/TRACKNUMBER/GENRE/ALBUMARTIST；`music-metadata` 抽样解析校验；
3. 下载时已嵌入的歌词/封面在刮削后不被破坏（read-merge-write 幂等性：连续刮两次结果一致）；
4. 平台接口 8s 超时 → `scrape_status=failed` + `scrape_info.error` 有值，任务 `status`/`warnings` 不变；自动重试 ≤2 次；
5. 空结果/平台不符 → `skipped`，不自动重试，手动 force 可重刮；
6. 「一键刮削全部」：只选中 `completed*` 且未 success 的任务，SSE 推 `scrape:progress`，前端进度条可见，结束后 stats 汇总正确；
7. 旧库（无新列）启动自动补列，重启幂等；进程重启后在途 `running` 归 `failed` 可重试；
8. MB 兜底触发时请求间隔 ≥1s（限流合规），UA 带应用标识；
9. 换源任务用 `actual_source` 平台直查且结果正确；
10. `API.md` 与 `docs/USER-GUIDE.md` 同步更新（新增 scrape API 与设置项说明）。

---

## 5. 风险与开放问题

| # | 风险 / 开放问题 | 影响 | 处置 |
|---|---|---|---|
| 1 | **平台详情接口字段映射未逐一验证**：wy eapi song/detail 响应中发行时间/碟号的准确字段名、tx songDetailV2 的返回结构，需实现时抓包核对（本文按接口能力做了如实的分级设计，未断言具体字段名） | L1 直查的字段覆盖率可能低于预期 | 实现首日先做 5 平台×3 首样本的接口探测脚本，按实际字段冻结映射表；不足字段自然落到 L2 MB 兜底 |
| 2 | **read-merge-write 的 buffer 往返**：node-id3 `read` 返回的 image 结构（buffer 数组）与 `write` 期望的 `imageBuffer` 格式差异，需适配转换；FLAC picture 同理 | 重写可能丢封面（违反幂等目标） | 验收项 3 专项覆盖；必要时刮削写入前先备份比对 |
| 3 | 内部平台接口无 SLA（风控/失效随时可能变化） | 直查命中率下降 | 降级链已内建（failed→重试→MB 兜底→skipped）；接口失败完全旁路不影响下载 |
| 4 | MusicBrainz 中文曲库覆盖有限 | 兜底命中率可能不高（预期管理） | mbFallback 可关；文档如实标注 |
| 5 | 批量刮削对平台接口的压力（一键刮削 500 任务场景） | 触发风控 | 并发固定 1 + 任务间 ≥300ms 间隔（可调）；分批入队（对齐 batchActivationSize 思想） |
| 6 | 刮削与下载同时写同一文件（理论上：任务刚 completed 即刮削，此时下载已结束，无并发写；但用户手动重刮进行中又手动 retry 下载） | 文件写冲突 | retry 入队时若该任务 `scrape_status='running'` 则跳过刮削登记（顺序约束，实现细节） |
| 7 | `music-metadata` 7→11 升级（若启用读取） | breaking changes（v8+ 改 ESM-only、API 微调） | 当前项目本就 ESM，风险低；仅在需要读取能力时升级，不作为本功能前置 |

---

## 附录 A：现状代码证据索引

| 主题 | 证据位置 |
|---|---|
| 依赖清单 | `server/package.json:23-31`（flac-tagger/music-metadata/node-id3/sharp/needle） |
| MP3 标签写入 | `server/src/core/download/tag-worker.ts:44-54`（embedMp3，NodeID3.write:52） |
| FLAC 标签写入 | `server/src/core/download/tag-worker.ts:57-72`（embedFlac，writeFlacTags） |
| part-fail 语义 | `tag-worker.ts:9`、`download/index.ts:327-331`、`queue.ts:334` |
| 标签嵌入触发点 | `download/index.ts:365-397`（embedCover/embedLyric 开关 + worker 池调用） |
| tag worker 池 | `download/index.ts:189-322`（TagWorkerPool，60s 超时:197） |
| music_info 写入 | `server/src/core/download/queue.ts:173-175`（JSON.stringify({...input})） |
| EnqueueInput | `queue.ts:31-37` |
| MusicInfo 结构 | `server/src/core/adapters/common.ts:71-92` |
| 入队 songmid 强校验 | `server/src/routes/download.ts:38` |
| 换源实际平台 | `queue.ts:262-263`（effPlatform）、`queue.ts:339`（actual_source='sourceId@platform'） |
| fetchLyric/fetchCoverUrl | `server/src/core/adapters/metadata.ts:31-51, 54-70` |
| 跨平台模糊匹配 | `server/src/core/adapters/match.ts:89-171`（findMusic；filterStr:60-64；三档:116-134；9级排序:148-159） |
| 五平台搜索服务 | `server/src/core/search/index.ts:19, 34, 54-57` |
| wy eapi 基建 | `server/src/core/adapters/wy/musicSearch.ts:8-18` |
| tx 签名/限流退避 | `server/src/core/adapters/tx/musicSearch.ts:13-25, 98-101` |
| kg 封面直查接口 | `server/src/core/adapters/kg/pic.ts:14-50`（get_res_privilege） |
| kw 封面直查接口 | `server/src/core/adapters/kw/pic.ts:7-16`（artistpicserver） |
| HTTP 超时支持 | `server/src/core/adapters/http.ts:18, 27, 30`（timeout 选项，默认 15s） |
| 任务完成事件链 | `queue.ts:237-244, 336-344` → `events.ts:29-43` → `routes/sse.ts` |
| 事件总线 emitEvent | `server/src/core/events.ts:46-48` |
| DB 列迁移范式 | `server/src/core/db/index.ts:86-91`（requeue_count 先例） |
| warnings 语义边界 | `db/index.ts:35`（注释）、`db/index.ts:97-120`（历史清理迁移） |
| taskStore.update | `db/index.ts:139-146` |
| config 可选字段范式 | `server/src/core/config.ts:26-36`（#6 新增项）、`config.ts:101-109`（默认值）、`config.ts:206-213`（patchConfig） |
| settings API 范式 | `server/src/routes/settings.ts:19-53, 81-104, 122-127` |
| API 路由风格 | `server/src/routes/download.ts:35-93` |
| 前端设置页范式 | `web/js/pages/settings.js:54-57, 128-137` |
| 前端 SSE 订阅 | `web/js/pages/library.js:40-45` |

> 外部数据（npm 版本/下载量、MusicBrainz/Last.fm/Discogs/AcoustID 政策）采集于 2026-08-20，来源：npm registry API、musicbrainz.org/doc/MusicBrainz_API（Rate Limiting 页）、last.fm API Docs、discogs.com/developers、acoustid.org/webservice。

---

## 附录 B：五平台详情接口探测冻结表（2026-08-20 实测，#45 实施）

> 探测方式：`server/scripts/probe-scrape.mjs`（tsx 运行，直接复用 `src/core` 既有签名/HTTP 基建），每平台抽真实 songmid 试调候选详情接口，验证字段覆盖后冻结映射。字段映射实现见 `server/src/core/adapters/scrape-detail.ts`。

| 平台 | 接口（已冻结） | year | trackNumber | disc | genre | album | singer | 结论 |
|---|---|---|---|---|---|---|---|---|
| wy 网易云 | `POST interface3.music.163.com/eapi/song/detail`（eapi `/api/v3/song/detail`，body `c=[{id}]`） | ✅ `publishTime`(ms→YYYY) | ✅ `no` | ✅ `cd`("01"→1) | ❌ 不提供 | ✅ `al.name` | ✅ `ar[].name` | L1 可用 |
| tx QQ 音乐 | `POST u.y.qq.com/cgi-bin/musics.fcg`（`music.pf_song_detail_svr/get_song_detail`，zzcSign，comm `{ct:24,cv:0}`；样本 songmid `0039MnYb0qxYhV`） | ✅ `album.time_public` | ✅ `index_album` | ✅ `index_cd`(>0) | ✅ `genre` 数字枚举→有限映射表（未知的宁缺勿错） | ✅ `album.name` | ✅ `singer[].name` | L1 可用；探测时连续搜索会触发限流（req.code 2001），详情接口本身不受影响 |
| kg 酷狗 | `songsearch.kugou.com/song_search_v2` 反查（keyword=`name+singer`，按 `Audioid` 精确匹配，含 `Grp` 子项展开） | ✅ `PublishDate` | ❌ | ❌ | ❌ | ✅ `AlbumName` | ✅ `SingerName` | L1 变体（无按 id 直查详情接口）；Audioid 精确匹配天然防串号 |
| kw 酷我 | 候选 `musicpay.kuwo.cn` / `nmobi.kuwo.cn` / `kuwo.cn/api/www/music/musicInfo` 三接口均不可用（404 / illegal request） | ❌ | ❌ | ❌ | ❌ | 仅 MusicInfo 已有 `albumName` | 仅已有 | **降级 L0**：`scrape_info.source='kw:l0-degraded'` + `degraded=true` |
| mg migu | `c.musicapp.migu.cn/MIGUM2.0/v1.0/content/resourceinfo.do?copyrightId=<id>&resourceType=2`（UA `Android_migu`） | ❌ 响应无发行时间 | ✅ `trackNumber` | ✅ `disc`("Disc 1"→1) | ✅ `tagList[0].tagName` | ✅ `album` | ✅ `singer` | L1 可用（除 year） |

**albumArtist（TPE2/ALBUMARTIST）**：五平台详情接口均不提供该字段，本次不写（宁缺勿错）；L2 MusicBrainz 兜底列入后续优化（§3）。

**标签库 API 验证结论**（同日实测）：
- `node-id3@0.2.9`：`NodeID3.update(tags, filepath)` 为**帧级合并**（只替换给出的 frame，保留 APIC/USLT），天然 read-merge-write；别名 `year(TYER)/trackNumber(TRCK)/genre(TCON)/performerInfo(TPE2)/partOfSet(TPOS)/album(TALB)`。
- `flac-tagger@1.0.8`：`readFlacTags(path)` → `{tagMap, picture}`；`writeFlacTags({tagMap, picture}, path)` **全量重写** Vorbis Comment，必须把读出的 `picture`（含 buffer）原样传回避免丢封面；Vorbis 字段 `DATE/TRACKNUMBER/GENRE/ALBUMARTIST/DISCNUMBER`。
