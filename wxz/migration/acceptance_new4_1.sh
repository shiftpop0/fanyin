#!/usr/bin/env bash
# 严格验收 6006/8885、HTTP URL、ForcedAligner 时间戳和真实多说话人 lid。

set -euo pipefail

RELEASE_ROOT="${RELEASE_ROOT:-/home/gezhi/fanyin/releases/new4.1-20260829}"
TEST_AUDIO_URL="${TEST_AUDIO_URL:-http://1.2.3.4/audio.wav?filename1=xxx.sdp}"
RESULT_ROOT="${RESULT_ROOT:-${RELEASE_ROOT}/tailect/log/acceptance_$(date '+%Y%m%d_%H%M%S')}"
REQUIRE_MULTIPLE_LIDS="${REQUIRE_MULTIPLE_LIDS:-1}"

mkdir -p "$RESULT_ROOT"

curl -fsS http://127.0.0.1:6006/health | tee "$RESULT_ROOT/health_6006.json"
printf '\n'
curl -fsS http://127.0.0.1:8885/health | tee "$RESULT_ROOT/health_8885.json"
printf '\n'

call_platform() {
    local diarize="$1"
    local output_file="$2"
    curl --fail-with-body -sS -X POST \
        "http://127.0.0.1:8885/v1/audiototext?model=Tailect_V4.1&diarize=${diarize}&language=auto&max_chars=40" \
        -H 'Accept: application/json' \
        -F "file=${TEST_AUDIO_URL}" \
        -o "$output_file"
}

call_platform 0 "$RESULT_ROOT/diarize_0.json"
call_platform 1 "$RESULT_ROOT/diarize_1.json"

python3 - "$RESULT_ROOT/diarize_0.json" "$RESULT_ROOT/diarize_1.json" "$REQUIRE_MULTIPLE_LIDS" <<'PY'
import json
import pathlib
import sys

plain_path = pathlib.Path(sys.argv[1])
diar_path = pathlib.Path(sys.argv[2])
require_multiple = sys.argv[3] == "1"

def load_and_validate(path: pathlib.Path):
    payload = json.loads(path.read_text(encoding="utf-8"))
    if payload.get("code") != 200:
        raise SystemExit(f"{path.name}: API code is not 200: {payload}")
    rows = payload.get("data")
    if not isinstance(rows, list) or not rows:
        raise SystemExit(f"{path.name}: no caption rows")
    previous_begin = -1
    for index, row in enumerate(rows):
        begin = row.get("begin")
        end = row.get("end")
        if not isinstance(begin, int) or not isinstance(end, int) or begin < 0 or end <= begin:
            raise SystemExit(f"{path.name}: invalid timestamp at row {index}: {row}")
        if begin < previous_begin:
            raise SystemExit(f"{path.name}: timestamps are not monotonic at row {index}: {row}")
        previous_begin = begin
    return payload, rows

plain_payload, plain_rows = load_and_validate(plain_path)
diar_payload, diar_rows = load_and_validate(diar_path)
for label, payload in (("diarize=0", plain_payload), ("diarize=1", diar_payload)):
    file_name = str(payload.get("file_name") or "")
    if not file_name.lower().endswith(".sdp"):
        raise SystemExit(f"{label}: expected the platform business filename to keep .sdp; got {file_name!r}")
lids = {str(row.get("lid")) for row in diar_rows if row.get("lid") is not None}
if require_multiple and len(lids) < 2:
    raise SystemExit(
        "diarize_1.json: expected at least two distinct lid values; "
        f"got {sorted(lids)}. Use a confirmed two-speaker WAV and verify TargetDiarization logs."
    )

print(f"diarize=0 rows={len(plain_rows)} file_name={plain_payload.get('file_name')}")
print(f"diarize=1 rows={len(diar_rows)} lids={sorted(lids)} file_name={diar_payload.get('file_name')}")
print("ACCEPTANCE PASSED")
PY

printf 'Acceptance artifacts: %s\n' "$RESULT_ROOT"
