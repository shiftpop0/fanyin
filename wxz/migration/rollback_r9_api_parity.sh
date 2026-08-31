#!/usr/bin/env bash
# Restore files retained by apply_r9_api_parity.sh.
# The R9 backup and package are retained; containers are not restarted automatically.

set -euo pipefail

RELEASE_ROOT="${RELEASE_ROOT:-/home/gezhi/fanyin/releases/new4.1-20260829}"
LATEST_POINTER="${RELEASE_ROOT}/wxz/hotfix_backups/r9_api_parity_latest.txt"
BACKUP_ROOT="${BACKUP_ROOT:-}"

if [[ -z "$BACKUP_ROOT" ]]; then
    [[ -f "$LATEST_POINTER" ]] || {
        echo "Backup pointer not found: $LATEST_POINTER" >&2
        echo "Set BACKUP_ROOT explicitly to an r9_api_parity_* backup directory." >&2
        exit 1
    }
    BACKUP_ROOT="$(head -n 1 "$LATEST_POINTER" | tr -d '\r\n')"
fi

case "$BACKUP_ROOT" in
    "${RELEASE_ROOT}/wxz/hotfix_backups/r9_api_parity_"*) ;;
    *) echo "Refusing unexpected backup path: $BACKUP_ROOT" >&2; exit 1 ;;
esac

files=(
    "tailect/core/audio_input.py"
    "tailect/core/config.py"
    "tailect/core/inference_engine.py"
    "tailect/core/v1_adapter.py"
    "tailect/core/v1_contract.py"
    "tailect/core/v1_router.py"
    "tailect/tests/test_v1_platform.py"
    "tailect/README.md"
    "spyware-translator-v4.1/spyware-translator-v4.1.user.js"
    "spyware-translator-v4.1/tests/tailect_v41_probe.mjs"
    "spyware-translator-v4.1/tests/userscript_static_test.mjs"
)

for relative_path in "${files[@]}"; do
    backup_path="${BACKUP_ROOT}/${relative_path}"
    target_path="${RELEASE_ROOT}/${relative_path}"
    [[ -f "$backup_path" ]] || { echo "Backup file missing: $backup_path" >&2; exit 1; }
    [[ -f "$target_path" ]] || { echo "Release target missing: $target_path" >&2; exit 1; }
    cp -a "$backup_path" "$target_path"
    printf 'Restored: %s\n' "$target_path"
done

printf 'R9 backup retained at: %s\n' "$BACKUP_ROOT"
printf 'No container was stopped or restarted. Restart this project to load restored files.\n'
