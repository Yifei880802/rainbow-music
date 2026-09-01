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

```bash
curl -b cookie.txt 'http://127.0.0.1:23330/api/v1/search/aggregate?keyword=月亮之上&platforms=kw,wy,mg&limit=3'
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

**错误 400**：platform 非法 / musicInfo 缺 songmid|name / quality 非法。

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
{ "acceptedCount": 2, "rejectedCount": 0,
  "accepted": [ { "index": 0, "id": "...", "name": "..." } ],
  "rejected": [] }
```

### GET /api/v1/tasks

任务列表。可选 `?status=` 过滤（`pending`/`active`/`completed`/`completed_with_warnings`/`failed`/`canceled`）。

**响应**：`{ "tasks": [ ... ] }`

### GET /api/v1/tasks/:id

单任务详情。

**响应 200**（示例）：
```json
{
  "id": "1662fe1d-...",
  "status": "completed",
  "name": "月亮之上",
  "singer": "凤凰传奇",
  "actualSource": "real-source",
  "progress": 100,
  "filePath": "/app/data/downloads/月亮之上 - 凤凰传奇.flac",
  "error": null
}
```
换源成功时 `status` 可能为 `completed_with_warnings`，`actualSource` 记为实际命中音源。

**错误 404**：`{ "error": "task not found" }`

### POST /api/v1/tasks/:id/retry

重试失败任务。成功 `{ "id": "...", "status": "pending" }`；不可重试 `409`。

### POST /api/v1/tasks/:id/cancel

取消任务。成功 `{ "id": "...", "status": "canceled" }`；不可取消 `409`。

### DELETE /api/v1/tasks/:id

删除任务记录。成功 `{ "id": "...", "deleted": true }`；不存在 `404`。

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

返回脱敏配置视图。

```json
{
  "auth": { "apiKeySet": true },
  "download": { "concurrency": 3, "defaultQuality": "flac", "nameTemplate": "{name} - {singer}", "embedCover": true, "embedLyric": true, "coverSize": 500 },
  "scrape": { "enabled": true, "autoOnComplete": true },
  "smokeTest": { "enabled": true, "cron": "0 6 * * *", "keyword": "周杰伦", "checkLyric": true, "checkPic": true, "alertThreshold": 2,
    "alert": { "bark": { "enabled": false, "serverUrl": "https://api.day.app", "deviceKeySet": false }, "serverChan": { "enabled": false, "sendKeySet": false } } }
}
```

### PATCH /api/v1/settings

局部更新配置（下载 / 刮削 / 冒烟测试 / 告警）。只传要改的字段。

**校验规则**：
- `download.concurrency`：1–10 整数
- `download.defaultQuality`：须为四种音质之一
- `download.coverSize`：100–1000 整数

```bash
curl -b cookie.txt -X PATCH http://127.0.0.1:23330/api/v1/settings \
  -H 'Content-Type: application/json' \
  -d '{ "download": { "concurrency": 5, "defaultQuality": "320k" } }'
```
并发变化即时生效；`smokeTest.cron`/`enabled` 变化会重排定时任务。响应返回更新后的脱敏视图。

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
  "app": "ro", "version": "0.2.14", "uptimeSec": 3600,
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
| `POST /api/v1/playlists/:id/download` | 整单批量下载 `{ quality? }`（逐首入队，返回 `accepted[]`） |

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
  "available": ["/app/data/downloads", "/app/data/scan/1"],
  "selected": [
    { "path": "/app/data/downloads", "enabled": true, "createdAt": 1769000000000 }
  ]
}
```

`available` 来自容器环境变量 `RO_SCAN_ROOTS`（`:` 分隔；未设置时仅默认 `/app/data/downloads`）——由 .fpk 安装向导「音乐库扫描目录」渲染进 compose，见 [docs/FNOS-DEPLOY.md](docs/FNOS-DEPLOY.md)。

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

## 错误约定

所有错误响应统一为 JSON：`{ "error": "<描述>" }`，部分附带 `valid` 字段列出合法取值。

| 状态码 | 含义 |
|---|---|
| `400` | 参数缺失或非法 |
| `401` | 未授权（未登录 / API Key 无效）|
| `403` | 需要管理员权限（v0.2.1：网关普通成员调用全局管理接口——settings PATCH/apikey、音源启停重载删除、刮削批量、`health/smoke/run`、通知测试）|
| `404` | 资源不存在（任务/音源；TCP 实例上的 gateway-login 亦为 404）|
| `409` | 状态冲突（任务不可重试/取消/未完成不可播放；同 uid 扫描进行中）|
| `410` | 资源已消失（播放时任务文件缺失；库曲目文件被移动/删除）|
| `416` | Range 不可满足（播放接口）|
| `201` | 创建成功（下载任务/音源导入/歌单）|
| `202` | 异步任务已启动（冒烟测试/本地库扫描）|

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
