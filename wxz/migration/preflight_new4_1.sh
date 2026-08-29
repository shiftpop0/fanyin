#!/usr/bin/env bash
# Tailect_V4.1 生产迁移只读预检：不创建、启动、停止或删除容器。

set -u

RELEASE_ROOT="${RELEASE_ROOT:-/home/gezhi/fanyin/releases/new4.1-20260829}"
PROJECT_ROOT="${PROJECT_ROOT:-${RELEASE_ROOT}/tailect}"
MODEL_DIR="${MODEL_DIR:-/home/gezhi/fanyin/tailect/model}"
IMAGE="${IMAGE:-tailect-asr-qwen3-asr:full-diar-offline}"
NGINX_IMAGE="${NGINX_IMAGE:-harbor.ge.cn/ailab/base/nginx:1.30.3-otel}"
MODEL_CONTAINER="${MODEL_CONTAINER:-tailect-v41-model}"
PLATFORM_CONTAINER="${PLATFORM_CONTAINER:-tailect-v41-platform}"
OLD_CONTAINER="${OLD_CONTAINER:-asr_instance_6006}"
FAILURES=0

ok() { printf '[OK] %s\n' "$*"; }
warn() { printf '[WARN] %s\n' "$*"; }
fail() { printf '[FAIL] %s\n' "$*"; FAILURES=$((FAILURES + 1)); }

check_dir() {
    local path="$1"
    local label="$2"
    [[ -d "$path" ]] && ok "$label: $path" || fail "$label 缺失: $path"
}

port_in_use() {
    local port="$1"
    if command -v ss >/dev/null 2>&1; then
        ss -ltn 2>/dev/null | awk -v port=":${port}" '$4 ~ port "$" { found=1 } END { exit !found }'
    elif command -v lsof >/dev/null 2>&1; then
        lsof -t -i ":${port}" >/dev/null 2>&1
    else
        return 1
    fi
}

printf 'Tailect_V4.1 production preflight\n'
printf 'release=%s\nproject=%s\nmodel=%s\nimage=%s\nnginx=%s\n\n' \
    "$RELEASE_ROOT" "$PROJECT_ROOT" "$MODEL_DIR" "$IMAGE" "$NGINX_IMAGE"

if [[ -r /etc/os-release ]]; then
    grep -E '^(PRETTY_NAME|VERSION_ID)=' /etc/os-release || true
fi

command -v docker >/dev/null 2>&1 && ok 'Docker 命令存在' || fail 'Docker 命令不存在'
if command -v docker >/dev/null 2>&1; then
    docker info >/dev/null 2>&1 && ok 'Docker daemon 可用' || fail 'Docker daemon 不可用'
    docker image inspect "$IMAGE" >/dev/null 2>&1 \
        && ok "ASR 镜像存在: $IMAGE" \
        || fail "ASR 镜像缺失: $IMAGE"
    docker image inspect "$NGINX_IMAGE" >/dev/null 2>&1 \
        && ok "8885 网关镜像存在: $NGINX_IMAGE" \
        || fail "8885 网关镜像缺失: $NGINX_IMAGE"

    if docker inspect "$OLD_CONTAINER" >/dev/null 2>&1; then
        docker inspect "$OLD_CONTAINER" \
            --format='[INFO] old_container={{.Name}} status={{.State.Status}} exit={{.State.ExitCode}} oom_killed={{.State.OOMKilled}} finished={{.State.FinishedAt}}' \
            2>/dev/null || true
        old_running="$(docker inspect "$OLD_CONTAINER" --format='{{.State.Running}}' 2>/dev/null || true)"
        old_oom_killed="$(docker inspect "$OLD_CONTAINER" --format='{{.State.OOMKilled}}' 2>/dev/null || true)"
        [[ "$old_running" == 'true' ]] \
            && fail "旧容器仍在运行: $OLD_CONTAINER" \
            || ok "旧容器未运行: $OLD_CONTAINER"
        [[ "$old_oom_killed" == 'true' ]] \
            && fail "旧容器曾被 OOM Kill；在继续使用 vLLM 0.7 前必须先核查显存日志" \
            || ok '旧容器没有 OOMKilled 记录'
    else
        warn "未找到旧容器: $OLD_CONTAINER"
    fi

    for container_name in "$MODEL_CONTAINER" "$PLATFORM_CONTAINER"; do
        if docker inspect "$container_name" >/dev/null 2>&1; then
            fail "新容器名称已存在，为避免启动陈旧配置而拒绝继续: $container_name"
        else
            ok "新容器名称可用: $container_name"
        fi
    done
fi

if port_in_use 6006; then fail '端口 6006 已被监听'; else ok '端口 6006 空闲'; fi
if port_in_use 8885; then fail '端口 8885 已被监听'; else ok '端口 8885 空闲'; fi

if command -v nvidia-smi >/dev/null 2>&1; then
    gpu_zero="$(nvidia-smi --query-gpu=index,name,memory.total,memory.used --format=csv,noheader -i 0 2>/dev/null || true)"
    if [[ -n "$gpu_zero" ]]; then
        printf '[INFO] GPU0: %s\n' "$gpu_zero"
        [[ "$gpu_zero" == *'RTX 4090'* ]] && ok 'GPU0 是 RTX 4090' || fail 'GPU0 不是预期的 RTX 4090'
    else
        fail '无法读取 GPU0'
    fi
else
    fail 'nvidia-smi 不存在'
fi

check_dir "$PROJECT_ROOT" 'new4.1 release 源码'
check_dir "$MODEL_DIR" '复用模型根目录'
check_dir "$MODEL_DIR/Tailect_V4.1" 'ASR 模型'
check_dir "$MODEL_DIR/Qwen3-ForcedAligner-0.6B" 'ForcedAligner 模型'
check_dir "$PROJECT_ROOT/TargetDiarization-main" 'TargetDiarization 源码'
check_dir "$MODEL_DIR/iic/speech_campplus_speaker-diarization_common" 'CAM++ diarization 模型'
check_dir "$MODEL_DIR/iic/speech_eres2netv2w24s4ep4_sv_zh-cn_16k-common" '说话人嵌入模型'
check_dir "$MODEL_DIR/iic/speech_fsmn_vad_zh-cn-16k-common-pytorch" 'VAD 模型'

if [[ -d "$MODEL_DIR/pyannote/speaker-diarization-3.1" ]]; then
    ok "PyAnnote 模型: $MODEL_DIR/pyannote/speaker-diarization-3.1"
elif [[ -d "$MODEL_DIR/pyannote/speaker-diarization-community-1" ]]; then
    ok "PyAnnote 兼容模型: $MODEL_DIR/pyannote/speaker-diarization-community-1"
else
    fail 'PyAnnote 模型缺失（需要 speaker-diarization-3.1 或 speaker-diarization-community-1）'
fi

CONFIG_FILE="$PROJECT_ROOT/core/config.py"
if [[ -f "$CONFIG_FILE" ]]; then
    grep -Eq '"vllm_gpu_memory_utilization"[[:space:]]*:[[:space:]]*0\.7' "$CONFIG_FILE" \
        && ok 'vLLM GPU memory utilization=0.7' \
        || fail 'new4.1 配置不是 vLLM GPU memory utilization=0.7'
    grep -Eq '"v1_diarization_fallback"[[:space:]]*:[[:space:]]*False' "$CONFIG_FILE" \
        && ok 'diarize=1 严格模式已启用' \
        || fail 'diarize=1 仍允许静默降级'
else
    fail "配置文件缺失: $CONFIG_FILE"
fi

ALLOWLIST_FILE="$PROJECT_ROOT/config/audio_url_allowlist.json"
if [[ -f "$ALLOWLIST_FILE" ]] && grep -Fq '"1.2.3.4"' "$ALLOWLIST_FILE"; then
    ok 'HTTP URL 白名单已包含 1.2.3.4'
else
    fail "HTTP URL 白名单未包含 1.2.3.4: $ALLOWLIST_FILE"
fi

printf '\n'
if [[ "$FAILURES" -eq 0 ]]; then
    printf 'PRECHECK PASSED: 可以进入启动步骤。\n'
    exit 0
fi
printf 'PRECHECK FAILED: 共 %s 项失败；未执行任何启动或修改操作。\n' "$FAILURES"
exit 1
