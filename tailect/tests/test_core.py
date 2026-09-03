"""
单元测试 — 验证重构后各模块的导入与基础功能。
运行方式:
    cd asr_offline
    python -m pytest tests/test_core.py -v
    或
    python -m unittest tests.test_core
"""

import os
import sys
import unittest

# 确保项目根目录在 PYTHONPATH 中
_SCRIPT_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if _SCRIPT_DIR not in sys.path:
    sys.path.insert(0, _SCRIPT_DIR)


class TestConfig(unittest.TestCase):
    """测试配置模块"""

    def test_import_config(self):
        from core.config import CONFIG, get_config

        self.assertIn("asr_model_path", CONFIG)
        self.assertIn("server_host", CONFIG)
        self.assertIn("server_port", CONFIG)
        self.assertEqual(CONFIG["server_port"], 6006)
        self.assertIn("vad_model_path", CONFIG)
        self.assertEqual(CONFIG["vad_max_segment_seconds"], 60.0)

    def test_get_config_returns_copy(self):
        from core.config import CONFIG, get_config

        cfg = get_config()
        self.assertIsInstance(cfg, dict)
        # 修改副本不应影响原配置
        cfg["test_key"] = "test"
        self.assertNotIn("test_key", CONFIG)


class TestLogger(unittest.TestCase):
    """测试日志模块"""

    def test_import_logger(self):
        from core.logger import logger

        self.assertEqual(logger.name, "unified_asr_diarization")


class TestDeviceUtils(unittest.TestCase):
    """测试设备工具模块"""

    def setUp(self):
        from core.device_utils import resolve_device, resolve_dtype

        self.resolve_device = resolve_device
        self.resolve_dtype = resolve_dtype

    def test_resolve_device_auto(self):
        self.assertEqual(self.resolve_device("auto"), "auto")

    def test_resolve_device_cpu(self):
        self.assertEqual(self.resolve_device("cpu"), "cpu")

    def test_resolve_device_cuda(self):
        self.assertEqual(self.resolve_device("cuda"), "cuda:0")

    def test_resolve_device_cuda_with_index(self):
        self.assertEqual(self.resolve_device("cuda:1"), "cuda:1")

    def test_resolve_device_fallback(self):
        result = self.resolve_device("unknown")
        self.assertEqual(result, "auto")

    def test_resolve_dtype_float32(self):
        import torch

        self.assertEqual(self.resolve_dtype("float32"), torch.float32)

    def test_resolve_dtype_bfloat16(self):
        import torch

        self.assertEqual(self.resolve_dtype("bfloat16"), torch.bfloat16)

    def test_resolve_dtype_float16(self):
        import torch

        self.assertEqual(self.resolve_dtype("float16"), torch.float16)


class TestAudioProcessor(unittest.TestCase):
    """测试音频处理模块"""

    def test_import_audio_processor(self):
        from core.audio_processor import clip_audio, format_wall_time

        self.assertTrue(callable(clip_audio))
        self.assertTrue(callable(format_wall_time))

    def test_clip_audio(self):
        import numpy as np
        from core.audio_processor import clip_audio

        audio = np.array([1.0, 2.0, 3.0, 4.0, 5.0], dtype=np.float32)
        clipped = clip_audio(audio, sr=10, start_sec=0.1, end_sec=0.4)
        self.assertEqual(len(clipped), 3)

    def test_format_wall_time(self):
        from core.audio_processor import format_wall_time

        result = format_wall_time(1000000.0)
        self.assertIsInstance(result, str)
        self.assertIn("T", result)  # ISO format contains T


class TestModelLoader(unittest.TestCase):
    """测试模型加载模块（仅测试可导入性和辅助函数）"""

    def test_import_model_loader(self):
        from core.model_loader import (
            install_numpy_compat_shim,
            install_torchaudio_compat_shim,
            patch_mistral_tokenizer,
            load_vad_model,
        )

        self.assertTrue(callable(install_numpy_compat_shim))
        self.assertTrue(callable(install_torchaudio_compat_shim))
        self.assertTrue(callable(patch_mistral_tokenizer))
        self.assertTrue(callable(load_vad_model))

    def test_install_numpy_compat_shim(self):
        import numpy as np
        from core.model_loader import install_numpy_compat_shim

        original_present = "NaN" in np.__dict__
        original_value = np.__dict__.get("NaN")
        try:
            np.__dict__.pop("NaN", None)
            install_numpy_compat_shim()
            self.assertIn("NaN", np.__dict__)
            self.assertTrue(np.isnan(np.__dict__["NaN"]))
        finally:
            if original_present:
                np.__dict__["NaN"] = original_value
            else:
                np.__dict__.pop("NaN", None)

    def test_install_torchaudio_compat_shim(self):
        from core.model_loader import install_torchaudio_compat_shim

        # 应该不会抛出异常
        install_torchaudio_compat_shim()

    def test_patch_mistral_tokenizer(self):
        from core.model_loader import patch_mistral_tokenizer

        # 应该不会抛出异常（如果 transformers 未安装则静默跳过）
        patch_mistral_tokenizer()


class TestInferenceEngine(unittest.TestCase):
    """测试推理引擎模块（仅测试可导入性和接口存在性）"""

    def test_import_all_classes(self):
        from core.inference_engine import (
            ASRWrapper,
            DiarizationWrapper,
            ForcedAlignWrapper,
            PunctuationRestorer,
            UnifiedService,
            resolve_diarization_project_path,
            summarize_segment_timings,
            transcribe_with_retry,
            read_audio_mono_16k,
        )
        from core.vad import OfflineVADWrapper

        self.assertTrue(callable(resolve_diarization_project_path))
        self.assertTrue(callable(summarize_segment_timings))
        self.assertTrue(callable(transcribe_with_retry))
        self.assertTrue(callable(read_audio_mono_16k))
        self.assertTrue(OfflineVADWrapper)

    def test_resolve_diarization_project_path_invalid(self):
        from core.inference_engine import resolve_diarization_project_path

        with self.assertRaises(RuntimeError):
            resolve_diarization_project_path("/nonexistent/path")

    def test_native_6006_wrapper_keeps_public_response_shape(self):
        from core.inference_engine import UnifiedService

        service = UnifiedService.__new__(UnifiedService)
        service.transcribe_diarized_segments = lambda *_args, **_kwargs: {
            "input_file": "sample.wav",
            "speaker_count": 1,
            "diarization_status": "ok",
            "overall_text": "你好",
            "speaker_segments": [],
            "timing_debug": {"available": False},
            "segment_workers_effective": 32,
            "request_id": "request-id",
            "detected_languages": ["Chinese"],
        }

        result = UnifiedService.diarization_then_asr(service, "sample.wav", "sample.wav")

        self.assertNotIn("detected_languages", result)
        self.assertEqual(result["overall_text"], "你好")
        self.assertEqual(result["segment_workers_effective"], 32)

    def test_batch_detailed_preserves_language_and_legacy_text_contract(self):
        from core.inference_engine import ASRWrapper

        class FakeResult:
            def __init__(self, text, language):
                self.text = text
                self.language = language

        wrapper = ASRWrapper.__new__(ASRWrapper)
        wrapper.model = object()
        wrapper.batch_size = 48
        wrapper._prepare_audio_input = lambda item: item
        wrapper._call_model_transcribe = lambda items: [
            FakeResult(f"text-{index}", "Chinese") for index, _item in enumerate(items)
        ]

        detailed = wrapper.transcribe_batch_detailed(["a.wav", "b.wav"])
        texts = wrapper.transcribe_batch(["a.wav", "b.wav"])

        self.assertEqual(
            detailed,
            [
                {"text": "text-0", "language": "Chinese"},
                {"text": "text-1", "language": "Chinese"},
            ],
        )
        self.assertEqual(texts, ["text-0", "text-1"])

    def test_mode2_uses_vad_segments_without_diarization(self):
        from unittest.mock import patch

        from core.inference_engine import UnifiedService

        class FakeVad:
            def detect(self, audio, sample_rate):
                self.audio = audio
                self.sample_rate = sample_rate
                return [
                    {"start": 0.0, "end": 0.5, "type": "single"},
                    {"start": 0.5, "end": 1.0, "type": "single"},
                ]

        class ForbiddenDiarization:
            def __getattr__(self, name):
                raise AssertionError(f"mode=2 must not access diarization: {name}")

        class FakeAsr:
            def transcribe_batch_detailed(self, _items, *, raise_on_failure=False):
                self.raise_on_failure = raise_on_failure
                return [
                    {"text": "你好。", "language": "Chinese"},
                    {"text": "世界。", "language": "Chinese"},
                ]

            def reset_kv_cache(self):
                return None

        import threading
        import numpy as np

        service = UnifiedService.__new__(UnifiedService)
        service.config = {
            "asr_target_sample_rate": 16000,
            "segment_workers": 32,
            "asr_batch_size": 32,
            "asr_timeout": 30,
        }
        service.vad = FakeVad()
        service.vad_init_error = None
        service.diarization = ForbiddenDiarization()
        service.asr = FakeAsr()
        service._asr_lock = threading.Lock()

        audio = np.zeros((16000,), dtype=np.float32)
        with patch("core.inference_engine.read_audio_mono_16k", return_value=(audio, 16000)):
            result = UnifiedService.transcribe_vad_segments(
                service,
                "sample.wav",
                "sample.wav",
            )

        self.assertEqual(result["mode"], 2)
        self.assertEqual(result["overall_text"], "你好。世界。")
        self.assertEqual(result["segment_count"], 2)
        self.assertEqual(result["completed_segment_count"], 2)
        self.assertTrue(service.asr.raise_on_failure)
        self.assertNotIn("speaker", result["segments"][0])


class TestAPIServer(unittest.TestCase):
    """测试 API 服务模块"""

    def test_import_app(self):
        from core.api_server import app, find_and_kill_process_on_port

        self.assertEqual(app.title, "Unified ASR + Diarization Service")
        self.assertTrue(callable(find_and_kill_process_on_port))

    def test_app_routes_exist(self):
        from core.api_server import app

        routes = [route.path for route in app.routes]
        self.assertIn("/health", routes)
        self.assertIn("/asr", routes)
        self.assertIn("/diarization", routes)
        self.assertIn("/asr_raw", routes)
        self.assertIn("/forced_align", routes)
        self.assertIn("/punctuation", routes)

    def test_asr_route_dispatches_mode1_and_mode2(self):
        from unittest.mock import patch

        from core import api_server

        class FakeUpload:
            filename = "sample.wav"

        class FakeService:
            def __init__(self):
                self.calls = []

            def diarization_then_asr(self, **kwargs):
                self.calls.append(("mode1", kwargs))
                return {"overall_text": "mode1"}

            def transcribe_vad_segments(self, **kwargs):
                self.calls.append(("mode2", kwargs))
                return {"mode": 2, "overall_text": "mode2", "segments": []}

            def asr_raw(self, path):
                self.calls.append(("raw", path))
                return {"text": "raw", "language": ""}

        service = FakeService()
        with (
            patch.object(api_server, "SERVICE", service),
            patch.object(api_server, "save_upload_file", return_value="sample.wav"),
            patch.object(api_server, "ensure_wav_audio", return_value="sample.wav"),
            patch.object(api_server, "safe_remove"),
        ):
            mode1 = api_server.asr_api(mode=1, diarization=None, file=FakeUpload())
            mode2 = api_server.asr_api(mode=2, diarization=None, file=FakeUpload())
            legacy = api_server.asr_api(mode=None, diarization=False, file=FakeUpload())

        self.assertEqual(mode1["overall_text"], "mode1")
        self.assertEqual(mode2["overall_text"], "mode2")
        self.assertEqual(legacy["text"], "raw")
        self.assertEqual([item[0] for item in service.calls], ["mode1", "mode2", "raw"])

    def test_asr_route_rejects_mode_and_diarization_together_before_upload(self):
        from unittest.mock import patch

        from fastapi import HTTPException
        from core import api_server

        class FakeUpload:
            filename = "sample.wav"

        with (
            patch.object(api_server, "SERVICE", object()),
            patch.object(api_server, "save_upload_file") as save_upload,
        ):
            with self.assertRaises(HTTPException) as raised:
                api_server.asr_api(mode=1, diarization=True, file=FakeUpload())

        self.assertEqual(raised.exception.status_code, 400)
        self.assertIn("cannot be used together", raised.exception.detail)
        save_upload.assert_not_called()


class TestMainWrapper(unittest.TestCase):
    """测试主入口包装器模块"""

    def test_import_main_module(self):
        """验证主文件可以正常导入且导出所有预期接口"""
        import importlib
        import sys

        # 确保模块名在 sys.modules 中未缓存
        module_name = "unified_asr_diarization_transformer_offline"
        if module_name in sys.modules:
            del sys.modules[module_name]

        module = importlib.import_module(module_name)

        # 验证主要类/函数可导入
        self.assertTrue(hasattr(module, "CONFIG"))
        self.assertTrue(hasattr(module, "ASRWrapper"))
        self.assertTrue(hasattr(module, "DiarizationWrapper"))
        self.assertTrue(hasattr(module, "ForcedAlignWrapper"))
        self.assertTrue(hasattr(module, "PunctuationRestorer"))
        self.assertTrue(hasattr(module, "UnifiedService"))
        self.assertTrue(hasattr(module, "app"))
        self.assertTrue(hasattr(module, "logger"))


if __name__ == "__main__":
    unittest.main()
