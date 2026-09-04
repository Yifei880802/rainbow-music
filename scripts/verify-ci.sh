#!/usr/bin/env bash
#
# verify-ci.sh —— Rainbow 发布前本地 CI 门禁（一键复跑 .github/workflows/build.yml 前四段）
#
# 对应 workflow 作业链：meta → build → docker → fpk（release 为 GitHub 侧动作，不在本地复跑）
#   a. meta   ：版本校验（正则与 workflow meta 一致）并推导 image_tag=v${VERSION}
#   b. build  ：cd server && npm ci（仅 node_modules 缺失时）&& npm run typecheck && npm run build
#   c. docker ：docker buildx build --platform $PLATFORM -t ${FPK_IMAGE}:${image_tag} --load .（可 --skip-docker 跳过）
#   d. fpk    ：注入 FPK_VERSION / FPK_IMAGE / FPK_IMAGE_TAG 调 scripts/build-fpk.sh，
#               解包产物并程序化校验 compose 内 image 与 ${FPK_IMAGE}:${image_tag} 逐字符一致
#
# 用法示例：
#   scripts/verify-ci.sh                            # 全量门禁（需 docker/buildx 可用，默认 linux/arm64）
#   scripts/verify-ci.sh --skip-docker              # 跳过 buildx 构建与镜像检查（无 docker 环境/与他人共用 colima 时）
#   scripts/verify-ci.sh --platform linux/amd64     # 指定构建平台
#   VERSION=0.2.0-r1 scripts/verify-ci.sh           # 指定版本号（默认取 fpk/manifest 的 version）
#   scripts/verify-ci.sh 0.2.0-r1 --skip-docker     # 版本号也可作首个位置参数
#
# 参数与环境变量：
#   VERSION      可选。X.Y.Z 或 X.Y.Z-rN，校验 ^[0-9]+\.[0-9]+\.[0-9]+(-r[0-9]+)?$；
#                未提供时读 fpk/manifest 的 version 字段
#   --skip-docker  跳过 docker 段（该段记为 SKIP，不影响最终结论）
#   --platform   buildx 目标平台，默认 linux/arm64
#   FPK_IMAGE    镜像名，默认 rainbow-music（本地门禁用短名即可；正式发布时 workflow 注入 ghcr.io/<owner>/rainbow-music）
#   FNPACK_BIN   可选。显式指定 fnpack 可执行文件；未提供且 PATH 无 fnpack 时，
#                build-fpk.sh 自动降级为手工 tar 组装并打印降级警示（降级产物仅供本地验证）
#
# 退出码：全部 PASS → 0；任一 FAIL → 1（SKIP 不影响结论，但汇总中醒目提示）
#
set -euo pipefail

# ─────────────────────────── 基础设施 ───────────────────────────

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

if [[ -t 1 ]]; then
    C_RED=$'\033[0;31m'; C_GREEN=$'\033[0;32m'; C_YELLOW=$'\033[1;33m'
    C_CYAN=$'\033[0;36m'; C_BOLD=$'\033[1m'; C_NC=$'\033[0m'
else
    C_RED=''; C_GREEN=''; C_YELLOW=''; C_CYAN=''; C_BOLD=''; C_NC=''
fi

log()  { printf '%s [%s] %s\n' "$(date '+%H:%M:%S')" "verify-ci" "$*"; }
section() {
    printf '\n%s' "$C_CYAN"
    printf '════════════════════════════════════════════════════════\n'
    printf ' ▶ %s\n' "$*"
    printf '════════════════════════════════════════════════════════%s\n' "$C_NC"
}

STAGE_NAMES=()
STAGE_RESULTS=()
record() { # record <stage> <PASS|FAIL|SKIP>
    STAGE_NAMES+=("$1")
    STAGE_RESULTS+=("$2")
    case "$2" in
        PASS) log "${C_GREEN}${C_BOLD}[$1] PASS${C_NC}" ;;
        FAIL) log "${C_RED}${C_BOLD}[$1] FAIL${C_NC}" ;;
        SKIP) log "${C_YELLOW}${C_BOLD}[$1] SKIP${C_NC}" ;;
    esac
}

# 临时解包目录：mktemp + trap 清理
TMP_EXTRACT=""
cleanup() {
    if [[ -n "$TMP_EXTRACT" && -d "$TMP_EXTRACT" ]]; then
        rm -rf "$TMP_EXTRACT"
    fi
}
trap cleanup EXIT INT TERM

# ─────────────────────────── 参数解析 ───────────────────────────

usage() { sed -n '2,29p' "$0" | sed 's/^# \{0,1\}//'; }

SKIP_DOCKER=0
PLATFORM="linux/arm64"
VERSION="${VERSION:-}"

while [[ $# -gt 0 ]]; do
    case "$1" in
        --skip-docker) SKIP_DOCKER=1 ;;
        --platform)
            [[ $# -ge 2 ]] || { log "错误：--platform 缺少参数"; exit 1; }
            PLATFORM="$2"; shift ;;
        --platform=*) PLATFORM="${1#*=}" ;;
        -h|--help) usage; exit 0 ;;
        -*)
            log "错误：未知参数 ${1}（--help 查看用法）"; exit 1 ;;
        *)
            if [[ -z "$VERSION" ]]; then VERSION="$1"
            else log "错误：多余的位置参数 $1"; exit 1; fi ;;
    esac
    shift
done

FPK_IMAGE="${FPK_IMAGE:-rainbow-music}"
FNPACK_BIN="${FNPACK_BIN:-}"
export FPK_IMAGE FNPACK_BIN

# ─────────────────────────── a. meta ───────────────────────────
# 对应 workflow job「meta：解析版本号」

stage_meta() {
    if [[ -z "$VERSION" ]]; then
        [[ -f "$REPO_ROOT/fpk/manifest" ]] || { log "错误：未指定 VERSION 且找不到 fpk/manifest"; return 1; }
        VERSION="$(grep '^version=' "$REPO_ROOT/fpk/manifest" | head -n1 | cut -d= -f2- | tr -d ' \r')"
        log "VERSION 未指定，取 fpk/manifest：$VERSION"
    fi
    # 与 workflow meta 正则一致（本地输入不带 v 前缀）
    if ! [[ "$VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+(-r[0-9]+)?$ ]]; then
        log "错误：版本号不合法：'$VERSION'（要求 X.Y.Z 或 X.Y.Z-rN）"
        return 1
    fi
    IMAGE_TAG="v${VERSION}"
    log "version=$VERSION  image=${FPK_IMAGE}:${IMAGE_TAG}  platform=$PLATFORM"
    return 0
}

# ─────────────────────────── b. build ───────────────────────────
# 对应 workflow job「build：Typecheck + 编译」

stage_build() {
    [[ -f "$REPO_ROOT/server/package.json" ]] || { log "错误：找不到 server/package.json"; return 1; }
    (
        cd "$REPO_ROOT/server"
        if [[ ! -d node_modules ]]; then
            log "node_modules 缺失，执行 npm ci"
            npm ci || { log "错误：npm ci 失败"; return 1; }
        else
            log "node_modules 已存在，跳过 npm ci"
        fi
        npm run typecheck || { log "错误：npm run typecheck 失败"; return 1; }
        npm run build     || { log "错误：npm run build 失败"; return 1; }
    ) || return 1
    return 0
}

# ─────────────────────────── c. docker ───────────────────────────
# 对应 workflow job「docker：buildx 构建」（本地只 --load 不推送）

stage_docker() {
    if [[ "$SKIP_DOCKER" -eq 1 ]]; then
        log "--skip-docker 已指定，跳过 buildx 构建与镜像检查"
        return 2   # 2 = SKIP
    fi
    if ! command -v docker >/dev/null 2>&1 || ! docker buildx version >/dev/null 2>&1; then
        log "错误：docker / buildx 不可用。请先启动运行时，例如：colima start"
        return 1
    fi
    (
        cd "$REPO_ROOT"
        docker buildx build \
            --platform "$PLATFORM" \
            -t "${FPK_IMAGE}:${IMAGE_TAG}" \
            --load .
    ) || { log "错误：buildx build 失败（platform=${PLATFORM}）"; return 1; }
    log "镜像已加载：${FPK_IMAGE}:${IMAGE_TAG}（${PLATFORM}）"
    return 0
}

# ─────────────────────────── d. fpk ───────────────────────────
# 对应 workflow job「fpk：打包 .fpk」+ 本地追加的 tag 一致性程序化校验

stage_fpk() {
    local fpk_path expected actual compose

    # 降级预警：fnpack 不可得时 build-fpk.sh 会自行降级并打印警示
    if [[ -z "$FNPACK_BIN" ]] && ! command -v fnpack >/dev/null 2>&1; then
        log "${C_YELLOW}提示：PATH 中无 fnpack 且未指定 FNPACK_BIN，build-fpk.sh 将走降级组装路径（产物仅供本地验证）${C_NC}"
    fi

    export FPK_VERSION="$VERSION"
    export FPK_IMAGE_TAG="$IMAGE_TAG"
    log "注入 FPK_VERSION=$FPK_VERSION FPK_IMAGE=$FPK_IMAGE FPK_IMAGE_TAG=$FPK_IMAGE_TAG"

    # build-fpk.sh 契约：info 全部走 stderr，stdout 最后一行 = 产物绝对路径
    if ! fpk_path="$(bash "$REPO_ROOT/scripts/build-fpk.sh")"; then
        log "错误：scripts/build-fpk.sh 执行失败"
        return 1
    fi
    fpk_path="$(printf '%s\n' "$fpk_path" | tail -n1)"
    [[ -f "$fpk_path" ]] || { log "错误：产物不存在：$fpk_path"; return 1; }
    log "产物：$fpk_path"

    # 解包（mktemp 临时目录，trap 清理）
    TMP_EXTRACT="$(mktemp -d "${TMPDIR:-/tmp}/rainbow-verify-ci.XXXXXX")"
    if ! tar -xzf "$fpk_path" -C "$TMP_EXTRACT"; then
        log "错误：解包失败：$fpk_path"
        return 1
    fi
    # 官方 fnpack 产物为 app.tgz 结构（app/ 压缩在 app.tgz 内）；降级 tar 产物则直接含 app/
    if [[ -f "$TMP_EXTRACT/app.tgz" ]]; then
        log "检测到 fnpack 官方结构（app.tgz），二次解包"
        tar -xzf "$TMP_EXTRACT/app.tgz" -C "$TMP_EXTRACT" \
            || { log "错误：解包 app.tgz 失败"; return 1; }
    else
        log "未检测到 app.tgz，按降级 tar 结构处理（直接含 app/）"
    fi

    # 官方 fnpack 的 app.tgz 解出后为 app/ 目录内容平铺（docker/、ui/、config/，无 app/ 前缀）；
    # 降级 tar 产物则直接含 app/。两种结构的 compose 路径均能被 '*docker/docker-compose.y*ml' 命中。
    compose="$(find "$TMP_EXTRACT" -type f -path '*docker/docker-compose.y*ml' | head -n1)"
    [[ -n "$compose" ]] || { log "错误：解包产物中找不到 app/docker/docker-compose.y*ml"; return 1; }

    # compose 内 image 与预期值逐字符比对
    expected="${FPK_IMAGE}:${IMAGE_TAG}"
    actual="$(grep -E '^[[:space:]]*image:' "$compose" | head -n1 \
        | sed -E 's/^[[:space:]]*image:[[:space:]]*//' \
        | tr -d '"' | tr -d "'" | tr -d '[:space:]')"
    log "compose image 实际值：'$actual'"
    log "预期值　　　　　　：'$expected'"
    if [[ "$actual" == "$expected" ]]; then
        log "${C_GREEN}${C_BOLD}TAG_CONSISTENCY_PASS${C_NC}"
    else
        log "${C_RED}${C_BOLD}TAG_CONSISTENCY_FAIL${C_NC}：compose 内 image 与 ${FPK_IMAGE}:${IMAGE_TAG} 不一致"
        return 1
    fi

    # 附加校验：manifest version 应为剥离 -rN 后的纯 X.Y.Z
    # 注意：fnpack 官方产物 manifest 为对齐格式（"version   = X.Y.Z"，= 两侧有空格），
    # 降级 tar 产物为紧凑格式（"version=X.Y.Z"），用 awk 按首个 = 切分以兼容两者
    if [[ -f "$TMP_EXTRACT/manifest" ]]; then
        local manifest_v
        manifest_v="$(awk -F= '$1 ~ /^[[:space:]]*version[[:space:]]*$/ {gsub(/[ \r]/,"",$2); print $2; exit}' "$TMP_EXTRACT/manifest")"
        if [[ "$manifest_v" != "${VERSION%%-r*}" ]]; then
            log "错误：fpk 内 manifest version='$manifest_v'，预期 '${VERSION%%-r*}'"
            return 1
        fi
        log "manifest version 校验通过：$manifest_v"
    fi

    # ── v0.2.15 包级断言：下载挂载源 = data-share 软链，且无 wizard_download_dir 残留 ──
    local share_src="/var/apps/com.rainbow.music/shares/rainbow-music"
    local dl_re='^[[:space:]]*-[[:space:]]+[^:]+:/app/data/downloads[[:space:]]*$'
    local dl_count dl_line dl_src
    dl_count="$(grep -Ec "$dl_re" "$compose" || true)"
    if [[ "$dl_count" -ne 1 ]]; then
        log "${C_RED}${C_BOLD}DOWNLOAD_MOUNT_FAIL${C_NC}：映射到 /app/data/downloads 的 volume 行应恰好 1 条，实际 ${dl_count} 条"
        return 1
    fi
    dl_line="$(grep -E "$dl_re" "$compose" | head -n1)"
    dl_src="$(printf '%s\n' "$dl_line" | sed -E 's/^[[:space:]]*-[[:space:]]+//; s#:/app/data/downloads[[:space:]]*$##')"
    if [[ "$dl_src" != "$share_src" ]]; then
        log "${C_RED}${C_BOLD}DOWNLOAD_MOUNT_FAIL${C_NC}：下载挂载源='$dl_src'，预期 '$share_src'"
        return 1
    fi
    log "${C_GREEN}${C_BOLD}DOWNLOAD_MOUNT_PASS${C_NC}：下载目录挂载 data-share 软链（${share_src} → /app/data/downloads）"

    # 拒绝旧的 @appdata 下载挂载回潮
    if grep -Fq '${TRIM_PKGVAR}/data/downloads:/app/data/downloads' "$compose"; then
        log "${C_RED}${C_BOLD}DOWNLOAD_MOUNT_FAIL${C_NC}：compose 仍存在旧挂载 \${TRIM_PKGVAR}/data/downloads:/app/data/downloads"
        return 1
    fi

    # 拒绝 wizard_download_dir 残留：向导 JSON 不得含该字段（JSON 无注释，裸词即违规）
    local wiz_install wiz_config cmdf
    wiz_install="$(find "$TMP_EXTRACT" -type f -path '*wizard/install' | head -n1)"
    wiz_config="$(find "$TMP_EXTRACT" -type f -path '*wizard/config' | head -n1)"
    if [[ -z "$wiz_install" || -z "$wiz_config" ]]; then
        log "${C_RED}${C_BOLD}WIZARD_FIELD_FAIL${C_NC}：解包产物中找不到 wizard/install 或 wizard/config"
        return 1
    fi
    if grep -Fq 'wizard_download_dir' "$wiz_install" || grep -Fq 'wizard_download_dir' "$wiz_config"; then
        log "${C_RED}${C_BOLD}WIZARD_FIELD_FAIL${C_NC}：向导文件仍含 wizard_download_dir 字段"
        return 1
    fi
    # cmd 脚本不得有 ${wizard_download_dir} 变量用法（记录“已移除”的裸词注释允许保留）
    while IFS= read -r cmdf; do
        [[ -n "$cmdf" ]] || continue
        if grep -Fq '${wizard_download_dir' "$cmdf"; then
            log "${C_RED}${C_BOLD}WIZARD_FIELD_FAIL${C_NC}：$cmdf 仍引用 \${wizard_download_dir}"
            return 1
        fi
    done < <(find "$TMP_EXTRACT" -type f -path '*cmd/*')
    log "${C_GREEN}${C_BOLD}WIZARD_FIELD_PASS${C_NC}：向导/回调均无 wizard_download_dir 残留"

    # v0.2.15：download.dir 收敛必须在包内生效——老现场把宿主绝对路径写进配置，
    # 而 render_config 幂等跳过已存在的 config.yaml，仅改 compose 挂载修不了老现场
    local common_f install_cb upgrade_cb
    common_f="$(find "$TMP_EXTRACT" -type f -path '*cmd/_common' | head -n1)"
    install_cb="$(find "$TMP_EXTRACT" -type f -path '*cmd/install_callback' | head -n1)"
    upgrade_cb="$(find "$TMP_EXTRACT" -type f -path '*cmd/upgrade_callback' | head -n1)"
    if [[ -z "$common_f" || -z "$install_cb" || -z "$upgrade_cb" ]]; then
        log "${C_RED}${C_BOLD}DDIR_CONVERGE_FAIL${C_NC}：解包产物缺少 cmd/_common、install_callback 或 upgrade_callback"
        return 1
    fi
    if ! grep -q '^normalize_download_dir()' "$common_f"; then
        log "${C_RED}${C_BOLD}DDIR_CONVERGE_FAIL${C_NC}：cmd/_common 未定义 normalize_download_dir()"
        return 1
    fi
    if ! grep -qE '^[[:space:]]*normalize_download_dir' "$install_cb" \
        || ! grep -qE '^[[:space:]]*normalize_download_dir' "$upgrade_cb"; then
        log "${C_RED}${C_BOLD}DDIR_CONVERGE_FAIL${C_NC}：install_callback / upgrade_callback 未调用 normalize_download_dir"
        return 1
    fi
    if ! grep -q 'cp -p "$CONFIG_FILE"' "$common_f"; then
        log "${C_RED}${C_BOLD}DDIR_CONVERGE_FAIL${C_NC}：normalize_download_dir 改写前未备份 config.yaml"
        return 1
    fi
    # 改写必须限定在 download: 块内——sources: 块同样有 dir: 行，全局替换会毁掉音源目录
    if ! grep -q '\^download:' "$common_f"; then
        log "${C_RED}${C_BOLD}DDIR_CONVERGE_FAIL${C_NC}：normalize_download_dir 未按 download: 块限定 dir: 匹配"
        return 1
    fi
    log "${C_GREEN}${C_BOLD}DDIR_CONVERGE_PASS${C_NC}：安装/升级回调均收敛遗留 download.dir（改前备份、限定 download 块）"

    return 0
}

# ─────────────────────────── 作业链调度 ───────────────────────────

LAST_RESULT=""
run_stage() { # run_stage <name> <fn>
    local name="$1" fn="$2" rc=0
    section "$name"
    "$fn" || rc=$?
    if [[ $rc -eq 2 ]]; then record "$name" SKIP
    elif [[ $rc -eq 0 ]]; then record "$name" PASS
    else record "$name" FAIL
    fi
    LAST_RESULT="${STAGE_RESULTS[${#STAGE_RESULTS[@]}-1]}"
}

log "Rainbow 本地 CI 门禁启动：对应 workflow 作业链 meta → build → docker → fpk"

run_stage "meta"   stage_meta

# meta 失败则 VERSION/IMAGE_TAG 未就绪，后续段无意义，直接汇总退出
if [[ "$LAST_RESULT" != "FAIL" ]]; then
    run_stage "build"  stage_build
    run_stage "docker" stage_docker
    run_stage "fpk"    stage_fpk
fi

# ─────────────────────────── e. 汇总 ───────────────────────────

section "汇总"
FAIL_COUNT=0
SKIP_COUNT=0
for i in "${!STAGE_NAMES[@]}"; do
    name="${STAGE_NAMES[$i]}"; result="${STAGE_RESULTS[$i]}"
    case "$result" in
        PASS) printf '  %s%-8s%s %s\n' "$C_GREEN" "PASS" "$C_NC" "$name" ;;
        FAIL) printf '  %s%-8s%s %s\n' "$C_RED"   "FAIL" "$C_NC" "$name"; FAIL_COUNT=$((FAIL_COUNT+1)) ;;
        SKIP) printf '  %s%-8s%s %s\n' "$C_YELLOW" "SKIP" "$C_NC" "$name"; SKIP_COUNT=$((SKIP_COUNT+1)) ;;
    esac
done

if [[ $SKIP_COUNT -gt 0 ]]; then
    printf '\n%s⚠ 注意：%d 个作业被跳过（SKIP），其结论未经本门禁验证%s\n' "$C_YELLOW" "$SKIP_COUNT" "$C_NC"
fi

if [[ $FAIL_COUNT -eq 0 ]]; then
    log "${C_GREEN}${C_BOLD}门禁结论：PASS（可发布）${C_NC}"
    exit 0
else
    log "${C_RED}${C_BOLD}门禁结论：FAIL（${FAIL_COUNT} 个作业失败，禁止发布）${C_NC}"
    exit 1
fi
