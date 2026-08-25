# Rainbow × design-md 品牌系统精修审计（DESIGN-MD-AUDIT）

> 任务 #48：应用 74 品牌设计系统库（awesome-design-md/skills/design-md）对 Rainbow 前端做一轮克制精修。
> 原则：**映射表先行、单橙身份与既有 Hume token 命名不变、只吸收做得更好的细节、id/class 契约零破坏**（契约红线见 MUSIC-PLAYER-UI-GUIDE §5.0 / 附录 A）。
> 基线：Hume 深色毛玻璃体系（#101113 底 / 单橙 #EE6C2B / blur(24–28px) / 圆角 24/16/12/999 / 8px 节奏），P0–P2 已全部落地。

## 1. 选型理由

| 品牌 | 角色 | 一句话理由 |
|---|---|---|
| **Spotify**（主对标，全文精读） | 深色音乐播放器，与 Rainbow 同域 | 其 elevation 分层（卡片 vs 浮层重阴影）、行 hover 规范、文本层级（#b3b3b3 secondary ≈7.2:1）、focus/滚动条规格与 Rainbow 逐项直接可比，是唯一「同题型」参考 |
| **Linear.app**（辅，浏览提取） | 深色产品 UI 工程化标杆 | 四层 ink 文本体系（meta 用亮层、tertiary 只做 disabled/footnote）佐证「数据文本提亮」决策；focus ring 50% 透明度的轻量环 |
| **Vercel**（辅，浏览提取） | 几何与 elevation 克制标杆 | stacked shadow（多层小偏移叠加 + inset ring）哲学——单层重投影改为「贴面层 + 扩散层」双层，深色系下更「工程感」 |

## 2. 映射表（Spotify → Rainbow/Hume → 决策）

> S = Spotify，L = Linear，V = Vercel。「已同构」= 双方规格本就一致，零改动。

| # | 来源 | 品牌规格 | Rainbow/Hume 现状 | 决策 |
|---|---|---|---|---|
| S1 | Spotify §6 | Elevation 两级：卡片 `rgba(0,0,0,.3) 0 8px 8px`；浮层 `rgba(0,0,0,.5) 0 8px 24px`（Dialog 级） | 单一 `--shadow-float: 0 8px 24px rgba(0,0,0,.35)`，静态卡片与 modal/toast 浮层共用同一档 | **采纳（改造）**：拆两级——新增 `--shadow-card`（卡片轻档）；`--shadow-float` 升至 `0 12px 32px rgba(0,0,0,.42)`（浮层重档，对齐 Spotify Dialog 量级）。卡片基元（.toolbar/.import-block/.src-card/.set-card/.table-wrap/.search-bar）改 card 档；.modal 因有遮罩叠底属浮层，单独保 float 档 |
| S2 | Spotify §2/§6 | 输入框 inset border-shadow 组合（`rgb(18,18,18) 0 1px 0, rgb(124,124,124) 0 0 0 1px inset`），recessed 触感 | input 仅 1px border，无内凹光影 | **采纳**：input/select 加 `inset 0 1px 3px rgba(0,0,0,.18)` 顶部内凹（保留现有 focus 橙环体系，focus 时 ring 自然覆盖内凹） |
| S3 | Spotify §4 | 卡片 hover = 轻微背景提亮 | `.src-card:hover → var(--card-hi)`、行 hover `.08` 提亮 ✓ | **已达标**，不动 |
| S4 | Spotify §4 | 控件按压反馈 | 全局 `button:active → scale(.97)` ✓；但 `.sb-nav .tab` 是 `<a>` 不继承 | **补齐**：`.sb-nav .tab:active → scale(.98)` |
| S5 | Spotify §4 | 当前播放行：行底提亮 + 歌名变品牌色 | 橙渐变行底 + 发光描边 + 歌名橙 + eq 三柱动画三件套 | **不采纳（现状更强）**：GUIDE §2.4 认定三件套为现状最强项，降级到 Spotify 式弱高亮属倒退 |
| S6 | Spotify §2/§9 | Secondary 文本 `#b3b3b3`（对 #121212 ≈7.2:1）；**时长/序号与歌手同为 secondary 层级** | `--txt3: #6E6C69`（≈3.5:1）同时承担时长/序号/百分比数据与 hint/占位/禁用 | **采纳（微调）**：时间/时长/序号/百分比纯数据类（.pb-time/.song-dur/.result-dur/.pd-num/.np-item-num/.progress-txt）升 `var(--txt2)`（7.9:1）；txt3 保留 hint/分组标签/占位用途。佐证：Linear 四层 ink 体系中 meta/数据用 #8a8f98 亮层，最深 #62666d 只做 disabled/footnote（L1） |
| S7 | Spotify §3 | 字重二元对比：700/400 为主，600 少用 | Hume 550/600 中间字重体系 | **不采纳**：中文 PingFang 700 视觉过重，550/600 是 Hume 既定层级且已成契约风格 |
| S8 | Spotify §9 | 滚动条细轨 | webkit 9px 轨 + 2px 透明边（视觉 5px 细轨）✓；Firefox 无适配 | **采纳（渐进增强）**：`html` 补 `scrollbar-width: thin; scrollbar-color` |
| S9 | Spotify §4 | focus：outline 统一规格 | `:focus-visible { outline: 2px solid var(--acc-hi); outline-offset: 2px; border-radius: 4px }` | **采纳（修正缺陷）**：移除 `border-radius: 4px`——该值会覆盖控件自身圆角（胶囊/圆形钮聚焦时焦点环变方角）；outline 色改 `rgba(240,138,75,.9)` 微透（L2 借鉴，实心改 90% 更轻） |
| S10 | Spotify §3 | 按钮大写 + 1.4–2px 字距 | 中文按钮（无大写概念）；分组标签已 10.5px/600 大写 + 1.6px 字距 | **不采纳**：中文域不适用 uppercase；分组标签体系已吸收同一理念 |
| S11 | Spotify §4 | Pill 500–9999px / 圆形 50% 几何 | `--r-pill: 999px` 胶囊钮 / 圆形钮 50% ✓ | **已同构**，不动 |
| S12 | Spotify §2/§7 | 播放键 heavy 阴影「高级音频设备质感」；深色底阴影必须重才可见 | `.pb-main: 0 6px 18px rgba(238,108,43,.4) + inset 高光`（基础达标） | **采纳（增强）**：叠 `0 1px 2px rgba(0,0,0,.32)` 贴面层（V1 stacked）；hover 光晕增幅 .4→.55 + 扩散 18→26px |
| S13 | Spotify §1 | 近黑三层底 #121212/#181818/#1f1f1f | #101113/#0E0F11/#141518 ✓ | **已同构**，不动 |
| S14 | Spotify §1/§7 | 唯一功能色（绿仅 play/active/CTA） | 单橙 #EE6C2B ≤8% 面积 ✓ | **已同构**，身份保持不动 |
| S15 | Spotify §5 | 卡片圆角 6–8px（紧凑） | Hume `--r-card: 16px` 四级圆角契约 | **不采纳**：24/16/12/999 圆角节奏是 Hume 体系核心契约，毛玻璃大圆角与之配套 |
| L1 | Linear | 四层 ink 文本体系（meta 亮层 / tertiary 仅 disabled） | 三层 txt（txt3 兼具 meta + footnote） | **采纳（并入 S6）**：数据文本升 txt2 即本条落地 |
| L2 | Linear | focus ring 2px @ 50% opacity | 2px 实心 | **采纳（并入 S9）**：outline 90% 不透明度 |
| V1 | Vercel | stacked shadow：多层小偏移叠加 + inset ring，忌单层重投影 | 单层投影 | **采纳（并入 S1/S12）**：`--shadow-card` 与 `.pb-main` 均为双层结构 |
| V2 | Vercel | 几何克制：方角与 pill 按场景分离 | 四级圆角体系 ✓ | **已达标**，不动 |

## 3. 实施清单（纯 CSS，仅 web/style.css）

| # | 改动 | 涉及选择器/位置 |
|---|---|---|
| 1 | 新增 `--shadow-card` 双层卡片档；`--shadow-float` 升为浮层档 | `:root` token 区 |
| 2 | 卡片基元阴影 float → card；`.modal` 单独保 float（浮层例外） | 基元组 + .modal |
| 3 | `.search-bar` 阴影 float → card | .search-bar |
| 4 | focus-visible 移除 `border-radius: 4px`；outline 色微透 90% | `:focus-visible` |
| 5 | input/select 加 inset 顶部内凹（recessed）；transition 增 box-shadow | input 基础规则 |
| 6 | 数据文本提亮 txt3 → txt2：.pb-time / .song-dur / .result-dur / #playlist-detail .pd-num / .np-item-num / .queue-sub .progress-txt | 六处数据类 |
| 7 | `.pb-main` 叠贴面层；hover 光晕增幅 | .pb-main / .pb-main:hover |
| 8 | `.sb-nav .tab:active` 按压反馈 | .sb-nav .tab 区 |
| 9 | Firefox 滚动条渐进增强 | `html` |

> 零 HTML/JS 改动；未新增/改名/删除任何 id/class；`.dl-ring-pct` 实测已是 txt2 无需改动。

## 4. 明确未采纳项汇总

| 项 | 理由 |
|---|---|
| 当前播放行降级为 Spotify 式弱高亮（S5） | Rainbow 三件套（行底渐变+发光描边+eq）更强，GUIDE 认定最强项 |
| Bold/regular 二元字重（S7） | 中文 PingFang 700 过重；Hume 550/600 既定契约 |
| uppercase 按钮字距（S10） | 中文无大写；分组标签已吸收该理念 |
| 6–8px 紧凑卡片圆角（S15） | 与 Hume 四级圆角契约冲突 |
| Spotify 绿 / Linear 薰衣草 / Vercel 网格渐变等任何第二强调色 | 单橙身份铁律（UI GUIDE §2.2 跨作品共性 2：强调色克制） |
| 浅色主题 / 多彩流派标签 | UI GUIDE §3.3 已明确舍弃，本轮不复议 |

## 5. 验证结果

| 验证项 | 方法 | 结果 |
|---|---|---|
| CSS 直出 | `curl /style.css` 与本地文件 byte 级 diff | **IDENTICAL**（69574 bytes）；6 条新特征串（--shadow-card/--shadow-float 新值/scrollbar-width/focus rgba(240,138,75,.9)/input inset/tab:active）全部直出 ✓ |
| JS 语法 | `node --check` web/js/*.js + pages/*.js + login.js | 全部通过（本轮零 js 改动，防御性确认）✓ |
| 契约零破坏 | 改动 diff 审计 | 仅样式值替换 + 两条既有选择器增量规则（.modal 浮层覆盖、.sb-nav .tab:active）；无任何 id/class 新增改名删除 ✓ |
| CDP 走查 console | headless Chrome + 裸 CDP（1440×900），监听 console error + exceptionThrown | 登录页 / 本地收藏播放态 / np 面板（歌词 45 行 + 当前句高亮）/ 设置页（6 张 set-card）四视图 **0 error / 0 exception** ✓ |
| CSS 实际生效 | computed style 断言 | 6/6 通过：shadow-card 双层、卡片非 float 档、#keyword inset 内凹、.pb-main 三层 stacked、.pb-time = rgb(168,166,163)（txt2）、:focus-visible 无 border-radius 覆盖 ✓ |
| 截图覆盖 | CDP 真实点击播放「十年」+ seek | library-playing.png（本地收藏+播放态+np 面板歌词）、now-playing-lyric.png（发现视图+副歌当前句高亮）、settings.png 均已覆盖 docs/screenshots/ ✓ |
| 服务保持 | 全程未触碰 PID 5018（node dist/index.js :23330） | 运行中 ✓ |

> 备注：验证脚本 clickSelector 增加了 scrollIntoView 兼容（长列表中部行在视口外时点击无效），与产品代码无关。

## 6. 结论

本轮为「克制精修」：9 项改动全部落在 web/style.css，其中 2 项为缺陷修正（focus-visible 圆角覆盖、数据文本对比度）、7 项为规格升级（两级 elevation、recessed 输入、stacked 播放键、按压反馈、Firefox 滚动条等）。Hume 单橙身份、token 命名、三级圆角、8px 节奏、全部 DOM 契约未动。
