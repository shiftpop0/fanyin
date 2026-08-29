"""Durable CSV synchronization store for the platform userscript API."""

from __future__ import annotations

import csv
import datetime as dt
import hashlib
import io
import json
import os
import re
import sqlite3
import threading
import uuid
from pathlib import Path
from typing import Any, Dict, Mapping, Optional

from core.v1_contract import V1ApiError, parse_bool


def _project_path(value: Any) -> Path:
    path = Path(str(value or "outputs/fanyin_output")).expanduser()
    return path.resolve() if path.is_absolute() else (Path.cwd() / path).resolve()


def sanitize_client_ip(value: Any) -> str:
    text = str(value or "unknown").split(",", 1)[0].strip()
    text = re.sub(r"[^0-9A-Za-z_.-]", "_", text).strip("._-")
    return text[:80] or "unknown"


def safe_csv_filename(value: Any, record_key: str = "") -> str:
    raw = str(value or record_key or f"translator_{uuid.uuid4().hex}")
    name = re.split(r"[\\/]", raw)[-1]
    name = re.sub(r'[<>:"/\\|?*\x00-\x1f]', "_", name)
    name = re.sub(r"\s+", " ", name).strip().rstrip(". ")
    stem = name[:-4] if name.lower().endswith(".csv") else name
    return f"{(stem[:184] or 'translator')}.csv"


def normalize_record_key(value: Any) -> str:
    text = re.sub(r"[\x00-\x1f]+", "", str(value or "")).strip()
    return text[:512] or "record"


def _hash(text: str) -> str:
    value = str(text or "").lstrip("\ufeff")
    return f"sha256:{hashlib.sha256(value.encode('utf-8')).hexdigest()}"


def _row_count(text: str) -> int:
    try:
        rows = list(csv.reader(io.StringIO(str(text or "").lstrip("\ufeff"))))
        return max(0, len([row for row in rows[1:] if any(str(cell).strip() for cell in row)]))
    except csv.Error:
        return max(0, len([line for line in str(text or "").splitlines()[1:] if line.strip()]))


class TranslatorStore:
    """CSV files plus a small SQLite revision index, separated by actual client IP."""

    def __init__(self, root: Any) -> None:
        self.root = _project_path(root)
        self._lock = threading.RLock()

    @property
    def db_path(self) -> Path:
        return self.root / ".state" / "sync_state.sqlite"

    def _client_dir(self, client_ip: str) -> Path:
        path = self.root / sanitize_client_ip(client_ip)
        path.mkdir(parents=True, exist_ok=True)
        return path

    def _connect(self) -> sqlite3.Connection:
        self.db_path.parent.mkdir(parents=True, exist_ok=True)
        conn = sqlite3.connect(str(self.db_path), timeout=30)
        conn.row_factory = sqlite3.Row
        conn.execute(
            """
            CREATE TABLE IF NOT EXISTS records (
                client_ip TEXT NOT NULL, record_key TEXT NOT NULL,
                csv_filename TEXT NOT NULL, server_revision INTEGER NOT NULL,
                server_version_id TEXT NOT NULL, content_hash TEXT NOT NULL,
                row_count INTEGER NOT NULL, canonical_updated_at TEXT NOT NULL,
                last_write_event TEXT NOT NULL, last_client_id TEXT NOT NULL,
                csv_path TEXT NOT NULL,
                PRIMARY KEY (client_ip, record_key, csv_filename)
            )
            """
        )
        conn.execute(
            """
            CREATE TABLE IF NOT EXISTS events (
                event_id TEXT PRIMARY KEY, client_ip TEXT NOT NULL,
                record_key TEXT NOT NULL, csv_filename TEXT NOT NULL,
                write_event TEXT NOT NULL, server_revision INTEGER NOT NULL,
                server_version_id TEXT NOT NULL, content_hash TEXT NOT NULL,
                row_count INTEGER NOT NULL, created_at TEXT NOT NULL,
                client_id TEXT NOT NULL, note TEXT NOT NULL
            )
            """
        )
        conn.commit()
        return conn

    @staticmethod
    def _read(path: Path) -> str:
        if not path.exists():
            return ""
        return path.read_text(encoding="utf-8-sig")

    @staticmethod
    def _write_atomic(path: Path, text: str) -> None:
        path.parent.mkdir(parents=True, exist_ok=True)
        temporary = path.with_name(f".{path.name}.{uuid.uuid4().hex}.tmp")
        temporary.write_text(str(text or "").lstrip("\ufeff"), encoding="utf-8-sig")
        os.replace(temporary, path)

    def _lookup(self, client_ip: str, record_key: str, filename: str) -> Optional[Dict[str, Any]]:
        with self._connect() as conn:
            row = conn.execute(
                "SELECT * FROM records WHERE client_ip=? AND record_key=? AND csv_filename=?",
                (client_ip, record_key, filename),
            ).fetchone()
        return dict(row) if row else None

    def save(self, payload: Mapping[str, Any], client_ip: str) -> Dict[str, Any]:
        ip = sanitize_client_ip(client_ip)
        record_key = normalize_record_key(payload.get("record_key") or payload.get("csv_filename"))
        filename = safe_csv_filename(payload.get("csv_filename") or payload.get("filename"), record_key)
        csv_text = str(payload.get("csv_text") or "")
        write_event = str(payload.get("write_event") or "manual_save")[:120]
        client_id = str(payload.get("client_id") or "")[:120]
        note = str(payload.get("note") or "")[:500]
        path = self._client_dir(ip) / filename
        content_hash = _hash(csv_text)
        rows = _row_count(csv_text)
        now = dt.datetime.now().isoformat(timespec="seconds")
        version_id = str(uuid.uuid4())
        with self._lock:
            self._write_atomic(path, csv_text)
            with self._connect() as conn:
                previous = conn.execute(
                    "SELECT server_revision FROM records WHERE client_ip=? AND record_key=? AND csv_filename=?",
                    (ip, record_key, filename),
                ).fetchone()
                revision = int(previous["server_revision"]) + 1 if previous else 1
                conn.execute(
                    """
                    INSERT INTO records VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                    ON CONFLICT(client_ip, record_key, csv_filename) DO UPDATE SET
                      server_revision=excluded.server_revision,
                      server_version_id=excluded.server_version_id,
                      content_hash=excluded.content_hash, row_count=excluded.row_count,
                      canonical_updated_at=excluded.canonical_updated_at,
                      last_write_event=excluded.last_write_event,
                      last_client_id=excluded.last_client_id, csv_path=excluded.csv_path
                    """,
                    (ip, record_key, filename, revision, version_id, content_hash, rows,
                     now, write_event, client_id, str(path)),
                )
                conn.execute(
                    "INSERT INTO events VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
                    (str(uuid.uuid4()), ip, record_key, filename, write_event, revision,
                     version_id, content_hash, rows, now, client_id, note),
                )
                conn.commit()
        return {
            "code": 200, "status": "saved", "client_ip": ip,
            "record_key": record_key, "csv_filename": filename,
            "csv_path": str(path), "exists": True, "empty": rows <= 0,
            "row_count": rows, "server_revision": revision,
            "server_version_id": version_id, "content_hash": content_hash,
            "updated_at": now,
        }

    def status(self, params: Mapping[str, Any], client_ip: str, include_text: bool = False) -> Dict[str, Any]:
        ip = sanitize_client_ip(client_ip)
        record_key = normalize_record_key(params.get("record_key") or params.get("csv_filename"))
        filename = safe_csv_filename(params.get("filename") or params.get("csv_filename"), record_key)
        path = self._client_dir(ip) / filename
        with self._lock:
            text = self._read(path)
            record = self._lookup(ip, record_key, filename) or {}
        result: Dict[str, Any] = {
            "code": 200, "client_ip": ip, "record_key": record_key,
            "csv_filename": filename, "path": str(path), "exists": path.exists(),
            "empty": _row_count(text) <= 0, "row_count": _row_count(text),
            "server_revision": int(record.get("server_revision") or 0),
            "server_version_id": str(record.get("server_version_id") or ""),
            "content_hash": str(record.get("content_hash") or (_hash(text) if text else "")),
            "updated_at": str(record.get("canonical_updated_at") or ""),
            "last_write_event": str(record.get("last_write_event") or ""),
        }
        if include_text:
            result["csv_text"] = text
        return result

    @staticmethod
    def _apply_correction(csv_text: str, payload: Mapping[str, Any]) -> str:
        reader = csv.DictReader(io.StringIO(str(csv_text or "").lstrip("\ufeff")))
        fieldnames = list(reader.fieldnames or [])
        rows = list(reader)
        english = "segment_no" in fieldnames or "corrected_text" in fieldnames
        names = (
            ("segment_no", "begin_ms", "end_ms", "corrected_text", "is_corrected", "updated_at")
            if english else
            ("分段序号", "开始时间（毫秒）", "结束时间（毫秒）", "修正文本", "是否修正", "更新时间")
        )
        segment_field, begin_field, end_field, corrected_field, flag_field, updated_field = names
        for field in (corrected_field, flag_field, updated_field):
            if field not in fieldnames:
                fieldnames.append(field)
        segment_no = str(payload.get("segment_no") or "").strip()
        begin_ms = str(payload.get("begin_ms") or "").strip()
        end_ms = str(payload.get("end_ms") or "").strip()
        target: Optional[int] = None
        for index, row in enumerate(rows):
            by_number = segment_no and str(row.get(segment_field) or "").strip() == segment_no
            by_time = (begin_ms or end_ms) and (not begin_ms or str(row.get(begin_field) or "").strip() == begin_ms) and (not end_ms or str(row.get(end_field) or "").strip() == end_ms)
            if by_number or by_time:
                target = index
                break
        if target is None and segment_no.isdigit() and 1 <= int(segment_no) <= len(rows):
            target = int(segment_no) - 1
        if target is None:
            raise V1ApiError("feedback target row was not found", "E022")
        rows[target][corrected_field] = str(payload.get("corrected_text") or "")
        rows[target][flag_field] = "1"
        rows[target][updated_field] = dt.datetime.now().isoformat(timespec="seconds")
        output = io.StringIO()
        writer = csv.DictWriter(output, fieldnames=fieldnames, lineterminator="\n")
        writer.writeheader()
        writer.writerows(rows)
        return output.getvalue()

    def feedback(self, payload: Mapping[str, Any], client_ip: str) -> Dict[str, Any]:
        current = self.status(payload, client_ip, include_text=True)
        if not current["exists"]:
            raise V1ApiError("CSV file was not found for feedback update", "E020")
        updated = self._apply_correction(str(current.get("csv_text") or ""), payload)
        saved = self.save(
            {
                "record_key": current["record_key"], "csv_filename": current["csv_filename"],
                "csv_text": updated, "write_event": "correction_submit",
                "client_id": payload.get("client_id") or "", "note": "feedback correction",
            },
            client_ip,
        )
        if parse_bool(payload.get("feedback_history"), False):
            history = self._client_dir(client_ip) / "feedback.jsonl"
            with self._lock, history.open("a", encoding="utf-8") as handle:
                item = {"event_id": str(uuid.uuid4()), "created_at": dt.datetime.now().isoformat(timespec="seconds"), **dict(payload)}
                handle.write(json.dumps(item, ensure_ascii=False) + "\n")
            saved["feedback_history_written"] = True
        else:
            saved["feedback_history_written"] = False
        return saved
