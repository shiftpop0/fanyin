#!/usr/bin/env python3

from __future__ import annotations

import csv
import difflib
import hashlib
import json
import sys
from pathlib import Path
from typing import Any


def load_json(path: Path) -> tuple[dict[str, Any] | None, str]:
    try:
        value = json.loads(path.read_text(encoding="utf-8"))
    except Exception as exc:
        return None, str(exc)
    return (value if isinstance(value, dict) else None), ""


def parse_meta(path: Path) -> tuple[int | None, float | None, int | None, int | None]:
    try:
        parts = path.read_text(encoding="utf-8").strip().split()
        return int(parts[0]), float(parts[1]), int(float(parts[2])), int(float(parts[3]))
    except Exception:
        return None, None, None, None


def summarize_response(path: Path) -> dict[str, Any]:
    label = path.stem
    data, parse_error = load_json(path)
    http_code, elapsed, upload_size, download_size = parse_meta(path.with_suffix(".meta"))
    row: dict[str, Any] = {
        "label": label,
        "http_code": http_code,
        "elapsed_seconds": elapsed,
        "upload_bytes": upload_size,
        "download_bytes": download_size,
        "json_parse_error": parse_error,
        "mode": None,
        "business_status": "",
        "text_length": 0,
        "text_sha256": "",
        "segment_count": None,
        "completed_segment_count": None,
        "empty_segment_count": None,
        "overall_matches_segment_join": None,
        "input_duration_seconds": None,
        "vad_speech_duration_seconds": None,
        "first_start": None,
        "last_end": None,
        "tail_gap_seconds": None,
        "max_segment_seconds": None,
        "max_gap_seconds": None,
        "timeline_valid": None,
        "has_speaker_field": None,
        "detected_languages": "",
        "request_id": "",
        "detail": "",
    }
    if not data:
        return row

    row["mode"] = data.get("mode")
    row["business_status"] = data.get("segmentation_status") or data.get("diarization_status") or ""
    row["detail"] = str(data.get("detail") or "")
    text = str(data.get("overall_text") if "overall_text" in data else data.get("text") or "")
    row["text_length"] = len(text)
    row["text_sha256"] = hashlib.sha256(text.encode("utf-8")).hexdigest()
    row["request_id"] = str(data.get("request_id") or "")
    languages = data.get("detected_languages")
    if isinstance(languages, list):
        row["detected_languages"] = ",".join(sorted({str(item) for item in languages if item}))
    elif data.get("language"):
        row["detected_languages"] = str(data["language"])

    segments = data.get("segments")
    if not isinstance(segments, list):
        segments = data.get("speaker_segments")
    if isinstance(segments, list):
        row["segment_count"] = data.get("segment_count", len(segments))
        row["completed_segment_count"] = data.get("completed_segment_count", len(segments))
        row["has_speaker_field"] = any(isinstance(item, dict) and "speaker" in item for item in segments)
        row["empty_segment_count"] = sum(
            1 for item in segments if isinstance(item, dict) and not str(item.get("text") or "")
        )
        joined_text = "".join(
            str(item.get("text") or "") for item in segments if isinstance(item, dict)
        )
        row["overall_matches_segment_join"] = joined_text == text
        valid = True
        previous_end = 0.0
        maximum_segment = 0.0
        maximum_gap = 0.0
        for item in segments:
            if not isinstance(item, dict):
                valid = False
                continue
            try:
                start = float(item["start"])
                end = float(item["end"])
            except Exception:
                valid = False
                continue
            if start < 0 or end <= start or start < previous_end:
                valid = False
            maximum_segment = max(maximum_segment, end - start)
            maximum_gap = max(maximum_gap, start - previous_end)
            previous_end = max(previous_end, end)
        row["timeline_valid"] = valid
        row["max_segment_seconds"] = round(maximum_segment, 3)
        row["max_gap_seconds"] = round(maximum_gap, 3)
        if segments:
            row["first_start"] = segments[0].get("start")
            row["last_end"] = segments[-1].get("end")

    row["input_duration_seconds"] = data.get("input_duration_seconds")
    row["vad_speech_duration_seconds"] = data.get("vad_speech_duration_seconds")
    if row["input_duration_seconds"] is not None and row["last_end"] is not None:
        row["tail_gap_seconds"] = round(
            float(row["input_duration_seconds"]) - float(row["last_end"]),
            3,
        )
    return row


def main() -> int:
    result_root = Path(sys.argv[1]).resolve()
    response_root = result_root / "responses"
    rows = [summarize_response(path) for path in sorted(response_root.glob("*.json"))]

    json_path = result_root / "matrix_summary.json"
    csv_path = result_root / "matrix_summary.csv"
    json_path.write_text(json.dumps(rows, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    with csv_path.open("w", encoding="utf-8-sig", newline="") as handle:
        writer = csv.DictWriter(handle, fieldnames=list(rows[0]) if rows else ["label"])
        writer.writeheader()
        writer.writerows(rows)

    comparisons: list[dict[str, Any]] = []
    by_label = {row["label"]: row for row in rows}
    for minutes in ("002m", "003m", "004m", "005m"):
        prefix = f"real_{minutes}_01"
        mode2 = by_label.get(f"{prefix}_mode2", {})
        mode1 = by_label.get(f"{prefix}_mode1", {})
        raw = by_label.get(f"{prefix}_asr_raw", {})
        raw_len = int(raw.get("text_length") or 0)
        mode2_len = int(mode2.get("text_length") or 0)
        mode2_data, _ = load_json(response_root / f"{prefix}_mode2.json")
        mode1_data, _ = load_json(response_root / f"{prefix}_mode1.json")
        mode2_text = str((mode2_data or {}).get("overall_text") or "")
        mode1_text = str((mode1_data or {}).get("overall_text") or "")
        comparisons.append(
            {
                "sample": prefix,
                "mode2_http": mode2.get("http_code"),
                "mode2_text_length": mode2_len,
                "mode2_segments": mode2.get("segment_count"),
                "mode2_completed": mode2.get("completed_segment_count"),
                "mode2_last_end": mode2.get("last_end"),
                "mode2_duration": mode2.get("input_duration_seconds"),
                "mode2_has_speaker": mode2.get("has_speaker_field"),
                "mode2_empty_segments": mode2.get("empty_segment_count"),
                "mode2_overall_matches_join": mode2.get("overall_matches_segment_join"),
                "mode1_http": mode1.get("http_code"),
                "mode1_text_length": mode1.get("text_length"),
                "mode1_last_end": mode1.get("last_end"),
                "mode2_to_mode1_length_ratio": round(mode2_len / len(mode1_text), 3) if mode1_text else None,
                "mode2_mode1_sequence_similarity": round(
                    difflib.SequenceMatcher(None, mode2_text, mode1_text, autojunk=False).ratio(),
                    4,
                ) if mode2_text and mode1_text else None,
                "raw_http": raw.get("http_code"),
                "raw_text_length": raw_len,
                "mode2_to_raw_length_ratio": round(mode2_len / raw_len, 3) if raw_len else None,
            }
        )
    (result_root / "problem_samples_comparison.json").write_text(
        json.dumps(comparisons, ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
    )
    print(json.dumps(comparisons, ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
