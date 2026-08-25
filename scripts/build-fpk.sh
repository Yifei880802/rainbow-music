#!/bin/bash
#
# Rainbow 飞牛 fnOS .fpk 打包脚本（对外契约，CI 依赖，勿随意改动行为）
#
# 环境变量：
#   FPK_VERSION    应用版本（X.Y.Z 或 X.Y.Z-rN，与 CI tag 契约 vX.Y.Z[-rN] 对齐），
#                  默认读 fpk/manifest 中的 version
#                  注意：飞牛 manifest 的 version 字段官方要求纯 X.Y.Z，
#                  渲染 manifest 时会自动剥离 -rN 后缀；产物文件名保留完整版本
#   FPK_IMAGE      镜像仓库地址，默认 ghcr.io/OWNER/rainbow-music
#   FPK_IMAGE_TAG  镜像 tag，默认 v${FPK_VERSION}
#                  注意：必须与 registry 实际 push 的 tag 完全一致，否则飞牛拉镜像失败
#   FPK_OUT_DIR    输出目录，默认 dist-fpk
#   FNPACK_BIN     显式指定 fnpack 可执行文件路径（可选）
#
# 行为：
#   1. 拷贝 fpk/ 到构建暂存目录并渲染：注入镜像占位、渲染 manifest 版本号
#   2. PATH 中存在 fnpack（或指定 FNPACK_BIN）时优先 fnpack build，否则手工 tar 组装
#   3. 产物：${FPK_OUT_DIR}/rainbow-${FPK_VERSION}.fpk
#   4. stdout 最后一行打印产物绝对路径
#
set -eu

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
FPK_SRC="$REPO_ROOT/fpk"

RED='\033[0;31m'; GREEN='\033[0;32m'; NC='\033[0m'
info() { printf "${GREEN}[build-fpk]${NC} %s\n" "$1" >&2; }
err()  { printf "${RED}[build-fpk]${NC} %s\n" "$1" >&2; exit 1; }

[ -d "$FPK_SRC" ] || err "找不到 $FPK_SRC"
[ -f "$FPK_SRC/manifest" ] || err "找不到 $FPK_SRC/manifest"

# ---------- 1. 解析契约环境变量 ----------

MANIFEST_VERSION=$(grep '^version=' "$FPK_SRC/manifest" | head -n1 | cut -d= -f2- | tr -d ' \r')
FPK_VERSION="${FPK_VERSION:-$MANIFEST_VERSION}"
FPK_IMAGE="${FPK_IMAGE:-ghcr.io/OWNER/rainbow-music}"
FPK_IMAGE_TAG="${FPK_IMAGE_TAG:-v${FPK_VERSION}}"
FPK_OUT_DIR="${FPK_OUT_DIR:-$REPO_ROOT/dist-fpk}"

# 与 CI tag 契约一致：X.Y.Z 或 X.Y.Z-rN（rN 为修订号）
if ! [[ "$FPK_VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+(-r[0-9]+)?$ ]]; then
    err "FPK_VERSION 格式非法（要求 X.Y.Z 或 X.Y.Z-rN）：'$FPK_VERSION'"
fi

# 飞牛 manifest version 字段官方要求纯 X.Y.Z：剥离 -rN 后缀（产物文件名仍带完整版本）
MANIFEST_VERSION_RENDER="${FPK_VERSION%%-r*}"

info "version=$FPK_VERSION image=${FPK_IMAGE}:${FPK_IMAGE_TAG}"

# ---------- 2. 暂存目录 + 渲染 ----------

STAGE="$FPK_OUT_DIR/build"
rm -rf "$STAGE"
mkdir -p "$STAGE"
cp -R "$FPK_SRC/." "$STAGE/"

# 渲染 manifest 版本号（只写纯 X.Y.Z，-rN 修订号不进 manifest）
sed -i.bak "s|^version=.*|version=${MANIFEST_VERSION_RENDER}|" "$STAGE/manifest"
rm -f "$STAGE/manifest.bak"

# 注入镜像占位（历史坑：compose 的 image tag 必须与仓库实际 tag 完全一致）
COMPOSE_FILE="$STAGE/app/docker/docker-compose.yaml"
[ -f "$COMPOSE_FILE" ] || err "找不到 $COMPOSE_FILE"
sed -i.bak \
    -e "s|__FPK_IMAGE__|${FPK_IMAGE}|" \
    -e "s|__FPK_IMAGE_TAG__|${FPK_IMAGE_TAG}|" \
    "$COMPOSE_FILE"
rm -f "$COMPOSE_FILE.bak"

if grep -q '__FPK_IMAGE' "$COMPOSE_FILE"; then
    err "compose 占位注入失败，仍存在 __FPK_IMAGE__ 占位符"
fi

# 生命周期脚本加执行位（fnpack 要求 cmd/ 下 9 个独立脚本均可执行）
chmod +x "$STAGE/cmd/"* 2>/dev/null || true

# 图标缺失时自动生成
if [ ! -f "$STAGE/ICON.PNG" ] || [ ! -f "$STAGE/ICON_256.PNG" ]; then
    info "图标缺失，调用 scripts/gen-icons.mjs 生成"
    ( cd "$REPO_ROOT" && node scripts/gen-icons.mjs )
    cp "$FPK_SRC/ICON.PNG" "$FPK_SRC/ICON_256.PNG" "$STAGE/"
fi

# ---------- 3. 打包：fnpack 优先，手工 tar 兜底 ----------

FNPACK_BIN="${FNPACK_BIN:-}"
if [ -z "$FNPACK_BIN" ] && command -v fnpack >/dev/null 2>&1; then
    FNPACK_BIN="fnpack"
fi

OUT_NAME="rainbow-${FPK_VERSION}.fpk"
OUT_PATH="$FPK_OUT_DIR/$OUT_NAME"
mkdir -p "$FPK_OUT_DIR"

warn() { printf "${RED}[build-fpk]${NC} %s\n" "$1" >&2; }

pack_with_fnpack() {
    # fnpack 已知行为：打包失败时退出码仍为 0，只能靠 stderr 出现
    # "Packing failed" 判断。因此 stderr 单独落盘检测，stdout 透传到 stderr。
    local errlog="$FPK_OUT_DIR/.fnpack-stderr.log"
    local rc=0
    ( cd "$STAGE" && "$FNPACK_BIN" build ) 1>&2 2>"$errlog" || rc=$?
    if [ "$rc" -ne 0 ]; then
        cat "$errlog" >&2
        rm -f "$errlog"
        warn "fnpack build 退出码非零（${rc}），打包失败"
        return 1
    fi
    if grep -q 'Packing failed' "$errlog"; then
        cat "$errlog" >&2
        rm -f "$errlog"
        warn "fnpack 退出码为 0 但 stderr 报告 Packing failed —— 打包实际失败"
        return 1
    fi
    if [ -s "$errlog" ]; then
        cat "$errlog" >&2
    fi
    rm -f "$errlog"
    # fnpack 产物命名为 <appname>.fpk（即 com.rainbow.music.fpk）：
    # app/ 压缩为 app.tgz、manifest 追加 checksum。按 *.fpk 查找后搬运到契约路径。
    local built
    built=$(find "$STAGE" -maxdepth 2 -name '*.fpk' -type f | head -n1)
    if [ -z "$built" ]; then
        warn "fnpack 执行后未找到产物（*.fpk）"
        return 1
    fi
    mv "$built" "$OUT_PATH"
}

pack_with_tar() {
    # 手工按 .fpk 结构组装（参考 fnos-apps scripts/build-fpk.sh：tar -czf 打包包根内容）
    # 注意：降级产物无 fnpack 的 app.tgz/checksum 处理，仅供本地验证
    ( cd "$STAGE" && tar -czf "$OUT_PATH" manifest config cmd wizard app ICON.PNG ICON_256.PNG )
}

if [ -n "$FNPACK_BIN" ]; then
    info "使用 fnpack 打包：$FNPACK_BIN"
    if ! pack_with_fnpack; then
        warn "fnpack 打包失败，降级为手工 tar 组装"
        warn "警示：降级产物仅供本地验证，真机分发请使用 fnpack 构建"
        pack_with_tar
    fi
else
    info "PATH 中未找到 fnpack，使用手工 tar 组装"
    warn "警示：降级产物仅供本地验证，真机分发请使用 fnpack 构建"
    pack_with_tar
fi

[ -f "$OUT_PATH" ] || err "打包失败：未生成 $OUT_PATH"
rm -rf "$STAGE"

info "完成：$OUT_NAME ($(du -h "$OUT_PATH" | cut -f1))"

# ---------- 4. 契约：stdout 最后一行 = 产物绝对路径 ----------
printf '%s\n' "$(cd "$(dirname "$OUT_PATH")" && pwd)/$(basename "$OUT_PATH")"
