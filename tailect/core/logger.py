# core/logger.py
"""
日志工具模块 — 配置全局日志格式与级别。
"""

import logging

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s | %(levelname)s | %(name)s | %(message)s",
)
logger = logging.getLogger("unified_asr_diarization")
