#!/bin/bash
#
# Rainbow 镜像静态资源一致性验证脚本（源码 → 镜像重建 → 容器内断言）
#
# 用法：
#   ./scripts/verify-image.sh [镜像名] [宿主端口]
#   IMAGE=rainbow-music:v0.2.0 PORT=23332 ./scripts/verify-image.sh   # 环境变量等价
#
# 参数：
#   $1 / IMAGE  镜像名，默认 rainbow-music:v0.2.0
#   $2 / PORT   宿主映射端口，默认 23331（23330 为常驻开发服务，勿占用）
#
# 环境变量：
#   RB_USER  登录用户名，默认 admin
#   RB_PASS  登录密码，默认 admin
#   KEEP     =1 时无论成败都保留容器与 colima（排查用）
#
# 流程：
#   1. colima start（幂等；脚本启动的实例结束时 stop 恢复原状，原本就在跑的不动）
#   2. docker buildx build --load 重建镜像（Dockerfile 多阶段，前端 web/ 原样 COPY）
#   3. 起临时容器：挂载仓库根 config.yaml（只读），宿主 PORT → 容器 23330
#   4. 等健康 → 登录（鉴权链路验证）
#   5. 断言：web/ 全部静态文件（style.css、index.html、js/*.js、login.*、favicon.png）
#      逐文件 MD5 比对容器内 /app/web 对应文件；另附登录态 HTTP 交付抽查
#   6. 输出逐文件比对报告；任一 FAIL → 退出码 1，容器保留便于排查
#   7. 全 PASS → 清理容器 → colima stop（仅当由本脚本启动）
#
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

IMAGE="${1:-${IMAGE:-rainbow-music:v0.2.0}}"
PORT="${2:-${PORT:-23331}}"
RB_USER="${RB_USER:-admin}"
RB_PASS="${RB_PASS:-admin}"
CONTAINER="rainbow-verify-image"
BASE="http://127.0.0.1:${PORT}"

RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[0;33m'; BOLD='\033[1m'; NC='\033[0m'
info() { printf "${GREEN}[verify-image]${NC} %s\n" "$1"; }
warn() { printf "${YELLOW}[verify-image]${NC} %s\n" "$1"; }
err()  { printf "${RED}[verify-image]${NC} %s\n" "$1"; }
pass() { printf "  ${GREEN}PASS${NC}  %s\n" "$1"; }
fail() { printf "  ${RED}FAIL${NC}  %s\n" "$1"; }

[ -f "$REPO_ROOT/Dockerfile" ] || { err "不在仓库根（找不到 Dockerfile）"; exit 1; }
[ -f "$REPO_ROOT/config.yaml" ] || { err "找不到 config.yaml"; exit 1; }
command -v docker  >/dev/null 2>&1 || { err "缺少 docker CLI"; exit 1; }
command -v colima  >/dev/null 2>&1 || { err "缺少 colima"; exit 1; }
command -v curl    >/dev/null 2>&1 || { err "缺少 curl"; exit 1; }
command -v md5     >/dev/null 2>&1 || { err "缺少 md5（macOS）"; exit 1; }

CLEANUP_DONE=0
VERIFY_FAILED=0
COLIMA_STARTED_HERE=0
COOKIE_JAR="$(mktemp)"

cleanup() {
  # 保存进入 trap 前的退出码；末尾显式 exit 恢复（防 trap 尾命令覆盖真实退出码）
  local rc=$?
  rm -f "$COOKIE_JAR" 2>/dev/null || true
  if [ "$CLEANUP_DONE" = 1 ]; then
    exit "$rc"
  fi
  CLEANUP_DONE=1
  if [ "$VERIFY_FAILED" = 1 ] || [ "${KEEP:-0}" = 1 ]; then
    warn "容器保留供排查：docker exec -it $CONTAINER sh / docker logs $CONTAINER / docker rm -f $CONTAINER"
  else
    docker rm -f "$CONTAINER" >/dev/null 2>&1 || true
    info "临时容器已清理"
  fi
  if [ "$COLIMA_STARTED_HERE" = 1 ] && [ "${KEEP:-0}" != 1 ]; then
    info "停止 colima（恢复脚本运行前状态）…"
    colima stop >/dev/null 2>&1 || true
  fi
  exit "$rc"
}
trap cleanup EXIT

echo -e "${BOLD}== Rainbow 镜像静态资源验证 ==${NC}"
info "镜像：${IMAGE}　宿主端口：${PORT}　登录：${RB_USER}"

# ---------- 1. colima ----------
if colima status >/dev/null 2>&1; then
  info "colima 已在运行（结束后保持原状）"
else
  info "colima 未运行，启动中…（首次冷启动约 1–2 分钟）"
  COLIMA_STARTED_HERE=1
  colima start
fi

# ---------- 2. buildx 重建镜像 ----------
info "buildx 重建镜像（多阶段构建：npm ci + tsc + 原生模块编译，约 3–8 分钟）…"
docker buildx build --load --file "$REPO_ROOT/Dockerfile" --tag "$IMAGE" "$REPO_ROOT" 2>&1 \
  | grep -E '^#[0-9]+ (\[|DONE|ERROR)|^ERROR|naming to' || true
docker image inspect "$IMAGE" >/dev/null 2>&1 || { err "镜像构建失败：$IMAGE"; VERIFY_FAILED=1; exit 1; }
info "镜像就绪：$IMAGE"

# ---------- 3. 起临时容器 ----------
docker rm -f "$CONTAINER" >/dev/null 2>&1 || true
info "启动临时容器（挂载 config.yaml 只读；$PORT → 23330；data 不挂载，隔离开发库）…"
docker run -d --name "$CONTAINER" \
  -p "${PORT}:23330" \
  -v "$REPO_ROOT/config.yaml:/app/config.yaml:ro" \
  "$IMAGE" >/dev/null

# ---------- 4. 健康等待 + 登录 ----------
info "等待服务就绪（最长 45s）…"
READY=0
for i in $(seq 1 45); do
  CODE=$(curl -s -o /dev/null -m 3 -w '%{http_code}' "$BASE/api/v1/status" 2>/dev/null || true)
  if [ "$CODE" = "200" ] || [ "$CODE" = "401" ]; then READY=1; break; fi
  sleep 1
done
[ "$READY" = 1 ] || { err "服务未就绪（最后状态码：${CODE}）；容器日志："; docker logs --tail 30 "$CONTAINER" 2>&1 | sed 's/^/    /'; VERIFY_FAILED=1; exit 1; }
pass "服务就绪 GET /api/v1/status (HTTP $CODE)"

LOGIN_CODE=$(curl -s -o /dev/null -m 10 -c "$COOKIE_JAR" \
  -H 'Content-Type: application/json' \
  -d "{\"username\":\"$RB_USER\",\"password\":\"$RB_PASS\"}" \
  -w '%{http_code}' "$BASE/api/v1/auth/login" 2>/dev/null || true)
if [ "$LOGIN_CODE" = "200" ]; then
  pass "登录 POST /api/v1/auth/login (HTTP 200)"
else
  err "登录失败 (HTTP $LOGIN_CODE)——检查 config.yaml 的 auth.webLogin 与 RB_USER/RB_PASS"
  VERIFY_FAILED=1; exit 1
fi

# ---------- 5. 静态资源 MD5 逐文件比对（主断言） ----------
echo -e "${BOLD}-- 静态资源 MD5 比对（源码 web/ vs 容器 /app/web）--${NC}"
TOTAL=0; OK=0
while IFS= read -r f; do
  TOTAL=$((TOTAL + 1))
  HOST_MD5=$(md5 -q "$REPO_ROOT/web/$f" 2>/dev/null || echo "HOST-READ-FAIL")
  CTR_MD5=$(docker exec "$CONTAINER" md5sum "/app/web/$f" 2>/dev/null | awk '{print $1}' || true)
  if [ -n "$CTR_MD5" ] && [ "$HOST_MD5" = "$CTR_MD5" ]; then
    OK=$((OK + 1)); pass "web/$f  ${HOST_MD5:0:10}…"
  else
    VERIFY_FAILED=1
    fail "web/$f  源=${HOST_MD5:0:10}… 容器=${CTR_MD5:-<缺失>}"
  fi
done < <(cd "$REPO_ROOT/web" && find . -type f ! -name '.DS_Store' | sed 's|^\./||' | sort)

# ---------- 6. 登录态 HTTP 交付抽查（服务实际吐出的字节） ----------
echo -e "${BOLD}-- 登录态 HTTP 交付抽查 --${NC}"
for probe in style.css index.html; do
  HTTP_MD5=$(curl -s -m 10 -b "$COOKIE_JAR" "$BASE/$probe" 2>/dev/null | md5 -q || true)
  HOST_MD5=$(md5 -q "$REPO_ROOT/web/$probe")
  if [ -n "$HTTP_MD5" ] && [ "$HTTP_MD5" = "$HOST_MD5" ]; then
    OK=$((OK + 1)); TOTAL=$((TOTAL + 1)); pass "HTTP /$probe  ${HTTP_MD5:0:10}…（交付字节 = 源码）"
  else
    TOTAL=$((TOTAL + 1)); VERIFY_FAILED=1
    fail "HTTP /$probe  源=${HOST_MD5:0:10}… 交付=${HTTP_MD5:0:10}…"
  fi
done

# ---------- 7. 报告 ----------
echo
if [ "$VERIFY_FAILED" = 0 ]; then
  echo -e "${GREEN}${BOLD}比对报告：${OK}/${TOTAL} 全部一致 PASS${NC}"
  info "镜像 $IMAGE 内静态资源与源码完全一致"
  exit 0
else
  echo -e "${RED}${BOLD}比对报告：${OK}/${TOTAL} 一致，存在差异 FAIL${NC}"
  exit 1
fi
