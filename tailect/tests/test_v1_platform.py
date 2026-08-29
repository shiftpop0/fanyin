"""Offline contract tests that do not load GPU models or start HTTP services."""

from __future__ import annotations

import asyncio
import json
import tempfile
import unittest
from pathlib import Path

from core.audio_input import HotReloadAllowlist, audio_url_host_allowed, validate_audio_url
from core.translator_store import TranslatorStore
from core.security import RateLimiter, authorize, resolve_client_ip
from core.v1_adapter import FifoInferenceQueue, transcribe_platform_audio
from core.v1_contract import V1ApiError, build_caption_rows, require_model_alias


RUNTIME_ROOT = Path(__file__).resolve().parents[1] / "outputs" / "test_v1_platform"
RUNTIME_ROOT.mkdir(parents=True, exist_ok=True)


class ContractTests(unittest.TestCase):
    def test_only_v41_alias_is_accepted(self) -> None:
        self.assertEqual(require_model_alias("Tailect_V4.1"), "Tailect_V4.1")
        self.assertEqual(require_model_alias("v4.1"), "Tailect_V4.1")
        with self.assertRaises(V1ApiError):
            require_model_alias("Taizhou")

    def test_caption_rows_use_local_alignment_and_diarization(self) -> None:
        rows = build_caption_rows(
            full_text="你好，世界。",
            timestamps=[
                {"start": 0.1, "end": 0.5, "text": "你好"},
                {"start": 0.6, "end": 1.0, "text": "世界"},
            ],
            speaker_segments=[
                {"start": 0.0, "end": 0.55, "speaker": "speaker-a"},
                {"start": 0.55, "end": 1.2, "speaker": "speaker-b"},
            ],
            max_chars=40,
            split_by_punctuation=True,
        )
        self.assertEqual(rows[0], {"lid": "1", "text": "你好，", "begin": 100, "end": 500})
        self.assertEqual(rows[1], {"lid": "2", "text": "世界。", "begin": 600, "end": 1000})

    def test_caption_rows_support_japanese_and_korean_letters(self) -> None:
        rows = build_caption_rows(
            full_text="こんにちは。안녕하세요.",
            timestamps=[
                {"start": 0.0, "end": 0.8, "text": "こんにちは"},
                {"start": 0.9, "end": 1.8, "text": "안녕하세요"},
            ],
            max_chars=40,
            split_by_punctuation=True,
        )
        self.assertEqual(len(rows), 2)
        self.assertEqual(rows[0]["end"], 800)
        self.assertEqual(rows[1]["begin"], 900)

    def test_adapter_uses_local_aligner_and_optional_diarization(self) -> None:
        calls = []

        class FakeService:
            def asr_raw(self, _path: str):
                calls.append("asr")
                return {"text": "你好。", "language": "Chinese"}

            def forced_align(self, _path: str, text: str, language: str):
                calls.append(("align", text, language))
                return {"segments": [{"start": 0.2, "end": 0.9, "text": "你好"}]}

            def diarization_only(self, _path: str):
                calls.append("diarization")
                return {"segments": [{"start": 0.0, "end": 1.0, "speaker": "speaker-x"}]}

        result = transcribe_platform_audio(
            FakeService(), "sample.wav", language="Chinese", diarize=True,
            max_chars=40, split_by_punctuation=True,
            config={"v1_default_language": "Chinese", "v1_diarization_fallback": True},
        )
        self.assertEqual(result["language"], "zh")
        self.assertEqual(result["rows"], [{"lid": "1", "text": "你好。", "begin": 200, "end": 900}])
        self.assertEqual(calls, ["asr", ("align", "你好。", "Chinese"), "diarization"])


class AllowlistTests(unittest.TestCase):
    def test_matching_rules_and_hot_reload_fail_closed(self) -> None:
        self.assertTrue(audio_url_host_allowed("audio.internal", ["audio.internal"]))
        self.assertTrue(audio_url_host_allowed("a.media.internal", ["*.media.internal"]))
        self.assertTrue(audio_url_host_allowed("10.20.1.8", ["10.20.0.0/16"]))
        self.assertFalse(audio_url_host_allowed("example.com", ["*.media.internal"]))

        root = Path(tempfile.mkdtemp(prefix="allowlist_", dir=RUNTIME_ROOT))
        path = root / "allowlist.json"
        allowlist = HotReloadAllowlist(path)
        self.assertFalse(allowlist.status()["loaded"])
        path.write_text(json.dumps({"allow_hosts": ["audio.internal"]}), encoding="utf-8")
        self.assertEqual(validate_audio_url("http://audio.internal/a.wav", allowlist.rules()), "http://audio.internal/a.wav")
        path.write_text("{invalid", encoding="utf-8")
        self.assertFalse(allowlist.status()["loaded"])
        with self.assertRaises(V1ApiError):
            validate_audio_url("http://audio.internal/a.wav", allowlist.rules())


class TranslatorStoreTests(unittest.TestCase):
    def test_save_read_and_feedback(self) -> None:
        root = Path(tempfile.mkdtemp(prefix="translator_", dir=RUNTIME_ROOT))
        store = TranslatorStore(root)
        csv_text = "segment_no,text,corrected_text,is_corrected,updated_at\n1,原文,,,\n"
        saved = store.save(
            {"record_key": "case-1", "csv_filename": "case-1.csv", "csv_text": csv_text},
            "10.1.2.3",
        )
        self.assertEqual(saved["server_revision"], 1)
        current = store.status({"record_key": "case-1", "filename": "case-1.csv"}, "10.1.2.3", True)
        self.assertTrue(current["exists"])
        self.assertIn("原文", current["csv_text"])
        corrected = store.feedback(
            {
                "record_key": "case-1", "csv_filename": "case-1.csv",
                "segment_no": 1, "corrected_text": "修正文",
            },
            "10.1.2.3",
        )
        self.assertEqual(corrected["server_revision"], 2)
        final = store.status({"record_key": "case-1", "filename": "case-1.csv"}, "10.1.2.3", True)
        self.assertIn("修正文", final["csv_text"])

    def test_filename_cannot_escape_client_directory(self) -> None:
        root = Path(tempfile.mkdtemp(prefix="translator_path_", dir=RUNTIME_ROOT))
        store = TranslatorStore(root)
        saved = store.save(
            {"record_key": "case-2", "csv_filename": "../../outside.csv", "csv_text": "a\n"},
            "10.2.3.4",
        )
        self.assertEqual(saved["csv_filename"], "outside.csv")
        self.assertTrue(Path(saved["csv_path"]).is_relative_to(root.resolve()))


class SecurityTests(unittest.TestCase):
    def test_trusted_proxy_and_rate_limit(self) -> None:
        self.assertEqual(
            resolve_client_ip(
                peer_host="127.0.0.1", headers={"x-forwarded-for": "10.9.8.7, 127.0.0.1"},
                trusted_proxy_hosts=["127.0.0.1"],
            ),
            "10.9.8.7",
        )
        self.assertEqual(
            resolve_client_ip(
                peer_host="10.0.0.5", headers={"x-forwarded-for": "spoofed"},
                trusted_proxy_hosts=["127.0.0.1"],
            ),
            "10.0.0.5",
        )
        limiter = RateLimiter(1)
        limiter.check("client")
        with self.assertRaises(V1ApiError):
            limiter.check("client")

    def test_optional_api_key(self) -> None:
        import os

        env_name = "TAILECT_TEST_API_KEY"
        os.environ[env_name] = "secret-for-test"
        try:
            authorize({"v1_api_key_env": env_name}, {"X-API-Key": "secret-for-test"}, {})
            with self.assertRaises(V1ApiError):
                authorize({"v1_api_key_env": env_name}, {"X-API-Key": "wrong"}, {})
        finally:
            os.environ.pop(env_name, None)


class QueueTests(unittest.IsolatedAsyncioTestCase):
    async def test_fifo_and_single_concurrency(self) -> None:
        queue = FifoInferenceQueue(max_waiters=8, timeout_sec=2)
        order = []

        async def worker(number: int) -> None:
            async with queue.slot():
                order.append(number)
                await asyncio.sleep(0.01)

        await asyncio.gather(*(worker(index) for index in range(5)))
        self.assertEqual(order, [0, 1, 2, 3, 4])
        self.assertEqual(queue.status()["completed"], 5)


if __name__ == "__main__":
    unittest.main()
