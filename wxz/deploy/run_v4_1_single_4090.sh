#!/usr/bin/env bash
# Single-GPU production entry: one Tailect_V4.1 process on 6006 and platform proxy on 8885.
# This script never kills port owners and never removes containers.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPOSITORY_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"
PROJECT_ROOT="${REPOSITORY_ROOT}/tailect"
IMAGE="${IMAGE:-tailect-asr-qwen3-asr:full-diar-offline}"
NGINX_IMAGE="${NGINX_IMAGE:-harbor.ge.cn/ailab/base/nginx:1.30.3-otel}"
GPU_ID="${GPU_ID:-0}"
MODEL_CONTAINER="${MODEL_CONTAINER:-tailect-v41-model}"
PLATFORM_CONTAINER="${PLATFORM_CONTAINER:-tailect-v41-platform}"
MODEL_DIR="${MODEL_DIR:-${PROJECT_ROOT}/model}"
LOG_DIR="${LOG_DIR:-${PROJECT_ROOT}/log}"
ACTION="${1:-start}"

container_exists() { docker ps -a --format '{{.Names}}' | grep -Fxq "$1"; }
container_running() { docker ps --format '{{.Names}}' | grep -Fxq "$1"; }
port_in_use() {
    if command -v ss >/dev/null 2>&1; then
        ss -ltn "sport = :$1" 2>/dev/null | grep -q LISTEN
    else
        lsof -t -i ":$1" >/dev/null 2>&1
    fi
}

status() {
    docker ps -a --filter "name=^/${MODEL_CONTAINER}$" --filter "name=^/${PLATFORM_CONTAINER}$" \
        --format 'table {{.Names}}\t{{.Status}}\t{{.Ports}}'
    curl -fsS http://127.0.0.1:6006/health || true
    echo
    curl -fsS http://127.0.0.1:8885/health || true
    echo
}

if [[ "$ACTION" == "status" ]]; then
    status
    exit 0
fi

if [[ "$ACTION" == "stop" ]]; then
    container_running "$PLATFORM_CONTAINER" && docker stop "$PLATFORM_CONTAINER" >/dev/null
    container_running "$MODEL_CONTAINER" && docker stop "$MODEL_CONTAINER" >/dev/null
    echo "Stopped project containers; they were not removed."
    exit 0
fi

if [[ "$ACTION" != "start" ]]; then
    echo "Usage: $0 [start|status|stop]" >&2
    exit 2
fi

command -v docker >/dev/null 2>&1 || { echo "Docker is not installed." >&2; exit 1; }
docker info >/dev/null 2>&1 || { echo "Docker daemon is unavailable." >&2; exit 1; }
docker image inspect "$IMAGE" >/dev/null 2>&1 || { echo "Offline model image not found: $IMAGE" >&2; exit 1; }
docker image inspect "$NGINX_IMAGE" >/dev/null 2>&1 || { echo "Offline Nginx image not found: $NGINX_IMAGE" >&2; exit 1; }
[[ -d "$MODEL_DIR/Tailect_V4.1" ]] || { echo "Model directory not found: $MODEL_DIR/Tailect_V4.1" >&2; exit 1; }
mkdir -p "$LOG_DIR" "$PROJECT_ROOT/outputs/api_uploads" "$PROJECT_ROOT/outputs/fanyin_output"

if container_running "$MODEL_CONTAINER"; then
    echo "Model container already running: $MODEL_CONTAINER"
elif container_exists "$MODEL_CONTAINER"; then
    port_in_use 6006 && { echo "Port 6006 is occupied; refusing to start." >&2; exit 1; }
    docker start "$MODEL_CONTAINER" >/dev/null
else
    port_in_use 6006 && { echo "Port 6006 is occupied; refusing to start." >&2; exit 1; }
    model_args=(
        docker run -d --name "$MODEL_CONTAINER" --restart unless-stopped
        --gpus "device=${GPU_ID}" --network host
        -v "${PROJECT_ROOT}:/workspace" -v "${MODEL_DIR}:/workspace/model"
        -w /workspace -e PYTHONPATH=/workspace -e CUDA_VISIBLE_DEVICES=0
        -e HF_HUB_OFFLINE=1 -e TRANSFORMERS_OFFLINE=1 -e MODELSCOPE_OFFLINE=1
        -e AUDIOPROCESSOR_DISABLED_PACKAGES=enhancer,separater,restorer
        -e VLLM_NO_USAGE_STATS=1 -e TQDM_DISABLE=1 -e TZ=Asia/Shanghai
    )
    [[ -n "${TAILECT_API_KEY:-}" ]] && model_args+=(-e "TAILECT_API_KEY=${TAILECT_API_KEY}")
    model_args+=(
        --entrypoint bash "$IMAGE" -c
        'python /workspace/unified_asr_diarization_transformer_offline.py --host 0.0.0.0 --port 6006 >> /workspace/log/tailect_v41_model.log 2>&1'
    )
    "${model_args[@]}" >/dev/null
fi

echo "Waiting for Tailect_V4.1 on port 6006..."
ready=false
for _ in $(seq 1 180); do
    if curl -fsS http://127.0.0.1:6006/health >/dev/null 2>&1; then ready=true; break; fi
    sleep 2
done
$ready || { echo "Model did not become ready; inspect $LOG_DIR/tailect_v41_model.log" >&2; exit 1; }

if container_running "$PLATFORM_CONTAINER"; then
    echo "Platform container already running: $PLATFORM_CONTAINER"
elif container_exists "$PLATFORM_CONTAINER"; then
    port_in_use 8885 && { echo "Port 8885 is occupied; refusing to start." >&2; exit 1; }
    docker start "$PLATFORM_CONTAINER" >/dev/null
else
    port_in_use 8885 && { echo "Port 8885 is occupied; refusing to start." >&2; exit 1; }
    docker run -d --name "$PLATFORM_CONTAINER" --restart unless-stopped --network host \
        -v "${SCRIPT_DIR}/nginx_platform_8885.conf:/etc/nginx/conf.d/default.conf:ro" \
        -v "${SCRIPT_DIR}/proxy_params.conf:/etc/nginx/proxy_params.conf:ro" \
        -v "${LOG_DIR}:/var/log/nginx" "$NGINX_IMAGE" >/dev/null
fi

curl -fsS http://127.0.0.1:8885/health >/dev/null
echo "Ready: generic API http://127.0.0.1:6006; platform API http://127.0.0.1:8885"
