# core/audio_processor.py
"""
音频处理模块 — 音频读取、裁剪、分段、临时文件管理等工具。
注意：本模块不依赖 FastAPI，纯音频处理工具。
"""

import os
from datetime import datetime
from typing import Any, Dict, List, Optional, Tuple

import numpy as np

from core.logger import logger


def clip_audio(audio: np.ndarray, sr: int, start_sec: float, end_sec: float) -> np.ndarray:
    """裁剪音频片段。"""
    start_idx = max(0, int(round(start_sec * sr)))
    end_idx = min(len(audio), int(round(end_sec * sr)))
    if end_idx <= start_idx:
        return np.zeros((0,), dtype=np.float32)
    return np.asarray(audio[start_idx:end_idx], dtype=np.float32)


def safe_remove(path: str) -> None:
    """安全删除文件，忽略不存在的文件。"""
    try:
        if path and os.path.exists(path):
            os.remove(path)
    except Exception as e:
        logger.warning("Failed to remove temp file %s: %s", path, e)


def format_wall_time(epoch_seconds: float) -> str:
    """格式化可读的墙钟时间。"""
    return datetime.fromtimestamp(epoch_seconds).isoformat(timespec="milliseconds")
