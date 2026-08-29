#!/usr/bin/env bash
# 停止 new4.1 新容器并恢复旧容器；不删除任何容器或文件。

set -euo pipefail

RELEASE_ROOT="${RELEASE_ROOT:-/home/gezhi/fanyin/releases/new4.1-20260829}"
OLD_CONTAINER="${OLD_CONTAINER:-asr_instance_6006}"
DEPLOY_SCRIPT="${RELEASE_ROOT}/wxz/deploy/run_v4_1_single_4090.sh"

[[ -f "$DEPLOY_SCRIPT" ]] || { echo "Deploy script not found: $DEPLOY_SCRIPT" >&2; exit 1; }
docker inspect "$OLD_CONTAINER" >/dev/null 2>&1 \
    || { echo "Old container not found: $OLD_CONTAINER" >&2; exit 1; }

bash "$DEPLOY_SCRIPT" stop

for _ in $(seq 1 30); do
    if command -v ss >/dev/null 2>&1 && ! ss -ltn 2>/dev/null | grep -Eq ':(6006|8885)[[:space:]]'; then
        break
    fi
    sleep 1
done

docker start "$OLD_CONTAINER" >/dev/null
printf 'Old container started: %s\n' "$OLD_CONTAINER"
printf 'No new or old container was deleted.\n'
