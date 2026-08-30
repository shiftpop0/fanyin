# core/config.py
"""
配置管理模块 — 集中管理所有可调参数。
"""

from typing import Any, Dict

# ===================================================================
# 可迁移配置（修改此处即可适配新环境）
# ===================================================================
CONFIG: Dict[str, Any] = {
    # ===== 对外模型身份 =====
    "model_alias": "Tailect_V4.1",

    # ===== ASR 模型配置（Transformers 模式）=====
    "asr_model_path": "model/Tailect_V4.1",

    # 设备配置（容器内启动，容器已通过 --gpus / CUDA_VISIBLE_DEVICES 隔离 GPU，
    # 故容器内始终写 cuda:0，无需跨卡）
    "asr_device": "cuda:0",            # 可选: "auto", "cpu", "cuda", "cuda:0", "cuda:1"
    "asr_dtype": "bfloat16",          # 可选: "float32", "float16", "bfloat16"

    # 推理性能配置
    "asr_batch_size": 32,            # 批处理大小（显存充足可调大）
    "asr_max_new_tokens": 2048,       # 最大生成长度
    "asr_temperature": 0.0,           # 采样温度
    "asr_repetition_penalty": 1.02,   # 重复惩罚系数
    "asr_top_p": 0.95,                # nucleus sampling 参数
    "asr_top_k": 50,                  # top-k sampling 参数

    # ===== 标点恢复配置 =====
    "punctuation_model_path": "model/iic/punc_ct-transformer_zh-cn-common-vocab272727-pytorch",
    "punctuation_device": "cuda:0",    # 容器内只有一张卡，始终用 cuda:0

    # 是否使用 torch.compile 加速（首次调用会较慢）
    "asr_use_compile": True,

    # 音频处理配置
    "asr_target_sample_rate": 16000,  # 目标采样率
    "asr_audio_max_duration": 3600,   # 单次处理最大音频时长（秒），超过会自动分段
    # 纯 ASR 切分阈值（秒）：运行时覆盖 qwen_asr 硬编码的 MAX_ASR_INPUT_SECONDS(1200)，
    # 超过该时长的音频会先按低能量点切分再推理。
    # 注意：Qwen3-ASR 音频 token 密度约 13 token/秒，
    # 在 vllm_max_model_len=8192 下：
    #   300s chunk ≈ 4088 prompt token，剩余 ~4100 token 可生成（≈6000+ 中文字）✓
    #   600s chunk ≈ 7988 prompt token，仅剩 ~204 token，文本会被 vLLM 硬截断 ✗（曾踩坑）
    # 故务必保持 ≤300；若调大 vllm_max_model_len，可适当放宽此值。
    "pure_asr_max_chunk_seconds": 300,

    # ===== 说话人区分配置 =====
    "diarization_project_path": "TargetDiarization-main",
    "diarization_device": "cuda",       # 可选: "cuda", "cuda:0", "cpu"
                                       # 容器内只有一张卡，默认 cuda 即可
    "diarization_timeout": 60,

    # ===== 强制对齐配置 =====
    "forced_aligner_model_path": "model/Qwen3-ForcedAligner-0.6B",
    "forced_aligner_device": "cuda:0",  # 容器内只有一张卡，始终用 cuda:0
    "forced_align_timeout": 120,

    # ===== ASR 推理后端选择 =====
    #
    # vllm_enabled: 选择推理后端
    #   False — Transformers 模式（当前默认，from_pretrained 加载）
    #   True  — vLLM 模式（Qwen3ASRModel.LLM() 加载，显存效率更高）
    #
    "vllm_enabled": True,             # True=vLLM  False=Transformers
    "vllm_gpu_memory_utilization": 0.7,  # vLLM 显存利用率
    "vllm_max_new_tokens": 2048,      # vLLM 最大生成长度
    "vllm_max_model_len": 8192,       # vLLM 最大上下文长度（音频+文本总 token 数上限）
                                     # 增加此值可避免 "decode prompt length > max_model_len" 错误，
                                     # 但会占用更多 GPU 显存（KV cache 增大）。
                                     # 如果遇到显存不足(OOM)，请适当降低此值或减小音频时长。

    # ===== 流式识别开关 =====
    "streaming_enabled": False,       # 是否启用流式识别 API (/api/stream/*)

    # ===== GPU 部署配置（启动脚本据此自动生成容器）=====
    "asr_available_gpus": "0,1,2",   # 部署GPU列表，用逗号分隔；改此值即可增减容器
                                     # "0"          → 1卡 (GPU0, :8001)
                                     # "0,1"        → 2卡 (GPU0,1, :8001-8002)
                                     # "0,1,2"      → 3卡 (GPU0,1,2, :8001-8003)

    # ===== 服务配置 =====
    "server_host": "0.0.0.0",
    "server_port": 6006,
    # 平台标准接口由离线 Nginx 监听 8885，并转发到同一 6006 模型进程。
    "platform_api_port": 8885,

    # ===== 平台 v1 API =====
    "v1_max_upload_mb": 512,
    "v1_queue_timeout_sec": 600,
    "v1_queue_max_size": 128,
    "v1_rate_limit_per_minute": 60,
    "v1_api_key_env": "TAILECT_API_KEY",
    # Request language is accepted for compatibility but ignored. This is only
    # used when the native model returns no language for ForcedAligner.
    "v1_alignment_fallback_language": "Chinese",
    "v1_split_by_punctuation": True,
    # 平台要求 diarize=1 必须真正完成说话人分离；失败时返回错误，禁止伪装成单说话人。
    "v1_diarization_fallback": False,
    "v1_audio_convert_timeout_sec": 120,
    "v1_upload_dir": "outputs/api_uploads",
    "translator_output_root": "outputs/fanyin_output",

    # HTTP(S) 完整 WAV URL 输入。白名单文件按 mtime 热加载，无需重启服务。
    "audio_url_allowlist_file": "config/audio_url_allowlist.json",
    "audio_url_timeout_sec": 30,
    "audio_url_max_redirects": 5,

    # 仅信任本机离线 Nginx 注入的代理头。
    "trusted_proxy_hosts": ["127.0.0.1", "::1"],
    "cors_allowed_origins": ["*"],

    # ===== 推理超时配置 =====
    "asr_timeout": 180,               # ASR 单次推理超时
    "segment_workers": 32,             # 分段并发数

    # ===== 端口处理（不再需要，但保留以防其他组件使用）=====
    "auto_kill_port_occupier": False,
    "port_release_wait_seconds": 5,

    # ===== 其他兼容性设置 =====
    # 注意力实现
    "asr_attn_implementation": "flash_attention_2",  # 可选: None, "flash_attention_2", "sdpa", "eager"
    "disable_flash_attn": False,
}


def get_config() -> Dict[str, Any]:
    """获取当前配置字典的副本。"""
    return dict(CONFIG)
