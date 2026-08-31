#!/usr/bin/env bash
# Restore the files saved by apply_web_console.sh. Container switching is manual.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PACKAGE_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
RELEASE_ROOT="${RELEASE_ROOT:-/home/gezhi/fanyin/releases/new4.1-20260829}"
LATEST_POINTER="${RELEASE_ROOT}/wxz/hotfix_backups/web_console_latest.txt"

[[ -f "$LATEST_POINTER" ]] || { echo "Web backup pointer not found: $LATEST_POINTER" >&2; exit 1; }
BACKUP_ROOT="$(head -n 1 "$LATEST_POINTER")"
[[ -d "$BACKUP_ROOT" ]] || { echo "Web backup directory not found: $BACKUP_ROOT" >&2; exit 1; }

files=(
    "wxz/deploy/nginx_platform_8885.conf"
    "wxz/deploy/proxy_params.conf"
    "wxz/deploy/run_v4_1_single_4090.sh"
)

for relative_path in "${files[@]}"; do
    [[ -f "$BACKUP_ROOT/$relative_path" ]] || { echo "Backup file missing: $relative_path" >&2; exit 1; }
    cp -a "$BACKUP_ROOT/$relative_path" "$RELEASE_ROOT/$relative_path"
    printf 'Restored: %s\n' "$RELEASE_ROOT/$relative_path"
done

if [[ -d "$BACKUP_ROOT/tailect/web/dist" ]]; then
    mkdir -p "$RELEASE_ROOT/tailect/web/dist"
    cp -a "$BACKUP_ROOT/tailect/web/dist/." "$RELEASE_ROOT/tailect/web/dist/"
    echo "Restored the previous Web build without deleting newer retained files."
else
    echo "No previous Web build existed; deployed dist files are retained but can be left unmounted."
fi

printf 'File rollback completed from: %s\n' "$BACKUP_ROOT"
printf 'No container was stopped, renamed, removed, or started.\n'
