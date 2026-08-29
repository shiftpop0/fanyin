#!/usr/bin/env bash
# 向已创建的 new4.1 release 应用 r7 启动/兼容性修复；不停止容器，不删除文件。

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PACKAGE_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
PAYLOAD_ROOT="${PACKAGE_ROOT}/payload"
RELEASE_ROOT="${RELEASE_ROOT:-/home/gezhi/fanyin/releases/new4.1-20260829}"
BACKUP_ROOT="${RELEASE_ROOT}/wxz/hotfix_backups/r7_$(date '+%Y%m%d_%H%M%S')"

[[ -d "$PAYLOAD_ROOT" ]] || { echo "Package payload not found: $PAYLOAD_ROOT" >&2; exit 1; }
[[ -d "$RELEASE_ROOT/tailect" ]] || { echo "Release not found: $RELEASE_ROOT/tailect" >&2; exit 1; }

files=(
    "tailect/core/api_server.py"
    "tailect/core/model_loader.py"
    "tailect/tests/test_core.py"
    "tailect/unified_asr_diarization_transformer_offline.py"
    "wxz/deploy/run_v4_1_single_4090.sh"
)

for relative_path in "${files[@]}"; do
    source_path="${PAYLOAD_ROOT}/${relative_path}"
    target_path="${RELEASE_ROOT}/${relative_path}"
    backup_path="${BACKUP_ROOT}/${relative_path}"
    [[ -f "$source_path" ]] || { echo "Hotfix source missing: $source_path" >&2; exit 1; }
    if [[ -f "$target_path" ]]; then
        mkdir -p "$(dirname "$backup_path")"
        cp -a "$target_path" "$backup_path"
    fi
    mkdir -p "$(dirname "$target_path")"
    cp -a "$source_path" "$target_path"
    printf 'Updated: %s\n' "$target_path"
done

printf 'Previous files retained under: %s\n' "$BACKUP_ROOT"
printf 'No container was stopped or restarted. Restart new4.1 to load the updated Python files.\n'
