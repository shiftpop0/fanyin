"""Platform v1 response contract and caption-row helpers."""

from __future__ import annotations

import re
import unicodedata
from typing import Any, Dict, Iterable, List, Sequence, Tuple


LANGUAGE_TO_V1 = {
    "chinese": "zh",
    "mandarin": "zh",
    "cantonese": "yue",
    "english": "en",
    "japanese": "ja",
    "korean": "ko",
}

V1_TO_LANGUAGE = {
    "zh": "Chinese",
    "zh-cn": "Chinese",
    "cmn": "Chinese",
    "yue": "Cantonese",
    "en": "English",
    "ja": "Japanese",
    "ko": "Korean",
}


class V1ApiError(Exception):
    """Business error returned inside the stable HTTP-200 v1 envelope."""

    def __init__(self, message: str, error_id: str = "E500") -> None:
        super().__init__(message)
        self.error_id = str(error_id or "E500")

    @property
    def public_message(self) -> str:
        return f"[{self.error_id}] {self}"


def response_body(
    *,
    code: int,
    language: str = "",
    data: Iterable[Dict[str, Any]] = (),
    file_name: str = "",
    message: str = "",
    request_id: str = "",
) -> Dict[str, Any]:
    return {
        "code": int(code),
        "language": str(language or ""),
        "data": list(data),
        "file_name": str(file_name or ""),
        "message": str(message or ""),
        "uuid": str(request_id or ""),
    }


def error_body(exc: Exception, *, request_id: str, file_name: str = "") -> Dict[str, Any]:
    message = exc.public_message if isinstance(exc, V1ApiError) else "[E500] internal inference error"
    return response_body(
        code=500,
        language="",
        data=(),
        file_name=file_name,
        message=message,
        request_id=request_id,
    )


def parse_bool(value: Any, default: bool = False) -> bool:
    if value is None or value == "":
        return bool(default)
    if isinstance(value, bool):
        return value
    text = str(value).strip().lower()
    if text in {"1", "true", "yes", "on", "y"}:
        return True
    if text in {"0", "false", "no", "off", "n"}:
        return False
    return bool(default)


def parse_int(value: Any, default: int, minimum: int, maximum: int) -> int:
    try:
        parsed = int(value)
    except (TypeError, ValueError):
        parsed = int(default)
    return max(int(minimum), min(int(maximum), parsed))


def canonical_model_alias(value: Any) -> str:
    text = str(value or "").strip()
    compact = re.sub(r"[^a-z0-9]+", "", text.lower())
    if compact in {"tailectv41", "v41", "41"}:
        return "Tailect_V4.1"
    return text


def require_model_alias(value: Any, expected: str = "Tailect_V4.1") -> str:
    if not str(value or "").strip():
        raise V1ApiError("missing required parameter: model", "E001")
    alias = canonical_model_alias(value)
    if alias != expected:
        raise V1ApiError(f"unsupported model: {value}; expected {expected}", "E002")
    return alias


def request_language_to_internal(value: Any, default: str = "Chinese") -> str:
    text = str(value or "auto").strip()
    if not text or text.lower() == "auto":
        return str(default or "Chinese")
    return V1_TO_LANGUAGE.get(text.lower(), text)


def language_to_v1(value: Any) -> str:
    text = str(value or "").strip()
    if not text:
        return ""
    first = next((part.strip() for part in text.split(",") if part.strip()), "")
    return LANGUAGE_TO_V1.get(first.lower(), first.lower())


def _pure_text_len(text: str) -> int:
    return sum(
        1
        for character in str(text or "")
        if unicodedata.category(character).startswith(("L", "N"))
    )


def _best_speaker(
    start_sec: float,
    end_sec: float,
    speaker_segments: Sequence[Tuple[float, float, str]],
) -> str:
    if not speaker_segments:
        return "1"
    best_overlap = 0.0
    best_speaker = "1"
    for speaker_start, speaker_end, speaker in speaker_segments:
        overlap = max(0.0, min(end_sec, speaker_end) - max(start_sec, speaker_start))
        if overlap > best_overlap:
            best_overlap = overlap
            best_speaker = speaker
    return best_speaker


def normalize_speaker_segments(items: Any) -> List[Tuple[float, float, str]]:
    labels: Dict[str, str] = {}
    output: List[Tuple[float, float, str]] = []
    if not isinstance(items, list):
        return output
    for item in items:
        if not isinstance(item, dict):
            continue
        try:
            start = float(item.get("start", 0.0))
            end = float(item.get("end", 0.0))
            raw = str(item.get("speaker", "unknown"))
        except (TypeError, ValueError):
            continue
        if end <= start:
            continue
        if raw not in labels:
            labels[raw] = str(len(labels) + 1)
        output.append((start, end, labels[raw]))
    return output


def build_caption_rows(
    *,
    full_text: str,
    timestamps: Sequence[Dict[str, Any]],
    speaker_segments: Any = None,
    max_chars: int = 40,
    split_by_punctuation: bool = True,
) -> List[Dict[str, Any]]:
    text = str(full_text or "").strip()
    if not text:
        return []
    if not timestamps:
        raise V1ApiError("local ForcedAligner returned no timestamps", "E016")

    speakers = normalize_speaker_segments(speaker_segments)
    parts = re.findall(r"([^，。！？；：,.!?:; \n]+[，。！？；：,.!?:; \n]*)", text)
    rows: List[Dict[str, Any]] = []
    timestamp_index = 0
    current_timestamps: List[Dict[str, Any]] = []
    current_text = ""

    def flush() -> None:
        nonlocal current_timestamps, current_text
        row_text = current_text.strip()
        if not current_timestamps or not row_text:
            current_timestamps = []
            current_text = ""
            return
        start_sec = float(current_timestamps[0].get("start", 0.0) or 0.0)
        end_sec = float(current_timestamps[-1].get("end", 0.0) or 0.0)
        if end_sec < start_sec:
            end_sec = start_sec
        rows.append(
            {
                "lid": _best_speaker(start_sec, end_sec, speakers),
                "text": row_text,
                "begin": int(round(start_sec * 1000)),
                "end": int(round(end_sec * 1000)),
            }
        )
        current_timestamps = []
        current_text = ""

    for part in parts:
        target_len = _pure_text_len(part)
        if target_len <= 0:
            current_text += part
            continue
        consumed = 0
        start_index = timestamp_index
        while timestamp_index < len(timestamps) and consumed < target_len:
            consumed += _pure_text_len(str(timestamps[timestamp_index].get("text", "")))
            timestamp_index += 1
        if timestamp_index > start_index:
            current_timestamps.extend(timestamps[start_index:timestamp_index])
        current_text += part
        punctuation_end = bool(re.search(r"[，。！？；：,.!?:;\n]\s*$", part))
        length_overflow = _pure_text_len(current_text) >= max(1, int(max_chars))
        if (split_by_punctuation and punctuation_end) or length_overflow:
            flush()

    if current_timestamps or current_text.strip():
        flush()
    return rows
