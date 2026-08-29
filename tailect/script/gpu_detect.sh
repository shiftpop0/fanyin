#!/usr/bin/env bash
# ===================================================================
# gpu_detect.sh — GPU 检测函数库
# 通过 nvidia-smi 检测 GPU 硬件信息，nvidia-smi 不可用时自动降级
# 用法: source script/gpu_detect.sh
# ===================================================================

# ---------- 颜色输出（安全引用，兼容 set -u）----------
_gpu_info()  { echo -e "${CYAN:-}[GPU]${NC:-}   $*"; }
_gpu_ok()    { echo -e "${GREEN:-}[GPU.OK]${NC:-} $*"; }
_gpu_warn()  { echo -e "${YELLOW:-}[GPU.WARN]${NC:-} $*"; }
_gpu_error() { echo -e "${RED:-}[GPU.ERROR]${NC:-} $*" >&2; }

# ---------- 检测 nvidia-smi 是否可用 ----------
_nvidia_smi_available() {
    command -v nvidia-smi &>/dev/null && nvidia-smi --query-gpu=count --format=csv,noheader &>/dev/null
}

# ---------- 检测 GPU 数量 ----------
detect_gpu_count() {
    if _nvidia_smi_available; then
        GPU_COUNT=$(nvidia-smi --query-gpu=count --format=csv,noheader 2>/dev/null | head -1 | tr -d ' ')
        GPU_COUNT=${GPU_COUNT:-1}
    else
        GPU_COUNT=1
        _gpu_warn "nvidia-smi 不可用，默认 GPU_COUNT=1"
    fi
    echo "$GPU_COUNT"
}

# ---------- 检测指定 GPU 的显存 (MiB) ----------
detect_gpu_memory_mb() {
    local gpu_id=${1:-0}
    local mem_mib=""
    if _nvidia_smi_available; then
        mem_mib=$(nvidia-smi --query-gpu=memory.total --format=csv,noheader,nounits -i "$gpu_id" 2>/dev/null | head -1 | tr -d ' ')
    fi
    if [[ -z "$mem_mib" || "$mem_mib" == "0" ]]; then
        mem_mib=8192
        _gpu_warn "GPU $gpu_id 显存检测失败，默认 8192 MiB"
    fi
    echo "$mem_mib"
}

# ---------- 检测指定 GPU 的计算能力 ----------
detect_gpu_compute_cap() {
    local gpu_id=${1:-0}
    local cc=""
    if _nvidia_smi_available; then
        cc=$(nvidia-smi --query-gpu=compute_cap --format=csv,noheader -i "$gpu_id" 2>/dev/null | head -1 | tr -d ' ')
    fi
    if [[ -z "$cc" ]]; then
        cc="7.0"
        _gpu_warn "GPU $gpu_id 计算能力检测失败，默认 7.0"
    fi
    echo "$cc"
}

# ---------- 检测指定 GPU 的型号名称 ----------
detect_gpu_name() {
    local gpu_id=${1:-0}
    local name=""
    if _nvidia_smi_available; then
        name=$(nvidia-smi --query-gpu=name --format=csv,noheader -i "$gpu_id" 2>/dev/null | head -1 | sed 's/^[ \t]*//;s/[ \t]*$//')
    fi
    if [[ -z "$name" ]]; then
        name="Unknown GPU"
        _gpu_warn "GPU $gpu_id 型号检测失败，默认 'Unknown GPU'"
    fi
    echo "$name"
}

# ---------- 检测所有 GPU 的完整信息 ----------
detect_all_gpus_info() {
    local count
    count=$(detect_gpu_count)
    echo "=============================================="
    echo "  GPU 检测报告"
    echo "=============================================="
    echo "  GPU 数量: $count"
    echo "  ─────────────────────────────────────"
    for ((i = 0; i < count; i++)); do
        local name mem cc
        name=$(detect_gpu_name "$i")
        mem=$(detect_gpu_memory_mb "$i")
        cc=$(detect_gpu_compute_cap "$i")
        printf "  GPU %d: %s | %d MiB | CC %s\n" "$i" "$name" "$mem" "$cc"
    done
    echo "=============================================="
}

# ---------- 导出 GPU 环境变量 ----------
# 设置所有 GPU 的全局变量数组，供其他脚本 source 使用
export_gpu_env() {
    GPU_COUNT=$(detect_gpu_count)
    GPU_NAMES=()
    GPU_MEM_MIBS=()
    GPU_COMPUTE_CAPS=()
    for ((i = 0; i < GPU_COUNT; i++)); do
        GPU_NAMES+=("$(detect_gpu_name "$i")")
        GPU_MEM_MIBS+=("$(detect_gpu_memory_mb "$i")")
        GPU_COMPUTE_CAPS+=("$(detect_gpu_compute_cap "$i")")
    done
    export GPU_COUNT
    export GPU_NAMES
    export GPU_MEM_MIBS
    export GPU_COMPUTE_CAPS
}
