#!/usr/bin/env bash
# Tailect_V4.1 生产环境只读信息采集脚本
#
# 作用：采集增量迁移所需的 Docker、GPU、端口、目录和离线镜像信息。
# 保证：除指定的采集结果文件及其父目录外，不创建或修改项目文件；
#       不启动、不停止、不重启、不创建、不删除任何容器或镜像。
#
# 默认用法：
#   bash collect_production_info.sh
#
# 原容器名称不是 asr_instance_6006 时：
#   CONTAINER_NAME=实际容器名称 bash collect_production_info.sh
#
# 指定项目目录或输出文件：
#   PROJECT_DIR=/home/gezhi/fanyin/tailect \
#   OUTPUT_FILE=/home/gezhi/fanyin/production_info.txt \
#   bash collect_production_info.sh

set -u

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="${PROJECT_DIR:-/home/gezhi/fanyin/tailect}"
CONTAINER_NAME="${CONTAINER_NAME:-asr_instance_6006}"
COLLECTED_AT="$(date '+%Y%m%d_%H%M%S')"
OUTPUT_FILE="${OUTPUT_FILE:-${SCRIPT_DIR}/production_info_${COLLECTED_AT}.txt}"

mkdir -p "$(dirname "$OUTPUT_FILE")"
exec > >(tee "$OUTPUT_FILE") 2>&1

section() {
    printf '\n============================================================\n'
    printf '%s\n' "$1"
    printf '============================================================\n'
}

run_if_available() {
    local command_name="$1"
    shift
    if command -v "$command_name" >/dev/null 2>&1; then
        "$@"
    else
        printf '[未安装] %s\n' "$command_name"
    fi
}

check_directory() {
    local path="$1"
    local label="$2"
    if [[ -d "$path" ]]; then
        printf '[存在] %s: %s\n' "$label" "$path"
    else
        printf '[缺失] %s: %s\n' "$label" "$path"
    fi
}

section '采集说明'
printf '采集时间: %s\n' "$(date --iso-8601=seconds 2>/dev/null || date)"
printf '项目目录: %s\n' "$PROJECT_DIR"
printf '候选原容器: %s\n' "$CONTAINER_NAME"
printf '输出文件: %s\n' "$OUTPUT_FILE"
printf '说明: 除上述输出文件及其父目录外，本脚本不改变容器、镜像、端口或项目文件。\n'
printf '说明: 本脚本不输出容器完整环境变量，避免泄露密钥。\n'

section '操作系统与基础环境'
printf '主机名: %s\n' "$(hostname 2>/dev/null || printf '未知')"
if [[ -r /etc/os-release ]]; then
    grep -E '^(PRETTY_NAME|VERSION_ID)=' /etc/os-release || true
fi
uname -a 2>/dev/null || true
printf '\nDocker 命令: '
command -v docker 2>/dev/null || printf '未安装\n'
if command -v docker >/dev/null 2>&1; then
    docker version --format 'Client={{.Client.Version}} Server={{.Server.Version}}' 2>/dev/null \
        || docker version 2>&1 \
        || true
fi

section 'Docker 容器列表'
if command -v docker >/dev/null 2>&1; then
    docker ps -a --no-trunc \
        --format 'table {{.Names}}\t{{.Image}}\t{{.Status}}\t{{.Ports}}' 2>&1 \
        || true
else
    printf '无法检查：Docker 命令不存在。\n'
fi

INSPECT_CONTAINER=""
PORT_CANDIDATES=()
if command -v docker >/dev/null 2>&1; then
    if docker inspect "$CONTAINER_NAME" >/dev/null 2>&1; then
        INSPECT_CONTAINER="$CONTAINER_NAME"
    else
        mapfile -t PORT_CANDIDATES < <(
            docker ps -a --filter publish=6006 --format '{{.Names}}' 2>/dev/null
        )
        if [[ "${#PORT_CANDIDATES[@]}" -eq 1 ]]; then
            INSPECT_CONTAINER="${PORT_CANDIDATES[0]}"
            printf '\n[自动识别] 发布 6006 端口的唯一容器是: %s\n' "$INSPECT_CONTAINER"
        fi
    fi
fi

section "原容器详情: ${INSPECT_CONTAINER:-未能唯一识别}"
if [[ -n "$INSPECT_CONTAINER" ]]; then
    docker inspect "$INSPECT_CONTAINER" --format 'name={{.Name}}
image={{.Config.Image}}
image_id={{.Image}}
status={{.State.Status}}
exit_code={{.State.ExitCode}}
oom_killed={{.State.OOMKilled}}
finished_at={{.State.FinishedAt}}
workdir={{.Config.WorkingDir}}
entrypoint={{json .Config.Entrypoint}}
cmd={{json .Config.Cmd}}
network_mode={{.HostConfig.NetworkMode}}
ports={{json .HostConfig.PortBindings}}
gpu_requests={{json .HostConfig.DeviceRequests}}
restart_policy={{.HostConfig.RestartPolicy.Name}}' 2>&1 || true

    printf '\n挂载目录：\n'
    docker inspect "$INSPECT_CONTAINER" \
        --format '{{range .Mounts}}{{println .Type ":" .Source " -> " .Destination "(" .Mode ")"}}{{end}}' \
        2>&1 || true

    printf '\nDocker 网络：\n'
    docker inspect "$INSPECT_CONTAINER" \
        --format '{{range $name,$value := .NetworkSettings.Networks}}{{println $name}}{{end}}' \
        2>&1 || true
else
    printf '未找到容器 %s。\n' "$CONTAINER_NAME"
    if [[ "${#PORT_CANDIDATES[@]}" -gt 1 ]]; then
        printf '同时发现多个发布 6006 端口的候选容器：\n'
        printf '  %s\n' "${PORT_CANDIDATES[@]}"
    fi
    printf '请根据上面的容器列表确认名称；如名称不同，可重新运行：\n'
    printf '  CONTAINER_NAME=实际名称 bash %s\n' "$(basename "$0")"
fi

section '本地 Docker 镜像'
if command -v docker >/dev/null 2>&1; then
    docker image ls --no-trunc \
        --format 'table {{.Repository}}\t{{.Tag}}\t{{.ID}}\t{{.Size}}' 2>&1 \
        || true
else
    printf '无法检查：Docker 命令不存在。\n'
fi

section 'Nginx 可用性'
if command -v docker >/dev/null 2>&1; then
    if docker image inspect nginx:alpine >/dev/null 2>&1; then
        printf '[存在] Docker 镜像 nginx:alpine\n'
        docker image inspect nginx:alpine \
            --format 'id={{.Id}} created={{.Created}} size_bytes={{.Size}}' 2>&1 \
            || true
    else
        printf '[不存在] Docker 镜像 nginx:alpine\n'
    fi

    printf '\n其他 Nginx Docker 镜像：\n'
    docker image ls --format '{{.Repository}}:{{.Tag}} {{.ID}} {{.Size}}' 2>/dev/null \
        | grep -E '(^|/)nginx:' \
        || printf '未发现其他 nginx:* 镜像。\n'
fi

if command -v nginx >/dev/null 2>&1; then
    printf '\n[存在] 宿主机 Nginx: '
    nginx -v 2>&1 || true
else
    printf '\n[不存在] 宿主机未发现 nginx 命令。\n'
fi

section '6006 与 8885 端口'
if command -v ss >/dev/null 2>&1; then
    ss -ltnp 2>&1 | awk '
        NR == 1 || $4 ~ /:6006$/ || $4 ~ /:8885$/ { print }
    ' || true
elif command -v lsof >/dev/null 2>&1; then
    lsof -nP -iTCP:6006 -sTCP:LISTEN 2>&1 || true
    lsof -nP -iTCP:8885 -sTCP:LISTEN 2>&1 || true
else
    printf '未安装 ss 或 lsof，无法检查监听端口。\n'
fi

if command -v docker >/dev/null 2>&1; then
    printf '\nDocker 端口映射摘要：\n'
    docker ps -a --format '{{.Names}} {{.Ports}}' 2>/dev/null \
        | grep -E '(^|[^0-9])(6006|8885)([^0-9]|$)' \
        || printf '未发现包含 6006 或 8885 的 Docker 端口映射。\n'
fi

section 'GPU 与 NVIDIA 容器运行时'
if command -v nvidia-smi >/dev/null 2>&1; then
    nvidia-smi --query-gpu=index,name,uuid,memory.total,memory.used,driver_version \
        --format=csv,noheader 2>&1 || true
else
    printf '未发现 nvidia-smi。\n'
fi

if command -v docker >/dev/null 2>&1; then
    printf '\nDocker runtimes：\n'
    docker info --format '{{json .Runtimes}}' 2>&1 || true
fi

section '项目目录与关键模型'
if [[ -d "$PROJECT_DIR" ]]; then
    printf '[存在] 项目目录: %s\n' "$PROJECT_DIR"
    if command -v du >/dev/null 2>&1; then
        printf '项目总大小（只读统计，可能包含模型）：\n'
        du -sh "$PROJECT_DIR" 2>&1 || true
    fi
else
    printf '[缺失] 项目目录: %s\n' "$PROJECT_DIR"
fi

check_directory "$PROJECT_DIR/model" '模型根目录'
check_directory "$PROJECT_DIR/model/Tailect_V4.1" 'ASR 模型 Tailect_V4.1'
check_directory "$PROJECT_DIR/model/Qwen3-ForcedAligner-0.6B" 'ForcedAligner 模型'
check_directory "$PROJECT_DIR/TargetDiarization-main" 'TargetDiarization 源码'
check_directory "$PROJECT_DIR/model/iic/speech_campplus_speaker-diarization_common" 'CAM++ 说话人分离模型'
check_directory "$PROJECT_DIR/model/pyannote/speaker-diarization-3.1" 'PyAnnote 说话人分离模型（README 标准路径）'
check_directory "$PROJECT_DIR/model/pyannote/speaker-diarization-community-1" 'PyAnnote 说话人分离模型（兼容路径，可选）'
check_directory "$PROJECT_DIR/model/iic/speech_eres2netv2w24s4ep4_sv_zh-cn_16k-common" '说话人嵌入模型'
check_directory "$PROJECT_DIR/model/iic/speech_fsmn_vad_zh-cn-16k-common-pytorch" 'VAD 模型'
check_directory "$PROJECT_DIR/model/iic/punc_ct-transformer_zh-cn-common-vocab272727-pytorch" '标点模型'

section '生产源码版本与关键配置'
if [[ -d "$PROJECT_DIR/.git" ]] && command -v git >/dev/null 2>&1; then
    git -C "$PROJECT_DIR" status --short --branch 2>&1 || true
    git -C "$PROJECT_DIR" log -1 --format='commit=%H%nsubject=%s%ncommitted_at=%cI' 2>&1 || true
else
    printf '项目目录不是 Git 工作树，或未安装 Git。\n'
fi

if [[ -f "$PROJECT_DIR/core/config.py" ]]; then
    printf '\ncore/config.py 中与迁移有关的配置行：\n'
    grep -nE 'asr_model_path|asr_batch_size|diarization_project_path|forced_aligner_model_path|vllm_gpu_memory_utilization|vllm_max_new_tokens|vllm_max_model_len|server_port|auto_kill_port_occupier' \
        "$PROJECT_DIR/core/config.py" 2>&1 || true
else
    printf '[缺失] %s/core/config.py\n' "$PROJECT_DIR"
fi

if [[ -f "$PROJECT_DIR/core/config_auto.py" ]]; then
    printf '\ncore/config_auto.py 中与迁移有关的配置行：\n'
    grep -nE 'asr_model_path|asr_batch_size|diarization_project_path|forced_aligner_model_path|vllm_gpu_memory_utilization|vllm_max_new_tokens|vllm_max_model_len|server_port|auto_kill_port_occupier' \
        "$PROJECT_DIR/core/config_auto.py" 2>&1 || true
else
    printf '\n[未发现] %s/core/config_auto.py\n' "$PROJECT_DIR"
fi

printf '\n关键源码 SHA-256：\n'
if command -v sha256sum >/dev/null 2>&1; then
    for relative_path in \
        core/config.py \
        core/config_auto.py \
        core/api_server.py \
        core/inference_engine.py \
        unified_asr_diarization_transformer_offline.py \
        script/run_auto.sh; do
        if [[ -f "$PROJECT_DIR/$relative_path" ]]; then
            sha256sum "$PROJECT_DIR/$relative_path" 2>&1 || true
        fi
    done
else
    printf '未安装 sha256sum。\n'
fi

section '已有 ASR 离线镜像归档'
if [[ -d /home/gezhi/fanyin ]]; then
    find /home/gezhi/fanyin -maxdepth 2 -type f \
        \( -name 'tailect-asr*.tar' -o -name '*qwen3*asr*.tar' \) \
        -printf '%p | %s bytes | %TY-%Tm-%Td %TH:%TM:%TS\n' 2>&1 \
        || true
else
    printf '[缺失] /home/gezhi/fanyin\n'
fi

section '采集完成'
printf '请将这个文件返回给开发方：\n%s\n' "$OUTPUT_FILE"
if [[ -z "$INSPECT_CONTAINER" ]]; then
    printf '未能唯一识别原容器；请按上面的提示指定 CONTAINER_NAME 后重新运行。\n'
fi
