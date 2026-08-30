#!/usr/bin/env bash
# Apply the r8 explicit multichannel-to-mono preprocessing patch to an existing release.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PACKAGE_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
PAYLOAD_ROOT="${PACKAGE_ROOT}/payload"
RELEASE_ROOT="${RELEASE_ROOT:-/home/gezhi/fanyin/releases/new4.1-20260829}"
BACKUP_ROOT="${RELEASE_ROOT}/wxz/hotfix_backups/r8_stereo_downmix_$(date '+%Y%m%d_%H%M%S')"
LATEST_POINTER="${RELEASE_ROOT}/wxz/hotfix_backups/r8_stereo_downmix_latest.txt"

files=(
    "tailect/core/audio_input.py"
    "tailect/core/v1_router.py"
)

[[ -d "$PAYLOAD_ROOT" ]] || { echo "Package payload not found: $PAYLOAD_ROOT" >&2; exit 1; }
[[ -d "$RELEASE_ROOT/tailect/core" ]] || { echo "Release not found: $RELEASE_ROOT/tailect/core" >&2; exit 1; }

if command -v sha256sum >/dev/null 2>&1 && [[ -f "$PACKAGE_ROOT/SHA256SUMS" ]]; then
    (cd "$PACKAGE_ROOT" && sha256sum -c SHA256SUMS)
fi

for relative_path in "${files[@]}"; do
    source_path="${PAYLOAD_ROOT}/${relative_path}"
    target_path="${RELEASE_ROOT}/${relative_path}"
    backup_path="${BACKUP_ROOT}/${relative_path}"
    [[ -f "$source_path" ]] || { echo "Patch source missing: $source_path" >&2; exit 1; }
    [[ -f "$target_path" ]] || { echo "Release target missing: $target_path" >&2; exit 1; }
    mkdir -p "$(dirname "$backup_path")"
    cp -a "$target_path" "$backup_path"
    cp -a "$source_path" "$target_path"
    printf 'Updated: %s\n' "$target_path"
done

mkdir -p "$(dirname "$LATEST_POINTER")"
printf '%s\n' "$BACKUP_ROOT" > "$LATEST_POINTER"

printf 'Previous files retained under: %s\n' "$BACKUP_ROOT"
printf 'Backup pointer: %s\n' "$LATEST_POINTER"
printf 'No container was stopped or restarted. Restart new4.1 to load the patch.\n'

