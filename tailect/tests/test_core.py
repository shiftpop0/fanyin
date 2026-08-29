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
        )

        self.assertTrue(callable(install_numpy_compat_shim))
        self.assertTrue(callable(install_torchaudio_compat_shim))
        self.assertTrue(callable(patch_mistral_tokenizer))

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
        )

        self.assertTrue(callable(resolve_diarization_project_path))
        self.assertTrue(callable(summarize_segment_timings))
        self.assertTrue(callable(transcribe_with_retry))

    def test_resolve_diarization_project_path_invalid(self):
        from core.inference_engine import resolve_diarization_project_path

        with self.assertRaises(RuntimeError):
            resolve_diarization_project_path("/nonexistent/path")


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
