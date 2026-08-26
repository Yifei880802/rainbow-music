#!/bin/sh
#
# Rainbow 安装后冒烟验证脚本
#
# 用法：
#   RB_USER=admin RB_PASS='你的密码' ./scripts/verify.sh
#
# 环境变量：
#   RB_HOST  服务地址，默认 127.0.0.1
#   RB_PORT  服务端口，默认 23330
#   RB_USER  登录用户名，默认 admin
#   RB_PASS  登录密码（必填）
#
# 流程：登录 → /api/v1/status → /api/v1/health/smoke →
#       ④ 网关 socket 冒烟（RO_GATEWAY_SOCK 存在时；本地无网关环境 SKIP）→
#       ⑤ admin 账密登录回归（双实例改造后本地登录闭环不变）→
#       ⑥ /api/v1/me 身份端点 → ⑦ /api/v1/library/tracks（200 空列表），
#       逐步输出 PASS/FAIL（SKIP 不计失败）。
# 全部通过退出码 0，任一失败退出码 1；全部步骤幂等，可重复执行。
#
set -eu

RB_HOST="${RB_HOST:-127.0.0.1}"
RB_PORT="${RB_PORT:-23330}"
RB_USER="${RB_USER:-admin}"
RB_PASS="${RB_PASS:-}"
BASE="http://${RB_HOST}:${RB_PORT}"

if [ -z "$RB_PASS" ]; then
    echo "FAIL: 未设置 RB_PASS（登录密码）"
    exit 1
fi
command -v curl >/dev/null 2>&1 || { echo "FAIL: 缺少 curl"; exit 1; }

COOKIE_JAR="$(mktemp)"
trap 'rm -f "$COOKIE_JAR"' EXIT

FAILED=0

json_escape() {
    # JSON 字符串最小转义：先转 \ 再转 "，避免密码含引号/反斜杠时请求体损坏
    printf '%s' "$1" | sed -e 's/\\/\\\\/g' -e 's/"/\\"/g'
}

RB_USER_JSON=$(json_escape "$RB_USER")
RB_PASS_JSON=$(json_escape "$RB_PASS")

step() { # $1=名称 $2=HTTP码 $3=期望码范围描述; 返回 0/1
    if [ "$2" = "000" ]; then
        echo "FAIL: $1 —— 无法连接 $BASE"
        return 1
    fi
    case "$2" in
        2*) echo "PASS: $1 (HTTP $2)" ;;
        *)  echo "FAIL: $1 (HTTP $2)"; return 1 ;;
    esac
}

echo "== Rainbow 冒烟验证 @ $BASE =="

# 1) 登录
LOGIN_CODE=$(curl -s -o /dev/null -m 10 -c "$COOKIE_JAR" \
    -H 'Content-Type: application/json' \
    -d "{\"username\":\"${RB_USER_JSON}\",\"password\":\"${RB_PASS_JSON}\"}" \
    -w '%{http_code}' "$BASE/api/v1/auth/login" 2>/dev/null || true)
[ -n "$LOGIN_CODE" ] || LOGIN_CODE=000
if step "登录 POST /api/v1/auth/login" "$LOGIN_CODE"; then :; else FAILED=1; fi

# 2) 状态接口
STATUS_CODE=$(curl -s -o /dev/null -m 10 -b "$COOKIE_JAR" \
    -w '%{http_code}' "$BASE/api/v1/status" 2>/dev/null || true)
[ -n "$STATUS_CODE" ] || STATUS_CODE=000
if step "状态 GET /api/v1/status" "$STATUS_CODE"; then :; else FAILED=1; fi

# 3) 冒烟结果接口
SMOKE_CODE=$(curl -s -o /dev/null -m 10 -b "$COOKIE_JAR" \
    -w '%{http_code}' "$BASE/api/v1/health/smoke" 2>/dev/null || true)
[ -n "$SMOKE_CODE" ] || SMOKE_CODE=000
if step "冒烟 GET /api/v1/health/smoke" "$SMOKE_CODE"; then :; else FAILED=1; fi

# 4) 网关 socket 冒烟（v0.2.1）：RO_GATEWAY_SOCK 环境变量存在且指向 unix socket
#    时，带模拟 X-Trim-* 头调 gateway-login（网关实例才注册该路由，预期 200）。
#    v0.2.5 增测前缀重写：经 /app/com.rainbow.music 前缀请求 auth/status（rewriteUrl
#    应在路由查找前剥前缀，预期 200）——fnOS 网关按官方语义保留完整前缀转发，
#    应用侧不剥前缀则 iframe 入口全部 404（v0.2.4 入口 404 根因链之一）。
#    本地开发机/纯端口部署无此环境变量 → SKIP（不计失败，属预期降级）。
if [ -n "${RO_GATEWAY_SOCK:-}" ]; then
    if [ -S "$RO_GATEWAY_SOCK" ]; then
        GW_CODE=$(curl -s -o /dev/null -m 10 --unix-socket "$RO_GATEWAY_SOCK" \
            -H 'X-Trim-Userid: 424242' \
            -H 'X-Trim-Username: verify-smoke' \
            -H 'X-Trim-Isadmin: false' \
            -X POST -w '%{http_code}' \
            "http://localhost/api/v1/auth/gateway-login" 2>/dev/null || true)
        [ -n "$GW_CODE" ] || GW_CODE=000
        if step "网关登录 POST /api/v1/auth/gateway-login @ $RO_GATEWAY_SOCK" "$GW_CODE"; then :; else FAILED=1; fi

        # 前缀重写（v0.2.5）：带网关前缀的请求应剥前缀后命中同一路由
        GWP_CODE=$(curl -s -o /dev/null -m 10 --unix-socket "$RO_GATEWAY_SOCK" \
            -w '%{http_code}' \
            "http://localhost/app/com.rainbow.music/api/v1/auth/status" 2>/dev/null || true)
        [ -n "$GWP_CODE" ] || GWP_CODE=000
        if step "网关前缀 GET /app/com.rainbow.music/api/v1/auth/status @ $RO_GATEWAY_SOCK" "$GWP_CODE"; then :; else FAILED=1; fi
    else
        echo "SKIP: 网关冒烟 —— RO_GATEWAY_SOCK 已设置但 socket 不存在: $RO_GATEWAY_SOCK"
    fi
else
    echo "SKIP: 网关冒烟 —— 未设置 RO_GATEWAY_SOCK（本地/纯端口环境，无网关实例）"
fi

# 5) admin 账密登录回归（v0.2.1）：双实例改造后本地 TCP 登录闭环必须不变
LOGIN2_CODE=$(curl -s -o /dev/null -m 10 -c "$COOKIE_JAR" \
    -H 'Content-Type: application/json' \
    -d "{\"username\":\"${RB_USER_JSON}\",\"password\":\"${RB_PASS_JSON}\"}" \
    -w '%{http_code}' "$BASE/api/v1/auth/login" 2>/dev/null || true)
[ -n "$LOGIN2_CODE" ] || LOGIN2_CODE=000
if step "登录回归 POST /api/v1/auth/login（admin 账密）" "$LOGIN2_CODE"; then :; else FAILED=1; fi

# 6) 身份端点（v0.2.1）：uid/username/isAdmin/mode 四字段
ME_CODE=$(curl -s -o /dev/null -m 10 -b "$COOKIE_JAR" \
    -w '%{http_code}' "$BASE/api/v1/me" 2>/dev/null || true)
[ -n "$ME_CODE" ] || ME_CODE=000
if step "身份 GET /api/v1/me" "$ME_CODE"; then :; else FAILED=1; fi

# 7) 本地音乐库列表（v0.2.1）：未扫描时空列表，断言 200
TRACKS_CODE=$(curl -s -o /dev/null -m 10 -b "$COOKIE_JAR" \
    -w '%{http_code}' "$BASE/api/v1/library/tracks?limit=10" 2>/dev/null || true)
[ -n "$TRACKS_CODE" ] || TRACKS_CODE=000
if step "曲库 GET /api/v1/library/tracks" "$TRACKS_CODE"; then :; else FAILED=1; fi

if [ "$FAILED" = "0" ]; then
    echo "PASS"
    exit 0
fi
echo "FAIL"
exit 1
