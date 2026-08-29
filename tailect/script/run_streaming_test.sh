#!/usr/bin/env bash
# ===================================================================
# run_streaming_test.sh — 流式识别独立测试服务
# 仅加载 vLLM 后端，不加载 Transformers/DIAR 等其他模型。
# 用于快速验证流式识别功能。
#
# 用法:
#   bash script/run_streaming_test.sh
#
# 环境变量（可选）:
#   STREAM_PORT=6007          # 服务端口，默认 6007
#   STREAM_GMU=0.7            # GPU 显存利用率，默认 0.7
#   STREAM_MAX_TOKENS=256     # 最大生成 token 数，默认 256
#   IMAGE=tailect-asr-qwen3-asr:offline-salvaged-20260506  # Docker 镜像
#
# 测试:
#   curl http://localhost:2300/health
#   python3 script/run_streaming_test_client.py  # 客户端测试
#
# 注意: 服务端会自动复制 core/vad.py 到容器中
# ===================================================================

set -euo pipefail

# ---------- 常量 ----------
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"
IMAGE="${IMAGE:-tailect-asr-qwen3-asr:offline-salvaged-20260506}"
CONTAINER_NAME="streaming-test"
HOST_PORT="${STREAM_PORT:-2300}"
CONTAINER_PORT=6007
GPU_MEM_UTIL="${STREAM_GMU:-0.7}"
MAX_TOKENS="${STREAM_MAX_TOKENS:-256}"

# WSL 宿主机路径（通过 /mnt/ 访问 Windows 盘符）
HOST_MODEL_DIR="${PROJECT_DIR}/model"

# 容器内路径
CONTAINER_WORKDIR="/workspace"
CONTAINER_MODEL_DIR="${CONTAINER_WORKDIR}/model"
CONTAINER_SCRIPT="${CONTAINER_WORKDIR}/test_streaming_only.py"

# ---------- 颜色输出 ----------
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
CYAN='\033[0;36m'
NC='\033[0m'

info()  { echo -e "${CYAN}[INFO]${NC}  $*"; }
warn()  { echo -e "${YELLOW}[WARN]${NC}  $*"; }
error() { echo -e "${RED}[ERROR]${NC} $*" >&2; }
ok()    { echo -e "${GREEN}[OK]${NC}    $*"; }

# ---------- 前置检查 ----------
preflight_checks() {
    echo ""
    info "===== 前置环境检查 ====="

    # 1. 检查模型目录
    if [ -d "${HOST_MODEL_DIR}/Tailect_v3.1_ttFinetune" ]; then
        ok "模型目录存在: ${HOST_MODEL_DIR}/Tailect_v3.1_ttFinetune"
    else
        warn "模型 Tailect_v3.1_ttFinetune 不存在于 ${HOST_MODEL_DIR}"
        warn "请确认模型路径正确"
    fi

    # 2. 检查测试脚本
    if [ -f "${PROJECT_DIR}/test_streaming_only.py" ]; then
        ok "测试脚本存在: ${PROJECT_DIR}/test_streaming_only.py"
    else
        error "测试脚本不存在: ${PROJECT_DIR}/test_streaming_only.py"
        error "请确认 Tailect_server 目录下有 test_streaming_only.py"
        exit 1
    fi

    # 3. 检查 Docker
    if command -v docker &> /dev/null; then
        ok "Docker 可用"
    else
        error "Docker 未安装"
        exit 1
    fi

    # 4. 检查镜像
    if docker images --format "{{.Repository}}:{{.Tag}}" | grep -q "^${IMAGE}$"; then
        ok "Docker 镜像存在: ${IMAGE}"
    else
        error "Docker 镜像不存在: ${IMAGE}"
        exit 1
    fi

    echo ""
}

# ---------- 启动服务 ----------
start_service() {
    info "===== 启动流式识别测试服务 ====="
    echo ""
    info "  镜像:         ${IMAGE}"
    info "  容器名:       ${CONTAINER_NAME}"
    info "  端口:         ${HOST_PORT} -> ${CONTAINER_PORT}"
    info "  模型:         ${HOST_MODEL_DIR}"
    info "  GPU 显存:     ${GPU_MEM_UTIL}"
    info "  最大 tokens: ${MAX_TOKENS}"
    echo ""

    # 清理旧容器
    docker rm -f "${CONTAINER_NAME}" 2>/dev/null || true

    # 启动容器
    info "创建容器 (端口映射 ${HOST_PORT} -> ${CONTAINER_PORT})..."
    docker run -d --gpus all \
        --entrypoint /bin/bash \
        --name "${CONTAINER_NAME}" \
        -p "${HOST_PORT}:${CONTAINER_PORT}" \
        -v "${HOST_MODEL_DIR}:${CONTAINER_MODEL_DIR}" \
        "${IMAGE}" \
        -c "sleep 9999" > /dev/null

    ok "容器已创建"

    # 复制测试脚本
    info "复制测试脚本..."
    docker cp "${PROJECT_DIR}/test_streaming_only.py" \
        "${CONTAINER_NAME}:${CONTAINER_SCRIPT}" > /dev/null
    ok "脚本已复制"

    ok "脚本已复制"

    # 启动流式服务
    info "启动流式服务 (后台)..."
    docker exec "${CONTAINER_NAME}" sh -c \
        "nohup python3 ${CONTAINER_SCRIPT} \
            --model ${CONTAINER_MODEL_DIR}/Tailect_v3.1_ttFinetune \
            --port ${CONTAINER_PORT} \
            --gmu ${GPU_MEM_UTIL} \
            --max-tokens ${MAX_TOKENS} \
            > /tmp/streaming.log 2>&1 &"

    ok "流式服务已启动"
    echo ""
}

# ---------- 等待服务就绪 ----------
wait_for_service() {
    info "===== 等待模型加载 ====="
    info "vLLM 首次加载需编译 CUDA graphs，预计 2~5 分钟..."
    echo ""

    local elapsed=0
    local timeout=600
    local check_interval=15

    while [ ${elapsed} -lt ${timeout} ]; do
        if docker exec "${CONTAINER_NAME}" python3 -c "
import urllib.request
try:
    r = urllib.request.urlopen('http://localhost:${CONTAINER_PORT}/health', timeout=5)
    print(r.read().decode())
    exit(0)
except Exception:
    exit(1)
" 2>/dev/null; then
            echo ""
            ok "服务已就绪！"
            echo ""
            return 0
        fi

        elapsed=$((elapsed + check_interval))
        warn "等待中... ${elapsed}s（查看日志: docker exec ${CONTAINER_NAME} tail -f /tmp/streaming.log）"
        sleep ${check_interval}
    done

    error "服务启动超时（${timeout}s）"
    error "查看日志: docker exec ${CONTAINER_NAME} cat /tmp/streaming.log"
    return 1
}

# ---------- 打印摘要 ----------
print_summary() {
    echo ""
    info "============================================"
    info "  流式识别测试服务已就绪！"
    info "============================================"
    echo ""
    info "  健康检查:"
    info "    curl http://localhost:${HOST_PORT}/health"
    echo ""
    info "  流式 API:"
    info "    POST http://localhost:${HOST_PORT}/api/stream/start"
    info "    POST http://localhost:${HOST_PORT}/api/stream/chunk?session_id=<id>"
    info "    POST http://localhost:${HOST_PORT}/api/stream/finish?session_id=<id>"
    echo ""
    info "  查看日志:"
    info "    docker exec ${CONTAINER_NAME} tail -f /tmp/streaming.log"
    echo ""
    info "  麦克风测试（连续流式，VAD 自动分段）:"
    info "    python ${PROJECT_DIR}/script/run_streaming_test_mic.py"
    echo ""
    info "  停止服务:"
    info "  停止服务:"
    info "    docker rm -f ${CONTAINER_NAME}"
    echo ""
    info "============================================"
    echo ""
}

# ---------- 主流程 ----------
main() {
    echo ""
    echo -e "${CYAN}╔════════════════════════════════════════════════╗${NC}"
    echo -e "${CYAN}║      Tailect 流式识别测试服务启动脚本        ║${NC}"
    echo -e "${CYAN}╚════════════════════════════════════════════════╝${NC}"
    echo ""

    preflight_checks
    start_service
    wait_for_service
    print_summary
}

main "$@"
