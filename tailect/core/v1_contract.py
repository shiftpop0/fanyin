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


def _split_text_parts(text: str) -> List[str]:
    return re.findall(r"([^，。！？；：,.!?:; \n]+[，。！？；：,.!?:; \n]*)", str(text or ""))


def _speaker_bounded_parts(
    full_text: str,
    items: Any,
) -> List[Tuple[str, str, bool]]:
    """Return text parts carrying hard speaker boundaries when segment text is available."""
    if not isinstance(items, list):
        return []
    labels: Dict[str, str] = {}
    text_segments: List[Tuple[str, str]] = []
    for item in items:
        if not isinstance(item, dict) or "text" not in item:
            return []
        try:
            start = float(item.get("start", 0.0))
            end = float(item.get("end", 0.0))
        except (TypeError, ValueError):
            return []
        if end <= start:
            return []
        raw = str(item.get("speaker", "unknown"))
        if raw not in labels:
            labels[raw] = str(len(labels) + 1)
        text_segments.append((str(item.get("text") or ""), labels[raw]))

    if not text_segments or "".join(item[0] for item in text_segments).strip() != str(full_text or "").strip():
        return []

    output: List[Tuple[str, str, bool]] = []
    for segment_text, lid in text_segments:
        segment_parts = _split_text_parts(segment_text)
        for index, part in enumerate(segment_parts):
            output.append((part, lid, index == len(segment_parts) - 1))
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
    bounded_parts = _speaker_bounded_parts(text, speaker_segments)
    parts: List[Tuple[str, str, bool]] = bounded_parts or [
        (part, "", False) for part in _split_text_parts(text)
    ]

    normalized_timestamps: List[Tuple[Dict[str, Any], int]] = []
    previous_start = -1.0
    for item in timestamps:
        if not isinstance(item, dict):
            raise V1ApiError("local ForcedAligner returned an invalid timestamp item", "E016")
        try:
            start_sec = float(item.get("start", 0.0))
            end_sec = float(item.get("end", 0.0))
        except (TypeError, ValueError) as exc:
            raise V1ApiError("local ForcedAligner returned a non-numeric timestamp", "E016") from exc
        if start_sec < 0 or end_sec <= start_sec or start_sec < previous_start:
            raise V1ApiError("local ForcedAligner returned invalid or non-monotonic timestamps", "E016")
        previous_start = start_sec
        item_len = _pure_text_len(str(item.get("text", "")))
        if item_len > 0:
            normalized_timestamps.append((item, item_len))
    if not normalized_timestamps:
        raise V1ApiError("local ForcedAligner returned no textual timestamps", "E016")

    rows: List[Dict[str, Any]] = []
    timestamp_index = 0
    timestamp_offset = 0
    current_timestamps: List[Dict[str, Any]] = []
    current_text = ""
    current_lid = ""

    def consume_timestamps(target_len: int) -> List[Dict[str, Any]]:
        nonlocal timestamp_index, timestamp_offset
        remaining = max(0, int(target_len))
        selected: List[Dict[str, Any]] = []
        while remaining > 0:
            if timestamp_index >= len(normalized_timestamps):
                raise V1ApiError("local ForcedAligner did not cover the full transcript", "E016")
            item, item_len = normalized_timestamps[timestamp_index]
            available = item_len - timestamp_offset
            if available <= 0:
                timestamp_index += 1
                timestamp_offset = 0
                continue
            if not selected or selected[-1] is not item:
                selected.append(item)
            consumed = min(remaining, available)
            remaining -= consumed
            timestamp_offset += consumed
            if timestamp_offset >= item_len:
                timestamp_index += 1
                timestamp_offset = 0
        return selected

    def flush() -> None:
        nonlocal current_timestamps, current_text, current_lid
        row_text = current_text.strip()
        if not current_timestamps or not row_text:
            current_timestamps = []
            current_text = ""
            current_lid = ""
            return
        start_sec = float(current_timestamps[0].get("start", 0.0) or 0.0)
        end_sec = float(current_timestamps[-1].get("end", 0.0) or 0.0)
        if end_sec <= start_sec:
            raise V1ApiError("local ForcedAligner produced an empty caption range", "E016")
        rows.append(
            {
                "lid": current_lid or _best_speaker(start_sec, end_sec, speakers),
                "text": row_text,
                "begin": int(round(start_sec * 1000)),
                "end": int(round(end_sec * 1000)),
            }
        )
        current_timestamps = []
        current_text = ""
        current_lid = ""

    for part, forced_lid, hard_boundary in parts:
        target_len = _pure_text_len(part)
        if target_len <= 0:
            current_text += part
            continue
        part_timestamps = consume_timestamps(target_len)
        part_start = float(part_timestamps[0].get("start", 0.0) or 0.0)
        part_end = float(part_timestamps[-1].get("end", 0.0) or 0.0)
        part_lid = forced_lid or _best_speaker(part_start, part_end, speakers)
        if current_timestamps and current_lid and part_lid != current_lid:
            flush()
        current_timestamps.extend(part_timestamps)
        current_text += part
        current_lid = part_lid
        punctuation_end = bool(re.search(r"[，。！？；：,.!?:;\n]\s*$", part))
        length_overflow = _pure_text_len(current_text) >= max(1, int(max_chars))
        if hard_boundary or (split_by_punctuation and punctuation_end) or length_overflow:
            flush()

    if current_timestamps or current_text.strip():
        flush()
    if sum(_pure_text_len(row.get("text", "")) for row in rows) != _pure_text_len(text):
        raise V1ApiError("caption rows did not preserve the full transcript", "E016")
    return rows
