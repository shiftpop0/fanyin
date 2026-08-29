"""Authentication, trusted-client resolution and lightweight rate limiting."""

from __future__ import annotations

import hmac
import os
import threading
import time
from collections import defaultdict, deque
from typing import Any, Deque, Dict, Iterable, Mapping

from core.v1_contract import V1ApiError


def configured_api_key(config: Mapping[str, Any]) -> str:
    env_name = str(config.get("v1_api_key_env") or "TAILECT_API_KEY")
    return str(os.environ.get(env_name) or "")


def extract_api_key(headers: Mapping[str, Any], params: Mapping[str, Any]) -> str:
    direct = str(headers.get("x-api-key") or headers.get("X-API-Key") or "").strip()
    if direct:
        return direct
    authorization = str(headers.get("authorization") or headers.get("Authorization") or "").strip()
    if authorization.lower().startswith("bearer "):
        return authorization[7:].strip()
    return str(params.get("api_key") or "").strip()


def authorize(config: Mapping[str, Any], headers: Mapping[str, Any], params: Mapping[str, Any]) -> None:
    expected = configured_api_key(config)
    if not expected:
        return
    actual = extract_api_key(headers, params)
    if not actual or not hmac.compare_digest(actual, expected):
        raise V1ApiError("invalid or missing API key", "E006")


def resolve_client_ip(
    *,
    peer_host: str,
    headers: Mapping[str, Any],
    trusted_proxy_hosts: Iterable[str],
) -> str:
    peer = str(peer_host or "unknown").strip() or "unknown"
    trusted = {str(item).strip() for item in trusted_proxy_hosts}
    if peer in trusted:
        forwarded = str(headers.get("x-forwarded-for") or headers.get("X-Forwarded-For") or "")
        first = forwarded.split(",", 1)[0].strip()
        if first:
            return first
        real_ip = str(headers.get("x-real-ip") or headers.get("X-Real-IP") or "").strip()
        if real_ip:
            return real_ip
    return peer


class RateLimiter:
    def __init__(self, per_minute: int) -> None:
        self.per_minute = max(0, int(per_minute))
        self._lock = threading.Lock()
        self._windows: Dict[str, Deque[float]] = defaultdict(deque)

    def check(self, client_id: str) -> None:
        if self.per_minute <= 0:
            return
        now = time.monotonic()
        cutoff = now - 60.0
        key = str(client_id or "unknown")
        with self._lock:
            window = self._windows[key]
            while window and window[0] <= cutoff:
                window.popleft()
            if len(window) >= self.per_minute:
                raise V1ApiError("rate limit exceeded", "E005")
            window.append(now)
