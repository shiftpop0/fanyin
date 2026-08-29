#!/usr/bin/env bash
# 从现有生产源码旁路创建 new4.1 release；不覆盖或删除旧项目。

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PACKAGE_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
PAYLOAD_ROOT="${PACKAGE_ROOT}/payload"
BASE_PROJECT="${BASE_PROJECT:-/home/gezhi/fanyin/tailect}"
MODEL_DIR="${MODEL_DIR:-${BASE_PROJECT}/model}"
RELEASE_ROOT="${RELEASE_ROOT:-/home/gezhi/fanyin/releases/new4.1-20260829}"
RELEASE_PROJECT="${RELEASE_ROOT}/tailect"

[[ -d "$BASE_PROJECT" ]] || { echo "Base project not found: $BASE_PROJECT" >&2; exit 1; }
[[ -d "$MODEL_DIR" ]] || { echo "Model directory not found: $MODEL_DIR" >&2; exit 1; }
[[ -d "$PAYLOAD_ROOT/tailect" ]] || { echo "Package payload not found: $PAYLOAD_ROOT" >&2; exit 1; }
[[ ! -e "$RELEASE_ROOT" ]] || {
    echo "Release target already exists; refusing to overwrite: $RELEASE_ROOT" >&2
    echo "Move it to a retained backup location before retrying." >&2
    exit 1
}

if [[ -f "$PACKAGE_ROOT/SHA256SUMS" ]]; then
    (cd "$PACKAGE_ROOT" && sha256sum -c SHA256SUMS)
fi

mkdir -p "$RELEASE_PROJECT"

# 只在本机复制原源码骨架；明确排除模型、日志、输出、缓存和旧项目隔离目录。
(
    cd "$BASE_PROJECT"
    tar \
        --exclude='./model' \
        --exclude='./model/*' \
        --exclude='./log' \
        --exclude='./log/*' \
        --exclude='./outputs' \
        --exclude='./outputs/*' \
        --exclude='./del' \
        --exclude='./del/*' \
        --exclude='./__pycache__' \
        --exclude='*/__pycache__' \
        --exclude='*.pyc' \
        --exclude='./.git' \
        -cf - .
) | (cd "$RELEASE_PROJECT" && tar -xf -)

# 增量文件只覆盖新建 release 内的副本，旧生产目录保持不变。
cp -a "$PAYLOAD_ROOT/tailect/." "$RELEASE_PROJECT/"
cp -a "$PAYLOAD_ROOT/wxz" "$RELEASE_ROOT/"
if [[ -d "$PAYLOAD_ROOT/spyware-translator-v4.1" ]]; then
    cp -a "$PAYLOAD_ROOT/spyware-translator-v4.1" "$RELEASE_ROOT/"
fi

ln -s "$MODEL_DIR" "$RELEASE_PROJECT/model"
mkdir -p \
    "$RELEASE_PROJECT/log" \
    "$RELEASE_PROJECT/outputs/api_uploads" \
    "$RELEASE_PROJECT/outputs/fanyin_output"

printf 'Release prepared without changing the old project.\n'
printf 'Old project: %s\n' "$BASE_PROJECT"
printf 'New release: %s\n' "$RELEASE_ROOT"
printf 'Shared models: %s -> %s\n' "$RELEASE_PROJECT/model" "$MODEL_DIR"
printf '\nNext:\n'
printf '  RELEASE_ROOT=%q bash %q\n' "$RELEASE_ROOT" "$RELEASE_ROOT/wxz/migration/preflight_new4_1.sh"
