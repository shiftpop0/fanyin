#!/usr/bin/env bash

set -u

TEST_ROOT="/root/fanyin4.1_20260902_130435/mode2_validation_20260903"
AUDIO_ROOT="/root/fanyin4.1_20260902_130435/project/benchmark_5090/prepared/real_continuous_66/audio"
REFERENCE_AUDIO="/root/fanyin4.1_20260902_130435/project/benchmark_5090/reference_audio.wav"
BASE_URL="http://127.0.0.1:16006"
RESULT_ROOT="${TEST_ROOT}/results"
RESPONSE_ROOT="${RESULT_ROOT}/responses"
INPUT_ROOT="${TEST_ROOT}/generated_inputs"

date --iso-8601=seconds > "${RESULT_ROOT}/metadata/extended_started.txt"
nvidia-smi --query-gpu=timestamp,utilization.gpu,memory.used \
  --format=csv,noheader,nounits -l 1 > "${RESULT_ROOT}/metadata/gpu_samples_extended.csv" 2>&1 &
GPU_SAMPLER_PID=$!

finish_run() {
  kill "${GPU_SAMPLER_PID}" 2>/dev/null || true
  wait "${GPU_SAMPLER_PID}" 2>/dev/null || true
  date --iso-8601=seconds > "${RESULT_ROOT}/metadata/extended_finished.txt"
}
trap finish_run EXIT

record_request() {
  local label="$1"
  local audio_path="$2"
  date --iso-8601=seconds > "${RESPONSE_ROOT}/${label}.started"
  curl -sS --max-time 1200 -X POST "${BASE_URL}/asr?mode=2" \
    -F "file=@${audio_path};type=audio/wav" \
    -o "${RESPONSE_ROOT}/${label}.json" \
    -w '%{http_code} %{time_total} %{size_upload} %{size_download}\n' \
    > "${RESPONSE_ROOT}/${label}.meta"
  local curl_exit=$?
  date --iso-8601=seconds > "${RESPONSE_ROOT}/${label}.finished"
  printf '%s\n' "${curl_exit}" > "${RESPONSE_ROOT}/${label}.curl_exit"
  printf '%s %s\n' "${label}" "$(cat "${RESPONSE_ROOT}/${label}.meta")"
}

declare -a EXTENDED_SAMPLES=(
  "${AUDIO_ROOT}/001m/real_001m_01.wav"
  "${AUDIO_ROOT}/010m/real_010m_01.wav"
  "${AUDIO_ROOT}/020m/real_020m_01.wav"
  "${AUDIO_ROOT}/030m/real_030m_01.wav"
)

sha256sum "${EXTENDED_SAMPLES[@]}" > "${RESULT_ROOT}/metadata/extended_samples_sha256.txt"

for audio_path in "${EXTENDED_SAMPLES[@]}"; do
  sample_name="$(basename "${audio_path}" .wav)"
  record_request "${sample_name}_mode2_extended" "${audio_path}"
done

MULTI_SILENCE_AUDIO="${INPUT_ROOT}/reference_twice_with_5s_silence_16k_mono.wav"
if [[ ! -e "${MULTI_SILENCE_AUDIO}" ]]; then
  ffmpeg -nostdin -hide_banner -loglevel error \
    -i "${REFERENCE_AUDIO}" \
    -f lavfi -t 5 -i anullsrc=r=16000:cl=mono \
    -i "${REFERENCE_AUDIO}" \
    -filter_complex \
    '[0:a]aresample=16000,aformat=channel_layouts=mono[first];[1:a]aformat=sample_rates=16000:channel_layouts=mono[silence];[2:a]aresample=16000,aformat=channel_layouts=mono[second];[first][silence][second]concat=n=3:v=0:a=1[out]' \
    -map '[out]' -c:a pcm_s16le "${MULTI_SILENCE_AUDIO}"
fi
ffprobe -v error -show_entries format=filename,duration,size \
  -show_entries stream=codec_name,sample_rate,channels,sample_fmt \
  -of json "${MULTI_SILENCE_AUDIO}" > "${RESULT_ROOT}/metadata/multi_silence_ffprobe.json"
record_request "reference_multi_silence_mode2" "${MULTI_SILENCE_AUDIO}"

curl -sS --max-time 20 "${BASE_URL}/health" \
  -o "${RESULT_ROOT}/metadata/health_after_extended.json" \
  -w '%{http_code} %{time_total}\n' > "${RESULT_ROOT}/metadata/health_after_extended.meta"
