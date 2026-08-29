#!/usr/bin/env bash
# stop_offline.sh — 动态停止所有容器并清理端口
# 从 core/config.py 读取 GPU 列表，自动计算容器和端口

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
cd "$SCRIPT_DIR"

# 颜色输出
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
CYAN='\033[0;36m'
NC='\033[0m'

info()  { echo -e "${CYAN}[INFO]${NC}  $*"; }
ok()    { echo -e "${GREEN}[OK]${NC}    $*"; }
warn()  { echo -e "${YELLOW}[WARN]${NC}  $*"; }
error() { echo -e "${RED}[ERROR]${NC} $*" >&2; }

echo ""
echo "=============================================="
echo "  停止 Tailect ASR 服务"
echo "=============================================="
echo ""

# ---------- 从 config.py 读取 GPU 部署列表 ----------
CONFIG_FILE="${PROJECT_ROOT}/core/config.py"
if [ -f "$CONFIG_FILE" ]; then
    GPU_LIST=$(grep -E 'asr_available_gpus' "$CONFIG_FILE" 2>/dev/null \
               | grep -oE '"[0-9,]+"' | head -1 | tr -d '"')
fi
GPU_LIST="${GPU_LIST:-0,1}"

IFS=',' read -ra GPU_IDS <<< "$GPU_LIST"

# 生成容器名和端口列表
CONTAINER_NAMES=""
PORTS=()
for i in "${!GPU_IDS[@]}"; do
    port=$((8001 + i))
    CONTAINER_NAMES+=" asr_instance_${port}"
    PORTS+=("$port")
done
NGINX_PORT=6006
PORTS+=("$NGINX_PORT")

# 1. 停止并删除 Docker 容器
info "停止并删除容器..."
# shellcheck disable=SC2086
docker rm -f ${CONTAINER_NAMES} 2>/dev/null || true
docker rm -f asr_nginx 2>/dev/null || true
ok "容器已清理"

# 2. 清理端口占用
info "清理端口占用..."
for port in "${PORTS[@]}"; do
    pids=$(lsof -t -i ":$port" 2>/dev/null || true)
    if [ -n "$pids" ]; then
        warn "端口 $port 被占用，清理进程: $pids"
        for pid in $pids; do
            kill -9 "$pid" 2>/dev/null || true
        done
    fi
done
ok "端口已释放"

echo ""
info "停止完成"
