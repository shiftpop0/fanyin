#!/usr/bin/env bash
# ===================================================================
# run.sh — 一键启动 tailect-asr-qwen3-asr 离线服务容器
# 运行环境：WSL (Ubuntu / 默认发行版)
# Docker 镜像：tailect-asr-qwen3-asr:offline-salvaged-20260506
# 容器端口映射：6006（HTTP API）
# 用法: ./run.sh [--standalone] [--help]
# ===================================================================

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"

# ---------- 常量 ----------
IMAGE="${IMAGE:-tailect-asr-qwen3-asr:offline-salvaged-20260506}"
CONTAINER_NAME="${CONTAINER_NAME:-tailect-offline-prod}"
HOST_PORT=${HOST_PORT:-6006}
CONTAINER_PORT=6006

# 宿主机路径（可通过环境变量覆盖，默认指向项目根目录）
HOST_PROJECT_DIR="${HOST_PROJECT_DIR:-${PROJECT_ROOT}}"
HOST_MODEL_DIR="${HOST_MODEL_DIR:-${PROJECT_ROOT}/model}"

# 容器内路径
CONTAINER_WORKDIR="/workspace"

# ASR 脚本在项目根目录（asr_offline/ 是老名称，文件已移至根目录）
CONTAINER_ASR_DIR="${CONTAINER_WORKDIR}"
CONTAINER_PYTHON_SCRIPT="${CONTAINER_WORKDIR}/unified_asr_diarization_transformer_offline.py"

# ---------- 颜色输出 ----------
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
CYAN='\033[0;36m'
NC='\033[0m' # No Color

info()  { echo -e "${CYAN}[INFO]${NC}  $*"; }
warn()  { echo -e "${YELLOW}[WARN]${NC}  $*"; }
error() { echo -e "${RED}[ERROR]${NC} $*" >&2; }
ok()    { echo -e "${GREEN}[OK]${NC}    $*"; }

# ---------- 前置检查 ----------
preflight_checks() {
    echo ""
    info "===== 前置环境检查 ====="

    # 1. 检查 WSL 路径可访问
    if [ -d "$HOST_PROJECT_DIR" ]; then
        ok "项目目录存在: $HOST_PROJECT_DIR"
    else
        error "项目目录不存在: $HOST_PROJECT_DIR"
        error "请确认 WSL 能访问 Windows 路径 D:\\dialect\\Tailect_web"
        error "提示: 可在 WSL 中执行 'ls /mnt/d/' 查看盘符挂载情况"
        exit 1
    fi

    # 2. 检查模型目录
    if [ -d "$HOST_MODEL_DIR" ]; then
        ok "模型目录存在: $HOST_MODEL_DIR"
    else
        warn "模型目录不存在: $HOST_MODEL_DIR"
        warn "服务会以降级模式启动（缺少模型可能导致部分功能不可用）"
    fi

    # 3. 检查主 Python 脚本（在项目根目录）
    if [ -f "$HOST_PROJECT_DIR/unified_asr_diarization_transformer_offline.py" ]; then
        ok "启动脚本存在: unified_asr_diarization_transformer_offline.py"
    else
        error "启动脚本不存在: $HOST_PROJECT_DIR/unified_asr_diarization_transformer_offline.py"
        exit 1
    fi

    # 3b. 检查 core 模块目录
    if [ -d "$HOST_PROJECT_DIR/core" ]; then
        ok "核心模块目录存在 (core/)"
    else
        warn "核心模块目录不存在: $HOST_PROJECT_DIR/core"
        warn "请确认重构后的文件结构完整"
    fi

    # 4. 检查 Docker 是否可用
    if command -v docker &>/dev/null; then
        ok "Docker 命令可用: $(docker --version)"
    else
        error "Docker 未安装或不在 PATH 中"
        error "请先安装 Docker: https://docs.docker.com/engine/install/"
        exit 1
    fi

    # 5. 检查 Docker 守护进程是否运行
    if docker info &>/dev/null; then
        ok "Docker 守护进程运行中"
    else
        error "Docker 守护进程未运行"
        error "请启动 Docker Desktop 或 systemctl start docker"
        exit 1
    fi

    # 6. 检查 Docker 镜像是否存在
    if docker image inspect "$IMAGE" &>/dev/null; then
        ok "Docker 镜像已存在: $IMAGE"
    else
        error "Docker 镜像不存在: $IMAGE"
        error "请先构建或导入镜像: docker load < tailect-asr-qwen3-asr-offline-salvaged-20260506.tar.gz"
        exit 1
    fi

    # 7. 检查 GPU 支持
    if docker run --rm --gpus all nvidia/cuda:12.2.0-base-ubuntu22.04 nvidia-smi &>/dev/null; then
        ok "GPU (--gpus all) 可用"
    else
        # 降级检查：可以不深度测试，但至少检测 docker 是否识别 --gpus
        if docker run --rm --gpus all alpine echo "gpu-check" &>/dev/null; then
            ok "GPU (--gpus all) 可用"
        else
            warn "nvidia-docker 可能未正确安装"
            warn "容器将以 CPU 模式运行（如镜像需要 GPU 将失败）"
            warn "安装指引: https://docs.nvidia.com/datacenter/cloud-native/container-toolkit/install-guide.html"
        fi
    fi

    echo ""
}

# ---------- 清理旧容器 ----------
cleanup_old_container() {
    info "检查旧容器: $CONTAINER_NAME"
    if docker ps -a --format "{{.Names}}" | grep -q "^${CONTAINER_NAME}$"; then
        warn "发现同名旧容器，正在停止并删除..."
        docker stop "$CONTAINER_NAME" 2>/dev/null || true
        docker rm -f "$CONTAINER_NAME" 2>/dev/null || true
        ok "旧容器已清理"
    else
        ok "无同名旧容器"
    fi
    echo ""
}

# ---------- 启动容器 ----------
start_container() {
    info "===== 启动容器 ====="
    echo ""

    # 容器的 Entrypoint 是 /bin/bash -lc，因此整个 Python 命令必须作为
    # 一个字符串参数传入，否则 bash -lc 会只执行第一个 token。
    # PYTHONPATH 用于确保 core/ 模块可被正确导入。
    local docker_cmd=(
        docker run
        --name "$CONTAINER_NAME"
        --gpus all
        -p "${HOST_PORT}:${CONTAINER_PORT}"
        -v "${HOST_PROJECT_DIR}:${CONTAINER_WORKDIR}"
        -v "${HOST_MODEL_DIR}:${CONTAINER_WORKDIR}/model"
        -w "${CONTAINER_WORKDIR}"
        -e "PYTHONPATH=${CONTAINER_ASR_DIR}:${PYTHONPATH:-}"
        -e "HF_HUB_OFFLINE=1"
        -e "TRANSFORMERS_OFFLINE=1"
        "$IMAGE"
        "python ${CONTAINER_PYTHON_SCRIPT}"
    )

    echo -e "${CYAN}执行命令:${NC}"
    echo "  docker run \\"
    echo "    --name $CONTAINER_NAME \\"
    echo "    --gpus all \\"
    echo "    -p ${HOST_PORT}:${CONTAINER_PORT} \\"
    echo "    -v ${HOST_PROJECT_DIR}:${CONTAINER_WORKDIR} \\"
    echo "    -v ${HOST_MODEL_DIR}:${CONTAINER_WORKDIR}/model \\"
    echo "    -w ${CONTAINER_WORKDIR} \\"
    echo "    -e PYTHONPATH=${CONTAINER_ASR_DIR}:\${PYTHONPATH:-} \\"
    echo "    $IMAGE \\"
    echo "    \"python ${CONTAINER_PYTHON_SCRIPT}\""
    echo ""

    info "容器启动中，日志将实时输出 (按 Ctrl+C 停止)..."
    echo ""

    # 前台运行 —— 用户 Ctrl+C 后容器自动停止
    "${docker_cmd[@]}"
    local exit_code=$?

    echo ""
    if [ $exit_code -ne 0 ]; then
        warn "容器已退出 (exit code: $exit_code)"
        warn "可通过以下命令查看完整日志:"
        echo "  docker logs $CONTAINER_NAME"
    else
        ok "容器正常退出"
    fi

    return $exit_code
}

# ---------- 独立运行模式（无需 Docker）----------
run_standalone() {
    cd "$PROJECT_ROOT"

    echo ""
    info "===== 独立运行模式（无 Docker）====="
    info "工作目录: $(pwd)"

    # 添加项目根目录到 Python 路径，确保 core/ 模块可导入
    export PYTHONPATH="${PYTHONPATH}:${PROJECT_ROOT}"
    info "PYTHONPATH: ${PYTHONPATH}"

    # 检查主脚本是否存在
    if [ ! -f "unified_asr_diarization_transformer_offline.py" ]; then
        error "脚本不存在: $(pwd)/unified_asr_diarization_transformer_offline.py"
        exit 1
    fi

    info "启动服务..."
    echo ""

    python unified_asr_diarization_transformer_offline.py "$@"
    local exit_code=$?

    if [ $exit_code -ne 0 ]; then
        warn "服务已退出 (exit code: $exit_code)"
    else
        ok "服务正常退出"
    fi

    return $exit_code
}

# ---------- 主流程 ----------
main() {
    echo ""
    echo "=============================================="
    echo "  Tailect ASR Offline Service Launcher"
    echo "  镜像: $IMAGE"
    echo "  容器: $CONTAINER_NAME"
    echo "  端口: ${HOST_PORT} -> ${CONTAINER_PORT}"
    echo "=============================================="
    echo ""

    preflight_checks
    cleanup_old_container
    start_container
}

# ---------- 入口 ----------
if [[ "${1:-}" == "--standalone" ]]; then
    shift
    run_standalone "$@"
elif [[ "${1:-}" == "--help" ]] || [[ "${1:-}" == "-h" ]]; then
    echo "用法: $0 [OPTIONS]"
    echo ""
    echo "选项:"
    echo "  --standalone     直接运行 Python 服务（无需 Docker）"
    echo "  --help, -h       显示此帮助信息"
    echo ""
    echo "默认模式: 使用 Docker 运行（需安装 Docker 和 nvidia-container-toolkit）"
    exit 0
else
    main "$@"
fi
