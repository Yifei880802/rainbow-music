# Hume 设计语言拆解与 Rainbow Web 适配提示词

> 素材来源：Dribbble「Hume – Mobile App Design for Smart Home」(Phenomenon Studio)
> 素材：本目录 7 张截图 hume-header / hume-description / hume-shot-1..5
> 用途：提炼可量化参数，形成可直接投喂 AI 的 Rainbow Web UI 改造提示词。
> 说明：页面未提供官方色板/字体标注，以下参数均为原图目测估值（以 390pt 屏为基准）。

## 0. 设计语言总览

一句话定位：「calm、human、intuitive」的深色毛玻璃智控体验——炭黑氛围 + 暖灰玻璃卡片 + 单一橙色强调，用「低对比氛围、高对比交互」表达专注。

五个关键词：深色沉静 / 毛玻璃卡片 Glassmorphism / 单一橙色强调 / 大圆角胶囊 / 摄影氛围

## 1. 五维拆解

### 1.1 色彩系统（HEX 估值）
- 主背景 #0E0F11–#141518 近黑炭黑；展示背景 #4A4A48–#575653 暖深灰（模糊摄影底）
- 深色卡片 rgba(255,255,255,.06–.12) 叠深底呈 #232426–#2C2D30；浅玻璃卡 rgba(255,255,255,.30–.45)
- 强调橙 #E8622C/#EE6C2B（主按钮/开关on/滑杆/Live）；亮橙 #F08A4B（CTA 内圆形图标槽）
- 主文字 #F5F5F4；次文字 #A8A6A3；禁用 #6E6C69；状态绿 #34C759（极少量）
- 无硬边框：1px 内高光 rgba(255,255,255,.08) + 背景模糊 区分卡片
- 语义：橙=开启/启用/主操作/进度；灰=关闭/次要；绿/红仅状态点

### 1.2 排版与字体
- 无衬线（SF Pro/Inter/Manrope 观感），中文对应 PingFang SC
- 层级：大标题 28–32px/600–700；卡片标题 17–20px/600；正文 13–15px/400；注释 11–12px 次色
- 比例（以 14px 为基准）：大标题≈2.2×、卡题≈1.3×、注释≈0.8×；行高 1.3–1.5
- 小大写标签（PROJECT/INDUSTRY）字距 1–2px；字重对比 600 vs 400，靠字号+颜色分层

### 1.3 布局与栅格
- 单列卡片流 + 等宽双列网格（Wi-Fi/Cameras 等）
- 8px 节奏：屏边距 20–24；卡间距 12–16；卡内边距 16–20；组件间距 8–12
- 圆角层级：屏级 24–28；卡片 16–20；控件/输入 12–14；胶囊 999；图标容器 10–14
- 毛玻璃：backdrop-filter: blur(20–30px) saturate(1.2)；底 rgba(20,20,22,.55) 或 rgba(255,255,255,.08)
- 阴影克制：浮层 0 8–24px rgba(0,0,0,.35)；主要靠内高光+模糊分层

### 1.4 图标与组件
- 图标：1.5–1.75px 描边圆头线性，白/次色；活动图标入 40–44px 毛玻璃圆角方
- 开关（签名式）：胶囊轨 46×26–51×30；off=rgba(255,255,255,.12)轨+灰钮；on=暗轨+橙色实心圆钮
- 滑杆：4px 轨 rgba(255,255,255,.15)，已填橙；钮 20–24px 橙色实心圆
- 进度：刻度尺条+白色指示块（Energy/Storage），非传统实心进度条
- 主 CTA：56–60px 橙色胶囊，左亮橙圆形图标槽，右「>>>」箭头引导
- 分段控件：毛玻璃胶囊容器，选中项更亮玻璃+白字（Warm/Neutral/Cold）
- Chip 胶囊：带线性图标的玻璃小标签（21.2°C / Locked / 71%）
- 列表行：12–16px 圆角行卡，左标题+副、右开关/箭头；底部场景栏玻璃+选中亮块

### 1.5 图片与氛围
- 真实摄影/建筑渲染作背景，压暗+模糊+渐变遮罩后置，保证文字可读
- 3D 产品渲染作详情页视觉主体（射灯/智能锁/音箱）
- 氛围元素：星点粒子（Night）、橙色发光环（指纹/语音球）、暖色光斑
- 展示层：点阵 dot-grid 纹理、大模糊背景、手机 mockup

## 2. 通用提示词模板

### 2.1 中文版
设计一个智能控制风格的深色 UI 设计系统：页面背景为近黑炭黑 #101113；所有卡片使用暖灰毛玻璃（rgba(255,255,255,.08) + backdrop-filter: blur(24px)），圆角 16–24px，以 1px 内高光 rgba(255,255,255,.08) 代替边框；唯一强调色为橙 #EE6C2B，仅用于主按钮、开启态开关、滑杆已填充与关键数据；文字近白 #F5F5F4、次要暖灰 #A8A6A3；无衬线字体（Inter / PingFang SC），大标题 28–32px/600、卡片标题 17–20px/600、正文 13–15px/400、注释 11–12px；图标为 1.5px 圆头线性；开关为胶囊形、开启时橙色大圆钮；主 CTA 为 56px 橙色胶囊按钮、左侧亮橙圆形图标槽；间距遵循 8px 节奏（卡内边距 16–20、卡间距 12–16）；背景可用压暗模糊的真实摄影或点阵纹理；整体氛围 calm、human、intuitive。

### 2.2 English Version
Design a calm smart-control dark UI system: near-black charcoal background #101113; cards are warm-gray glassmorphism (rgba(255,255,255,.08) + backdrop-filter: blur(24px)), radius 16-24px, 1px inner highlight rgba(255,255,255,.08) instead of borders; single accent orange #EE6C2B reserved for primary CTAs, active switches, slider fills and key data;
text near-white #F5F5F4, secondary warm gray #A8A6A3; sans-serif type (Inter / SF Pro), display 28-32px/600, card title 17-20px/600, body 13-15px/400, caption 11-12px; icons 1.5px rounded line style; pill switches with a big orange round knob when on;
primary CTA = 56px orange pill button with a lighter-orange circular icon slot on the left; 8px spacing rhythm (card padding 16-20, gaps 12-16); optional blurred darkened photo or dot-grid backdrop; overall mood: calm, human, intuitive.

## 3. Rainbow 适配提示词

### 3.1 现状诊断（web/style.css、index.html、js/pages/）
浅灰 #f5f6f8 底 + 白卡 + 1px #e6e8ec 边 + 8px 圆角；主色蓝 #1f6feb；表格承载信息（搜索结果/任务/健康矩阵）；原生 checkbox；6px 蓝色进度条；emoji 状态点。差距：明暗相反、蓝 vs 橙、表格 vs 卡片、原生控件 vs 玻璃组件。

### 3.2 逐页改造要点
- 全局 tokens：--bg:#0F1012; --card:rgba(255,255,255,.07); --brd:rgba(255,255,255,.08); --acc:#EE6C2B; --txt:#F5F5F4; --txt2:#A8A6A3; --r-card:16px; --r-ctl:12px；替换全部 #1f6feb；白卡→毛玻璃。
- 登录页：深色渐变背景 + 居中 24px 圆角毛玻璃卡；标题近白；登录钮橙色胶囊。
- 搜索页：搜索栏改毛玻璃胶囊容器；select 暗色化；结果表格→歌曲卡片行（左标题+歌手、右音质 pill）；badge 改橙色玻璃 pill；批量工具条玻璃条。
- 任务页：表格→任务卡片列表；6px 进度条→40px 橙色进度环（中心 % 文本）或 4px 橙细条；.st 状态改玻璃 pill+状态点；SSE 点加发光。
- 歌单页：歌单 2 列玻璃网格卡；详情歌曲行卡；操作钮小玻璃钮。
- 音源页：src-card 玻璃化；启用 checkbox→橙色胶囊开关；平台 badge 中性 pill；删除红字暗底。
- 设置页：set-card 分组玻璃卡；全部 checkbox→橙色胶囊开关；input/select 暗玻璃 12px 圆角；APIKey code 块深色等宽玻璃；danger 按钮红字暗底。
- 健康页：矩阵 emoji→发光圆点（绿 #34C759 / 橙 #E0A800 / 红 #E5484D + box-shadow 发光）；表格行改深色行卡。
- 导航 header：深色毛玻璃 sticky 顶栏；active tab 橙字+玻璃胶囊底；登出红字。

### 3.3 可直接执行的改造提示词（投喂 AI 编码工具）
将 Rainbow 音乐下载 Web（web/style.css 与 js/pages/*.js 渲染模板）改造为 Hume 式深色毛玻璃设计，保留全部 DOM id 与 JS 逻辑：1) 全局 CSS 变量 --bg:#0F1012; --card:rgba(255,255,255,.07); --brd:rgba(255,255,255,.08); --acc:#EE6C2B; --txt:#F5F5F4; --txt2:#A8A6A3; --r-card:16px; --r-ctl:12px；body 用 --bg/--txt。2) 所有 #1f6feb 替换为 var(--acc)；白底边框卡（.toolbar/.src-card/.set-card/.import-block/.modal）改 var(--card)+backdrop-filter:blur(20px)+1px var(--brd)+var(--r-card) 圆角。
3) 表格行 tr 改卡片式行（圆角 12、hover 提亮背景）。4) 任务进度改 40px SVG 进度环、橙色描边、中心 % 文本。5) 开关型 checkbox（音源启用/设置启用）改 46×26 胶囊开关、on 态橙色圆钮。6) 主按钮（.search-bar button、#set-save、登录钮）改 48px 橙色胶囊 radius 999。7) .st 状态改半透明 pill；健康矩阵 emoji 改发光圆点。8) 字体层级：h1 20/600、卡题 16/600、正文 13–14/400、注释 11–12 次色。

## 4. 落地优先级
- P0（仅改 style.css，约 1–2h）：深色底 + 橙色强调 + 毛玻璃卡片 + 开关/按钮胶囊化 + 圆角层级；零逻辑风险，立即统一气质。
- P1（模板微调，约 0.5–1d）：任务列表卡片化 + 进度环、状态 pill、搜索结果卡片化、健康点发光；涉及 tasks.js/search.js/health.js 渲染模板。
- P2（氛围增强，可选）：登录页摄影氛围、毛玻璃 sticky 导航、点阵纹理背景、封面渐变装饰。

## 附：素材索引
- shot-1 Dashboard 主屏；shot-2 Night mode+Scene Builder；shot-3 CCTV+History；shot-4 设备详情+智能锁；shot-5 实时总览+语音球；header 标题页；description 描述拼贴。
