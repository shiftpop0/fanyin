#!/usr/bin/env bash
# ===================================================================
# run_offline.sh — 离线机 2 卡生产启动脚本（Docker 容器版）
# 运行环境：离线机（无网络，已有 nginx Docker 镜像）
# GPU：cuda:0,1 各一个容器实例
# 端口：8001/8002（后端），6006（Nginx 负载均衡对外）
# 用法: ./run_offline.sh
#       可通过环境变量覆盖: HOST_PROJECT_DIR=... HOST_MODEL_DIR=... IMAGE=...
# ===================================================================

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
cd "$SCRIPT_DIR"

# 创建日志目录（统一放在项目根目录的 log/ 下）
LOG_DIR="${LOG_DIR:-${PROJECT_ROOT}/log}"
mkdir -p "${LOG_DIR}"

# 宿主机路径（可通过环境变量覆盖，默认指向项目根目录）
HOST_PROJECT_DIR="${HOST_PROJECT_DIR:-${PROJECT_ROOT}}"
HOST_MODEL_DIR="${HOST_MODEL_DIR:-${PROJECT_ROOT}/model}"

# NVIDIA 驱动库路径（宿主机）
NVIDIA_ML_LIB="${NVIDIA_ML_LIB:-/usr/lib/x86_64-linux-gnu/libnvidia-ml.so.1}"
NVIDIA_CUDA_LIB="${NVIDIA_CUDA_LIB:-/usr/lib/x86_64-linux-gnu/libcuda.so.1}"

# 镜像名
IMAGE="${IMAGE:-tailect-asr-qwen3-asr:offline-salvaged-20260506}"


# 容器内路径
CONTAINER_WORKDIR="/workspace"

# ASR 脚本在项目根目录（asr_offline/ 是老名称，文件已移至根目录）
CONTAINER_ASR_DIR="${CONTAINER_WORKDIR}"
CONTAINER_MODEL_DIR="${CONTAINER_WORKDIR}/model"

NGINX_PORT=6006

# ---------- 从 config.py 读取 GPU 部署列表 ----------
parse_gpu_config() {
    local config_file="${HOST_PROJECT_DIR}/core/config.py"
    if [ -f "$config_file" ]; then
        # 提取 asr_available_gpus 的值（如 "0,1,2"）
        local gpu_raw
        gpu_raw=$(grep -E 'asr_available_gpus' "$config_file" 2>/dev/null \
                  | grep -oE '"[0-9,]+"' | head -1 | tr -d '"')
        echo "${gpu_raw:-0,1}"
    else
        echo "0,1"
    fi
}

# 将 GPU 列表字符串拆为数组，生成对应的后端端口列表
# 例如 "0,1,2" → GPU_IDS=(0 1 2)  BACKEND_PORTS=(8001 8002 8003)
setup_deploy_arrays() {
    local gpu_list="$1"
    IFS=',' read -ra GPU_IDS <<< "$gpu_list"
    BACKEND_PORTS=()
    ALL_PORTS=()
    for i in "${!GPU_IDS[@]}"; do
        local port=$((8001 + i))
        BACKEND_PORTS+=("$port")
        ALL_PORTS+=("$port")
    done
    ALL_PORTS+=("${NGINX_PORT}")
}

GPU_LIST=$(parse_gpu_config)
setup_deploy_arrays "$GPU_LIST"

# ---------- 颜色输出 ----------
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
CYAN='\033[0;36m'
NC='\033[0m'

info()  { echo -e "${CYAN}[INFO]${NC}  $*"; }
ok()    { echo -e "${GREEN}[OK]${NC}    $*"; }
warn()  { echo -e "${YELLOW}[WARN]${NC}  $*"; }
error() { echo -e "${RED}[ERROR]${NC} $*" >&2; }

# ---------- 端口清理函数 ----------
kill_process_on_port() {
    local port=$1
    local pids=$(lsof -t -i ":$port" 2>/dev/null || true)
    
    if [ -n "$pids" ]; then
        warn "端口 $port 被占用，正在清理进程: $pids"
        for pid in $pids; do
            kill -9 "$pid" 2>/dev/null || true
        done
        sleep 1
        ok "端口 $port 已释放"
    else
        ok "端口 $port 未被占用"
    fi
}

cleanup_ports() {
    echo ""
    info "===== 检查并清理端口占用 ====="
    
    for port in "${ALL_PORTS[@]}"; do
        kill_process_on_port "$port"
    done
    
    echo ""
}

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

    if ! docker image inspect nginx:alpine &>/dev/null 2>&1; then
        error "Docker nginx:alpine 镜像不存在"
        error "请先导入: docker load < nginx.tar.gz"
        exit 1
    fi
    ok "nginx:alpine 镜像存在"

    # 检查 NVIDIA 驱动库
    if [[ ! -f "${NVIDIA_ML_LIB}" ]]; then
        warn "NVIDIA driver library not found: ${NVIDIA_ML_LIB}"
        warn "GPU may not work in container"
    else
        ok "NVIDIA driver library 存在"
    fi

    if [[ ! -f "${NVIDIA_CUDA_LIB}" ]]; then
        warn "NVIDIA CUDA library not found: ${NVIDIA_CUDA_LIB}"
        warn "GPU may not work in container"
    else
        ok "NVIDIA CUDA library 存在"
    fi

    # 检查宿主机目录
    if [[ ! -d "${HOST_PROJECT_DIR}" ]]; then
        error "宿主机项目目录不存在: ${HOST_PROJECT_DIR}"
        exit 1
    fi
    ok "项目目录存在: ${HOST_PROJECT_DIR}"

    if [[ ! -d "${HOST_MODEL_DIR}" ]]; then
        warn "宿主机模型目录不存在: ${HOST_MODEL_DIR}"
        warn "服务可能无法加载模型"
    else
        ok "模型目录存在: ${HOST_MODEL_DIR}"
    fi

    echo ""
}

# ---------- 清理旧容器 ----------
cleanup_containers() {
    info "===== 清理旧容器 ====="
    
    for port in "${BACKEND_PORTS[@]}"; do
        docker rm -f "asr_instance_${port}" 2>/dev/null || true
    done
    docker rm -f asr_nginx 2>/dev/null || true
    
    ok "旧容器已清理"
    echo ""
}

# ---------- 启动单个实例 ----------
start_instance() {
    local gpu_id=$1
    local port=$2
    
    info "启动实例 — GPU ${gpu_id}, 端口 ${port}..."
    
    docker run -d \
        --name "asr_instance_${port}" \
        --gpus "device=${gpu_id}" \
        --restart unless-stopped \
        -p "${port}:6006" \
        -v "${HOST_PROJECT_DIR}:${CONTAINER_WORKDIR}" \
        -v "${HOST_MODEL_DIR}:${CONTAINER_MODEL_DIR}" \
        -v "${NVIDIA_ML_LIB}:${NVIDIA_ML_LIB}:ro" \
        -v "${NVIDIA_CUDA_LIB}:${NVIDIA_CUDA_LIB}:ro" \
        -w "${CONTAINER_WORKDIR}" \
        -e PYTHONPATH="${CONTAINER_ASR_DIR}" \
        -e CUDA_VISIBLE_DEVICES=0 \
        -e HF_HUB_OFFLINE=1 \
        -e TRANSFORMERS_OFFLINE=1 \
        -e HF_HUB_DISABLE_SYMLINKS_WARNING=1 \
        -e VLLM_NO_USAGE_STATS=1 \
        -e TQDM_DISABLE=1 \
        -e TZ=Asia/Shanghai \
        "${IMAGE}" \
        "mkdir -p /workspace/log && python /workspace/unified_asr_diarization_transformer_offline.py --port 6006 > /workspace/log/asr_instance_${port}.log 2>&1"
    
    if [ $? -eq 0 ]; then
        ok "实例 ${port} 启动成功 (日志: /workspace/log/asr_instance_${port}.log)"
        return 0
    else
        error "实例 ${port} 启动失败"
        return 1
    fi
}

# ---------- 启动所有后端实例 ----------
start_backend_instances() {
    info "===== 并行启动后端服务容器 ====="
    
    local pids=()
    for i in "${!GPU_IDS[@]}"; do
        start_instance "${GPU_IDS[$i]}" "${BACKEND_PORTS[$i]}" &
        pids+=($!)
    done
    
    # 等待所有后台启动完成
    for pid in "${pids[@]}"; do
        wait "$pid" 2>/dev/null || true
    done
    
    echo ""
}

# ---------- 等待服务就绪（并行检查所有端口）---------
wait_for_services() {
    info "===== 等待服务就绪 ====="
    
    local max_wait=180
    local interval=5
    local all_ready=false
    
    for ((attempt=1; attempt<=max_wait/interval; attempt++)); do
        all_ready=true
        for port in "${BACKEND_PORTS[@]}"; do
            if ! curl -sf "http://127.0.0.1:${port}/health" > /dev/null 2>&1; then
                all_ready=false
                break
            fi
        done
        
        if $all_ready; then
            for port in "${BACKEND_PORTS[@]}"; do
                ok "asr_instance_${port} 健康检查通过"
            done
            break
        fi
        
        sleep $interval
    done
    
    if ! $all_ready; then
        warn "部分服务未就绪 (${max_wait}s 超时)"
        for port in "${BACKEND_PORTS[@]}"; do
            if ! curl -sf "http://127.0.0.1:${port}/health" > /dev/null 2>&1; then
                warn "asr_instance_${port} 未就绪，请查看日志: tail -50 ${HOST_PROJECT_DIR}/log/asr_instance_${port}.log"
            fi
        done
    fi
    
    echo ""
}

# ---------- 启动 Nginx（动态生成配置）----------
start_nginx() {
    info "===== 启动 Nginx 负载均衡 ====="

    local nginx_conf="/tmp/nginx_offline_6006.conf"
    local nginx_log_dir="${HOST_PROJECT_DIR}/log"
    chmod 777 "$nginx_log_dir" 2>/dev/null || true

    # 显式拼装 upstream
    local upstream_block=""
    for port in "${BACKEND_PORTS[@]}"; do
        upstream_block="${upstream_block}    server 127.0.0.1:${port};
"
    done

    cat > "$nginx_conf" << NGINX_EOF
upstream asr_backend {
    least_conn;
${upstream_block}}
server {
    listen 6006;
    client_max_body_size 200M;

    access_log /var/log/nginx/asr_access.log;
    error_log  /var/log/nginx/asr_error.log warn;

    location / {
        proxy_pass http://asr_backend;
        proxy_set_header Host \$host;
        proxy_set_header X-Real-IP \$remote_addr;
        proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto \$scheme;
        proxy_read_timeout 300s;
        proxy_connect_timeout 75s;
        proxy_send_timeout 300s;
        proxy_http_version 1.0;
        proxy_set_header Connection "close";
        proxy_buffering off;

        add_header X-Upstream \$upstream_addr always;
    }
}
NGINX_EOF
    ok "Nginx 配置已生成: ${nginx_conf}"
    
    # 验证 upstream 包含所有后端端口
    local upstream_ports
    upstream_ports=$(grep -oE '800[0-9]' "$nginx_conf" | sort -u | tr '\n' ' ')
    info "upstream 后端: ${upstream_ports}(共 $(echo $upstream_ports | wc -w) 个)"
    
    docker run -d \
        --name asr_nginx \
        --restart unless-stopped \
        --network host \
        -v "${nginx_conf}:/etc/nginx/conf.d/default.conf:ro" \
        -v "${nginx_log_dir}:/var/log/nginx" \
        nginx:alpine
    
    sleep 2
    
    if docker ps --format "{{.Names}}" | grep -q "^asr_nginx$"; then
        ok "Nginx 容器运行中"
        
        # 验证 Nginx 健康检查
        if curl -sf "http://127.0.0.1:${NGINX_PORT}/health" > /dev/null 2>&1; then
            ok "Nginx 代理健康检查通过 (端口 ${NGINX_PORT})"
        else
            warn "Nginx 代理健康检查失败，请查看日志: tail -50 ${HOST_PROJECT_DIR}/log/asr_error.log"
        fi
        
        # 测试负载均衡分布
        info "发送 12 个请求验证负载均衡..."
        local dist=""
        for ((i=0; i<12; i++)); do
            local upstream
            upstream=$(curl -si "http://127.0.0.1:${NGINX_PORT}/health" 2>/dev/null | grep -i 'x-upstream' | awk '{print $2}' | tr -d '\r')
            dist="$dist $upstream"
        done
        echo ""
        echo "$dist" | grep -oE '800[0-9]' | sort | uniq -c | sort -rn | while read count port; do
            echo "  │  端口 ${port}: ${count} 次"
        done
    else
        error "Nginx 容器启动失败"
        exit 1
    fi
    
    echo ""
}

# ---------- 打印部署信息 ----------
print_deployment_info() {
    local gpu_ports=""
    local container_list=""
    for i in "${!GPU_IDS[@]}"; do
        gpu_ports+="  │  GPU ${GPU_IDS[$i]} → :${BACKEND_PORTS[$i]} (容器: asr_instance_${BACKEND_PORTS[$i]})│\n"
        container_list+=" asr_instance_${BACKEND_PORTS[$i]}"
    done

    echo ""
    echo "=============================================="
    echo "  ✅ 部署完成"
    echo "=============================================="
    echo "  ┌─────────────────────────────────────────┐"
    echo "  │  对外接口: http://localhost:${NGINX_PORT}        │"
    echo "  │                                         │"
    echo -e "${gpu_ports}"
    echo "  │                                         │"
    echo "  │  Nginx 负载均衡代理 ${NGINX_PORT} → $(IFS=,; echo "${BACKEND_PORTS[*]}")    │"
    echo "  │                                         │"
    echo "  │  日志目录: ${HOST_PROJECT_DIR}/log/      │"
    echo "  └─────────────────────────────────────────┘"
    echo ""
    echo "📋 常用命令："
    echo "   curl http://localhost:${NGINX_PORT}/health"
    echo "   docker logs asr_nginx"
    echo "   ./stop_offline.sh"
    echo "=============================================="
}

# ---------- 主流程 ----------
main() {
    local gpu_summary=""
    for i in "${!GPU_IDS[@]}"; do
        gpu_summary+="GPU${GPU_IDS[$i]}:${BACKEND_PORTS[$i]} "
    done

    echo ""
    echo "=============================================="
    echo "  Tailect ASR — 离线机生产模式 (Docker)"
    echo "  ${gpu_summary}"
    echo "  Nginx → localhost:${NGINX_PORT}"
    echo "  (GPU 列表来自 core/config.py → asr_available_gpus)"
    echo "=============================================="
    
    preflight_checks
    cleanup_ports
    cleanup_containers
    start_backend_instances
    wait_for_services
    start_nginx
    print_deployment_info
}

# ---------- 入口 ----------
main "$@"
