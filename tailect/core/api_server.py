# core/api_server.py
"""
API 服务模块 — FastAPI 应用、路由、服务生命周期、端口管理。
"""

import numpy as np
import os
import signal
import socket
import subprocess
import sys
import tempfile
import time
import traceback
from typing import Any, Dict, Optional

import torch
from fastapi import FastAPI, File, Form, HTTPException, Query, UploadFile
from fastapi.responses import JSONResponse
from fastapi.middleware.cors import CORSMiddleware
import uvicorn

from core.config import CONFIG
from core.logger import logger
from core.inference_engine import UnifiedService, StreamingManager
from core.streaming_session import StreamingSessionManager
from core.audio_processor import safe_remove
from core.v1_router import PlatformApi


# ===================================================================
# 端口管理
# ===================================================================


def find_and_kill_process_on_port(port: int, auto_kill: bool = False) -> bool:
    """检测并终止占用指定端口的进程。"""
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
        try:
            s.bind(("0.0.0.0", port))
            return True
        except OSError:
            pass

    if not auto_kill:
        logger.error("Port %s is occupied and auto_kill is disabled", port)
        return False

    logger.warning("Port %s is occupied, attempting to release...", port)

    pids: list[int] = []
    try:
        result = subprocess.run(
            ["lsof", "-t", f"-i:{port}"],
            capture_output=True,
            text=True,
            timeout=5,
        )
        pid_str = result.stdout.strip()
        if pid_str:
            pids = [int(p) for p in pid_str.split() if p.isdigit()]
            logger.info("Found process(es) on port %s: %s", port, pids)
    except (subprocess.TimeoutExpired, FileNotFoundError, ValueError) as e:
        logger.warning("lsof failed: %s, trying fallback method", e)

    if not pids:
        try:
            result = subprocess.run(
                ["fuser", f"{port}/tcp"],
                capture_output=True,
                text=True,
                timeout=5,
            )
            if result.stdout.strip():
                pids = [int(p) for p in result.stdout.strip().split() if p.isdigit()]
                logger.info("Found process(es) via fuser: %s", pids)
        except (subprocess.TimeoutExpired, FileNotFoundError):
            pass

    if not pids:
        try:
            result = subprocess.run(
                ["netstat", "-tlnp"],
                capture_output=True,
                text=True,
                timeout=5,
            )
            for line in result.stdout.split("\n"):
                if f":{port}" in line and "LISTEN" in line:
                    parts = line.split()
                    for part in parts:
                        if "/" in part and part.split("/")[0].isdigit():
                            pid = int(part.split("/")[0])
                            pids.append(pid)
                            logger.info("Found process via netstat: PID %s", pid)
                            break
        except (subprocess.TimeoutExpired, FileNotFoundError):
            pass

    if not pids:
        logger.warning("Cannot identify process occupying port %s", port)
        return False

    for pid in pids:
        try:
            os.kill(pid, signal.SIGTERM)
            logger.info("Sent SIGTERM to PID %s", pid)
        except ProcessLookupError:
            logger.info("PID %s already gone", pid)
        except PermissionError:
            logger.warning("No permission to kill PID %s", pid)

    wait_seconds = int(CONFIG.get("port_release_wait_seconds", 5))
    for _ in range(wait_seconds * 2):
        time.sleep(0.5)
        with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
            try:
                s.bind(("0.0.0.0", port))
                logger.info("Port %s released after SIGTERM", port)
                return True
            except OSError:
                continue

    logger.warning("Graceful termination failed, sending SIGKILL...")
    for pid in pids:
        try:
            os.kill(pid, signal.SIGKILL)
            logger.info("Sent SIGKILL to PID %s", pid)
        except (ProcessLookupError, PermissionError):
            pass

    time.sleep(1)
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
        try:
            s.bind(("0.0.0.0", port))
            logger.info("Port %s released after SIGKILL", port)
            return True
        except OSError:
            logger.error("Failed to release port %s", port)
            return False


def save_upload_file(upload_file: UploadFile) -> str:
    """保存上传文件到临时路径。"""
    suffix = os.path.splitext(upload_file.filename or "")[1] or ".wav"
    with tempfile.NamedTemporaryFile(delete=False, suffix=suffix) as tmp:
        content = upload_file.file.read()
        tmp.write(content)
        return tmp.name


def ensure_wav_audio(file_path: str) -> str:
    """将非 WAV 音频文件转为 16kHz 单声道 WAV（使用 ffmpeg）。

    如果已经是 .wav 后缀或转换失败，直接返回原路径。
    转换成功后会删除原始文件。
    """
    ext = os.path.splitext(file_path)[1].lower()
    if ext == ".wav":
        return file_path

    output_path = os.path.splitext(file_path)[0] + ".wav"
    try:
        result = subprocess.run(
            [
                "ffmpeg", "-y",
                "-i", file_path,
                "-acodec", "pcm_s16le",
                "-ar", "16000",
                "-ac", "1",
                output_path,
            ],
            capture_output=True,
            timeout=120,
        )
        if result.returncode == 0 and os.path.exists(output_path):
            safe_remove(file_path)
            logger.info("Audio converted: %s -> %s", file_path, output_path)
            return output_path
        logger.warning("ffmpeg convert failed (rc=%s) for %s: %s",
                       result.returncode, file_path, result.stderr.decode(errors="replace"))
    except FileNotFoundError:
        logger.error(
            "ffmpeg not found. 请安装 ffmpeg："
            " apt-get install -y ffmpeg"
            "（容器内），或宿主机直接安装。"
        )
    except Exception as e:
        logger.error("Audio format conversion error for %s: %s", file_path, e)

    return file_path


# ===================================================================
# FastAPI 应用
# ===================================================================

app = FastAPI(title="Unified ASR + Diarization Service")
SERVICE: Optional[UnifiedService] = None
STREAMING_MANAGER: Optional[StreamingManager] = None
SESSION_MANAGER: Optional[StreamingSessionManager] = None


def _get_service() -> Optional[UnifiedService]:
    return SERVICE


PLATFORM_API = PlatformApi(CONFIG, _get_service)
app.include_router(PLATFORM_API.router)
app.add_middleware(
    CORSMiddleware,
    allow_origins=list(CONFIG.get("cors_allowed_origins", ["*"])),
    allow_credentials=False,
    allow_methods=["GET", "POST", "OPTIONS"],
    allow_headers=["*"],
)


@app.on_event("startup")
def _startup() -> None:
    global SERVICE, STREAMING_MANAGER, SESSION_MANAGER
    logger.info("Starting unified service with config: %s", CONFIG)

    # ===== 启动环境检测日志 =====
    gpu_count = torch.cuda.device_count() if torch.cuda.is_available() else 0
    logger.info("=" * 60)
    logger.info("[ENV] CUDA available: %s", torch.cuda.is_available())
    logger.info("[ENV] GPU count: %d", gpu_count)
    if gpu_count > 0:
        for i in range(gpu_count):
            logger.info("[ENV]   GPU %d: %s", i, torch.cuda.get_device_name(i))
        logger.info("[ENV]   Current device: %s", torch.cuda.current_device())
    logger.info("[ENV] ASR device mode: %s", CONFIG.get("asr_device", "N/A"))
    logger.info("[ENV] ASR batch size: %s", CONFIG.get("asr_batch_size", "N/A"))
    logger.info("[ENV] Segment workers: %s", CONFIG.get("segment_workers", "N/A"))
    logger.info("[ENV] Attn implementation: %s", CONFIG.get("asr_attn_implementation", "N/A"))
    logger.info("[ENV] Torch compile enabled: %s", CONFIG.get("asr_use_compile", False))
    logger.info("[ENV] ASR backend: %s", "vLLM" if CONFIG.get("vllm_enabled") else "Transformers")
    logger.info("[ENV] Streaming enabled: %s", CONFIG.get("streaming_enabled", False))
    logger.info("=" * 60)

    SERVICE = UnifiedService(CONFIG)
    logger.info("Unified service initialized successfully")

    # 初始化流式识别（仅 streaming_enabled=True 时加载）
    if CONFIG.get("streaming_enabled", False):
        try:
            logger.info("[STREAM] Initializing streaming manager (vLLM backend)...")
            STREAMING_MANAGER = StreamingManager(CONFIG)
            SESSION_MANAGER = StreamingSessionManager(
                ttl=CONFIG.get("stream_session_ttl", 600),
                cleanup_interval=CONFIG.get("stream_session_cleanup_interval", 300),
            )
            logger.info("[STREAM] Streaming manager initialized")
        except Exception as e:
            logger.error("[STREAM] Failed to initialize streaming manager: %s", e)
            logger.warning("[STREAM] Streaming API will be unavailable")
            STREAMING_MANAGER = None
            SESSION_MANAGER = None
    else:
        logger.info("[STREAM] Streaming disabled by config, streaming API unavailable")


@app.on_event("shutdown")
def _shutdown() -> None:
    global SERVICE, STREAMING_MANAGER, SESSION_MANAGER
    if SERVICE is not None:
        SERVICE.close()
    if SESSION_MANAGER is not None:
        SESSION_MANAGER.shutdown()
    if STREAMING_MANAGER is not None:
        STREAMING_MANAGER.close()
    logger.info("Unified service shutdown completed")


# ===================================================================
# HTTP 路由
# ===================================================================


@app.get("/health")
def health() -> Dict[str, Any]:
    stream_ready = (
        STREAMING_MANAGER is not None
        and SESSION_MANAGER is not None
    )
    diarization_ready = SERVICE is not None and SERVICE.diarization is not None
    forced_aligner_ready = SERVICE is not None and SERVICE.forced_aligner is not None
    punctuation_ready = (
        SERVICE is not None
        and SERVICE.punctuation is not None
        and SERVICE.punctuation.model is not None
    )
    return {
        "status": "ok",
        "model": str(CONFIG.get("model_alias", "Tailect_V4.1")),
        "server": "uvicorn",
        "cuda": bool(torch.cuda.is_available()),
        "service_ready": SERVICE is not None,
        "diarization_ready": diarization_ready,
        "diarization_error": (
            str(SERVICE.diarization_init_error or "") if SERVICE is not None else "service unavailable"
        ),
        "forced_aligner_ready": forced_aligner_ready,
        "punctuation_ready": punctuation_ready,
        "streaming_ready": stream_ready,
        "active_streaming_sessions": (
            SESSION_MANAGER.get_active_count() if SESSION_MANAGER else 0
        ),
        **PLATFORM_API.health(),
    }


@app.post("/diarization")
def diarization_api(file: UploadFile = File(...)) -> Dict[str, Any]:
    if SERVICE is None:
        raise HTTPException(status_code=500, detail="Service is not initialized")

    temp_path = ""
    try:
        temp_path = save_upload_file(file)
        temp_path = ensure_wav_audio(temp_path)
        return SERVICE.diarization_only(temp_path)
    except TimeoutError as e:
        logger.error("Timeout: %s", e)
        raise HTTPException(status_code=504, detail=str(e))
    except Exception as e:
        logger.error("Unhandled diarization exception: %s\n%s", e, traceback.format_exc())
        raise HTTPException(status_code=500, detail=f"Internal error: {e}")
    finally:
        safe_remove(temp_path)


@app.post("/asr_raw")
def asr_raw_api(file: UploadFile = File(...)) -> Dict[str, Any]:
    if SERVICE is None:
        raise HTTPException(status_code=500, detail="Service is not initialized")

    temp_path = ""
    try:
        temp_path = save_upload_file(file)
        temp_path = ensure_wav_audio(temp_path)
        return SERVICE.asr_raw(temp_path)
    except TimeoutError as e:
        logger.error("Timeout: %s", e)
        raise HTTPException(status_code=504, detail=str(e))
    except Exception as e:
        logger.error("Unhandled asr_raw exception: %s\n%s", e, traceback.format_exc())
        raise HTTPException(status_code=500, detail=f"Internal error: {e}")
    finally:
        safe_remove(temp_path)


@app.post("/forced_align")
def forced_align_api(
    text: str = Form(..., description="需要对齐的文本"),
    language: str = Form("Chinese", description="语言名，如 Chinese/English"),
    file: UploadFile = File(...),
) -> Dict[str, Any]:
    if SERVICE is None:
        raise HTTPException(status_code=500, detail="Service is not initialized")

    temp_path = ""
    try:
        temp_path = save_upload_file(file)
        temp_path = ensure_wav_audio(temp_path)
        return SERVICE.forced_align(temp_path, text=text, language=language)
    except TimeoutError as e:
        logger.error("Timeout: %s", e)
        raise HTTPException(status_code=504, detail=str(e))
    except Exception as e:
        logger.error("Unhandled forced_align exception: %s\n%s", e, traceback.format_exc())
        raise HTTPException(status_code=500, detail=f"Internal error: {e}")
    finally:
        safe_remove(temp_path)


@app.post("/asr")
def asr_api(
    diarization: bool = Query(False, description="是否启用说话人区分后分段 ASR"),
    file: UploadFile = File(...),
) -> Dict[str, Any]:
    """兼容旧接口：
    - diarization=false: 等同 /asr_raw
    - diarization=true: 先 diarization 再分段 ASR
    """
    if SERVICE is None:
        raise HTTPException(status_code=500, detail="Service is not initialized")

    temp_path = ""
    try:
        temp_path = save_upload_file(file)
        temp_path = ensure_wav_audio(temp_path)

        if not diarization:
            return SERVICE.asr_raw(temp_path)

        return SERVICE.diarization_then_asr(
            audio_path=temp_path,
            input_filename=file.filename or os.path.basename(temp_path),
        )
    except TimeoutError as e:
        logger.error("Timeout: %s", e)
        raise HTTPException(status_code=504, detail=str(e))
    except HTTPException:
        raise
    except Exception as e:
        logger.error("Unhandled /asr exception: %s\n%s", e, traceback.format_exc())
        raise HTTPException(status_code=500, detail=f"Internal error: {e}")
    finally:
        safe_remove(temp_path)


@app.post("/punctuation")
def punctuation_api(text: str = Form(..., description="需要恢复标点的文本")) -> Dict[str, Any]:
    if SERVICE is None:
        raise HTTPException(status_code=500, detail="Service is not initialized")

    try:
        return SERVICE.restore_punctuation(text)
    except Exception as e:
        logger.error("Punctuation exception: %s", e)
        raise HTTPException(status_code=500, detail=f"Internal error: {e}")


# ===================================================================
# 流式识别 REST 端点（遵循 Qwen3-ASR 官方 REST 模式）
# 使用方式:
#   1. POST /api/stream/start           → { "session_id": "..." }
#   2. POST /api/stream/chunk           → { "language": "...", "text": "..." }
#   3. POST /api/stream/finish          → { "language": "...", "text": "..." }
# ===================================================================


@app.post("/api/stream/start")
def stream_start(
    language: str = Query("", description="强制语言，如 Chinese，留空自动检测"),
) -> Dict[str, Any]:
    """创建流式识别 session，返回 session_id。"""
    if STREAMING_MANAGER is None or SESSION_MANAGER is None:
        raise HTTPException(status_code=503, detail="Streaming service is not available")

    try:
        state = STREAMING_MANAGER.init_session(language=language)
        session_id = SESSION_MANAGER.create(state)
        logger.info("[STREAM] Session created: %s (language=%r)", session_id, language)
        return {"session_id": session_id}
    except Exception as e:
        logger.error("[STREAM] Failed to create session: %s", e)
        raise HTTPException(status_code=500, detail=f"Failed to create session: {e}")


@app.post("/api/stream/chunk")
def stream_chunk(
    session_id: str = Query(..., description="流式 session ID"),
    file: bytes = File(..., description="16kHz mono float32 PCM 音频块（raw bytes）"),
) -> Dict[str, Any]:
    """发送音频块，返回当前识别结果。"""
    if STREAMING_MANAGER is None or SESSION_MANAGER is None:
        raise HTTPException(status_code=503, detail="Streaming service is not available")

    session = SESSION_MANAGER.get(session_id)
    if session is None:
        raise HTTPException(status_code=404, detail=f"Session not found: {session_id}")

    if len(file) % 4 != 0:
        raise HTTPException(status_code=400, detail="Audio data length must be multiple of 4 (float32)")

    try:
        # 解析 float32 PCM bytes → numpy array
        wav = np.frombuffer(file, dtype=np.float32).reshape(-1)
        STREAMING_MANAGER.process_chunk(session.state, wav)
        return {
            "language": session.state.language or "",
            "text": session.state.text or "",
        }
    except Exception as e:
        logger.error("[STREAM] Chunk processing failed (session=%s): %s", session_id, e)
        raise HTTPException(status_code=500, detail=f"Chunk processing failed: {e}")


@app.post("/api/stream/finish")
def stream_finish(
    session_id: str = Query(..., description="流式 session ID"),
) -> Dict[str, Any]:
    """结束流式识别，返回最终结果。"""
    if STREAMING_MANAGER is None or SESSION_MANAGER is None:
        raise HTTPException(status_code=503, detail="Streaming service is not available")

    session = SESSION_MANAGER.get(session_id)
    if session is None:
        raise HTTPException(status_code=404, detail=f"Session not found: {session_id}")

    try:
        STREAMING_MANAGER.finish_session(session.state)
        result = {
            "language": session.state.language or "",
            "text": session.state.text or "",
        }
        SESSION_MANAGER.remove(session_id)
        logger.info(
            "[STREAM] Session finished: %s (len=%d chars)",
            session_id, len(result.get("text", "")),
        )
        return result
    except Exception as e:
        logger.error("[STREAM] Finish failed (session=%s): %s", session_id, e)
        # 即使 finish 失败也清理 session
        SESSION_MANAGER.remove(session_id)
        raise HTTPException(status_code=500, detail=f"Finish failed: {e}")
