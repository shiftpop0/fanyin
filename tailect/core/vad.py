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
from typing import Optional, Literal

import numpy as np

logger = logging.getLogger("vad")


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
