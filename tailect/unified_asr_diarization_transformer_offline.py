#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
独立 FastAPI 服务：单进程内直接加载 ASR、说话人区分、强制对齐模型。
不依赖外部 API 进程，模型常驻内存，算法可通过 HTTP 进行无状态调用。

注意：本文件为重构后的薄封装层，核心逻辑已移至 core/ 子模块。
"""

from __future__ import annotations

import os
import sys

# ===================================================================
# 环境稳定性设置：必须在所有模型导入之前设置
# ===================================================================
os.environ.setdefault("TRANSFORMERS_NO_TF", "1")
os.environ.setdefault("USE_TF", "0")
os.environ.setdefault("USE_TORCH", "1")
os.environ.setdefault("OMP_NUM_THREADS", "1")
# 强制离线：禁止 HuggingFace / ModelScope 联网下载
os.environ.setdefault("HF_HUB_OFFLINE", "1")
os.environ.setdefault("TRANSFORMERS_OFFLINE", "1")
# 禁用 tqdm 进度条（避免在 Docker 日志中阻塞）
os.environ["TQDM_DISABLE"] = "1"

# ===================================================================
# 压制无害的第三方警告
# ===================================================================
import warnings
# pyannote 在 import 时会检测 torchcodec，无 FFmpeg 环境时发出 UserWarning
# 但服务使用内存音频加载，完全不受影响，故压制
warnings.filterwarnings("ignore", message="torchcodec is not installed correctly")
warnings.filterwarnings("ignore", message=".*libtorchcodec.*")
# 对 pyannote.audio.core.io 模块直接压制所有 UserWarning（模块级别检测）
warnings.filterwarnings("ignore", category=UserWarning, module="pyannote.audio.core.io")

# 需要先加载 CONFIG 以读取 disable_flash_attn
from core.config import CONFIG, get_config

if CONFIG.get("disable_flash_attn", True):
    os.environ.setdefault("DISABLE_FLASH_ATTN", "1")

# ===================================================================
# Monkey patches（必须在 transformers 等库导入前执行）
# ===================================================================
from core.model_loader import patch_mistral_tokenizer

patch_mistral_tokenizer()

# ===================================================================
# 重新导出所有核心接口（保持 100% 向后兼容）
# ===================================================================
from core.logger import logger
from core.device_utils import resolve_device, resolve_dtype
from core.model_loader import (
    load_asr_model,
    load_diarization_model,
    load_forced_aligner,
    load_punctuation_model,
    install_numpy_compat_shim,
    install_torchaudio_compat_shim,
)
from core.audio_processor import safe_remove, clip_audio, format_wall_time
from core.inference_engine import (
    ASRWrapper,
    DiarizationWrapper,
    ForcedAlignWrapper,
    PunctuationRestorer,
    UnifiedService,
    StreamingManager,
    resolve_diarization_project_path as _resolve_diarization_project_path,
    summarize_segment_timings as _summarize_segment_timings,
    transcribe_with_retry as _transcribe_with_retry,
)
from core.streaming_session import StreamingSessionManager, StreamingSession
from core.api_server import (
    app,
    find_and_kill_process_on_port,
    save_upload_file,
    SERVICE,
    STREAMING_MANAGER,
    SESSION_MANAGER,
    _startup,
    _shutdown,
    health,
    diarization_api,
    asr_raw_api,
    forced_align_api,
    asr_api,
    punctuation_api,
    stream_start,
    stream_chunk,
    stream_finish,
)

__all__ = [
    "CONFIG", "get_config", "logger",
    "resolve_device", "resolve_dtype",
    "load_asr_model", "load_diarization_model", "load_forced_aligner",
    "load_punctuation_model", "install_numpy_compat_shim", "install_torchaudio_compat_shim",
    "save_upload_file", "safe_remove", "clip_audio", "format_wall_time",
    "ASRWrapper", "DiarizationWrapper", "ForcedAlignWrapper",
    "PunctuationRestorer", "UnifiedService", "StreamingManager",
    "StreamingSessionManager", "StreamingSession",
    "app", "find_and_kill_process_on_port", "SERVICE",
    "STREAMING_MANAGER", "SESSION_MANAGER",
    "_startup", "_shutdown",
    "health", "diarization_api", "asr_raw_api", "forced_align_api",
    "asr_api", "punctuation_api",
    "stream_start", "stream_chunk", "stream_finish",
]

# ===================================================================
# 程序入口（支持 --port / --host 命令行参数）
# ===================================================================
if __name__ == "__main__":
    import argparse
    import uvicorn

    parser = argparse.ArgumentParser(description="Tailect ASR Offline Service")
    parser.add_argument("--port", type=int, default=None, help="服务端口（默认从 CONFIG 读取）")
    parser.add_argument("--host", type=str, default=None, help="监听地址（默认从 CONFIG 读取）")
    args, _ = parser.parse_known_args()

    host = str(args.host or CONFIG["server_host"])
    port = int(args.port or CONFIG["server_port"])
    auto_kill = bool(CONFIG.get("auto_kill_port_occupier", False))

    if not find_and_kill_process_on_port(port, auto_kill=auto_kill):
        logger.error("Cannot free port %s, exiting", port)
        sys.exit(1)

    logger.info("Starting server on %s:%s", host, port)
    uvicorn.run(
        "unified_asr_diarization_transformer_offline:app",
        host=host,
        port=port,
        reload=False,
    )
