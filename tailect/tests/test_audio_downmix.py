"""Tests for explicit multichannel WAV merging before platform inference."""

from __future__ import annotations

import struct
import tempfile
import unittest
import wave
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

from core.audio_input import ensure_standard_wav


RUNTIME_ROOT = Path(__file__).resolve().parents[1] / "outputs" / "test_audio_downmix"
RUNTIME_ROOT.mkdir(parents=True, exist_ok=True)


class AudioDownmixTests(unittest.TestCase):
    @staticmethod
    def _write_pcm_wav(path: Path, channels: int) -> None:
        frames = []
        for index in range(160):
            left = 12000 if index % 2 == 0 else -12000
            values = [left, 6000] if channels == 2 else [left]
            frames.append(struct.pack("<" + "h" * channels, *values))
        with wave.open(str(path), "wb") as handle:
            handle.setnchannels(channels)
            handle.setsampwidth(2)
            handle.setframerate(16000)
            handle.writeframes(b"".join(frames))

    def test_multichannel_wav_is_explicitly_summed_to_mono(self) -> None:
        root = Path(tempfile.mkdtemp(prefix="stereo_downmix_", dir=RUNTIME_ROOT))
        source = root / "stereo.wav"
        self._write_pcm_wav(source, channels=2)
        commands = []

        def fake_run(command, **_kwargs):
            commands.append(command)
            self._write_pcm_wav(Path(command[-1]), channels=1)
            return SimpleNamespace(returncode=0, stderr=b"")

        with patch("core.audio_input.subprocess.run", side_effect=fake_run):
            result = ensure_standard_wav(source)

        self.assertEqual(result.name, "stereo_mono.wav")
        with wave.open(str(result), "rb") as handle:
            self.assertEqual(handle.getnchannels(), 1)
        command_text = " ".join(commands[0])
        self.assertIn("pan=mono|c0=c0+c1", command_text)
        self.assertIn("alimiter=limit=0.95:level=false", command_text)

    def test_mono_wav_is_not_rewritten(self) -> None:
        root = Path(tempfile.mkdtemp(prefix="mono_passthrough_", dir=RUNTIME_ROOT))
        source = root / "mono.wav"
        self._write_pcm_wav(source, channels=1)

        with patch("core.audio_input.subprocess.run") as run:
            result = ensure_standard_wav(source)

        self.assertEqual(result, source)
        run.assert_not_called()


if __name__ == "__main__":
    unittest.main()
