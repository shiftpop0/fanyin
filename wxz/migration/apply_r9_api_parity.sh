#!/usr/bin/env bash
# Apply R9 native-6006 ASR parity to the existing new4.1 release.
# Files are backed up first; containers are not stopped, restarted, or removed.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PACKAGE_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
PAYLOAD_ROOT="${PACKAGE_ROOT}/payload"
RELEASE_ROOT="${RELEASE_ROOT:-/home/gezhi/fanyin/releases/new4.1-20260829}"
BACKUP_ROOT="${RELEASE_ROOT}/wxz/hotfix_backups/r9_api_parity_$(date '+%Y%m%d_%H%M%S')"
LATEST_POINTER="${RELEASE_ROOT}/wxz/hotfix_backups/r9_api_parity_latest.txt"

files=(
    "tailect/core/audio_input.py"
    "tailect/core/inference_engine.py"
    "tailect/core/v1_adapter.py"
    "tailect/core/v1_contract.py"
    "tailect/README.md"
    "spyware-translator-v4.1/spyware-translator-v4.1.user.js"
    "spyware-translator-v4.1/tests/userscript_static_test.mjs"
)

[[ -d "$PAYLOAD_ROOT" ]] || { echo "Package payload not found: $PAYLOAD_ROOT" >&2; exit 1; }
[[ -d "$RELEASE_ROOT/tailect/core" ]] || { echo "Release not found: $RELEASE_ROOT/tailect/core" >&2; exit 1; }

if command -v sha256sum >/dev/null 2>&1 && [[ -f "$PACKAGE_ROOT/SHA256SUMS" ]]; then
    (cd "$PACKAGE_ROOT" && sha256sum -c SHA256SUMS)
fi

for relative_path in "${files[@]}"; do
    source_path="${PAYLOAD_ROOT}/${relative_path}"
    target_path="${RELEASE_ROOT}/${relative_path}"
    [[ -f "$source_path" ]] || { echo "R9 source missing: $source_path" >&2; exit 1; }
    [[ -f "$target_path" ]] || { echo "Release target missing: $target_path" >&2; exit 1; }
done

if grep -Eq 'pan=mono|audio channel merge|_mono\.wav|merged .*channels to mono' \
    "$PAYLOAD_ROOT/tailect/core/audio_input.py"; then
    echo "R9 payload unexpectedly contains the rejected R8 server-side downmix logic." >&2
    exit 1
fi
grep -Fq 'def transcribe_diarized_segments(' \
    "$PAYLOAD_ROOT/tailect/core/inference_engine.py" || {
    echo "R9 shared diarized ASR core is missing from payload." >&2
    exit 1
}
grep -Fq 'service.transcribe_diarized_segments(' \
    "$PAYLOAD_ROOT/tailect/core/v1_adapter.py" || {
    echo "R9 v1 adapter does not call the shared diarized ASR core." >&2
    exit 1
}

if grep -Fq 'def transcribe_diarized_segments(' \
    "$RELEASE_ROOT/tailect/core/inference_engine.py" && \
    grep -Fq 'service.transcribe_diarized_segments(' \
    "$RELEASE_ROOT/tailect/core/v1_adapter.py"; then
    echo "Release already appears to contain R9; refusing a duplicate apply." >&2
    echo "A duplicate backup would make the default rollback point ambiguous." >&2
    exit 1
fi

if command -v python3 >/dev/null 2>&1; then
    python3 - "$PAYLOAD_ROOT" <<'PY'
import ast
import pathlib
import sys

root = pathlib.Path(sys.argv[1])
for relative in (
    "tailect/core/audio_input.py",
    "tailect/core/inference_engine.py",
    "tailect/core/v1_adapter.py",
    "tailect/core/v1_contract.py",
):
    path = root / relative
    ast.parse(path.read_text(encoding="utf-8"), filename=str(path))
print("R9 payload Python syntax check passed.")
PY
fi

# Complete the backup before changing any release file.  Publish the pointer now so
# rollback remains available even if a later copy is interrupted.
for relative_path in "${files[@]}"; do
    target_path="${RELEASE_ROOT}/${relative_path}"
    backup_path="${BACKUP_ROOT}/${relative_path}"
    mkdir -p "$(dirname "$backup_path")"
    cp -a "$target_path" "$backup_path"
done
mkdir -p "$(dirname "$LATEST_POINTER")"
printf '%s\n' "$BACKUP_ROOT" > "$LATEST_POINTER"

for relative_path in "${files[@]}"; do
    source_path="${PAYLOAD_ROOT}/${relative_path}"
    target_path="${RELEASE_ROOT}/${relative_path}"
    cp -a "$source_path" "$target_path"
    printf 'Updated: %s\n' "$target_path"
done

if command -v python3 >/dev/null 2>&1; then
    python3 - "$RELEASE_ROOT" <<'PY'
import ast
import pathlib
import sys

root = pathlib.Path(sys.argv[1])
for relative in (
    "tailect/core/audio_input.py",
    "tailect/core/inference_engine.py",
    "tailect/core/v1_adapter.py",
    "tailect/core/v1_contract.py",
):
    path = root / relative
    ast.parse(path.read_text(encoding="utf-8"), filename=str(path))
print("R9 Python syntax check passed.")
PY
fi

printf 'R9 files applied. Previous files retained under: %s\n' "$BACKUP_ROOT"
printf 'Backup pointer: %s\n' "$LATEST_POINTER"
printf 'No container was stopped or restarted. Restart this project to load R9.\n'
