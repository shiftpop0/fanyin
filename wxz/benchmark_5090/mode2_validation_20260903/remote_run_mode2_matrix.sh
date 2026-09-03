#!/usr/bin/env bash

set -u

TEST_ROOT="/root/fanyin4.1_20260902_130435/mode2_validation_20260903"
AUDIO_ROOT="/root/fanyin4.1_20260902_130435/project/benchmark_5090/prepared/real_continuous_66/audio"
REFERENCE_AUDIO="/root/fanyin4.1_20260902_130435/project/benchmark_5090/reference_audio.wav"
BASE_URL="http://127.0.0.1:16006"
RESULT_ROOT="${TEST_ROOT}/results"
RESPONSE_ROOT="${RESULT_ROOT}/responses"
INPUT_ROOT="${TEST_ROOT}/generated_inputs"

mkdir -p "${RESPONSE_ROOT}" "${RESULT_ROOT}/logs" "${RESULT_ROOT}/metadata" "${INPUT_ROOT}"

date --iso-8601=seconds > "${RESULT_ROOT}/metadata/matrix_started.txt"
nvidia-smi --query-gpu=timestamp,utilization.gpu,memory.used \
  --format=csv,noheader,nounits -l 1 > "${RESULT_ROOT}/metadata/gpu_samples.csv" 2>&1 &
GPU_SAMPLER_PID=$!

finish_run() {
  kill "${GPU_SAMPLER_PID}" 2>/dev/null || true
  wait "${GPU_SAMPLER_PID}" 2>/dev/null || true
  date --iso-8601=seconds > "${RESULT_ROOT}/metadata/matrix_finished.txt"
}
trap finish_run EXIT

record_request() {
  local label="$1"
  local url="$2"
  local audio_path="$3"
  local response_path="${RESPONSE_ROOT}/${label}.json"
  local meta_path="${RESPONSE_ROOT}/${label}.meta"
  local start_path="${RESPONSE_ROOT}/${label}.started"
  local finish_path="${RESPONSE_ROOT}/${label}.finished"

  date --iso-8601=seconds > "${start_path}"
  curl -sS --max-time 900 -X POST "${url}" \
    -F "file=@${audio_path};type=audio/wav" \
    -o "${response_path}" \
    -w '%{http_code} %{time_total} %{size_upload} %{size_download}\n' \
    > "${meta_path}"
  local curl_exit=$?
  date --iso-8601=seconds > "${finish_path}"
  printf '%s\n' "${curl_exit}" > "${RESPONSE_ROOT}/${label}.curl_exit"
  printf '%s %s\n' "${label}" "$(cat "${meta_path}")"
}

declare -a SAMPLE_PATHS=(
  "${AUDIO_ROOT}/002m/real_002m_01.wav"
  "${AUDIO_ROOT}/003m/real_003m_01.wav"
  "${AUDIO_ROOT}/004m/real_004m_01.wav"
  "${AUDIO_ROOT}/005m/real_005m_01.wav"
)

sha256sum "${SAMPLE_PATHS[@]}" > "${RESULT_ROOT}/metadata/problem_samples_sha256.txt"
ffprobe -v error -show_entries format=filename,duration,size \
  -show_entries stream=codec_name,sample_rate,channels,sample_fmt \
  -of json "${SAMPLE_PATHS[0]}" > "${RESULT_ROOT}/metadata/problem_sample_ffprobe.json"

for audio_path in "${SAMPLE_PATHS[@]}"; do
  sample_name="$(basename "${audio_path}" .wav)"
  record_request "${sample_name}_mode2" "${BASE_URL}/asr?mode=2" "${audio_path}"
done

for audio_path in "${SAMPLE_PATHS[@]}"; do
  sample_name="$(basename "${audio_path}" .wav)"
  record_request "${sample_name}_mode1" "${BASE_URL}/asr?mode=1" "${audio_path}"
done

for audio_path in "${SAMPLE_PATHS[@]}"; do
  sample_name="$(basename "${audio_path}" .wav)"
  record_request "${sample_name}_asr_raw" "${BASE_URL}/asr_raw" "${audio_path}"
done

record_request "reference_legacy_diarization_true" \
  "${BASE_URL}/asr?diarization=true" "${REFERENCE_AUDIO}"
record_request "reference_mode1" "${BASE_URL}/asr?mode=1" "${REFERENCE_AUDIO}"
record_request "reference_legacy_default" "${BASE_URL}/asr" "${REFERENCE_AUDIO}"

SILENCE_AUDIO="${INPUT_ROOT}/silence_5s_16k_mono.wav"
REFERENCE_16K_MONO="${INPUT_ROOT}/reference_16k_mono.wav"
REFERENCE_16K_STEREO="${INPUT_ROOT}/reference_16k_stereo.wav"

if [[ ! -e "${SILENCE_AUDIO}" ]]; then
  ffmpeg -nostdin -hide_banner -loglevel error -f lavfi \
    -i anullsrc=r=16000:cl=mono -t 5 -c:a pcm_s16le "${SILENCE_AUDIO}"
fi
if [[ ! -e "${REFERENCE_16K_MONO}" ]]; then
  ffmpeg -nostdin -hide_banner -loglevel error -i "${REFERENCE_AUDIO}" \
    -ar 16000 -ac 1 -c:a pcm_s16le "${REFERENCE_16K_MONO}"
fi
if [[ ! -e "${REFERENCE_16K_STEREO}" ]]; then
  ffmpeg -nostdin -hide_banner -loglevel error -i "${REFERENCE_AUDIO}" \
    -ar 16000 -ac 2 -c:a pcm_s16le "${REFERENCE_16K_STEREO}"
fi

record_request "silence_5s_mode2" "${BASE_URL}/asr?mode=2" "${SILENCE_AUDIO}"
record_request "reference_16k_mono_mode2" "${BASE_URL}/asr?mode=2" "${REFERENCE_16K_MONO}"
record_request "reference_16k_stereo_mode2" "${BASE_URL}/asr?mode=2" "${REFERENCE_16K_STEREO}"

curl -sS --max-time 20 "${BASE_URL}/health" \
  -o "${RESULT_ROOT}/metadata/health_after_matrix.json" \
  -w '%{http_code} %{time_total}\n' > "${RESULT_ROOT}/metadata/health_after_matrix.meta"
