#!/usr/bin/env bash
# R9 production acceptance: compare native 6006 diarized ASR text with 8885 v1 text.

set -euo pipefail

RELEASE_ROOT="${RELEASE_ROOT:-/home/gezhi/fanyin/releases/new4.1-20260829}"
TEST_AUDIO_FILE="${TEST_AUDIO_FILE:-}"
SERVER_BASE="${SERVER_BASE:-http://127.0.0.1}"
REQUIRE_MULTIPLE_LIDS="${REQUIRE_MULTIPLE_LIDS:-1}"
RESULT_ROOT="${RESULT_ROOT:-${RELEASE_ROOT}/tailect/log/acceptance_r9_$(date '+%Y%m%d_%H%M%S')}"

[[ -n "$TEST_AUDIO_FILE" ]] || {
    echo "Set TEST_AUDIO_FILE to the confirmed WAV used for both requests." >&2
    exit 1
}
[[ -f "$TEST_AUDIO_FILE" ]] || { echo "Test audio not found: $TEST_AUDIO_FILE" >&2; exit 1; }
[[ -f "$RELEASE_ROOT/tailect/core/audio_input.py" ]] || { echo "Release not found: $RELEASE_ROOT" >&2; exit 1; }

if grep -Eq 'pan=mono|audio channel merge|_mono\.wav|merged .*channels to mono' \
    "$RELEASE_ROOT/tailect/core/audio_input.py"; then
    echo "Rejected R8 server-side downmix logic is still present." >&2
    exit 1
fi
grep -Fq 'def transcribe_diarized_segments(' \
    "$RELEASE_ROOT/tailect/core/inference_engine.py" || {
    echo "R9 shared diarized ASR core is missing." >&2
    exit 1
}
grep -Fq 'service.transcribe_diarized_segments(' \
    "$RELEASE_ROOT/tailect/core/v1_adapter.py" || {
    echo "R9 v1 adapter is not connected to the shared core." >&2
    exit 1
}
grep -Fq 'build_diarized_caption_rows(' \
    "$RELEASE_ROOT/tailect/core/v1_adapter.py" || {
    echo "R9 E016 fix is missing: diarized requests still use global alignment." >&2
    exit 1
}

mkdir -p "$RESULT_ROOT"
curl -fsS "${SERVER_BASE}:6006/health" | tee "$RESULT_ROOT/health_6006.json"
printf '\n'
curl -fsS "${SERVER_BASE}:8885/health" | tee "$RESULT_ROOT/health_8885.json"
printf '\n'

curl -fsS --max-time 1200 -X POST \
    "${SERVER_BASE}:6006/asr?diarization=true" \
    -F "file=@${TEST_AUDIO_FILE};type=audio/wav" \
    -o "$RESULT_ROOT/result_6006.json"

curl -fsS --max-time 1200 -X POST \
    "${SERVER_BASE}:8885/v1/audiototext?model=Tailect_V4.1&diarize=1&language=compatibility-probe-ignored" \
    -F "file=@${TEST_AUDIO_FILE};type=audio/wav" \
    -o "$RESULT_ROOT/result_8885.json"

curl -sS --max-time 30 -X POST \
    "${SERVER_BASE}:8885/v1/audiototext?model=Tailect_V4.1&max_chars=40" \
    -o "$RESULT_ROOT/result_removed_max_chars.json"

python3 - \
    "$RESULT_ROOT/result_6006.json" \
    "$RESULT_ROOT/result_8885.json" \
    "$RESULT_ROOT/result_removed_max_chars.json" \
    "$REQUIRE_MULTIPLE_LIDS" <<'PY'
import json
import pathlib
import sys

native_path = pathlib.Path(sys.argv[1])
platform_path = pathlib.Path(sys.argv[2])
removed_parameter_path = pathlib.Path(sys.argv[3])
require_multiple = sys.argv[4] == "1"
native = json.loads(native_path.read_text(encoding="utf-8-sig"))
platform = json.loads(platform_path.read_text(encoding="utf-8-sig"))
removed_parameter = json.loads(removed_parameter_path.read_text(encoding="utf-8-sig"))

if native.get("diarization_status") != "ok":
    raise SystemExit(f"6006 diarization is not ok: {native.get('diarization_status')}")
if platform.get("code") != 200:
    raise SystemExit(f"8885 business failure: {platform.get('message')}")
if removed_parameter.get("code") != 500 or "[E017]" not in str(removed_parameter.get("message") or ""):
    raise SystemExit(f"8885 did not explicitly reject removed max_chars: {removed_parameter}")

native_text = str(native.get("overall_text") or "").strip()
rows = platform.get("data") or []
platform_text = "".join(str(row.get("text") or "") for row in rows).strip()
if not native_text:
    raise SystemExit("6006 returned empty overall_text")
if native_text != platform_text:
    raise SystemExit(
        "R9 parity failure: 8885 text is not identical to native 6006 text\n"
        f"6006={native_text}\n8885={platform_text}"
    )

speaker_ids = {}
expected_rows = []
for segment in native.get("speaker_segments") or []:
    text = str(segment.get("text") or "")
    if not text.strip():
        continue
    speaker = str(segment.get("speaker") or "")
    if speaker not in speaker_ids:
        speaker_ids[speaker] = str(len(speaker_ids) + 1)
    expected_rows.append(
        {
            "lid": speaker_ids[speaker],
            "text": text,
            "begin": int(round(float(segment["start"]) * 1000)),
            "end": int(round(float(segment["end"]) * 1000)),
        }
    )

if rows != expected_rows:
    raise SystemExit(
        "R9 native-segment failure: 8885 rows are not the exact 6006 "
        "speaker_segments conversion\n"
        f"expected={expected_rows}\nactual={rows}"
    )

previous_begin = -1
lids = set()
for index, row in enumerate(rows):
    begin = row.get("begin")
    end = row.get("end")
    lid = str(row.get("lid") or "")
    if not isinstance(begin, int) or not isinstance(end, int) or begin < 0 or end <= begin:
        raise SystemExit(f"8885 invalid timestamp at row {index}: {row}")
    if begin < previous_begin:
        raise SystemExit(f"8885 non-monotonic timestamp at row {index}: {row}")
    previous_begin = begin
    if lid:
        lids.add(lid)

if require_multiple and len(lids) < 2:
    raise SystemExit(f"expected at least two 8885 lids, got {sorted(lids)}")
if lids and sorted(lids, key=int) != [str(index) for index in range(1, len(lids) + 1)]:
    raise SystemExit(f"8885 lids are not continuous from 1: {sorted(lids)}")

native_speakers = int(native.get("speaker_count") or 0)
print(
    "R9 API parity passed: "
    f"chars={len(native_text)} rows={len(rows)} "
    f"native_speakers={native_speakers} lids={sorted(lids)} "
    "language_ignored=yes max_chars_rejected=E017"
)
PY

printf 'R9 acceptance output retained at: %s\n' "$RESULT_ROOT"
