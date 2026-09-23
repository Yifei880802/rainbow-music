# Rainbow API 文档

Rainbow 的完整 HTTP API 参考。所有接口以 `/api/v1` 为前缀，返回 `application/json`（SSE 除外）。

- **Base URL**：`http://<服务器IP>:23330`
- **数据格式**：请求体 `application/json`（文件上传为 `multipart/form-data`）
- **平台代号**：`kw`(酷我) `kg`(酷狗) `tx`(QQ音乐) `wy`(网易云) `mg`(咪咕)
- **音质代号**：`flac24bit` > `flac` > `320k` > `128k`

---

## 目录

- [鉴权](#鉴权)
- [1. 认证 Auth](#1-认证-auth)
- [2. 搜索 Search](#2-搜索-search)
- [3. 下载与任务 Download / Tasks](#3-下载与任务-download--tasks)
- [4. 音源管理 Sources](#4-音源管理-sources)
- [5. 设置 Settings](#5-设置-settings)
- [6. 实时事件 SSE](#6-实时事件-sse)
- [7. 状态 Status](#7-状态-status)
- [8. 歌单 Playlists](#8-歌单-playlists)
- [9. 用户与 FN ID 身份 Me / Gateway（v0.2.1）](#9-用户与-fn-id-身份-me--gatewayv021)
- [10. 本地音乐库 Library（v0.2.1）](#10-本地音乐库-libraryv021)
- [11. 健康冒烟 Health Smoke](#11-健康冒烟-health-smoke)
- [错误约定](#错误约定)
- [完整调用示例：搜索→下载→追踪](#完整调用示例搜索下载追踪)

---

## 鉴权

当 `config.yaml` 里 `auth.enabled: true` 时，除白名单外所有接口都需要鉴权。支持**两种方式**（任选其一）：

### 方式 A：Web 会话 Cookie（浏览器/前端）

先调 `POST /api/v1/auth/login`，响应会 `Set-Cookie: ro_sess=...`（HttpOnly，7 天）。后续请求带上该 Cookie 即可。

### 方式 B：API Key（脚本/程序调用，推荐）

在 Web 设置页生成 API Key（或调 `POST /api/v1/settings/apikey/generate`），然后在请求头带上，二选一：

```
X-API-Key: ro_xxxxxxxxxxxxxxxx
```
或
```
Authorization: Bearer ro_xxxxxxxxxxxxxxxx
```

**免鉴权白名单**（`auth.enabled=true` 时也放行）：`/login.html`、`/login.js`、`/style.css`、`/favicon.ico`、`POST /api/v1/auth/login`、`POST /api/v1/auth/gateway-login`（仅网关实例存在）、`GET /api/v1/auth/status`。

**未授权行为**：`/api/*` 返回 `401 JSON`；其它路径 `302` 跳转 `/login.html`。

> `auth.enabled: false` 时全部放行，适合纯内网可信环境。
>
> **v0.2.1 多用户说明**：经 fnOS 网关入口进入的请求携带网关注入的可信身份（`X-Trim-*` 头，仅网关 Unix Socket 实例采信，TCP 端口零采信防伪造）；每个用户有自己的 `uid`，歌单/播放历史/收藏/本地曲库均按 uid 隔离。端口直连与 API Key 通道的身份为管理员（uid=`legacy`，v0.2.0 语义不变）。详见 [docs/FNOS-DEPLOY.md](docs/FNOS-DEPLOY.md)。

---

## 1. 认证 Auth

### POST /api/v1/auth/login

登录并获取会话 Cookie。

**请求体**：
```json
{ "username": "admin", "password": "admin" }
```

**响应 200**：`{ "ok": true }`（并 `Set-Cookie: ro_sess=...`）

**错误**：
- `400` `{ "error": "尚未设置登录密码..." }`（config 里未设密码）
- `401` `{ "error": "用户名或密码错误" }`

```bash
curl -c cookie.txt -X POST http://127.0.0.1:23330/api/v1/auth/login \
  -H 'Content-Type: application/json' \
  -d '{"username":"admin","password":"admin"}'
```

### POST /api/v1/auth/gateway-login

**仅网关实例**（fnOS 统一网关 Unix Socket，`RO_GATEWAY_SOCK` 启用时）存在；TCP 实例上请求返回 `404`（防伪造红线）。无需请求体。

读取网关注入的可信身份头 `X-Trim-Userid` / `X-Trim-Username` / `X-Trim-Isadmin`，首次见到则建档（users 表），签发携带身份的 session Cookie。

**响应 200**：
```json
{ "ok": true, "user": { "uid": "1000", "username": "alice", "isAdmin": false } }
```
（并 `Set-Cookie: ro_sess=...`，7 天）

**错误**：`401` `{ "error": "缺少有效网关身份头（X-Trim-Userid / X-Trim-Username）" }`（uid 非数字/用户名空白同此）；`404`（TCP 实例，路由不存在）。

### POST /api/v1/auth/logout

登出，清除会话 Cookie。响应 `{ "ok": true }`。

### GET /api/v1/auth/status

查询鉴权状态（**免鉴权**，用于前端判断是否需登录；也是登录页探测网关模式的入口）。

**响应 200**：
```json
{
  "enabled": true,
  "authenticated": true,
  "passwordConfigured": true,
  "mode": "gateway",
  "user": { "uid": "1000", "username": "alice", "isAdmin": false }
}
```

> v0.2.1 新增字段（只增不改）：`mode` = `gateway` | `local`（请求落在哪个实例，前端据此切换 FN ID 直达卡/账密表单）；`user` = 已认证时的身份（未认证为 `null`；端口直连 admin 为 `{"uid":"legacy","username":"admin","isAdmin":true}`）。

---

## 2. 搜索 Search

> 所有搜索结果里的单曲对象（含 `songmid` / `name` / `singer` / `source` 等字段）可**原样**作为下载接口的 `musicInfo` 传入。

### GET /api/v1/search

单平台歌曲搜索。

**Query 参数**：

| 参数 | 必填 | 默认 | 说明 |
|---|---|---|---|
| `keyword` | 是 | — | 搜索关键词 |
| `platform` | 否 | `kw` | 平台代号 |
| `page` | 否 | `1` | 页码 |
| `limit` | 否 | 音源默认 | 每页条数 |

**错误**：`400` keyword 缺失 / platform 非法（返回 `valid` 平台列表）。

```bash
curl -b cookie.txt 'http://127.0.0.1:23330/api/v1/search?keyword=月亮之上&platform=kw&limit=5'
```

### GET /api/v1/search/aggregate

聚合搜索（多平台并发）。

**Query 参数**：`keyword`(必填)、`page`(默认1)、`limit`、`platforms`（逗号分隔，如 `kw,wy,mg`；省略=全平台）。

**响应**（结构示例）：
```json
{
  "keyword": "月亮之上",
  "page": 1,
  "results": [
    { "platform": "kw", "ok": true, "total": 30, "list": [ { "name": "月亮之上", "singer": "凤凰传奇", "source": "kw", "songmid": 107811, "albumName": "月亮之上", "interval": "4:31", "img": "...", "lrc": null } ] },
    { "platform": "kg", "ok": true, "total": 13, "list": [ ... ] }
  ]
}
```

单平台失败/超时（`search.timeoutMs`，默认 8s）只落该平台的 `ok:false` + `error`，不拖爆整体；结果按 `(keyword,page,platforms,limit)` 签名做 5 分钟内存缓存 + 并发 in-flight 去重。

> **#200 O4 错字容错**：当结果稀疏（各平台条数之和 `< search.correctMinResults`，默认 **3**）且 `search.correctEnabled` 为真（默认开）时，响应**可能**额外带两个字段：
>
> ```jsonc
> { "corrected": "晴天", "correctedFrom": "晴夭" }
> ```
>
> `corrected` = 建议的正确关键词；`correctedFrom` = 该建议对应的用户原始输入（trim 后）。**服务端不会自动替换用户原词**——`results` 里仍是按原词搜出来的结果，这两个字段只供前端做「已为你搜索 X，是否改搜 Y?」提示。纠错词典取自搜索历史全时段高频词（前 500，60s 内存缓存）；纠错计算抛错时**静默降级**（字段缺席），绝不影响主搜索。

```bash
curl -b cookie.txt 'http://127.0.0.1:23330/api/v1/search/aggregate?keyword=月亮之上&platforms=kw,wy,mg&limit=3'
```

### GET /api/v1/search/merged

#191 J1 **合并搜索视图**：在 `/search/aggregate` 之上做跨平台去重合并，同一曲目的多平台来源折叠为一条，并叠加相关度评分。搜索结果页**推荐直接用这个端点**（省去前端自行去重）。

**Query 参数**：同 `/search/aggregate` —— `keyword`(必填)、`page`(默认 1)、`limit`（缺省回落 `search.defaultLimit`，默认 30）、`platforms`（逗号分隔，省略 = 全平台）。

**去重规则**：主键 `name + singer`（归一化后比对）；辅键时长 `interval` 相差 ≤5s 视为同一首。每条合并结果挂 `sources[]`（全部来源，前端可折叠/展开后逐项换源下载），整体按 `score` 降序。

**响应 200**：
```json
{
  "keyword": "晴天",
  "page": 1,
  "total": 12,
  "list": [
    {
      "name": "晴天",
      "singer": "周杰伦",
      "albumName": "叶惠美",
      "img": "https://…/cover.jpg",
      "interval": "4:29",
      "qualities": ["flac24bit", "flac", "320k", "128k"],
      "score": 87.5,
      "sources": [
        {
          "platform": "kw",
          "songmid": "107811",
          "qualities": ["flac", "320k", "128k"],
          "songInfo": { "name": "晴天", "singer": "周杰伦", "source": "kw", "songmid": "107811", "types": […], "_types": {…} }
        }
      ]
    }
  ]
}
```

| 字段 | 说明 |
|---|---|
| `total` | **去重后**的合并条目数（= `list.length`，不是各平台条数之和）|
| `list[].qualities` | 该曲全部来源音质的**并集**（去重、按档位降序）|
| `list[].sources[].qualities` | 单个来源自身可达的音质（去重、降序）|
| `list[].sources[].songInfo` | 该平台**原始**单曲对象，可原样作为 `POST /api/v1/download` 的 `musicInfo` 传入 |
| `list[].score` | #191 J2 相关度评分（取代表来源打分，叠加 `search.platformWeights` 平台权重乘数），越大越相关 |

结果稀疏时同样可能带 `corrected` / `correctedFrom`（以**合并后**条目数判稀疏，语义同上）。

**错误**：`400` keyword 缺失 / `platforms` 含非法平台（返回 `valid` 平台列表）。

```bash
curl -b cookie.txt 'http://127.0.0.1:23330/api/v1/search/merged?keyword=晴天&platforms=kw,wy&limit=20'
```

### GET /api/v1/search/songlist

单平台**歌单**搜索。参数同 `/search`（`keyword` 必填、`platform`、`page`、`limit`）。

### GET /api/v1/search/songlist/aggregate

聚合歌单搜索。参数同 `/search/aggregate`。

### GET /api/v1/search/songlist/detail

获取歌单详情（含歌曲列表，可逐首或整单下载）。

**Query 参数**：`platform`(默认kw)、`id`(必填，歌单 ID)、`page`(默认1)。

```bash
curl -b cookie.txt 'http://127.0.0.1:23330/api/v1/search/songlist/detail?platform=kw&id=123456&page=1'
```

### GET /api/v1/search/suggest

P0 D2 **搜索联想**（输入框下拉建议）。数据源为三源复合：当前 uid 的搜索历史（`type: history`）+ 全局近 7 天热搜词（`type: hot`）+ 热门榜标题池（`type: title`，取 wy/tx/kg 三榜，`search.suggestPlatforms` 可配；单榜 8s 超时、5min 内存缓存）。按归一化后的 `text|singer` 复合键去重，**包含匹配**（不要求前缀）。

**Query 参数**：

| 参数 | 默认 | 说明 |
|---|---|---|
| `q` | — | 匹配词；**为空/缺省时直接返回空 `items`**（不做无词推荐）|
| `limit` | `10` | 返回条数上限；非正整数回落 10 |

**响应 200**：
```json
{ "q": "晴", "items": [ { "text": "晴天", "singer": "周杰伦", "type": "title" }, { "text": "晴朗", "type": "hot" } ] }
```

`items[].type` ∈ `history` | `hot` | `title`；`singer` 仅在有值时出现（通常来自 `title` 源）。未登录/鉴权关闭时 `history` 源自然为空，仅 `hot` + `title`。标题池抓取失败静默降级为空，**本端点不报错**。

### GET /api/v1/search/trending

P0 D3 **热搜榜**：全局搜索历史近 **7 天**词频 Top N。廉价 DB `GROUP BY` 直查保新鲜（**不做内存缓存**）。

**Query 参数**：`limit`（默认 10，非正整数回落 10）。

**响应 200**：`{ "items": [ { "text": "晴天", "count": 42 } ] }`（按 `count` 降序）

### GET /api/v1/search/related

P2 O5 **相关推荐**（「搜过 X 的人也搜 Y」）：基于 `search_cooccurrence` 全局共现统计，按共现频次降序、排除 `kw` 自身。冷启动（无共现数据）回退 trending 热门词（同样排除自身），仍为空则返回空数组——**绝不报错**。`search.relatedEnabled: false` 或 `kw` 为空时直接返回 `{ "related": [] }`。

**Query 参数**：`kw`（基准词）、`limit`（默认 10，非正整数回落 10）。

**响应 200**：`{ "related": [ { "kw": "七里香", "score": 7 } ] }`（`score` = 共现次数）

```bash
curl -b cookie.txt 'http://127.0.0.1:23330/api/v1/search/suggest?q=晴&limit=8'
curl -b cookie.txt 'http://127.0.0.1:23330/api/v1/search/trending?limit=10'
curl -b cookie.txt 'http://127.0.0.1:23330/api/v1/search/related?kw=晴天&limit=6'
```

### GET /api/v1/hot-playlists

热门歌单聚合（#60 首页数据源；#62 P1 酷狗扩展为 5 榜）：一次性返回 5 平台 10 张热歌榜单（平台交错序）。

**榜单清单**：wy 热歌榜(3778678) / tx 巅峰榜·热歌(26) / kg TOP500(top500) / tx 飙升榜(62) / kg 飙升榜(soar) / kw 酷我精选(虚拟) / kg 新歌榜(new) / mg 咪咕精选(虚拟) / kg 网络热歌榜(webhot) / kg 欧美榜(eur)。

- kg 榜 id 为语义 slug（`kg-top500`/`kg-soar` 等，对应原生 rankid 8888/6666/74534/82831/31310，55 榜全集 `m.kugou.com/rank/list` 实测）；与 wy 热歌/tx 双榜并列
- kw/mg 榜单接口不可用 → 固定热门关键词搜索拼装虚拟榜（`source: "virtual"`，不冒充官方榜）
- 单榜失败/超时(8s) → 该平台进 `errors`，其余照常返回（平台级隔离，同平台多榜去重报一条）
- 服务端内存缓存 5 分钟（并发去重；缓存签名含榜单集——清单变化即失效）；`songs` 每榜上限 50 首
- `songs[].songInfo` 与 `/api/v1/search` 的 list item **同构**，可原样作为下载接口的 `musicInfo` 传入（榜单歌零转换进下载/刮削链路）

**响应**（结构示例）：
```json
{
  "fetchedAt": 1787294899000,
  "playlists": [
    {
      "id": "wy-3778678",
      "platform": "wy",
      "nativeId": "3778678",
      "title": "热歌榜",
      "description": "云音乐中每天更新一次的热歌榜…",
      "coverUrl": "https://p1.music.126.net/….jpg",
      "updateTime": "2026-08-21",
      "updatedAt": "2026-08-21",
      "total": 200,
      "source": "toplist",
      "songs": [
        {
          "platform": "wy",
          "songmid": "1973665667",
          "title": "海屿你",
          "artist": "马也_Crabbit",
          "album": "海屿你",
          "interval": "3:52",
          "coverUrl": "http://p3.music.126.net/….jpg",
          "songInfo": { "name": "海屿你", "singer": "马也_Crabbit", "source": "wy", "songmid": "1973665667", "types": […], "_types": {…}, "typeUrl": {} }
        }
      ]
    }
  ],
  "errors": [ { "platform": "kg", "error": "kg: upstream timeout" } ]
}
```

```bash
curl -b cookie.txt 'http://127.0.0.1:23330/api/v1/hot-playlists'
```

### GET /api/v1/playlist-square

歌单广场聚合（#67 首页「精选歌单」分区数据源）：wy/tx 两平台广场轻量列表（**不含曲目**，详情 drill 复用 `/search/songlist/detail`）。平台矩阵实测依据：`docs/research/PLAYLIST-EXPANSION-RESEARCH.md` §1（wy 全绿主接入；tx 列表可用、详情约 75% 需容错；kg plist 已死不接入）。

**Query 参数**：

| 参数 | 默认 | 说明 |
|---|---|---|
| `platform` | `all` | `all`（wy+tx 按索引交错混合）/ `wy` / `tx` |
| `cat` | `全部` | 分类：**wy 分类词透传**（如 全部/华语/流行/摇滚/电子）；**tx 仅识别纯数字 sortId**（5=推荐 2=最热 3=最新），其他值固定 sortId=5（tx categoryId 体系与广场页不一致，10000001 实测为空 → 固定全部 10000000） |
| `page` | `1` | 翻页（供「换一批」）；wy=offset 步进、tx=sin/ein 步进，实测均零重叠 |
| `offset` | — | 与 `page` 等价的偏移写法（按 20/页换算，脚本直调用） |
| `limit` | `20` | 每平台拉取数（5–20 clamp；两平台分页步长一致） |

- 单平台失败/超时(8s) → 进 `errors` 不阻塞另一平台（同 hot-playlists 范式）
- 服务端内存缓存 5 分钟（in-flight 并发去重；键 = `platform|cat|page|limit`）
- 封面归一：wy `coverImgUrl` 原样；tx `imgurl` 末段小尺寸档升 300（qpic 300 档实测 HEAD 200），空值归 `null` → 前端 hp-fallback 径向渐变兜底
- **歌单详情零新端点**：卡片点击 → 现有 `GET /api/v1/search/songlist/detail?platform=wy|tx&id=<nativeId>`（`songs[].songInfo` 同构可进下载/收藏链路）；tx 推荐位 dissid 详情空 cdlist 时后端抛错 → 前端 toast「该歌单暂时无法获取详情，可能为平台推荐位限制」

**响应**（结构示例）：
```json
{
  "fetchedAt": 1787294899000,
  "platform": "all",
  "cat": "全部",
  "page": 1,
  "limit": 20,
  "playlists": [
    {
      "platform": "wy",
      "nativeId": "17990594711",
      "title": "纯音乐｜专注 放松 清新 氛围",
      "coverUrl": "http://p1.music.126.net/….jpg",
      "playCount": 175852,
      "trackCount": 60,
      "creator": "洛米Gemini",
      "category": "全部"
    }
  ],
  "total": 12303,
  "hasMore": true,
  "totals": { "wy": 683, "tx": 11620 },
  "errors": []
}
```

```bash
curl -b cookie.txt 'http://127.0.0.1:23330/api/v1/playlist-square?platform=all&cat=%E5%8D%8E%E8%AF%AD&page=2'
```

---

## 3. 下载与任务 Download / Tasks

### POST /api/v1/download

提交单首下载任务。

**请求体**：

| 字段 | 必填 | 默认 | 说明 |
|---|---|---|---|
| `platform` | 是 | — | 平台代号 |
| `musicInfo` | 是 | — | 搜索结果里的单曲对象，**必须含 `songmid` 和 `name`** |
| `quality` | 否 | `flac` | 目标音质（`flac24bit`/`flac`/`320k`/`128k`）|
| `primarySourceId` | 否 | — | 指定优先使用的音源 ID |
| `sourceIds` | 否 | — | 限定候选音源 ID 列表 |

**响应 201**：`{ "id": "<taskId>", "status": "pending" }`

**错误 400**：platform 非法 / musicInfo 缺 songmid|name / quality 非法（纯字符串形态 `{ "error": "<描述>", "valid": [...] }`）。

**错误 507 / 5xx（v0.2.21 起，结构化错误体）**：`enqueue` 已转 **async**，入队阶段的失败不再被吞掉，而是以结构化错误码返回：

```jsonc
// 507 Insufficient Storage —— N3 磁盘空间预检不足
{ "error": { "code": "ERR_DISK_FULL", "message": "磁盘可用空间不足（free 52428800 bytes < required 104857600 bytes）" } }
```

**N3 磁盘预检语义**（开关 `download.diskPrecheck`，默认开）：入队前用 `check-disk-space` 探测下载目录可用空间，低于 `download.minFreeBytes`（默认 **104857600 = 100MB**）即抛 `DiskFullError` → **507**，任务**不入库**。探测结果有 **2s 缓存**（批量入队不会逐首重复探测）；依赖缺失或探测异常时 **fail-open**（放行入队，不因预检自身故障堵住下载）。H5 去重命中（同 `platform+songmid+quality` 的在途/已完成任务）时直接复用既有任务，**不触发预检**。

**错误码 → HTTP 状态映射**（`errorToStatus`）：

| `errorCode` | HTTP | 含义 |
|---|---|---|
| `ERR_DISK_FULL` | `507` | 磁盘可用空间不足（入队预检 / 下载中写盘失败）|
| `ERR_NO_SOURCE` | `503` | 无可用音源 |
| `ERR_TIMEOUT` | `504` | 上游超时 |
| `ERR_BAD_REQUEST` | `400` | 请求参数问题 |
| `ERR_DNS` / `ERR_HTTP_4XX` / `ERR_HTTP_5XX` / `ERR_ALL_SOURCES_FAILED` / `ERR_TAG_EMBED` / `ERR_UNKNOWN` | `502` | 其余统一 502 |

```bash
curl -b cookie.txt -X POST http://127.0.0.1:23330/api/v1/download \
  -H 'Content-Type: application/json' \
  -d '{
    "platform": "kw",
    "quality": "flac",
    "musicInfo": { "name": "月亮之上", "singer": "凤凰传奇", "source": "kw", "songmid": 107811 }
  }'
```

### POST /api/v1/download/batch

批量下载（一次最多 **200** 首）。

**请求体**：
```json
{
  "quality": "flac",
  "primarySourceId": "real-source",
  "items": [
    { "platform": "kw", "musicInfo": { "name": "...", "songmid": 1, "singer": "...", "source": "kw" }, "quality": "320k" },
    { "platform": "wy", "musicInfo": { "name": "...", "songmid": 2, "singer": "...", "source": "wy" } }
  ]
}
```
每个 item 的 `quality` 可覆盖顶层默认。

**响应 201**：
```json
{ "batchId": "b-7f3c…", "acceptedCount": 2, "rejectedCount": 0,
  "accepted": [ { "index": 0, "id": "...", "name": "..." } ],
  "rejected": [] }
```

- `batchId`（H1）：本批共享的批次 id，可用于 `GET /api/v1/batches/:id` 与 `GET /api/v1/tasks?batchId=` 过滤；**全部 item 非法时 `batchId` 为 `null`、`acceptedCount` 为 0**（仍返回 201，逐条拒收原因在 `rejected[]`）
- 上限 `download.batchMaxItems`（H5，默认 **200**、可配）；超限 `400 { "error": "too many items (max 200)" }`
- `rejected[]` 元素为 `{ index, error }`（`index` = 请求 `items` 里的下标）

**错误 507（v0.2.21 起）**：**批量入队时任一歌曲磁盘预检失败 → 整批驳回**，返回同 `POST /download` 的结构化错误体：

```jsonc
{ "error": { "code": "ERR_DISK_FULL", "message": "磁盘可用空间不足（free … bytes < required … bytes）" } }
```

整批驳回**不产生部分入库**——不会出现「前 50 首已入队、后 150 首被拒」的中间态，前端可原样重试整批。

### GET /api/v1/tasks

任务列表（H4 分页 + 过滤；#196-fix2 补 `total`）。

**Query 参数**：

| 参数 | 默认 | 说明 |
|---|---|---|
| `status` | — | 过滤状态：`pending`/`active`/`completed`/`completed_with_warnings`/`failed`/`canceled` |
| `batchId` | — | 只看某批次（H1）|
| `limit` | `50` | 每页条数，clamp **1..500**（防内存炸裂；非法值回落默认）|
| `offset` | `0` | 偏移量（负数归 0）|

**响应 200**：
```json
{
  "tasks": [ { "id": "1662fe1d-…", "status": "completed", "…": "字段同 GET /tasks/:id" } ],
  "limit": 50, "offset": 0, "count": 50, "total": 137
}
```

`count` = 本页实际条数；`total` = **同条件下的全量计数**（不受分页上限影响；`status=completed_with_warnings` 归入 `completed` 计数），供前端分页判定。

### GET /api/v1/tasks/owned

#196-fix2 **轻量「已拥有」端点**：一次拿全量终态任务的拥有判定所需字段（**无分页**），供前端在搜索/歌单页批量标记「已下载」，避免拉整个 `/tasks` 列表。

**响应 200**：
```json
{ "owned": [ { "key": "kw:107811", "taskId": "1662fe1d-…", "status": "completed", "quality": "flac", "hasFile": true } ] }
```

| 字段 | 说明 |
|---|---|
| `key` | `"<platform>:<songmid>"` —— 前端按此键查表 |
| `taskId` | 对应任务 id |
| `status` | 任务状态（终态）|
| `quality` | **请求**音质（`requested_quality`）|
| `hasFile` | 是否已有落盘文件（`filePath` 非空）|

### GET /api/v1/tasks/:id

单任务详情。

**响应 200**（完整字段）：
```json
{
  "id": "1662fe1d-...",
  "platform": "kw",
  "songmid": "107811",
  "name": "月亮之上",
  "singer": "凤凰传奇",
  "album": "月亮之上",
  "requestedQuality": "flac",
  "actualQuality": "flac",
  "actualSource": "real-source",
  "status": "completed",
  "progress": 100,
  "filePath": "/app/data/downloads/月亮之上 - 凤凰传奇.flac",
  "fileSize": 34603008,
  "warnings": [],
  "error": null,
  "errorCode": null,
  "scrapeStatus": "success",
  "scrapeInfo": { "…": "见刮削章节" },
  "actualBitrate": 1411200,
  "actualCodec": "flac",
  "actualSampleRate": 44100,
  "batchId": null,
  "createdAt": 1787300000000,
  "updatedAt": 1787300012345
}
```

| 字段 | 说明 |
|---|---|
| `status` | `pending`/`active`/`completed`/`completed_with_warnings`/`failed`/`canceled`；换源成功时为 `completed_with_warnings`，`actualSource` 记为实际命中音源 |
| `requestedQuality` / `actualQuality` | 请求音质 vs 实际落地音质（降级时不同）|
| `warnings` | 字符串数组（换源/降级等提示），无则 `[]` |
| `error` / `errorCode` | **M1 结构化错误**：`error` = 人类可读 message（保留旧前端的纯字符串读取路径），`errorCode` ∈ `ERR_DNS`/`ERR_TIMEOUT`/`ERR_HTTP_4XX`/`ERR_HTTP_5XX`/`ERR_NO_SOURCE`/`ERR_ALL_SOURCES_FAILED`/`ERR_TAG_EMBED`/`ERR_DISK_FULL`/`ERR_BAD_REQUEST`/`ERR_UNKNOWN`；成功时两者均为 `null`。落盘为 `{code,message}` JSON，读旧数据（纯字符串）自动归 `ERR_UNKNOWN` + 原文 |
| `actualBitrate`/`actualCodec`/`actualSampleRate` | C2 真实音质回写（`music-metadata` 实测），未测得为 `null` |
| `scrapeStatus`/`scrapeInfo` | 元数据刮削状态与详情（见 `POST /tasks/:taskId/scrape`）|
| `batchId` | H1 批次 id；单首入队为 `null` |
| `createdAt`/`updatedAt` | 毫秒时间戳 |

**错误 404**：`{ "error": "task not found" }`

### GET /api/v1/tasks/:id/attempts

M2 **下载尝试审计轨迹**：每次换源 / 音质降级 / 队列重试都会追加一行，供前端「为什么失败」展开。写入为 **best-effort**，不阻断主下载流程。

**响应 200**：
```json
{
  "attempts": [
    { "task_id": "1662fe1d-…", "attempt_no": 1, "source_id": "src-a", "platform": "kw", "quality": "flac", "error_code": "ERR_HTTP_5XX", "ts": 1787300001000 },
    { "task_id": "1662fe1d-…", "attempt_no": 1, "source_id": "src-b", "platform": "kw", "quality": "320k", "error_code": null, "ts": 1787300004200 }
  ]
}
```

**`download_attempts` 行结构**（SQLite 表，带索引 `idx_attempts_task(task_id, ts)`）：

| 列 | 类型 | 说明 |
|---|---|---|
| `task_id` | TEXT | 所属任务 id |
| `attempt_no` | INTEGER | **队列重试轮次**，从 **1** 起；同一轮内换音源/换音质的多次尝试**共享同一 `attempt_no`** |
| `source_id` | TEXT | 本次尝试使用的音源 id |
| `platform` | TEXT | 平台代号 |
| `quality` | TEXT | 本次尝试请求的音质档位 |
| `error_code` | TEXT \| NULL | 失败错误码（同上枚举）；**命中成功的那一条为 `null`** |
| `ts` | INTEGER | 毫秒时间戳 |

排序固定 `ts ASC, id ASC`（时间正序，同毫秒按插入序）。任务存在但尚无尝试（未执行 / H5 去重复用）→ 返回**空数组**（不是 404）。`DELETE /api/v1/tasks/:id` 会**级联删除**该任务的全部 attempts 行。

**错误 404**：`{ "error": "task not found" }`

### POST /api/v1/tasks/:id/retry

重试失败任务。成功 `{ "id": "...", "status": "pending" }`；不可重试 `409`。

### POST /api/v1/tasks/:id/cancel

取消任务。成功 `{ "id": "...", "status": "canceled" }`；不可取消 `409`。

### DELETE /api/v1/tasks/:id

删除任务记录。成功 `{ "id": "...", "deleted": true }`；不存在 `404`。

> 同时**级联删除**该任务在 `download_attempts` 里的全部审计行（见 `GET /tasks/:id/attempts`）；已落盘的音频文件不动。

> **批次与队列（H1/H3）**：`POST /api/v1/download/batch` 与 `POST /api/v1/playlists/:id/download*` 入队的任务共享一个 `batchId`，下面五个端点提供批次维度的查看/整批操作与队列运行态控制。

### GET /api/v1/batches

H1 **批次汇总列表**（按批内最新活动时间倒序）。

**响应 200**：
```json
{
  "batches": [
    { "batch_id": "b-7f3c…", "total": 50, "pending": 3, "active": 1,
      "completed": 44, "failed": 2, "canceled": 0,
      "created_at": 1787300000000, "updated_at": 1787300600000 }
  ]
}
```

字段口径：`completed` **含** `completed_with_warnings`；`created_at` = 批内最早创建时间（`MIN`），`updated_at` = 批内最新活动时间（`MAX`）；只统计 `batch_id` 非空的任务（单首入队不在列）。

### GET /api/v1/batches/:id

H1 **批次详情**（含批内任务，上限 **500** 条）。

**响应 200**：
```json
{
  "batchId": "b-7f3c…", "total": 50,
  "pending": 3, "active": 1, "completed": 44, "failed": 2, "canceled": 0,
  "tasks": [ { "id": "1662fe1d-…", "status": "completed", "…": "字段同 GET /tasks/:id" } ]
}
```

**错误 404**：`{ "error": "batch not found or empty" }`（批次不存在或批内无任务）

### POST /api/v1/batches/:id/cancel

H1 **整批取消**（仅 `pending` / `active` 可取消；已终态的任务不动）。**限管理员**。同步清理激活缓冲里属于本批的未激活任务，避免已取消任务又被激活。

**响应 200**：`{ "batchId": "b-7f3c…", "canceled": 4 }`（`canceled` = 实际取消条数，可能为 0）

**错误 403**：`{ "error": "需要管理员权限" }`

### POST /api/v1/queue/pause

H3 **暂停出队**（限管理员）。只停止**调度新任务**，不影响已在途任务；与 RSS 内存护栏（`memPaused`）**相互独立**——两者任一为真则 p-queue 保持暂停，RSS 回落恢复时不会覆盖用户的暂停意图。

**响应 200** = 当前队列快照（结构同 `GET /api/v1/queue/status`）。错误 `403`。

### POST /api/v1/queue/resume

H3 **恢复出队**（限管理员）：仅当 RSS 护栏也未暂停时才真正恢复。

**响应 200** = 当前队列快照。错误 `403`。

### GET /api/v1/queue/status

H3 **队列运行态快照**（限管理员）。

**响应 200**：
```json
{
  "paused": false, "memPaused": false,
  "concurrency": 2, "scheduled": 50, "activationBuffer": 0, "running": 1,
  "pending": 3, "active": 1, "completed": 44, "failed": 2, "canceled": 0
}
```

| 字段 | 说明 |
|---|---|
| `paused` | 用户级暂停态（`POST /queue/pause` 置位）|
| `memPaused` | RSS 内存护栏暂停态（自动，与用户暂停独立）|
| `concurrency` | 当前并发度 |
| `scheduled` | 已调度进 p-queue 的任务数 |
| `activationBuffer` | 背压缓冲中等待激活的任务数（#6：p-queue 内同时激活 ≤ `download.batchActivationSize`，默认 200）|
| `running` | p-queue 正在执行的条数 |
| `pending`/`active`/`completed`/`failed`/`canceled` | 全库按状态精确计数（`completed` 含 `completed_with_warnings`）|

### GET /api/v1/preview

O1 **结果内试听**：取音源直链后 **302 重定向**过去（不落地、不占下载配额、不建任务）。与下载链路**共享**音源选择与限流（L1 健康排序 / L2 熔断 / L3 令牌桶都内建在 `resolveSourceOrder` 与 `sourceEngine.callAction` 里，本端点复用 orchestrator 自动继承）。

**刻意 `allowToggleSource: false`**：试听针对「这一首」，跨平台换源会换成另一首歌，语义不符（下载才需要换源兜底）。故 preview 命中失败即失败，**不做换源**。

**Query 参数**：

| 参数 | 必填 | 默认 | 说明 |
|---|---|---|---|
| `platform` | 是 | — | 平台代号 |
| `songmid` | 是 | — | 歌曲 mid（非空）|
| `quality` | 否 | `flac` | `flac24bit`/`flac`/`320k`/`128k` |
| `name` | 否 | 回落 `songmid` | 曲名（透传给音源脚本，可选）|
| `singer` | 否 | `""` | 歌手（透传给音源脚本，可选）|

**响应 302**：`Location: <音源直链>`，并带 `Cache-Control: no-store`（防浏览器/中间层缓存易失效的 CDN 直链），**无响应体**。

> 前端用法：把本 URL 直接塞进 `<audio src>`，浏览器自动跟随 302；脚本调用请加 `-L` 或直接读 `Location`。直链有时效，**不要缓存本端点的结果**。

**错误**（结构化错误体 `{ "error": { "code", "message" } }`）：

| HTTP | `code` | 触发 |
|---|---|---|
| `400` | `ERR_BAD_REQUEST` | `platform` 非法（附 `valid`）/ `songmid` 缺失或空白 / `quality` 非法（附 `valid`）|
| `503` | `ERR_NO_SOURCE` | 无可用音源 |
| `504` | `ERR_TIMEOUT` | 上游超时 |
| `502` | `ERR_ALL_SOURCES_FAILED` / `ERR_HTTP_4XX` / `ERR_HTTP_5XX` / `ERR_DNS` / `ERR_UNKNOWN` | 取直链失败（其余情形）|

```bash
curl -b cookie.txt -sI 'http://127.0.0.1:23330/api/v1/preview?platform=kw&songmid=107811&quality=320k'
# HTTP/1.1 302 Found
# location: https://…/xxx.mp3
# cache-control: no-store
```

### POST /api/v1/tasks/:taskId/scrape

对已完成任务触发元数据刮削：从音源平台拉取歌曲详情，补全年份/曲目号/碟号/流派等标签（**read-merge-write，只补缺不覆盖已有标签**）。任务对象相应增加 `scrapeStatus` / `scrapeInfo` 字段。

**Query**：`?force=true` —— 已 `success` 的任务也重新入队重刮（仍只补缺）。

**响应 202**：`{ "id": "<taskId>", "scrapeStatus": "pending" }`

**错误**：`404` 任务不存在；`409` 未完成 / 无文件 / 已刮过（需 `force`）/ 刮削功能未启用。

### POST /api/v1/scrape/all

一键刮削全部待处理任务（已完成、有文件、且未 `success`；`?force=true` 含已 `success`）。异步执行，进度经 SSE `scrape:progress` 推送。

**响应 202**：`{ "queued": <入队数>, "skipped": <跳过数> }`

### GET /api/v1/scrape/status

刮削运行态与状态分布统计。

```json
{
  "running": false, "activeTaskId": null, "queueSize": 0,
  "stats": { "none": 3, "pending": 0, "running": 0, "success": 2, "failed": 0, "skipped": 1 }
}
```

> `scrapeStatus` 状态机：`pending → running → success / failed(自动重试≤2) / skipped(确定性不刮)`。`scrapeInfo` 记录来源平台、补全字段、时间与错误信息；开启 `scrape.mbFallback`（默认开）时另含 `mbFallback: attempted|hit|miss` —— MusicBrainz L2 兜底 albumArtist 的尝试/命中/未命中标注（中文曲目命中率有限属预期）。

### POST /api/v1/scrape/reset

重置全部任务的刮削状态：`scrape_status` 置回 `pending`、`scrape_info` 清空。

- 仅清除数据库内部簿记，**不改动已写入音频文件的标签**，也不影响任务本身状态；
- 重置后这些任务会被「刮削全部待处理」重新纳入（标签只补缺，已写过的字段不会重复写）；
- 设置页「元数据刮削 → 状态重置」按钮即调此接口（confirm 确认后）。

**响应 200**：`{ "reset": <实际发生变化的行数> }`（本就 pending 且无记录的行不计入）

```bash
curl -b cookie.txt -X POST http://127.0.0.1:23330/api/v1/scrape/reset
# → { "reset": 12 }
```

### GET /api/v1/play/:taskId

流式播放已完成任务的音频文件（供 `<audio>` 标签直接引用，同源 Cookie 自动携带）。

**前置条件**：任务状态必须为 `completed` 或 `completed_with_warnings`，且 `file_path` 文件实际存在于 `download.dir` 之内。

**Range 支持**：完整支持 HTTP Range（`bytes=start-end` / `bytes=start-` / `bytes=-suffix` 单段），支持拖动进度条/断点续拖：

- 不带 `Range` → `200` 全量响应，带 `Accept-Ranges: bytes`
- 带合法 `Range` → `206 Partial Content`，带 `Content-Range: bytes <start>-<end>/<total>` 与对应 `Content-Length`
- `Range` 不可满足 → `416`，带 `Content-Range: bytes */<total>`

**Content-Type** 按文件扩展名：`.mp3` → `audio/mpeg`，`.flac` → `audio/flac`，其余 `audio/*`。

**响应 206（示例头）**：
```http
HTTP/1.1 206 Partial Content
Content-Type: audio/mpeg
Accept-Ranges: bytes
Content-Range: bytes 0-1023/8452310
Content-Length: 1024
```

**错误码**：

| 状态码 | 含义 |
|---|---|
| `401` | 未授权（全局守卫，同其它接口） |
| `404` | 任务不存在 |
| `409` | 任务未完成（pending/active/failed/canceled），不可播放 |
| `410` | 任务文件缺失（file_path 为空/被删除/越出 download.dir） |
| `416` | Range 不可满足 |

```bash
curl -b cookie.txt -I http://127.0.0.1:23330/api/v1/play/<taskId>
curl -b cookie.txt -H 'Range: bytes=0-1023' -o chunk.bin http://127.0.0.1:23330/api/v1/play/<taskId>
```

### GET /api/v1/cover/:taskId

取任务的歌曲封面（供 `<img>` 标签直接引用，同源 Cookie 自动携带；鉴权与 play 一致）。
按以下顺序解析，前端 `onerror` 时回退装饰位：

1. **嵌入封面**：任务已完成且为 MP3 → 读取 ID3 `APIC` 帧 → `200 image/jpeg`（或实际 mime），带 `Cache-Control: private, max-age=86400`（FLAC 嵌入封面暂不支持读取）
2. **音源封面直链**：入队时落库的 `music_info.musicInfo.img`（tx/wy/mg 搜索结果自带 500x500 直链）→ `302` 重定向到该 URL，浏览器直连
3. 两者皆无 → `404 { "error": "no cover available" }`

**错误码**：

| 状态码 | 含义 |
|---|---|
| `401` | 未授权（全局守卫，同其它接口） |
| `404` | 任务不存在 / 无可用封面 |

```bash
curl -b cookie.txt -o cover.jpg -w '%{http_code} %{content_type}\n' http://127.0.0.1:23330/api/v1/cover/<taskId>
```

### GET /api/v1/lyric/:taskId

取任务的歌曲歌词（原始 lrc 文本，含 `[mm:ss.xx]` 时间轴；前端解析后渲染滚动歌词，鉴权与 play/cover 一致）。
歌词与下载嵌入、冒烟测试共用同一内核（各平台官方接口，不走音源）：

1. 解析任务入队时落库的 `music_info`（`platform` + `musicInfo.songmid` 等）→ 按平台拉取 lrc
2. 拉取成功且非空 → `200 { "lyric": "[00:00.00]...\n[00:12.50]..." }`，带 `Cache-Control: private, max-age=86400`（歌词对同一任务不可变）
3. 任务不存在 → `404 { "error": "task not found" }`
4. 平台不支持 / payload 损坏 / 上游无歌词 → `404 { "error": "no lyric available" }`

服务端内存 LRU 缓存（容量 100，key=taskId，含「无歌词」负缓存）避免重复拉取；重启后缓存重建。

**错误码**：

| 状态码 | 含义 |
|---|---|
| `401` | 未授权（全局守卫，同其它接口） |
| `404` | 任务不存在 / 无可用歌词 |

```bash
curl -b cookie.txt http://127.0.0.1:23330/api/v1/lyric/<taskId>
```

---

## 4. 音源管理 Sources

### GET /api/v1/sources

音源列表（含状态/平台/音质）。

**响应**：
```json
{ "sources": [ {
  "id": "real-source", "name": "[独家音源]", "description": "...",
  "version": "4", "author": "...", "homepage": "",
  "status": "ready", "enabled": true, "errorMessage": null,
  "platforms": [ { "platform": "kw", "actions": ["musicUrl"], "qualitys": ["128k","320k","flac","flac24bit"] } ]
} ] }
```

### GET /api/v1/sources/capabilities

C4 **音质能力查询**：聚合全部「就绪（`status: ready`）且已启用（`enabled: true`）且声明了该平台」的音源，给出该平台四档音质的**可达性并集**与音源清单。前端可据此置灰不可选的音质档位。

**Query 参数**：`platform`（**必填**）。

**响应 200**：
```json
{
  "platform": "kw",
  "qualities": { "flac24bit": false, "flac": true, "320k": true, "128k": true },
  "sources": [
    { "id": "real-source", "name": "[独家音源]", "qualities": ["128k", "320k", "flac"] }
  ]
}
```

- `qualities` 四档固定全量回传（`flac24bit`/`flac`/`320k`/`128k`），只要**任一**就绪启用音源声明了该档就置 `true`
- `sources[]` 只列该平台可用的音源，`qualities` 为该音源**自身声明**的原始档位数组（未做并集/排序加工）
- 无匹配音源时返回全 `false` 的 `qualities` 与空 `sources`（**不报错**）
- 本端点为 **GET 可读**（不限管理员，与 `GET /api/v1/sources` 同口径）

**错误 400**：`{ "error": "platform query parameter is required" }`（`platform` 缺失）

```bash
curl -b cookie.txt 'http://127.0.0.1:23330/api/v1/sources/capabilities?platform=kw'
```

### POST /api/v1/sources/import/content

粘贴脚本内容导入。请求体 `{ "name": "可选", "content": "<音源脚本源码>" }`。成功 `201` 返回音源视图；`content` 缺失 `400`。

### POST /api/v1/sources/import/url

在线 URL 导入。请求体 `{ "url": "https://...", "name": "可选" }`。成功 `201`；`url` 缺失 `400`。

### POST /api/v1/sources/upload

文件上传（`multipart/form-data`，字段为文件）。成功 `201`。

```bash
curl -b cookie.txt -X POST http://127.0.0.1:23330/api/v1/sources/upload \
  -F 'file=@real-source.js'
```

### PATCH /api/v1/sources/:id/enabled

启停音源。请求体 `{ "enabled": true|false }`。成功 `{ "id": "...", "enabled": true }`；缺字段 `400`；不存在 `404`。

> #56 起 `enabled` 持久化到 SQLite meta 表（key `sourceEnabled`）：热重载 `loadAll()` 与服务重启后自动恢复，不再被重置为 true。

### POST /api/v1/sources/:id/reload

热重载单个音源。成功返回音源视图；不存在 `404`。

### POST /api/v1/sources/smoke

#56 一键快速冒烟：对每个「就绪且启用」的音源逐平台（kw/kg/tx/wy/mg）执行 `search（固定关键词「周杰伦 晴天」，同平台结果缓存复用）→ musicUrl(128k, 15s 超时) → HEAD/Range 探测（3s 超时；HEAD 被 405/501 拒时回退 Range GET）`，**同步等待全部完成或整体预算耗尽后返回**（最长约 60s）。并发控制：音源串行、同音源内平台并行 ≤3；与定时全量冒烟（`POST /api/v1/health/smoke/run`）互斥。不落库、不告警。

**响应 200**（`matrix` 行 = 启用音源 × 全部五平台，含未声明平台的 `"-"` 格子）:
```json
{
  "keyword": "周杰伦 晴天",
  "startedAt": 1761234567890, "finishedAt": 1761234573210, "durationMs": 5320,
  "timeout": false,
  "total": 25, "passed": 12, "failed": 11,
  "matrix": [
    { "source": "pdone-flower", "platform": "wy", "search": "ok", "url": "ok", "latencyMs": 812, "error": null },
    { "source": "pdone-flower", "platform": "kw", "search": "ok", "url": "fail", "latencyMs": 240, "error": "HTTP 410" },
    { "source": "pdone-grass", "platform": "kg", "search": "ok", "url": "-", "latencyMs": 0, "error": null }
  ]
}
```

字段口径：`search`/`url` ∈ `ok|fail|-`（`-` = 未测：平台未被该音源声明，或 search 失败未走到取链）；`latencyMs` = musicUrl+探测链路耗时（search fail 的格子记 search 耗时）；`passed` = search 且 url 均 ok 的格子数，`failed` = 任一 fail 的格子数。错误：`409`（已有快速/全量冒烟在跑），`500`（执行异常）。

### DELETE /api/v1/sources/:id

删除音源（同步清理其持久化启停状态）。成功 `{ "id": "...", "deleted": true }`；不存在 `404`。

---

## 5. 设置 Settings

> **安全**：`apiKey` 与 `webLogin.password` 永不回传明文，只回传是否已设置（布尔）。空字符串的密钥字段视为「不修改」。

### GET /api/v1/settings

返回脱敏配置视图（对应 `server/src/routes/settings.ts` 的 `safeView()`，六个顶层块恒全部出现）。

```json
{
  "auth": { "apiKeySet": true },
  "download": {
    "concurrency": 3, "defaultQuality": "flac", "nameTemplate": "{name} - {singer}",
    "embedCover": true, "embedLyric": true, "coverSize": 500,
    "resolvedDir": "/vol1/1000/downloads", "startupResolvedDir": "/vol1/1000/downloads",
    "dirTemplate": "", "dedupePolicy": "skip", "batchMaxItems": 200, "resume": true,
    "diskPrecheck": true, "minFreeBytes": 104857600
  },
  "sources": { "healthAware": true, "circuitThreshold": 5, "circuitWindowMs": 300000, "ratePerMin": 0 },
  "scrape": { "enabled": true, "autoOnComplete": true },
  "search": {
    "platformWeights": { "kw": 1, "kg": 1, "tx": 1.1, "wy": 1, "mg": 0.9 },
    "suggestPlatforms": ["wy", "tx", "kg"],
    "correctEnabled": true, "correctMinResults": 3, "relatedEnabled": true
  },
  "smokeTest": { "enabled": true, "cron": "0 6 * * *", "keyword": "周杰伦", "checkLyric": true, "checkPic": true, "alertThreshold": 2,
    "alert": { "bark": { "enabled": false, "serverUrl": "https://api.day.app", "deviceKeySet": false }, "serverChan": { "enabled": false, "sendKeySet": false } } }
}
```

> **字段说明**：`download.resolvedDir` = 当前解析后的绝对下载目录，`download.startupResolvedDir` = 本进程启动时快照，两者不一致 → 前端显示「待重启」角标。`sources.*` 即 L1/L2/L3 三层音源质量闸门的可调参（`healthAware`=L1 健康排序开关、`circuitThreshold`/`circuitWindowMs`=L2 熔断阈值与滑动窗口、`ratePerMin`=L3 每音源令牌桶限速且 **0=禁用**）；机制详见 `docs/DEVELOPMENT.md` 「音源质量闸门 L1/L2/L3」。`search.platformWeights`/`suggestPlatforms` 为相关度评分权重与联想取榜平台，`correctEnabled`/`correctMinResults`/`relatedEnabled` 为错字容错与相关推荐开关。

> **契约注（#126 评审 m2；#127 起口径更新）**：`smokeTest` 块及其下各字段（含 `alert.bark` / `alert.serverChan` 子树）**恒出现**，不随 `config.yaml` 是否写了 `smokeTest:` 而缺省。自 #127 起 `loadConfig()` 会把 YAML 与内置默认值（`server/src/core/config.ts` 的 `buildDefaultConfig()`，口径同 `config.example.yaml`）**深合并**，故 `config.yaml` 里**缺字段或写成空值**（`enabled:` → YAML `null`）时一律回落内置默认值：`enabled` / `checkLyric` / `checkPic` → `true`，`alert.bark.enabled` / `alert.serverChan.enabled` → `false`，`cron` → `0 6 * * *`，`keyword` → `周杰伦`，`alertThreshold` → `2`，`bark.serverUrl` → `https://api.day.app`。**要关掉某项必须显式写 `false`，留空等于用默认值。**（#127 之前是「缺省/空值一律回落 `false`」，此为有意的行为变更；真机 `.fpk` 的 `config.yaml` 由安装回调渲染、恒含完整块，故对真机部署零影响。）展示层用 `=== true` 判定，调度器 `scheduler.ts` 用 `if (!config.smokeTest.enabled) return` 判定，深合并后两者拿到的是**同一个非 null 布尔值**，恒同真假——不会重现「UI 显示启用、调度器实际禁用」的背离。**密钥字段只回传 `*Set` 布尔**（`deviceKeySet` / `sendKeySet` / `apiKeySet`）；`auth.webLogin.password` 的合并默认值恒为**空串**而非随机强密码，故未配密码时 `isPasswordConfigured()` 仍为 `false`、登录接口仍返回 400「尚未设置登录密码…」的明确提示（随机强密码只在配置文件本身不存在、由首启自动生成时产生，并仅在日志打印一次）。即：该端点恒返回 200 且结构完整，前端可直接按上表结构取值，无需再做存在性判断。

### PATCH /api/v1/settings

局部更新配置（下载 / 音源闸门 / 刮削 / 搜索 / 冒烟测试 / 告警）。只传要改的字段。

**校验规则**（越界一律 `400` + `{ "error": "…" }`）：
- `download.concurrency`：1–10 整数
- `download.defaultQuality`：须为四种音质之一（`flac24bit` / `flac` / `320k` / `128k`）
- `download.coverSize`：100–1000 整数
- `download.dir` / 顶层 `downloadDir`：字符串、trim 后非空、≤512 字符、不含控制字符（相对路径相对项目根解析，绝对路径原样使用）
- `download.dedupePolicy`：`skip` / `replace` / `always-new` 三选一
- `download.batchMaxItems`：1–1000 整数
- `download.minFreeBytes`：0 – 1TB（1099511627776）的整数（0=不限制）
- `download.resume` / `download.diskPrecheck`：布尔值
- `download.dirTemplate`：字符串、≤512 字符、不含控制字符（`''`=平铺合法）
- `sources.healthAware`：布尔值
- `sources.circuitThreshold`：1–100 整数
- `sources.circuitWindowMs`：1000–3600000 整数（1s–1h）
- `sources.ratePerMin`：0–100000 整数（**0 = 不限速**）
- `search.platformWeights`：对象，键∈五平台，值为 0–5 的数值
- `search.suggestPlatforms`：数组，元素∈五平台
- `search.correctMinResults`：1–50 整数
- `search.correctEnabled` / `search.relatedEnabled`：布尔值

> **未做服务端校验的字段**：`smokeTest.*`（含 `cron` / `alertThreshold` / `keyword` / `enabled` / `checkLyric` / `checkPic` / `alert.*`）与 `scrape.*` 在本端点**不做强校验**，直接深合并落盘。非法 `cron` 表达式不返回 400，而是在重排调度时被 `scheduler.ts` 的 `cron.validate()` 拦下——该次不启动调度器、只记 `warn` 日志（旧任务已在 `startSmokeScheduler()` 入口被 `stopSmokeScheduler()` 停掉，故结果是「定时冒烟静默不跑」）。告警阈值请用 `GET /api/v1/health/smoke` 反推，不要依赖 PATCH 报错。

```bash
curl -b cookie.txt -X PATCH http://127.0.0.1:23330/api/v1/settings \
  -H 'Content-Type: application/json' \
  -d '{ "download": { "concurrency": 5, "defaultQuality": "320k" } }'
```
并发变化即时生效（`downloadQueue.setConcurrency()`）；`smokeTest.cron`/`enabled` 变化会重排定时任务（`rescheduleSmoke()`）；`sources.*` 变化**无需重排也无需重启**：L1 开关与 L2 阈值在每次取链/每次记录失败时实时读 `config`（L1 健康快照另有 30s 内存缓存 TTL），L3 在每次取令牌时实时读 `ratePerMin`（已有桶的存量令牌不清零）。L2 熔断计数是**进程内存态**、不持久化，重启即清零。响应返回更新后的脱敏视图。

### POST /api/v1/settings/apikey/generate

生成新的 API Key（`ro_` + 32 字节 base64url）。**明文仅在本次响应返回一次**，之后只能看到 `apiKeySet=true`。

**响应**：`{ "apiKey": "ro_xxxx...", "once": true }`

> 生成即覆盖旧 Key。请立即保存。

### DELETE /api/v1/settings/apikey

撤销当前 API Key。响应 `{ "ok": true, "apiKeySet": false }`。

### POST /api/v1/settings/notify/test

发送测试告警（Bark / Server酱，按 config 配置的渠道）。请求体可选 `{ "title": "...", "body": "..." }`。响应 `{ "results": [...] }`。

---

## 6. 实时事件 SSE

### GET /api/v1/sse/subscribe

Server-Sent Events 事件流。`Content-Type: text/event-stream`，服务端每 15s 发送 `: ping` 心跳注释行防断连。

**首包**：`event: connected` + `data: { "ts": <毫秒> }`

**事件类型**：

| 事件 | 触发 |
|---|---|
| `task:created` | 任务创建 |
| `task:active` | 任务开始下载 |
| `task:progress` | 下载进度更新 |
| `task:completed` | 下载完成 |
| `task:completed_with_warnings` | 完成（触发过换源等警告）|
| `task:failed` | 下载失败 |
| `task:canceled` | 任务取消 |
| `source:changed` | 音源目录变更/重载 |
| `source:update-alert` | 音源更新提醒 |
| `smoke:completed` | 冒烟测试完成 |
| `smoke:failed` | 冒烟测试失败 |
| `scrape:update` | 单任务刮削状态变更（含 `taskId`/`status`/`fieldsWritten`/`source`/`error`）|
| `scrape:progress` | 批量刮削进度（`{ "done": n, "total": m }`）|
| `scan:progress` | 本地音乐库扫描进度（v0.2.1，**按 uid 定向推送**：仅同用户连接收到）：`{ "phase": "walk\|meta\|done", "scanned": n, "total": m\|null, "added": n, "updated": n, "removed": n, "currentRoot": "...\|null", "metaDone": n, "last": {...} }`，节流约 500ms；`done` 后附带 `last` 最近一轮结果 |

每条事件格式：`event: <name>\ndata: <json>\n\n`。

> **断线重连**后应调一次 `GET /api/v1/tasks` 做全量对账，避免漏事件。

```javascript
const es = new EventSource('http://127.0.0.1:23330/api/v1/sse/subscribe', { withCredentials: true })
es.addEventListener('task:progress', e => console.log('进度', JSON.parse(e.data)))
es.addEventListener('task:completed', e => console.log('完成', JSON.parse(e.data)))
```
> 注意：原生 `EventSource` 不支持自定义请求头，API Key 场景建议用会话 Cookie，或改用支持 header 的 SSE 客户端（如 `fetch` 流式读取）。

---

## 7. 状态 Status

### GET /api/v1/status

服务健康与运行指标（也是容器 healthcheck 探测的端点）。

**响应 200**：
```json
{
  "app": "ro", "version": "0.2.23", "uptimeSec": 3600,
  "node": "v22.x.x", "memoryMB": 198,
  "sources": { "loaded": 1, "ready": 1 },
  "tasks": { "pending": 0, "active": 1, "completed": 12, "failed": 0 },
  "gatewayHealth": {
    "status": "suspected-unregistered",
    "suspectedUnregistered": true,
    "recentlyInstalled": false,
    "totalRequests": 23,
    "gatewayRequests": 0,
    "startedAt": "2026-08-31T12:00:00.000Z",
    "firstRequestAt": "2026-08-31T12:05:11.000Z",
    "lastGatewayRequestAt": null,
    "installMarkerAt": "2026-08-31T11:58:40.000Z"
  }
}
```
> 开启鉴权时未授权访问返回 `401`（healthcheck 视 401 为「存活」，仅连接失败判宕机）。
>
> `gatewayHealth`（v0.2.12）：网关注册诊断（全内存被动统计 + install marker 现算，
> 公开计数无敏感信息；网关 404 时用户走直连也可读取——正是诊断目标场景；
> v0.2.13 起本端点免登录，见 PUBLIC_PATHS）。
> `status` 取值：`ok`（已有网关流量，注册且转发正常）/ `waiting`（刚安装宽限，
> sacentry 同步周期最长约 30 分钟）/ `suspected-unregistered`（运行 >10 分钟且
> 有 API 流量但零网关流量——从飞牛桌面打开将 404）/ `unknown`（流量为零无从
> 判断；或直连流量存在但观察窗未满）。网关流量按实例级判定（网关 Unix Socket
> 实例收到的 `/api/v1/*` 请求），静态资源不计；install marker 由 fpk
> install_callback 写入 `@appdata` 的 `data/db/install.marker`（v0.2.13 起落在
> compose 已挂载子目录——fnOS 仅挂载 data 三个子目录而非 data 根；每次安装与
> 升级均写入——t111 实证 fnOS 手动升级为完整重装链（install/upgrade 双跑），
> 升级后同样进入 waiting 宽限；非 fpk 部署无此文件时 `installMarkerAt` 为
> null）。详见
> `docs/FNOS-DEPLOY.md` 与 `docs/FNOS-FEEDBACK.md`。

---

## 8. 歌单 Playlists

> 本章为 #57 补录（路由实际存在但此前未收录入档）。歌单内曲目顺序 = 加入顺序（`GET /:id` 的 `items[]` 即展示序）。

端点总览：

| 端点 | 说明 |
|---|---|
| `GET /api/v1/playlists` | 歌单列表（含 `count`，按更新时间倒序） |
| `POST /api/v1/playlists` | 创建 `{ name, description? }` → `201` 歌单对象 |
| `POST /api/v1/playlists/import` | 批量导入建单（#66，发现页榜单/平台歌单一键保存）：`{ title, description?, songs: [{ platform, musicInfo }] }` → `201` |
| `GET /api/v1/playlists/:id` | 歌单详情（`items[]` 按加入顺序，含完整 `musicInfo`） |
| `PATCH /api/v1/playlists/:id` | 改名 `{ name, description? }` |
| `DELETE /api/v1/playlists/:id` | 删除歌单及其全部曲目 |
| `POST /api/v1/playlists/:id/items` | 添加歌曲 `{ platform, musicInfo }`（同歌单内 `(platform, songmid)` 去重；已存在返回 `200 {"added":false}`，新增返回 `201`） |
| `DELETE /api/v1/playlists/:id/items/:itemId` | 移除歌曲 |
| `POST /api/v1/playlists/:id/download` | 整单批量下载 `{ quality? }`（H2：共享单一 `batchId`，返回 `accepted[]`；磁盘预检不足可返回 **507**）|
| `POST /api/v1/playlists/:id/download-missing` | H2 **仅下未拥有项**：跳过已有落盘文件的完成曲，返回 `accepted[]` + `skipped[]` |

### POST /api/v1/playlists/import

批量导入建单（#66：单请求事务内建单 + 逐首入单，避免前端逐首 50 次 `POST /:id/items` 往返）。

**请求体**：
```json
{
  "title": "热歌榜",
  "description": "来自发现页 · 网易云 · 2026-08-24",
  "songs": [
    { "platform": "wy", "musicInfo": { "name": "海屿你", "singer": "马也_Crabbit", "source": "wy", "songmid": "1973665667", "types": [] } }
  ]
}
```

- `title` 必填；`songs` 非空数组，**最多 200 首**；每个元素与 `POST /:id/items` 的 body 同构（`{ platform, musicInfo }`，`musicInfo` 必须含 `songmid` 与 `name`），另兼容直接传 `MusicInfo`（此时 `platform` 缺省取 `musicInfo.source`）
- `musicInfo` 与 `GET /api/v1/search` 的 list item 同构——发现页 `hot-playlists` 的 `songs[].songInfo` 可原样传入（零转换）
- 重名处理：同名歌单已存在时自动加后缀「`title (2)`」「`title (3)`」…，响应 `renamed: true`
- 同批内 `(platform, songmid)` 重复自动去重（计入 `skippedCount`）；非法元素逐条拒收（计入 `rejected[]`），不影响其余歌曲

**响应 201**：
```json
{
  "id": "<uuid>", "name": "热歌榜", "description": "…",
  "created_at": 1787300000000, "updated_at": 1787300000000,
  "count": 50, "addedCount": 50, "skippedCount": 0,
  "renamed": false, "rejectedCount": 0, "rejected": []
}
```

**错误**：`400` title 缺失 / `songs` 非非空数组 / 超过 200 首 / 全部元素非法（`{ error: 'no valid song in songs', rejected }`）。

**调用示例**：
```bash
curl -b cookie.txt -X POST "$BASE/api/v1/playlists/import" \
  -H 'Content-Type: application/json' \
  -d '{"title":"热歌榜","songs":[{"platform":"wy","musicInfo":{"name":"海屿你","singer":"马也_Crabbit","source":"wy","songmid":"1973665667"}}]}'
```

### POST /api/v1/playlists/:id/download

H2 **整单批量下载**：把歌单里全部曲目一次性入队（共享单一 `batchId`，可用 `GET /api/v1/batches/:id` 跟踪整批进度）。

**请求体**：`{ "quality": "flac" }` —— `quality` 可选，缺省 `flac`；取值 `flac24bit`/`flac`/`320k`/`128k`。

**响应 201**：
```json
{
  "batchId": "b-9a1e…",
  "acceptedCount": 12,
  "accepted": [ { "id": "1662fe1d-…", "name": "晴天" } ]
}
```

> 与 `POST /api/v1/download/batch` 的差异：本端点从歌单取曲，**不做逐条参数校验**（曲目已是合法入库数据），因此没有 `rejected[]`；`accepted[]` 元素也没有 `index`（按歌单曲目顺序）。

**错误**：
```jsonc
{ "error": "playlist not found" }                                  // 404（或不属于当前 uid）
{ "error": "invalid quality", "valid": ["flac24bit","flac","320k","128k"] }  // 400
{ "error": "playlist is empty" }                                   // 400 歌单无曲目
{ "error": "no downloadable item in playlist" }                    // 400 曲目均无合法平台
// 507（v0.2.21 起）—— N3 磁盘预检不足，整单不入队
{ "error": { "code": "ERR_DISK_FULL", "message": "磁盘可用空间不足（free … bytes < required … bytes）" } }
```

```bash
curl -b cookie.txt -X POST "$BASE/api/v1/playlists/$PID/download" \
  -H 'Content-Type: application/json' -d '{"quality":"320k"}'
```

### POST /api/v1/playlists/:id/download-missing

H2 **仅下载未拥有项**：逐曲用 `taskStore.findCompletedWithFile(platform, songmid)` 判「已拥有」（已完成且带落盘文件），已有的直接跳过，**不重复下载**。

**请求体**：`{ "quality": "flac" }`（同上）。

**响应 201**（有项入队）：
```json
{
  "batchId": "b-9a1e…",
  "acceptedCount": 3,
  "skippedCount": 9,
  "accepted": [ { "id": "1662fe1d-…", "name": "晴天" } ],
  "skipped": [ { "name": "七里香", "songmid": "107812", "reason": "already-owned" } ]
}
```

**响应 200**（全部已拥有，**注意状态码与上面不同**）：
```json
{
  "batchId": null, "acceptedCount": 0, "skippedCount": 12,
  "accepted": [], "skipped": [ { "name": "…", "songmid": "…", "reason": "already-owned" } ]
}
```

> 前端判「本次有无新入队」请看 **HTTP 状态码**（`201` = 有入队，`200` = 全跳过）或 `acceptedCount > 0`，不要只看 `batchId`。`skipped[].reason` 目前只有 `already-owned` 一种取值。

**错误**：同 `POST /:id/download`（404 / 400 / **507 ERR_DISK_FULL**，507 时同样整单不入队）。

```bash
curl -b cookie.txt -X POST "$BASE/api/v1/playlists/$PID/download-missing" \
  -H 'Content-Type: application/json' -d '{"quality":"flac"}'
```

### PUT /api/v1/playlists/:id/items/order

重排歌单曲目顺序（前端拖拽排序落库，#57）。**幂等**：传入同一顺序重复调用结果一致。

实现取舍：零 schema 改动——曲目顺序由 `created_at` 升序表达，重排在事务内按新顺序重写时间戳（`created_at` 不在任何响应中暴露，语义损失可接受；避免已部署库的 `position` 列迁移）。

**请求体**：`{ "itemIds": ["<itemId>", ...] }` —— 必须与该歌单现有曲目的 id **集合完全一致**（不多、不少、不重复），防部分重排丢歌。

**响应 200**：
```json
{ "id": "<playlistId>", "reordered": true, "count": 12 }
```

**错误**：
```jsonc
// 404 歌单不存在
{ "error": "playlist not found" }
// 400 itemIds 非数组 / 空数组
{ "error": "itemIds (non-empty array) is required" }
// 400 长度或去重后数量与现集不符（缺项 / 重复）
{ "error": "itemIds must cover the current item set exactly (no missing, no duplicates, no unknown ids)", "current": 12, "received": 11 }
// 400 含未知 id
{ "error": "itemIds contains unknown item id(s)", "current": 12, "received": 12 }
```

**调用示例**：
```bash
curl -X PUT "$BASE/api/v1/playlists/$PID/items/order" \
  -H "Authorization: Bearer $KEY" -H "Content-Type: application/json" \
  -d '{"itemIds":["id-3","id-1","id-2"]}'
# → { "id": "...", "reordered": true, "count": 3 }
# 之后 GET /api/v1/playlists/$PID 的 items[] 顺序即为 id-3, id-1, id-2
```

---

## 9. 用户与 FN ID 身份 Me / Gateway（v0.2.1）

多用户个性化端点：全部按请求身份的 `uid` 隔离（网关用户各自独立；端口直连 admin / API Key 通道 = `uid: "legacy"`）。鉴权关闭时按 legacy/admin 兑底（与 v0.2.0 行为一致）。

端点总览：

| 端点 | 说明 |
|---|---|
| `GET /api/v1/me` | 当前身份 `{ uid, username, isAdmin, mode }` |
| `GET /api/v1/me/scan-roots` | 本地库扫描根：available（容器可选项）/ selected（该 uid 勾选）|
| `PUT /api/v1/me/scan-roots` | 全量替换勾选 `{ paths: [...] }`（每个 path 必须 ∈ available）|
| `POST /api/v1/me/history` | 播放历史上报 `{ track: <任意 JSON> }`（每 uid 保最近 200 条）|
| `GET /api/v1/me/history?limit=50` | 播放历史列表（played_at 倒序）|
| `POST /api/v1/me/favorites` | 新增收藏 `{ kind, ref }` |
| `GET /api/v1/me/favorites` | 该 uid 全部收藏 |
| `DELETE /api/v1/me/favorites/:kind/:ref` | 移除收藏 |

### GET /api/v1/me

**响应 200**：
```json
{ "uid": "legacy", "username": "admin", "isAdmin": true, "mode": "local" }
```

`mode` 取决于请求落在哪个实例（`local` = TCP 端口 / `gateway` = 网关 socket）。前端启动时用它拉 uid（localStorage 键按 uid 前缀隔离）。

### GET /api/v1/me/scan-roots

**响应 200**：
```json
{
  "available": ["/app/data/downloads", "/app/data/library"],
  "selected": [
    { "path": "/app/data/downloads", "enabled": true, "createdAt": 1769000000000 }
  ]
}
```

`available` 来自容器环境变量 `RO_SCAN_ROOTS`（`:` 分隔；未设置时仅默认 `/app/data/downloads`）。自 v0.2.16（#88 Track A）起，该变量由 fpk **包内 compose 模板字面直写双根** `/app/data/downloads:/app/data/library`（分别对应两个 data-share：下载共享 `rainbow-music` 与导入共享 `rainbow-library`），**不再经安装向导回调渲染挂载**；「音乐库扫描目录」向导字段降级为可选备注、不产生挂载。两根为独立物理共享、天然不嵌套（配合服务端 `dev:ino` 同源去重杜绝曲库翻倍）。详见 [docs/FNOS-DEPLOY.md](docs/FNOS-DEPLOY.md)。

### PUT /api/v1/me/scan-roots

**请求体**：`{ "paths": ["/app/data/downloads"] }` —— 全量替换该 uid 的勾选（空数组 = 清空，合法；自动去重）。

**响应 200**：同 GET 结构。

**错误**：
```jsonc
// 400 paths 非数组
{ "error": "paths (array) is required" }
// 400 含不在 available 集合中的路径（越界防护）
{ "error": "path not in available scan roots", "invalid": ["/vol1/music"], "available": ["/app/data/downloads"] }
```

### POST /api/v1/me/history

**请求体**：`{ "track": { ... } }` —— track 为任意 JSON 值（前端传播放中的曲目对象，后端原样存档；序列化后 ≤ 64KB）。前端 debounce/节流上报，无需高频。

**响应 200**：`{ "ok": true, "keep": 200 }`（keep = 每 uid 保留条数上限）

**错误**：`400` track 缺失/非 JSON 可序列化/超长。

### GET /api/v1/me/history?limit=50

`limit` clamp 1..200（默认 50），按 `played_at` 倒序。

**响应 200**：
```json
{
  "history": [
    { "id": 1, "track": { "name": "晴天", "singer": "周杰伦" }, "played_at": 1769000000000 }
  ]
}
```

### 搜索历史 Search History（P0 D1）

登录态跨设备同步的搜索历史，按请求身份 `uid` 隔离（与其他 `/me/*` 端点同口径）。服务端负责**去重置顶**（去重键 = `(uid, kw.trim())`；已存在则保留原 `id`、只刷新 `ts`/`type`/`platform` 并提到最前）与**封顶**（同事务内修剪到每 uid 最近 `SEARCH_HISTORY_KEEP` = **200** 条）。`ts` 取 `max(Date.now(), 该 uid 现有 MAX(ts)+1)` 保证严格递增，同毫秒连写（脚本/批量）下置顶仍稳定。

这张表同时是 `GET /api/v1/search/trending`、`/search/suggest`、`/search/related` 与错字容错词典的数据源。另外，`POST` 时若本次词与该 uid **上一条**搜索词不同且间隔 ≤ **30min**（`COOC_WINDOW_MS`），会同事务记一对**搜索共现**（`search_cooccurrence`，双向 upsert），这就是 `/search/related`「搜过 X 的人也搜 Y」的数据来源。

### GET /api/v1/me/search-history

**Query 参数**：`limit`（默认 **50**，clamp `1..200`；非整数或 `<1` 回落 50）。

**响应 200**：
```json
{ "items": [ { "id": 12, "kw": "晴天", "type": "song", "platform": "kw", "ts": 1787300000000 } ] }
```

按 `ts` 倒序（最近搜的在前）。`type` / `platform` 为上报时的可选标签，缺省存**空字符串**（不是 `null`）。

### POST /api/v1/me/search-history

**请求体**：`{ "kw": "晴天", "type": "song", "platform": "kw" }` —— `kw` 必填且 trim 后非空；`type` / `platform` 可选（非字符串或缺省时存空串）。

**响应 201**：
```json
{ "id": 12, "kw": "晴天", "type": "song", "platform": "kw", "ts": 1787300000000 }
```

**错误 400**：
```jsonc
{ "error": "kw (non-empty string) is required" }   // kw 缺失/非字符串/trim 后为空
{ "error": "kw too long (max 512 chars)" }         // 长度护栏，防单条超大字符串撑爆历史表
```

### DELETE /api/v1/me/search-history

清空当前 uid 的全部搜索历史（**无请求体、不带参数**）。

**响应 200**：`{ "ok": true }`

```bash
curl -b cookie.txt -X POST "$BASE/api/v1/me/search-history" -H 'Content-Type: application/json' -d '{"kw":"晴天"}'
curl -b cookie.txt "$BASE/api/v1/me/search-history?limit=20"
curl -b cookie.txt -X DELETE "$BASE/api/v1/me/search-history"
```

### POST /api/v1/me/favorites

**请求体**：`{ "kind": "track", "ref": "kw:107811" }` —— `kind` ∈ `track | playlist | square`；`ref` 非空字符串 ≤1024 字符（同一 `(uid, kind, ref)` 重复收藏幂等）。

**响应 200**：`{ "ok": true, "added": true }`（added=false 表示已存在）

### GET /api/v1/me/favorites

**响应 200**：
```json
{ "favorites": [ { "kind": "track", "ref": "kw:107811", "createdAt": 1769000000000 } ] }
```

### DELETE /api/v1/me/favorites/:kind/:ref

**响应 200**：`{ "ok": true, "deleted": true }`（deleted=false 表示本就不存在；kind 非法 → 400）

---

## 10. 本地音乐库 Library（v0.2.1）

扫描 NAS 挂载目录里已有的音频文件入库、分页浏览、流式播放。所有端点按请求身份 `uid` 隔离（各用户各自的库）。支持格式：mp3 / flac / m4a / ogg / opus / wav / aac。

端点总览：

| 端点 | 说明 |
|---|---|
| `POST /api/v1/library/scan` | 启动扫描（202 异步；per-uid 互斥 409；未配置扫描根 400）|
| `GET /api/v1/library/scan/status` | `{ scanning, last?, progress? }`（进程内存态）|
| `GET /api/v1/library/tracks` | 分页列表（limit/offset/q/artist/album/sort）|
| `GET /api/v1/library/tracks/:id/stream` | 音频流（支持 Range，206 分段；进度条拖动）|
| `GET /api/v1/library/tracks/:id/cover` | 内嵌封面图（缓存优先，无则现场解析；200 image 或 404）|
| `DELETE /api/v1/library/tracks/:id` | 只删索引行（不动音频文件），顺带清封面缓存 |

### POST /api/v1/library/scan

对该 uid 已勾选的扫描根（`me/scan-roots`）启动一轮两阶段扫描：阶段一遍历目录（只收 path/size/mtime 三元组，与 SQLite 快照 diff：未变跳过、消失文件连续 2 轮才删）；阶段二标签补全（worker 池，标题/艺人/专辑/时长，封面落 `data/covers/{uid}/`）。异步执行，进度经 SSE `scan:progress` 推送（按 uid 定向）。

**响应 202**：`{ "ok": true, "jobId": "<id>" }`

**错误**：
```jsonc
// 400 未勾选任何扫描根
{ "error": "未配置扫描根，请先通过 GET/PUT /api/v1/me/scan-roots 选择" }
// 409 该 uid 已有扫描在途
{ "error": "该用户已有扫描在进行中，请稍后再试" }
```

### GET /api/v1/library/scan/status

**响应 200**：
```json
{
  "scanning": true,
  "progress": {
    "phase": "walk",
    "scanned": 120, "total": 340, "added": 12, "updated": 0, "removed": 0,
    "currentRoot": "/app/data/scan/1", "metaDone": 0
  },
  "last": { "finishedAt": 1769000000000, "total": 340, "added": 300, "updated": 12, "removed": 3 }
}
```

`scanning=false` 时无 `progress`；从未扫描过时无 `last`；`last.error` 存在表示上一轮异常结束。

### GET /api/v1/library/tracks

Query：`limit`（clamp 1..500，默认 100）、`offset`（默认 0）、`q`（title/artist LIKE 模糊）、`artist` / `album`（精确）、`sort` ∈ `updated`（默认，入库时间倒序）| `artist` | `album`。

**响应 200**：
```json
{
  "tracks": [
    {
      "id": 1, "title": "晴天", "artist": "周杰伦", "album": "叶惠美",
      "durationMs": 269000, "format": "flac", "size": 28945126,
      "coverState": 1, "metaState": 1, "updatedAt": 1769000000000
    }
  ],
  "total": 1, "offset": 0, "limit": 100
}
```

> `coverState`/`metaState`：0 未探测 / 1 有 / 2 定格无。键集分页（`total` 为当前过滤条件总数）。

### GET /api/v1/library/tracks/:id/stream

音频流：无 Range 头 → `200` 全量（`Accept-Ranges: bytes`）；带 `Range: bytes=a-b` → `206` 分段（`Content-Range`，支持拖动/续拖，语义同 `GET /api/v1/play/:taskId`）。路径安全：解析后必须位于「该 uid 扫描根 ∪ download.dir」内。

**错误**：`404` track not found（含路径越界）；`410` 文件已被移动/删除；`416` Range 不可满足。

### GET /api/v1/library/tracks/:id/cover

内嵌封面（flac PICTURE / mp3 APIC）：缓存 `data/covers/{uid}/{id}.jpg` 优先，未缓存现场解析后写缓存；`Cache-Control: private, max-age=86400`。

**错误**：`404` 无封面可用（含已定格 coverState=2 的免重复解析）。

### DELETE /api/v1/library/tracks/:id

只删索引行（音频文件不动；下次扫描若文件仍在会重新出现），best-effort 清封面缓存。

**响应 200**：`{ "ok": true, "deleted": true }`（`404` 不存在）

---

## 11. 健康冒烟 Health Smoke

音源可用性冒烟测试（R9）：对每个「就绪且启用」的音源逐平台执行 `search → musicUrl → head → lyric → pic` 五步探测，结果落库（`smoke_results`）并可查趋势。与 `POST /api/v1/sources/smoke`（#56 一键快速冒烟：同步返回、**不落库不告警**）互斥、互补。

> **`smoke_results` 的四个消费口径各不相同，读数据前先确认看的是哪个**（v0.2.22 核对）：
>
> | 口径 | 实现 | 统计的 step | 用途 |
> |---|---|---|---|
> | **L1 健康排序** | `source-engine/source-health.ts` `computeSourceHealth()` | **仅 `search` + `musicUrl`** | 候选音源排序（近 5 轮全败的源降到末尾） |
> | 矩阵三色 | `routes/health.ts` | `search`/`musicUrl`/`head` 任一失败=red；仅 `lyric`/`pic` 失败=yellow | 健康页展示 |
> | 「连续失败」告警 | `db/smoke.ts` `recentRunsOutcome()` | **五步全算**（无 step 过滤的 `MIN(ok)`） | Bark/Server酱 告警，宽口径宁多报不漏报 |
> | 趋势 | `db/smoke.ts` `trend()` | **仅 `head`** | `GET …/smoke/trend` |
>
> 关键差异：**L1 从 v0.2.22 起不再把 `head` 计入健康**。`head` 是诊断性探测，mg/tx 等平台 CDN 常拒 HEAD（405/410/502）而 GET 正常，计入会把实际下载 100% 成功的源误判为 `allRecentFailed` 而降权（修正前的 qdy 实例）。因此一个源可以「矩阵显示 red / 触发告警」却仍被 L1 当作健康源优先使用——这是**有意为之**，不是不一致。L2 熔断与上述四者完全无关（纯进程内存连续失败计数，不读 `smoke_results`）。机制详见 `docs/DEVELOPMENT.md` 「音源质量闸门 L1/L2/L3」。

### GET /api/v1/health/smoke

最近一次全量冒烟的结果 + **音源 × 平台**矩阵。**GET 可读**（不限管理员）。

**响应 200**：
```json
{
  "runId": "3f0a7c2e-9b41-4d5a-8c6e-1f2a3b4c5d6e",
  "lastRunAt": 1787300000000,
  "running": false,
  "summary": { "total": 5, "green": 3, "yellow": 1, "red": 1 },
  "cells": [
    {
      "sourceId": "real-source",
      "platform": "kw",
      "steps": {
        "search":   { "ok": true,  "ms": 412, "error": null },
        "musicUrl": { "ok": true,  "ms": 180, "error": null },
        "head":     { "ok": true,  "ms": 96,  "error": null },
        "lyric":    { "ok": false, "ms": 210, "error": "无歌词" },
        "pic":      { "ok": true,  "ms": 88,  "error": null }
      },
      "ok": true,
      "state": "yellow"
    }
  ]
}
```

**`state` 三色判定**：`search`/`musicUrl`/`head` 任一失败 → **`red`**（关键路径断）；关键步骤全通但 `lyric`/`pic` 失败 → **`yellow`**（附属元数据缺失）；全通 → **`green`**。`ok` = 关键步骤全通（即 `state !== "red"`）。

`runId`（UUID）/ `lastRunAt` 在**从未跑过冒烟**时为 `null`（`cells` 为空、`summary` 全 0）；`running` = 当前是否有全量冒烟在跑。`steps` 里只出现**实际执行过**的步骤（前置步骤失败则后续步骤无条目）。

### GET /api/v1/health/smoke/trend

最近 N 天冒烟趋势（按 **天 × 平台** 聚合，只统计 `head` 步骤——即「直链可用性」口径）。

**Query 参数**：`days`（默认 **7**，clamp `1..30`；非法值回落 7）。

**响应 200**：
```json
{
  "days": 7,
  "trend": [
    { "day": "2026-09-23", "platform": "kw", "total": 12, "ok": 10 },
    { "day": "2026-09-23", "platform": "wy", "total": 12, "ok": 12 }
  ]
}
```

`day` 为**本地时区**日期（`date(created_at/1000,'unixepoch','localtime')`），按 `day` 倒序；`total` = 该平台当天 `head` 探测次数，`ok` = 其中成功次数。无数据时 `trend` 为空数组。

### POST /api/v1/health/smoke/run

手动触发一次**全量**冒烟（异步跑、立即返回；结果落库供上面两个 GET 读取，完成/失败经 SSE 推 `smoke:completed` / `smoke:failed` 事件）。**限管理员**。

**响应 202**：`{ "started": true }`

**错误**：`403 { "error": "需要管理员权限" }`；`409 { "error": "冒烟测试已在运行中" }`。

```bash
curl -b cookie.txt -X POST "$BASE/api/v1/health/smoke/run"     # → 202 { "started": true }
curl -b cookie.txt "$BASE/api/v1/health/smoke"
curl -b cookie.txt "$BASE/api/v1/health/smoke/trend?days=14"
```

---

## 错误约定

所有错误响应统一为 JSON。历史端点为纯字符串形态 `{ "error": "<描述>" }`（部分附带 `valid` 字段列出合法取值）；**v0.2.21 起下载/试听链路的失败额外提供结构化形态**：

```jsonc
// 形态 A（历史，纯字符串）——参数校验、资源不存在等
{ "error": "task not found" }
{ "error": "invalid platform", "valid": ["kw","kg","tx","wy","mg"] }

// 形态 B（M1 结构化）—— POST /download、POST /download/batch、
//                       POST /playlists/:id/download(-missing)、GET /preview
{ "error": { "code": "ERR_DISK_FULL", "message": "磁盘可用空间不足（free … bytes < required … bytes）" } }
```

两种形态**共存**：同一端点的 400（参数校验）多为形态 A，而入队/取链失败为形态 B。客户端健壮写法：`typeof body.error === 'string' ? body.error : body.error.message`，错误码取 `body.error?.code ?? null`。

`code` 枚举（`ErrorCode`）：`ERR_DNS` / `ERR_TIMEOUT` / `ERR_HTTP_4XX` / `ERR_HTTP_5XX` / `ERR_NO_SOURCE` / `ERR_ALL_SOURCES_FAILED` / `ERR_TAG_EMBED` / `ERR_DISK_FULL` / `ERR_BAD_REQUEST` / `ERR_UNKNOWN`。任务对象上对应 `error`（message）+ `errorCode`（code）两个字段。

| 状态码 | 含义 |
|---|---|
| `200` | 成功（也用于「无实际变更」的幂等结果，如 `download-missing` 全跳过）|
| `201` | 创建成功（下载任务/音源导入/歌单）|
| `202` | 异步任务已启动（冒烟测试/本地库扫描/刮削）|
| `302` | 重定向（`GET /preview` → 音源直链；未授权访问非 `/api/*` 路径 → `/login.html`）|
| `400` | 参数缺失或非法 |
| `401` | 未授权（未登录 / API Key 无效）|
| `403` | 需要管理员权限（v0.2.1：网关普通成员调用全局管理接口——settings PATCH/apikey、音源启停重载删除、刮削批量、`health/smoke/run`、`queue/*`、`batches/:id/cancel`、通知测试）|
| `404` | 资源不存在（任务/批次/音源；TCP 实例上的 gateway-login 亦为 404）|
| `409` | 状态冲突（任务不可重试/取消/未完成不可播放；同 uid 扫描进行中；冒烟已在跑）|
| `410` | 资源已消失（播放时任务文件缺失；库曲目文件被移动/删除）|
| `416` | Range 不可满足（播放接口）|
| `502` | 上游失败兜底（`ERR_DNS`/`ERR_HTTP_4XX`/`ERR_HTTP_5XX`/`ERR_ALL_SOURCES_FAILED`/`ERR_TAG_EMBED`/`ERR_UNKNOWN`）|
| `503` | 无可用音源（`ERR_NO_SOURCE`）|
| `504` | 上游超时（`ERR_TIMEOUT`）|
| `507` | **磁盘可用空间不足**（`ERR_DISK_FULL`；v0.2.21 新增失败态，入队预检或写盘阶段触发）|

---

## 完整调用示例：搜索→下载→追踪

以 API Key 方式，下载「月亮之上」并轮询任务状态：

```bash
BASE=http://127.0.0.1:23330
KEY='ro_你的APIKey'
H="-H X-API-Key:$KEY"

# 1. 聚合搜索，取 kw 第一条
curl -s $H "$BASE/api/v1/search/aggregate?keyword=月亮之上&platforms=kw&limit=1" -o search.json

# 2. 提交下载（把搜索结果里的单曲对象整体作为 musicInfo）
curl -s $H -X POST $BASE/api/v1/download \
  -H 'Content-Type: application/json' \
  -d '{"platform":"kw","quality":"flac","musicInfo":{"name":"月亮之上","singer":"凤凰传奇","source":"kw","songmid":107811}}'
# → { "id": "abc-123", "status": "pending" }

# 3. 轮询任务状态
curl -s $H $BASE/api/v1/tasks/abc-123
# → { "status": "completed", "filePath": "/app/data/downloads/月亮之上 - 凤凰传奇.flac", ... }
```

下载完成的文件落在容器 `/app/data/downloads`（本项目部署映射到宿主机下载目录），歌词与封面已内嵌进音频文件。
