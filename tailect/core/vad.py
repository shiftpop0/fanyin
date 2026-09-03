# core/vad.py
"""
语音活动检测 (VAD) 模块 — 基于音频能量 (RMS) 的轻量实现。
零外部依赖，仅需 numpy。

用于长时流式识别中的自动语音分段：
  1. speech_start → 开始 ASR session
  2. speech_end   → 静音 >= 1.5s，自动 finish + 新 session
  3. force_flush  → 连续说话 > 60s 无停顿，强制 reset
"""

from __future__ import annotations

import logging
import math
import concurrent.futures
import threading
from typing import Any, Dict, List, Optional, Literal

import numpy as np

logger = logging.getLogger("vad")
service_logger = logging.getLogger("unified_asr_diarization")


class VADWrapper:
    """
    基于 RMS 能量的语音活动检测。

    使用方式:
      vad = VADWrapper()
      for chunk in audio_stream:
          event = vad.process_chunk(chunk)
          if event: handle_event(event)
    """

    def __init__(
        self,
        threshold: float = 0.02,
        sampling_rate: int = 16000,
        min_silence_duration_ms: int = 1500,
        max_speech_duration_s: float = 60.0,
    ):
        """
        Args:
            threshold: RMS 能量阈值 (0~1)。值越小越灵敏。
                      安静环境 0.01，正常说话 0.02~0.05，嘈杂环境 0.1。
            sampling_rate: 音频采样率。
            min_silence_duration_ms: 静音持续多少毫秒后认为一句话说完。
            max_speech_duration_s: 一段语音最长多少秒，超时强制 reset。
        """
        self.sampling_rate = sampling_rate
        self.threshold = threshold
        self.min_silence_samples = int(min_silence_duration_ms * sampling_rate / 1000)
        self.max_speech_samples = int(max_speech_duration_s * sampling_rate)
        self._min_silence_duration_s = min_silence_duration_ms / 1000.0

        # 状态
        self._speech_active = False
        self._silence_samples = 0  # 当前静音累积样本数
        self._total_speech_samples = 0  # 当前段累计语音样本数

    @staticmethod
    def _calc_rms(audio: np.ndarray) -> float:
        """计算音频块的 RMS 能量。"""
        if len(audio) == 0:
            return 0.0
        return float(math.sqrt(np.mean(np.square(audio.astype(np.float64)))))

    def process_chunk(
        self, chunk_16k: np.ndarray
    ) -> Optional[Literal["speech_start", "speech_end", "force_flush"]]:
        """
        处理一段 16kHz float32 音频块，返回检测到的事件。

        Returns:
            "speech_start" — 语音开始
            "speech_end"   — 语音结束(静音 >= min_silence_duration_ms)
            "force_flush"  — 超时强制结束
            None           — 无事件
        """
        rms = self._calc_rms(chunk_16k)
        chunk_samples = len(chunk_16k)

        is_speech = rms >= self.threshold

        if is_speech:
            # 有声音
            self._silence_samples = 0
            self._total_speech_samples += chunk_samples

            if not self._speech_active:
                # 语音开始
                self._speech_active = True
                self._total_speech_samples = chunk_samples
                logger.debug("[VAD] speech_start (rms=%.4f)", rms)
                return "speech_start"

            # 检查是否超时
            if self._total_speech_samples >= self.max_speech_samples:
                logger.info("[VAD] force_flush after %.1fs", self._total_speech_samples / self.sampling_rate)
                self._reset_internal()
                return "force_flush"

            return None

        # 静音
        if self._speech_active:
            self._silence_samples += chunk_samples
            if self._silence_samples >= self.min_silence_samples:
                logger.debug("[VAD] speech_end (silence=%.1fs)", self._silence_samples / self.sampling_rate)
                self._reset_internal()
                return "speech_end"

        return None

    def is_speech_active(self) -> bool:
        """当前是否在语音中。"""
        return self._speech_active

    def reset(self):
        """重置 VAD 状态（新会话时调用）。"""
        self._reset_internal()

    def _reset_internal(self):
        self._speech_active = False
        self._silence_samples = 0
        self._total_speech_samples = 0


def normalize_offline_vad_segments(
    raw_result: Any,
    *,
    audio_duration_seconds: float,
    min_segment_seconds: float = 0.0,
    max_segment_seconds: float = 60.0,
) -> List[Dict[str, float]]:
    """将 FunASR FSMN VAD 的毫秒区间转换为有序、无重叠的秒区间。"""
    duration = max(0.0, float(audio_duration_seconds))
    if duration <= 0:
        return []

    value: Any = None
    if isinstance(raw_result, dict):
        value = raw_result.get("value")
    elif isinstance(raw_result, list):
        if not raw_result:
            return []
        first = raw_result[0]
        if isinstance(first, dict):
            value = first.get("value")
        elif isinstance(first, (list, tuple)):
            value = raw_result

    if value is None:
        raise RuntimeError("Independent VAD returned an unsupported result structure")
    if not isinstance(value, (list, tuple)):
        raise RuntimeError("Independent VAD result 'value' must be a list")

    candidates: List[tuple[float, float]] = []
    invalid_count = 0
    for item in value:
        if not isinstance(item, (list, tuple)) or len(item) < 2:
            invalid_count += 1
            continue
        try:
            start_seconds = float(item[0]) / 1000.0
            end_seconds = float(item[1]) / 1000.0
        except (TypeError, ValueError, OverflowError):
            invalid_count += 1
            continue
        if not math.isfinite(start_seconds) or not math.isfinite(end_seconds):
            invalid_count += 1
            continue
        start_seconds = min(duration, max(0.0, start_seconds))
        end_seconds = min(duration, max(0.0, end_seconds))
        if end_seconds <= start_seconds:
            invalid_count += 1
            continue
        candidates.append((start_seconds, end_seconds))

    candidates.sort(key=lambda item: (item[0], item[1]))
    minimum = max(0.0, float(min_segment_seconds))
    maximum = float(max_segment_seconds)
    output: List[Dict[str, float]] = []
    previous_end = 0.0

    for raw_start, raw_end in candidates:
        # VAD 正常情况下不应重叠；若发生重叠，只保留尚未处理的时间范围，
        # 防止同一音频被重复送入 ASR。
        start_seconds = max(raw_start, previous_end)
        end_seconds = raw_end
        if end_seconds <= start_seconds:
            invalid_count += 1
            continue

        chunk_start = start_seconds
        while chunk_start < end_seconds:
            chunk_end = end_seconds
            if maximum > 0:
                chunk_end = min(chunk_end, chunk_start + maximum)
            if chunk_end - chunk_start >= minimum:
                rounded_start = round(chunk_start, 3)
                rounded_end = round(chunk_end, 3)
                if rounded_end > rounded_start:
                    output.append(
                        {
                            "start": rounded_start,
                            "end": rounded_end,
                            "type": "single",
                        }
                    )
            chunk_start = chunk_end
        previous_end = max(previous_end, end_seconds)

    if invalid_count:
        service_logger.warning(
            "[VAD] Ignored or clipped %s invalid/overlapping segment(s)",
            invalid_count,
        )
    return output


class OfflineVADWrapper:
    """mode=2 独立离线 FSMN VAD；不依赖 TargetDiarization。"""

    def __init__(
        self,
        model_path: str,
        device: str,
        timeout_seconds: float,
        *,
        min_segment_seconds: float = 0.0,
        max_segment_seconds: float = 60.0,
        model: Any = None,
    ) -> None:
        self.model_path = model_path
        self.device = str(device)
        self.timeout_seconds = max(1.0, float(timeout_seconds))
        self.min_segment_seconds = max(0.0, float(min_segment_seconds))
        self.max_segment_seconds = float(max_segment_seconds)
        self._inference_lock = threading.Lock()
        if model is None:
            # 延迟导入使流式 RMS VAD 保持零模型依赖，也便于独立单元测试。
            from core.model_loader import load_vad_model

            model = load_vad_model(model_path, self.device)
        self.model = model

    def _generate(self, audio_data: np.ndarray) -> Any:
        if self.model is None:
            raise RuntimeError("Independent VAD model is not loaded")
        with self._inference_lock:
            try:
                return self.model.generate(input=audio_data, cache={})
            except TypeError:
                # 兼容不接受 cache 参数的 FunASR AutoModel 版本。
                return self.model.generate(input=audio_data)

    def detect(self, audio_data: np.ndarray, sampling_rate: int) -> List[Dict[str, float]]:
        if int(sampling_rate) != 16000:
            raise RuntimeError(
                f"Independent VAD requires 16000 Hz audio, got {int(sampling_rate)} Hz"
            )
        audio = np.ascontiguousarray(np.asarray(audio_data, dtype=np.float32).reshape(-1))
        duration = float(len(audio) / sampling_rate) if sampling_rate > 0 else 0.0
        if duration <= 0:
            return []

        executor = concurrent.futures.ThreadPoolExecutor(max_workers=1)
        future = executor.submit(self._generate, audio)
        try:
            raw_result = future.result(timeout=self.timeout_seconds)
        except concurrent.futures.TimeoutError as exc:
            future.cancel()
            raise TimeoutError(
                f"Independent VAD timeout after {self.timeout_seconds:g}s"
            ) from exc
        finally:
            executor.shutdown(wait=False, cancel_futures=True)

        segments = normalize_offline_vad_segments(
            raw_result,
            audio_duration_seconds=duration,
            min_segment_seconds=self.min_segment_seconds,
            max_segment_seconds=self.max_segment_seconds,
        )
        service_logger.info(
            "[VAD] Independent detection completed: duration=%.3fs segments=%s speech=%.3fs",
            duration,
            len(segments),
            sum(item["end"] - item["start"] for item in segments),
        )
        return segments

    def close(self) -> None:
        self.model = None
