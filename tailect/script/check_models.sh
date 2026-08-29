#!/usr/bin/env bash
# ===================================================================
# check_models.sh — 离线机模型完整性检查脚本
# 在部署前运行，确保所有模型文件已存在（避免启动时联网下载）
# 用法: ./check_models.sh [模型目录路径]
#       如果不传参数，默认使用项目根目录下的 model/ 目录
# ===================================================================

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
MODEL_DIR="${1:-${PROJECT_ROOT}/model}"

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
CYAN='\033[0;36m'
NC='\033[0m'

info()  { echo -e "${CYAN}[INFO]${NC}  $*"; }
ok()    { echo -e "${GREEN}[OK]${NC}    $*"; }
warn()  { echo -e "${YELLOW}[WARN]${NC}  $*"; }
error() { echo -e "${RED}[ERROR]${NC} $*"; }

echo ""
echo "=============================================="
echo "  模型完整性检查"
echo "  目录: $MODEL_DIR"
echo "=============================================="
echo ""

MISSING=0

check_dir() {
    if [ -d "$1" ]; then
        ok "$2"
    else
        error "缺失: $1 ($2)"
        MISSING=1
    fi
}

check_file() {
    if [ -f "$1" ]; then
        ok "$2"
    else
        error "缺失: $1 ($2)"
        MISSING=1
    fi
}

# ===== ASR 模型 =====
info "--- ASR 模型 ---"
check_dir "${MODEL_DIR}/Tailect_v2.0" "ASR 主模型 (Qwen3-ASR)"

# ===== 强制对齐模型 =====
info "--- 强制对齐模型 ---"
check_dir "${MODEL_DIR}/Qwen3-ForcedAligner-0.6B" "强制对齐模型"

# ===== 说话人分离模型 (ModelScope) =====
info "--- 说话人分离模型 ---"
check_dir "${MODEL_DIR}/iic/speech_campplus_speaker-diarization_common" "说话人分离 pipeline (ModelScope)"
check_dir "${MODEL_DIR}/pyannote/speaker-diarization-3.1" "重叠检测模型 (PyAnnote)"
check_file "${MODEL_DIR}/pyannote/speaker-diarization-3.1/config.yaml" "PyAnnote config.yaml"

# ===== 声纹模型 =====
info "--- 声纹/嵌入模型 ---"
check_dir "${MODEL_DIR}/iic/speech_eres2netv2w24s4ep4_sv_zh-cn_16k-common" "声纹嵌入模型 (ERes2NetV2)"
check_dir "${MODEL_DIR}/damo/speech_campplus_sv_zh-cn_16k-common" "声纹模型 (CAM++)"
check_dir "${MODEL_DIR}/iic/speech_campplus_sv_zh-cn_16k-common" "声纹模型 (CAM++ iic)"

# ===== VAD 模型 =====
info "--- VAD 模型 ---"
check_dir "${MODEL_DIR}/iic/speech_fsmn_vad_zh-cn-16k-common-pytorch" "VAD 模型 (iic)"
check_dir "${MODEL_DIR}/damo/speech_fsmn_vad_zh-cn-16k-common-pytorch" "VAD 模型 (damo)"

# ===== 标点恢复模型 =====
info "--- 标点恢复模型 ---"
check_dir "${MODEL_DIR}/iic/punc_ct-transformer_zh-cn-common-vocab272727-pytorch" "标点恢复模型"

# ===== 说话人变化检测 =====
info "--- 辅助模型 ---"
check_dir "${MODEL_DIR}/damo/speech_campplus-transformer_scl_zh-cn_16k-common" "说话人变化检测模型"
check_dir "${MODEL_DIR}/speech_campplus_speaker-diarization_common" "附加 diarization 模型 (旧路径)"
check_dir "${MODEL_DIR}/checkpoints/mossformer2-finetune" "MossFormer2 分离权重"

echo ""
if [ "$MISSING" -eq 0 ]; then
    ok "所有模型文件完整！"
else
    warn "部分模型缺失，请检查后重新部署。"
fi
echo ""
