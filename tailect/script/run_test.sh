#!/usr/bin/env bash
# ===================================================================
# run_test.sh — 测试机单实例启动脚本
# 运行环境：测试机（单卡，有网络）
# GPU：cuda:0
# 端口：6006
# 用法: ./run_test.sh [--port PORT] [其他参数]
# ===================================================================

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
cd "$PROJECT_ROOT"

# ---------- 颜色输出 ----------
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
CYAN='\033[0;36m'
NC='\033[0m'

info()  { echo -e "${CYAN}[INFO]${NC}  $*"; }
ok()    { echo -e "${GREEN}[OK]${NC}    $*"; }
error() { echo -e "${RED}[ERROR]${NC} $*" >&2; }

echo ""
echo "=============================================="
echo "  Tailect ASR — 测试机单实例模式"
echo "  GPU: cuda:0  |  端口: 6006"
echo "  工作目录: $(pwd)"
echo "=============================================="
echo ""

# 检查主脚本是否存在
if [ ! -f "unified_asr_diarization_transformer_offline.py" ]; then
    error "脚本不存在: $(pwd)/unified_asr_diarization_transformer_offline.py"
    exit 1
fi

# 添加项目根目录到 PYTHONPATH
export PYTHONPATH="${PYTHONPATH}:${PROJECT_ROOT}"
info "PYTHONPATH: ${PYTHONPATH}"

# 设置仅使用 GPU 0
export CUDA_VISIBLE_DEVICES=0
info "CUDA_VISIBLE_DEVICES=${CUDA_VISIBLE_DEVICES}"

PORT="${1:-6006}"
info "启动服务 (port=${PORT})..."
echo ""

exec python unified_asr_diarization_transformer_offline.py --port "${PORT}"
