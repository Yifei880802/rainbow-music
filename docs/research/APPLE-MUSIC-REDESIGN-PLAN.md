# Rainbow × Apple Music 首页改版规划（APPLE-MUSIC-REDESIGN-PLAN）

> 任务 #59 · 调研实测 + 规划文档（零产品代码改动；临时实测脚本测完已删除；不执行 git；未触碰 23330 服务——实测时发现该端口实际无监听，降级链路改用上游端点直测，见 §4.4）。
> 布局参考：Apple Music「新发现」桌面页截图（左导航 + 横幅卡 + 网格卡 + 列表分区 + 底部播放条）。
> 视觉约束：Hume 体系不可变项（`#101113`/`#EE6C2B`/blur 24/圆角 24-16-12/8px 节奏，`HUME-DESIGN-BREAKDOWN.md` §1.1/§3.2 定值）；契约红线遵循 `MUSIC-PLAYER-UI-GUIDE.md` §5.0（静态 id 只增不改名不删除）。
> 关联文档：`SPOTIFY-REDESIGN-PLAN.md`（#49，顶栏搜索 pill/网格卡等裁决可复用，本文引用不重复论证）；#60 为本文 P0 的实施任务。

---

## 1. 现状与目标

### 1.1 现状（实测基线）

| 维度 | 现状 | 代码出处 |
|---|---|---|
| 默认首页 | 「发现」tab = 跨平台搜索页（keyword 输入 + 平台/音质选择 + 结果列表） | index.html `#view-search`（class `active`）；main.js showTab |
| 本地收藏 | 第二 tab：双视图（网格默认/列表）+ 歌曲/专辑/艺人三维度聚合 + drill + 排序筛选密度（#53/#56/#57 全量落地） | web/js/pages/library.js（942 行） |
| 侧栏结构 | 发现 / 本地收藏 / 歌单 / 设置 + 系统组（音源/健康）+ 最近播放 + 品牌区（音符 logo + "Rainbow 音乐播放器"） | index.html `.sb-nav` / `.sb-brand` |
| 后端能力 | search 五端点 + download + tasks + playlists + sources + settings + SSE；**无任何榜单/推荐内容端点**（#49 §0.3 已确认） | API.md |
| 平台适配器 | `server/src/core/adapters/{wy,tx,kg,kw,mg}/`：musicSearch（搜歌）+ songList（搜歌单/详情）+ lyric + pic | 各目录 |

**首页问题**：默认落地是「空搜索框」，新用户/打开即用性差（AM 范式是「打开即内容」——榜单卡网格直接可点可播）。搜索是主动行为，不应占据首页心智位。

### 1.2 目标

「发现」tab 从搜索页升级为**热门歌单聚合页**（下称**首页**）：打开即呈现各平台官方热歌榜单卡（大封面网格），点卡进歌单详情页（横幅 + 歌曲列表），可整榜播放/下载——榜单歌曲复用现有 `songmid` 下载/刮削/播放全链路。搜索降为独立入口。

### 1.3 信息架构调整（导航结构）

**采用方案 A（推荐）：侧栏五 tab，搜索独立、发现=首页**

```
现状（5 项）                    目标（6 项，对齐 AM 侧栏心智）
├ 发现     → 搜索页            ├ 搜索     → 原 #view-search 原样迁移（改名不改 id）
├ 本地收藏                      ├ 发现     → 新 #view-home 热门歌单聚合页（默认 active）
├ 歌单                          ├ 本地收藏  → 保持（不降级为子入口，见下）
├ 设置                          ├ 歌单
└ 系统(音源/健康)               ├ 设置
                               └ 系统(音源/健康)
```

- **AM 映射依据**：AM 侧栏 = 搜索 / 主页 / 新发现 / 广播——「搜索」独立第一位、「内容页」紧随其后。Rainbow 映射为 搜索 / 发现（榜单首页）/ 本地收藏 / 歌单。
- **本地收藏不降级为子入口**：任务书「本地收藏降级为侧栏入口」的可落地下确认为——它不再是**默认首页心智**（首页让位给热门歌单），但仍是侧栏一级 tab：232px 侧栏容纳 6 项富余（现有 5 项 + 系统组），AM 的「资料库」同为一级入口，符合范式；降为子入口反而增加点击深度（本地曲库是核心高频功能，#53–#57 刚完成双视图/维度聚合迭代）。
- **tab 改动方式（契约安全）**：`#view-search` 的 section 与「搜索」tab 均为存量 id，**只挪位置/改 label，不改 id**；新增 `#view-home` section + `data-tab="home"`；main.js 默认 active tab 从 `search` 改为 `home`（showTab 逻辑零改动，纯配置）。
- **方案 B（P1 增强）**：顶栏全局搜索 pill（复用 SPOTIFY-REDESIGN-PLAN §1.1 D1 裁决：280px 暗玻璃胶囊 + focus 橙环），届时侧栏「搜索」tab 保留（双入口并存，AM 亦为侧栏+框内快捷双路径）。

---

## 2. 布局线框图（ASCII）

### 2.1 首页 · 热门歌单聚合页（#view-home，宽屏 ≥1280px）

```
+----------+------------------------------------------------------------+
| sidebar  |  #view-home                                                |
| 232px    |  ┌ 问候区 ──────────────────────────────────────────────┐   |
|          |  │  晚上好                    2026-08-21 · 7 个榜单    │   |
| [搜索]   |  │  发现                     今日更新的热歌榜单        │   |
| [发现]◀  |  └──────────────────────────────────────────────────────┘   |
| [本地收藏]|  ┌ 榜单卡网格 4-5/行（AM 大封面卡）──────────────────────┐   |
| [歌单]   |  │ ┌──────┐ ┌──────┐ ┌──────┐ ┌──────┐ ┌──────┐        │   |
| [设置]   |  │ │ 封面 │ │ 封面 │ │ 封面 │ │ 封面 │ │ 封面 │        │   |
| ──────   |  │ │ 1:1  │ │ 1:1  │ │ 1:1  │ │ 1:1  │ │ 1:1  │        │   |
| 最近播放  |  │ └──────┘ └──────┘ └──────┘ └──────┘ └──────┘        │   |
| (≤20条)  |  │ 热歌榜    巅峰榜·热歌 TOP500   飙升榜   酷我精选 …    │   |
| ──────   |  │ 网易云    QQ音乐    酷狗     QQ音乐    酷狗          │   |
| 音源/健康|  │ 今日更新* 今日更新* 今日更新*  每日更新   虚拟榜      │   |
|          |  │ ┌──────┐ ┌──────┐                                      │   |
| [🌈 R]   |  │ │ 封面 │ │ 封面 │   （7-9 卡，第二行居左）           │   |
|          |  │ └──────┘ └──────┘                                      │   |
|          |  └──────────────────────────────────────────────────────┘   |
|          |  ┌ P1 横幅推荐位（首榜大卡，取 grid 第一项放大）──────────┐  |
|          |  └──────────────────────────────────────────────────────┘   |
+----------+------------------------------------------------------------+
| player-bar（fixed 底，现状不动）                                        |
+---------------------------------------------------------------------+
```

- 窄屏 ≤900px：网格 `repeat(auto-fill, minmax(140px, 1fr))` 自然塌缩为 2-3 列（对齐 #53 网格卡 168px 模式微调）；问候区标题字号降档。
- 网格卡顺序：平台交错（wy → tx → kg → tx → kg → kw → mg），避免同平台扎堆，视觉更「聚合」。
- 「今日更新*」徽标：`updateTime === 今天` 时显示（wy/kg 响应自带更新时间字段，见附录 A）。

### 2.2 歌单详情页（榜单详情，首页点卡进入，view 内二级态）

```
+----------+------------------------------------------------------------+
| sidebar  |  #view-home（drill 态，复用 #57 面包屑模式）                 |
|          |  [← 返回] 热歌榜 · 网易云 · 200 首                          |
|          |  ┌ 顶部大封面横幅区 ────────────────────────────────────┐   |
|          |  │ ╭────╮  热歌榜                        [今日更新]    │   |
|          |  │ │封面│  网易云 · 官方榜单 · 更新于 08-21 08:30       │   |
|          |  │ │232 │                                                │   |
|          |  │ ╰────╯  [▶ 播放全部]  [⬇ 下载全部]  30/200 首        │   |
|          |  └────────（横幅底 = 封面 blur(24) 放大铺底 + 炭黑渐变遮罩）┘  |
|          |  ┌ 歌曲列表（.song-row 契约复用）────────────────────────┐   |
|          |  │ 1  [封面] 海屿你            马也_Crabbit   3:52 [网易云]│   |
|          |  │ 2  [封面] 甲乙丙丁(你我怎么两清) 李佳薇      3:30 [网易云]│   |
|          |  │ 3  [封面] 无题               姜云升        3:04 [网易云]│   |
|          |  │ …（P0 首屏 30 首；[加载更多 30 首] 走详情端点翻页）      │   |
|          |  └──────────────────────────────────────────────────────┘   |
+----------+------------------------------------------------------------+
| player-bar（fixed 底，现状不动）                                        |
+---------------------------------------------------------------------+
```

- 序号列：AM 榜单列表的排名语义（1-3 名可用 `--acc-hi` 强调）。
- 行结构完全复用 `.song-row`（封面/歌名/歌手/时长/平台 pill + hover 播放钮），SSE/播放高亮/行内交互零改动。

### 2.3 侧栏品牌区（🌈 Music logo）

```
┌────────────────────────┐
│ ╭──╮  Rainbow          │   logo：40×40 圆角 14px（--r-ctl 档，现值不动）
│ │🌈 │  MUSIC           │   多段暖虹渐变底（见 §3 规格），白色音符 SVG 现款保留
│ ╰──╯  （small 副标）    │   品牌名 "Rainbow" 16px/700 + 副标 "MUSIC"（原「音乐播放器」改小写字距加大，更 AM）
└────────────────────────┘
```

- logo 渐变为品牌资产表达：体系内暖色五段（`#F08A4B → #EE6C2B → #C2551F → #8A3D1A → #5C2A12` 的暖虹序列），不引入体系外冷色/多彩语义色（§3 不采纳项）。
- 光晕与 inset 高光沿用 `.sb-logo` 现有 box-shadow 量级，仅换 background 渐变值 + 副标文案——改动面 2 行 CSS。

---

## 3. 组件规格映射表（AM 特征 → Hume token 落地值）

| # | AM 特征（截图实测） | Rainbow 落地值（严格映射 Hume token） | 不采纳/替代说明 |
|---|---|---|---|
| M1 | 大封面卡（1:1 封面 + 下方标题/副信息，悬停浮起） | `.hp-card`：封面槽 1:1 `--r-card` 16px、overflow hidden；卡身透明（无底，AM 同款纯封面卡）；hover `transform: scale(1.05)` + `--shadow-card`、封面右下角 36px 橙圆播放钮浮现（同 #53 网格卡交互范式）；active `scale(.98)`；transition `.2s ease` | AM 卡阴影更重——沿用两级 elevation 不加档 |
| M2 | 悬停放大 1.05 / 按压 0.98 | `scale(1.05)` / `scale(.98)`，`transition: transform .2s ease`；`prefers-reduced-motion` 降级为 opacity（UI-GUIDE 动效红线） | — |
| M3 | 毛玻璃横幅（详情页大封面区） | 横幅底 = 榜单封面 `filter: blur(24px) saturate(1.2)` 放大 1.4 倍铺底 + `linear-gradient(180deg, transparent, var(--bg) 88%)` 遮罩；前景信息层 `--card` 底 + blur(24px)（体系 blur 定值不可变） | AM 用纯大图横幅——Rainbow 榜单封面为长方形 300×300，blur 铺底更稳（封面尺寸不足放大满屏时发虚） |
| M4 | 字体层级：大标题粗 + 副信息细灰 | 问候语 22px/600 `--txt`（新）；页面大标题沿用 `.view-title` 29px/700 渐变文字（已对齐 AM 大标题档，零改动）；卡标题 14px/600 单行省略；卡副信息 12px/400 `--txt2`；徽标 10.5px/600 大写字母距 1.2px（复用 `.sb-section-label` 量级） | 不引入 SF Pro Display 字体栈（保持 `-apple-system + PingFang SC` 现栈——本身就是 AM 中文环境同款渲染） |
| M5 | 封面占位渐变 | `.hp-cover-fallback`：`radial-gradient(circle at 30% 25%, rgba(240,138,75,.85), rgba(238,108,43,.45) 42%, #101113 100%)` + 居中音符 SVG（现款 `agg-note` 复用）——**#EE6C2B→#101113 径向渐变** | AM 多彩占位（粉/蓝/绿随机）不采纳：单橙体系 |
| M6 | 平台标识 | 卡副信息行 = `PLATFORM_NAME[platform]` 文本（网易云/QQ音乐/酷狗…）+ 榜单名；行内歌曲平台 pill 复用 `.song-plat` | AM 无平台概念，此处为 Rainbow 聚合特有 |
| M7 | 「今日更新」编辑性徽标 | 10.5px 胶囊 `--acc-soft` 底 + `--acc-hi` 文字 + `--r-pill`；数据源 = 各榜单响应的更新时间字段（附录 A：wy `trackCount/无显式` → 用缓存写入时间；kg `rank_id_publish_date`；tx `update_time`） | AM 红色高亮系（品牌红）不采纳，统一橙 |
| M8 | 网格节奏 | `repeat(auto-fill, minmax(168px, 1fr))`（对齐 #53 网格卡密度）gap 12px；窄屏 minmax(140px) → 2-3 列；间距全部 8 的倍数（4/8/12/16/24） | — |
| M9 | 详情页操作按钮 | 「▶ 播放全部」「⬇ 下载全部」复用 `.toolbar button` 现款控件（`--r-ctl` 12px、主按钮橙底白字同 #play-all） | AM 圆角大按钮（粉/蓝填充）不采纳 |
| M10 | 排名序号 | 列表首列 16px/600 `--txt3` 等宽数字；1-3 名 `--acc-hi` | AM 无排名（编辑推荐位）——榜单场景必须有 |

**不采纳项汇总**：AM 多彩语义色（每卡不同主色）、SF 字体栈替换、亮色模式、红色品牌高亮、横幅人像编辑文案位（P1 横幅位只放榜单本身，不做人工编辑文案）、「广播」导航项（无对应能力）。

---

## 4. 数据层设计

### 4.1 后端聚合端点契约：`GET /api/v1/hot-playlists`

```
响应 200：
{
  "playlists": [
    {
      "id": "wy-3778678",                  // 合成 id：{platform}-{原生榜单id}，详情页路由用
      "platform": "wy",                     // wy | tx | kg | kw | mg
      "nativeId": "3778678",                // 平台原生 id（tx=topid、kg=rankid、kw/mg 虚拟榜=关键词 slug）
      "title": "热歌榜",
      "coverUrl": "https://p1.music.126.net/0SUEG8yDACfx0Bw2MYFv4Q==/109951170048519512.jpg",
                                          // 平台原生封面，{size} 占位已替换（kg 用 480，附录 A.5）
      "updateTime": "2026-08-21",           // 各平台原生更新时间（kw/mg 虚拟榜 = 生成日期）
      "total": 200,                         // 榜单总曲目数
      "source": "toplist",                  // toplist=官方榜 | virtual=关键词拼装（前端徽标区分）
      "songs": [                            // P0 固定取前 30 首（kg 单页 30/tx 单页 50 上限内）
        {
          "platform": "wy",
          "songmid": "1973665667",
          "title": "海屿你",
          "artist": "马也_Crabbit",
          "album": "海屿你",
          "interval": "3:52",
          "img": "http://p3.music.126.net/…",   // 歌曲级封面，可空（kw 恒空 → M5 渐变占位）
          "songInfo": { …MusicInfo 原样… }      // ★ 与 GET /api/v1/search 的 list item 同构
        }
      ]
    }
    // … 共 7 榜：wy热歌榜 / tx巅峰榜·热歌 / tx飙升榜 / kg TOP500 / kg飙升榜 / kw精选(虚拟) / mg精选(虚拟)
  ],
  "errors": [                               // 平台失败不阻塞其他（§4.2 降级）
    { "platform": "kg", "error": "upstream timeout", "fallback": "cache" }
  ]
}
```

**设计要点**：
- `songs[].songInfo` = 现有 `MusicInfo` 结构原样内嵌（`API.md` §2 已言明该结构「可原样作为下载接口的 musicInfo 传入」）——榜单歌**零转换**进入现有 download/刮削/播放链路，这是本次设计最关键的一条契约。
- 端点内部三平台并发（`Promise.allSettled`），单平台失败/超时（建议 8s）→ 该平台项进 `errors`，其余照常返回。
- 端点带 5 分钟服务端内存缓存（同进程 Map，防前端多端同时冷启动打穿上游——三平台连发实测稳定但无 SLA，见 §6）。

### 4.2 各平台数据获取路径（Part 1 实测结论，证据见附录 A）

| 平台 | 榜单 | 获取路径 | 歌曲 → MusicInfo 适配 |
|---|---|---|---|
| wy | 热歌榜 3778678 | **复用现有 `wy/songList.ts getListDetail('3778678')` 零新代码**（linuxapi `/api/v3/playlist/detail`，实测一次返回全量 200 首 + privileges） | `filterListDetail()` 现成转换（songmid=id、img=al.picUrl、types 由 privileges 推档） |
| tx | 巅峰榜·热歌 topid=26 / 飙升榜 topid=62 | 新增 `tx/toplist.ts`：`GET c.y.qq.com/v8/fcg-bin/fcg_v8_toplist_cp.fcg?topid={id}&format=json&song_begin=0&song_num=50`，**无需任何请求头**（实测裸 fetch 可用） | 榜单 `songlist[].data` 与 `tx/musicSearch.ts` 的 `TxRawItem` **字段同构但扁平**（strMediaMid 顶层、无 file 嵌套）→ 需 20 行小适配：`songmid=songmid、strMediaMid=strMediaMid、img=T002R500x500M000{albummid}.jpg 构造（实测 200）`；音质档由 size_* 字段推（含 sizeflac/size_hires） |
| kg | TOP500 rankid=8888 / 飙升榜 rankid=6666 | 新增 `kg/toplist.ts`：`GET m.kugou.com/rank/info/?rankid={id}&page={p}&json=true`（移动端 UA），30 首/页，page 翻页 | `songmid=audio_id、hash=hash、albumId=album_id、img=album_sizable_cover({size}→480)`；音质档缺失（榜单响应无 filesize 字段）→ **下载时走现有 gateway 补齐链路**（`kg/songList.ts fetchAudioInfos(hashList)` 现成函数，按 hash 批量取 320/flac/hires 档） |
| kw | （榜单接口不可用） | **降级**：搜索拼装虚拟榜「酷我精选」——固定热门关键词（配置化数组，如 `["热门歌曲", "抖音热歌"]` 取第一词）→ 复用 `kw/musicSearch.ts search(kw词, 1, 30)`，实测可用 | 搜索结果即 MusicInfo（songmid=MUSICRID 去前缀），零转换；封面恒空 → M5 渐变占位 |
| mg | （榜单接口不可用） | **降级**：同上「咪咕精选」，复用 `mg/musicSearch.ts search()`，实测可用（sign 头复刻验证通过） | 搜索结果即 MusicInfo（songmid=songId + copyrightId），img3 拼绝对路径（适配器已处理） |

> 降级策略通用性：任一平台榜单接口未来失效时（tx/kg 均为非官方公开接口），同一「搜索拼装」模式即可兜底该平台——`source: "virtual"` 字段让前端可透明展示降级态（卡片标注「精选」而非冒充官方榜）。

### 4.3 前端缓存策略（localStorage `rainbow.hot-playlists`）

```
结构：{
  savedAt: 1787294899000,              // 写入时间戳
  playlists: [...],                    // 端点响应原样
  stalePlatforms: { "kg": 1787294899000 }  // 各平台失败时间戳（来自 errors）
}
策略：
1. 进入首页：savedAt 距今 < 24h → 直接渲染缓存；并发静默预取（SWR 式，成功后仅当 updateTime 变化才重渲染，避免打断浏览）
2. savedAt ≥ 24h 或无缓存 → 请求端点；请求失败 → 有旧缓存则渲染旧缓存 + toast「榜单数据为缓存」；无缓存 → 每卡显示 M5 渐变占位 + 重试按钮
3. 平台级失败短 TTL：stalePlatforms[kg] 距今 < 1h → 本地渲染时直接采用缓存内该平台旧数据（不因单平台失败整页空白）；≥ 1h 或缓存也无该平台 → 卡片隐藏该平台，不显示错误卡（聚合页保完整感）
4. 写入防御：JSON.stringify 包 try/catch（隐私模式/配额满——library.js 同款范式）；体积实测预估 ~300KB（7 榜 × 30 首 × ~1.4KB MusicInfo），5MB 配额内安全
```

### 4.4 播放 / 下载 / 刮削链路复用（songmid 已具备）

- **播放**：首页卡「▶」/ 详情页播放全部 → `player.playQueue(songs.map(s => s.songInfo), startId)`——songInfo 即任务视图兼容对象（与搜索结果播放同路径，`typeUrl` 空由播放器现网逻辑处理）。
- **下载**：详情页行内下载/下载全部 → `POST /api/v1/download`（musicInfo 原样传入）；kg 歌曲下载前置 gateway 补齐由**现有 createTask 链路**自动完成（kg/songList.ts 同款），前端无感。
- **刮削**：下载完成后走现有 tasks + scrape 全链路，无需任何改动。
- **实测佐证**：任务书所列常驻服务（PID 562/端口 23330）经核查实际未运行（PID 562 为系统进程 `appleh13camerad`，23330 无监听）——遵守「勿动」约束未自行启动服务；降级链路改为**直测上游端点**：kw `search.kuwo.cn/r.s`（TOTAL=3305 正常返回）与 mg `jadeite.migu.cn`（code=000000 正常返回）均验证可用，即 kw/mg 搜索拼装路径成立（证据见附录 A.4）。

---

## 5. P0 / P1 分阶段

### P0（#60 实施范围：可用性闭环）

| # | 项 | 内容 | 涉及文件（预估） |
|---|---|---|---|
| P0-1 | 品牌更新 | 侧栏 logo 暖虹渐变 + 副标改「MUSIC」 | style.css（2 处）、index.html（1 行文案） |
| P0-2 | 数据源 | 后端 `GET /api/v1/hot-playlists`：wy（复用 getListDetail）+ tx/kg toplist 适配器 + kw/mg 搜索拼装 + 5min 内存缓存 + errors 隔离 | server/src/routes/（新 hotPlaylists.ts）、adapters/{tx,kg}/toplist.ts（新）、API.md 增补 |
| P0-3 | 首页 | `#view-home`：问候区 + 7 卡网格（M1/M4/M5/M8 规格）+ 今日更新徽标 + 缓存渲染 + 空态 | index.html、web/js/pages/home.js（新）、style.css（.hp-* 命名空间） |
| P0-4 | 歌单详情 | drill 二级态：blur 横幅（M3）+ 播放全部/下载全部 + .song-row 列表 + 排名列（M10）+ 翻页加载（kg page++/tx song_begin+=50/wy 本地切片） | home.js 内 drill 状态机（复用 #57 libDrill 模式）、style.css |
| P0-5 | 导航调整 | 「搜索」tab 独立置首、「发现」= 首页默认 active；tab id 不改只挪位 | index.html、main.js（默认 tab 常量） |
| P0-6 | 前端缓存 | rainbow.hot-playlists 24h TTL + 平台短 TTL 重试 + 写入防御 | home.js |

P0 验收线：断网冷启动有占位+重试；三平台榜单卡可点进详情、可整榜播放、可单曲下载（kg 含 gateway 补齐）；任一平台上游挂掉页面不空白。

### P1（增强迭代，按优先级）

1. **横幅推荐位**：网格首榜升级为大横幅卡（封面左置 232px + 渐变文字区，取 AM「今日热门」位型）。
2. **平台分组 tab**：首页顶部 segmented「全部/网易云/QQ/酷狗/…」（复用 .lib-dim-seg 范式）。
3. **骨架屏**：卡片 shimmer 占位（blur24 玻璃底 + 亮度呼吸动画，reduced-motion 降级静态）。
4. **入口动效**：首屏卡片 staggered reveal（animation-delay 40ms/卡，240ms 总时长，同 #53 lib-switching 量级）。
5. **顶栏全局搜索 pill**：复用 SPOTIFY-REDESIGN-PLAN §1.1 D1 裁决（280px 暗玻璃胶囊）。
6. **榜单扩展**：酷狗榜单全集接口（`m.kugou.com/rank/list/&json=true`，实测 55 榜）按需加「网络热歌榜 82831 / 新歌榜 74534」等；网易可选「新歌榜 3779629 / 原创榜 2884035」（同一 getListDetail 链路）。
7. **首页「热歌速览」列表分区**：首榜前 10 首直接平铺（AM「新歌精选」多列列表样式），点击行播放。
8. **榜单歌曲本地化标记**：已下载歌曲行加「已入库」徽标（songmid 与 tasks 比对）。

---

## 6. 风险点

| # | 风险 | 等级 | 缓解 |
|---|---|---|---|
| R1 | 上游接口无 SLA：tx fcg 老接口/kg m 端/wy linuxapi 均为公开非官方端点，随时可能风控或改版（kg m3ws 已实锤 Access Deny，见 A.3） | 高 | ① errors 隔离 + 缓存兜底 + 搜索拼装三重降级；② toplist 适配器独立文件，改版影响面收敛；③ 健康页可后续加榜单探活 |
| R2 | 单页上限：tx 50/页（实测 song_num=100 实返 50）、kg 30/页、wy 一次全量 200 | 中 | P0 详情页统一「首屏 30 + 加载更多」分页交互，翻页参数各平台差异封装在 toplist 适配器内 |
| R3 | kg 榜单曲目无音质档位，批量「下载全部」触发 gateway 高频补齐（30 首/批） | 中 | 下载全部沿用现有批量 ≤200 与节流；gateway 每批 100 hash 一次（现有实现），30 首单曲批=1 次请求，可接受 |
| R4 | kw/mg 虚拟榜语义偏差：搜索排序 ≠ 官方榜单（热度词质量不可控、时效漂移） | 中 | 卡片标注「精选」（source=virtual 徽标），不冒充官方榜；关键词配置化（config 或常量数组）便于调优 |
| R5 | 封面直链防盗链/跨区 CDN 波动 | 低 | 实测三平台封面 HEAD 全 200（A.5）；img 统一 `referrerpolicy="no-referrer"` + onerror 渐变占位（M5）双保险 |
| R6 | localStorage 容量与竞态（多 tab 同时写） | 低 | ~300KB/5MB 配额安全；写入 try/catch；竞态窗口仅损新一轮缓存，无功能影响 |
| R7 | 榜单 songmid 与下载链路一致性：wy 数字 id / kg audio_id / tx songmid 均为平台原生 id，与现有搜索结果同源 | 低 | 实测三平台榜单歌曲 id 形态与各自 musicSearch 结果一致（附录 A 摘要），链路天然兼容；#60 实施时抽 1 首歌真实下载回归验证 |

---

## 附录 A. Part 1 榜单接口实测矩阵（2026-08-21，node fetch 脚本 6 轮 / 24 候选端点）

> 实测环境：macOS + node v23（原生 fetch）；临时脚本 `.qa-tmp/toplist-probe/probe1-6.mjs`（测完已删除，本附录为其输出摘要的完整留存）。

### A.1 总矩阵

| 平台 | 候选端点 | 结果 | 采用 |
|---|---|---|---|
| wy | `POST music.163.com/api/linux/forward` → `/api/v3/playlist/detail`（linuxapi 加密，id=3778678） | ✅ 200，playlist.tracks **全量 200 首** + privileges + coverImgUrl + trackIds | ★ 主路径（现有代码） |
| wy | `GET music.163.com/api/v6/playlist/detail?id=3778678&n=30` | ✅ 200，tracks=n 可控（20/30 验证过），trackIds 200 | 备选（轻量） |
| wy | `GET music.163.com/api/playlist/detail?id=3778678` | ⚠️ 200 但 `result` 包装 + 563KB 重 | 不采用 |
| wy | `GET music.163.com/api/top/list?id=3778678` | ❌ `{"code":404}` 已下线 | — |
| tx | `GET c.y.qq.com/v8/fcg-bin/fcg_v8_toplist_cp.fcg?topid=26&format=json&song_begin=0&song_num=50` | ✅ code=0，「巅峰榜·热歌」total 300，songlist 50 首/页 | ★ 主路径 |
| tx | 同上 topid=62 | ✅ 「飙升榜」total 100 | ★ |
| tx | 同上 topid=27 | ✅ 新歌榜（响应正常） | P1 备选 |
| tx | `u.y.qq.com musics.fcg` 签名体系 | 未测（需 zzcSign 签名，fcg 公开端点已够用） | — |
| kg | `GET m.kugou.com/rank/info/?rankid=8888&page=1&json=true` | ✅ 200，TOP500：info（rankname/img_cover/intro/rank_id_publish_date）+ songs.list **30 首/页** + total 500 | ★ 主路径 |
| kg | `GET m.kugou.com/rank/list/&json=true` | ✅ 200，榜单全集 **55 榜**（8888 TOP500 / 6666 飙升榜 / 82831 网络热歌榜 / 74534 新歌榜 …） | P1 榜单扩展 |
| kg | `GET m3ws.kugou.com/rank/v7/get_rank_list` / `get_rank_info` | ❌ `Access Deny ! No Actions !`（需签名） | — |
| kg | `GET www.kugou.com/yy/rank/home/1-8888.html` | ⚠️ 200 HTML 但无 `global.data` 歌曲块（仅页面变量） | — |
| kg | `GET m.kugou.com/rank/songs/…json=true` | ❌ Access Deny | — |
| kw | `GET kuwo.cn/api/www/bang/bang/musicList?bangId=93` / `bangList` | ❌ 需动态 csrf：`{"success":false,"message":"The request is illegal!"}`；kw_token 在首页/rankList（NUXT SPA）均无下发途径（仅 Hm_lvt 统计 cookie） | 搜索降级 |
| kw | `GET wapi.kuwo.cn/api/v1/billboard/home` / `m.kuwo.cn/api/v7/billboard/home` | ❌ 404 | — |
| mg | `app.c.nf.migu.cn/MIGUM* content/querycontentbybillid / billboard_content`（chartId 02 / column 2750 双域名） | ❌ `{"code":"299996","info":"路由请求不支持"}` | 搜索降级 |
| mg | `m.music.migu.cn/migu/remoting/*`（billboard/migu_top / cms_boutique / cms_bulletin_bo_test） | ❌ 全部返回 H5 壳 HTML（remoting 系已下线）；`music.migu.cn/v3` 为 Vue SPA 无 SSR | — |

### A.2 关键响应证据（前 3 首摘要）

- **wy 热歌榜（linuxapi v3）**：`playlist.name="热歌榜"`，cover `p1.music.126.net/0SUEG8yDACfx0Bw2MYFv4Q==/109951170048519512.jpg`；前 3：`1973665667 海屿你—马也_Crabbit` / `3399839173 甲乙丙丁(你我怎么两清)—李佳薇` / `3423462793 无题—姜云升`。头：UA + Origin + `Cookie: MUSIC_U=`（空值即可）。
- **tx 巅峰榜·热歌（topid=26）**：`ListName="巅峰榜·热歌"` update 2026-08-21，总 300 首；前 3：`003GT3CT3p4h82 闭目入神—郑中基` / `001fsNdn1zuZnA 我不难过—孙燕姿` / `000nXKv108CoUC BiiiG—BIGBANG`。**无任何自定义请求头实测亦 code=0**（裸 fetch）。
- **tx 飙升榜（topid=62）**：`ListName="飙升榜"` 每日更新，总 100，listennum 1863 万。
- **kg TOP500（rankid=8888）**：`rankname="TOP500"` `rank_id_publish_date="2026-08-21 08:30:00"`；前 3：`audio_id=627136989 山风山风等等我—万海东` / `571484095 你有没有真的爱过我—阿图表妹` / `1106816298 甲乙丙丁(你我怎么两清)—李佳薇`（与 wy 热歌榜第 2 首同名同艺人——榜单数据真实可信的旁证）。头：移动端 UA。
- **翻页**：kg `page=2` 返回 30 首（首 1=好想再爱你 / 首 30=富士山下）✅；tx `song_begin=100` 返回 50 首 ✅；tx `song_num=100` **实返 50**（单页上限实测确认）。

### A.3 请求头与限流初判

| 平台 | 必需头 | Cookie | 连发实测 | 限流初判 |
|---|---|---|---|---|
| wy | UA + Origin（linuxapi 路径） | `MUSIC_U=` 空值即可 | 3 连发（400ms 间隔）全成功 | 低风险（与现有搜索/歌单链路同源，产品已长期使用） |
| tx | **无**（裸 fetch code=0） | 不需要 | 3 连发全成功 | 低风险（fcg 老接口无签名无频控迹象） |
| kg | 移动端 UA（推荐） | 不需要 | 3 连发全成功 | 低-中风险（m 站点有签名版接口被拒的前科，json=true 老路径目前开放；建议服务端 5min 缓存） |

### A.4 降级链路证据（kw / mg 搜索拼装）

- **kw**：`GET http://search.kuwo.cn/r.s?client=kt&all=周杰伦&pn=0&rn=5&…rformat=json&mobi=1`（kw/musicSearch.ts 现用上游）→ 200，`TOTAL=3305`，abslist 含 `MUSICRID/SONGNAME/ARTIST/ALBUM/N_MINFO`（音质档：bitrate 22000 zply / 25000 dtsx 等可解析 128k–flac24bit 档）。
- **mg**：`GET https://jadeite.migu.cn/music_search/v3/search/searchAll`（复刻 mg/musicSearch.ts sign：md5(text+sig+appid+deviceId+timestamp) 头）→ `code=000000` total=126，含 `songId/copyrightId/name/singerList/img3`（webp 相对路径拼 `d.musicapp.migu.cn` 前缀）。
- 结论：kw/mg 「固定热门关键词搜索前 N 首拼装虚拟热歌榜」**技术可行**，零新接口（直接调现有 search 适配器）。

### A.5 封面 URL 有效性（HEAD 实测全 200）

| 封面类型 | 样例 | 结果 |
|---|---|---|
| wy 榜单封面 | `p1.music.126.net/…/109951170048519512.jpg` | 200 image/jpg 154KB |
| wy 歌曲专辑封面 | `tracks[0].al.picUrl` | 200 image/jpg 360KB |
| tx 榜单封面 | `topinfo.pic_v12`（T003R300x300M000…） | 200 image/jpeg 19KB |
| tx 歌曲专辑封面 | `T002R500x500M000{albummid}.jpg`（**构造式**，与 tx/musicSearch.ts img 同款） | 200 image/jpeg 45KB |
| kg 榜单封面 | `imge.kugou.com/mcommon/{size}/…png` → {size}∈{240,400,480,640} | **4 档全 200**（480 档 96KB，**推荐 480**） |
| kg 歌曲专辑封面 | `imge.kugou.com/stdmusic/{size}/…` → {240,480,640} | 3 档全 200（240 档 94KB 性价比高） |

### A.6 响应结构要点（适配器实现速查）

- **wy**：`body.playlist.{name, coverImgUrl, trackCount, tracks[]{id,name,dt,ar[].name,al{name,id,picUrl},sq/h/l 大小}, trackIds[], privileges[]{id,maxbr,maxBrLevel}}`——与 `wy/songList.ts` 现有类型定义完全一致。
- **tx**：`{code:0, topinfo{ListName, pic_v12, pic, update_time, listennum}, songlist[]{data{songmid, songname, singer[]{name,mid}, albummid, albumname, albumid, interval, strMediaMid, size128/320/flac/hires, vid}, cur_count, in_count, old_count}, date, update_time, total_song_num}`——data 与 TxRawItem 字段同构但**扁平**（无 file 嵌套、strMediaMid 顶层、无 media_mid），适配函数需注意。
- **kg**：`{info{rankname, img_cover({size}), bannerurl, intro, rank_id_publish_date, play_times, rankid}, songs{total, page, pagesize:30, list[]{songname, h5_author_name, authors[], album_sizable_cover({size}), album_id, hash, audio_id, duration, filename}}}`——无音质档位字段，下载需 gateway 补齐（现有 `fetchAudioInfos` 链路支持 hash 批量）。
- **kg 榜单全集**：`{rank{total:55, list[]{rankid, rankname, imgurl({size})}}}`。
