"""Single-model FIFO adapter from the platform v1 contract to UnifiedService."""

from __future__ import annotations

import asyncio
import os
from contextlib import asynccontextmanager
from typing import Any, AsyncIterator, Dict, Mapping

from core.logger import logger
from core.v1_contract import V1ApiError, build_caption_rows, language_to_v1


class FifoInferenceQueue:
    """One active inference at a time; asyncio.Lock preserves waiter arrival order."""

    def __init__(self, max_waiters: int, timeout_sec: float) -> None:
        self.max_waiters = max(1, int(max_waiters))
        self.timeout_sec = max(1.0, float(timeout_sec))
        self._lock = asyncio.Lock()
        self._waiting = 0
        self._completed = 0

    @asynccontextmanager
    async def slot(self) -> AsyncIterator[None]:
        if self._waiting >= self.max_waiters:
            raise V1ApiError("inference queue is full", "E011")
        self._waiting += 1
        acquired = False
        try:
            try:
                await asyncio.wait_for(self._lock.acquire(), timeout=self.timeout_sec)
                acquired = True
            except asyncio.TimeoutError as exc:
                raise V1ApiError("inference queue wait timed out", "E012") from exc
            yield
            self._completed += 1
        finally:
            self._waiting = max(0, self._waiting - 1)
            if acquired:
                self._lock.release()

    def status(self) -> Dict[str, Any]:
        return {
            "concurrency": 1,
            "busy": self._lock.locked(),
            "waiting": max(0, self._waiting - (1 if self._lock.locked() else 0)),
            "max_waiters": self.max_waiters,
            "completed": self._completed,
        }


def transcribe_platform_audio(
    service: Any,
    audio_path: str,
    *,
    language: str,
    diarize: bool,
    max_chars: int,
    split_by_punctuation: bool,
    config: Mapping[str, Any],
) -> Dict[str, Any]:
    """Run the native ASR pipeline, then adapt it to the platform contract."""
    speakers = []
    detected_language = ""
    if diarize:
        native_result = service.transcribe_diarized_segments(
            audio_path,
            os.path.basename(audio_path),
            allow_diarization_fallback=bool(config.get("v1_diarization_fallback", False)),
        )
        text = str(native_result.get("overall_text") or "").strip()
        speakers = native_result.get("speaker_segments") or []
        language_candidates = [
            str(item or "").strip()
            for item in native_result.get("detected_languages", [])
            if str(item or "").strip()
        ]
        if language_candidates:
            detected_language = max(
                dict.fromkeys(language_candidates),
                key=language_candidates.count,
            )
        pipeline = "diarized_segment_asr"
    else:
        asr_result = service.asr_raw(audio_path)
        text = str(asr_result.get("text") or "").strip()
        detected_language = str(asr_result.get("language") or "").strip()
        pipeline = "whole_audio_asr"

    if not text:
        return {
            "language": language_to_v1(detected_language or language),
            "text": "",
            "rows": [],
        }

    align_language = detected_language or language or str(config.get("v1_default_language") or "Chinese")
    aligned = service.forced_align(audio_path, text=text, language=align_language)
    timestamps = aligned.get("segments") or []

    rows = build_caption_rows(
        full_text=text,
        timestamps=timestamps,
        speaker_segments=speakers,
        max_chars=max_chars,
        split_by_punctuation=split_by_punctuation,
    )
    logger.info(
        "[V1-ASR] pipeline=%s text_len=%s speaker_segments=%s aligned_segments=%s rows=%s language=%s",
        pipeline,
        len(text),
        len(speakers),
        len(timestamps),
        len(rows),
        detected_language or align_language,
    )
    return {
        "language": language_to_v1(detected_language or align_language),
        "text": text,
        "rows": rows,
    }
