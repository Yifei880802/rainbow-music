# 歌单广场接口调研实测 + 封面现状排查（#65）

> 调研产出，供 #66（歌单广场接入）/ #67（封面修复）实施。不含产品代码。
> 实测环境：本机 node fetch 直连各上游 + 常驻服务（127.0.0.1:23330，node dist/index.js）登录态 curl。
> 实测时间：2026-08-24。所有结论均有真实网络证据；响应样本字段的截图级证据以「实测输出」段落为准。

---

## 一、Part 1 歌单广场接口实测矩阵

### 1.1 总览

| 平台 | 广场列表端点 | 可用 | 分页(换一批) | 列表封面 | 详情取 tracks | 详情歌曲封面 | 稳定性(3连发) | 接入建议 |
|---|---|---|---|---|---|---|---|---|
| wy 网易云 | `GET music.163.com/api/playlist/list` 或 linuxapi 转发同 path | ✅ | ✅ offset 步进无重叠 | ✅ coverImgUrl（HEAD 200） | ✅ 复用现有 getListDetail | ✅ al.picUrl 直链 | 200→200→200 | **P0 接入（首选）** |
| tx QQ音乐 | `GET c.y.qq.com/splcloud/fcgi-bin/fcg_get_diss_by_tag.fcg` | ✅ | ✅ sin/ein 无重叠 | ✅ imgurl 300 档（HEAD 200） | ⚠️ 老接口 75%（广场 dissid 6/8；搜索链路 dissid 3/3） | ✅ T002R500 拼接 | 200→200→200 | **P1 接入（详情需容错）** |
| kg 酷狗 | `m.kugou.com/plist/index` 系列 | ❌ 全部失效（body null/壳页） | — | — | ✅ special/single HTML | ❌ gateway 链路 img 恒 null | — | **降级：关键词拼装（P2）或不接入** |
| kw/mg | （任务范围外，维持现状） | — | — | — | — | kw 恒 null / mg img3 直链 | — | 维持虚拟榜现状 |

### 1.2 wy 网易云（实测全绿，P0 首选）

**列表端点（两条等价路径，任选）**
- A. 直连：`GET https://music.163.com/api/playlist/list?cat=全部&order=hot&limit=20&offset=0`
  - 请求头：PC UA + `Referer: https://music.163.com/discover/playlist`；无需 Cookie
- B. linuxapi 转发（与现有 [wy/songList.ts](../../server/src/core/adapters/wy/songList.ts) `getListDetail` 同鉴权路径）：POST `https://music.163.com/api/linux/forward`，eparams 里包 `method:POST, url:https://music.163.com/api/playlist/list, params:{cat, order:'hot', limit, offset, total:true}`
- 实测 A/B 返回数据完全一致（total=683）

**响应结构映射**

| 目标字段 | 源字段 | 样本 |
|---|---|---|
| 歌单 id | `playlists[].id` | `17990594711` |
| 标题 | `playlists[].name` | 纯音乐｜专注 放松 清新 氛围 纯音乐 |
| 封面 URL | `playlists[].coverImgUrl` | `http://p1.music.126.net/Sr6oQAIyKdawA_zfn2ECdw==/109951173274628960.jpg` |
| 播放数 | `playlists[].playCount` | 175852 |
| 歌曲数 | `playlists[].trackCount` | 60 |
| 创建者 | `playlists[].creator.nickname` | 洛米Gemini |
| 简介 | `playlists[].description` | 有 |
| 总数 | `total` | 683 |

**分页**：`offset`（page=1→offset 0，page=2→offset 20）。实测 page1 首 id=17990594711，page2 前 3 id 全新、零重叠 → 「换一批」直接 offset 递增。
**分类**：`cat=华语` 实测可用（分类词即参数，全部分类同构）。
**详情**：复用现有 `GET /api/v1/search/songlist/detail?platform=wy&id=...`（linux/forward → api/v3/playlist/detail，已生产验证）；实测广场 id 直取：60 首 tracks，每首含 `songmid`(id) + `al.picUrl` 封面直链，与 MusicInfo.img 映射现成（filterListDetail）。
**限流风险**：低——与现有 wy 搜索/歌单详情同域同路径族，现有 httpFetch 已带重试。建议沿用 hot-playlists 的 5min 内存缓存 + 单请求 8s 超时范式。

**3 歌单样本证据**
1. 「纯音乐｜专注 放松 清新 氛围 纯音乐」id=17990594711，60 首，封面 HEAD 200（image/jpg 154KB），详情首 3 首：溺于无声之夏 / Shizukana Umi / 无尽幸福
2. 「Rosy赵露思｜不怕人海多辽阔 你会认出我啊」id=18167297102，24 首，封面 HEAD 200
3. 「Queen皇后乐队｜摇滚灵魂不朽」id=18194128578，60 首，封面 HEAD 200，创建者：索尼音乐国际

### 1.3 tx QQ 音乐（广场可用；详情 75% 需容错，P1）

**列表端点**
```
GET https://c.y.qq.com/splcloud/fcgi-bin/fcg_get_diss_by_tag.fcg
  ?picmid=1&rnd={random16}&g_tk=724972804&loginUin=0&hostUin=0
  &format=json&inCharset=utf8&outCharset=utf-8&notice=0&platform=yqq&needNewCode=0
  &categoryId=10000000&sortId=5&sin=0&ein=19
```
- 请求头：`Referer: https://c.y.qq.com/`、`Origin: https://c.y.qq.com`（缺了会 jsonpc 包裹/拒绝）
- sortId：5=推荐（默认，20 条/页，sum=11620）；2/3（最热/最新）亦可用
- categoryId=10000000（全部）可用；**10000001 实测返回空**（diss 分类 id 体系与歌单广场页不一致，其余分类 id 需另行探测，非必须——全部类目足够）

**响应结构映射**

| 目标字段 | 源字段 | 样本 |
|---|---|---|
| 歌单 id | `data.list[].dissid` | `7729596131` |
| 标题 | `data.list[].dissname` | 耳机里的秘密 \| 宝藏女声集合站 |
| 封面 URL | `data.list[].imgurl` | `http://qpic.y.qq.com/music_cover/.../300?n=1`（HEAD 200） |
| 播放数 | `data.list[].listennum` | 55474084 |
| 歌曲数 | `data.list[].song_count` | 有（部分缺） |
| 创建者 | `data.list[].creator.name` | 腾讯音乐人 |
| 总数 | `data.sum` | 11620 |

**分页**：`sin/ein`（0/19 → 20/39 实测零重叠）→ 换一批 sin 递增。
**详情**：复用现有 `fcg_ucc_getcdinfo_byids_cp.fcg`（= tx/songList.getListDetail 端点）：
- 现有搜索链路 dissid：3/3 全可用（415/410/62 首，tracks 含 mid/album.mid → img 拼接 T002R500 现成）
- 广场 dissid：**6/8 可用**（1229/128/642/156/22/100 首）；失败 2 个（7707261125「甜度爆表」、7578943835「丧系Rap」）返回 HTTP 200 + code 0 但 `cdlist` 空——疑似推荐位特殊 diss 类型，**无鉴权可破**（新网关 `u.y.qq.com/cgi-bin/musicu.fcg` GetDissInfo=500003 / PlayListPlazaServer=500005 均拒）
- **接入必须容错**：详情空 → 跳过/提示「该歌单详情暂不可取」（或广场列表页预探测过滤）
**限流风险**：低-中。3 连发（间隔 800ms）全 200；rnd 随机数必带。

**3 歌单样本证据**
1. 「耳机里的秘密 | 宝藏女声集合站」dissid=7729596131，详情 1229 首 ✓（腾讯音乐人，播放 5547 万）
2. 「侠气古风 : 腰间两把刀！断和了」dissid=7614366897，详情 128 首 ✓，封面 HEAD 200
3. 「甜度爆表 | 旋律说唱狙击少女心」dissid=7707261125，列表 ✓（播放 854 万）但详情空 cdlist ✗（容错样本）

### 1.4 kg 酷狗（广场端点已死；降级关键词拼装，P2/不接入）

- `m.kugou.com/plist/index/json/?union=true&isper=1&special=true...`：HTTP 200 但 body `null`
- 变体 `plist/index&json=true` / `plist/index/json?special=1` / `plist/list?json=1`：全部返回跳转壳/`null` → **移动广场 JSON 已下线**
- 降级方案（与 kw/mg 虚拟榜同型）：`http://msearchretry.kugou.com/api/v3/search/special?keyword=流行&page=1&pagesize=20&...`（= 现有 kg/songList.search 同端点，生产在用）
  - 空关键词报「参数不合法」→ 必须关键词轮换（流行/华语/抖音热歌…）
  - 实测：total=480、page1/2 零重叠、3 连发 200、封面 `c1.kgimg.com/custom/150/...jpg` 与 `imge.kugou.com/soft/collection/{size}/...jpg` 两种形态 HEAD 均 200
  - 样本：「抖音歌曲最火的歌2026【持续更新】」specialid=1852429，577 首，播放 19.6 亿
- **详情歌曲封面缺口**：special/single HTML 只给 hash（filename 为空），现有链路 hash→gateway 补齐后 `filterData2` 的 `img` 恒 `null`（gateway fields 无封面字段）→ kg 歌单详情歌曲行无封面来源（与榜单链路不同——榜单有 `album_sizable_cover` 回填，songList 链路无对应字段）。接入则详情行封面只能靠前端渐变兜底，如实标注。

### 1.5 对 #66 的接口契约建议

- **新端点仅一个**（发现入口）：`GET /api/v1/playlist-square?platform=wy|tx&page=1&cat=全部`
  ```jsonc
  {
    "list": [{ "id": "17990594711", "name": "...", "coverUrl": "http://p1.music.126.net/...", 
               "playCount": 175852, "total": 60, "author": "洛米Gemini", "desc": "...", "source": "wy" }],
    "total": 683, "page": 1, "hasMore": true
  }
  ```
  - 服务端 5min 内存缓存 + in-flight 去重（照抄 hotPlaylists.ts 范式）；tx 详情失败不在此端点处理
- **详情/下载零新端点**：点击歌单 → 现有 `GET /api/v1/search/songlist/detail?platform=wy&id=...`（wy/kg 已可用）；tx 详情空 cdlist 时后端抛错 → 前端 toast「该歌单详情暂不可取，试试下一个」+ 卡片可继续换批
- 「换一批」：page++（wy=offset、tx=sin/ein 映射）；kg 若做 = 关键词池轮换 + page
- 前端卡片复用 hp-card 范式（hp-fallback 径向渐变兜底 + onerror 移除），歌单广场数据源 coverUrl 覆盖率高（wy/tx 列表全带）

---

## 二、Part 2 封面现状排查

### 2.1 排行榜歌单卡封面（GET /api/v1/hot-playlists 实测）

实测（2026-08-24，errors=[]，10 榜全成功）：

| 榜单 | pl.coverUrl | songs[].coverUrl | 说明 |
|---|---|---|---|
| wy-3778678 热歌榜 | ✅ | 50/50 | p1.music.126.net |
| tx-26 巅峰榜·热歌 | ✅ | 50/50 | T003R300 榜卡 / T002R500 行 |
| kg-top500 | ✅ | 30/30 | mcommon/480 榜卡 / stdmusic/240 行 |
| tx-62 飙升榜 | ✅ | 50/50 | |
| kg-soar | ❌ **NULL** | 30/30 | 上游 `img_cover=""`（空串） |
| kw-hot-hits 虚拟 | ❌ NULL（结构性） | **0/30** | kw 搜索 img 恒 null |
| kg-new | ❌ **NULL** | 30/30 | img_cover/bannerurl 双空，但 img_9/banner_9 有 |
| mg-hot-hits 虚拟 | ❌ NULL（结构性） | 22/22 | img3 webp 直链（意外全绿） |
| kg-webhot | ✅ | 30/30 | |
| kg-eur | ❌ **NULL** | 29/30 | img_cover=""，bannerurl 可用未生效 |

**根因（kg 三榜 NULL）**：[kg/toplist.ts L90](../../server/src/core/adapters/kg/toplist.ts) `sizedCover(info.img_cover ?? info.bannerurl, 480)` —— 上游对部分榜返回 `img_cover: ""`（**空串**），`??` 只判 null/undefined 不判空串 → fallback 失效。实测：
- 6666 飙升：`img_cover=""` 但 `bannerurl="http://imge.kugou.com/mcommonbanner/{size}/20190214/...jpg"`（480 档 HEAD 200）
- 31310 欧美：同上（bannerurl 可用，480 档 HEAD 200）
- 74534 新歌：img_cover/bannerurl 双空，但 `img_9`/`banner_9` 有（mcommon/{size} 模板，480 档 HEAD 200）

**修复方案（P0，一处小改）**：fallback 链改为「非空串优先级」：
```ts
sizedCover(firstNonEmpty(info.img_cover, info.bannerurl, info.img_9, info.banner_9), 480)
```
→ kg 五榜封面全覆盖（8888/82831 不受影响）。

**前端兜底链路**（已合格）：[home.js playlistCard](../../web/js/pages/home.js) → 无 coverUrl 不渲染 img、hp-fallback（径向渐变 `radial-gradient(circle at 30% 25%, rgba(240,138,75,.85)…#101113)` + 音符 SVG）常驻 → 有图时 onerror `this.remove()` 移除 img 露渐变 → 兜底视觉合格，无空白破相。
- kw/mg 虚拟榜恒 NULL → 维持渐变；**可选增强（P1）**：mg 虚拟榜 songs 22/22 有封面，可用 `songs[0].coverUrl` 作卡面（局部拉伸视觉可接受）；kw 无源，维持渐变。

### 2.2 榜单详情歌曲行封面

**前端现状**：songRow（home.js L369-390）已有封面位 `.result-cover.hp-song-cover`（40px）：NOTE_SVG 音符常驻 + `s.coverUrl` 有值渲染 img（onerror remove）。渲染位不缺。
**后端链路**：hotPlaylists.ts toSongs `coverUrl: m.img ?? null` —— MusicInfo.img 原样透传（songInfo 同步内嵌）。
**实测覆盖**：wy 50/50、tx 50/50×2、kg 29~30/30 ✅；mg 22/22 ✅（img3 webp）；**kw 0/30 ❌**（kw/musicSearch.ts L75 `img: null` 硬编码，酷我搜索接口无封面字段）。
**与本地收藏行差距**：本地收藏行有 cover 接口三级回退（APIC→302→渐变）；榜单行 kw 无任何回退源（无 taskId、img 恒 null）。
**修复方案**：
- P1 后端：hot-playlists 聚合时对 kw songs 调 `fetchCoverUrl('kw', ...)`（kw/pic.ts artistpicserver 接口已存在且 metadata.ts 已接线）批量补图。风险：30 首串行可能超 8s 单榜超时 → 实施时需并发（Promise.all 限流 5）+ 超时放弃补图（保持 null 走前端渐变）
- P2 前端：维持现状渐变（.result-cover 浅橙 145deg 渐变 + 音符，视觉合格但与 hp-fallback 径向深渐变不同款；统一为径向深渐变可选）

### 2.3 本地收藏歌曲行封面（cover 接口实测）

**链路**（[cover.ts](../../server/src/routes/cover.ts)）：①任务不存在 404 → ②mp3 且已完成：node-id3 读 APIC → 200 image/* → ③music_info.payload.musicInfo.img 为 http(s) → 302 直链 → ④404。前端 library.js 行内 `<img src="/api/v1/cover/:taskId" onerror="this.remove()">` → 露 .song-cover 三变体橙色渐变 + 音符（兜底合格）。

**实测抽查（20 任务，按平台全量取样）**：200(APIC)=8、404=12、302=0
- **kw 0/8 全 404（P0 缺口）**：全库 40 个 kw done 任务（39 flac + 1 mp3）
  - **根因 A（决定性证据）**：FLAC 下载时 flac-tagger **已嵌入封面**——实测抽 8 个 kw done flac 全部含 PICTURE block（46~80KB，覆盖 8/8；样本 d7241e73 扫 block：`type=6 PICTURE len=59835`），但 cover.ts `readEmbeddedCover` 仅支持 `.mp3`（node-id3），**FLAC PICTURE block 读取端缺失** → 写了读不出
  - 根因 B：kw 搜索 img 恒 null（kw/musicSearch.ts L75）+ kw mp3 那首 getKwPic 亦无图 → 302 分支也走不到
  - **修复（P0，收益最大）**：cover.ts 增加 FLAC PICTURE block 解析——fLaC magic → 扫 METADATA_BLOCK（type=6）→ 解析 PICTURE 结构（type/mime/description/width/height/data）→ 200。纯 Buffer 解析零新依赖约 40 行。**修复后 kw 39 首（全库 74% done 任务）404→200**
- **wy 4/8 404**：4 首翻唱/合作版条目（晴天-Lucky小爱、稻香-周杰伦,A-LNK 等，actual_source=qdy），上游 `al.picUrl=null`（无专辑信息条目）且 metadata.ts fetchCoverUrl **无 wy 兜底分支**（只接了 kw/kg）
  - **修复（P1）**：fetchCoverUrl 加 wy 分支——img 缺失时调 eapi `song/detail` 补 `al.picUrl`（scrape-detail.ts 已有同款 eapi song/detail 调用链路可复用）
- tx 1/1、mg 2/2、kg 1/1 抽查全 200 ✅

**刮削现状**：download_tasks.scrape_info（53 条 success）fieldsWritten 全库仅出现 title/artist/album/year/trackNumber/discNumber/genre/albumArtist——**刮削不产出封面、不回写 music_info.img**（scrape-detail.ts 无 img 处理）。
- **修复（P1，刮削增强）**：刮削匹配成功时若上游详情含封面直链（wy eapi song/detail 的 al.picUrl / tx song-detail 等），回写 `music_info.payload.musicInfo.img` → cover 接口 302 分支即生效，无需重下载；对存量任务可做「补刮封面」批处理

**kw/mg 搜索下载 img 字段**：kw 恒空（接口特性）；mg img3 直链有（实测 22/22）——与 metadata.ts 注释「tx/wy/mg 搜索结果自带 500x500 直链」一致。

### 2.4 「AI 生成封面」可行性结论

**不引入（预期结论成立）**。理由：
1. 最大缺口（74%）是 FLAC 读取端 bug，修复即消失，不是「无封面可取」；
2. 剩余缺口（kw 个别单曲、wy 翻唱条目）占比小且有明确兜底路径（getKwPic/eapi 补图）；
3. 项目零外部图像服务依赖（下载链路 sharp 本地处理），引入 AI 生图 = 新增外部 API + key 管理 + 生成延迟与费用，违背自包含原则；
4. 现有渐变兜底（hp-fallback 径向渐变 / song-cover 三变体渐变 + 音符）视觉统一合格。
- 可选低成本强化（P2）：封面占位按歌名 hash 派生多档渐变色相，提升长列表辨识度（纯 CSS/前端，零依赖）。

---

## 三、问题清单汇总（根因 → 方案 → 分级）

| # | 场景 | 根因 | 修复方案 | 分级 |
|---|---|---|---|---|
| 1 | kg 飙升/欧美榜单卡封面 NULL | 上游 `img_cover=""` 空串，`??` 不吃空串，bannerurl 未生效 | toplist fallback 改非空串优先级链（`\|\|`） | **P0** |
| 2 | kg 新歌榜卡封面 NULL | img_cover/bannerurl 双空，img_9/banner_9 未纳入链 | 同上（链补 img_9/banner_9） | **P0** |
| 3 | 本地收藏 kw flac 39 首封面 404 | flac-tagger 已嵌 PICTURE，cover.ts 只读 mp3 APIC | cover.ts 加 FLAC PICTURE block 解析（零依赖 Buffer 解析） | **P0** |
| 4 | wy 翻唱条目 4 首封面 404 | al.picUrl=null 且 fetchCoverUrl 无 wy 兜底分支 | fetchCoverUrl 加 wy eapi song/detail 补图分支 | P1 |
| 5 | 刮削不产出封面 | scrape-detail 无封面处理 | 匹配成功回写 musicInfo.img（存量可补刮） | P1 |
| 6 | kw 榜单详情行 0/30 封面 | kw 搜索 img 恒 null，无回退源 | 聚合时 getKwPic 并发补图（限流+超时放弃）或维持渐变 | P1 |
| 7 | kw/mg 虚拟榜卡恒无封面 | 结构性（搜索拼装无歌单概念） | mg 用 songs[0].coverUrl 作卡面；kw 维持渐变 | P1 |
| 8 | kg 歌单（若接入）详情行无封面 | songList gateway 链路 img 恒 null | 接入时如实标注；前端渐变兜底 | P2 |
| 9 | 占位渐变单色相 | 长列表辨识度 | 歌名 hash 多档渐变（纯前端） | P2 |
| 10 | AI 生成封面 | — | 不引入（见 §2.4） | 结论 |

## 四、风险点

1. **tx 广场详情 75% 成功率**：失败 dissid 返回 200+code 0+空 cdlist，无鉴权可破（新网关 500003/500005）→ #66 必须做详情容错 UX；若产品要求高成功率，可列表预探测（代价：+1 次请求/歌单）。
2. **上游接口无 SLA**：wy/tx 广场与现有适配器同族（lx-music 系），随版本变化风险同现有搜索链路；5min 缓存 + 单请求超时 + 失败降级（前端 errors 占位卡范式）可控制爆炸半径。
3. **kw getKwPic 批量补图耗时未压测**：30 首串行可能超单榜 8s 超时，实施时必须并发限流 + 部分失败放弃。
4. ~~FLAC PICTURE 解析需覆盖 flac-tagger 写入的具体 block 布局~~ **已补验：抽 8/8 kw done flac 全含标准 type=6 PICTURE（46~80KB）**，实施时按标准 FLAC METADATA_BLOCK_PICTURE 结构解析即可；仅需留意无封面 flac 与损坏文件的容错（解析失败回退 302/404 分支）。
5. **cover 302 直链的时效性**：musicInfo.img 直链（p1.music.126.net 等）长期有效性未验证；直链失效时前端 onerror 已兜渐变，不阻塞。
6. **kg plist 广场死接口**：若酷狗后续恢复移动广场，可替换关键词拼装方案（端点形态已在 §1.4 记录）。

## 五、临时脚本

本次调研临时脚本（node fetch 探测 + db 只读统计）位于 `.qa-tmp/pl-square/`，任务完结后已删除；本文所有证据字段以「实测输出」引用结构为准，可按端点参数直接复现。
