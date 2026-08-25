# 音源生态实测记录（SOURCES）

> 数据目录：`data/sources/*.js`（gitignore，用户自托管数据，不入 git）。
> 音源体系：lx-music 生态自定义音源脚本（vm + worker 沙箱），由 `source-engine` 加载、`orchestrator` 跨音源横向编排（同音质遍历 → 整体降级 → 跨平台换源兜底）。
> **脚本 ready ≠ 链路可用**：脚本可正常初始化（声明平台/音质），但其上游接口可能已失效；可用性以本页实测矩阵为准。

## 实测方法论

每轮评测对每个候选音源执行三层验证（复用服务内置能力，不引入额外依赖）：

1. **导入与初始化**：`POST /api/v1/sources/import/content`（或 `import/url`）→ 校验 `status=ready`、声明的平台/音质矩阵；初始化失败（如后端域名不可达）直接淘汰；
2. **冒烟矩阵**：`POST /api/v1/health/smoke/run` → 每音源 × 每平台真实链路 `search → musicUrl(128k) → HEAD 探测（2xx + content-length）`，结果落 `smoke_results`，`GET /api/v1/health/smoke` 输出矩阵（绿/黄/红）；
3. **端到端下载**：对判定可用的音源×平台提交锁定单源的真实下载任务（`POST /api/v1/download`，`sourceIds` 锁定、128k 快速档）→ `completed` 即证明上游 URL HTTP 200 + 音频 content-type + 完整文件落盘；本地播放链路另以 `GET /api/v1/play/:taskId` 验证（200 全量 / 206 Range，`audio/mpeg`）。

## 实测矩阵（2026-08-20）

平台符号：✅ 搜索+取 URL+探测全过｜◐ 部分可用（见备注）｜❌ 失效｜— 脚本未声明该平台。
冒烟关键词：周杰伦（config `smokeTest.keyword`）；端到端下载关键词：晴天。

| # | 音源（脚本 id） | 版本 | 来源 | kw | kg | tx | wy | mg | 决策 |
|---|---|---|---|---|---|---|---|---|---|
| 1 | qdy（全豆要·聚合音源） | 9.3 | 历史入库 | ◐ | ◐ | ❌ | ✅ | ❌ | **保留启用** |
| 2 | huibq（Huibq_lxmusic源） | v1.2.0 | 历史入库 | ❌ | ❌ | ❌ | ❌ | ❌ | 保留文件，**已禁用** |
| 3 | sixyin（六音音源） | v1.2.1 | 历史入库 | ❌ | ❌ | ❌ | ❌ | ❌ | 保留文件，**已禁用** |
| 4 | pdone-flower（野花🌷） | 1 | [pdone/lx-music-source](https://github.com/pdone/lx-music-source) `flower/latest.js` | ◐ | ❌ | ✅ | ✅ | ✅ | **入库启用** |
| 5 | pdone-grass（野草🌾） | 1 | 同上 `grass/latest.js` | ✅ | — | — | — | — | **入库启用**（仅 kw） |
| 6 | yoyodada-flower（野花） | 1.0.0 | [yoyodadada/lx-music-source](https://github.com/yoyodadada/lx-music-source) `flower/Flower.js` | ◐ | ❌ | ❌ | ✅ | ✅ | **入库启用** |
| 7 | yoyodada-lx（独家音源） | 5 | 同上 `lx/lx.js` | ◐ | ✅ | ❌ | ❌ | ❌ | **入库启用**（kg 主力） |
| 8 | pdone-ikun（ikun音源） | v22 | pdone 仓库 `ikun/latest.js`（api.ikunshare.com） | — | — | — | — | — | **淘汰**：worker crash，DNS ENOTFOUND |
| 9 | pdone-lx（独家音源） | 4 | pdone 仓库 `lx/latest.js` | — | — | — | — | — | **淘汰**：全平台 `param error` |
| 10 | pdone-juhe（聚合API接口 CF） | 3 | pdone 仓库 `juhe/latest.js`（api.music.lerd.dpdns.org） | — | — | — | — | — | **淘汰**：初始化失败（CF 后端不可达） |
| 11 | yecao202412（野草旧版） | — | `tt.tenmeng.com` 直链（issue #2550） | — | — | — | — | — | **淘汰**：下载直链已死，未入库 |

### 逐项备注

1. **qdy**：wy 端到端 completed；kg 冒烟全过但端到端 GET 下载挂起（HEAD 可过、流不动，上游节点疑似假 URL/限流）；kw/tx/mg 的 URL HEAD 探测分别 410/502/404。
2. **huibq / sixyin**：脚本正常加载（ready），但全平台 `musicUrl` 失败（`unknow error` / `failed`），上游接口已死 → 管理页禁用（保留文件便于后续更新恢复）。
3. **pdone-flower**：tx/wy/mg 端到端 completed（tx 实测 4.4MB 真实 128k mp3 + 标签刮削成功）；kg `musicUrl: Fail`；kw 仅 lyric 黄（无歌词，非致命）。
4. **pdone-grass**：仅声明 kw 平台，musicUrl + HEAD + 端到端下载全过，kw 主力源。
5. **yoyodada-flower**：与 pdone-flower 同源不同版本（v1.0.0 vs v1），wy/mg 端到端 completed，与 pdone-flower 互为冗余。
6. **yoyodada-lx**：kg 端到端 completed（本环境 kg 唯一可用源）；tx 搜索失败、wy `unknow error`、mg action 超时。
7. **pdone-ikun**：脚本 inited 后立即请求 `api.ikunshare.com` 触发 `getaddrinfo ENOTFOUND`，worker crash → status=error。本网络环境下域名不可解析。
8. pdone 仓库的 `huibq/qdy/sixyin` latest 与本地已入库版本 md5 完全一致（同一来源镜像），未重复实测，直接引用基线结果。

### 入库后音源生态（多音源聚合）

| 平台 | 可用音源（按编排器顺序） |
|---|---|
| kw | pdone-grass、qdy（部分） |
| kg | yoyodada-lx、qdy（部分） |
| tx | pdone-flower |
| wy | pdone-flower、yoyodada-flower、qdy |
| mg | pdone-flower、yoyodada-flower |

五平台首次全部具备至少一个端到端验证过的可用音源（此前仅 wy/kg 经 qdy 可用）。

## 前端失效标注（本页配套实现）

- **搜索页**（`web/js/pages/search.js`）：聚合搜索响应 `results[].ok=false` 的平台（该聚合源本次请求完全失败）→ 结果区顶部显示毛玻璃暗红警示条 `.src-warn-banner`（含平台名与错误摘要，`role=alert`）；仅个别平台失败时常规警示（不影响其余结果浏览），全平台失败时升级 `severe` 态（加深红 + 图标呼吸）。判定信号来自现有聚合响应结构（`ok`/`error` 字段），无后端改动。
- **音源管理页**（`web/js/pages/sources.js`）：状态徽标中文化（运行中/不可用/加载中）；`status=error` 或 `enabled=false` 的卡片加 `.src-card--dead` 态（降透明度 + 左侧暗红竖条），启停开关保留。

## 已知限制与运维提示

- ~~`enabled` 为内存态~~（#56 已修复）：启停状态现持久化到 SQLite meta 表（key `sourceEnabled`），`loadAll()` 热重载与服务重启后自动恢复；验证方式：toggle → 触发目录变动/重启 → 状态保持。删除音源时同步清理记录。
- **一键快速冒烟**（#56）：音源管理页「一键冒烟测试」按钮 → `POST /api/v1/sources/smoke` 同步返回矩阵（音源串行、平台并行≤3、整体 60s 预算，契约见 API.md）；与全量冒烟（health/smoke/run，落库+告警）互斥。矩阵每格「搜索/取链」双态，全部可测平台均未通过的音源会标「建议禁用」（与 dead 态判定同源）。
- 音源上游可用性随时间漂移（本轮 qdy kw/tx/mg 的 HEAD 410/502/404 与历史记录已有差异），建议保持 `smokeTest` 定时任务（默认每日 06:00）并关注告警。
- 第三方脚本为用户自托管数据：更新方式为音源管理页「URL 导入/重载」，或替换 `data/sources/*.js` 后自动热重载。
