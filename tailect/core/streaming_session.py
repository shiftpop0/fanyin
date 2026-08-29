"""
流式会话管理模块 — Session 数据结构与自动 GC。

遵循 Qwen3-ASR 官方 REST 模式：
  POST /api/stream/start   → 创建 session
  POST /api/stream/chunk   → 发送音频块
  POST /api/stream/finish  → 结束流式
"""

from __future__ import annotations

import threading
import time
import uuid
from dataclasses import dataclass
from typing import Any, Dict, Optional

from core.logger import logger


@dataclass
class StreamingSession:
    """单个流式识别会话的状态。"""

    session_id: str
    state: Any  # ASRStreamingState — qwen_asr 的流式状态对象
    created_at: float
    last_seen: float


class StreamingSessionManager:
    """
    全局 session 管理器，线程安全，自动 GC。

    使用内存 dict 存储所有活跃 session，后台线程定期清理过期 session。
    """

    def __init__(self, ttl: int = 600, cleanup_interval: int = 300) -> None:
        """
        Args:
            ttl: Session 过期时间（秒），超时未被访问则自动清理。
            cleanup_interval: 后台清理间隔（秒）。
        """
        self._sessions: Dict[str, StreamingSession] = {}
        self._lock = threading.Lock()
        self._ttl = ttl
        self._cleanup_interval = cleanup_interval
        self._stop_event = threading.Event()
        self._gc_thread = threading.Thread(
            target=self._gc_loop,
            name="streaming-session-gc",
            daemon=True,
        )
        self._gc_thread.start()
        logger.info(
            "[STREAM-SESSION] Session manager started (ttl=%ss, cleanup_interval=%ss)",
            ttl, cleanup_interval,
        )

    def create(self, state: Any) -> str:
        """创建新 session，返回 session_id。"""
        session_id = uuid.uuid4().hex
        now = time.time()
        session = StreamingSession(
            session_id=session_id,
            state=state,
            created_at=now,
            last_seen=now,
        )
        with self._lock:
            self._sessions[session_id] = session
        return session_id

    def get(self, session_id: str) -> Optional[StreamingSession]:
        """获取 session，同时更新 last_seen 时间戳。"""
        with self._lock:
            session = self._sessions.get(session_id)
            if session is not None:
                session.last_seen = time.time()
            return session

    def remove(self, session_id: str) -> None:
        """移除 session。"""
        with self._lock:
            self._sessions.pop(session_id, None)

    def get_active_count(self) -> int:
        """获取当前活跃 session 数量。"""
        with self._lock:
            return len(self._sessions)

    def _gc_loop(self) -> None:
        """后台 GC 线程：定期清理过期 session。"""
        while not self._stop_event.is_set():
            self._stop_event.wait(timeout=self._cleanup_interval)
            if self._stop_event.is_set():
                break
            self._gc()

    def _gc(self) -> None:
        """清理所有超时未访问的 session。"""
        now = time.time()
        deadline = now - self._ttl
        dead_ids: list[str] = []
        with self._lock:
            for sid, session in self._sessions.items():
                if session.last_seen < deadline:
                    dead_ids.append(sid)
            for sid in dead_ids:
                del self._sessions[sid]
        if dead_ids:
            logger.info(
                "[STREAM-SESSION] GC cleaned %d expired session(s) (active=%d)",
                len(dead_ids), len(self._sessions),
            )

    def shutdown(self) -> None:
        """关闭 GC 线程。"""
        self._stop_event.set()
        logger.info("[STREAM-SESSION] Session manager shut down")
