"""Offline contract tests that do not load GPU models or start HTTP services."""

from __future__ import annotations

import asyncio
import inspect
import json
import os
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from core.audio_input import (
    HotReloadAllowlist,
    audio_url_host_allowed,
    cleanup_request_uploads,
    download_wav_url,
    validate_audio_url,
)
from core.translator_store import TranslatorStore
from core.security import RateLimiter, authorize, resolve_client_ip
from core.v1_adapter import FifoInferenceQueue, transcribe_platform_audio
from core.v1_contract import (
    V1ApiError,
    build_caption_rows,
    build_diarized_caption_rows,
    forced_aligner_language,
    reject_removed_v1_parameters,
    require_model_alias,
)


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
            split_by_punctuation=True,
        )
        self.assertEqual(len(rows), 2)
        self.assertEqual(rows[0]["end"], 800)
        self.assertEqual(rows[1]["begin"], 900)

    def test_caption_rows_split_on_native_speaker_boundaries(self) -> None:
        rows = build_caption_rows(
            full_text="你好世界",
            timestamps=[
                {"start": 0.1, "end": 0.5, "text": "你好"},
                {"start": 0.6, "end": 1.0, "text": "世界"},
            ],
            speaker_segments=[
                {"start": 0.0, "end": 0.55, "speaker": "speaker-a", "text": "你好"},
                {"start": 0.55, "end": 1.2, "speaker": "speaker-b", "text": "世界"},
            ],
            split_by_punctuation=False,
        )
        self.assertEqual(
            rows,
            [
                {"lid": "1", "text": "你好", "begin": 100, "end": 500},
                {"lid": "2", "text": "世界", "begin": 600, "end": 1000},
            ],
        )

    def test_caption_rows_reject_incomplete_alignment(self) -> None:
        with self.assertRaisesRegex(V1ApiError, "did not cover the full transcript") as raised:
            build_caption_rows(
                full_text="你好世界",
                timestamps=[{"start": 0.1, "end": 0.5, "text": "你好"}],
            )
        self.assertEqual(raised.exception.error_id, "E016")

    def test_diarized_rows_preserve_native_text_and_timestamps(self) -> None:
        rows = build_diarized_caption_rows(
            full_text="第一句。 第二句。",
            speaker_segments=[
                {"start": 0.1, "end": 0.8, "speaker": "speaker-a", "text": "第一句。 "},
                {"start": 0.9, "end": 1.6, "speaker": "speaker-b", "text": "第二句。"},
            ],
        )
        self.assertEqual(
            rows,
            [
                {"lid": "1", "text": "第一句。 ", "begin": 100, "end": 800},
                {"lid": "2", "text": "第二句。", "begin": 900, "end": 1600},
            ],
        )
        self.assertEqual("".join(row["text"] for row in rows).strip(), "第一句。 第二句。")

    def test_diarized_rows_reject_text_mismatch(self) -> None:
        with self.assertRaisesRegex(V1ApiError, "did not preserve the full transcript") as raised:
            build_diarized_caption_rows(
                full_text="你好世界",
                speaker_segments=[
                    {"start": 0.0, "end": 0.5, "speaker": "speaker-a", "text": "你好"},
                ],
            )
        self.assertEqual(raised.exception.error_id, "E016")

    def test_forced_aligner_language_maps_dialect_to_supported_fallback(self) -> None:
        self.assertEqual(forced_aligner_language("Tiantai", "Chinese"), "Chinese")
        self.assertEqual(forced_aligner_language("Wu language", "Chinese"), "Chinese")
        self.assertEqual(forced_aligner_language("en", "Chinese"), "English")
        self.assertEqual(forced_aligner_language("Cantonese", "Chinese"), "Cantonese")

    def test_adapter_reuses_native_diarized_rows_without_global_alignment(self) -> None:
        calls = []

        class FakeService:
            def transcribe_diarized_segments(
                self,
                _path: str,
                input_filename: str,
                *,
                allow_diarization_fallback: bool,
            ):
                calls.append(("native-diarized-asr", input_filename, allow_diarization_fallback))
                return {
                    "overall_text": "你好。世界。",
                    "speaker_segments": [
                        {"start": 0.0, "end": 0.55, "speaker": "speaker-a", "text": "你好。"},
                        {"start": 0.55, "end": 1.2, "speaker": "speaker-b", "text": "世界。"},
                    ],
                    "detected_languages": ["Tiantai", "Tiantai"],
                }

            def forced_align(self, _path: str, text: str, language: str):
                raise AssertionError(f"global alignment must not run: {text=} {language=}")

        result = transcribe_platform_audio(
            FakeService(), "sample.wav", diarize=True,
            split_by_punctuation=True,
            config={"v1_alignment_fallback_language": "Chinese", "v1_diarization_fallback": False},
        )
        self.assertEqual(result["language"], "tiantai")
        self.assertEqual(
            result["rows"],
            [
                {"lid": "1", "text": "你好。", "begin": 0, "end": 550},
                {"lid": "2", "text": "世界。", "begin": 550, "end": 1200},
            ],
        )
        self.assertEqual(
            calls,
            [
                ("native-diarized-asr", "sample.wav", False),
            ],
        )

    def test_adapter_keeps_whole_audio_asr_when_diarize_is_disabled(self) -> None:
        calls = []

        class FakeService:
            def asr_raw(self, _path: str):
                calls.append("asr")
                return {"text": "你好。", "language": "Chinese"}

            def forced_align(self, _path: str, text: str, language: str):
                calls.append(("align", text, language))
                return {"segments": [{"start": 0.2, "end": 0.9, "text": "你好"}]}

        result = transcribe_platform_audio(
            FakeService(), "sample.wav", diarize=False,
            split_by_punctuation=True,
            config={"v1_alignment_fallback_language": "Chinese", "v1_diarization_fallback": False},
        )
        self.assertEqual(result["rows"], [{"lid": "1", "text": "你好。", "begin": 200, "end": 900}])
        self.assertEqual(calls, ["asr", ("align", "你好。", "Chinese")])

    def test_non_diarized_dialect_response_uses_chinese_for_alignment(self) -> None:
        calls = []

        class FakeService:
            def asr_raw(self, _path: str):
                return {"text": "方言文本。", "language": "Tiantai"}

            def forced_align(self, _path: str, text: str, language: str):
                calls.append((text, language))
                return {"segments": [{"start": 0.1, "end": 0.8, "text": "方言文本"}]}

        result = transcribe_platform_audio(
            FakeService(), "sample.wav", diarize=False,
            split_by_punctuation=True,
            config={"v1_alignment_fallback_language": "Chinese", "v1_diarization_fallback": False},
        )
        self.assertEqual(result["language"], "tiantai")
        self.assertEqual(calls, [("方言文本。", "Chinese")])

    def test_diarization_failure_is_not_hidden_when_fallback_is_disabled(self) -> None:
        class FakeService:
            def transcribe_diarized_segments(
                self,
                _path: str,
                _input_filename: str,
                *,
                allow_diarization_fallback: bool,
            ):
                self.allow_diarization_fallback = allow_diarization_fallback
                raise RuntimeError("TargetDiarization unavailable")

        with self.assertRaisesRegex(RuntimeError, "TargetDiarization unavailable"):
            transcribe_platform_audio(
                FakeService(), "sample.wav", diarize=True,
                split_by_punctuation=True,
                config={"v1_alignment_fallback_language": "Chinese", "v1_diarization_fallback": False},
            )

    def test_removed_max_chars_parameter_is_rejected(self) -> None:
        with self.assertRaises(V1ApiError) as raised:
            reject_removed_v1_parameters({"max_chars": "40"})
        self.assertEqual(raised.exception.error_id, "E017")

    def test_request_language_is_accepted_but_not_forwarded_to_adapter(self) -> None:
        reject_removed_v1_parameters(
            {"model": "Tailect_V4.1", "language": "English", "diarize": "1"}
        )
        self.assertNotIn("language", inspect.signature(transcribe_platform_audio).parameters)


class AllowlistTests(unittest.TestCase):
    def test_completed_request_uploads_are_not_retained(self) -> None:
        root = Path(tempfile.mkdtemp(prefix="upload_cleanup_", dir=RUNTIME_ROOT))
        request_dir = root / "request-id"
        request_dir.mkdir()
        (request_dir / "audio.wav").write_bytes(b"transient")
        (request_dir / "audio_converted.wav").write_bytes(b"transient-converted")

        cleanup_request_uploads(request_dir, root)

        self.assertFalse(request_dir.exists())

    def test_upload_cleanup_refuses_paths_outside_direct_root(self) -> None:
        root = Path(tempfile.mkdtemp(prefix="upload_cleanup_root_", dir=RUNTIME_ROOT))
        outside = Path(tempfile.mkdtemp(prefix="upload_cleanup_outside_", dir=RUNTIME_ROOT))
        with self.assertRaises(ValueError):
            cleanup_request_uploads(outside, root)

    def test_upload_cleanup_refuses_nested_directories_without_partial_cleanup(self) -> None:
        root = Path(tempfile.mkdtemp(prefix="upload_cleanup_nested_", dir=RUNTIME_ROOT))
        request_dir = root / "request-id"
        nested = request_dir / "unexpected"
        nested.mkdir(parents=True)
        audio_path = request_dir / "audio.wav"
        audio_path.write_bytes(b"transient")

        with self.assertRaises(OSError):
            cleanup_request_uploads(request_dir, root)

        self.assertTrue(audio_path.exists())
        self.assertTrue(nested.exists())

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
        valid_mtime_ns = path.stat().st_mtime_ns
        path.write_text("{invalid", encoding="utf-8")
        # Some Windows filesystems can report the same mtime for two immediate writes.
        # Force a distinct timestamp so this test deterministically exercises hot reload.
        os.utime(path, ns=(valid_mtime_ns + 1_000_000_000, valid_mtime_ns + 1_000_000_000))
        self.assertFalse(allowlist.status()["loaded"])
        with self.assertRaises(V1ApiError):
            validate_audio_url("http://audio.internal/a.wav", allowlist.rules())

    def test_url_filename1_sdp_keeps_business_name_and_uses_wav_path(self) -> None:
        root = Path(tempfile.mkdtemp(prefix="url_sdp_", dir=RUNTIME_ROOT))
        allowlist_path = root / "allowlist.json"
        allowlist_path.write_text(json.dumps({"allow_hosts": ["1.2.3.4"]}), encoding="utf-8")
        allowlist = HotReloadAllowlist(allowlist_path)
        wav_payload = b"RIFF" + (16).to_bytes(4, "little") + b"WAVE" + b"data" + b"\x00" * 8

        class FakeResponse:
            headers = {"Content-Length": str(len(wav_payload))}

            def __init__(self) -> None:
                self.sent = False

            def __enter__(self):
                return self

            def __exit__(self, *_args):
                return False

            def read(self, _size: int) -> bytes:
                if self.sent:
                    return b""
                self.sent = True
                return wav_payload

        class FakeOpener:
            def open(self, _request, timeout: float):
                self.timeout = timeout
                return FakeResponse()

        with patch("core.audio_input.build_opener", return_value=FakeOpener()):
            original_name, audio_path = download_wav_url(
                "http://1.2.3.4/audio.wav?filename1=xxx.sdp",
                root / "downloads",
                limit_bytes=1024,
                timeout_sec=30,
                max_redirects=5,
                allowlist=allowlist,
            )

        self.assertEqual(original_name, "xxx.sdp")
        self.assertEqual(audio_path.suffix, ".wav")
        self.assertTrue(audio_path.exists())
        self.assertFalse(audio_path.with_suffix(".sdp").exists())


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
