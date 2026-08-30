"""FastAPI routes for the port-8885 platform contract."""

from __future__ import annotations

import asyncio
import traceback
import uuid
from pathlib import Path
from typing import Any, Callable, Dict, Mapping

from fastapi import APIRouter, Request
from fastapi.responses import JSONResponse
from starlette.datastructures import UploadFile

from core.audio_input import (
    HotReloadAllowlist,
    cleanup_request_uploads,
    download_wav_url,
    ensure_standard_wav,
    normalize_uploaded_audio_path,
    safe_upload_name,
    save_upload_limited,
    validate_upload_filename,
)
from core.logger import logger
from core.security import RateLimiter, authorize, configured_api_key, resolve_client_ip
from core.translator_store import TranslatorStore
from core.v1_adapter import FifoInferenceQueue, transcribe_platform_audio
from core.v1_contract import (
    V1ApiError,
    error_body,
    parse_bool,
    reject_removed_v1_parameters,
    require_model_alias,
    response_body,
)


def _project_path(value: Any) -> Path:
    path = Path(str(value or "outputs/api_uploads")).expanduser()
    return path.resolve() if path.is_absolute() else (Path.cwd() / path).resolve()


class PlatformApi:
    def __init__(self, config: Mapping[str, Any], service_getter: Callable[[], Any]) -> None:
        self.config = config
        self.service_getter = service_getter
        self.router = APIRouter()
        self.allowlist = HotReloadAllowlist(config.get("audio_url_allowlist_file"))
        self.rate_limiter = RateLimiter(int(config.get("v1_rate_limit_per_minute", 60)))
        self.queue = FifoInferenceQueue(
            max_waiters=int(config.get("v1_queue_max_size", 128)),
            timeout_sec=float(config.get("v1_queue_timeout_sec", 600)),
        )
        self.store = TranslatorStore(config.get("translator_output_root"))
        self.upload_root = _project_path(config.get("v1_upload_dir"))
        self._register_routes()

    def _client_ip(self, request: Request) -> str:
        return resolve_client_ip(
            peer_host=request.client.host if request.client else "unknown",
            headers=request.headers,
            trusted_proxy_hosts=self.config.get("trusted_proxy_hosts", ()),
        )

    def _guard(self, request: Request, params: Mapping[str, Any]) -> str:
        authorize(self.config, request.headers, params)
        client_ip = self._client_ip(request)
        self.rate_limiter.check(client_ip)
        return client_ip

    @staticmethod
    def _json_error(exc: Exception, request_id: str = "", file_name: str = "") -> JSONResponse:
        return JSONResponse(error_body(exc, request_id=request_id, file_name=file_name), status_code=200)

    async def _json_payload(self, request: Request) -> Dict[str, Any]:
        try:
            payload = await request.json()
        except Exception as exc:
            raise V1ApiError("request JSON body must be an object", "E021") from exc
        if not isinstance(payload, dict):
            raise V1ApiError("request JSON body must be an object", "E021")
        result = dict(payload)
        result.update(dict(request.query_params))
        return result

    def health(self) -> Dict[str, Any]:
        return {
            "platform_api_port": int(self.config.get("platform_api_port", 8885)),
            "api_key_required": bool(configured_api_key(self.config)),
            "max_upload_mb": int(self.config.get("v1_max_upload_mb", 512)),
            "audio_url_allowlist": self.allowlist.status(),
            "inference_queue": self.queue.status(),
        }

    def _register_routes(self) -> None:
        @self.router.post("/v1/audiototext")
        async def audio_to_text(request: Request) -> JSONResponse:
            request_id = str(uuid.uuid4())
            original_name = ""
            request_dir: Path | None = None
            try:
                limit_bytes = int(self.config.get("v1_max_upload_mb", 512)) * 1024 * 1024
                content_length = request.headers.get("content-length")
                if content_length and int(content_length) > limit_bytes + 2 * 1024 * 1024:
                    raise V1ApiError("request body is too large", "E003")

                form = await request.form()
                params: Dict[str, Any] = dict(request.query_params)
                for key, value in form.items():
                    if not isinstance(value, UploadFile):
                        params[key] = value
                reject_removed_v1_parameters(params)
                self._guard(request, params)
                expected_model = str(self.config.get("model_alias") or "Tailect_V4.1")
                require_model_alias(params.get("model"), expected=expected_model)

                file_value = form.get("file")
                upload = file_value if isinstance(file_value, UploadFile) else None
                file_url = str(params.get("file") or "").strip() if upload is None else ""
                if upload is None and not file_url:
                    raise V1ApiError("missing required file: file", "E010")

                request_dir = self.upload_root / request_id
                if upload is not None:
                    original_name = upload.filename or "audio.wav"
                    validate_upload_filename(original_name)
                    raw_path = request_dir / safe_upload_name(original_name, request_id)
                    await save_upload_limited(upload, raw_path, limit_bytes)
                    raw_path = normalize_uploaded_audio_path(original_name, raw_path)
                    audio_path = await asyncio.to_thread(
                        ensure_standard_wav,
                        raw_path,
                        float(self.config.get("v1_audio_convert_timeout_sec", 120)),
                    )
                else:
                    original_name, audio_path = await asyncio.to_thread(
                        download_wav_url,
                        file_url,
                        request_dir,
                        limit_bytes=limit_bytes,
                        timeout_sec=float(self.config.get("audio_url_timeout_sec", 30)),
                        max_redirects=int(self.config.get("audio_url_max_redirects", 5)),
                        allowlist=self.allowlist,
                    )

                diarize = parse_bool(params.get("diarize"), False)
                split_by_punctuation = parse_bool(
                    params.get("split_by_punctuation"),
                    bool(self.config.get("v1_split_by_punctuation", True)),
                )
                service = self.service_getter()
                if service is None:
                    raise V1ApiError("model service is not initialized", "E009")
                async with self.queue.slot():
                    result = await asyncio.to_thread(
                        transcribe_platform_audio,
                        service,
                        str(audio_path),
                        diarize=diarize,
                        split_by_punctuation=split_by_punctuation,
                        config=self.config,
                    )
                return JSONResponse(
                    response_body(
                        code=200,
                        language=result["language"],
                        data=result["rows"],
                        file_name=original_name,
                        message="",
                        request_id=request_id,
                    ),
                    status_code=200,
                )
            except Exception as exc:
                if not isinstance(exc, V1ApiError):
                    logger.error("platform audio inference failed: %s\n%s", exc, traceback.format_exc())
                return self._json_error(exc, request_id, original_name)
            finally:
                if request_dir is not None:
                    try:
                        await asyncio.to_thread(cleanup_request_uploads, request_dir, self.upload_root)
                    except Exception as cleanup_exc:
                        logger.warning(
                            "failed to clean transient platform upload directory %s: %s",
                            request_dir,
                            cleanup_exc,
                        )

        @self.router.get("/translator/csv/status")
        async def csv_status(request: Request) -> JSONResponse:
            try:
                params = dict(request.query_params)
                client_ip = self._guard(request, params)
                return JSONResponse(await asyncio.to_thread(self.store.status, params, client_ip, False))
            except Exception as exc:
                return self._json_error(exc)

        @self.router.get("/translator/csv")
        async def csv_read(request: Request) -> JSONResponse:
            try:
                params = dict(request.query_params)
                client_ip = self._guard(request, params)
                return JSONResponse(await asyncio.to_thread(self.store.status, params, client_ip, True))
            except Exception as exc:
                return self._json_error(exc)

        @self.router.post("/translator/csv")
        async def csv_save(request: Request) -> JSONResponse:
            try:
                params = await self._json_payload(request)
                client_ip = self._guard(request, params)
                return JSONResponse(await asyncio.to_thread(self.store.save, params, client_ip))
            except Exception as exc:
                return self._json_error(exc)

        @self.router.post("/translator/feedback")
        async def feedback(request: Request) -> JSONResponse:
            try:
                params = await self._json_payload(request)
                client_ip = self._guard(request, params)
                return JSONResponse(await asyncio.to_thread(self.store.feedback, params, client_ip))
            except Exception as exc:
                return self._json_error(exc)
