# core/device_utils.py
"""
设备与精度工具模块 — 解析设备字符串与数据类型。
"""

import torch
import logging

logger = logging.getLogger("unified_asr_diarization")


def resolve_device(device: str) -> str:
    """解析设备配置。"""
    device_lower = str(device).lower().strip()

    if device_lower == "auto":
        return "auto"
    elif device_lower == "cpu":
        return "cpu"
    elif device_lower == "cuda":
        return "cuda:0"
    elif device_lower.startswith("cuda:"):
        return device_lower
    else:
        logger.warning("[ASR] Unknown device '%s', falling back to auto", device)
        return "auto"


def resolve_dtype(dtype_str: str, fallback_device: str = "auto") -> torch.dtype:
    """解析数据类型配置。"""
    dtype_lower = str(dtype_str).lower().strip()

    if dtype_lower in ("float32", "fp32"):
        return torch.float32
    elif dtype_lower in ("float16", "fp16"):
        return torch.float16
    elif dtype_lower in ("bfloat16", "bf16"):
        return torch.bfloat16
    else:
        logger.warning(
            "[ASR] Unknown dtype '%s', falling back to bfloat16 if CUDA else float32",
            dtype_str,
        )
        if "cuda" in fallback_device or fallback_device == "auto":
            return torch.bfloat16
        return torch.float32
