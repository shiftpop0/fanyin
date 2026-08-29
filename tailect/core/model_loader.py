# core/model_loader.py
"""
模型加载模块 — 加载 ASR、说话人分离、强制对齐、标点恢复等模型。
"""

import os
import sys
import types
import logging
from typing import Any, Optional

import torch

from core.logger import logger

# ===================================================================
# 兼容性补丁
# ===================================================================


def install_torchaudio_compat_shim() -> None:
    """兼容某些 torchaudio 版本缺少 API 的情况，避免 pyannote 导入失败。"""
    try:
        import torchaudio as ta
    except Exception:
        return

    if not hasattr(ta, "AudioMetaData"):

        class AudioMetaData:
            def __init__(
                self,
                sample_rate: int = 0,
                num_frames: int = 0,
                num_channels: int = 0,
                bits_per_sample: int = 0,
                encoding: str = "",
            ):
                self.sample_rate = sample_rate
                self.num_frames = num_frames
                self.num_channels = num_channels
                self.bits_per_sample = bits_per_sample
                self.encoding = encoding

        setattr(ta, "AudioMetaData", AudioMetaData)

    if not hasattr(ta, "list_audio_backends"):
        setattr(ta, "list_audio_backends", lambda: ["soundfile"])
    if not hasattr(ta, "get_audio_backend"):
        setattr(ta, "get_audio_backend", lambda: "soundfile")
    if not hasattr(ta, "set_audio_backend"):
        setattr(ta, "set_audio_backend", lambda backend: None)

    if "torchaudio.backend" not in sys.modules:
        backend_module = types.ModuleType("torchaudio.backend")
        backend_module.list_audio_backends = ta.list_audio_backends
        backend_module.get_audio_backend = ta.get_audio_backend
        backend_module.set_audio_backend = ta.set_audio_backend
        sys.modules["torchaudio.backend"] = backend_module
    else:
        backend_module = sys.modules["torchaudio.backend"]

    if "torchaudio.backend.common" not in sys.modules:
        common_module = types.ModuleType("torchaudio.backend.common")
        if hasattr(ta, "AudioMetaData"):
            common_module.AudioMetaData = ta.AudioMetaData
        sys.modules["torchaudio.backend.common"] = common_module
    else:
        common_module = sys.modules["torchaudio.backend.common"]

    setattr(backend_module, "common", common_module)


def patch_mistral_tokenizer() -> None:
    """自动为 Mistral/Qwen 架构模型修复 tokenizer 正则表达式。"""
    try:
        from transformers import AutoTokenizer
        from transformers.tokenization_utils_base import PreTrainedTokenizerBase

        if getattr(AutoTokenizer.from_pretrained, "_mistral_fix_patched", False):
            return

        _original_from_pretrained = AutoTokenizer.from_pretrained

        def _patched_from_pretrained(pretrained_model_name_or_path, *args, **kwargs):
            path_lower = str(pretrained_model_name_or_path).lower()
            if "mistral" in path_lower or "qwen" in path_lower or "checkpoint" in path_lower:
                kwargs.setdefault("fix_mistral_regex", True)
            return _original_from_pretrained(pretrained_model_name_or_path, *args, **kwargs)

        _patched_from_pretrained._mistral_fix_patched = True
        AutoTokenizer.from_pretrained = _patched_from_pretrained

        if not getattr(PreTrainedTokenizerBase.from_pretrained, "_mistral_fix_patched", False):
            _orig_base_from_pretrained = PreTrainedTokenizerBase.from_pretrained.__func__

            def _patched_base_from_pretrained(cls, pretrained_model_name_or_path, *args, **kwargs):
                path_lower = str(pretrained_model_name_or_path).lower()
                if "mistral" in path_lower or "qwen" in path_lower or "checkpoint" in path_lower:
                    kwargs.setdefault("fix_mistral_regex", True)
                return _orig_base_from_pretrained(cls, pretrained_model_name_or_path, *args, **kwargs)

            _patched_base_from_pretrained._mistral_fix_patched = True
            setattr(
                PreTrainedTokenizerBase,
                "from_pretrained",
                classmethod(_patched_base_from_pretrained),
            )

        logger.info("[TOKENIZER] Applied fix_mistral_regex monkey patch")
    except ImportError:
        logger.warning("[TOKENIZER] transformers not installed, skip tokenizer patch")
    except Exception as e:
        logger.warning("[TOKENIZER] Failed to patch AutoTokenizer.from_pretrained: %s", e)


# ===================================================================
# ASR 模型加载
# ===================================================================


def load_asr_model(
    model_path: str,
    device: str,
    dtype: torch.dtype,
    batch_size: int,
    attn_implementation: Optional[str] = None,
    use_compile: bool = False,
    max_new_tokens: Optional[int] = None,
) -> Any:
    """加载 Qwen3ASRModel。"""
    if not os.path.isdir(model_path):
        raise RuntimeError(f"Invalid ASR model path: {model_path}")

    try:
        from qwen_asr import Qwen3ASRModel
    except ImportError as e:
        raise RuntimeError("Failed to import qwen_asr. Please install: pip install qwen-asr") from e

    load_kwargs = {
        "dtype": dtype,
        "device_map": device,
        "max_inference_batch_size": batch_size,
    }

    if attn_implementation is not None:
        load_kwargs["attn_implementation"] = attn_implementation
        logger.info("[ASR] Using attention implementation: %s", attn_implementation)

    if device == "auto":
        gpu_count = torch.cuda.device_count() if torch.cuda.is_available() else 0
        logger.info("[ASR] Device mode: auto (device_map=auto, %d GPU(s) available)", gpu_count)
        if gpu_count > 0:
            for i in range(gpu_count):
                logger.info("[ASR]   GPU %d: %s", i, torch.cuda.get_device_name(i))
    else:
        logger.info("[ASR] Device mode: %s (explicit device)", device)

    logger.info("[ASR] Loading Qwen3ASRModel from %s", model_path)
    try:
        model = Qwen3ASRModel.from_pretrained(model_path, **load_kwargs)
    except Exception as e:
        logger.error("[ASR] Failed to load model: %s", e)
        raise

    if use_compile and hasattr(model, "compile"):
        logger.info("[ASR] Applying torch.compile...")
        try:
            model.compile()
            logger.info("[ASR] torch.compile applied successfully")
        except Exception as e:
            logger.warning("[ASR] torch.compile failed: %s", e)

    return model


def load_asr_model_vllm(
    model_path: str,
    gpu_memory_utilization: float = 0.7,
    max_new_tokens: int = 2048,
    max_model_len: int = 4096,
    batch_size: int = 32,
) -> Any:
    """使用 vLLM 后端加载 Qwen3ASRModel。

    Qwen3ASRModel.LLM() 返回与 from_pretrained() 同类的实例，
    .transcribe() 接口完全一致，支持文件路径 / 数组 / 批量输入。
    """
    if not os.path.isdir(model_path):
        raise RuntimeError(f"Invalid ASR model path: {model_path}")

    try:
        from qwen_asr import Qwen3ASRModel
    except ImportError as e:
        raise RuntimeError(
            "Failed to import qwen_asr (vLLM mode). Install with: pip install qwen-asr[vllm]"
        ) from e

    logger.info("[ASR][vLLM] Loading Qwen3ASRModel.LLM from %s", model_path)
    logger.info(
        "[ASR][vLLM] Params: gpu_memory_utilization=%s, max_new_tokens=%s, "
        "max_model_len=%s, batch_size=%s",
        gpu_memory_utilization, max_new_tokens, max_model_len, batch_size,
    )

    try:
        model = Qwen3ASRModel.LLM(
            model=model_path,
            gpu_memory_utilization=gpu_memory_utilization,
            max_new_tokens=max_new_tokens,
            max_model_len=max_model_len,
            max_inference_batch_size=batch_size,
        )
    except Exception as e:
        logger.error("[ASR][vLLM] Failed to load model: %s", e)
        raise

    logger.info("[ASR][vLLM] Model loaded successfully (backend=vllm)")
    return model


# ===================================================================
# 说话人分离模型加载
# ===================================================================


def load_diarization_model(project_path: str, device: str) -> Any:
    """加载 TargetDiarization 模型。"""
    if not os.path.isdir(project_path):
        raise RuntimeError(f"Invalid diarization project path: {project_path}")

    install_torchaudio_compat_shim()

    if project_path not in sys.path:
        sys.path.insert(0, project_path)

    try:
        from TargetDiarization import TargetDiarization  # type: ignore
    except Exception as e:
        raise RuntimeError("Failed to import TargetDiarization class") from e

    logger.info("[DIAR] Loading model from project: %s", project_path)
    # 修正：TargetDiarization 父目录 = asr_offline/，模型在 asr_offline/model/ 下
    workspace_root = os.path.abspath(os.path.join(project_path, os.pardir))
    MODEL_ROOT = os.path.join(workspace_root, "model")

    diarization_pipeline_dir = os.path.join(
        MODEL_ROOT, "iic", "speech_campplus_speaker-diarization_common",
    )
    od_model_dir = os.path.join(
        MODEL_ROOT, "pyannote", "speaker-diarization-community-1",
    )
    embedding_model_dir = os.path.join(
        MODEL_ROOT, "iic", "speech_eres2netv2w24s4ep4_sv_zh-cn_16k-common",
    )
    vad_model_dir = os.path.join(
        MODEL_ROOT, "iic", "speech_fsmn_vad_zh-cn-16k-common-pytorch",
    )

    logger.info("[DIAR] diarization_pipeline_dir=%s", diarization_pipeline_dir)
    logger.info("[DIAR] od_model_dir=%s", od_model_dir)
    logger.info("[DIAR] embedding_model_dir=%s", embedding_model_dir)
    logger.info("[DIAR] vad_model_dir=%s", vad_model_dir)

    # 解析 cuda 设备索引
    def _resolve_cuda_device(dev: str) -> Optional[int]:
        dev_lower = dev.lower().strip()
        if dev_lower == "cpu":
            return -1
        elif dev_lower == "cuda":
            return 0  # 默认 GPU 0，非 None
        elif dev_lower.startswith("cuda:"):
            try:
                return int(dev_lower.split(":")[1])
            except (ValueError, IndexError):
                return 0
        return 0

    # 强制离线模式，禁止联网下载
    os.environ["HF_HUB_OFFLINE"] = "1"
    os.environ["TRANSFORMERS_OFFLINE"] = "1"

    model = TargetDiarization(
        diarization_pipeline_dir=diarization_pipeline_dir,
        od_model_dir=od_model_dir,
        cuda_device=_resolve_cuda_device(device),
        embedding_model_dir=embedding_model_dir,
        vad_model_dir=vad_model_dir,
        asr_model_dir="",
        mdx_weights_file="",
        separater_weights_folder="",
        restorer_weights_folder="",
        verbose_log=False,
    )
    return model


# ===================================================================
# 强制对齐模型加载
# ===================================================================


def load_forced_aligner(model_path: str, device: str) -> Any:
    """加载 Qwen3ForcedAligner。"""
    if not os.path.isdir(model_path):
        raise RuntimeError(f"Invalid forced aligner model path: {model_path}")

    # 尝试添加候选路径
    candidate = "/root/autodl-tmp/Qwen3-ASR"
    if os.path.isdir(candidate) and candidate not in sys.path:
        sys.path.insert(0, candidate)

    try:
        from qwen_asr import Qwen3ForcedAligner
    except Exception as e:
        raise RuntimeError("Failed to import qwen_asr.Qwen3ForcedAligner") from e

    dev = device.strip().lower()
    device_map = "cuda:0" if dev == "cuda" else ("cpu" if dev == "cpu" else device)
    dtype = torch.bfloat16 if str(device_map).startswith("cuda") else torch.float32

    logger.info("[ALIGN] Loading forced aligner from %s on %s", model_path, device_map)
    aligner = Qwen3ForcedAligner.from_pretrained(
        model_path,
        dtype=dtype,
        device_map=device_map,
    )
    return aligner


# ===================================================================
# 标点恢复模型加载
# ===================================================================


def load_punctuation_model(model_path: str, device: str = "cuda:0") -> Any:
    """加载标点恢复模型（FunASR）。"""
    try:
        from funasr import AutoModel

        model = AutoModel(
            model=model_path,
            device=device,
            disable_update=True,
        )
        logger.info("[PUNC] Loaded punctuation model from %s on %s", model_path, device)
        return model
    except Exception as e:
        logger.warning("[PUNC] Failed to load punctuation model: %s", e)
        return None
