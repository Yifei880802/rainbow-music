# Rainbow × Spotify 布局与功能架构重规划（SPOTIFY-REDESIGN-PLAN）

> 任务 #49 · 研究规划文档（零代码改动、不执行 git、不触碰 23330 服务）。
> 主对标：`awesome-design-md/skills/design-md/references/spotify/DESIGN.md`（下称 **SPD**，引用格式 §n）。
> 工作流遵循 design-md SKILL.md 四步：选品牌（Spotify，同域唯一「同题型」参考，AUDIT §1 已论证）→ 提取具体规格值 → 映射 Hume token 层 → 输出可执行改造清单。
> 层级边界：**本文 = 布局 / 功能 / 交互层重规划**；视觉 token 精修已由 #48 `DESIGN-MD-AUDIT.md`（19 项映射、9 项实施全部落地并验证）完成，本文引用其裁决、不推倒（附录 A 对照表）。
> 契约约束：全部建议遵循 `MUSIC-PLAYER-UI-GUIDE.md` §5.0 红线与附录 A（66 静态 id + JS 渲染 class 清单），只增不改名不删除。

## 0. 现状基线（实测值，规划的事实基础）

### 0.1 布局现状（web/index.html + web/style.css 实测）

| 区域 | 实测值 | 代码出处 |
|---|---|---|
| 侧栏 | 固定左 232px（`--sidebar-w`）；≥1280px 可折叠 64px（`body.sidebar-compact`，localStorage `rainbow.sidebar-compact` 记忆）；≤900px 转 translateX 抽屉 + 遮罩 | style.css :root / .sidebar / L1531 |
| 顶栏 | `header.topbar`：仅 nav-toggle 抽屉钮 + 品牌文案；无搜索、无视图标题、非 sticky | index.html L71-76 |
| 主区 | `.main-wrap` 让位侧栏，内部 main 滚动；六个 `.view` 单显（main.js showTab 切换） | main.js L32-46 |
| Now Playing 面板 | `#np-panel` 320px fixed 右缘 z-85，覆盖式滑入；`body.np-open` 时 main padding-right 336px；<1280px 整体 `display:none`（入口 #pb-expand 同隐）；**开合不记忆**（刷新即合） | style.css L1205/L1358；player.js npOpen |
| 播放栏 | `#player-bar` fixed 底 z-90 三段式；`body.player-open` main padding-bottom 112px；≤900px 换行布局 | style.css L918/L933/L1046 |
| 断点 | 3 档：≤900（抽屉）、<1280（np 隐藏）、≥1280（折叠钮出现） | style.css @media |

### 0.2 功能现状（player.js 826 行 / pages/*.js 通读结论）

**已有**：shuffle（Fisher-Yates 保留洗牌基线）/repeat 三态（off/all/one）、滚动歌词（lrc 解析 + 当前句高亮 + 纯文本降级 + 竞态拦截）、20 柱频谱（AnalyserNode，reduced-motion 降级三柱）、封面取色氛围 `--ambient`（16×16 canvas 采样）、最近播放 localStorage 20 条（侧栏入口 + 404 自清理）、行内刮削钮、下载进度环、播放全部 / 批量下载 / 批量加歌单、歌单 CRUD + 整单下载、Range 拖动进度、音量条键盘 ±5%。
**缺失**（下文规划对象）：播放队列持久化（刷新即丢）、MediaSession、FLAC 兼容提示、右键菜单、全局键盘快捷键（空格/切歌/seek）、搜索历史、视图切换（网格/列表）、队列编辑（移除/插队/清空）、np 开合记忆、音量记忆（初始 0.8 硬编码，player.js L679）。

### 0.3 后端能力边界（API.md 全文 + server/src/routes 目录 + api.js 交叉核对）

**可用**：search 五端点（song/songlist/aggregate/songlist-aggregate/detail）、download 单/批（≤200）、tasks CRUD + 单曲刮削、`GET /play/:taskId`（完整 Range 流式）、`GET /cover/:taskId`（嵌入 ID3 → 302 直链 → 404 三级）、`GET /lyric/:taskId`（LRU 100 缓存）、playlists 全套（list/create/get/rename/remove/addItem/removeItem/download）、sources、settings、SSE 十二类事件、status。
**注意**：`server/src/routes/playlists.ts` 实际存在但 **API.md 未收录该章**——本规划以实际路由为准（api.js 已封装），建议后续单独补文档（不在本文范围）。
**不存在**（规划不得依赖，涉及项在 §5 明确标注「需新后端」）：播放进度/队列状态端点、艺人/专辑聚合端点（GET /tasks 响应无可分组标签字段）、榜单/推荐内容端点、歌单 items 顺序字段（playlists.ts 无 position/order，拖拽排序需后端增量）。

## 1. 布局重构方案（对标 Spotify Web 范式）

SPD §5 Layout 原文范式：`Sidebar (fixed) + main content area`、`Grid-based album/playlist cards`、`Full-width now-playing bar at bottom`；§8 给出断点与塌缩策略。Rainbow 骨架与之同构（AUDIT 选型结论「保持 232px 侧栏 + 底部播放条，验证正确」），重构聚焦四个增量：**顶栏升级、视图切换器、np 面板跨断点策略、断点补强**，而非推倒重来。

### 1.1 目标线框（≥1280px 完整态）

```
+----------+----------------------------------------+-------------+
| sidebar  | topbar (sticky, 56px)                  |             |
| 232px    |  [>] 发现           [Q 全局搜索 pill 280px] |  np-panel |
| (可折叠   +----------------------------------------+  320px      |
|  64px)   | view-head                              | (可选滑入)  |
| -------- |  标题·副题            [网格|列表] 切换器  | +---------+ |
| > 发现    | toolbar（刷新/播放全部/摘要）            | | 封面 240 | |
| > 本地收藏| -------------------------------------- | | 歌名/歌手| |
| > 歌单    | 主内容区（滚动）                        | | 频谱20柱 | |
| > 设置    |  · 列表态: song-row 56px x N            | | [歌词|队列]| |
| -------- |  · 网格态: 封面卡 minmax(168px,1fr)     | | 滚动歌词  | |
| 歌单组    |                                        | | 队列列表  | |
| (前5个)   |                                        | +---------+ |
| -------- |                                        |             |
| 最近播放  |                                        |             |
| (<=20条)  |                                        |             |
| -------- |                                        |             |
| 音源/健康 |                                        |             |
+----------+----------------------------------------+-------------+
| player-bar（fixed 底）: 曲目信息 | shuffle <[ ]> repeat + 进度条 | 音量+面板 |
+---------------------------------------------------------------------+
```

各区规格与 Spotify 依据：

| 区 | 目标规格 | SPD 依据 | 相对现状差量 |
|---|---|---|---|
| 侧栏 | 保持 232/64 双态 + 折叠记忆（已完成，零改动）；新增「歌单」组置于最近播放上方（调 api.playlists.list 取前 5，渲染语系复用 .sb-recent-item） | §4 Navigation（侧栏含歌单列表） | 新增一组（D5） |
| 顶栏 | sticky 升级：左 nav-toggle + 当前视图标题（showTab 联动）；右全局搜索 pill：宽 280px、高 36px、暗玻璃胶囊 + inset 内凹（S2 基元复用）+ focus 橙环；点击跳发现视图并聚焦 #keyword；`/` 键聚焦 | §4 Inputs（search pill 500px/半径、#1f1f1f 底）+ §5（顶部搜索常驻） | 现仅品牌文案（D1） |
| 主区 | view-head 右侧加视图切换 segmented（列表/网格，aria-pressed 表达态，首期仅本地收藏）；网格 `repeat(auto-fill, minmax(168px, 1fr))` gap 12px | §8（album grid 5→3→2→1 列塌缩；§5 grid-based cards） | 新增（D2） |
| np 面板 | 定位裁决见 §1.5：保持覆盖式 320px（零结构改动）；<1280px 由「整体隐藏」升级为全屏浮层 | §8（Now-playing bar maintained at all sizes——播放上下文不因屏宽消失） | 增强（D3/D4） |
| 播放栏 | 三段式结构保持；本轮仅交互增量（§4） | §5 Full-width now-playing bar | 无结构改动 |

### 1.2 中间档（901–1279px）

```
+----------+------------------------------+
| sidebar  | topbar（搜索 pill 收窄 200px）|
| 232px    +------------------------------+
| (折叠钮  | 主区（列表/网格切换保留）       |
|  隐藏)   | np 侧栏面板隐藏 -> 全屏浮层:   |
|          |  #np-panel.np-fullscreen      |
|          |  (fixed inset:0, z-95)        |
+----------+------------------------------+
| player-bar（#pb-expand 改为开全屏浮层）   |
+-----------------------------------------+
```

### 1.3 窄档（≤900px，维持现状骨架）

侧栏抽屉 + nav-toggle + 播放栏换行（style.css L1046 已有）全部保持；np 全屏浮层与 §1.2 共用一套 `.np-fullscreen` 样式。SPD §8 移动端「sidebar → bottom bar」范式**不采纳**（UI-GUIDE §3.3 已裁定：fpk 部署以桌面 Web 为主场景，移动端只吸收母题不吸收布局）。

### 1.4 主内容区「卡片网格 vs 列表」视图切换（含记忆）

- **载体**：`#view-library .toolbar` 内加 segmented 控件（`#lib-view-list` / `#lib-view-grid` 两个按钮，aria-pressed 表达态），不新增视图路由。
- **状态机**：单 class `body.lib-grid` 切换——列表态现有 `.song-list` 不动；网格态 `body.lib-grid #library-songs .song-list { display: grid; … }`，`.song-row` 结构 grid 重排（DOM 模板零改动，契约安全）。
- **记忆**：localStorage `rainbow.library-view = 'list' | 'grid'`，library.js init 读取应用；try/catch 防御范式复用 main.js L71-78（sidebar-compact 同款）。
- **网格卡规格**：封面槽 1:1（`/api/v1/cover/:taskId` + onerror 降级音符位，复用现有降级链）；歌名 14.5px/600 var(--txt) 单行省略；歌手 12px/400 var(--txt2)；卡底 rgba(255,255,255,.07) + --r-card 16px；hover 提亮 --card-hi + 播放钮浮现（36px 橙圆钮 rgba(238,108,43,.9)，Spotify 卡 hover 绿圆钮的 Hume 单橙映射）。
- **适用范围**：首期仅本地收藏（歌曲粒度全量、封面可用）；歌单页已有网格（UI-GUIDE P0-3 落地）；**搜索结果页不做网格**（多选勾选批量流程依赖行结构，网格态复选框成本高收益低）。

### 1.5 np 面板定位取舍（固定右栏 vs 浮层 vs 现状 fixed 滑入）

| 方案 | 描述 | 优点 | 代价 | 裁决 |
|---|---|---|---|---|
| A 固定右栏（参与 .app flex 布局） | aside 常驻占位 | 与 Spotify 现版最接近；主区宽度真实收缩 | 需重构 .app flex 与三处让位逻辑（main padding / 播放栏 right / 抽屉态）；「可选性」差 | **不采纳**：现状「覆盖式 + padding 让位」在视觉与行为上已等价（打开时主区同样收缩 336px），结构重构属高风险低收益 |
| B 居中浮层（modal 卡） | Now Playing 做模态 | 沉浸感 | 遮挡列表主流程；Spotify 仅移动端用全屏范式 | **不采纳为主形态**；吸收其全屏变体作为 <1280px 降级（D4） |
| C 现状：fixed 右缘滑入 + main padding-right 让位 | 已实现并验证（CDP 0 error） | 零结构改动；开合动画就绪；<1280 有遮蔽保护 | 开合不记忆；<1280 整体隐藏（播放上下文功能缺口） | **采纳并增强**：①开合记忆 localStorage `rainbow.np-open`（setNpOpen 写入、init 恢复，仅 ≥1280 应用）；②<1280 升级 `.np-fullscreen` 全屏浮层态（#pb-expand 入口不隐藏，改开浮层；Esc/收起钮关闭） |

### 1.6 与现状 diff 总表

| # | 项 | 现状 | 目标 | 类型 |
|---|---|---|---|---|
| D1 | 顶栏 | 静态品牌文案 | 视图标题 + 全局搜索 pill | 结构增量 |
| D2 | 视图切换 | 无（纯列表） | 列表/网格 segmented + localStorage 记忆 | 结构增量 |
| D3 | np 开合记忆 | 不记忆（刷新即合） | localStorage 恢复 | 小 JS |
| D4 | np <1280px | 整体隐藏 | 全屏浮层（.np-fullscreen） | 结构增量 |
| D5 | 侧栏歌单组 | 无（歌单仅页面内可达） | 侧栏「歌单」组（前 5 个，点击直达） | 结构增量 |
| D6 | 断点体系 | 3 档（900/1280） | 维持 3 档 + np 浮层跨档补强（SPD 7 档不照搬，理由见 §3.2 T4） | 维持 |

## 2. 功能模块对标矩阵

### 2.1 主矩阵（Spotify 核心模块 × Rainbow 现状）

| Spotify 模块 | Rainbow 现状 | 覆盖度 | 体验差距 | 增强建议 | 需新后端 |
|---|---|---|---|---|---|
| Home 发现流 | 「发现」= 跨平台聚合搜索（五平台并发 + 音质四档） | 部分（工具型 vs 内容型，域模型不同） | 无浏览/榜单/推荐入口 | 首页加「最近搜索 + 最近播放封面网格」快捷区（纯前端，复用现有 localStorage 数据） | 否（榜单/推荐内容端点不存在，**不做**，避免臆造后端） |
| 搜索 | 表单四件套（词/类型/平台/音质）+ 平台分组结果 + 批量工具条 | 已具备核心 | 入口藏于视图内（无全局搜索）；无历史；无联想 | 顶栏全局搜索（§1.1 D1）+ 搜索历史（§2.2-F）+ P2 实时联想（复用既有 /search 端点，防抖 300ms） | 联想不需要 |
| 歌单管理 | CRUD + items 增删 + 整单下载 + 网格卡（P0-3 已落地） | 已具备基础 | 无侧栏直达；无歌单封面；详情无内排序 | 侧栏歌单组（D5）；封面 = 前四曲 musicInfo.img 直链 2×2 拼贴（纯前端） | 拖拽排序需 items 加 position 字段（P2-3 标注） |
| 本地图书馆 Your Library | 全量歌曲列表（56px 行 + 三件套高亮）+ 下载队列区 | 部分 | 无艺人/专辑聚合分组；无网格视图；无排序筛选 | 网格视图（§1.4 D2）；歌手分组（前端按 tasks 的 singer 字段聚合，纯前端可做） | 艺人/专辑独立页需聚合端点（P2-1 标注） |
| 播放队列 Queue | np 面板队列 tab：点击切歌、当前项三件套、eq 动画 | 已具备展示 | 无编辑（移除/清空/插队）；无持久化（刷新丢） | 队列编辑 + 持久化（§2.2-A） | 否（localStorage） |
| 歌词 | np 面板滚动歌词：时间轴高亮 + 纯文本降级 + 错误重试 | 已具备 | 无全屏歌词态 | P2：np 全屏浮层（D4）自然承载大字歌词 | 否 |
| 喜欢歌曲（Liked Songs） | 无对应概念（下载即拥有；歌单承担收藏） | 不适用 | — | **剔除**：域模型不同（流媒体收藏 vs 本地文件库），强行加心标引入第二套收藏语义 | — |
| 播客/有声书 | 无 | 不适用 | — | **剔除**（后端无播客域） | — |
| 社交（好友动态/协作歌单） | 无 | 不适用 | — | **剔除**（UI-GUIDE §3.3 已裁定：单用户自托管下载器，无社交域） | — |
| 播放控制全套 | shuffle / prev / play / next / repeat 三态（P1 已落地） | 已具备 | 无键盘全局快捷键 | §2.2-E | 否 |
| 最近播放 | 侧栏 20 条 + 任务存在性校验 + 404 自清理 | 已具备 | 无首页网格化展示 | 并入 Home 快捷区建议 | 否 |
| 系统媒体集成 | 无 | 缺失 | 锁屏/系统播放控件/媒体键不可用 | §2.2-B（MediaSession） | 否 |

### 2.2 用户点名候选项逐项评估（7 项全评）

| # | 候选 | 现状证据 | 结论 | 方案要点 |
|---|---|---|---|---|
| A | 播放队列持久化（localStorage） | player.js：queue/index 为模块变量，刷新即丢；playQueue 每次全量重建 | **建议做（P1）** | loadAt/setNpOpen 时写 `rainbow.queue`（含 queue 数组 + currentTaskId + shuffleOn/repeatMode）；init 读取→**仅恢复「已暂停」态**（audio.src 需用户手势才可播，恢复为待播而非自动播）；恢复时逐条跳过 404 任务（复用 main.js onRecentClick 校验范式）；容量截断 200 条防配额 |
| B | MediaSession 锁屏/系统媒体控制 | 全库无 navigator.mediaSession 引用 | **建议做（P0，性价比最高）** | loadAt 更新 `navigator.mediaSession.metadata`（title/artist/artwork = `/api/v1/cover/:taskId`）；setActionHandler 绑 play/pause/previoustrack/nexttrack/seekto/seekbackward/seekforward；playbackState 随 play/pause 同步；纯增量约 30 行进 player.js；Chromium/Safari/Firefox 均支持 |
| C | FLAC 浏览器兼容降级提示 | 无 canPlayType 检测；Safari（≤14）/旧 Edge 对 audio/flac 解码不全 | **建议做（P0 轻量）** | init 时 `audio.canPlayType('audio/flac')`：返回空串且曲库含 .flac → 播放栏上方一次性提示条（「当前浏览器可能不支持 FLAC 播放，建议 Chrome/Edge；或下载后本地播放」，可关闭，localStorage `rainbow.flac-tip-dismissed` 记忆）；播放 error 事件兜底文案区分 401/410（会话/文件）与解码失败 |
| D | 右键菜单（上下文操作） | 全库无 contextmenu 监听（浏览器原生菜单） | **建议做（P1）** | 内容项清单 + 定位策略详见 §4.5 |
| E | 键盘快捷键（空格/方向键） | 仅音量条 focus 后 ←→ ±5%（player.js L779-786） | **建议做（P0）** | 全局 keydown（**排除** input/textarea/select 焦点与修饰键）：Space 播放/暂停、←/→ seek ∓5s、↑/↓ 音量 ±5%（复用 setVolume）、N/P 切歌（next ±1）、`/` 聚焦全局搜索（P1-D1 就绪前降级为跳发现视图聚焦 #keyword）、Esc 关 np 浮层/菜单；快捷键帮助浮层列 P2 可选 |
| F | 搜索历史 | 无 | **建议做（P0）** | onSearch 成功后写 `rainbow.search-history`（去重置顶，保留 12 条，含 keyword/type/platform）；#keyword focus 且值为空时下方弹出历史面板（渲染语系复用 .sb-recent-item：40px 槽改时钟图标 + 双行文字）；点击项回填并直接执行搜索；支持单条删除与一键清空 |
| G | 视图密度切换 | 无 | **缓做（P2 可选）**：网格/标准列表（D2）先行 | 网格 + 56px 标准列表已覆盖主要价值；Spotify 式紧凑列表（无封面、行高 ~40px）对中文双行元信息（歌名+歌手）收益低，且 56px 行高是 UI-GUIDE §2.1 既定契约；若做则作为第三态 `body.lib-compact`（行高 40px、封面 32px、歌名/歌手合并单行省略），与 D2 切换器并为三段 |

### 2.3 优先级矩阵（价值 × 成本四象限）

```
 价值高 |  B MediaSession        ||  D 右键菜单系统
       |  E 键盘快捷键          ||  D2 网格视图切换
       |  F 搜索历史            ||  P1-4 队列编辑(移除/插队)
       |  C FLAC 提示           ||  D4 np 全屏浮层
       |  A 队列持久化          ||  D1 顶栏全局搜索
       |  D3 np 开合记忆        ||  D5 侧栏歌单组
       |========================||========================
       |  G 密度第三态          ||  P2-1 艺人/专辑聚合页
       |  音量 hover 展宽       ||  P2-2 搜索实时联想
 价值低 |  音量记忆(成本极低)    ||  P2-3 歌单拖拽排序
       |         成本低          ||         成本高
```

裁决依据：左上象限全部为 <100 行纯前端、零契约风险、日常高频操作；右上象限价值等价但需新组件/结构（各约 0.5–1 天）；右下两项被后端能力阻塞（§0.3）或交互链路过长。

## 3. token 映射对照表（SPD 具体值 × Hume 体系）

### 3.1 #48 AUDIT 已裁决项引用（不复议、不重复展开，详见 DESIGN-MD-AUDIT §2/§4）

| AUDIT# | 主题（SPD 原值） | 裁决 | 本轮状态核验 |
|---|---|---|---|
| S1/V1 | 两级 elevation：Medium `rgba(0,0,0,.3) 0 8px 8px` / Dialog `rgba(0,0,0,.5) 0 8px 24px` | 采纳改造（--shadow-card 双层 / --shadow-float `0 12px 32px rgba(0,0,0,.42)`） | **已完成**（style.css :root L32-33 实测在） |
| S2 | 输入框 inset 内凹（`rgb(124,124,124) 0 0 0 1px inset` 组合） | 采纳（毛玻璃版 `inset 0 1px 3px rgba(0,0,0,.18)`） | 已完成（input 基础规则） |
| S3/S4/S11/S13/S14 | 行 hover 提亮 / 按压反馈 / pill+circle 几何 / 三层近黑 / 单一功能色 | 已同构或已补齐 | 已完成 |
| S5 | 当前播放行降级为 Spotify 式弱高亮 | 不采纳（三件套更强） | 维持裁决（§4.1 引用并核验闭环） |
| S6/L1 | Secondary `#b3b3b3`（对 #121212 ≈7.2:1），数据文本同层 | 采纳（数据类 txt3→txt2 ≈7.9:1） | 已完成 |
| S7 | 字重二元 700/400 | 不采纳（中文 PingFang 700 过重） | 维持 |
| S8 | 细滚动条 | 采纳（webkit + Firefox thin） | 已完成 |
| S9/L2 | focus ring 规格 | 采纳（去 border-radius 覆盖 + 90% 微透） | 已完成 |
| S10 | 按钮大写 + 1.4–2px 字距 | 不采纳（中文域）；分组标签已吸收理念 | 维持 |
| S12 | 播放键 heavy 阴影 | 采纳（stacked 三层） | 已完成 |
| S15 | 卡片圆角 6–8px | 不采纳（24/16/12/999 四级契约） | 维持 |

### 3.2 本轮新增裁决（布局/功能/交互层，编号 T*；均不在 AUDIT 19 项覆盖范围）

| # | SPD 原文值（§出处） | Hume 现值 | 裁决 | 理由 |
|---|---|---|---|---|
| T1 | SPD 全篇无 backdrop-filter：深度靠实色分层 #121212/#181818/#1f1f1f（§1/§6） | blur(24–28px) saturate(1.2–1.25) 毛玻璃三层 | **不采纳实色化** | 毛玻璃+单橙是 Rainbow 身份核心（HUME 体系全部裁决建立在此基线）；SPD「content-first darkness」理念已通过三层近黑底 + 封面供色（--ambient）吸收，无需放弃材质 |
| T2 | 搜索输入：500px pill、#1f1f1f 底、padding 12px 48px（§4 Inputs） | .search-bar 已胶囊化；顶栏无搜索 | **采纳（用于顶栏全局搜索 pill）** | 映射：暗玻璃胶囊 rgba(255,255,255,.06) + --r-pill + inset 内凹（S2 基元）+ focus 橙环；高 36px、宽 280px（901–1279 收窄 200px）、placeholder 12.5px var(--txt3) |
| T3 | 专辑网格 5→3→2→1 列塌缩（§8 Collapsing） | 歌单网格 auto-fill minmax(240px,1fr) 已落地；歌曲无网格 | **采纳（本地收藏网格）** | `repeat(auto-fill, minmax(168px, 1fr))` gap 12px——歌曲卡窄于专辑卡（无大标题）；塌缩交给 auto-fill 自然承担，不写死列数（Spotify 固定列数是其内容定宽卡，Rainbow 自适应更简） |
| T4 | 断点 7 档：<425 / 425–576 / 576–768 / 768–896 / 896–1024 / 1024–1280 / >1280（§8） | 3 档：900 / 1279.98 / 1280 | **不采纳照搬** | fpk 桌面 Web 主场景（UI-GUIDE §3.3）；7 档对单页应用属过度工程；仅吸收其「now-playing 上下文全尺寸保持」精神 → D4 np 全屏浮层 |
| T5 | 密度哲学：dark compression、content density over breathing room（§5 Whitespace） | 56px 行 + hover 浮现操作 + 紧凑 view-head | **已吸收，无新增动作** | 网格态 gap 12px 同密度基调；不进一步压缩（中文可读性下限） |
| T6 | Now-playing bar maintained at all sizes（§8） | 播放中常驻，≤900 换行 | 已同构 | — |
| T7 | 语义色 negative `#f3727f` / warning `#ffa42b` / announcement `#539df5`（§2） | --err #E5484D / --warn #E0A000，限面积 | **不采纳替换** | Hume 状态色已达标且限面积（UI-GUIDE §2.2）；引入第三色相（蓝）违反单橙+语义克制铁律（AUDIT §4 末行同族裁定） |
| T8 | Section Title 24px/700（§3 Hierarchy） | view-title 20px/700、np 标题 20px/700 | **不采纳抬升** | 与 S7/S10 同族：中文 20px/700 已是列表密度下可读上限，24px 中文在 232px 侧栏 + 56px 行体系里过重 |
| T9 | 卡片无可见边框 + hover 轻微提亮（§4 Cards） | 1px 内高光代边框 + --card-hi hover | 已同构（= AUDIT S3） | — |

### 3.3 本轮新增命名空间与 localStorage key 汇总（全部纯增量，避开 UI-GUIDE 附录 A 契约清单）

- DOM/class：`#topbar-search`、`#topbar-view-title`、`#lib-view-list` / `#lib-view-grid`、`body.lib-grid`、`body.lib-compact`（P2）、`.np-fullscreen`、`#ctx-menu` / `.ctx-item` / `.ctx-sep` / `.ctx-danger`、`#flac-tip`、`.search-history-pop`。
- localStorage：`rainbow.queue`、`rainbow.np-open`、`rainbow.library-view`、`rainbow.search-history`、`rainbow.vol`、`rainbow.flac-tip-dismissed`（命名对齐既有 `rainbow.recent` / `rainbow.sidebar-compact` 前缀范式）。

## 4. 交互细节优化方案（每项：现状 → SPD 规格 → 建议 → 落地路径）

### 4.1 当前播放行高亮

- SPD 方式：歌名变 Spotify 绿 `#1ed760` + 行底微亮（§4/§9）。
- Rainbow 现状：本地收藏行三件套（橙渐变行底 + inset 发光描边 + eq 三柱 + 歌名 --acc-hi）；**np 队列当前项同为三件套**（style.css L1334-1338 实测：渐变行底 + 描边 + `.np-item-meta b { color: var(--acc-hi) }`）。
- **裁决：维持现状，零改动**。AUDIT S5 已裁定降级属倒退；本轮核验 np 队列行已统一三件套语系（GUIDE 差距表中的历史遗漏项实际已闭环）。搜索结果行无播放态（结果非本地任务、不入播放队列），不适用、不造假状态。

### 4.2 进度条（悬停膨胀已达标 → 补拖拽预览气泡 + 键盘）

- 现状：`.pb-seek:hover` 轨 4→6px、把手 12→16px（style.css L1000/L1018，UI-GUIDE P0-2 已落地）；bindSlider 支持 pointer 点击/拖动定位。
- SPD 规格：悬停膨胀 + 拖拽中时间预览（hover 时间气泡是 Spotify Web 拖拽 seek 的标志性反馈）。
- 增量方案（两件）：
  1. **拖拽预览气泡**：bindSlider 拖拽期间给 `#pb-seek` 加 `.dragging`（pointerup/pointercancel 移除）；CSS `.pb-seek.dragging::after { content: attr(data-tip) }` —— 气泡 11.5px tabular-nums、底 rgba(16,17,19,.9) + blur(8px)、圆角 --r-ctl、定位于轨道上方 -28px 水平跟随把手；player.js apply() 内同步 `els.seek.dataset.tip = fmt(r * dur)`。
  2. **seek 键盘**：`#pb-seek` 加 tabindex=0 + keydown ←/→ ±5s / Shift+←→ ±30s（复用音量条键盘范式 player.js L779-786）；aria-valuenow/valuetext 已有同步链（syncProgress）。
- 落地：web/js/player.js（bindSlider +6 行、keydown +8 行）、web/style.css（.pb-seek.dragging::after 段约 12 行）、web/index.html（#pb-seek 加 tabindex 属性一处）。

### 4.3 音量控制

- 现状：常驻 84px 轨（≤900px 收 56px，style.css L1023/L1050）；音量初始硬编码 0.8（player.js L679）不记忆。
- SPD 规格：图标 + 合拢条 hover 展开（省空间），滑条与 seek 同构反馈。
- **裁决：保持常驻条（桌面主场景 + 可见性更好），采纳两件小增量**：
  1. **音量记忆**：init 读 localStorage `rainbow.vol`（缺省 0.8）；setVolume 内 debounce 300ms 写入（try/catch 防御，范式同 main.js L71-78）。
  2. **hover 展宽（可选）**：`.pb-voltrack { width: 84px; transition: width .18s ease }` + `.pb-vol:hover .pb-voltrack { width: 104px }`——低成本吸收「悬停增益」手感；**不做合拢态**（合拢后把手/当前值不可见，与可见性目标冲突）。
- 落地：player.js 约 8 行、style.css 3 行。

### 4.4 切歌过渡（封面 crossfade）

- 现状：单层封面 `coverIn`（opacity 0→1 + scale .96→1，240ms ease-out）已实施于 .pb-cover（style.css L948）与 np 面板封面（L1257/L1352）；切歌时 hidden 复位再 load 防残影（player.js syncCover/syncNp）。
- **裁决：维持单层淡入，不做真 crossfade（双层 img 交替淡出淡入）**。理由：单 `<audio>` 切歌是 src 整替，无双缓冲窗口可言；双层封面需预载下一首图（cover 接口对部分任务是 302 外链，延迟不可控），复杂度与闪烁风险大于收益；现状 240ms 淡入已达成「平滑不闪断」的验收口径（GUIDE P1-6）。
- 可选 P2 增量（列出不排期）：np 大封面切歌时 `--ambient` 氛围光同步 300ms 过渡（background-image 不能 transition，需双层伪元素交叉，收益低）。

### 4.5 右键菜单（内容项清单 + 定位策略）

**菜单内容项清单（按触发区）**：

| 触发区 | 菜单项 | 动作来源（全部复用既有 API/组件） |
|---|---|---|
| 本地收藏歌曲行 `.song-row` | ① 立即播放 ② 下一首播放（插队） ③ 加入歌单… ④ 刮削元数据 ⑤ 复制「歌名 - 歌手」 ⑥ 删除任务（danger + confirmModal） | ① player.playQueue(q, id) ② P1-4 insertNext ③ ui.js pickPlaylistModal + api.playlists.addItem——**注意：items 契约为 platform+musicInfo，本地完成任务响应是否回传 musicInfo 未在 API.md 标明，实施前需实测；若不回传则本项仅对搜索行开放** ④ api.scrape.task（复用 library.js onScrapeAction） ⑤ navigator.clipboard.writeText ⑥ api.tasks.remove + confirmModal（复用 onQueueAction del 分支） |
| 搜索结果行 `.result-row` | ① 下载这首 ② 加入歌单… ③ 复制「歌名 - 歌手」 | ① api.download.batch 单元素数组（onRowDownload 同款） ② musicInfo 齐备，无障碍 ③ clipboard |
| np 队列行 `.np-item` | ① 下一首播放 ② 从队列移除 | 队列内存操作（P1-4 removeAt/insertNext） |

**定位策略**：fixed 定位（clientX/Y 起点）；打开前 `getBoundingClientRect` 测量——右缘溢出则左翻、下缘溢出则上翻（Spotify 同款视口翻转）；触发滚动/resize/点击菜单外区域/Escape 任一即关闭；菜单容器 aria-expanded + role=menu，项为 button（role=menuitem）。

**视觉规格（Hume 映射，非 Spotify 绿）**：宽 min-content ≥180px、项高 34px、字 13px/400（danger 项 --err）；分隔线 .ctx-sep 1px rgba(255,255,255,.08)；容器 --r-ctl 12px、底 rgba(15,16,18,.86) + blur(24px) saturate(1.2) + 1px 内高光 + --shadow-float（AUDIT 浮层档）；项 hover rgba(255,255,255,.07)。

**落地**：新文件 `web/js/ctx-menu.js`（show(items, x, y) + 全局关闭管理，约 90 行）；index.html 末尾 `<div id="ctx-menu" hidden>`；style.css `#ctx-menu` 段约 40 行；library.js / search.js / player.js 各加 contextmenu 事件委托约 15 行（命中行才 preventDefault，保留原生菜单兜底）。

## 5. 分阶段实施建议

> 归类口径：**布局重构** = 改变页面结构/信息架构（§1 的 D 系列）；**功能增强** = 新增能力不改布局骨架（§2 系列）。契约影响全部按 UI-GUIDE §5.0 五条红线评估。

### P0 · 纯 CSS / 小 JS 高价值（合计约 0.5–1 天，零结构风险，可并行）

| # | 任务 | 规模 | 依赖 | 契约影响 | 归类 |
|---|---|---|---|---|---|
| P0-1 | MediaSession 元数据 + 动作 handlers（§2.2-B） | player.js 约 30 行 | 无 | 纯增量（API 存在性检测渐进增强） | 功能增强 |
| P0-2 | 全局键盘快捷键 Space/←→/↑↓/N/P//（§2.2-E） | 新 hotkeys.js 或 main.js 约 50 行 | `/` 键目标依赖 P1-1，先降级为聚焦 #keyword | 纯增量（排除表单焦点） | 功能增强 |
| P0-3 | 搜索历史 + focus 下拉（§2.2-F） | search.js 约 60 行 + CSS 约 20 行 | 无 | 新增 .search-history-pop 命名空间 | 功能增强 |
| P0-4 | 音量记忆 + hover 展宽（§4.3） | player.js 约 8 行 + CSS 3 行 | 无 | 纯增量 | 功能增强 |
| P0-5 | 进度条拖拽气泡 + seek 键盘（§4.2） | player.js 约 14 行 + CSS 约 12 行 + index.html 1 属性 | 无 | #pb-seek 加 tabindex（属性增量） | 功能增强 |
| P0-6 | FLAC 兼容提示条（§2.2-C） | player.js 约 20 行 + CSS 约 15 行 + index.html 1 节点 | 无 | 新增 #flac-tip | 功能增强 |
| P0-7 | np 开合记忆（§1.5-C① / D3） | player.js 约 8 行 | 无 | 纯增量 | 布局重构 |

### P1 · 结构增量（合计 1–2 天）

| # | 任务 | 规模 | 依赖 | 契约影响 | 归类 |
|---|---|---|---|---|---|
| P1-1 | 顶栏升级：视图标题 + 全局搜索 pill（§1.1 D1） | index.html topbar 改造 + main.js showTab 联动约 30 行 + CSS 约 30 行 | P0-2（/ 键升级目标，可后补） | topbar 内新增 #topbar-search / #topbar-view-title；nav-toggle/.topbar-brand 保留 | 布局重构 |
| P1-2 | 本地收藏网格/列表切换 + 记忆（§1.4 D2） | library.js 约 40 行 + CSS 约 50 行 | 无 | body.lib-grid + #lib-view-* 新增；.song-row 模板不动 | 布局重构 |
| P1-3 | 右键菜单系统（§4.5 D） | 新 ctx-menu.js 约 90 行 + 三视图接入约 45 行 + CSS 约 40 行 | P1-4（队列项动作；可先上收藏/搜索两区） | 新增 #ctx-menu 命名空间 | 功能增强 |
| P1-4 | 队列编辑：移除单曲 / 清空 / 下一首播放（插队） | player.js 约 40 行（removeAt/insertNext/clearQueue）+ renderNpQueue 行尾操作钮 | 无 | .np-item 模板增量按钮 | 功能增强 |
| P1-5 | 播放队列持久化（§2.2-A） | player.js 约 35 行（loadAt 写入 + init 恢复「已暂停」态） | 建议晚于 P1-4（持久化结构定稿） | localStorage rainbow.queue | 功能增强 |
| P1-6 | 侧栏歌单组（§1.1 D5） | main.js 约 30 行（api.playlists.list + 渲染） | 无 | .sb-playlist-item 复用 .sb-recent-item 渲染语系 | 布局重构 |
| P1-7 | np 全屏浮层 <1280px（§1.2 D4） | player.js setNpOpen 分支约 15 行 + CSS 约 30 行 | P0-7 | .np-fullscreen 态 class；#pb-expand <1280 由隐藏改可用 | 布局重构 |

### P2 · 需新后端或大改（按需排期，不阻塞 P0/P1）

| # | 任务 | 规模 | 依赖 | 契约影响 | 归类 |
|---|---|---|---|---|---|
| P2-1 | 艺人/歌手聚合视图（分组浏览） | 前端约 1 天 | **需新后端**：GET /tasks 响应暴露 singer/album 等可分组字段，或新增 `/api/v1/library/grouped?by=artist|album` 聚合端点（含代表封面） | view-library 子态（新 class） | 功能增强 |
| P2-2 | 搜索实时联想（防抖 300ms + 下拉 + 键盘导航） | 前端约 0.5 天 | 后端无需改（复用 /search?limit=5）；列 P2 因竞态/AbortController/键盘链路完整实现成本 | .search-suggest 命名空间 | 功能增强 |
| P2-3 | 歌单封面 2×2 拼贴 + 歌单内拖拽排序 | 拼贴前端约 0.5 天；拖拽**需新后端**（items 加 position 字段 + PATCH 顺序端点） | 后端确认后分两步 | 渲染模板增量 | 功能增强 |
| P2-4 | 本地曲库排序/筛选（时间/名称/歌手 + 关键词过滤） | library.js 渲染管线加 sort/filter 层，约 1 天 | 无（纯前端，但属大改） | toolbar 增量控件 | 功能增强 |
| P2-5 | 密度第三态紧凑列表（§2.2-G） | CSS 约 30 行 + 切换器扩态 | P1-2 | body.lib-compact | 布局重构 |

**需新后端能力汇总（全清单仅两项）**：P2-1 聚合端点/字段、P2-3 items 顺序字段。其余全部任务纯前端可实现；本文全部规划未依赖任何不存在端点（后端核对见 §0.3）。

**依赖链**：P0 七项互相独立可并行 → P1-1 依赖 P0-2（可空降级）、P1-3 依赖 P1-4（可拆两区先行）、P1-5 建议晚于 P1-4 → P2 按需独立排期。

**验收口径（P0/P1 完成后）**：① UI-GUIDE §6 验收标准 ①②⑦ 全量回归 + ② 新增功能各自冒烟（快捷键不劫持表单输入、MediaSession 在 Chrome 媒体控件可见、队列刷新恢复为已暂停态、右键菜单视口四角不溢出）；③ 旧 id/class 全部可检索（对照附录 A 清单）；④ CDP console 0 error 基线维持。

## 附录 A · 与 DESIGN-MD-AUDIT.md（#48）的边界对照

| 维度 | #48 AUDIT | 本文 #49 |
|---|---|---|
| 层级 | 视觉 token / CSS 精修 | 布局 / 功能 / 交互架构重规划 |
| 方法 | 19 项品牌规格映射（Spotify 主 + Linear/Vercel 辅） | SPD 布局与交互范式 + 功能模块矩阵 + 新增 T 系列裁决 |
| 产出 | style.css 9 项改动（已实施、已验证 IDENTICAL + CDP 0 error） | 本规划文档（零代码） |
| 引用关系 | 其 §2 映射表与 §4 未采纳项为本文既定约束（本文 §3.1 引用不复议） | 本文 §3.2 T 系列不触碰其已实施 CSS；重叠接触点仅 §4.1（S5 当前行高亮）——标注「维持裁决，现状已闭环，零改动」 |
| 已实施项防重复 | S1/S2/S4/S6/S8/S9/S12 等在本文一律标「已完成」 | — |

## 附录 B · 契约红线与证据出处

- 契约红线：MUSIC-PLAYER-UI-GUIDE §5.0（五条）+ 附录 A（66 静态 id + JS 渲染 class 清单）；本文新增命名空间（§3.3）逐一比对无冲突；.src-card 双视图复用场景本文未触碰。
- 证据：Spotify 规格值全部出自 `references/spotify/DESIGN.md`（§n 行内引用）；Rainbow 现状值出自 web/index.html（304 行）、web/style.css（1546 行）、web/js/player.js（826 行）、web/js/pages/{library,search,playlists}.js、web/js/{api,main,ui,sse}.js 实测；后端能力出自 API.md（574 行）+ server/src/routes/ 目录 + api.js 交叉核对（发现 API.md 漏收 playlists 一章，以实际路由为准）。
- 关键已实施核验（防重复建议）：coverIn 切歌过渡在 style.css L948/L1257/L1352；np 队列当前项三件套在 L1334-1338；seek hover 膨胀在 L1000/L1018；两级阴影在 :root L32-33；侧栏折叠记忆在 main.js L69-108。
