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
# 流程：登录 → /api/v1/status → /api/v1/health/smoke，逐步输出 PASS/FAIL。
# 全部通过退出码 0，任一失败退出码 1。
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

if [ "$FAILED" = "0" ]; then
    echo "PASS"
    exit 0
fi
echo "FAIL"
exit 1
