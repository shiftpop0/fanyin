#!/usr/bin/env python3
"""流式识别独立测试服务 — 仅加载 vLLM 后端。"""
from __future__ import annotations

import argparse, logging, os, sys, threading, time, uuid
from dataclasses import dataclass
from typing import Any, Dict, Optional

os.environ.setdefault("HF_HUB_OFFLINE", "1")
os.environ.setdefault("TRANSFORMERS_OFFLINE", "1")
os.environ["TQDM_DISABLE"] = "1"

logging.basicConfig(level=logging.INFO, format="%(asctime)s | %(levelname)s | %(message)s")
logger = logging.getLogger("streaming_test")

import numpy as np
from fastapi import FastAPI, HTTPException, Query, Request

# ── 轻量 VAD（零依赖，基于 RMS 能量检测）──
import math as _math
class _VADWrapper:
    def __init__(self, threshold=0.02, sampling_rate=16000,
                 min_silence_ms=1500, max_speech_s=60.0):
        self.sr = sampling_rate
        self.threshold = threshold
        self.min_silence = int(min_silence_ms * sampling_rate / 1000)
        self.max_speech = int(max_speech_s * sampling_rate)
        self._speech = False
        self._silence = 0
        self._total = 0

    def _rms(self, a):
        return float(_math.sqrt(max(1e-12, float(np.mean(np.square(a.astype(np.float64)))))))

    def process_chunk(self, chunk):
        rms = self._rms(chunk)
        n = len(chunk)
        if rms >= self.threshold:
            self._silence = 0
            self._total += n
            if not self._speech:
                self._speech = True; self._total = n
                logger.debug("[VAD] speech_start rms=%.4f", rms)
                return "speech_start"
            if self._total >= self.max_speech:
                logger.info("[VAD] force_flush %.1fs", self._total / self.sr)
                self._reset(); return "force_flush"
            return None
        if self._speech:
            self._silence += n
            if self._silence >= self.min_silence:
                logger.debug("[VAD] speech_end silence=%.1fs", self._silence / self.sr)
                self._reset(); return "speech_end"
        return None

    def is_speech_active(self): return self._speech
    def reset(self): self._reset()
    def _reset(self): self._speech = False; self._silence = 0; self._total = 0

app = FastAPI(title="Tailect Streaming ASR Test")


@dataclass
class Session:
    session_id: str; state: Any; created_at: float; last_seen: float


class SessionManager:
    def __init__(self, ttl: int = 600):
        self._sessions: Dict[str, Session] = {}
        self._lock = threading.Lock()
        self._ttl = ttl
        self._gc_running = True
        threading.Thread(target=self._gc_loop, daemon=True).start()

    def create(self, state: Any) -> str:
        sid = uuid.uuid4().hex; now = time.time()
        with self._lock: self._sessions[sid] = Session(sid, state, now, now)
        return sid

    def get(self, sid: str) -> Optional[Session]:
        with self._lock:
            s = self._sessions.get(sid)
            if s: s.last_seen = time.time()
            return s

    def remove(self, sid: str) -> None:
        with self._lock: self._sessions.pop(sid, None)

    def active_count(self) -> int:
        with self._lock: return len(self._sessions)

    def _gc_loop(self):
        while self._gc_running:
            time.sleep(300)
            dead = [sid for sid, s in list(self._sessions.items()) if time.time() - s.last_seen > self._ttl]
            for sid in dead: self._sessions.pop(sid, None)

    def shutdown(self): self._gc_running = False


# ── 连续流式 Session（透明切换，客户端无感）──
@dataclass
class ContinuousSession:
    """连续流式 session：内部管理多个 ASR state，通过 VAD 自动分段。"""
    session_id: str
    asr_model: Any           # Qwen3ASRModel
    current_state: Any       # 当前 ASRStreamingState
    vad: _VADWrapper          # VAD
    complete_text: str       # 完整历史转录
    segment_index: int       # 已完成的段落数
    chunk_size_sec: float    # chunk 时长
    created_at: float
    last_seen: float
    language: str            # 强制语言

    def finish_current_segment(self):
        """结束当前 ASR 段，追加到 complete_text，初始化新段。"""
        self.asr_model.finish_streaming_transcribe(self.current_state)
        seg_text = self.current_state.text or ""
        if seg_text:
            self.complete_text += seg_text
        self.segment_index += 1
        self.current_state = self.asr_model.init_streaming_state(
            context="", language=self.language if self.language else None,
            unfixed_chunk_num=3, unfixed_token_num=20,
            chunk_size_sec=self.chunk_size_sec,
        )
        self.vad.reset()
        logger.info("[CONT] Segment %d done: %d chars, total=%d chars",
                    self.segment_index, len(seg_text), len(self.complete_text))
        return seg_text


class ContinuousSessionManager:
    """管理 ContinuousSession，含自动 GC。"""
    def __init__(self, ttl: int = 600):
        self._sessions: Dict[str, ContinuousSession] = {}
        self._lock = threading.Lock()
        self._ttl = ttl
        threading.Thread(target=self._gc_loop, daemon=True).start()

    def create(self, session: ContinuousSession) -> str:
        sid = session.session_id
        with self._lock: self._sessions[sid] = session
        return sid

    def get(self, sid: str) -> Optional[ContinuousSession]:
        with self._lock:
            s = self._sessions.get(sid)
            if s: s.last_seen = time.time()
            return s

    def remove(self, sid: str) -> None:
        with self._lock: self._sessions.pop(sid, None)

    def _gc_loop(self):
        while True:
            time.sleep(300)
            now = time.time()
            dead = [sid for sid, s in list(self._sessions.items()) if now - s.last_seen > self._ttl]
            for sid in dead: self._sessions.pop(sid, None)


def create_app(model_path: str, gmu: float, max_tokens: int, max_len: int):
    logger.info("=" * 60)
    logger.info("Loading vLLM... Model=%s gmu=%.2f", model_path, gmu)
    logger.info("=" * 60)
    if not os.path.isdir(model_path):
        logger.error("Model not found: %s", model_path); sys.exit(1)

    from qwen_asr import Qwen3ASRModel
    t0 = time.time()
    model = Qwen3ASRModel.LLM(model=model_path, gpu_memory_utilization=gmu,
                              max_new_tokens=max_tokens, max_model_len=max_len)
    logger.info("vLLM loaded in %.1fs", time.time() - t0)
    mgr = SessionManager(ttl=600)

    @app.get("/health")
    def health():
        return {"status": "ok", "model_loaded": True, "active_sessions": mgr.active_count()}

    @app.post("/api/stream/start")
    def stream_start(language: str = Query("", description="强制语言")):
        state = model.init_streaming_state(
            context="", language=language if language else None,
            unfixed_chunk_num=3, unfixed_token_num=20, chunk_size_sec=1.0)
        sid = mgr.create(state)
        logger.info("[START] session=%s", sid)
        return {"session_id": sid}

    # ⚡ Accept raw binary body (matches Qwen3-ASR official REST pattern)
    @app.post("/api/stream/chunk")
    async def stream_chunk(request: Request, session_id: str = Query(...)):
        body = await request.body()
        session = mgr.get(session_id)
        if session is None: raise HTTPException(404, "Session not found")
        if len(body) % 4 != 0: raise HTTPException(400, "Audio must be float32 bytes")
        try:
            wav = np.frombuffer(body, dtype=np.float32).reshape(-1)
            model.streaming_transcribe(wav, session.state)
            return {"language": session.state.language or "", "text": session.state.text or ""}
        except Exception as e:
            logger.error("[CHUNK] %s", e)
            raise HTTPException(500, f"Chunk error: {e}")

    @app.post("/api/stream/finish")
    def stream_finish(session_id: str = Query(...)):
        session = mgr.get(session_id)
        if session is None: raise HTTPException(404, "Session not found")
        try:
            model.finish_streaming_transcribe(session.state)
            result = {"language": session.state.language or "", "text": session.state.text or ""}
            mgr.remove(session_id)
            logger.info("[FINISH] len=%d", len(result["text"]))
            return result
        except Exception as e:
            mgr.remove(session_id)
            raise HTTPException(500, f"Finish error: {e}")

    # ── Continuous Session Manager ──
    cont_mgr = ContinuousSessionManager(ttl=600)

    @app.post("/api/stream/continuous/start")
    def cont_start(language: str = Query("", description="强制语言")):
        """创建连续流式 session（透明 VAD 分段）。"""
        state = model.init_streaming_state(
            context="", language=language if language else None,
            unfixed_chunk_num=3, unfixed_token_num=20, chunk_size_sec=1.0)
        vad = _VADWrapper(threshold=0.02, sampling_rate=16000,
                         min_silence_ms=1500, max_speech_s=60.0)
        sid = uuid.uuid4().hex
        cs = ContinuousSession(
            session_id=sid, asr_model=model, current_state=state, vad=vad,
            complete_text="", segment_index=0, chunk_size_sec=1.0,
            created_at=time.time(), last_seen=time.time(),
            language=language if language else "",
        )
        cont_mgr.create(cs)
        logger.info("[CONT-START] session=%s", sid)
        return {"session_id": sid}

    @app.post("/api/stream/continuous/chunk")
    async def cont_chunk(request: Request, session_id: str = Query(...)):
        """发送音频块，VAD 自动判断分段，客户端无感知。"""
        body = await request.body()
        cs = cont_mgr.get(session_id)
        if cs is None:
            raise HTTPException(404, "Session not found")
        if len(body) % 4 != 0:
            raise HTTPException(400, "Audio must be float32 bytes")
        try:
            wav = np.frombuffer(body, dtype=np.float32).reshape(-1)
            # 1. VAD 检测
            event = cs.vad.process_chunk(wav)
            # 2. 如果是 speech_start 且之前处于静音状态
            if event == "speech_start":
                logger.debug("[CONT] speech_start")
            # 3. 正常 ASR 推理
            model.streaming_transcribe(wav, cs.current_state)
            # 4. 如果是 speech_end 或 force_flush，自动分段
            if event in ("speech_end", "force_flush"):
                seg_text = cs.finish_current_segment()
                return {
                    "language": cs.current_state.language or "",
                    "text": cs.current_state.text or "",
                    "partial": False,
                    "segment_text": seg_text,
                    "complete_text": cs.complete_text,
                    "segment_index": cs.segment_index,
                }
            # 5. 普通中间结果
            return {
                "language": cs.current_state.language or "",
                "text": cs.current_state.text or "",
                "partial": True,
                "segment_index": cs.segment_index,
            }
        except Exception as e:
            logger.error("[CONT-CHUNK] %s", e)
            raise HTTPException(500, f"Chunk error: {e}")

    @app.post("/api/stream/continuous/finish")
    def cont_finish(session_id: str = Query(...)):
        """结束连续流式识别，返回完整转录。"""
        cs = cont_mgr.get(session_id)
        if cs is None:
            raise HTTPException(404, "Session not found")
        try:
            # finish 当前段
            model.finish_streaming_transcribe(cs.current_state)
            seg_text = cs.current_state.text or ""
            if seg_text:
                cs.complete_text += seg_text
            result = {
                "language": cs.current_state.language or "",
                "text": cs.current_state.text or "",
                "complete_text": cs.complete_text,
                "segment_index": cs.segment_index + 1,
            }
            cont_mgr.remove(session_id)
            logger.info("[CONT-FINISH] session=%s total=%d chars",
                        session_id, len(cs.complete_text))
            return result
        except Exception as e:
            cont_mgr.remove(session_id)
            raise HTTPException(500, f"Finish error: {e}")

    logger.info("Streaming service ready!")
    return app


if __name__ == "__main__":
    p = argparse.ArgumentParser()
    p.add_argument("--model", required=True)
    p.add_argument("--gmu", type=float, default=0.7)
    p.add_argument("--max-tokens", type=int, default=256)
    p.add_argument("--max-len", type=int, default=8192)
    p.add_argument("--port", type=int, default=6007)
    p.add_argument("--host", default="0.0.0.0")
    a = p.parse_args()

    import uvicorn
    app = create_app(a.model, a.gmu, a.max_tokens, a.max_len)
    uvicorn.run(app, host=a.host, port=a.port, log_level="info")
