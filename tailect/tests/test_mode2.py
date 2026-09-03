"""6006 mode 参数和独立离线 VAD 的轻量单元测试。"""

import os
import sys
import unittest
import ast
from pathlib import Path

import numpy as np


_PROJECT_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if _PROJECT_DIR not in sys.path:
    sys.path.insert(0, _PROJECT_DIR)


class ModeParameterTests(unittest.TestCase):
    def test_mode_and_legacy_parameter_are_strictly_mutually_exclusive(self) -> None:
        from core.mode import ModeParameterError, resolve_asr_mode

        for mode in (1, 2):
            for diarization in (False, True):
                with self.subTest(mode=mode, diarization=diarization):
                    with self.assertRaisesRegex(ModeParameterError, "cannot be used together"):
                        resolve_asr_mode(mode, diarization)

    def test_supported_modes_and_legacy_routes(self) -> None:
        from core.mode import resolve_asr_mode

        self.assertEqual(resolve_asr_mode(1, None), 1)
        self.assertEqual(resolve_asr_mode(2, None), 2)
        self.assertEqual(resolve_asr_mode(None, True), 1)
        self.assertIsNone(resolve_asr_mode(None, False))
        self.assertIsNone(resolve_asr_mode(None, None))

    def test_unknown_or_non_integer_mode_is_rejected(self) -> None:
        from core.mode import ModeParameterError, resolve_asr_mode

        for value in (0, 3, -1, True, "2"):
            with self.subTest(value=value):
                with self.assertRaises(ModeParameterError):
                    resolve_asr_mode(value, None)  # type: ignore[arg-type]

    def test_dispatch_routes_mode1_mode2_and_legacy_without_cross_calls(self) -> None:
        from core.mode import dispatch_asr_mode

        class FakeService:
            def __init__(self) -> None:
                self.calls = []

            def diarization_then_asr(self, **kwargs):
                self.calls.append(("mode1", kwargs))
                return {"overall_text": "mode1"}

            def transcribe_vad_segments(self, **kwargs):
                self.calls.append(("mode2", kwargs))
                return {"mode": 2, "overall_text": "mode2"}

            def asr_raw(self, audio_path):
                self.calls.append(("legacy", audio_path))
                return {"text": "legacy", "language": ""}

        service = FakeService()
        self.assertEqual(
            dispatch_asr_mode(service, 1, "a.wav", "a.wav")["overall_text"],
            "mode1",
        )
        self.assertEqual(
            dispatch_asr_mode(service, 2, "b.wav", "b.wav")["overall_text"],
            "mode2",
        )
        self.assertEqual(
            dispatch_asr_mode(service, None, "c.wav", "c.wav")["text"],
            "legacy",
        )
        self.assertEqual([item[0] for item in service.calls], ["mode1", "mode2", "legacy"])


class OfflineVadTests(unittest.TestCase):
    def test_normalization_sorts_clamps_deduplicates_and_splits(self) -> None:
        from core.vad import normalize_offline_vad_segments

        raw = [
            {
                "value": [
                    [9000, 15000],
                    [-100, 1000],
                    [500, 2500],
                    [3000, 9000],
                    [15000, 25000],
                    [4000, 4000],
                    ["bad", 5000],
                ]
            }
        ]
        segments = normalize_offline_vad_segments(
            raw,
            audio_duration_seconds=20.0,
            max_segment_seconds=5.0,
        )

        self.assertEqual(
            segments,
            [
                {"start": 0.0, "end": 1.0, "type": "single"},
                {"start": 1.0, "end": 2.5, "type": "single"},
                {"start": 3.0, "end": 8.0, "type": "single"},
                {"start": 8.0, "end": 9.0, "type": "single"},
                {"start": 9.0, "end": 14.0, "type": "single"},
                {"start": 14.0, "end": 15.0, "type": "single"},
                {"start": 15.0, "end": 20.0, "type": "single"},
            ],
        )

    def test_empty_vad_result_is_no_speech(self) -> None:
        from core.vad import normalize_offline_vad_segments

        self.assertEqual(
            normalize_offline_vad_segments([], audio_duration_seconds=10.0),
            [],
        )

    def test_unsupported_vad_structure_is_rejected(self) -> None:
        from core.vad import normalize_offline_vad_segments

        with self.assertRaisesRegex(RuntimeError, "unsupported result structure"):
            normalize_offline_vad_segments(
                [{"unexpected": []}],
                audio_duration_seconds=10.0,
            )

    def test_offline_wrapper_uses_injected_model_and_requires_16k(self) -> None:
        from core.vad import OfflineVADWrapper

        class FakeVadModel:
            def __init__(self) -> None:
                self.calls = []

            def generate(self, **kwargs):
                self.calls.append(kwargs)
                return [{"value": [[100, 900]]}]

        model = FakeVadModel()
        wrapper = OfflineVADWrapper(
            "unused-in-test",
            "cpu",
            5,
            model=model,
        )
        audio = np.zeros((16000,), dtype=np.float32)
        self.assertEqual(
            wrapper.detect(audio, 16000),
            [{"start": 0.1, "end": 0.9, "type": "single"}],
        )
        self.assertEqual(len(model.calls), 1)
        self.assertIn("input", model.calls[0])

        with self.assertRaisesRegex(RuntimeError, "requires 16000 Hz"):
            wrapper.detect(audio, 8000)


class Mode2IsolationTests(unittest.TestCase):
    def test_mode2_service_method_has_no_diarization_or_aligner_call(self) -> None:
        source_path = Path(_PROJECT_DIR) / "core" / "inference_engine.py"
        module = ast.parse(source_path.read_text(encoding="utf-8"))
        method = None
        for node in ast.walk(module):
            if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)) and node.name == "transcribe_vad_segments":
                method = node
                break
        self.assertIsNotNone(method)

        attributes = {
            node.attr
            for node in ast.walk(method)
            if isinstance(node, ast.Attribute)
        }
        self.assertNotIn("diarization", attributes)
        self.assertNotIn("diarization_only", attributes)
        self.assertNotIn("forced_align", attributes)
        self.assertNotIn("asr_raw", attributes)


if __name__ == "__main__":
    unittest.main()
