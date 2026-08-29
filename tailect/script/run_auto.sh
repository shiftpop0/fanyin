#!/usr/bin/env bash
# ===================================================================
# run_auto.sh — GPU 自动检测与智能配置部署脚本
# 支持本地直接运行 (--direct) 和 Docker 部署两种模式
# ===================================================================
#
# 用法:
#   bash script/run_auto.sh                          # 交互式选择 GPU
#   bash script/run_auto.sh --gpus 0,2,3             # 指定 GPU
#   bash script/run_auto.sh --gpus 0 --direct        # 本地直接运行
#   bash script/run_auto.sh --gpus 0 --dry-run       # 仅检测预览
#
# 参数:
#   --gpus <列表>        GPU ID 列表，逗号分隔（默认交互式）
#   --direct             本地直接运行（conda），否则 Docker
#   --with-diarization   启用说话人区分功能（默认关闭）
#   --with-vllm          启用 vLLM 后端（默认关闭，用 Transformer）
#   --dry-run            仅检测打印，不启动
#   --port <端口>        服务端口（默认 6006）
#   --help               显示帮助
# ===================================================================

set -euo pipefail

# ===================================================================
# 常量与路径
# ===================================================================
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
cd "$PROJECT_ROOT"

# 默认值
DEFAULT_PORT=6006
NGINX_PORT=6006

# Docker 镜像
IMAGE="${IMAGE:-tailect-asr-qwen3-asr:offline-salvaged-20260506}"

# ===================================================================
# 颜色输出
# ===================================================================
if [[ -t 1 ]]; then
    RED='\033[0;31m'
    GREEN='\033[0;32m'
    YELLOW='\033[1;33m'
    CYAN='\033[0;36m'
    NC='\033[0m'
fi

info()   { echo -e "${CYAN}[INFO]${NC}   $*"; }
ok()     { echo -e "${GREEN}[OK]${NC}     $*"; }
warn()   { echo -e "${YELLOW}[WARN]${NC}  $*"; }
error()  { echo -e "${RED}[ERROR]${NC} $*" >&2; }
header() { echo ""; echo "=============================================="; echo "  $*"; echo "=============================================="; }

# ===================================================================
# 参数解析
# ===================================================================
PARAM_GPUS=""
PARAM_DIRECT=false
PARAM_DIARIZATION=false
PARAM_VLLM=false
PARAM_DRY_RUN=false
PARAM_PORT=$DEFAULT_PORT

usage() {
    sed -n 's/^# //p; s/^#$//p' "$0" | sed '1,2d'
    exit 0
}

while [[ $# -gt 0 ]]; do
    case "$1" in
        --gpus)    PARAM_GPUS="$2"; shift 2 ;;
        --direct)  PARAM_DIRECT=true; shift ;;
        --with-diarization) PARAM_DIARIZATION=true; shift ;;
        --with-vllm) PARAM_VLLM=true; shift ;;
        --dry-run) PARAM_DRY_RUN=true; shift ;;
        --port)    PARAM_PORT="$2"; shift 2 ;;
        --help)    usage ;;
        *)         error "未知参数: $1"; usage ;;
    esac
done

# ===================================================================
# 1. 检测 GPU 硬件信息
# ===================================================================
header "GPU 硬件检测"

# shellcheck source=script/gpu_detect.sh
source "${SCRIPT_DIR}/gpu_detect.sh"

if ! _nvidia_smi_available; then
    _gpu_warn "nvidia-smi 不可用，将使用降级配置（单卡、8GB、CC 7.0）"
fi

export_gpu_env
echo "  GPU 数量: ${GPU_COUNT}"
for ((i = 0; i < GPU_COUNT; i++)); do
    printf "  GPU %d: %s | %d MiB | CC %s\n" \
        "$i" "${GPU_NAMES[$i]}" "${GPU_MEM_MIBS[$i]}" "${GPU_COMPUTE_CAPS[$i]}"
done
echo ""

# ===================================================================
# 2. 选择 GPU — 交互式兜底
# ===================================================================
if [[ -z "$PARAM_GPUS" ]]; then
    header "GPU 选择"
    echo "  可用 GPU:"
    for ((i = 0; i < GPU_COUNT; i++)); do
        printf "  [%d] %s | %d MiB | CC %s\n" \
            "$i" "${GPU_NAMES[$i]}" "${GPU_MEM_MIBS[$i]}" "${GPU_COMPUTE_CAPS[$i]}"
    done
    echo ""
    echo -n "  请输入要使用的 GPU ID（逗号分隔，直接回车使用全部）: "
    read -r user_input
    if [[ -n "$user_input" ]]; then
        PARAM_GPUS="$user_input"
    fi
    echo ""
fi

# ===================================================================
# 3. 自动配置决策 + 生成 config_auto.py
# ===================================================================
header "自动配置决策"

# shellcheck source=script/auto_config.sh
source "${SCRIPT_DIR}/auto_config.sh"

if ! auto_configure_all "$PROJECT_ROOT" "$PARAM_GPUS"; then
    error "自动配置失败"
    exit 1
fi

# 应用用户覆盖参数
if $PARAM_VLLM; then
    AUTO_VLLM_ENABLED=true
    _auto_info "用户指定: --with-vllm → vllm_enabled=true"
fi
if ! $PARAM_DIARIZATION; then
    _auto_info "用户指定: 不启用 diarization"
fi

# ===================================================================
# 4. 打印最终检测报告
# ===================================================================
header "GPU 检测与配置报告"
echo "  ┌────────────────────────────────────────────────┐"
echo "  │ GPU 信息                                       │"
echo "  │ ────────────────────────────────────────────── │"
for ((i = 0; i < GPU_COUNT; i++)); do
    printf "  │   GPU %d: %s\n" "$i" "${GPU_NAMES[$i]}"
    printf "  │           %d MiB | CC %s\n" "${GPU_MEM_MIBS[$i]}" "${GPU_COMPUTE_CAPS[$i]}"
done
echo "  │                                                │"
echo "  │ 选定 GPU: ${SELECTED_GPU_LIST}                                   │"
echo "  │                                                │"
echo "  │ 自动优化参数                                   │"
echo "  │ ────────────────────────────────────────────── │"
printf "  │   asr_batch_size              = %s\n" "$AUTO_BATCH_SIZE"
printf "  │   asr_dtype                    = %s\n" "$AUTO_DTYPE"
printf "  │   asr_attn_implementation     = %s\n" "$AUTO_ATTN_IMPL"
printf "  │   vllm_gpu_memory_utilization = %s\n" "$AUTO_VLLM_GMU"
printf "  │   vllm_enabled                = %s\n" "$AUTO_VLLM_ENABLED"
if $PARAM_DIRECT; then
    echo "  │                                                │"
    echo "  │ 运行模式: 本地直接运行 (--direct)              │"
    echo "  │ 端口: ${PARAM_PORT}                                     │"
fi
echo "  └────────────────────────────────────────────────┘"
echo ""

# --dry-run 在此退出
if $PARAM_DRY_RUN; then
    ok "Dry-run 模式，未启动任何服务。"
    exit 0
fi

# ===================================================================
# 5. 提取通用配置变量（两种模式共用）
# ===================================================================
VLLM_ENABLED_PY=$($PARAM_VLLM && echo "True" || echo "${AUTO_VLLM_ENABLED}" | sed 's/true/True/;s/false/False/')
DIAR_PATH_PY=$($PARAM_DIARIZATION && echo "'TargetDiarization-main'" || echo "''")

# ===================================================================
# 6. Direct 模式 — 本地直接运行
# ===================================================================
if $PARAM_DIRECT; then
    header "Direct 模式 — 本地直接运行"

    # 检查主脚本
    if [[ ! -f "unified_asr_diarization_transformer_offline.py" ]]; then
        error "脚本不存在: $(pwd)/unified_asr_diarization_transformer_offline.py"
        exit 1
    fi

    # ---------- 配置注入：临时替换 config.py ----------
    CONFIG_BAK="core/config.py.bak.auto"
    if [[ -f "core/config_auto.py" ]]; then
        info "注入自动配置 → core/config.py"
        cp "core/config.py" "$CONFIG_BAK"

        python3 -c "
import sys, importlib.util

# 加载原 config
spec = importlib.util.spec_from_file_location('orig_config', 'core/config.py')
orig = importlib.util.module_from_spec(spec)
spec.loader.exec_module(orig)

# 加载 config_auto
spec2 = importlib.util.spec_from_file_location('auto_config', 'core/config_auto.py')
cfg_auto = importlib.util.module_from_spec(spec2)
spec2.loader.exec_module(cfg_auto)

# 合并：auto 覆盖 orig
merged = dict(orig.CONFIG)
merged.update(cfg_auto.CONFIG)

# 用户参数覆盖
merged['vllm_enabled'] = ${VLLM_ENABLED_PY}
merged['diarization_project_path'] = ${DIAR_PATH_PY}

# 写出合并后的 config.py
with open('core/config.py', 'w') as f:
    f.write('# auto-generated by run_auto.sh (merged) — DO NOT EDIT\n')
    f.write('from typing import Any, Dict\n')
    f.write('CONFIG: Dict[str, Any] = {\n')
    for k, v in merged.items():
        if isinstance(v, str):
            f.write(f'    \"{k}\": \"{v}\",\n')
        elif isinstance(v, bool):
            f.write(f'    \"{k}\": {v},\n')
        elif isinstance(v, int):
            f.write(f'    \"{k}\": {v},\n')
        elif isinstance(v, float):
            f.write(f'    \"{k}\": {v},\n')
    f.write('}\n\n\n')
    f.write('def get_config() -> Dict[str, Any]:\n')
    f.write('    return dict(CONFIG)\n')
print('合并配置写入成功')
" || {
            error "配置合并失败，正在恢复..."
            mv "$CONFIG_BAK" "core/config.py"
            exit 1
        }

        # 注册退出时的恢复钩子
        trap 'ok "恢复原始 config.py"; mv "$CONFIG_BAK" "core/config.py"' EXIT INT TERM
    fi

    # ---------- 设置环境变量 ----------
    FIRST_GPU="${SELECTED_GPU_IDS[0]}"
    export CUDA_VISIBLE_DEVICES="$FIRST_GPU"
    export PYTHONPATH="${PYTHONPATH:-}:${PROJECT_ROOT}"
    info "CUDA_VISIBLE_DEVICES=${CUDA_VISIBLE_DEVICES}"
    info "PYTHONPATH=${PYTHONPATH}"
    echo ""

    info "启动服务 (port=${PARAM_PORT})..."
    echo ""

    # 使用 exec 直接替换当前进程
    exec python3 unified_asr_diarization_transformer_offline.py --port "${PARAM_PORT}"
    # exec 后不会执行到这里
fi

# ===================================================================
# 7. Docker 模式 — 容器部署
# ===================================================================
header "Docker 模式 — 容器部署"

CONTAINER_WORKDIR="/workspace"
LOG_DIR="${PROJECT_ROOT}/log"
mkdir -p "$LOG_DIR"

# ---------- 生成完整合并配置 ----------
# Docker 模式用文件级挂载覆盖容器内 config.py，需要包含所有配置键
if [[ -f "${PROJECT_ROOT}/core/config_auto.py" ]]; then
    MERGED_CONFIG="${PROJECT_ROOT}/core/config_auto.full.py"
    info "生成完整合并配置: ${MERGED_CONFIG}"
    python3 -c "
import importlib.util

# 加载原 config
spec = importlib.util.spec_from_file_location('orig_config', 'core/config.py')
orig = importlib.util.module_from_spec(spec)
spec.loader.exec_module(orig)

# 加载 config_auto
spec2 = importlib.util.spec_from_file_location('auto_config', 'core/config_auto.py')
cfg_auto = importlib.util.module_from_spec(spec2)
spec2.loader.exec_module(cfg_auto)

# 合并：auto 覆盖 orig
merged = dict(orig.CONFIG)
merged.update(cfg_auto.CONFIG)

# 用户参数覆盖
merged['vllm_enabled'] = ${VLLM_ENABLED_PY}
merged['diarization_project_path'] = ${DIAR_PATH_PY}

# 写出完整合并后的配置
with open('core/config_auto.full.py', 'w') as f:
    f.write('# auto-generated by run_auto.sh (merged) — DO NOT EDIT\n')
    f.write('from typing import Any, Dict\n')
    f.write('CONFIG: Dict[str, Any] = {\n')
    for k, v in merged.items():
        if isinstance(v, str):
            f.write(f'    \"{k}\": \"{v}\",\n')
        elif isinstance(v, bool):
            f.write(f'    \"{k}\": {v},\n')
        elif isinstance(v, int):
            f.write(f'    \"{k}\": {v},\n')
        elif isinstance(v, float):
            f.write(f'    \"{k}\": {v},\n')
    f.write('}\n\n\n')
    f.write('def get_config() -> Dict[str, Any]:\n')
    f.write('    return dict(CONFIG)\n')
print('完整合并配置写入成功')
" || {
        error "Docker 配置生成失败"
        exit 1
    }
else
    MERGED_CONFIG=""
fi

# ---------- 前置检查 ----------
preflight_checks() {
    info "===== 前置环境检查 ====="

    if ! command -v docker &>/dev/null; then
        error "Docker 未安装或不在 PATH 中"
        exit 1
    fi
    ok "Docker 命令可用"

    if ! docker info &>/dev/null; then
        error "Docker 守护进程未运行"
        exit 1
    fi
    ok "Docker 守护进程运行中"

    if ! docker image inspect "$IMAGE" &>/dev/null; then
        error "Docker 镜像不存在: $IMAGE"
        exit 1
    fi
    ok "Docker 镜像存在: $IMAGE"

    if [[ ! -d "$PROJECT_ROOT" ]]; then
        error "项目目录不存在: ${PROJECT_ROOT}"
        exit 1
    fi
    ok "项目目录存在: ${PROJECT_ROOT}"

    if [[ ! -d "${PROJECT_ROOT}/model" ]]; then
        warn "模型目录不存在: ${PROJECT_ROOT}/model"
    else
        ok "模型目录存在: ${PROJECT_ROOT}/model"
    fi

    # 多 GPU 时需要 Nginx
    if [[ ${#SELECTED_GPU_IDS[@]} -gt 1 ]]; then
        if ! docker image inspect nginx &>/dev/null 2>&1; then
            error "Docker nginx 镜像不存在"
            error "请先导入: docker load < nginx.tar.gz"
            exit 1
        fi
        ok "nginx 镜像存在"
    fi

    echo ""
}

# ---------- 端口清理 ----------
kill_process_on_port() {
    local port=$1
    local pids
    pids=$(lsof -t -i ":$port" 2>/dev/null || true)
    if [[ -n "$pids" ]]; then
        warn "端口 $port 被占用，正在清理进程: $pids"
        for pid in $pids; do
            kill -9 "$pid" 2>/dev/null || true
        done
        sleep 1
    fi
}

cleanup_ports() {
    info "===== 检查并清理端口 ====="
    local all_ports=("${BACKEND_PORTS[@]}")
    if [[ ${#SELECTED_GPU_IDS[@]} -gt 1 ]]; then
        all_ports+=("$NGINX_PORT")
    fi
    for port in "${all_ports[@]}"; do
        kill_process_on_port "$port"
    done
    echo ""
}

# ---------- 清理旧容器 ----------
cleanup_containers() {
    info "===== 清理旧容器 ====="
    for port in "${BACKEND_PORTS[@]}"; do
        docker rm -f "asr_instance_${port}" 2>/dev/null || true
    done
    if [[ ${#SELECTED_GPU_IDS[@]} -gt 1 ]]; then
        docker rm -f asr_nginx 2>/dev/null || true
    fi
    ok "旧容器已清理"
    echo ""
}

# ---------- 启动单个实例 ----------
start_instance() {
    local gpu_id=$1
    local port=$2
    local log_file="${LOG_DIR}/asr_instance_${port}.log"

    info "启动实例 — GPU ${gpu_id}, 端口 ${port}..."

    # 构建 docker run 命令
    local docker_cmd=(
        docker run -d
        --name "asr_instance_${port}"
        --gpus "device=${gpu_id}"
        --restart unless-stopped
        -p "${port}:6006"
        -v "${PROJECT_ROOT}:${CONTAINER_WORKDIR}"
        -v "${PROJECT_ROOT}/model:${CONTAINER_WORKDIR}/model"
        -w "${CONTAINER_WORKDIR}"
        -e "PYTHONPATH=${CONTAINER_WORKDIR}"
        -e "CUDA_VISIBLE_DEVICES=${gpu_id}"
        -e "HF_HUB_OFFLINE=1"
        -e "TRANSFORMERS_OFFLINE=1"
        -e "TQDM_DISABLE=1"
        -e "TZ=Asia/Shanghai"
    )

    # 如果完整的合并配置存在，文件级挂载覆盖容器内 config.py
    if [[ -n "${MERGED_CONFIG:-}" && -f "$MERGED_CONFIG" ]]; then
        docker_cmd+=(
            -v "${MERGED_CONFIG}:${CONTAINER_WORKDIR}/core/config.py"
        )
        info "  → 注入完整合并配置覆盖容器内 config.py"
    elif [[ -f "${PROJECT_ROOT}/core/config_auto.py" ]]; then
        docker_cmd+=(
            -v "${PROJECT_ROOT}/core/config_auto.py:${CONTAINER_WORKDIR}/core/config.py"
        )
        info "  → 注入 config_auto.py 覆盖容器内 config.py"
    fi

    # 容器 Entrypoint 为 /bin/bash -lc，直接覆写 CMD 会嵌套
    # 用 --entrypoint bash + -c 避免嵌套引用问题
    local log_cmd="python ${CONTAINER_WORKDIR}/unified_asr_diarization_transformer_offline.py --port 6006 >> ${CONTAINER_WORKDIR}/log/asr_instance_${port}.log 2>&1"
    docker_cmd+=(
        --entrypoint bash
        "${IMAGE}"
        "-c" "${log_cmd}"
    )

    "${docker_cmd[@]}"

    if [[ $? -eq 0 ]]; then
        ok "实例 ${port} 启动成功 (日志: ${log_file})"
        return 0
    else
        error "实例 ${port} 启动失败"
        return 1
    fi
}

# ---------- 启动后端实例 ----------
start_backend_instances() {
    info "===== 启动后端服务容器 ====="
    for i in "${!SELECTED_GPU_IDS[@]}"; do
        start_instance "${SELECTED_GPU_IDS[$i]}" "${BACKEND_PORTS[$i]}"
    done
    echo ""
}

# ---------- 等待服务就绪 ----------
wait_for_services() {
    info "===== 等待服务就绪 ====="
    local max_wait=300
    local interval=2

    for port in "${BACKEND_PORTS[@]}"; do
        local service_name="asr_instance_${port}"
        local wait_start
        wait_start=$(date +%s)

        info "等待 ${service_name} 就绪..."
        while true; do
            if curl -sf "http://127.0.0.1:${port}/health" > /dev/null 2>&1; then
                ok "${service_name} 健康检查通过"
                break
            fi
            local now elapsed
            now=$(date +%s)
            elapsed=$((now - wait_start))
            if [[ $elapsed -ge $max_wait ]]; then
                warn "${service_name} 超时未就绪 (${max_wait}s)"
                warn "请检查日志: tail -50 ${LOG_DIR}/asr_instance_${port}.log"
                break
            fi
            sleep $interval
        done
    done
    echo ""
}

# ---------- 启动 Nginx ----------
start_nginx() {
    info "===== 启动 Nginx 负载均衡 ====="

    local upstream_servers=""
    for port in "${BACKEND_PORTS[@]}"; do
        upstream_servers+="    server 127.0.0.1:${port};\n"
    done

    local nginx_template
    nginx_template=$(cat <<NGINX_EOF
upstream asr_backend {
    least_conn;
${upstream_servers}}
server {
    listen ${NGINX_PORT};
    client_max_body_size 200M;
    location / {
        proxy_pass http://asr_backend;
        proxy_set_header Host \$host;
        proxy_set_header X-Real-IP \$remote_addr;
        proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto \$scheme;
        proxy_read_timeout 300s;
        proxy_connect_timeout 75s;
        proxy_send_timeout 300s;
        proxy_buffering off;
    }
}
NGINX_EOF
)

    local nginx_conf="/tmp/nginx_auto_${NGINX_PORT}.conf"
    echo -e "$nginx_template" > "$nginx_conf"
    ok "Nginx 配置已生成: ${nginx_conf}"

    docker run -d \
        --name asr_nginx \
        --restart unless-stopped \
        --network host \
        -v "${nginx_conf}:/etc/nginx/conf.d/default.conf:ro" \
        nginx

    sleep 2

    if docker ps --format "{{.Names}}" | grep -q "^asr_nginx$"; then
        ok "Nginx 容器运行中"
        if curl -sf "http://127.0.0.1:${NGINX_PORT}/health" > /dev/null 2>&1; then
            ok "Nginx 代理健康检查通过 (端口 ${NGINX_PORT})"
        else
            warn "Nginx 代理健康检查失败，请检查日志: docker logs asr_nginx"
        fi
    else
        error "Nginx 容器启动失败"
        exit 1
    fi
    echo ""
}

# ---------- 打印部署信息 ----------
print_deployment_info() {
    local gpu_ports=""
    for i in "${!SELECTED_GPU_IDS[@]}"; do
        gpu_ports+="  │  GPU ${SELECTED_GPU_IDS[$i]} → :${BACKEND_PORTS[$i]} (容器: asr_instance_${BACKEND_PORTS[$i]})│\n"
    done

    echo ""
    echo "=============================================="
    echo "  ✅ 部署完成"
    echo "=============================================="
    echo "  ┌─────────────────────────────────────────┐"
    if [[ ${#SELECTED_GPU_IDS[@]} -gt 1 ]]; then
        echo "  │  对外接口: http://localhost:${NGINX_PORT}        │"
    else
        echo "  │  对外接口: http://localhost:${BACKEND_PORTS[0]}        │"
    fi
    echo "  │                                         │"
    echo -e "${gpu_ports}"
    echo "  │                                         │"
    echo "  │  日志目录: ${LOG_DIR}/      │"
    echo "  └─────────────────────────────────────────┘"
    echo "=============================================="
}

# ---------- 准备端口 ----------
BACKEND_PORTS=()
for i in "${!SELECTED_GPU_IDS[@]}"; do
    if [[ ${#SELECTED_GPU_IDS[@]} -eq 1 ]]; then
        # 单 GPU 直接用用户指定端口
        BACKEND_PORTS+=("$PARAM_PORT")
    else
        # 多 GPU 从 8001 开始
        BACKEND_PORTS+=("$((8001 + i))")
    fi
done

# ---------- 执行部署 ----------
preflight_checks
cleanup_ports
cleanup_containers
start_backend_instances
wait_for_services

# 多 GPU 启动 Nginx
if [[ ${#SELECTED_GPU_IDS[@]} -gt 1 ]]; then
    start_nginx
fi

print_deployment_info
