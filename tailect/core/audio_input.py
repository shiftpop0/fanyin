"""Bounded uploads and fail-closed, hot-reloaded HTTP(S) WAV input."""

from __future__ import annotations

import ipaddress
import json
import os
import re
import subprocess
import threading
from pathlib import Path
from typing import Any, Dict, Optional, Sequence, Tuple
from urllib.error import HTTPError, URLError
from urllib.parse import parse_qs, unquote, urljoin, urlsplit
from urllib.request import HTTPRedirectHandler, ProxyHandler, Request, build_opener

from core.v1_contract import V1ApiError


CHUNK_SIZE = 1024 * 1024


def _resolve_project_path(value: Any) -> Path:
    path = Path(str(value or "")).expanduser()
    return path.resolve() if path.is_absolute() else (Path.cwd() / path).resolve()


class HotReloadAllowlist:
    """Reload allowlist JSON when mtime changes; invalid files fail closed."""

    def __init__(self, path: Any) -> None:
        self.path = _resolve_project_path(path)
        self._lock = threading.Lock()
        self._mtime_ns: Optional[int] = None
        self._initialized = False
        self._rules: Tuple[str, ...] = ()
        self._error = ""

    def _load_if_changed(self) -> None:
        try:
            stat = self.path.stat()
            mtime_ns: Optional[int] = stat.st_mtime_ns
        except FileNotFoundError:
            mtime_ns = None
        with self._lock:
            if self._initialized and mtime_ns == self._mtime_ns:
                return
            self._initialized = True
            self._mtime_ns = mtime_ns
            if mtime_ns is None:
                self._rules = ()
                self._error = f"allowlist file not found: {self.path}"
                return
            try:
                payload = json.loads(self.path.read_text(encoding="utf-8-sig"))
                raw_rules = payload.get("allow_hosts", []) if isinstance(payload, dict) else payload
                if not isinstance(raw_rules, list):
                    raise ValueError("allow_hosts must be an array")
                rules = tuple(
                    str(item).strip().lower()
                    for item in raw_rules
                    if str(item).strip()
                )
                self._rules = rules
                self._error = ""
            except Exception as exc:
                self._rules = ()
                self._error = f"invalid allowlist: {exc}"

    def rules(self) -> Tuple[str, ...]:
        self._load_if_changed()
        with self._lock:
            return self._rules

    def status(self) -> Dict[str, Any]:
        self._load_if_changed()
        with self._lock:
            return {
                "path": str(self.path),
                "loaded": not bool(self._error),
                "rule_count": len(self._rules),
                "error": self._error,
            }


def audio_url_host_allowed(hostname: str, rules: Sequence[str]) -> bool:
    host = str(hostname or "").strip().lower().rstrip(".")
    if not host or not rules:
        return False
    try:
        host_ip = ipaddress.ip_address(host)
    except ValueError:
        host_ip = None

    for raw_rule in rules:
        rule = str(raw_rule or "").strip().lower().rstrip(".")
        if not rule:
            continue
        if "/" in rule:
            try:
                if host_ip is not None and host_ip in ipaddress.ip_network(rule, strict=False):
                    return True
            except ValueError:
                continue
        if rule.startswith("*."):
            suffix = rule[1:]
            if host.endswith(suffix) and host != suffix[1:]:
                return True
        elif rule.startswith("."):
            if host == rule[1:] or host.endswith(rule):
                return True
        elif host == rule:
            return True
    return False


def validate_audio_url(value: Any, rules: Sequence[str]) -> str:
    text = str(value or "").strip()
    try:
        parsed = urlsplit(text)
    except ValueError as exc:
        raise V1ApiError(f"invalid audio URL: {exc}", "E013") from exc
    if parsed.scheme.lower() not in {"http", "https"}:
        raise V1ApiError("audio URL must use http or https", "E013")
    if parsed.username or parsed.password:
        raise V1ApiError("audio URL credentials are not allowed", "E013")
    if not parsed.hostname or not audio_url_host_allowed(parsed.hostname, rules):
        raise V1ApiError(f"audio URL host is not allowed: {parsed.hostname or ''}", "E013")
    return text


class _SafeRedirectHandler(HTTPRedirectHandler):
    def __init__(self, rules: Sequence[str], max_redirects: int) -> None:
        super().__init__()
        self.rules = tuple(rules)
        self.max_redirects = max(0, int(max_redirects))
        self.redirect_count = 0

    def redirect_request(self, req: Request, fp: Any, code: int, msg: str, headers: Any, newurl: str) -> Any:
        self.redirect_count += 1
        if self.redirect_count > self.max_redirects:
            raise V1ApiError("audio URL redirected too many times", "E014")
        target = validate_audio_url(urljoin(req.full_url, newurl), self.rules)
        return super().redirect_request(req, fp, code, msg, headers, target)


def is_wav_file(path: Path) -> bool:
    try:
        with path.open("rb") as handle:
            header = handle.read(12)
    except OSError:
        return False
    return len(header) >= 12 and header[:4] in {b"RIFF", b"RF64", b"BW64"} and header[8:12] == b"WAVE"


def safe_upload_name(filename: str, request_id: str) -> str:
    name = re.split(r"[\\/]", str(filename or ""))[-1]
    name = re.sub(r'[<>:"/\\|?*\x00-\x1f]', "_", name).strip().rstrip(". ")
    if not name:
        name = f"audio_{request_id}.wav"
    stem, ext = os.path.splitext(name)
    return f"{(stem[:120] or 'audio')}{ext[:16]}"


def validate_upload_filename(filename: str) -> None:
    text = str(filename or "")
    if not text.strip():
        raise V1ApiError("uploaded file has no filename", "E004")
    if "\x00" in text:
        raise V1ApiError("uploaded filename contains invalid characters", "E004")


async def save_upload_limited(upload: Any, target: Path, limit_bytes: int) -> int:
    target.parent.mkdir(parents=True, exist_ok=True)
    total = 0
    with target.open("wb") as handle:
        while True:
            chunk = await upload.read(CHUNK_SIZE)
            if not chunk:
                break
            total += len(chunk)
            if total > int(limit_bytes):
                raise V1ApiError(
                    f"uploaded file is larger than {int(limit_bytes) // 1024 // 1024} MB",
                    "E003",
                )
            handle.write(chunk)
    if total <= 0:
        raise V1ApiError("uploaded file is empty", "E007")
    return total


def normalize_uploaded_audio_path(original_name: str, raw_path: Path) -> Path:
    extension = Path(original_name).suffix.lower()
    wav_content = is_wav_file(raw_path)
    if extension == ".sdp":
        if not wav_content:
            raise V1ApiError(".sdp upload does not contain WAV audio", "E004")
        target = raw_path.with_suffix(".wav")
        raw_path.replace(target)
        return target
    if extension == ".wav" and not wav_content:
        raise V1ApiError("uploaded .wav file has an invalid WAVE header", "E004")
    return raw_path


def ensure_standard_wav(path: Path, timeout_sec: float = 120.0) -> Path:
    """Return a local WAV path, converting non-WAV media without removing its source."""
    if is_wav_file(path):
        return path
    output_path = path.with_name(f"{path.stem}_converted.wav")
    try:
        result = subprocess.run(
            [
                "ffmpeg",
                "-y",
                "-i",
                str(path),
                "-acodec",
                "pcm_s16le",
                "-ar",
                "16000",
                "-ac",
                "1",
                str(output_path),
            ],
            capture_output=True,
            timeout=max(1.0, float(timeout_sec)),
            check=False,
        )
    except FileNotFoundError as exc:
        raise V1ApiError("ffmpeg is required for non-WAV uploads", "E008") from exc
    except subprocess.TimeoutExpired as exc:
        raise V1ApiError("audio conversion timed out", "E008") from exc
    except OSError as exc:
        raise V1ApiError(f"audio conversion failed: {exc}", "E008") from exc
    if result.returncode != 0 or not output_path.exists() or not is_wav_file(output_path):
        detail = result.stderr.decode(errors="replace")[-500:].strip()
        raise V1ApiError(f"audio conversion failed: {detail or 'invalid ffmpeg output'}", "E008")
    return output_path


def _url_display_name(url: str) -> str:
    parsed = urlsplit(url)
    params = parse_qs(parsed.query)
    for key in ("filename1", "filename", "file_name"):
        candidate = str((params.get(key) or [""])[0]).strip()
        if candidate:
            return safe_upload_name(unquote(candidate), "url")
    path_name = unquote(Path(parsed.path).name)
    return safe_upload_name(path_name or "download.wav", "url")


def download_wav_url(
    value: Any,
    target_dir: Path,
    *,
    limit_bytes: int,
    timeout_sec: float,
    max_redirects: int,
    allowlist: HotReloadAllowlist,
) -> Tuple[str, Path]:
    rules = allowlist.rules()
    url = validate_audio_url(value, rules)
    name = _url_display_name(url)
    target_dir.mkdir(parents=True, exist_ok=True)
    target = target_dir / safe_upload_name(name, "url")
    redirect_handler = _SafeRedirectHandler(rules, max_redirects)
    opener = build_opener(ProxyHandler({}), redirect_handler)
    request = Request(url, headers={"User-Agent": "Tailect-V4.1-Offline/1.0", "Accept": "audio/wav,*/*;q=0.1"})
    try:
        with opener.open(request, timeout=max(1.0, float(timeout_sec))) as response:
            content_length = response.headers.get("Content-Length")
            if content_length and int(content_length) > int(limit_bytes):
                raise V1ApiError("audio URL response is too large", "E003")
            total = 0
            with target.open("wb") as handle:
                while True:
                    chunk = response.read(CHUNK_SIZE)
                    if not chunk:
                        break
                    total += len(chunk)
                    if total > int(limit_bytes):
                        raise V1ApiError("audio URL response is too large", "E003")
                    handle.write(chunk)
    except V1ApiError:
        raise
    except (HTTPError, URLError, TimeoutError, OSError, ValueError) as exc:
        raise V1ApiError(f"audio URL download failed: {exc}", "E014") from exc
    if not target.exists() or target.stat().st_size <= 0:
        raise V1ApiError("audio URL returned an empty response", "E014")
    if not is_wav_file(target):
        raise V1ApiError("audio URL response is not WAV audio", "E015")
    # 平台 URL 常用 filename1=xxx.sdp 表示业务文件名，但响应内容仍是 WAV。
    # 保留返回给平台的原始 .sdp 名称，推理侧改用 .wav 后缀，避免下游库按扩展名误判。
    if target.suffix.lower() == ".sdp":
        wav_target = target.with_suffix(".wav")
        target.replace(wav_target)
        target = wav_target
    return name, target
