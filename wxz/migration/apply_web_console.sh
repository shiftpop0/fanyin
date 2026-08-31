#!/usr/bin/env bash
# Install the prebuilt 8885 Web console files without restarting containers.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PACKAGE_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
PAYLOAD_ROOT="${PACKAGE_ROOT}/payload"
RELEASE_ROOT="${RELEASE_ROOT:-/home/gezhi/fanyin/releases/new4.1-20260829}"
BACKUP_ROOT="${RELEASE_ROOT}/wxz/hotfix_backups/web_console_$(date '+%Y%m%d_%H%M%S')"
LATEST_POINTER="${RELEASE_ROOT}/wxz/hotfix_backups/web_console_latest.txt"

files=(
    "wxz/deploy/nginx_platform_8885.conf"
    "wxz/deploy/proxy_params.conf"
    "wxz/deploy/run_v4_1_single_4090.sh"
)

[[ -f "$PAYLOAD_ROOT/tailect/web/dist/index.html" ]] || {
    echo "Web index missing from payload." >&2
    exit 1
}
find "$PAYLOAD_ROOT/tailect/web/dist/assets" -maxdepth 1 -type f | grep -q . || {
    echo "Web assets missing from payload." >&2
    exit 1
}
[[ -d "$RELEASE_ROOT/tailect" ]] || { echo "Release not found: $RELEASE_ROOT" >&2; exit 1; }

if command -v sha256sum >/dev/null 2>&1 && [[ -f "$PACKAGE_ROOT/SHA256SUMS" ]]; then
    (cd "$PACKAGE_ROOT" && sha256sum -c SHA256SUMS)
fi

for relative_path in "${files[@]}"; do
    [[ -f "$PAYLOAD_ROOT/$relative_path" ]] || { echo "Payload file missing: $relative_path" >&2; exit 1; }
    [[ -f "$RELEASE_ROOT/$relative_path" ]] || { echo "Release file missing: $relative_path" >&2; exit 1; }
done

grep -Fq 'try_files /index.html =404' "$PAYLOAD_ROOT/wxz/deploy/nginx_platform_8885.conf" || {
    echo "Payload Nginx configuration does not serve the Web index." >&2
    exit 1
}
grep -Fq '/usr/share/nginx/html:ro' "$PAYLOAD_ROOT/wxz/deploy/run_v4_1_single_4090.sh" || {
    echo "Payload start script does not mount the Web build." >&2
    exit 1
}

mkdir -p "$BACKUP_ROOT"
for relative_path in "${files[@]}"; do
    mkdir -p "$BACKUP_ROOT/$(dirname "$relative_path")"
    cp -a "$RELEASE_ROOT/$relative_path" "$BACKUP_ROOT/$relative_path"
done
if [[ -d "$RELEASE_ROOT/tailect/web/dist" ]]; then
    mkdir -p "$BACKUP_ROOT/tailect/web"
    cp -a "$RELEASE_ROOT/tailect/web/dist" "$BACKUP_ROOT/tailect/web/dist"
else
    printf 'tailect/web/dist\n' > "$BACKUP_ROOT/ABSENT_BEFORE_APPLY.txt"
fi
mkdir -p "$(dirname "$LATEST_POINTER")"
printf '%s\n' "$BACKUP_ROOT" > "$LATEST_POINTER"

for relative_path in "${files[@]}"; do
    cp -a "$PAYLOAD_ROOT/$relative_path" "$RELEASE_ROOT/$relative_path"
    printf 'Updated: %s\n' "$RELEASE_ROOT/$relative_path"
done
mkdir -p "$RELEASE_ROOT/tailect/web/dist/assets"
cp -a "$PAYLOAD_ROOT/tailect/web/dist/." "$RELEASE_ROOT/tailect/web/dist/"

printf 'Web files installed. Previous files retained under: %s\n' "$BACKUP_ROOT"
printf 'No container was stopped or restarted. Follow migration/README.md to activate Web safely.\n'
