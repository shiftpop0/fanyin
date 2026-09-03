"""6006 /asr 模式参数定义与互斥解析。"""

from __future__ import annotations

from typing import Any, Dict, Optional


MODE_SPEAKER_DIARIZATION = 1
MODE_VAD_SEGMENT = 2
SUPPORTED_ASR_MODES = frozenset({MODE_SPEAKER_DIARIZATION, MODE_VAD_SEGMENT})


class ModeParameterError(ValueError):
    """mode/diarization 查询参数组合不合法。"""


def resolve_asr_mode(
    mode: Optional[int],
    diarization: Optional[bool],
) -> Optional[int]:
    """返回本次请求模式；None 表示保持旧的 whole-audio ASR 路径。"""
    if mode is not None and diarization is not None:
        raise ModeParameterError("mode and diarization cannot be used together")

    if mode is not None:
        if type(mode) is not int or mode not in SUPPORTED_ASR_MODES:
            raise ModeParameterError(
                f"unsupported mode: {mode}; supported modes are 1 and 2"
            )
        return mode

    if diarization is True:
        return MODE_SPEAKER_DIARIZATION
    return None


def dispatch_asr_mode(
    service: Any,
    resolved_mode: Optional[int],
    audio_path: str,
    input_filename: str,
) -> Dict[str, Any]:
    """执行已解析的 6006 模式；None 保持旧 whole-audio ASR。"""
    if resolved_mode == MODE_VAD_SEGMENT:
        return service.transcribe_vad_segments(
            audio_path=audio_path,
            input_filename=input_filename,
        )
    if resolved_mode == MODE_SPEAKER_DIARIZATION:
        return service.diarization_then_asr(
            audio_path=audio_path,
            input_filename=input_filename,
        )
    if resolved_mode is None:
        return service.asr_raw(audio_path)
    raise ModeParameterError(f"unsupported resolved mode: {resolved_mode}")
