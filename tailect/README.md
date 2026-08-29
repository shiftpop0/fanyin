
<p align="center">
  <img src="https://img.shields.io/badge/Python-3.10%2B-blue" alt="Python">
  <img src="https://img.shields.io/badge/PyTorch-2.2%2B-red" alt="PyTorch">
  <img src="https://img.shields.io/badge/CUDA-12.x-76b900" alt="CUDA">
  <img src="https://img.shields.io/badge/FastAPI-0.100%2B-009688" alt="FastAPI">
  <img src="https://img.shields.io/badge/License-Apache--2.0-green" alt="License">
  <img src="https://img.shields.io/badge/Status-Production-brightgreen" alt="Status">
</p>

<h1 align="center">🎤 Tailect ASR Offline Service</h1>

<p align="center">
  <strong>统一语音识别（ASR）+ 说话人日志（Diarization）+ 强制对齐（Forced Alignment）离线推理服务</strong>
</p>

<p align="center">
  基于 Qwen3-ASR 与 TargetDiarization 的高性能离线语音处理平台，单进程加载全部模型，通过 HTTP API 提供无状态调用。
</p>

---

## 📋 目录

- [项目简介](#-项目简介)
- [核心功能](#-核心功能)
- [技术栈](#-技术栈)
- [项目结构](#-项目结构)
- [快速开始](#-快速开始)
- [部署指南](#-部署指南)
- [API 文档](#-api-文档)
- [配置说明](#-配置说明)
- [模型清单](#-模型清单)
- [开发指南](#-开发指南)
- [常见问题](#-常见问题)
- [许可证](#-许可证)

---

## 🎯 项目简介

**Tailect ASR Offline Service** 是一个面向生产环境的离线语音处理服务平台。它将语音识别（ASR）、说话人日志（Speaker Diarization）、强制对齐（Forced Alignment）和标点恢复（Punctuation Restoration）整合到单个 FastAPI 服务中，所有模型常驻内存，通过 HTTP API 提供低延迟推理。

**核心设计理念：**
- 🚫 **完全离线** — 所有模型本地加载，无需联网下载
- 🧩 **单进程一体化** — 不依赖外部 API 进程或 vLLM 子进程
- 🎯 **目标说话人分离** — 可从多人对话中识别并分离特定说话人
- 📦 **Docker 容器化部署** — 支持单机多卡负载均衡

---

## 🔧 核心功能

| 功能模块 | 端点 | 说明 |
|---------|------|------|
| **语音识别 (ASR)** | `POST /asr`, `POST /asr_raw` | 基于 Qwen3-ASR 的高精度语音转文本 |
| **说话人日志 (Diarization)** | `POST /diarization` | 识别音频中不同说话人及其时间区间 |
| **说话人分离 + 批量 ASR** | `POST /asr?diarization=true` | 先分离说话人，再对每段进行 **批量推理**（`transcribe_batch`） |
| **强制对齐 (Forced Alignment)** | `POST /forced_align` | 将文本与音频对齐，输出字/词级时间戳 |
| **标点恢复 (Punctuation)** | `POST /punctuation` | 为 ASR 结果恢复标点符号 |
| **平台标准转写** | `POST /v1/audiototext` | `Tailect_V4.1` 固定合同、ForcedAligner 时间戳、可选说话人、FIFO 并发 1 |
| **油猴 CSV 同步** | `GET/POST /translator/*` | CSV 读取、状态、保存与人工修正 |
| **健康检查** | `GET /health` | 服务状态监测 |

生产部署保留两个端口角色：6006 是当前 FastAPI 通用接口；8885 由离线 Nginx 仅代理 `/health`、`/v1/audiototext` 和 `/translator/*` 到同一 6006 进程，因此显存中只加载一份模型。单张 4090 的安全启动方式、接口合同、URL 白名单和油猴联调详见 [API_V4.1_离线接口与部署.md](API_V4.1_离线接口与部署.md)。

---

## 🏗 技术栈

### 后端框架
| 组件 | 技术选型 | 用途 |
|-----|---------|------|
| Web 框架 | **FastAPI** | HTTP API 服务 |
| ASR 引擎 | **Qwen3-ASR (Transformers 原生模式)** | 端到端语音识别 |
| 说话人分离 | **TargetDiarization** (CAM++ / PyAnnote) | 多人说话人日志 |
| 强制对齐 | **Qwen3-ForcedAligner** | 文本-音频时间对齐 |
| 标点恢复 | **FunASR CT-Transformer** | 中文标点恢复 |
| 语音分离 | **MossFormer2** | 音频降噪与分离 |
| 声纹识别 | **ERes2NetV2 / CAM++** | 说话人嵌入 |

### 部署与运行环境
| 组件 | 技术选型 |
|-----|---------|
| 容器化 | Docker + NVIDIA Container Toolkit |
| 负载均衡 | Nginx (ip_hash 策略) |
| GPU 支持 | CUDA 12.x, PyTorch 2.2+ |
| 运行环境 | Linux (Ubuntu 22.04+) / WSL2 |

---

## 📁 项目结构

```
asr_offline/
├── unified_asr_diarization_transformer_offline.py  # 主入口（薄封装层，核心逻辑已迁至 core/）
├── run.sh                                           # WSL Docker 启动脚本（根目录版，路径硬编码）
├── core/                                            # 核心逻辑模块
│   ├── __init__.py                                  # 模块初始化（延迟导入+全部接口重导出）
│   ├── config.py                                    # 集中配置管理
│   ├── logger.py                                    # 日志配置
│   ├── device_utils.py                              # 设备与精度工具
│   ├── model_loader.py                              # 模型加载（含 torchaudio 兼容补丁 + tokenizer monkey patch）
│   ├── audio_processor.py                           # 音频处理工具
│   ├── inference_engine.py                          # 推理引擎（核心业务逻辑：ASR/Diarization/Align/Punctuation）
│   └── api_server.py                                # FastAPI 应用与路由（端口多级释放、服务生命周期）
├── script/                                          # 运维脚本
│   ├── run.sh                                       # WSL Docker 启动脚本（环境变量覆盖版）
│   ├── run_offline.sh                               # 离线机 3 卡生产启动脚本（Docker+Nginx 负载均衡）
│   ├── run_auto.sh                                  # [新] GPU 自动检测+智能配置部署脚本
│   ├── gpu_detect.sh                                # [新] GPU 检测函数库（被 run_auto.sh source）
│   ├── auto_config.sh                               # [新] 自动配置决策引擎（被 run_auto.sh source）
│   ├── run_test.sh                                  # 测试机单实例启动脚本
│   ├── stop_offline.sh                              # 停止服务脚本（清理容器+端口）
│   ├── check_models.sh                              # 模型完整性检查
│   ├── inject_nvidia_drivers.sh                     # NVIDIA 驱动注入（驱动库注入+重启 worker）
│   ├── nginx_offline.conf                           # Nginx 负载均衡配置（ip_hash 策略）
│   ├── xianju_batch.py                              # 仙居方言批量 ASR 处理脚本（支持断点续传+动态 batch）
│   └── xianju.txt                                   # 仙居方言测试音频列表
├── TargetDiarization-main/                          # 第三方说话人分离项目（离线化改造）
│   ├── TargetDiarization.py                         # 目标说话人日志主类
│   ├── TargetASR.py                                 # ASR 工具类
│   ├── AudioProcessor.py                            # 音频处理工具类
│   ├── ASRProcessor.py                              # ASR 处理类
│   ├── main.py                                      # 命令行入口
│   ├── webui.py                                     # Gradio WebUI
│   ├── requirements.txt                             # 依赖清单
│   ├── checkpoints/                                 # MossFormer2 分离权重
│   ├── iic/                                         # ModelScope 模型软链
│   ├── mdx/                                         # MDX 分离模型
│   └── pyannote/                                    # PyAnnote 模型软链
├── tests/                                           # 单元测试
│   ├── __init__.py
│   └── test_core.py                                 # 核心模块测试（配置/设备/音频/模型加载/API 路由）
└── .gitignore                                       # Git 忽略规则
```

### 关键文件说明

| 文件 | 说明 |
|------|------|
| `unified_asr_diarization_transformer_offline.py` | **薄封装层**：设置环境变量、执行 monkey patch、重导出 core/ 全部接口、解析命令行参数启动 uvicorn |
| `core/config.py` | 全局配置字典，所有可调参数集中管理 |
| `core/inference_engine.py` | 核心业务逻辑，包含 `UnifiedService`、`ASRWrapper`（支持 `transcribe_batch` 批量推理）、`DiarizationWrapper`、`ForcedAlignWrapper`、`PunctuationRestorer` |
| `core/api_server.py` | FastAPI 应用，定义 6 个路由端点、多级端口释放、服务生命周期 |
| `core/model_loader.py` | 模型加载逻辑，包含 torchaudio 兼容补丁、Mistral/Qwen tokenizer monkey patch |
| `core/device_utils.py` | 设备/精度解析工具 |
| `core/audio_processor.py` | 音频裁剪、临时文件管理等纯音频工具 |
| `core/logger.py` | 日志格式配置 |
| `script/gpu_detect.sh` | GPU 检测函数库（`source` 导入），通过 `nvidia-smi` 检测数量/显存/计算能力，不可用时自动降级 |
| `script/auto_config.sh` | 自动配置决策引擎，根据 GPU 硬件推导 `batch_size`/`dtype`/`attention`/`vllm_gmu`，生成 `core/config_auto.py` |
| `script/run_auto.sh` | **智能自动部署入口**，自动检测 GPU → 参数调优 → Docker 部署，支持 `--dry-run`、`--with-diarization`、`--with-vllm` 等参数 |
| `script/xianju_batch.py` | 仙居方言批量 ASR 处理脚本，支持断点续传、动态 batch 调整、Flash Attention、OOM 自动降级 |
| `TargetDiarization-main/` | 第三方目标说话人日志项目（经过离线化改造：`disable_update=True`, `local_files_only=True`） |

---

## 🚀 快速开始

### 前置条件

- Python 3.10+
- CUDA 12.x + NVIDIA GPU (8GB+ 显存)
- PyTorch 2.2+ (CUDA 版本)
- Docker + NVIDIA Container Toolkit (容器部署模式)

### 安装依赖

```bash
# 1. 克隆项目
git clone <repository-url>
cd Tailect_server

# 2. 安装 Python 依赖
pip install torch torchaudio --index-url https://download.pytorch.org/whl/cu121
pip install fastapi uvicorn[standard] numpy soundfile librosa transformers
pip install funasr modelscope pyannote.audio
pip install qwen-asr  # Qwen3-ASR & Qwen3-ForcedAligner

# 3. 准备模型文件（见下方模型清单）
# 将模型权重放入 model/ 目录
```

### 快速测试运行

```bash
# 方式一：直接运行（推荐开发测试）
cd /mnt/d/dialect/Tailect_web/asr_offline
export PYTHONPATH="${PYTHONPATH}:$(pwd)"
python unified_asr_diarization_transformer_offline.py --port 6006

# 方式二：使用测试脚本
bash script/run_test.sh

# 方式三：独立运行模式（通过 run.sh，无 Docker）
bash run.sh --standalone
# 或
bash script/run.sh --standalone
```

### 验证服务

```bash
# 健康检查
curl http://localhost:6006/health

# ASR 识别（指定音频文件）
curl -X POST http://localhost:6006/asr_raw \
  -F "file=@/path/to/audio.wav"

# ASR 识别（使用项目内测试音频）
curl -s http://localhost:6006/asr_raw -F "file=@tests/0051409.wav"

# ASR 识别 + 说话人区分
curl -X POST "http://localhost:6006/asr?diarization=true" \
  -F "file=@/path/to/audio.wav"
```

> 测试音频 `tests/0051409.wav` 为项目自带的方言测试样本，可直接用于验证服务是否正常运行。

---

## 🐳 部署指南

### 单机单卡（测试/开发）

使用 `run_test.sh`：

```bash
bash script/run_test.sh
```

### 单机多卡（生产）

使用 `run_offline.sh`（3 GPU，Nginx 负载均衡）：

```bash
# 前置条件：确保 Docker 镜像已导入
# docker load < tailect-asr-qwen3-asr-offline-salvaged-20260506.tar.gz

# 启动服务
bash script/run_offline.sh

# 停止服务
bash script/stop_offline.sh
```

部署架构：

```
                    ┌─────────────┐
                    │  Nginx      │
                    │  port 6006  │
                    │ ip_hash     │
                    └──────┬──────┘
                           │
               ┌───────────┼───────────┐
               ▼           ▼           ▼
        ┌──────────┐ ┌──────────┐ ┌──────────┐
        │ GPU 0    │ │ GPU 1    │ │ (预留)   │
        │ :8001    │ │ :8002    │ │          │
        └──────────┘ └──────────┘ └──────────┘

> 当前为 **2 卡模式**。如需扩回 3 卡，改 `config.py` 中 `asr_available_gpus="0,1,2"`，
> 并在 `run_offline.sh` 中恢复 `start_instance 2 8003` 和 `nginx_offline.conf` 中 `server 127.0.0.1:8003`。
```

### WSL Docker 部署（根目录 run.sh）

```bash
cd /mnt/d/dialect/Tailect_web/asr_offline
bash run.sh
```
> 根目录 `run.sh` 硬编码 WSL 路径 `/mnt/d/dialect/Tailect_web`，适用于固定开发环境。

### WSL Docker 部署（可配置版）

```bash
# 可覆盖以下环境变量
export HOST_PROJECT_DIR="/mnt/d/dialect/Tailect_web"
export HOST_MODEL_DIR="/mnt/d/dialect/Tailect_web/asr_offline/model"
export IMAGE="tailect-asr-qwen3-asr:offline-salvaged-20260506"
bash script/run.sh
```

### 🧠 智能自动部署（GPU 自动检测 + 参数调优）

`run_auto.sh` 是新增的智能部署脚本，通过 `nvidia-smi` 自动检测 GPU 硬件信息，
动态计算最优推理参数，然后自动完成 Docker 容器部署。**无需手动修改任何配置文件。**

**检测 → 决策 → 部署 全流程：**

```
nvidia-smi 检测
  ├── GPU 数量     → asr_available_gpus
  ├── 显存 (MiB)   → asr_batch_size / vllm_gpu_memory_utilization
  ├── 计算能力 (CC) → asr_attn_implementation / asr_dtype
  └── GPU 型号名称  → 展示用
       │
       ▼
生成 core/config_auto.py（仅含被优化的键）
       │
       ▼
合并 core/config.py + config_auto.py → core/config_auto.full.py
       │
       ▼
Docker 文件级挂载覆盖容器内 config.py（不污染宿主机 config.py）
```

**参数调优策略：**

| 显存范围 | batch_size | vllm_gmu | 适用显卡 |
|---------|-----------|----------|---------|
| ≥ 40GB | 64 | 0.5 | A100/A800 |
| ≥ 24GB | 32 | 0.6 | RTX 4090 |
| ≥ 16GB | 16 | 0.4 | RTX 3080/3080Ti |
| < 16GB | 8 | 0.3 (vllm 关闭) | 低显存显卡 |

| 计算能力 | attention 实现 | dtype |
|---------|---------------|-------|
| ≥ 8.0 | `flash_attention_2` | `bfloat16` |
| ≥ 7.0 | `sdpa` | `float16` |
| < 7.0 | `eager` | `float32` |

> 多 GPU 场景以**最低规格**为准，确保所有卡兼容。

**用法：**

```bash
# 交互式选择 GPU
bash script/run_auto.sh

# 指定 GPU + dry-run 预览（仅检测，不启动）
bash script/run_auto.sh --gpus 0 --dry-run

# 单卡 Docker 部署（直连端口 6006）
bash script/run_auto.sh --gpus 0 --port 6006

# 三卡部署（自动启动 Nginx 负载均衡）
bash script/run_auto.sh --gpus 0,1,2

# 开启说话人区分功能
bash script/run_auto.sh --gpus 0 --port 6006 --with-diarization

# 开启 vLLM 后端（默认用 Transformer）
bash script/run_auto.sh --gpus 0 --port 6006 --with-vllm
```

**参数说明：**

| 参数 | 说明 | 默认值 |
|------|------|--------|
| `--gpus` | GPU ID 列表，逗号分隔 | 不传则交互式询问 |
| `--port` | 服务端口（单卡模式） | 6006 |
| `--with-diarization` | 启用说话人区分 | 关闭 |
| `--with-vllm` | 启用 vLLM 后端 | 关闭（Transformer） |
| `--dry-run` | 仅检测打印，不启动 | 关闭 |
| `--direct` | 本地直接运行（跳过 Docker） | 关闭 |

> **设计原则：** `run_auto.sh` 绝不修改 `core/config.py`。它通过 Docker 文件级挂载 (`-v`) 将自动生成的 `config_auto.full.py` 覆盖到容器内，宿主机原始配置文件完好无损。

---

### NVIDIA 驱动注入

当 Docker Container Toolkit 无法正常注入驱动库时：

```bash
# 检查状态
bash script/inject_nvidia_drivers.sh --check-only

# 注入驱动并重启 worker
bash script/inject_nvidia_drivers.sh --gpus 0,1,2
```

### 模型完整性检查

```bash
# 检查所有模型文件是否存在
bash script/check_models.sh

# 指定模型目录
bash script/check_models.sh /path/to/model
```

---

## 📚 API 文档

### 健康检查

```
GET /health
```

**响应示例：**

```json
{
  "status": "ok",
  "service_ready": true
}
```

---

### 语音识别（原始）

```
POST /asr_raw
Content-Type: multipart/form-data

Parameters:
  - file: 音频文件 (UploadFile)
```

**响应示例：**

```json
{
  "text": "识别的文本内容"
}
```

---

### 语音识别（兼容接口）

```
POST /asr?diarization=false
Content-Type: multipart/form-data

Parameters:
  - file: 音频文件 (UploadFile)
  - diarization: 是否先做说话人分离 (Query, default: false)
```

**`diarization=true` 响应示例：**

```json
{
  "input_file": "meeting.wav",
  "speaker_count": 3,
  "diarization_status": "ok",
  "overall_text": "所有人说话的整体文本...",
  "speaker_segments": [
    {
      "start": 0.0,
      "end": 12.5,
      "speaker": "speaker_0",
      "text": "说话人0的文本",
      "type": "single",
      "asr_debug": { ... }
    },
    {
      "start": 3.2,
      "end": 8.7,
      "speaker": "speaker_1",
      "text": "说话人1的文本",
      "type": "single",
      "asr_debug": { ... }
    }
  ],
  "timing_debug": { ... }
}
```

---

### 说话人日志

```
POST /diarization
Content-Type: multipart/form-data

Parameters:
  - file: 音频文件 (UploadFile)
```

**响应示例：**

```json
{
  "segments": [
    { "start": 0.0, "end": 5.2, "speaker": "speaker_0" },
    { "start": 5.2, "end": 12.8, "speaker": "speaker_1" }
  ]
}
```

---

### 强制对齐

```
POST /forced_align
Content-Type: multipart/form-data

Parameters:
  - file: 音频文件 (UploadFile)
  - text: 需要对齐的文本 (Form)
  - language: 语言 (Form, default: "Chinese")
```

**响应示例：**

```json
{
  "segments": [
    { "start": 0.12, "end": 0.45, "text": "你" },
    { "start": 0.45, "end": 0.89, "text": "好" }
  ]
}
```

---

### 标点恢复

```
POST /punctuation
Content-Type: application/x-www-form-urlencoded

Parameters:
  - text: 需要恢复标点的文本 (Form)
```

**响应示例：**

```json
{
  "text": "你好，今天天气真好啊！"
}
```

---

## ⚙️ 配置说明

所有配置集中在 `core/config.py` 的 `CONFIG` 字典中。可以通过修改该文件来适配新环境。

### 核心配置项

| 配置项 | 默认值 | 说明 |
|-------|--------|------|
| `model_alias` | `Tailect_V4.1` | 对外统一模型名称 |
| `asr_model_path` | `model/Tailect_V4.1` | ASR 模型路径（相对项目根目录） |
| `asr_device` | `cuda:0` | ASR 设备，可选 `auto`/`cpu`/`cuda:0` |
| `asr_dtype` | `bfloat16` | 推理精度，可选 `float32`/`float16`/`bfloat16` |
| `asr_batch_size` | `48` | ASR 批处理大小（默认 48，24GB 显存可调至 128） |
| `asr_max_new_tokens` | `4096` | 最大生成 token 数 |
| `asr_temperature` | `0.0` | 采样温度（0.0 = 贪心解码） |
| `asr_repetition_penalty` | `1.02` | 重复惩罚系数 |
| `asr_top_p` | `0.95` | nucleus sampling 参数 |
| `asr_top_k` | `50` | top-k sampling 参数 |
| `asr_use_compile` | `true` | 启用 torch.compile 加速（首次调用较慢） |
| `asr_attn_implementation` | `flash_attention_2` | 注意力实现，可选 `null`/`flash_attention_2`/`sdpa`/`eager` |
| `punctuation_model_path` | `model/iic/punc_ct-transformer_zh-cn-common-vocab272727-pytorch` | 标点恢复模型路径 |
| `punctuation_device` | `cuda:0` | 标点恢复设备 |
| `diarization_project_path` | `./TargetDiarization-main` | 说话人分离项目路径 |
| `diarization_device` | `cuda` | 说话人分离设备 |
| `forced_aligner_model_path` | `model/Qwen3-ForcedAligner-0.6B` | 强制对齐模型路径 |
| `forced_aligner_device` | `cuda:0` | 强制对齐设备 |
| `server_host` | `0.0.0.0` | 服务监听地址 |
| `server_port` | `6006` | 服务监听端口 |
| `segment_workers` | `32` | ASR 分段并发数（diarization_then_asr 时使用） |
| `disable_flash_attn` | `false` | （已弃用）禁用 Flash Attention，请改用 `asr_attn_implementation` |
| `auto_kill_port_occupier` | `false` | 端口被占用时拒绝启动，避免影响其它服务 |
| `port_release_wait_seconds` | `5` | 端口释放等待时间（秒） |

### 环境变量

| 变量名 | 说明 | 默认值 |
|-------|------|--------|
| `HOST_PROJECT_DIR` | 宿主机项目目录（Docker 挂载用） | 脚本自动推导 |
| `HOST_MODEL_DIR` | 宿主机模型目录 | `${HOST_PROJECT_DIR}/model`（注意：实际路径为 `asr_offline/model`） |
| `IMAGE` | Docker 镜像名 | `tailect-asr-qwen3-asr:offline-salvaged-20260506` |
| `CUDA_VISIBLE_DEVICES` | 可见 GPU 设备 | 各脚本自行设置 |
| `HF_HUB_OFFLINE` | HuggingFace 离线模式 | `1`（强制，代码中多处设置） |
| `TRANSFORMERS_OFFLINE` | Transformers 离线模式 | `1`（强制） |
| `CONTAINER_NAME` | Docker 容器名 | `tailect-offline-prod` |
| `HOST_PORT` | 宿主机映射端口 | `6006` |
| `GPU_LIST` | NVIDIA 驱动注入目标 GPU | `0,1,2,3` |

### 环境变量文件 (.env)

项目支持 `.env` 文件，但未提交到版本控制。可创建 `.env` 文件存放 Docker Compose 相关变量：

```bash
# .env 示例
COMPOSE_PROJECT_NAME=tailect_asr
LOG_LEVEL=INFO
```

---

## 📦 模型清单

服务正常运行需要以下模型文件（放置在 `model/` 目录下）：

### ASR 模型
| 模型 | 路径 | 大小 |
|------|------|------|
| Qwen3-ASR 主模型 | `model/Tailect_V4.1` | 以本地模型目录为准 |

### 说话人分离模型
| 模型 | 路径 |
|------|------|
| CAM++ Diarization Pipeline | `model/iic/speech_campplus_speaker-diarization_common` |
| PyAnnote 重叠检测 | `model/pyannote/speaker-diarization-3.1` |
| 声纹嵌入 (ERes2NetV2) | `model/iic/speech_eres2netv2w24s4ep4_sv_zh-cn_16k-common` |
| 声纹 (CAM++ 标准版) | `model/damo/speech_campplus_sv_zh-cn_16k-common` |
| 声纹 (CAM++ iic) | `model/iic/speech_campplus_sv_zh-cn_16k-common` |

### VAD 模型
| 模型 | 路径 |
|------|------|
| VAD (iic) | `model/iic/speech_fsmn_vad_zh-cn-16k-common-pytorch` |
| VAD (damo) | `model/damo/speech_fsmn_vad_zh-cn-16k-common-pytorch` |

### 其他模型
| 模型 | 路径 |
|------|------|
| 标点恢复 | `model/iic/punc_ct-transformer_zh-cn-common-vocab272727-pytorch` |
| 说话人变化检测 | `model/damo/speech_campplus-transformer_scl_zh-cn_16k-common` |
| MossFormer2 分离权重 | `model/checkpoints/mossformer2-finetune` |
| 强制对齐模型 | `model/Qwen3-ForcedAligner-0.6B` |

> **注意**：模型文件较大（总计约 20-30GB），不存储在 Git 仓库中。需通过 ModelScope 或 HuggingFace 手动下载。

---

## 🧪 开发指南

### 运行测试

```bash
cd /mnt/d/dialect/Tailect_web/asr_offline
export PYTHONPATH="${PYTHONPATH}:$(pwd)"
python -m pytest tests/test_core.py -v
```

### 代码结构

```
请求流程：
Client → HTTP Request → FastAPI (api_server.py)
                       → UnifiedService (inference_engine.py)
                           ├── ASRWrapper.transcribe()        # 单条 ASR
                           ├── ASRWrapper.transcribe_batch()  # 批量 ASR（Qwen3ASRModel 原生批处理）
                           ├── DiarizationWrapper.diarize()   # 说话人分离
                           ├── ForcedAlignWrapper.align()     # 强制对齐
                           └── PunctuationRestorer.restore()  # 标点恢复
                       → JSON Response → Client
```

### 性能优化要点

| 特性 | 说明 |
|------|------|
| **批量推理** | `ASRWrapper.transcribe_batch()` — 将多个音频片段打包为一次 GPU 调用，10 片段约 2-3 秒（顺序处理约 20 秒） |
| **torch.compile** | `asr_use_compile=true` — 编译计算图加速推理，首次调用较慢，后续显著加速 |
| **Flash Attention 2** | `asr_attn_implementation=flash_attention_2` — 减少显存占用，加速长序列推理 |
| **断点续传** | `script/xianju_batch.py` 扫描输出目录中的已有结果，自动跳过已处理文件 |

### 仙居方言批量处理

```bash
cd /mnt/d/dialect/Tailect_web/asr_offline
python script/xianju_batch.py \
  --input_dir /path/to/audio/files \
  --output_dir /path/to/results \
  --device cuda:0 \
  --batch_size 12 \
  --max_tokens 256 \
  --enable_flash_attention
```

支持特性：断点续传、动态 batch 调整（基于可用显存）、OOM 自动降级重试、结果按批次写入 JSON。

### 添加新端点

1. 在 `core/inference_engine.py` 中添加推理方法
2. 在 `core/api_server.py` 中添加 FastAPI 路由
3. 在 `unified_asr_diarization_transformer_offline.py` 中导出（可选）

---

## ❓ 常见问题

### Q: 服务启动时报 "Port is occupied"

```bash
# 默认不会终止占用端口的进程。请先确认占用者，再由运维人员处理。
lsof -i:6006
```

### Q: 模型加载失败

确保模型文件已下载并放在正确的目录下：

```bash
bash script/check_models.sh
```

### Q: GPU 显存不足

- 降低 `asr_batch_size`（默认 48）
- 设置 `asr_device` 为 `cpu` 或特定 GPU
- 设置 `disable_flash_attn: true`

### Q: Docker 中 GPU 不可用

```bash
# 检查 NVIDIA Container Toolkit
bash script/inject_nvidia_drivers.sh --check-only

# 注入驱动
bash script/inject_nvidia_drivers.sh
```

### Q: "qwen_asr" 模块未找到

```bash
pip install qwen-asr
```

### Q: "funasr" 相关错误

```bash
pip install funasr modelscope
```

### Q: 说话人分离 + ASR 模式（diarization=true）速度慢

当前的实现使用 **批量推理**（`transcribe_batch`）：将所有说话人片段裁剪后一次性送入 GPU，大幅提升吞吐量。如果仍然慢，请检查 GPU 显存是否充足，或调大 `asr_batch_size`。

### Q: xianju_batch.py 如何使用？

```bash
python script/xianju_batch.py \
  --input_dir /path/to/audio \
  --output_dir /path/to/results \
  --device cuda:0 \
  --batch_size 12
```
支持断点续传（自动跳过已处理文件）、动态 batch 调整、Flash Attention 加速。

### Q: 如何排查批量推理是否生效？

查看服务日志中的 `[SEG-ASR][BATCH]` 条目，会输出 `segments=N batch_elapsed=Xs speedup=~Yx`，其中 `speedup` 字段显示相对顺序处理的加速比。

---

## 📄 许可证

本项目基于 [Apache License 2.0](https://www.apache.org/licenses/LICENSE-2.0) 开源。

---

## 🙏 致谢

- [Qwen3-ASR](https://github.com/QwenLM/Qwen3-ASR) — 先进的语音识别模型
- [TargetDiarization](https://github.com/jingzhunxue/TargetDiarization) — 目标说话人日志框架
- [FunASR](https://github.com/modelscope/FunASR) — 端到端语音识别工具包
- [PyAnnote Audio](https://github.com/pyannote/pyannote-audio) — 说话人日志工具库
