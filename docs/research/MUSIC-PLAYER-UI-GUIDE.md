# 音乐播放器 UI 研究与 Rainbow 优化指南（MUSIC-PLAYER-UI-GUIDE）

> 素材：本目录 8 组共 12 张 Dribbble 音乐播放器参考图（research/mp-*.png）+ 基准文档 HUME-DESIGN-BREAKDOWN.md
> 现状：docs/screenshots/ 9 张 Rainbow 视图截图（Hume 深色毛玻璃体系 v1 已落地）
> 用途：五维提炼跨作品共性规范 → 与 Hume 体系融合取舍 → Rainbow 现状差距 → P0/P1/P2 优化方案 → 可直接执行的改造提示词
> 约束：所有改造保持现有 DOM id/class 与 JS 契约不破坏（只允许增量，禁止改名/删除）；引用截图使用相对路径 research/mp-*.png 与 screenshots/*.png

## 1. 参考作品索引

| 编号 | 作品 | 形态 | 本地截图 | 一句话亮点 |
|---|---|---|---|---|
| mp-1 | Groovvy | 深色 Web | research/mp-1-dark-webapp.png | 三栏布局 + 右侧 Player 常驻面板（封面/进度/全套控制/LYRICS 折叠入口），Top Charts 编号行 |
| mp-2 | Musa | 深色桌面 | research/mp-2-musa-desktop.png | 深色侧栏歌单列表（缩略图+数量）+ 艺人金黄 banner 取色 + 底部半透明播放条——与 Rainbow 结构最接近 |
| mp-3 | Musiclia | 浅色 Web | research/mp-3-fleex-webapp.png、research/mp-3-fleex-webapp-2.png | 底部播放条 + Billboard 榜单行（当前曲整行粉色高亮）+ 封面横向滚动行 |
| mp-4 | ChefMusic | 浅色桌面 | research/mp-4-fireart-desktop.png、research/mp-4-fireart-desktop-2.png | 右侧 Friends Activity 社交面板 + 专辑卡内嵌 5 行曲目清单 + Recently Played 五联封面 |
| mp-5 | Adze | 深色 Web（双主题） | research/mp-5-portal-dark.png、research/mp-5-portal-dark-2.png | Spotify 式曲目表格（# / TITLE / 播放量 / 时长 / 悬浮操作），当前行反色+暂停图标，几乎零彩色的黑白灰克制 |
| mp-6 | Indev | 浅色桌面 | research/mp-6-indev-web.png | 72px 窄图标栏 + 大封面 NOW PLAYING 悬浮卡（scrim 遮罩 + 小写字距标签 + shuffle/queue/repeat） |
| mp-7 | Echo Mirage | 深色平板 | research/mp-7-riotters-echo-mirage.png、research/mp-7-riotters-echo-mirage-2.png | 三面板工作流（Overview/Tracks/Lyrics）+ 歌词 sidecar（时间戳/当前句/协作头像）+ A/B 版本标签 |
| mp-8 | MIO | 移动端（最高热度） | research/mp-8-nixtio-mobile.png | 黑胶母题（圆形封面+中心孔）+ 波形进度可视化 + 黄黑暖色氛围 |

注：采集时未记录 Dribbble 直链，URL 列从略；需要时以作品名在 Dribbble 检索即可。

## 2. 五维设计规范（跨作品共性 → Rainbow 推荐值）

### 2.1 布局结构

跨作品共性：
1. 导航栏两档宽度：全宽文字栏 220–240px（mp-1/2/3/4/5）与窄图标栏约 64–72px（mp-6）；栏内 3–4 个分组（菜单 / 曲库 / 歌单），组标题 10–11px 大写 + 1–2px 字距。
2. 播放控制两种位置：底部全局条（8 作中 6 作，mp-2/3/4/5 均是，高度 64–88px，深浅主题通吃）vs 右侧常驻面板（mp-1 Groovvy、mp-7 局部）。底部条与右侧面板不冲突——mp-7 两者并存（Minimize/Player 视图切换）。
3. 曲目承载 5/8 用「榜单/表格行」：行高 48–60px，含封面缩略或序号、标题+歌手双行、时长、悬浮操作；专辑/歌单用 1:1 封面网格（4–6 列）或横向滚动行。
4. 上下文第二面板：右侧放艺人信息/社交/歌词（mp-1 Player、mp-2 艺人面板、mp-7 三面板）；或 NOW PLAYING 大封面悬浮卡（mp-6）。

Rainbow 推荐值：
- 保持 232px 毛玻璃侧栏 + 底部播放条（与 mp-2 Musa 同构，Rainbow 现状即此路线，验证正确）。
- ≥1280px 屏新增右侧 Now Playing/队列面板：宽 320px、毛玻璃、transform 滑入/出；打开时 body.np-open 使 main 右侧 padding 增至 336px；<1280px 隐藏入口（媒体查询兜底）。
- 曲目行统一行高 56px、内边距 8px 12px（song-row / result-row / 歌单详情行一致）。
- 歌单网格：`repeat(auto-fill, minmax(240px, 1fr))`，间距 14px（对标 mp-2 歌单列表卡）。
- 侧栏窄图标模式（72px，body.sidebar-compact）列为 P2 可选，data-tab 契约不动。

### 2.2 色彩体系

跨作品共性：
1. 深色系（mp-1/2/5/7）背景 2–3 层级：底 #0E–#14 / 面板 #16171B–#1E1E24 / 卡片 rgba(255,255,255,.05–.09)；浅色系（mp-3/4/6）反向（#F2–#F7 底 + 白卡 + 粉紫强调）。
2. 强调色克制是跨作品铁律：mp-5 几乎零彩色（黑白灰 + 反白按钮）；mp-1 的多彩只出现在「流派标签」这类内容分类，从不进入按钮/进度等控件态。
3. 渐变光效均为「内容主导」：mp-1 右面板蓝紫渐变兜底、mp-2 金黄 banner 取自封面、mp-8 黄黑波浪——是封面/氛围色，不是 UI 功能色。
4. 当前行高亮强度：约为底色 6–12% 提亮（mp-3 整行粉底、mp-5 反色、mp-6 灰底）。

Rainbow 推荐值：
- 直接继承 Hume：--bg #101113 / --bg-deep #0E0F11 / --bg-raise #141518 / 卡片 rgba(255,255,255,.07)；唯一功能强调 #EE6C2B，总面积 ≤8%（主按钮、active tab、进度填充、now-playing 行、开关 on 态）。
- 新增氛围 token `--ambient`：取当前播放封面平均色（canvas 16×16 采样），以 10–14% 透明度 radial-gradient 仅用于 Now Playing 面板与播放条局部光晕；取色失败兜底 rgba(238,108,43,.10)；氛围色一律不参与文字与控件状态。
- 对比度实测（相对 #101113）：#F5F5F4 ≈ 16.9:1、#A8A6A3 ≈ 7.6:1、#EE6C2B ≈ 6.1:1，全部 ≥4.5:1 达标，成文固化。
- 状态色沿用 Hume 语义并限面积：--ok #34C759 / --warn #E0A800 / --err #E5484D 仅作状态点与错误文字，不做大面积底色。

### 2.3 组件形态

跨作品共性：
1. 圆角节奏跨作品一致：面板/大卡 16–24px、普通卡 12–16px、按钮 8–12px 或胶囊、封面槽 8–12px。
2. 播放主键 40–48px 圆形（mp-1 白圆、mp-3 白圆、mp-8 大白圆）；次级控制 28–36px 幽灵圆钮；全部作品主键都是「页面最大单控件」。
3. 榜单行组件公式：序号列（11–12px 次色等宽数字，hover 时序号↔播放图标互换）+ 40px 封面槽 + 标题/歌手双行 + 时长 + 悬浮操作组（hover 前 opacity 0）。
4. 半透明叠层两种用法：底部半透明播放条（mp-2/3/5）与「封面 + 深色 scrim + 小写字距标签」（mp-6 NOW PLAYING 卡）。
5. 黑胶母题（mp-8）：圆形封面 + 中心孔 + 播放时旋转。

Rainbow 推荐值：
- 继承 Hume 圆角层级 --r-screen 24 / --r-card 16 / --r-ctl 12 / --r-pill 999 与 blur(24–28px) saturate(1.2–1.25) 毛玻璃、1px 内高光代边框。
- Now Playing 大封面：240×240px、圆角 20px、外层 1px var(--brd) 内高光；左上角叠 NOW PLAYING 标签（10.5px/600 大写、字距 1.6px、底 rgba(16,17,19,.55) + blur(8px) 胶囊）——mp-6 同款。
- 新增 shuffle / repeat 钮：32×32 幽灵圆钮（无边框、底 rgba(255,255,255,.06) hover 提亮）；active 态字色 --acc-hi + 底 rgba(238,108,43,.16)。
- 黑胶模式（P2）：播放中大封面叠 conic-gradient 唱纹（rgba(255,255,255,.04) 每 30deg）+ 中心 12px #101113 圆孔 + 外圈 6px 透明环；旋转 10s/圈 linear infinite，暂停 animation-play-state: paused。
- badge 统一规格：高 20px、内边距 3px 8px、11px/500、圆角 999、底 rgba(255,255,255,.08)；音质类 badge.q 字色 --acc-hi、底 rgba(238,108,43,.14)。
- 开关沿用 Hume 46×26 胶囊（on 态橙色圆钮），输入框 12px 圆角暗玻璃。

### 2.4 交互细节

跨作品共性：
1. 当前行高亮三件套（6/8 作品齐备）：行底提亮 + 封面/序号处换暂停图标或 eq 动画 + 标题变强调色。Rainbow 已有（.now-playing + .song-eq + 标题 --acc-hi），是现状最强项。
2. 进度条通用式：静态细轨 4–6px，hover 轨道加粗至 6–8px、把手放大（Spotify/mp-5 模式）；mp-8 以波形替代轨道属内容可视化，非通用件。
3. 播放控制全套 shuffle/prev/play/next/repeat：6/8 作品齐备——Rainbow 现只有 prev/play/next，是最明显缺口。
4. 歌词两种形态：折叠入口（mp-1 LYRICS caret）与独立面板（mp-7 当前句高亮 + 时间戳 + 滚动）。
5. 队列/最近播放：mp-2 侧栏歌单列表（缩略图 + 数量）、mp-6 queue 图标、mp-1 面板内列表。
6. 「悬浮才显操作」原则：榜单行的播放/收藏/加单按钮 hover 时浮现，静态视图只保留信息。

Rainbow 推荐值：
- seek hover：轨 4→6px（现状 background-clip 技巧支持无损过渡）、把手 12→16px、200ms ease。
- 切歌过渡：封面 opacity 0→1 + scale(.96→1)，240ms ease-out（与 player.js 载入时 pb-cover hidden 复位逻辑天然衔接）。
- shuffle/repeat（P1 JS 增量）：shuffle 置换播放队列次序；repeat 双态——单击 audio.loop 单曲循环、双击队列循环；状态点亮同 §2.3。
- 歌词（P2，需后端增量路由）：面板内滚动歌词，当前句 --txt + 600 字重、其余 rgba(245,245,244,.45)、句间滚动 200ms。
- 下载队列：40px SVG 进度环（stroke #EE6C2B 4px、底轨 rgba(255,255,255,.12)）+ 中心百分比 11px tabular——沿用 Hume 文档 P1 规划并落位于 library 下载队列行。
- 表格/矩阵 hover：tr:hover 背景 rgba(255,255,255,.06)、操作组 opacity 0→1 180ms；健康矩阵单元格命中区 ≥28×28px。

### 2.5 字体层级

跨作品共性：
1. 行主标（歌名）14–16px / 500–600 / 近白；行副标（歌手·专辑）12–13px / 400 / 次色；时长与序号 11–12px 等宽数字；分组标题 10–11px / 600 大写 + 1–2px 字距。
2. Now Playing / 详情大标题 20–28px / 700；hero 标题可至 32–40px。
3. 层级只靠「字号 × 字重 × 颜色」三变量，无斜体、无下划线。

Rainbow 推荐值（沿用 Hume 比例，音乐域特化）：
- 行主标 14.5px/600 var(--txt)；行副标 12px/400 var(--txt2)。
- 时长 / 进度 / 序号 / 百分比：11.5px，`font-variant-numeric: tabular-nums`，var(--txt3)——现状截图可见 0:05→3:02 数字跳动，全部时间元素强制等宽（P0 第一条）。
- Now Playing 标题 20px/700、歌手 13px var(--txt2)、专辑行 11.5px var(--txt3)。
- 分组标签（「系统」「最近播放」「NOW PLAYING」「下载队列」）10.5px/600 大写、字距 1.6px、var(--txt3)——现状 .sb-section-label 已一致，成文固化。
- 视图标题沿用 .view-title 20px/700 + .view-sub 12px var(--txt2)。

## 3. 与 Hume 体系的融合取舍

### 3.1 直接继承（Hume 已定，参考作品反向验证有效）

| 项目 | Hume 定值 | 参考作品佐证 |
|---|---|---|
| 近黑炭黑底三层级 | #0E0F11 / #101113 / #141518 + rgba 白卡 | mp-1/2/5/7 深色系全部落在同区间 |
| 单一强调色 + ≤8% 面积 | #EE6C2B（亮橙 #F08A4B 高亮槽） | mp-5 近零彩的黑白灰方案证明「克制单色」路线在音乐域成立 |
| 毛玻璃 + 1px 内高光代边框 | blur(24–28px) saturate(1.2)、rgba(255,255,255,.08) | mp-2 底部半透明条、mp-7 深灰面板同构 |
| 圆角节奏 24/16/12/999 | 屏/卡/控件/胶囊 | 全部作品圆角节奏一致（§2.3 共性 1） |
| 8px 间距节奏 | 卡内 16–20、卡间 12–16 | 跨作品一致 |
| 胶囊开关 46×26 | on 态橙色圆钮 | mp-3/4 开关同形态 |
| 44px 圆形播放主键 | 橙渐变圆 + 光晕 | mp-1/3/8 主键同尺寸档（40–48px） |

### 3.2 吸收借鉴（参考作品带来、Hume 未覆盖）

| 借鉴点 | 来源 | 落位 | 优先级 |
|---|---|---|---|
| 右侧 Now Playing/队列面板 | mp-1 Player 面板 + mp-7 三面板 | 320px 玻璃滑入面板 #np-panel，播放条加 #pb-expand 入口 | P1 |
| NOW PLAYING 悬浮标签卡 | mp-6 | 面板头部：240px 封面 + scrim + 小写字距标签 | P1 |
| 榜单式行卡（表格行改造） | mp-3 Billboard、mp-5 表格 | 歌单详情 table 保结构纯 CSS 行卡化：56px 行 + hover 操作浮现 | P0 |
| shuffle / repeat 全套控制 | 6/8 作品 | #pb-shuffle / #pb-repeat 32px 幽灵钮 | P1 |
| 封面取色氛围 --ambient | mp-2 金黄 banner、mp-1 渐变兜底 | canvas 采样封面均值，仅面板与播放条光晕 | P1 |
| 真实封面接入 | mp-2/3/5 全部用真图 | 后端已有 GET /api/v1/cover/:taskId，本地曲库行 + 播放条优先真图，渐变占位降级 | P1 |
| 歌词 sidecar | mp-7 Lyrics 面板（当前句高亮/时间戳） | 后端 fetchLyric 内核已有、缺对外路由：新增 GET /api/v1/lyric 后面板内滚动歌词 | P2 |
| 黑胶母题 | mp-8（最高热度） | 面板封面 conic 唱纹 + 中心孔 + 10s 旋转，body.is-playing 钩子 | P2 |
| 波形可视化 | mp-8 | WebAudio AnalyserNode，信息价值/成本比最低，远期 | P2 |
| 歌单网格卡 | mp-2 歌单列表（缩略图+数量） | #playlists 网格化（240px 自适应列） | P0 |

### 3.3 明确舍弃（附理由）

| 舍弃项 | 来源 | 理由 |
|---|---|---|
| 浅色主题 | mp-3/4/6 | 双主题维护成本翻倍，且与 Hume「深色沉静」定位冲突；mp-5 的浅色版仅作展示页 |
| 多强调色（蓝紫青粉） | mp-1 流派色、mp-3/4 粉紫 | 破坏 Hume「橙=启用/主操作/进度」单色语义；Rainbow 五平台（kw/kg/tx/wy/mg）需要中性等价呈现，彩色会引入无谓的平台等级暗示 |
| 社交面板（Friends Activity） | mp-4 | Rainbow 是单用户自托管下载器，无社交域，纯装饰性复杂度 |
| 封面横向滚动行 | mp-3 Weekly Top Track | 不符合「搜索 → 勾选 → 下载」主流程的信息密度需求；歌单用网格更利于扫描 |
| 移动端构图 | mp-8 | fpk 部署以桌面 Web 为主场景，只吸收母题（黑胶/波形），不吸收布局 |
| A/B 双播放器对比 | mp-7 | 音乐制作工具特有工作流，与播放器域不符 |

## 4. Rainbow 现状差距分析（逐视图）

> 现状基线：Hume 深色毛玻璃 v1 已全部落地（对比 HUME-DESIGN-BREAKDOWN §3.1 的旧浅灰版，已是迭代后状态）。下表只列「相对 12 张参考图」的残余差距。

| 视图（截图） | 现状要点 | 主要差距 | 对标 |
|---|---|---|---|
| 全局框架（screenshots/main.png） | 232px 毛玻璃侧栏 + 底部播放条 + 最近播放区 | 无 Now Playing 沉浸层；无 shuffle/repeat；时间数字非等宽有跳动 | mp-1/mp-7/mp-2 |
| 发现（screenshots/search.png） | 搜索胶囊条 + 平台分组结果行 + 批量工具条 + 音质 badge | 封面为橙渐变占位；结果行无序号列，缺榜单式扫描感；分组头（酷我 竖线）信息层级弱 | mp-3/mp-5 |
| 本地收藏（screenshots/library.png、screenshots/library-playing.png） | 歌曲行 + eq 动画 + now-playing 高亮（现状最强项） | 下载队列为细条进度，无进度环；时长列 --:-- 缺省无兜底样式；封面占位 | mp-5/mp-7 |
| 歌单（screenshots/playlists.png） | 创建条 + 横条卡 + 详情原生素表格 | 歌单卡未网格化；详情表格无边框去除/行卡化/hover 操作/序号列，是全站最「旧」的视图 | mp-2/mp-5 |
| 设置（screenshots/settings.png） | set-card 玻璃分组 + 46×26 胶囊开关 | 基本达标；命名模板输入未用等宽 code 样式；生成 Key 按钮可升 48px 胶囊 | mp-5 |
| 音源（screenshots/sources.png） | src-card + 版本/状态/描述 + 启用开关 | 每卡 5 行平台×音质 badge 密度过大，应两列换行或折叠；.st 状态 pill 已达标 | mp-7 Tracks |
| 健康（screenshots/health.png） | 矩阵表格 + 发光圆点 + 图例统计 | 基本达标；单元格命中区偏小，可加 ≥28px 与行 hover 提示 | mp-5 表格 |
| 播放条（screenshots/library-playing.png 底部） | 玻璃条 + 44px 橙主键 + 4px seek + 音量条 | 缺 shuffle/repeat；封面盘无旋转/氛围光；无面板展开入口；seek 无 hover 加粗 | mp-1/mp-2/mp-8 |
| 登录（screenshots/login.png） | 深色 + 点阵 + 暖光斑 + 胶囊按钮 + 特性 pill | 达 Hume P2 水准；可选黑胶主视觉锦上添花 | mp-8 |

## 5. UI 优化方案（P0 / P1 / P2）

### 5.0 契约保护红线（所有优先级适用）

1. 不得删除或改名任何现有 id 与 JS 渲染 class（完整清单见附录 A）。
2. 状态 class 语义不可变：.active / .open / .show / .now-playing / .done / .player-open / [hidden]。
3. 新增元素一律用新命名空间：np-*（Now Playing 面板）、pb-shuffle / pb-repeat / pb-expand（播放条增量）。
4. JS 修改仅限增量挂载（新增事件绑定、新增 classList toggle），不改既有函数签名与数据流。
5. 涉及同名 class 双视图复用（.src-card 同时用于歌单与音源页）时，样式改动必须加视图作用域（#view-playlists 下）。

### 5.1 P0：纯 CSS（约 0.5 天，零逻辑风险）

| # | 改造点 | 选择器/做法 | 目标值 |
|---|---|---|---|
| 1 | 时间等宽数字 | .pb-time / .result-dur / .song 行时长 / .queue 百分比 | font-variant-numeric: tabular-nums；11.5px |
| 2 | seek hover 加粗 | .pb-seek:hover | 轨 4→6px、把手 12→16px、200ms ease |
| 3 | 歌单网格化 | #view-playlists #playlists | grid repeat(auto-fill,minmax(240px,1fr)) gap 14px；.src-card 卡式重排（作用域限定） |
| 4 | 歌单详情表格行卡化 | #playlist-detail table（保 table 结构） | tr 高 56px、去内边框、th 10.5px 大写次色、td 垂直居中、tr:hover rgba(255,255,255,.06)、.act 按钮 hover 浮现（opacity 0→1） |
| 5 | 行高统一 | .song-row / .result-row | 56px、内边距 8px 12px |
| 6 | 下载队列错误行 | .queue 内错误文案 | 11.5px / var(--err) 80% 不透明度；重试/删除钮 hover 浮现 |
| 7 | badge 规格对齐 | .badge / .badge.q | 高 20px、3px 8px、11px/500、999 圆角 |
| 8 | 健康矩阵命中区 | .table-wrap td | 内边距加大至 ≥28px 见方、行 hover 提亮 |
| 9 | 设置页细节 | #set-tpl 类输入、apikey 展示 | ui-monospace 等宽 + rgba 白 6% 底 + 8px 圆角 code 样式 |

### 5.2 P1：结构增量（1–2 天）

| # | 改造点 | 做法 | 契约影响 |
|---|---|---|---|
| 1 | 右侧 Now Playing 面板 | 新增 aside#np-panel（320px、毛玻璃 blur(28px)、translateX(100%)↔0）；头部 = mp-6 式 240px 封面卡 + NOW PLAYING 标签 + 标题 20px/700 + 歌手 13px；下方 #np-queue 队列列表（渲染语系复用 .sb-recent-item）；#pb-expand 入口钮挂播放条右端；body.np-open 时 main padding-right 336px；<1280px 媒体查询隐藏入口 | 纯新增 id；player.js 增量同步标题/封面/队列 |
| 2 | shuffle / repeat | .pb-controls 内插入 #pb-shuffle / #pb-repeat（32×32 幽灵圆钮，active = --acc-hi + rgba(238,108,43,.16) 底）；shuffle 洗牌队列、repeat 单击 audio.loop / 双击队列循环 | 新增 id + 两个事件绑定 |
| 3 | 封面取色氛围 | player.js 封面 load 时 canvas 16×16 缩采样均值 → body.style.setProperty('--ambient', 'r,g,b')；仅 #np-panel 背景光晕与 .player-bar 底部微光引用；失败兜底 rgba(238,108,43,.10) | 纯增量；CSS 变量消费 |
| 4 | 真实封面 | library.js song-cover 与播放条 pb-cover 优先 img src=/api/v1/cover/:taskId，onerror 降级现状渐变占位 | 渲染模板增量；路由已存在 |
| 5 | 下载进度环 | library 队列行 40px SVG 环（r16、stroke 4px、--acc 描边、中心 % 11px tabular），失败态环变 --err | 渲染模板增量 |
| 6 | 封面切歌过渡 | @keyframes coverIn（opacity 0→1 + scale .96→1）240ms ease-out 应用于 .pb-cover / 面板封面 | 纯 CSS |

### 5.3 P2：氛围增强（可选，按需排期）

| # | 改造点 | 做法 | 备注 |
|---|---|---|---|
| 1 | 黑胶模式 | player.js 增 body.is-playing 一行 toggle；#np-panel 封面播放态：conic 唱纹 + 12px 中心孔 + 10s/圈旋转、暂停 play-state:paused | mp-8 母题 |
| 2 | 歌词 sidecar | 后端新增 GET /api/v1/lyric?platform=&id=（复用 core/adapters/metadata 的 fetchLyric）；#np-panel 歌词区当前句 --txt/600、其余 45% 白、200ms 滚动 | mp-7；唯一需后端改动项 |
| 3 | 侧栏窄图标模式 | body.sidebar-compact 时 232→72px、.tab span 隐藏、图标居中；data-tab 不动 | mp-6 |
| 4 | 登录页黑胶主视觉 | 背景右下角大半圆黑胶 + 橙光晕，静止不旋转 | mp-8 |
| 5 | 波形/频谱可视化 | WebAudio AnalyserNode 32 柱频谱入面板头部 | mp-8；远期 |

## 6. 可直接执行的改造提示词

> 使用方式：将下面整段 prompt 原样交给实现代理（建议按 P0 → P1 → P2 分三次投喂，本段为全集）。

```text
将 Rainbow 音乐播放器 Web（web/style.css、web/index.html、web/js/）按以下规范做 UI 升级。硬性前提：保留全部现有 DOM id 与 JS 渲染 class 及其语义（.active/.open/.show/.now-playing/.done/.player-open/[hidden]），新增元素一律用 np-*、pb-shuffle、pb-repeat、pb-expand 等新命名，禁止删除或改名现有节点与事件绑定；.src-card 在歌单页与音源页复用，样式改动必须限定在 #view-playlists 作用域内。

【设计 token】背景三层 #0E0F11/#101113/#141518，卡片 rgba(255,255,255,.07) + backdrop-filter blur(24px) saturate(1.2) + 1px 内高光 rgba(255,255,255,.08) 代边框；唯一强调橙 #EE6C2B（高亮槽 #F08A4B），面积 ≤8%，只用于主按钮/active 导航/进度填充/当前播放行/开关 on 态；文字 #F5F5F4 主、#A8A6A3 次、#6E6C69 注；状态色 #34C759/#E0A800/#E5484D 仅作状态点与错误文字；圆角 24/16/12/999 四级；间距 8px 节奏；新增 --ambient 变量（封面取色，10–14% 透明度，只用于氛围光晕）。字体：-apple-system/PingFang SC；行主标 14.5px/600、行副标 12px/400 次色、时间序号百分比一律 11.5px + font-variant-numeric: tabular-nums、分组标签 10.5px/600 大写字距 1.6px、Now Playing 标题 20px/700。

【组件规格】曲目行高 56px（内边距 8px 12px），hover 背景 rgba(255,255,255,.06)，操作按钮 hover 才浮现（opacity 0→1、180ms）；badge 高 20px/内边距 3px 8px/11px/500/胶囊，音质 badge 字色 #F08A4B 底 rgba(238,108,43,.14)；开关 46×26 胶囊 on 态橙钮；主播放键 44px 橙渐变圆 + 0 6px 18px rgba(238,108,43,.4) 光晕；shuffle/repeat 为 32×32 幽灵圆钮，active 态字色 #F08A4B + 底 rgba(238,108,43,.16)；进度 seek 静态 4px 轨、hover 轨 6px 把手 12→16px（200ms ease）；下载进度 40px SVG 环（r16 stroke 4px 橙描边、中心百分比 11px 等宽，失败态换红描边）；Now Playing 封面 240×240 圆角 20px + 1px 内高光，左上角叠 NOW PLAYING 胶囊标签（10.5px 大写字距 1.6px、底 rgba(16,17,19,.55)+blur(8px)）。

【逐视图改造清单】1) 全局：.pb-time 等全部时间元素 tabular-nums。2) 发现页：结果行统一 56px；行封面保持占位渐变（真实封面仅本地库接入）。3) 本地收藏：song-row 56px；下载队列行加 40px SVG 进度环替换细条，错误文案 11.5px 红色 80% 不透明度；封面改用 /api/v1/cover/:taskId 真图（onerror 降级渐变）。4) 歌单页：#playlists 网格 repeat(auto-fill,minmax(240px,1fr)) gap 14px；详情 table 保持结构纯 CSS 行卡化——去内边框、th 改 10.5px 大写次色、tr 高 56px、.act 按钮 hover 浮现、tr:hover 提亮。5) 设置页：命名模板与 Key 展示区用 ui-monospace 等宽 + rgba 白 6% 底 8px 圆角 code 样式。6) 音源页：.src-plats 内 badge 两列 flex wrap 布局降密度。7) 健康页：td 命中区加大至 ≥28px、行 hover 提亮。8) 播放条：.pb-controls 前后插入 #pb-shuffle/#pb-repeat（32×32，行为：shuffle 洗牌播放队列；repeat 单击 audio.loop、双击队列循环，active 点亮）；右端加 #pb-expand 展开钮；封面切歌 opacity+scale 240ms 过渡。9) 新增 aside#np-panel 右侧面板：宽 320px、blur(28px) 毛玻璃、translateX 滑入；头部 mp-6 式封面卡 + 标题歌手；身体 #np-queue 播放队列列表（条目 = 40px 封面槽 + 双行文字 + 当前项橙色高亮）；body.np-open 时 main 右 padding 336px；<1280px 隐藏展开入口；面板背景加 radial-gradient(var(--ambient)) 光晕，--ambient 由 player.js 在封面加载时用 16×16 canvas 采样均值写入 body，失败用 rgba(238,108,43,.10)。10) P2 可选：player.js 播放态 toggle body.is-playing，面板封面播放时叠 conic 唱纹 + 12px 中心孔 + 10s/圈旋转、暂停停止；后端新增 GET /api/v1/lyric（复用 fetchLyric）后面板加滚动歌词（当前句白色 600、其余 45% 白、200ms 滚动）。

【验收标准】① 全部现有功能回归无 JS 报错：登录、搜索（含分组/全选/批量下载/加入歌单）、本地收藏播放、歌单创建/查看/删除、设置保存、音源导入/开关/删除、健康冒烟矩阵、SSE 状态点。② 旧 id/class 在 DOM 中全部可检索（对照 index.html 与 js/pages/*.js 渲染模板）。③ 时间数字不再横向跳动（tabular-nums 生效）。④ 歌单详情表格在 ≥56px 行高下无换行溢出，操作钮 hover 浮现。⑤ 播放条五个控制键（shuffle/prev/play/next/repeat）可见且 shuffle/repeat 可点亮。⑥ Now Playing 面板在 ≥1280px 屏可展开/收起，队列当前项高亮，封面氛围色生效；<1280px 无入口且布局不破。⑦ 深色对比度：正文 ≥4.5:1，橙色仅出现在规定控件。⑧ 改动不引入新依赖、不修改 server 端既有路由（/api/v1/lyric 为 P2 例外项需单独确认）。
```

## 附录 A：DOM 契约保护清单（改造时逐项对照）

静态 id（index.html，66 个）：sidebar、sb-recent-label、sb-recent、sse-dot、logout-btn、sb-backdrop、nav-toggle、view-search、search-form、keyword、search-type、platform、quality、search-toolbar、check-all、selected-count、batch-download、batch-add-playlist、search-status、results、view-library、refresh-library、play-all、library-summary、library-songs、library-queue、queue-summary、library-queue-list、view-playlists、new-playlist-name、create-playlist、refresh-playlists、playlists-summary、playlists、playlist-detail、view-settings、settings-body、view-sources、src-url、src-url-name、src-url-btn、src-file、src-file-btn、refresh-sources、sources-summary、sources、view-health、run-smoke、refresh-health、health-summary、health-matrix、player-bar、pb-cover、pb-title、pb-artist、pb-prev、pb-toggle、pb-next、pb-cur、pb-seek、pb-fill、pb-dur、pb-voltrack、pb-volfill、pb-close、pb-audio、toast。

JS 渲染 class（js/main.js 与 js/pages/*.js 模板）：.tab[data-tab] + .active、.view.active、.sidebar.open、.sb-backdrop.show、.nav-toggle.open、body.player-open、.player-bar.open、.sb-recent-item / .sb-recent-cover / .sb-recent-meta、.empty、.lib-empty / .lib-empty-icon / .lib-empty-sub、.song-list / .song-row / .song-cover / .song-note / .song-eq / .song-play / .song-warn、.now-playing（song-row 状态）、.badge / .badge.q、.result-chk / .result-cover / .result-info / .result-name / .result-artist / .result-dur / .result-right、.row-dl（+ .done）、.src-card / .src-head / .src-act / .src-desc / .src-err / .src-plats、.st（+ ready/canceled 等状态类）、.danger-lite、.switch、.set-card / .set-row / .hint、.table-wrap（table/thead/th/td/.act）、.hdot（.green/.yellow/.red/.hdot-sm）、.ic-play / .ic-pause（hidden 切换表达播放态）、.pb-seek-fill / .pb-thumb（含 aria-valuenow 联动）。

允许新增的命名空间：#np-panel、#np-cover、#np-title、#np-artist、#np-queue、#np-close、#pb-expand、#pb-shuffle、#pb-repeat、body.is-playing、body.np-open、body.sidebar-compact、--ambient。

## 附录 B：证据与出处

- 12 张参考图逐张目测取值：本目录 research/mp-1 至 mp-8（文件名见 §1 索引表）。
- Rainbow 现状：docs/screenshots/ 9 张视图截图 + web/index.html（263 行，DOM 契约源头）+ web/style.css（1010 行，token 现值）+ web/js/（main/player/pages 渲染模板）。
- 服务端能力核对：server/src/routes/cover.ts 存在 GET /api/v1/cover/:taskId（真实封面可接）；歌词仅有 core/adapters/metadata 的 fetchLyric 内核用于下载嵌入与冒烟，无对外路由（歌词 sidecar 需 P2 增量）。
- 基准体系：HUME-DESIGN-BREAKDOWN.md（本目录）。
