#!/usr/bin/env bash
# =============================================================================
# fnos-gateway-heal.sh — Rainbow（com.rainbow.music）fnOS 网关字段 heal
#                        （root 语境，幂等，纯 additive 运维脚本）
#
# 背景（详见 docs/FNOS-DEPLOY.md「v0.2.7/v0.2.8 网关 404 第三层根因」章）：
#   fnOS 对「手动安装的 Docker 形态应用」（manual_install=t + is_docker=t）
#   不解析 ui/config 的 gateway 字段 → appcenter.app_service 与 trim_sac.entry
#   两表的 gateway_socket / gateway_prefix 为空 → sacentry 周期任务无 socket
#   可注册 → 认证后访问 /app/com.rainbow.music/* 返回 404（9B）。
#   fpk 生命周期回调侧的自动补写（rb_psql/watcher）已被真机实证否决：回调以
#   应用专用用户 uid 975 执行，连 /var/run/docker.sock EACCES（t107/t114/t117），
#   三条宿主通道（pg peer / sudo / docker.sock）全部关闭。
#   唯一被真机实证成功的补写通道 = root 语境（root 同时具备 docker.sock 权限
#   与 pg_ident trim_root 的 peer 认证映射），本脚本即该通道的手修配方
#   （docs/FNOS-DEPLOY.md「DB 热修」节 SQL）的正式化、可复用版本。
#
# 通道原理（与 fpk/cmd/_common 的 rb_psql() 同源，勿改语法）：
#   宿主直接跑 psql 会被 pg_hba 的 local peer 认证拒绝（pg_ident trim_root 仅
#   映射 root→postgres，且宿主未必有 psql 依赖环境）。改经 docker 容器执行
#   「宿主 psql 二进制」：docker run 把宿主 /usr /run 只读挂载为容器内
#   /husr /hrun，用宿主 ld-linux 以 --library-path 拉起宿主 psql，连
#   /hrun/postgresql 的 unix socket——容器内进程 uid 0，经共享 unix socket 的
#   peer 凭据为 root，trim_root 放行。
#   ⚠️ 命名空间铁律：docker run 的 --entrypoint 与其后所有路径参数都在「新容器」
#   命名空间解析。宿主 /usr 挂到容器 /husr，而镜像基于 node:22-bookworm-slim
#   （见 Dockerfile），自身 /usr 里没有 ld-linux 对应布局、更没有
#   postgresql-client——容器侧写 /usr/... 首跑即失败。真机实证成功的配方是
#   .qa-tmp/t114/probe-repro.sh 变体 B（rc=0）与 probe-heal.sh，容器侧一律
#   /husr/... 前缀；本脚本据此拆分 HOST_*（宿主命名空间，仅供前置校验）与
#   LOADER/PSQLBIN（容器命名空间，供 docker run）。
#   镜像引用取自应用 compose 落盘文件的 image: 行（rainbow 自身镜像，与宿主
#   glibc/libpq 布局兼容已实证）。
#   ⚠️ v0.2.14（t114 三重复现）已证伪「镜像名后加 -- 分隔符」的写法：-- 会被
#   docker 透传给 ld-linux 导致 usage 错。本脚本保持不带 -- 的 v0.2.11 语法。
#
# SQL 出处（以文档已验证版本为准，未臆造任何字段/表名）：
#   docs/FNOS-DEPLOY.md「DB 热修（已在真机执行并验证，2026-08-27 20:31/20:42）」
#   与 fpk/cmd/_common fix_gateway_socket() 逐字一致：
#     appcenter.app_service：WHERE service_name='com.rainbow.music.Application'
#                            AND coalesce(gateway_socket,'')=''
#     trim_sac.entry       ：WHERE app_name='com.rainbow.music'
#                            AND service_name='com.rainbow.music.Application'
#                            AND coalesce(gateway_socket,'')=''
#     SET gateway_socket='/var/apps/com.rainbow.music/target/app.sock',
#         gateway_prefix='/app/com.rainbow.music', updated_at=now()
#   幂等语义：只补空字段——fnOS 已正确写入或先前 heal 过的行不会被改动。
#
# 用法（NAS 宿主；权威副本应置于 root-only 路径，见 docs/FNOS-GATEWAY-HEAL.md §1）：
#   sudo bash /usr/local/sbin/fnos-gateway-heal.sh --dry-run   # 只 SELECT 回读，不写
#   sudo bash /usr/local/sbin/fnos-gateway-heal.sh             # 幂等补写 + 回读确认
#   可选环境变量：
#     RB_COMPOSE_FILE  指定 compose 文件（默认自动探测 /vol*/@appcenter/<app>/docker/docker-compose.yaml）
#     RB_IMAGE         直接指定镜像引用（跳过从 compose 提取 image: 行）
#   注意：带环境变量时不要用 sudo -E（依赖 sudoers 配置），用精确注入：
#     sudo env RB_IMAGE=<镜像引用> bash /usr/local/sbin/fnos-gateway-heal.sh
#
# 退出码语义（runbook 第 6 节同口径）：
#   0   两表已是正确状态（幂等 no-op，本次未发生任何写入）
#   10  本次发生写入且 re-SELECT 回读确认落库（cron 场景可只筛 10 = 写库事件）
#   1   用法错误（未知参数等）
#   2   补写结果异常（回读未达「双表期望值命中」：行键错配 / 值非空但非期望 /
#       被周期同步覆盖），排查见 docs/FNOS-GATEWAY-HEAL.md
#   3   执行通道失败（docker run / psql / SQL 报错 / 回读非数字），stderr 保留
#       postgres 完整错误链；UPDATE 阶段失败时可能处于「库一已写、库二未写」
#       半补写中间态——重跑本脚本幂等安全（只补空字段）
#   4   前置校验失败（非 root / docker 不可用 / compose 或镜像引用缺失或本地
#       不存在 / 宿主或容器侧 loader、psql 路径异常）
#   5   未预期错误（ERR trap 兜底，报出触发行号；不属上面任何已定义分支）
#
# 红线（脚本绝不自动执行，只在结尾与失败路径提示）：
#   DB 直改不触发即时注册，须等下一个 sacentry 周期（约 30 分钟）；如需即时
#   生效须重启网关进程 trim_http_cgi——该动作曾导致全站 Cloudflare 隧道断开
#   （530 断联，恢复需物理介入），必须人工确认，本脚本与任何自动化禁止执行。
# =============================================================================

set -euoE pipefail

# ---------- 固定参数（与文档已验证 SQL / _common 实现同源，勿单侧改动） ----------
APP='com.rainbow.music'
SVC='com.rainbow.music.Application'
SOCK='/var/apps/com.rainbow.music/target/app.sock'
PREFIX='/app/com.rainbow.music'
# 宿主命名空间路径（仅供 preflight 存在性校验；docker run 绝不能用这组，见头注「命名空间铁律」）
HOST_LOADER='/usr/lib/x86_64-linux-gnu/ld-linux-x86-64.so.2'
HOST_PSQLBIN='/usr/lib/postgresql/15/bin/psql'
# 容器命名空间路径（docker run 内解析；宿主 /usr 挂载为 /husr，与 t114 probe-repro.sh
# 变体 B（rc=0，真机实证）/ probe-heal.sh 逐字对齐）
LOADER='/husr/lib/x86_64-linux-gnu/ld-linux-x86-64.so.2'
PSQLBIN='/husr/lib/postgresql/15/bin/psql'
PGSOCK_DIR='/run/postgresql'
LIBPATH='/husr/lib/x86_64-linux-gnu:/husr/lib:/husr/lib/postgresql/15/lib'

MODE='heal'          # heal | dry
IMAGE=''             # compose 提取或 RB_IMAGE 覆盖（镜像引用，可能含 @digest pin）
COMPOSE_FILE_RESOLVED=''
RB_OUT=''            # rb_psql 最近一次 stdout
RB_ERR=''            # rb_psql 最近一次 stderr 全文（原样保留，绝不压缩丢弃）
RB_TMPFILES=''       # 本脚本创建的临时文件（换行分隔），EXIT trap 统一清理

# ---------- 日志 ----------
ts()   { date '+%Y-%m-%d %H:%M:%S'; }
info() { printf '[%s] %s\n' "$(ts)" "$*"; }
warn() { printf '[%s] 警告：%s\n' "$(ts)" "$*"; }
err()  { printf '[%s] 错误：%s\n' "$(ts)" "$*" >&2; }

NL='
'

# ---------- 小工具 ----------
# pipefail 下 grep -q / head -1 命中即退会让管道上游收 SIGPIPE（rc=141）→ 整条
# 管道非零，误触 set -e/ERR trap。统一改「全量读完再判定」的等价写法：
has_line() { # $1=多行文本 $2=目标行；整行精确匹配
    # 修复（ID:154 缺陷1）：旧版 case "\n$1\n" / *"\n$2\n"* —— 双引号内的 \n 是
    # 字面「反斜杠+n」两个字符（case 不做转义解释，od 实测 \ n），而多行文本内部
    # 是真实换行 0xa，两者永不对齐 → 除「整段文本恰为单行且等于目标」外，按行
    # 匹配全部失效。改用脚本上方已定义的真实换行变量 NL 包裹，恢复整行精确匹配。
    # 不回退 grep -q/head -1 管道（继续规避 pipefail × SIGPIPE 陷阱）；无 bash4
    # 特性，兼容 bash 3.2 与 fnOS 老 bash。
    case "$NL$1$NL" in
        *"$NL$2$NL"*) return 0 ;;
        *) return 1 ;;
    esac
}

first_line() { # $1=多行文本 → stdout 首行（空输入输出空）
    local s="$1"
    printf '%s' "${s%%"$NL"*}"
}

# 未捕获错误兜底（set -E 让 ERR trap 进函数/子壳）：报出触发行号后统一 exit 5，
# 绝不静默失败。已定义分支（exit 1/2/3/4）各自显式退出，不经此 trap。
trap 'rc=$?; err "脚本在第 ${LINENO} 行触发未预期错误（退出码 ${rc}），请连同上文输出排查"; print_redline; exit 5' ERR
# EXIT trap：信号打断/任何退出路径都清掉本脚本创建的临时文件，不留 /tmp 残留
trap 'cleanup_tmp' EXIT

# EXIT trap 间接调用（见上 trap 'cleanup_tmp' EXIT）：SC2329 静态分析无法识别
# trap 字符串内的函数调用，此处属误报，显式豁免。
# shellcheck disable=SC2329
cleanup_tmp() {
    local f
    if [ -n "$RB_TMPFILES" ]; then
        while IFS= read -r f; do
            [ -n "$f" ] && rm -f "$f" 2>/dev/null
        done <<EOF
$RB_TMPFILES
EOF
    fi
}

usage() {
    cat <<'EOF'
用法：
  sudo bash /usr/local/sbin/fnos-gateway-heal.sh [--dry-run]
  （权威副本置于 root-only 路径；/tmp 仅作拷贝中转、用后即删，见 runbook §1/§5）

选项：
  --dry-run   只 SELECT 回读两表现状（gateway_socket / gateway_prefix /
              install_volume_id 等关键字段，列存在性动态适配），不做任何写入
  -h, --help  显示本帮助

环境变量（可选；sudo 场景用精确注入  sudo env VAR=值 bash 本脚本，勿用 sudo -E）：
  RB_COMPOSE_FILE   指定应用 compose 文件路径（默认自动探测
                    /vol*/@appcenter/com.rainbow.music/docker/docker-compose.yaml）
  RB_IMAGE          直接指定执行 SQL 所用镜像引用（默认从 compose 的 image: 行提取）

退出码：
  0=已正确（无写入）  10=本次发生写入且确认落库  1=用法错误
  2=补写结果异常（疑似行键错配/被覆盖）
  3=执行通道失败（stderr 含 postgres 完整错误链；UPDATE 阶段失败可能留下
    「库一已写、库二未写」中间态，重跑幂等安全）
  4=前置校验失败  5=未预期错误（ERR trap 兜底）
EOF
}

# ---------- 参数解析 ----------
while [ $# -gt 0 ]; do
    case "$1" in
        --dry-run) MODE='dry' ;;
        -h|--help) usage; exit 0 ;;
        *)
            err "未知参数：$1"
            usage >&2
            exit 1
            ;;
    esac
    shift
done

# ---------- SQL 执行通道（与 _common rb_psql 同款 docker run，不带 -- 分隔符） ----------
# $1=库名 $2=SQL；成功：RB_OUT=stdout（psql -At 格式）返回 0；
# 失败：RB_ERR=stderr 全文并返回非 0（调用方决定 fatal 或降级提示）。
# ⚠️ --entrypoint 与其后路径参数全部用容器命名空间的 /husr/...（LOADER/PSQLBIN），
# 绝不能用宿主 /usr/...（HOST_* 仅供 preflight），见头注「命名空间铁律」。
rb_psql() {
    local db="$1" sql="$2" errf rc=0
    errf="$(mktemp "${TMPDIR:-/tmp}/rb-heal-err.XXXXXX")"
    RB_TMPFILES="${RB_TMPFILES}${RB_TMPFILES:+$NL}${errf}"
    RB_OUT=''
    RB_ERR=''
    set +e
    RB_OUT="$(docker run --rm \
        -v /usr:/husr:ro -v /run:/hrun:ro \
        --entrypoint "$LOADER" "$IMAGE" \
        --library-path "$LIBPATH" \
        "$PSQLBIN" -h /hrun/postgresql -U postgres -d "$db" -Atc "$sql" 2>"$errf")"
    rc=$?
    set -e
    RB_ERR="$(cat "$errf" 2>/dev/null || true)"
    rm -f "$errf" 2>/dev/null || true
    return "$rc"
}

# 失败路径统一红线提示（ID:147 评审第 11 条）：exit 2/3/5 正是运维最容易冲动
# 重启网关进程的时刻，所有非用法错误（exit 1）的终止路径退出前必须打印本提示。
print_redline() {
    cat >&2 <<EOF

---------- ⚠️ 失败路径固定提示（运维红线） ----------
- 请等下一个 sacentry 周期（约 30 分钟）后复测；DB 直改不触发即时注册。
- 【禁止】重启网关进程 trim_http_cgi / cloudflared / reboot NAS——曾导致全站
  Cloudflare 隧道断开（530 断联，远程通道全断，恢复需现场物理介入）。
- 若失败发生在 UPDATE 阶段，两表可能处于「库一已写、库二未写」的半补写
  中间态：重跑本脚本幂等安全（只补空字段，不会重复写/覆盖非空值）。
- 完整红线清单见 docs/FNOS-GATEWAY-HEAL.md 第 4 节。
------------------------------------------------------
EOF
}

# 通道失败 = 无法给出任何 DB 层结论 → 红线提示 + 完整错误链进 stderr 后退出 3。
# stderr 逐行原样打印（不压缩、不截尾）：v0.2.14 教训——docker/psql 多行 stderr
# 的真实错误常在中间行，末行只是 usage 提示（tail -1 陷阱曾致两轮误诊）。
fail_channel() {
    local step="$1"
    err "执行通道失败（步骤：${step}），以下为 stderr 完整错误链："
    if [ -n "$RB_ERR" ]; then
        printf '%s\n' "$RB_ERR" >&2
    else
        err "（stderr 为空——docker run 非零退出但无输出；镜像引用 ${IMAGE} 已过前置存在性校验，请贴出上文全部输出人工排查）"
    fi
    print_redline
    exit 3
}

# ---------- 前置校验（任一不满足 → 中文指引 + 非零退出，绝不静默失败） ----------
preflight() {
    # 1) root 语境：peer 认证映射 trim_root 仅 root→postgres；非 root 连通道都不成立
    if [ "${EUID:-$(id -u)}" -ne 0 ]; then
        err "必须以 root 运行（当前 uid=$(id -u)）。fnOS 的 pg_ident trim_root 映射仅对 root 放行 peer 认证，非 root 语境没有任何可用补写通道（t107 实证 uid 975 连 docker.sock 都 EACCES）。"
        local flag=''
        [ "$MODE" = "dry" ] && flag=' --dry-run'
        err "指引：在 NAS 宿主上执行  sudo bash $0${flag}"
        exit 4
    fi

    # 2) docker CLI 可用
    if ! command -v docker >/dev/null 2>&1; then
        err "docker CLI 不可用（PATH 中未找到）。本脚本经 docker 容器执行宿主 psql（root peer 认证通道），无 docker 即无通道。"
        err "指引：确认在 fnOS 宿主（而非容器内）执行；若 PATH 异常可尝试  sudo /usr/bin/bash $0"
        exit 4
    fi

    # 3) docker.sock 存在且当前身份可写（root 语境下 -w 应为真；不可写说明 socket 异常）
    if [ ! -S /var/run/docker.sock ]; then
        err "/var/run/docker.sock 不存在或不是 unix socket——docker daemon 可能未运行。"
        err "指引：systemctl status docker 确认 daemon 状态；daemon 未起时本脚本无法工作。"
        exit 4
    fi
    if [ ! -w /var/run/docker.sock ]; then
        err "/var/run/docker.sock 不可写（当前身份 uid=$(id -u)）——root 语境下不应出现，检查 socket 权限是否被改动（正常为 root:docker 0660）。"
        exit 4
    fi

    # 4) docker daemon 实际可通信（比 -w 更强的探测；失败时给出指引）
    if ! docker info >/dev/null 2>&1; then
        err "docker daemon 不可达（docker info 失败）。"
        err "指引：systemctl status docker；若 daemon 正常仍失败，贴出  docker info 2>&1  全文排查。"
        exit 4
    fi

    # 5) 定位 compose 落盘文件（提取 image: 行用；RB_COMPOSE_FILE 可显式覆盖）
    local c match_count=0
    COMPOSE_FILE_RESOLVED="${RB_COMPOSE_FILE:-}"
    if [ -z "$COMPOSE_FILE_RESOLVED" ]; then
        # fnOS 把应用 compose 保存在 @appcenter/<app>/docker/ 下；卷号（/vol1 /vol2 …）
        # 因机而异，故 glob 探测。standalone 语境没有 TRIM_APPDEST 注入，不能依赖它。
        # 多卷多命中时不再静默取字典序第一个：告警并要求显式指定（评审第 15 条）。
        for c in /vol*/@appcenter/"$APP"/docker/docker-compose.yaml; do
            if [ -f "$c" ]; then
                match_count=$((match_count + 1))
                if [ -z "$COMPOSE_FILE_RESOLVED" ]; then
                    COMPOSE_FILE_RESOLVED="$c"
                else
                    warn "compose 探测多命中：已暂取 ${COMPOSE_FILE_RESOLVED}，另有 ${c}"
                fi
            fi
        done
        if [ "$match_count" -gt 1 ]; then
            warn "多卷同时存在 compose（共 ${match_count} 处），默认取字典序第一个可能不是现役安装卷。"
            err "指引：确认现役卷后用  sudo env RB_COMPOSE_FILE=<路径> bash $0  显式指定。"
            exit 4
        fi
    fi
    if [ -z "$COMPOSE_FILE_RESOLVED" ] || [ ! -f "$COMPOSE_FILE_RESOLVED" ]; then
        err "未找到应用 compose 文件（探测模式 /vol*/@appcenter/${APP}/docker/docker-compose.yaml，且未设置 RB_COMPOSE_FILE）。"
        err "可能原因：Rainbow 未安装 / 安装卷布局异常 / @appcenter 目录不可读。"
        err "指引：ls -d /vol*/@appcenter/${APP} 确认应用目录；找到后用  sudo env RB_COMPOSE_FILE=<路径> bash $0  显式指定。"
        exit 4
    fi

    # 6) 提取镜像引用（与 _common rb_psql 相同的 sed 表达式；RB_IMAGE 可覆盖）。
    #    多 image: 行命中同样告警 + 要求显式指定，不静默取第一行。
    IMAGE="${RB_IMAGE:-}"
    if [ -z "$IMAGE" ]; then
        local img_lines img_count
        img_lines="$(sed -n 's/^[[:space:]]*image:[[:space:]]*//p' "$COMPOSE_FILE_RESOLVED" 2>/dev/null | tr -d "\"'")"
        img_count="$(printf '%s\n' "$img_lines" | grep -c '[^[:space:]]' || true)"
        if [ "$img_count" -gt 1 ]; then
            err "compose（${COMPOSE_FILE_RESOLVED}）中提取到 ${img_count} 个 image: 行，无法自动裁决："
            printf '%s\n' "$img_lines" >&2
            err "指引：人工确认执行 SQL 所用镜像（应为 rainbow 自身镜像）后，用  sudo env RB_IMAGE=<镜像引用> bash $0  显式指定。"
            exit 4
        fi
        IMAGE="$(first_line "$img_lines")"
    fi
    if [ -z "$IMAGE" ]; then
        err "未能取得执行 SQL 所用镜像：${RB_IMAGE:+RB_IMAGE 为空且 }compose（${COMPOSE_FILE_RESOLVED}）中未提取到 image: 行。"
        err "指引：cat ${COMPOSE_FILE_RESOLVED} 人工确认镜像名后，用  sudo env RB_IMAGE=<镜像引用> bash $0  重试。"
        exit 4
    fi

    # 6b) 镜像本地存在性（评审第 15 条）：本地缺失时 docker run 会隐式出网 pull——
    #     digest pin（tag@sha256:…）形态在本地无对应 RepoDigest 时同样触发拉取。
    #     本脚本定位离线运维通道，绝不隐式出网：本地没有就直接拒绝并给指引。
    if ! docker image inspect "$IMAGE" >/dev/null 2>&1; then
        err "镜像本地不存在：${IMAGE}（docker image inspect 失败）。继续执行会让 docker run 隐式出网拉取，本脚本拒绝。"
        err "指引：docker images 确认 rainbow 镜像的实际 tag/digest（升级后旧引用可能已悬空）；确需使用该镜像时先人工 docker pull ${IMAGE}，再用  sudo env RB_IMAGE=<镜像引用> bash $0  重试。"
        exit 4
    fi

    # 7) 宿主 loader / psql 二进制存在（HOST_* = 宿主命名空间，只在这里校验；
    #    容器内实际执行用的是 /husr 前缀的 LOADER/PSQLBIN，见下条一致性断言）
    if [ ! -x "$HOST_LOADER" ]; then
        err "宿主 loader 缺失：${HOST_LOADER}（非 x86_64 布局或路径变化）。"
        err "指引：ls /usr/lib/*/ld-linux-*.so.2 找到实际路径后，同步修改脚本 HOST_LOADER 与 LOADER（容器侧 /husr 前缀版）、LIBPATH 的架构目录。"
        exit 4
    fi
    if [ ! -x "$HOST_PSQLBIN" ]; then
        err "宿主 psql 缺失：${HOST_PSQLBIN}（fnOS PG15 布局变化？fnOS 升级 PG16/arm 后此处会拦下，属预期）。"
        err "指引：ls /usr/lib/postgresql/*/bin/psql 找到实际版本目录后，同步修改脚本 HOST_PSQLBIN 与 PSQLBIN（容器侧 /husr 前缀版）、LIBPATH。"
        exit 4
    fi

    # 7b) 路径前缀一致性断言（评审第 1 条的机械化防线）：容器侧路径必须是宿主
    #     路径的 /usr→/husr 映射，且与 rb_psql 的 -v /usr:/husr:ro 挂载点一致；
    #     LIBPATH 每段同样必须 /husr/ 前缀。防止将来单侧改动再次引入命名空间错配。
    if [ "$LOADER" != "/husr${HOST_LOADER#/usr}" ] || [ "$PSQLBIN" != "/husr${HOST_PSQLBIN#/usr}" ]; then
        err "内部一致性断言失败：LOADER/PSQLBIN 必须是 HOST_LOADER/HOST_PSQLBIN 的 /usr→/husr 映射（当前 ${LOADER} / ${PSQLBIN}）。"
        exit 4
    fi
    local libseg
    local old_ifs="$IFS"
    IFS=':'
    for libseg in $LIBPATH; do
        case "$libseg" in
            /husr/*) : ;;
            *)
                IFS="$old_ifs"
                err "内部一致性断言失败：LIBPATH 段 ${libseg} 缺少 /husr/ 前缀（容器命名空间）。"
                exit 4
                ;;
        esac
    done
    IFS="$old_ifs"

    # 8) PG unix socket 目录存在（-h /hrun/postgresql 的宿主侧实体）
    if [ ! -d "$PGSOCK_DIR" ]; then
        err "${PGSOCK_DIR} 不存在——PostgreSQL 未运行或 socket 目录布局变化。"
        err "指引：systemctl status postgresql*；ls /run | grep -i post 确认实际 socket 目录。"
        exit 4
    fi

    info "前置校验通过：root ✓ docker ✓ compose=${COMPOSE_FILE_RESOLVED} image=${IMAGE}（本地在位 ✓）"
}

# ---------- 列存在性动态适配 ----------
# 已实证的列（文档/探针确认真机存在）：
#   app_service：id, service_name, gateway_socket, gateway_prefix, updated_at
#   entry      ：id, app_name, service_name, gateway_socket, gateway_prefix, updated_at
#   app        ：manual_install, is_docker, is_systemd_uint, source_id（probe61）
# 未逐表实证的列（如 install_volume_id 仅在 probe61 中以「app 行」口径提及）：
#   经 information_schema.columns 动态适配——存在才 SELECT，不存在则跳过并注明，
#   绝不因臆造列名让回读查询整体报错。
# $1=库 $2=表；输出：每行一个列名
table_columns() {
    local db="$1" tbl="$2" rc=0
    rb_psql "$db" "SELECT column_name FROM information_schema.columns WHERE table_name='${tbl}' AND table_schema=current_schema() ORDER BY ordinal_position" || rc=$?
    # 修复（ID:154 缺陷2）：rb_psql 把查询结果写入全局 RB_OUT，并不打到本函数
    # stdout；旧版未回显 → 调用方 have="$(table_columns ...)" 的命令替换恒捕获
    # 空串 → 列动态探测恒走降级路径（回落硬编码最小列集，回读缺列）。此处显式
    # 把 RB_OUT 打印到 stdout，并透传 rb_psql 返回码：失败时 rc≠0，调用方
    # if ! have=$(...) 仍进降级分支；成功但零列时 RB_OUT 为空，printf 输出的
    # 尾换行被命令替换剥离 → have 为空 → 同样降级，语义不变。
    printf '%s\n' "$RB_OUT"
    return "$rc"
    # 注（评审第 18 条）：若目标库的 search_path 被现场改动，current_schema() 可能
    # 解析到非 public schema 而查不到列——此时本函数返回空/报错，调用方已有降级
    # 分支（回退最小列集 / 跳过），不会静默给出错误结论。
}

# 从候选列中挑出实际存在的，拼逗号分隔清单；空候选项直接跳过（评审第 18 条）；
# 候选全部不存在时退回 'id'
pick_columns() {
    local have="$1"; shift
    local c picked='' picked_nl=''
    for c in "$@"; do
        [ -n "$c" ] || continue
        # 去重（ID:154 dry-run 复验暴露）：候选可能重复列入——如 select_app_context
        # 同时传 $where_col 与其字面名 app_name；修复 has_line 前 pick_columns 恒兜底
        # 'id' 掩盖了该重复，修复生效后显形为 SELECT「app_name, app_name」。复用已修复
        # 的 has_line 按整行精确判重，picked_nl 以真实换行 NL 累积已选列。无 bash4 特性。
        if has_line "$picked_nl" "$c"; then continue; fi
        if has_line "$have" "$c"; then
            picked="${picked:+${picked}, }${c}"
            picked_nl="${picked_nl:+${picked_nl}${NL}}${c}"
        fi
    done
    printf '%s' "${picked:-id}"
}

# ---------- 回读（SELECT，逐表打印；行键命中 0 行时显式警示） ----------
# $1=库 $2=表 $3=WHERE $4=标签
select_table() {
    local db="$1" tbl="$2" where="$3" label="$4"
    local cols have skipped='' cand
    printf '\n----- %s（%s.%s）-----\n' "$label" "$db" "$tbl"
    if ! have="$(table_columns "$db" "$tbl")" || [ -z "$have" ]; then
        info "无法取得 ${db}.${tbl} 列清单（表不存在、查询失败或 search_path 非 public），尝试以已实证最小列集回读："
        have='id
gateway_socket
gateway_prefix'
    else
        # install_volume_id 等未实证列：存在才选，缺失注明（不臆造、不报错）
        for cand in install_volume_id volume_id app_id; do
            if ! has_line "$have" "$cand"; then
                skipped="${skipped:+${skipped}, }${cand}"
            fi
        done
        if [ -n "$skipped" ]; then
            info "注：候选附加列 [${skipped}] 在 ${tbl} 中不存在，已跳过（动态适配）"
        fi
    fi
    cols="$(pick_columns "$have" id app_name appname service_name gateway_socket gateway_prefix install_volume_id volume_id app_id created_at updated_at)"
    if ! rb_psql "$db" "SELECT ${cols} FROM ${tbl} WHERE ${where}"; then
        err "${db}.${tbl} 回读失败，stderr 完整错误链："
        printf '%s\n' "$RB_ERR" >&2
        return 3
    fi
    if [ -z "$RB_OUT" ]; then
        printf '(0 行——行键未命中！entry key 形态错配或应用未安装，排查树分支⑤，见 docs/FNOS-GATEWAY-HEAL.md)\n'
    else
        printf '列: %s\n' "$cols"
        printf '%s\n' "$RB_OUT"
    fi
    return 0
}

# appcenter.app 行上下文（install_volume_id 已实证在此表口径提及；WHERE 列名动态适配）
select_app_context() {
    local have where_col='' where='' cols cand
    printf '\n----- appcenter.app 行上下文（install_volume_id / 安装形态）-----\n'
    if ! have="$(table_columns appcenter app)" || [ -z "$have" ]; then
        info "无法取得 appcenter.app 列清单，跳过该上下文回读（不影响两表 heal 判定）"
        return 0
    fi
    for cand in app_name name appname; do
        if has_line "$have" "$cand"; then
            where_col="$cand"
            break
        fi
    done
    if [ -z "$where_col" ]; then
        # 评审第 13 条：识别不到应用名列时直接跳过。旧版 WHERE true LIMIT 10 全表
        # 兜底会把其他应用的元数据打进 stdout——cron 下日志默认 0644 全局可读，
        # 属不必要的跨应用信息外泄面；本上下文只是辅助观测，跳过不影响 heal 判定。
        info "app 表未识别到应用名列（候选 app_name/name/appname 均不存在），跳过该上下文回读（不做全表兜底：避免把其他应用元数据写进日志；不影响两表 heal 判定）"
        return 0
    fi
    where="${where_col}='${APP}'"
    cols="$(pick_columns "$have" id "$where_col" app_name name appname install_volume_id volume_id manual_install is_docker is_systemd_uint source_id)"
    if ! rb_psql appcenter "SELECT ${cols} FROM app WHERE ${where} LIMIT 10"; then
        err "appcenter.app 回读失败，stderr 完整错误链："
        printf '%s\n' "$RB_ERR" >&2
        return 3
    fi
    if [ -z "$RB_OUT" ]; then
        printf '(0 行——应用行不存在，Rainbow 可能未安装)\n'
    else
        printf '列: %s\n' "$cols"
        printf '%s\n' "$RB_OUT"
    fi
    return 0
}

readback_all() {
    local label="$1"
    info "回读两表现状（${label}）："
    local rc=0
    select_table appcenter app_service \
        "service_name='${SVC}'" \
        "库一 appcenter.app_service（源头表）" || rc=$?
    select_table trim_sac entry \
        "app_name='${APP}' AND service_name='${SVC}'" \
        "库二 trim_sac.entry（网关注册视图）" || rc=$?
    select_app_context || rc=$?
    return "$rc"
}

# ---------- 幂等 UPDATE（文档已验证 SQL，逐字对齐，仅空字段才补写） ----------
SQL_UPD_APPCENTER="UPDATE app_service SET gateway_socket='${SOCK}', gateway_prefix='${PREFIX}', updated_at=now() WHERE service_name='${SVC}' AND coalesce(gateway_socket,'')='';"
SQL_UPD_TRIMSAC="UPDATE entry SET gateway_socket='${SOCK}', gateway_prefix='${PREFIX}', updated_at=now() WHERE app_name='${APP}' AND service_name='${SVC}' AND coalesce(gateway_socket,'')='';"

# 解析 psql -Atc 对 UPDATE 的输出「UPDATE <n>」→ 影响行数（trim 首尾空白）。
# 评审第 3 条：解析不到 command tag 时【不再 fatal】——输出 '?' 降级为观测值，
# 成败判定权收归其后的权威 re-SELECT（期望值计数）。'?' 只影响 exit 0/10 的
# 子码选择与日志观测，不影响「是否达成」的结论。
parse_affected() {
    local s="$1"
    # trim 首尾空白（制表符/空格/回车）
    while [ -n "$s" ]; do
        case "$s" in
            [[:space:]]*) s="${s#?}" ;;
            *) break ;;
        esac
    done
    while [ -n "$s" ]; do
        case "$s" in
            *[[:space:]]) s="${s%?}" ;;
            *) break ;;
        esac
    done
    case "$s" in
        'UPDATE '*) printf '%s' "${s#UPDATE }" ;;
        *)           printf '%s' "?" ;;
    esac
}

# 结论判定查询：期望值精确命中的行数（socket 与 prefix 都等于期望值）
SQL_EXPECT_SVC="SELECT count(*) FROM app_service WHERE service_name='${SVC}' AND gateway_socket='${SOCK}' AND gateway_prefix='${PREFIX}';"
SQL_EXPECT_SAC="SELECT count(*) FROM entry WHERE app_name='${APP}' AND service_name='${SVC}' AND gateway_socket='${SOCK}' AND gateway_prefix='${PREFIX}';"
# 行存在性查询（区分「行不存在」与「行存在但值不符」）
SQL_EXIST_SVC="SELECT count(*) FROM app_service WHERE service_name='${SVC}';"
SQL_EXIST_SAC="SELECT count(*) FROM entry WHERE app_name='${APP}' AND service_name='${SVC}';"

# 回读单值（count 类查询）；通道失败即 fatal（结论判定依赖它）
read_count() {
    local db="$1" sql="$2" step="$3"
    rb_psql "$db" "$sql" || fail_channel "$step"
    case "$RB_OUT" in
        ''|*[!0-9]*)
            err "回读结果非数字（${step}）：[${RB_OUT}]，无法判定"
            print_redline
            exit 3
            ;;
    esac
    printf '%s' "$RB_OUT"
}

# ---------- 结尾固定提示：生效时延 + 运维红线 ----------
print_next_steps() {
    cat <<EOF

=========== 生效时延与后续动作（固定提示，脚本绝不自动执行任何重启动作） ===========
1) DB 直改【不会】触发即时注册：网关进程 trim_http_cgi 持内存路由表，只有
   sacentry 周期任务或进程重启才刷新。fnOS 的 sacentry 周期约每 30 分钟读
   trim_sac.entry 重建上游路由（本机锚点约 HH:00:58 / HH:01:05）。
   → 请等待下一个周期（≤30 分钟）后再复测网关入口；可在 NAS 上
     sudo zgrep -h 'upstream register' /var/log/syslog*
     观察是否出现 app=${APP} 的注册行（zgrep 兼容轮转压缩档；注意日志为
     带空格的 upstream register）。
2) 复测顺序建议：先 LAN 直连 fnOS 网关入口（绕开 Cloudflare）验证前缀
   ${PREFIX}/ 不再返回 404 9B，再走公网入口复测。
   完整序列与「补写后仍 404」排查树见 docs/FNOS-GATEWAY-HEAL.md。
3) ⚠️ 运维红线：如需即时生效，理论上须重启网关进程 trim_http_cgi——该动作
   【有风险】：曾导致全站 Cloudflare 隧道断开（530 断联，恢复需用户物理
   介入）。本脚本绝不自动执行，任何 agent/自动化同样禁止执行；确有需要时
   必须由人工评估并确认。
==================================================================================
EOF
}

# ---------- 主流程 ----------
main() {
    info "模式：$([ "$MODE" = "dry" ] && echo 'dry-run（只读回读，不做任何写入）' || echo 'heal（幂等补写 + 回读确认）')"
    info "目标：${APP}（service=${SVC}）"
    info "期望写入：gateway_socket=${SOCK}  gateway_prefix=${PREFIX}"

    preflight

    if [ "$MODE" = "dry" ]; then
        # dry-run：只 SELECT。回读失败（rc=3）说明通道/DB 异常，同样非零退出。
        if ! readback_all 'dry-run'; then
            err "dry-run 回读未全部成功，详见上方 stderr"
            print_redline
            exit 3
        fi
        info "dry-run 完成：未做任何写入。确认现状后去掉 --dry-run 执行补写。"
        print_next_steps
        exit 0
    fi

    # ---- heal：先前置回读（留取证基线） ----
    readback_all '补写前基线' || err "补写前回读部分失败（继续执行 UPDATE，以 UPDATE 结果与事后回读为准）"

    # ---- 幂等 UPDATE：affected rows 降级为观测值（'?' = command tag 未解析到，
    #      只告警不终止；成败判定权在其后的权威 re-SELECT） ----
    info "执行库一 appcenter.app_service 幂等 UPDATE ..."
    if ! rb_psql appcenter "$SQL_UPD_APPCENTER"; then
        fail_channel 'UPDATE appcenter.app_service'
    fi
    local aff_svc
    aff_svc="$(parse_affected "$RB_OUT")"
    if [ "$aff_svc" = "?" ]; then
        warn "appcenter UPDATE 输出未解析到 command tag（原始输出：[${RB_OUT}]）——降级为观测值，以 re-SELECT 回读为权威判定；请留存该原始输出供排查（psql 形态变化嫌疑）"
    fi
    info "appcenter.app_service affected rows = ${aff_svc}（观测值）"

    info "执行库二 trim_sac.entry 幂等 UPDATE ..."
    if ! rb_psql trim_sac "$SQL_UPD_TRIMSAC"; then
        fail_channel 'UPDATE trim_sac.entry'
    fi
    local aff_sac
    aff_sac="$(parse_affected "$RB_OUT")"
    if [ "$aff_sac" = "?" ]; then
        warn "trim_sac UPDATE 输出未解析到 command tag（原始输出：[${RB_OUT}]）——降级为观测值，以 re-SELECT 回读为权威判定；请留存该原始输出供排查（psql 形态变化嫌疑）"
    fi
    info "trim_sac.entry affected rows = ${aff_sac}（观测值）"

    # ---- 立即 re-SELECT 回读确认落库（期望值精确命中计数；权威判定） ----
    local n_svc n_svc_row n_sac n_sac_row
    n_svc="$(read_count appcenter "$SQL_EXPECT_SVC" '回读 app_service 期望值计数')"
    n_sac="$(read_count trim_sac "$SQL_EXPECT_SAC" '回读 entry 期望值计数')"
    n_svc_row="$(read_count appcenter "$SQL_EXIST_SVC" '回读 app_service 行存在性')"
    n_sac_row="$(read_count trim_sac "$SQL_EXIST_SAC" '回读 entry 行存在性')"
    info "落库确认：app_service 期望值命中 ${n_svc} 行（行存在 ${n_svc_row}）；entry 期望值命中 ${n_sac} 行（行存在 ${n_sac_row}）"

    info "补写后两表现状（回读全文）："
    if ! readback_all '补写后确认'; then
        err "补写后回读部分失败（不影响上方已完成的落库计数判定）"
    fi

    # ---- 结论判定（唯一权威 = re-SELECT 期望值计数；aff_* 仅决定成功子码） ----
    if [ "$n_svc" -ge 1 ] && [ "$n_sac" -ge 1 ]; then
        # 评审第 10 条：拆成功子码——0=已是正确状态（无写入），10=本次发生写入。
        # '?'（command tag 未解析）按「可能发生写入」保守归入 10，宁可多报写事件。
        if [ "$aff_svc" = "0" ] && [ "$aff_sac" = "0" ]; then
            info "结论：两表已是正确状态（gateway_socket/gateway_prefix 均为期望值，本次 UPDATE 0 行属幂等 no-op，未做任何改动）。"
            print_next_steps
            exit 0
        fi
        info "结论：本次补写成功（appcenter=${aff_svc} 行，trim_sac=${aff_sac} 行，观测值），re-SELECT 回读确认已落库。"
        print_next_steps
        exit 10
    fi

    # 未达「双表期望值命中」→ 按行存在性互斥分支给排查线索（评审第 16 条：
    # 旧版两个 if 不互斥，会同时打印互相矛盾的成因）后非零退出
    err "结论：补写未完全达成（app_service 命中 ${n_svc}/${n_svc_row} 行，entry 命中 ${n_sac}/${n_sac_row} 行）。可能原因："
    if [ "$n_svc_row" = "0" ] || [ "$n_sac_row" = "0" ]; then
        err "  - 目标行不存在（行键未命中）：entry key 形态错配或应用未安装/刚被卸载（排查树分支⑤）；安装刚结束时 fnOS 可能尚未写入 app_service 行（时序缺口），稍后重跑即可"
    elif [ "$n_svc" = "0" ] || [ "$n_sac" = "0" ]; then
        err "  - 行存在但值非期望：字段并非「空」而是「非期望值」（部分补写/旧值残留/fnOS 写入了不同值），幂等 WHERE 刻意不覆盖——请人工核对上方回读全文"
        err "  - 或 entry 行刚被 trim_sac 周期同步从空的 app_service 回写覆盖（排查树分支③：先确认 app_service 已补上，再等下一周期或重跑本脚本）"
    fi
    err "  - 详细排查树见 docs/FNOS-GATEWAY-HEAL.md「补写后仍 404 / 未达成」分支"
    print_redline
    exit 2
}

main
