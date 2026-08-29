# core/inference_engine.py
"""
核心推理引擎 — ASR、说话人分离、强制对齐、标点恢复等所有推理逻辑。
"""

from __future__ import annotations

import concurrent.futures
import os
import sys
import tempfile
import threading
import time
from datetime import datetime
from typing import Any, Dict, List, Optional, Tuple

import numpy as np
import soundfile as sf
import torch

from core.config import CONFIG
from core.logger import logger
from core.device_utils import resolve_device, resolve_dtype
from core.model_loader import (
    load_asr_model,
    load_asr_model_vllm,
    load_diarization_model,
    load_forced_aligner,
    load_punctuation_model,
    install_torchaudio_compat_shim,
)
from core.audio_processor import clip_audio, safe_remove, format_wall_time

# ===================================================================
# 路径解析
# ===================================================================


def resolve_diarization_project_path(configured_path: str) -> str:
    """解析可用的 diarization 项目目录，兼容不同挂载层级。"""
    script_dir = os.path.dirname(os.path.abspath(__file__))
    # 从 core/ 往上一级到 asr_offline/
    project_root = os.path.dirname(script_dir)
    search_roots = [
        os.getcwd(),
        script_dir,
        project_root,
        os.path.dirname(project_root),
    ]

    candidate_paths = [
        configured_path,
        "./TargetDiarization-main",
        "./Tailect_web/TargetDiarization-main",
        "./Tailect-ASR/TargetDiarization-main",
    ]

    checked_paths: List[str] = []
    for raw_path in candidate_paths:
        if raw_path is None:
            continue
        normalized_path = str(raw_path).strip().replace("\\", "/")
        if not normalized_path:
            continue

        if os.path.isabs(normalized_path):
            absolute_path = os.path.abspath(normalized_path)
            checked_paths.append(absolute_path)
            if os.path.isdir(absolute_path):
                return absolute_path
            continue

        for root in search_roots:
            absolute_path = os.path.abspath(os.path.join(root, normalized_path))
            if absolute_path in checked_paths:
                continue
            checked_paths.append(absolute_path)
            if os.path.isdir(absolute_path):
                return absolute_path

    checked_summary = ", ".join(checked_paths)
    raise RuntimeError(
        "Invalid diarization project path. "
        f"configured='{configured_path}', checked=[{checked_summary}]"
    )


# ===================================================================
# ASR 包装器
# ===================================================================


class ASRWrapper:
    """
    ASR 推理包装器，支持 Transformers 和 vLLM 两种后端。

    后端选择（由 config vllm_enabled 控制）：
      - False (Transformers): Qwen3ASRModel.from_pretrained() 加载
      - True  (vLLM):        Qwen3ASRModel.LLM() 加载

    两种后端暴露相同的 .transcribe() 接口，上层无需关心后端差异。
    """

    def __init__(self, config: Dict[str, Any]) -> None:
        self.config = config
        self.model_path = str(config["asr_model_path"])
        self.vllm_mode = bool(config.get("vllm_enabled", False))

        if self.vllm_mode:
            # ===== vLLM 模式 =====
            self.device = "cuda:0"
            self.dtype = None
            self.batch_size = int(config.get("asr_batch_size", 32))
            self.max_new_tokens = int(config.get("vllm_max_new_tokens", 2048))
            self.target_sample_rate = int(config.get("asr_target_sample_rate", 16000))
            self.max_audio_duration = float(config.get("asr_audio_max_duration", 3600))
            self.temperature = 0.0
            self.repetition_penalty = 1.02
            self.top_p = 0.95
            self.top_k = 50
            self.attn_implementation = None
            self.use_compile = False

            self.model = load_asr_model_vllm(
                model_path=self.model_path,
                gpu_memory_utilization=float(config.get("vllm_gpu_memory_utilization", 0.7)),
                max_new_tokens=self.max_new_tokens,
                max_model_len=int(config.get("vllm_max_model_len", 4096)),
                batch_size=self.batch_size,
            )

            logger.info(
                "[ASR][vLLM] Initialized - batch_size=%s, max_new_tokens=%s, "
                "gpu_memory_utilization=%s",
                self.batch_size,
                self.max_new_tokens,
                config.get("vllm_gpu_memory_utilization", 0.7),
            )
        else:
            # ===== Transformers 模式（原行为）=====
            self.device = resolve_device(config.get("asr_device", "cuda:0"))
            self.dtype = resolve_dtype(config.get("asr_dtype", "bfloat16"), self.device)

            self.max_new_tokens = int(config.get("asr_max_new_tokens", 2048))
            self.temperature = float(config.get("asr_temperature", 0.0))
            self.repetition_penalty = float(config.get("asr_repetition_penalty", 1.02))
            self.top_p = float(config.get("asr_top_p", 0.95))
            self.top_k = int(config.get("asr_top_k", 50))

            self.batch_size = int(config.get("asr_batch_size", 16))
            self.target_sample_rate = int(config.get("asr_target_sample_rate", 16000))
            self.max_audio_duration = float(config.get("asr_audio_max_duration", 3600))
            self.attn_implementation = config.get("asr_attn_implementation", None)
            self.use_compile = bool(config.get("asr_use_compile", False))

            self.model = load_asr_model(
                model_path=self.model_path,
                device=self.device,
                dtype=self.dtype,
                batch_size=self.batch_size,
                attn_implementation=self.attn_implementation,
                use_compile=self.use_compile,
            )

            if hasattr(self.model, "max_new_tokens"):
                self.model.max_new_tokens = self.max_new_tokens
            if hasattr(self.model, "generation_config"):
                self.model.generation_config.max_new_tokens = self.max_new_tokens

            logger.info(
                "[ASR] Initialized - device=%s, dtype=%s, batch_size=%s, "
                "max_new_tokens=%s, attn=%s",
                self.device,
                self.dtype,
                self.batch_size,
                self.max_new_tokens,
                self.attn_implementation,
            )

        # ===== 应用纯 ASR 切分阈值（pure_asr_max_chunk_seconds）=====
        # qwen_asr 库内部硬编码 MAX_ASR_INPUT_SECONDS=1200（inference/utils.py），
        # 超过该时长的音频不会自动切分，导致 vLLM 报 "prompt length > max_model_len"。
        # 这里在运行时覆盖库内常量（transcribe() 从 qwen3_asr 模块全局读取，
        # 因此需同时 patch qwen3_asr 与 utils 两个模块的命名空间），使配置真正生效。
        # 两种后端（vLLM / Transformers）均适用。
        try:
            import qwen_asr.inference.qwen3_asr as _qwen3_asr_mod
            import qwen_asr.inference.utils as _qwen3_asr_utils

            chunk_sec = float(self.config.get("pure_asr_max_chunk_seconds", 300))
            if chunk_sec > 0:
                _qwen3_asr_mod.MAX_ASR_INPUT_SECONDS = chunk_sec
                _qwen3_asr_utils.MAX_ASR_INPUT_SECONDS = chunk_sec
                logger.info(
                    "[ASR] Applied pure_asr_max_chunk_seconds=%s "
                    "(overrode qwen_asr MAX_ASR_INPUT_SECONDS=1200)",
                    chunk_sec,
                )
        except Exception as e:
            logger.warning("[ASR] Failed to apply pure_asr_max_chunk_seconds: %s", e)

    def _resolve_device(self, device: str) -> str:
        """解析设备配置（保留原始方法签名）"""
        return resolve_device(device)

    def _resolve_dtype(self, dtype_str: str) -> torch.dtype:
        """解析数据类型配置（保留原始方法签名）"""
        return resolve_dtype(dtype_str, self.device)

    def _load_model(self) -> Any:
        """加载模型（保留原始方法签名）"""
        if self.vllm_mode:
            return load_asr_model_vllm(
                model_path=self.model_path,
                gpu_memory_utilization=float(self.config.get("vllm_gpu_memory_utilization", 0.7)),
                max_new_tokens=self.max_new_tokens,
                max_model_len=int(self.config.get("vllm_max_model_len", 4096)),
                batch_size=self.batch_size,
            )
        return load_asr_model(
            model_path=self.model_path,
            device=self.device,
            dtype=self.dtype,
            batch_size=self.batch_size,
            attn_implementation=self.attn_implementation,
            use_compile=self.use_compile,
            max_new_tokens=self.max_new_tokens,
        )

    def transcribe(self, audio_input: Any) -> str:
        """
        转录音频，支持多种输入格式：
        - 字符串: 音频文件路径
        - 元组: (numpy.ndarray, sample_rate)
        - bytes: 音频二进制数据
        """
        return self.transcribe_detailed(audio_input)["text"]

    def transcribe_detailed(self, audio_input: Any) -> Dict[str, str]:
        """Transcribe one input while preserving the model-reported language."""
        if self.model is None:
            raise RuntimeError("ASR model is not loaded")

        audio_input_for_model = self._prepare_audio_input(audio_input)
        try:
            result = self._call_model_transcribe(audio_input_for_model)
            return {
                "text": self._extract_text_from_result(result),
                "language": self._extract_language_from_result(result),
            }
        except Exception as e:
            logger.error("[ASR] Transcription failed: %s", e)
            raise

    def _prepare_audio_input(self, audio_input: Any) -> Any:
        """准备音频输入，转换为模型接受的格式"""
        if isinstance(audio_input, str):
            return audio_input

        if isinstance(audio_input, tuple) and len(audio_input) == 2:
            audio_data, sample_rate = audio_input

            if sample_rate != self.target_sample_rate:
                import librosa

                audio_data = librosa.resample(
                    audio_data,
                    orig_sr=sample_rate,
                    target_sr=self.target_sample_rate,
                )
                sample_rate = self.target_sample_rate

            with tempfile.NamedTemporaryFile(suffix=".wav", delete=False) as tmp:
                sf.write(tmp.name, audio_data, sample_rate)
                return tmp.name

        if isinstance(audio_input, bytes):
            with tempfile.NamedTemporaryFile(suffix=".wav", delete=False) as tmp:
                tmp.write(audio_input)
                return tmp.name

        raise RuntimeError(f"Unsupported audio input type: {type(audio_input)}")

    def _call_model_transcribe(self, audio_input: Any) -> Any:
        """调用模型的 transcribe 方法，支持单条和批量(list)输入"""
        if hasattr(self.model, "transcribe"):
            # 批量模式：传入 list，使用 audio= 关键字触发 Qwen3ASRModel 原生批处理
            if isinstance(audio_input, list):
                return self.model.transcribe(audio=audio_input)

            try:
                return self.model.transcribe(audio_input)
            except TypeError:
                try:
                    return self.model.transcribe(audio=audio_input)
                except TypeError:
                    try:
                        return self.model.transcribe(file=audio_input)
                    except Exception as e:
                        raise RuntimeError(f"Cannot call model.transcribe with input: {e}")

        if hasattr(self.model, "__call__"):
            if isinstance(audio_input, list):
                return [self.model(a) for a in audio_input]
            return self.model(audio_input)

        raise RuntimeError("Model does not have transcribe or __call__ method")

    def _extract_text_from_result(self, result: Any) -> str:
        """从模型返回结果中提取文本，支持 dict、对象属性、str 等格式"""
        if isinstance(result, str):
            return result.strip()

        if isinstance(result, dict):
            if "text" in result:
                return str(result["text"]).strip()
            if "transcription" in result:
                return str(result["transcription"]).strip()

        if isinstance(result, list) and len(result) > 0:
            first = result[0]
            if isinstance(first, dict):
                if "text" in first:
                    return str(first["text"]).strip()
            if isinstance(first, str):
                return first.strip()
            # Qwen3ASR 返回的对象具有 .text 属性
            if hasattr(first, "text"):
                return str(first.text).strip()

        # Qwen3ASRModel 单条结果对象
        if hasattr(result, "text"):
            return str(result.text).strip()

        return str(result).strip()

    def _extract_language_from_result(self, result: Any) -> str:
        """Extract Qwen3-ASR's language field without changing legacy text output."""
        value = result[0] if isinstance(result, list) and result else result
        if isinstance(value, dict):
            for key in ("language", "lang"):
                if value.get(key):
                    return str(value[key]).strip()
        for key in ("language", "lang"):
            if hasattr(value, key):
                language = getattr(value, key)
                if language:
                    return str(language).strip()
        return ""

    def _BATCH_SAFE_LIMIT(self) -> int:
        """Qwen3 内部分片上限为 48，超过会触发 KV cache 形状错误。
        取 min(配置值, 48) 确保每批不超过内部上限。
        """
        return min(self.batch_size, 48)

    def transcribe_batch(self, audio_list: List[Any]) -> List[str]:
        """
        真批量转录（主动分批版）。

        将音频按 _BATCH_SAFE_LIMIT（min(batch_size, 48)）切分成多个小 batch，
        每批独立调用 model.transcribe(audio=chunk)，绕过 Qwen3 内部 max_batch_size
        分片导致的 KV cache 形状不匹配问题，同时保持 GPU 批量推理性能。
        """
        if self.model is None:
            raise RuntimeError("ASR model is not loaded")

        if not audio_list:
            return []

        # 准备所有音频输入（统一转为模型可接受的格式）
        prepared_inputs: List[Any] = []
        cleanup_paths: List[str] = []
        for audio in audio_list:
            prepared = self._prepare_audio_input(audio)
            prepared_inputs.append(prepared)
            if isinstance(prepared, str) and not isinstance(audio, str):
                cleanup_paths.append(prepared)

        chunk_size = self._BATCH_SAFE_LIMIT()
        results: List[str] = []
        try:
            for chunk_start in range(0, len(prepared_inputs), chunk_size):
                chunk = prepared_inputs[chunk_start:chunk_start + chunk_size]
                try:
                    batch_results = self._call_model_transcribe(chunk)
                    if isinstance(batch_results, list):
                        chunk_texts = [self._extract_text_from_result(r) for r in batch_results]
                    else:
                        text = self._extract_text_from_result(batch_results)
                        chunk_texts = [text] * len(chunk)
                    results.extend(chunk_texts)
                except Exception as e:
                    logger.error(
                        "[ASR] Chunk batch failed (indices %s-%s), clearing cache & falling back per-item: %s",
                        chunk_start, chunk_start + len(chunk) - 1, e,
                    )
                    if torch.cuda.is_available():
                        torch.cuda.empty_cache()
                        torch.cuda.synchronize()
                    # 该 chunk 内逐条降级
                    for i, item in enumerate(chunk):
                        try:
                            text = self.transcribe(item)
                            chunk_texts = [text]
                        except Exception as e2:
                            logger.error(
                                "[ASR] Fallback transcription failed idx=%s: %s",
                                chunk_start + i, e2,
                            )
                            chunk_texts = [""]
                        results.extend(chunk_texts)
            return results
        finally:
            for p in cleanup_paths:
                safe_remove(p)

    def reset_kv_cache(self) -> None:
        """重置模型内部 KV 缓存，防止跨调用 batch_size 变化导致形状不匹配。

        vLLM 后端无需此操作（vLLM 内部管理 KV cache），为无操作。
        """
        if self.model is None or self.vllm_mode:
            return
        try:
            if hasattr(self.model, 'thinker'):
                thinker = self.model.thinker
                for attr in ['past_key_values', '_past_key_values',
                             'generation_cache', '_cache']:
                    if hasattr(thinker, attr):
                        try:
                            setattr(thinker, attr, None)
                        except Exception:
                            pass
                if hasattr(thinker, 'model') and hasattr(thinker.model, 'past_key_values'):
                    thinker.model.past_key_values = None
        except Exception as e:
            logger.debug("[ASR] Cache reset note: %s", e)

    def close(self) -> None:
        """释放模型资源"""
        if hasattr(self, "model") and self.model is not None:
            logger.info("[ASR] Releasing model resources...")
            del self.model
            if torch.cuda.is_available():
                torch.cuda.empty_cache()
                torch.cuda.synchronize()
        self.model = None

    def __del__(self) -> None:
        try:
            self.close()
        except Exception:
            pass


# ===================================================================
# 说话人分离包装器
# ===================================================================


class DiarizationWrapper:
    """封装 TargetDiarization，直接调用类方法，不启动其 FastAPI 服务。"""

    def __init__(self, project_path: str, device: str) -> None:
        self.project_path = os.path.abspath(project_path)
        self.device = device
        self.model = self._load_model()

    def _load_model(self) -> Any:
        """加载 diarization 模型（保留原始方法签名）"""
        return load_diarization_model(self.project_path, self.device)

    def diarize(self, audio_path: str) -> List[Dict[str, Any]]:
        """返回标准片段格式: [{start, end, speaker, type}, ...]"""
        audio_data, sampling_rate = self.model.ap.read_audio(audio_path)
        audio_data, sampling_rate = self.model.audio_preprocess(
            audio_data=audio_data,
            sampling_rate=sampling_rate,
        )

        long_audio_threshold = 30.0
        sd_result: Dict[str, List[Tuple[float, float]]] = {}
        pyannote_result = None

        # 打印设备信息
        logger.info("[DIAR] Model device: %s", getattr(self.model, 'device', 'unknown'))
        logger.info("[DIAR] Audio duration: %.2f sec", audio_data.shape[0] / sampling_rate)

        if audio_data.shape[0] / sampling_rate >= long_audio_threshold or self.model.od_pipeline is None:
            try:
                # 使用带超时的线程池执行 ModelScope pipeline
                with concurrent.futures.ThreadPoolExecutor(max_workers=1) as pool:
                    future = pool.submit(self.model.sd_pipeline, audio_data)
                    try:
                        raw_sd = future.result(timeout=300)  # 5 分钟超时
                    except concurrent.futures.TimeoutError:
                        logger.error("[DIAR] sd_pipeline timed out after 300s")
                        raise TimeoutError("sd_pipeline timed out after 300s")
                sd_result = self.model.sd_result_parser(
                    sd_result=raw_sd,
                    is_single=False,
                    combine_timerange=False,
                )
            except Exception as e:
                logger.warning("[DIAR] sd_pipeline failed: %s", e)

        if not sd_result and self.model.od_pipeline is not None and self.model.od_pipeline_mode == "diarization":
            try:
                pyannote_result = self.model.od_pipeline(
                    {
                        "waveform": self.model.ap.ndarray_to_torchaudio(
                            audio_data=audio_data, device=self.model.device
                        ),
                        "sample_rate": sampling_rate,
                    }
                )
                sd_result = self.model.od_result_parser(
                    od_result=pyannote_result,
                    is_single=False,
                    output_overlap=False,
                )
            except Exception as e:
                logger.warning("[DIAR] pyannote fallback failed: %s", e)

        if sd_result and self.model.od_pipeline is not None:
            try:
                if pyannote_result is None and self.model.od_pipeline_mode == "diarization":
                    pyannote_result = self.model.od_pipeline(
                        {
                            "waveform": self.model.ap.ndarray_to_torchaudio(
                                audio_data=audio_data, device=self.model.device
                            ),
                            "sample_rate": sampling_rate,
                        }
                    )
                if self.model.od_pipeline_mode == "overlap":
                    od_result = self.model.overlap_detection_result_parser(
                        audio_data=audio_data,
                        sampling_rate=sampling_rate,
                        sd_result=sd_result,
                    )
                else:
                    od_result = self.model.od_result_parser(
                        od_result=pyannote_result,
                        sd_result=sd_result,
                    )
                sd_result, _ = self.model.apply_od_result(sd_result=sd_result, od_result=od_result)
            except Exception as e:
                logger.warning("[DIAR] overlap refinement failed: %s", e)

        segments: List[Dict[str, Any]] = []
        for speaker, timeranges in (sd_result or {}).items():
            for timerange in timeranges or []:
                if not isinstance(timerange, (list, tuple)) or len(timerange) < 2:
                    continue
                start = float(timerange[0])
                end = float(timerange[1])
                if end <= start:
                    continue
                segments.append(
                    {
                        "start": round(start, 3),
                        "end": round(end, 3),
                        "speaker": str(speaker),
                        "type": "single",
                    }
                )

        segments.sort(key=lambda x: x["start"])
        logger.info("[DIAR] produced %s segments", len(segments))
        return segments

    def read_audio(self, audio_path: str) -> Tuple[np.ndarray, int]:
        """复用项目内 AudioProcessor，增强多格式音频兼容性。"""
        audio_data, sr = self.model.ap.read_audio(audio_path)
        audio_data = np.asarray(audio_data, dtype=np.float32)
        if audio_data.ndim > 1:
            audio_data = np.mean(audio_data, axis=1, dtype=np.float32)
        return audio_data, int(sr)


# ===================================================================
# 强制对齐包装器
# ===================================================================


class ForcedAlignWrapper:
    """封装 Qwen3ForcedAligner，用于文本到音频的强制对齐。"""

    def __init__(self, model_path: str, device: str) -> None:
        self.model_path = os.path.abspath(model_path)
        self.device = str(device)
        self.aligner = self._load_model()

    def _load_model(self) -> Any:
        """加载强制对齐模型（保留原始方法签名）"""
        return load_forced_aligner(self.model_path, self.device)

    def align(self, audio_path: str, text: str, language: str = "Chinese") -> List[Dict[str, Any]]:
        if not text.strip():
            return []
        results = self.aligner.align(
            audio=audio_path,
            text=text,
            language=language,
        )
        if not results:
            return []

        first = results[0]
        segments: List[Dict[str, Any]] = []
        for item in first:
            start = float(getattr(item, "start_time", 0.0))
            end = float(getattr(item, "end_time", 0.0))
            if end <= start:
                continue
            segments.append(
                {
                    "start": round(start, 3),
                    "end": round(end, 3),
                    "text": str(getattr(item, "text", "")).strip(),
                }
            )
        return segments


# ===================================================================
# 标点恢复器
# ===================================================================


class PunctuationRestorer:
    """标点恢复器（FunASR）"""

    def __init__(self, model_path: str, device: str = "cuda:0"):
        self.model_path = model_path
        self.device = device
        self.model = self._load_model()

    def _load_model(self):
        """加载标点模型（保留原始方法签名）"""
        return load_punctuation_model(self.model_path, self.device)

    def restore(self, text: str) -> str:
        if not text or self.model is None:
            return text
        try:
            result = self.model.generate(input=text)
            if result and len(result) > 0:
                return result[0].get("text", text)
        except Exception as e:
            logger.warning("[PUNC] Restoration failed: %s", e)
        return text


# ===================================================================
# 辅助函数（推理管线）
# ===================================================================


def summarize_segment_timings(segment_results: List[Dict[str, Any]]) -> Dict[str, Any]:
    """汇总片段时间戳，给出并行/顺序的判定线索。"""
    timings = [item.get("asr_debug") for item in segment_results if item.get("asr_debug")]
    if not timings:
        return {"available": False}

    valid_timings = [
        item
        for item in timings
        if item.get("started_at_epoch") is not None and item.get("finished_at_epoch") is not None
    ]
    if not valid_timings:
        return {"available": False}

    ordered_by_start = sorted(valid_timings, key=lambda item: float(item["started_at_epoch"]))
    overlaps: List[Dict[str, Any]] = []
    near_simultaneous_starts: List[Dict[str, Any]] = []
    sequential_chain = True
    smallest_start_gap: Optional[float] = None

    for index in range(1, len(ordered_by_start)):
        previous_item = ordered_by_start[index - 1]
        current_item = ordered_by_start[index]
        previous_start = float(previous_item["started_at_epoch"])
        previous_end = float(previous_item["finished_at_epoch"])
        current_start = float(current_item["started_at_epoch"])
        gap = current_start - previous_start

        if smallest_start_gap is None or gap < smallest_start_gap:
            smallest_start_gap = gap

        if current_start < previous_end:
            sequential_chain = False
            overlaps.append(
                {
                    "previous_segment": previous_item.get("segment_index"),
                    "current_segment": current_item.get("segment_index"),
                    "previous_start": previous_item.get("started_at_wall"),
                    "previous_end": previous_item.get("finished_at_wall"),
                    "current_start": current_item.get("started_at_wall"),
                    "current_end": current_item.get("finished_at_wall"),
                    "overlap_seconds": round(previous_end - current_start, 6),
                }
            )

        if gap <= 0.2:
            near_simultaneous_starts.append(
                {
                    "previous_segment": previous_item.get("segment_index"),
                    "current_segment": current_item.get("segment_index"),
                    "start_gap_seconds": round(gap, 6),
                }
            )

    if overlaps:
        execution_mode = "parallel"
        execution_reason = "at_least_one_segment_started_before_the_previous_segment_finished"
    elif len(valid_timings) > 1 and near_simultaneous_starts:
        execution_mode = "likely_parallel"
        execution_reason = "multiple_segments_started_within_200ms"
    elif len(valid_timings) > 1 and sequential_chain:
        execution_mode = "sequential"
        execution_reason = "each_segment_started_after_the_previous_segment_finished"
    else:
        execution_mode = "unknown"
        execution_reason = "insufficient_timing_signal"

    return {
        "available": True,
        "segment_count": len(valid_timings),
        "execution_mode": execution_mode,
        "execution_reason": execution_reason,
        "smallest_start_gap_seconds": round(smallest_start_gap, 6) if smallest_start_gap is not None else None,
        "overlaps": overlaps,
        "near_simultaneous_starts": near_simultaneous_starts,
        "segments": ordered_by_start,
    }


def transcribe_with_retry(
    asr: ASRWrapper,
    segment_audio: np.ndarray,
    sr: int,
    segment_index: int,
    segment_meta: Dict[str, Any],
    request_id: str,
    max_retries: int = 2,
) -> Dict[str, Any]:
    """带重试的音频片段转录。"""
    last_error: Optional[Exception] = None
    started_at_epoch = time.time()
    started_at_wall = format_wall_time(started_at_epoch)
    thread_name = threading.current_thread().name
    segment_label = (
        f"idx={segment_index} speaker={segment_meta.get('speaker')} "
        f"range=[{float(segment_meta.get('start', 0.0)):.3f}, {float(segment_meta.get('end', 0.0)):.3f}]"
    )

    logger.info(
        "[SEG-ASR][START] request_id=%s %s wall=%s thread=%s",
        request_id,
        segment_label,
        started_at_wall,
        thread_name,
    )

    for attempt in range(max_retries + 1):
        try:
            if segment_audio.size == 0:
                finished_at_epoch = time.time()
                finished_at_wall = format_wall_time(finished_at_epoch)
                logger.info(
                    "[SEG-ASR][END] request_id=%s %s wall=%s thread=%s text=EMPTY elapsed=%.3fs",
                    request_id,
                    segment_label,
                    finished_at_wall,
                    thread_name,
                    finished_at_epoch - started_at_epoch,
                )
                return {
                    "text": "",
                    "segment_index": segment_index,
                    "started_at_epoch": started_at_epoch,
                    "started_at_wall": started_at_wall,
                    "finished_at_epoch": finished_at_epoch,
                    "finished_at_wall": finished_at_wall,
                    "elapsed_seconds": round(finished_at_epoch - started_at_epoch, 6),
                    "thread_name": thread_name,
                    "attempts": attempt + 1,
                    "empty_segment": True,
                }

            text = asr.transcribe((segment_audio, sr))
            finished_at_epoch = time.time()
            finished_at_wall = format_wall_time(finished_at_epoch)
            logger.info(
                "[SEG-ASR][END] request_id=%s %s wall=%s thread=%s elapsed=%.3fs",
                request_id,
                segment_label,
                finished_at_wall,
                thread_name,
                finished_at_epoch - started_at_epoch,
            )
            return {
                "text": text,
                "segment_index": segment_index,
                "started_at_epoch": started_at_epoch,
                "started_at_wall": started_at_wall,
                "finished_at_epoch": finished_at_epoch,
                "finished_at_wall": finished_at_wall,
                "elapsed_seconds": round(finished_at_epoch - started_at_epoch, 6),
                "thread_name": thread_name,
                "attempts": attempt + 1,
                "empty_segment": False,
            }
        except Exception as e:
            last_error = e
            logger.warning(
                "[SEG-ASR][RETRY] request_id=%s %s attempt=%s/%s thread=%s error=%s",
                request_id,
                segment_label,
                attempt + 1,
                max_retries + 1,
                thread_name,
                e,
            )

    if last_error is not None:
        raise last_error

    finished_at_epoch = time.time()
    finished_at_wall = format_wall_time(finished_at_epoch)
    return {
        "text": "",
        "segment_index": segment_index,
        "started_at_epoch": started_at_epoch,
        "started_at_wall": started_at_wall,
        "finished_at_epoch": finished_at_epoch,
        "finished_at_wall": finished_at_wall,
        "elapsed_seconds": round(finished_at_epoch - started_at_epoch, 6),
        "thread_name": thread_name,
        "attempts": max_retries + 1,
        "empty_segment": False,
    }


# ===================================================================
# 统一服务
# ===================================================================


class UnifiedService:
    """统一服务：启动时加载三个模型，提供无状态推理方法。"""

    def __init__(self, config: Dict[str, Any]) -> None:
        self.config = config
        self.asr = ASRWrapper(config=config)
        self._asr_lock = threading.Lock()
        self.diarization: Optional[DiarizationWrapper] = None
        self.diarization_init_error: Optional[str] = None
        try:
            resolved_diarization_project_path = resolve_diarization_project_path(
                str(config.get("diarization_project_path", ""))
            )
            self.config["diarization_project_path"] = resolved_diarization_project_path
            logger.info("[DIAR] Resolved project path: %s", resolved_diarization_project_path)
            self.diarization = DiarizationWrapper(
                project_path=resolved_diarization_project_path,
                device=config["diarization_device"],
            )
        except Exception as e:
            self.diarization_init_error = str(e)
            logger.warning("[DIAR] Disabled at startup: %s", e, exc_info=True)
        self.forced_aligner = ForcedAlignWrapper(
            model_path=config["forced_aligner_model_path"],
            device=str(config.get("forced_aligner_device", "cuda:0")),
        )
        self.punctuation = PunctuationRestorer(
            model_path=config["punctuation_model_path"],
            device=str(config.get("punctuation_device", "cuda:0")),
        )

    def close(self) -> None:
        self.asr.close()

    def asr_raw(self, audio_path: str) -> Dict[str, Any]:
        max_attempts = 2
        last_exception: Optional[Exception] = None

        # 动态超时：长音频（Qwen3ASR 内部按 pure_asr_max_chunk_seconds 自动切分）需要更多时间
        try:
            audio_info = sf.info(audio_path)
            audio_duration = audio_info.duration
        except Exception:
            audio_duration = 0.0
        base_timeout = float(self.config.get("asr_timeout", 180))
        dynamic_timeout = max(
            base_timeout,
            audio_duration * 0.5 + 120.0,  # 至少半倍音频时长 + 2min 缓冲
        )
        logger.info(
            "[ASR] audio_duration=%.1fs, dynamic_timeout=%.1fs (base=%.0fs)",
            audio_duration, dynamic_timeout, base_timeout,
        )

        # 仅锁 ASR 推理本身，同一容器内串行化避免 KV cache 并发污染
        with self._asr_lock:
            try:
                for attempt in range(1, max_attempts + 1):
                    try:
                        with concurrent.futures.ThreadPoolExecutor(max_workers=1) as pool:
                            future = pool.submit(self.asr.transcribe_detailed, audio_path)
                            detail = future.result(timeout=dynamic_timeout)
                        return {
                            "text": str(detail.get("text") or ""),
                            "language": str(detail.get("language") or ""),
                        }
                    except concurrent.futures.TimeoutError as e:
                        raise TimeoutError("ASR timeout") from e
                    except RuntimeError as e:
                        last_exception = e
                        error_str = str(e)
                        # 只对张量形状类错误自动重试（偶发CUDA内存/竞争条件）
                        if "Size of tensors must match" in error_str or "CUDA out of memory" in error_str:
                            logger.warning(
                                "[ASR] Attempt %s/%s failed with CUDA/tensor error, retrying after cache clear: %s",
                                attempt, max_attempts, e,
                            )
                            self.asr.reset_kv_cache()
                            if torch.cuda.is_available():
                                torch.cuda.empty_cache()
                                torch.cuda.synchronize()
                            continue
                        # 其他 RuntimeError 不重试，直接抛出
                        raise
                    except Exception as e:
                        last_exception = e
                        logger.warning(
                            "[ASR] Attempt %s/%s failed, retrying: %s",
                            attempt, max_attempts, e,
                        )
                        if attempt < max_attempts:
                            if torch.cuda.is_available():
                                torch.cuda.empty_cache()
                            continue
                        raise
            finally:
                self.asr.reset_kv_cache()

        # 所有重试均失败
        if last_exception is not None:
            raise last_exception
        return {"text": "", "language": ""}

    def diarization_only(self, audio_path: str) -> Dict[str, Any]:
        if self.diarization is None:
            reason = self.diarization_init_error or "unknown error"
            raise RuntimeError(f"Diarization module unavailable: {reason}")
        with concurrent.futures.ThreadPoolExecutor(max_workers=1) as pool:
            future = pool.submit(self.diarization.diarize, audio_path)
            try:
                segments = future.result(timeout=float(self.config["diarization_timeout"]))
            except concurrent.futures.TimeoutError as e:
                raise TimeoutError("Diarization timeout") from e
        compact = [
            {
                "start": float(seg["start"]),
                "end": float(seg["end"]),
                "speaker": str(seg["speaker"]),
            }
            for seg in segments
        ]
        return {"segments": compact}

    def forced_align(self, audio_path: str, text: str, language: str = "Chinese") -> Dict[str, Any]:
        with concurrent.futures.ThreadPoolExecutor(max_workers=1) as pool:
            future = pool.submit(self.forced_aligner.align, audio_path, text, language)
            try:
                segments = future.result(timeout=float(self.config["forced_align_timeout"]))
            except concurrent.futures.TimeoutError as e:
                raise TimeoutError("Forced align timeout") from e
        return {"segments": segments}

    def restore_punctuation(self, text: str) -> Dict[str, Any]:
        """恢复文本标点"""
        return {"text": self.punctuation.restore(text)}

    def diarization_then_asr(self, audio_path: str, input_filename: str) -> Dict[str, Any]:
        """先分离后分段 ASR，利用 Qwen3ASRModel 原生批量推理大幅提升吞吐量"""
        if self.diarization is not None:
            audio_data, sr = self.diarization.read_audio(audio_path)
        else:
            audio_data, sr = sf.read(audio_path, dtype="float32", always_2d=False)
            audio_data = np.asarray(audio_data, dtype=np.float32)
            if audio_data.ndim > 1:
                audio_data = np.mean(audio_data, axis=1, dtype=np.float32)
            sr = int(sr)
        total_duration = float(len(audio_data) / sr) if sr > 0 else 0.0
        request_id = f"{os.path.basename(input_filename)}-{int(time.time() * 1000)}"

        diarization_status = "ok"
        segments: List[Dict[str, Any]] = []
        try:
            result = self.diarization_only(audio_path)
            segments = [
                {
                    "start": float(x["start"]),
                    "end": float(x["end"]),
                    "speaker": str(x["speaker"]),
                    "type": "single",
                }
                for x in result.get("segments", [])
            ]
            if not segments:
                raise RuntimeError("Empty diarization result")
        except Exception as e:
            logger.error("Diarization failed, fallback to whole-audio ASR: %s", e)
            diarization_status = f"fallback_asr: {str(e)}"
            # 降级：利用 Qwen3ASR 内部纯 ASR 智能切分逻辑处理长音频
            fallback_result = self.asr_raw(audio_path)
            fallback_text = fallback_result.get("text", "")
            logger.info(
                "[SEG-ASR] Fallback asr_raw done: duration=%.1fs, text_len=%d chars",
                total_duration, len(fallback_text),
            )
            # 构造单段 speaker_segment 以兼容返回格式
            return {
                "input_file": input_filename,
                "speaker_count": 0,
                "diarization_status": diarization_status,
                "overall_text": fallback_text,
                "speaker_segments": [
                    {
                        "start": 0.0,
                        "end": round(total_duration, 3),
                        "speaker": "0",
                        "type": "single",
                        "text": fallback_text,
                        "asr_debug": {
                            "segment_index": 0,
                            "started_at_epoch": None,
                            "started_at_wall": None,
                            "finished_at_epoch": None,
                            "finished_at_wall": None,
                            "elapsed_seconds": None,
                            "thread_name": None,
                            "attempts": 1,
                            "empty_segment": not bool(fallback_text),
                            "request_id": request_id,
                        },
                    }
                ],
                "timing_debug": {"available": False},
                "segment_workers_effective": 1,
                "request_id": request_id,
            }

        worker_count = max(1, int(self.config["segment_workers"]))
        logger.info(
            "[SEG-ASR] request_id=%s processing %s segments via batch inference (worker_count=%s, max_batch_size=%s)",
            request_id,
            len(segments),
            worker_count,
            self.config.get("asr_batch_size", "default"),
        )

        # ===== 批量推理：利用 Qwen3ASRModel 原生批处理能力 =====
        # 一次性裁剪所有片段，批量送入 GPU 推理，大幅提升吞吐量
        # 原顺序处理：10 片段 × 2 秒 = 20 秒，GPU 利用率极低
        # 批量处理：1 次调用 ≈ 2-3 秒，GPU 利用率大幅提升
        results_map: Dict[int, Dict[str, Any]] = {}

        # Step 1: 裁剪所有片段
        clips: List[np.ndarray] = []
        for idx, seg in enumerate(segments):
            clip = clip_audio(audio_data, sr, float(seg["start"]), float(seg["end"]))
            clips.append(clip)

        # Step 2: 批量转录（加锁串行化 + 超时保护 + 主动分批，避免 KV cache 并发污染）
        batch_start = time.time()
        batch_timeout = float(self.config.get("asr_timeout", 180))
        with self._asr_lock:
            try:
                with concurrent.futures.ThreadPoolExecutor(max_workers=1) as pool:
                    future = pool.submit(
                        self.asr.transcribe_batch,
                        [(clip, sr) for clip in clips],
                    )
                    batch_texts = future.result(timeout=batch_timeout)
            except concurrent.futures.TimeoutError:
                logger.error(
                    "[SEG-ASR][BATCH-TIMEOUT] request_id=%s timeout=%ss, "
                    "falling back to sequential per-segment transcription",
                    request_id, batch_timeout,
                )
                if torch.cuda.is_available():
                    torch.cuda.empty_cache()
                    torch.cuda.synchronize()
                batch_texts = []
                for idx, (clip, seg) in enumerate(zip(clips, segments)):
                    try:
                        result = transcribe_with_retry(
                            self.asr, clip, sr, idx, seg, request_id, 2,
                        )
                        batch_texts.append(result.get("text", ""))
                    except Exception as e2:
                        logger.error(
                            "[SEG-ASR][FAIL] request_id=%s idx=%s error=%s",
                            request_id, idx, e2,
                        )
                        batch_texts.append("")
            except Exception as e:
                logger.error(
                    "[SEG-ASR][BATCH-FAIL] request_id=%s error=%s, clearing cache & falling back to sequential",
                    request_id, e,
                )
                if torch.cuda.is_available():
                    torch.cuda.empty_cache()
                    torch.cuda.synchronize()
                batch_texts = []
                for idx, (clip, seg) in enumerate(zip(clips, segments)):
                    try:
                        result = transcribe_with_retry(
                            self.asr, clip, sr, idx, seg, request_id, 2,
                        )
                        batch_texts.append(result.get("text", ""))
                    except Exception as e2:
                        logger.error(
                            "[SEG-ASR][FAIL] request_id=%s idx=%s error=%s",
                            request_id, idx, e2,
                        )
                        batch_texts.append("")
            finally:
                self.asr.reset_kv_cache()

        batch_elapsed = time.time() - batch_start
        estimated_sequential = batch_elapsed * len(segments) if len(segments) > 1 else batch_elapsed
        logger.info(
            "[SEG-ASR][BATCH] request_id=%s segments=%s batch_elapsed=%.3fs "
            "(estimated sequential %.1fs, speedup ~%.1fx)",
            request_id, len(segments), batch_elapsed,
            estimated_sequential,
            estimated_sequential / batch_elapsed if batch_elapsed > 0 else 1.0,
        )

        # Step 3: 组装结果
        for idx, seg in enumerate(segments):
            text = batch_texts[idx] if idx < len(batch_texts) else ""
            results_map[idx] = {
                "start": float(seg["start"]),
                "end": float(seg["end"]),
                "speaker": str(seg["speaker"]),
                "type": str(seg.get("type", "single")),
                "text": str(text),
                "asr_debug": {
                    "segment_index": idx,
                    "started_at_epoch": None,
                    "started_at_wall": None,
                    "finished_at_epoch": None,
                    "finished_at_wall": None,
                    "elapsed_seconds": None,
                    "thread_name": None,
                    "attempts": 1,
                    "empty_segment": not bool(text),
                    "request_id": request_id,
                },
            }

        ordered_segments: List[Dict[str, Any]] = [results_map[i] for i in sorted(results_map.keys())]
        timing_debug = summarize_segment_timings(ordered_segments)
        if timing_debug.get("available"):
            logger.info(
                "[SEG-ASR][SUMMARY] request_id=%s mode=%s reason=%s smallest_start_gap_seconds=%s",
                request_id,
                timing_debug.get("execution_mode"),
                timing_debug.get("execution_reason"),
                timing_debug.get("smallest_start_gap_seconds"),
            )

        speaker_count = len({item["speaker"] for item in ordered_segments}) if ordered_segments else 0
        overall_text = "".join([item["text"] for item in ordered_segments if item["text"]])

        return {
            "input_file": input_filename,
            "speaker_count": speaker_count,
            "diarization_status": diarization_status,
            "overall_text": overall_text,
            "speaker_segments": ordered_segments,
            "timing_debug": timing_debug,
            "segment_workers_effective": worker_count,
            "request_id": request_id,
        }


# ===================================================================
# 流式识别管理器（vLLM 后端）
# ===================================================================


class StreamingManager:
    """
    流式识别管理器 — 封装 Qwen3-ASR vLLM 后端。

    提供三个核心操作：init_session / process_chunk / finish_session，
    与 core/streaming_session.py 配合实现 RESTful 流式 API。

    注意：
      - 仅支持 vLLM 后端（Qwen3ASRModel.LLM）
      - 不支持批量推理和时间戳
      - 音频格式：16kHz mono float32 PCM
    """

    def __init__(self, config: Dict[str, Any]) -> None:
        self.config = config
        self._model = None
        self._loaded = False
        self._load_lock = threading.Lock()
        logger.info("[STREAM] StreamingManager initialized (lazy-load mode)")

    def _ensure_loaded(self) -> None:
        """确保 vLLM 后端已加载（首次调用时懒加载）。"""
        if self._loaded:
            return
        with self._load_lock:
            if self._loaded:
                return

            model_path = str(self.config["asr_model_path"])
            gmu = float(self.config.get("vllm_gpu_memory_utilization", 0.6))
            max_new_tokens = int(self.config.get("vllm_max_new_tokens", 32))
            max_model_len = int(self.config.get("vllm_max_model_len", 4096))

            logger.info(
                "[STREAM] Lazy-loading vLLM backend: model=%s, gmu=%s, "
                "max_new_tokens=%s, max_model_len=%s",
                model_path, gmu, max_new_tokens, max_model_len,
            )

            try:
                from qwen_asr import Qwen3ASRModel
            except ImportError as e:
                raise RuntimeError(
                    "qwen-asr is not available. "
                    "Install with: pip install qwen-asr[vllm]"
                ) from e

            self._model = Qwen3ASRModel.LLM(
                model=model_path,
                gpu_memory_utilization=gmu,
                max_new_tokens=max_new_tokens,
                max_model_len=max_model_len,
            )
            self._loaded = True
            logger.info("[STREAM] vLLM backend loaded successfully")

    def init_session(
        self,
        language: str = "",
    ) -> Any:
        """
        初始化一个流式识别 session。

        Args:
            language: 可选，强制识别语言（如 "Chinese"）。空字符串表示自动检测。

        Returns:
            ASRStreamingState: 流式状态对象，需传递给 process_chunk 和 finish_session。
        """
        self._ensure_loaded()

        chunk_size_sec = float(self.config.get("stream_chunk_size_sec", 1.0))
        unfixed_chunk_num = int(self.config.get("stream_unfixed_chunk_num", 3))
        unfixed_token_num = int(self.config.get("stream_unfixed_token_num", 5))

        state = self._model.init_streaming_state(
            context="",
            language=language if language else None,
            unfixed_chunk_num=unfixed_chunk_num,
            unfixed_token_num=unfixed_token_num,
            chunk_size_sec=chunk_size_sec,
        )
        return state

    def process_chunk(
        self,
        state: Any,
        pcm_data: np.ndarray,
    ) -> None:
        """
        处理一段音频块，更新 state 中的识别结果。

        Args:
            state: init_session 返回的流式状态对象。
            pcm_data: 16kHz mono float32 PCM 音频数据。
        """
        if not self._loaded:
            raise RuntimeError("Streaming model not loaded. Call init_session first.")
        self._model.streaming_transcribe(pcm_data, state)

    def finish_session(self, state: Any) -> None:
        """
        结束流式识别，刷新剩余缓冲区并输出最终结果。
        state 中的 text/language 会被更新为最终值。
        """
        if not self._loaded:
            raise RuntimeError("Streaming model not loaded.")
        self._model.finish_streaming_transcribe(state)

    def close(self) -> None:
        """释放 vLLM 后端资源。"""
        if self._model is not None:
            logger.info("[STREAM] Releasing vLLM backend resources...")
            del self._model
            self._model = None
            self._loaded = False
            if torch.cuda.is_available():
                torch.cuda.empty_cache()
                torch.cuda.synchronize()
            logger.info("[STREAM] vLLM backend released")
