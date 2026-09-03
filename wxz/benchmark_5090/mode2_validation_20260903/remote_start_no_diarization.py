#!/usr/bin/env python3

"""Runtime-isolation fixture: start 6006 code with an intentionally unavailable diarization path."""

from core.config import CONFIG
from core.model_loader import patch_mistral_tokenizer


patch_mistral_tokenizer()
CONFIG["diarization_project_path"] = "/workspace/__intentionally_missing_diarization_project__"

from core.api_server import app  # noqa: E402


if __name__ == "__main__":
    import uvicorn

    uvicorn.run(app, host="127.0.0.1", port=16007, log_level="info")
