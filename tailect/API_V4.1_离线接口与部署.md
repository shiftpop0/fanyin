# Tailect V4.1 离线接口与部署手册

## 1. 部署边界

首期生产结构固定为：

```text
GPU：单张 4090
模型进程：1 个 UnifiedService
通用接口：FastAPI :6006
平台接口：Nginx :8885 -> FastAPI :6006
平台推理：有界 FIFO，并发 1
公开模型名：Tailect_V4.1
```

ASR、`Qwen3-ForcedAligner-0.6B`、TargetDiarization 和标点模型都从本项目 `model/` 加载。入口脚本会设置 Hugging Face、Transformers 和 ModelScope 离线变量；代码没有官方在线 API 或模型下载回退。`vllm_gpu_memory_utilization` 保持当前已经验证的 `0.7`。

8885 不是第二个模型进程，只是平台标准端口。它仅对外开放 `/health`、`/v1/audiototext` 和 `/translator/*`；6006 继续保留项目原来的通用接口。

## 2. 配置准备

模型目录至少应包含：

```text
model/Tailect_V4.1/
model/Qwen3-ForcedAligner-0.6B/
model/iic/punc_ct-transformer_zh-cn-common-vocab272727-pytorch/
```

URL 输入默认全部拒绝。若业务确实需要模型电脑自行下载一个完整 WAV，复制示例配置：

```bash
cp config/audio_url_allowlist.json.example config/audio_url_allowlist.json
```

然后只填写现场允许的内网主机、域名、通配子域名或 CIDR，例如：

```json
{
  "version": 1,
  "allow_hosts": [
    "audio.internal",
    "*.media.internal",
    "10.20.0.0/16"
  ]
}
```

该文件按修改时间自动热加载，不需要重启。文件缺失、JSON 无效或规则为空时，URL 模式会 fail-closed；multipart 上传不受影响。每次 HTTP 重定向都会重新校验目标主机，下载禁用系统代理，并受大小、超时和重定向次数限制。

如需 API Key，在启动前设置：

```bash
export TAILECT_API_KEY='现场密钥'
```

密钥为空时不强制鉴权。启用后支持 `X-API-Key`、`Authorization: Bearer ...`，也兼容 query 中的 `api_key`。不要把现场密钥写入 Git 或启动脚本。

## 3. 单 4090 启停

先确认 `GPU_ID` 是 4090 在宿主机中的编号，再运行：

```bash
cd /path/to/tailect
GPU_ID=0 bash script/run_v4_1_single_4090.sh start
```

可覆盖离线镜像名：

```bash
IMAGE=tailect-asr-qwen3-asr:offline-salvaged-20260506 \
NGINX_IMAGE=nginx:alpine \
GPU_ID=0 \
bash script/run_v4_1_single_4090.sh start
```

脚本有以下保护：

- 不自动终止任何端口占用者；6006 或 8885 被占用时直接拒绝启动。
- 不删除容器；`stop` 只停止本项目两个固定名称的容器。
- 容器内只暴露一张选定 GPU，并统一使用 `cuda:0`。
- 运行目录、模型目录、上传、CSV 和日志都保持在本项目范围内。

状态与停止：

```bash
bash script/run_v4_1_single_4090.sh status
bash script/run_v4_1_single_4090.sh stop
```

健康检查：

```bash
curl http://127.0.0.1:6006/health
curl http://127.0.0.1:8885/health
```

`/health` 重点字段：

```json
{
  "status": "ok",
  "model": "Tailect_V4.1",
  "service_ready": true,
  "platform_api_port": 8885,
  "api_key_required": false,
  "audio_url_allowlist": {
    "loaded": false,
    "rule_count": 0,
    "error": "allowlist file not found: ..."
  },
  "inference_queue": {
    "concurrency": 1,
    "busy": false,
    "waiting": 0
  }
}
```

白名单未配置导致 `loaded=false` 是安全默认值，不代表 multipart 转写不可用。

## 4. 平台 v1 转写合同

### 4.1 上传音频

```bash
curl -X POST \
  'http://127.0.0.1:8885/v1/audiototext?model=Tailect_V4.1&diarize=0&language=auto&max_chars=40' \
  -H 'Accept: application/json' \
  -H 'X-API-Key: 现场密钥' \
  -F 'file=@audio.wav;type=audio/wav'
```

可选参数：

| 参数 | 默认值 | 说明 |
| --- | --- | --- |
| `model` | 无 | 必填且只能为 `Tailect_V4.1`；也兼容写法 `v4.1` |
| `file` | 无 | multipart 音频文件，或 form/query 中的完整 WAV URL |
| `diarize` | `0` | `1` 时运行本地 TargetDiarization，并按最大时间重叠分配 `lid` |
| `language` | `auto` | `zh/en/ja/ko/yue/auto`，模型报告语言优先 |
| `max_chars` | `40` | 字幕行聚合的软长度上限，范围 1–500 |
| `split_by_punctuation` | `1` | 按中英文标点切字幕行 |

非 WAV 上传会由离线 ffmpeg 转换为 16kHz 单声道 WAV。扩展名为 `.wav` 但文件头非法会直接拒绝；`.sdp` 仅作为“内容确实为 WAV”的业务文件名兼容，不解析 SDP 协议。

### 4.2 URL 输入

```bash
curl -X POST 'http://127.0.0.1:8885/v1/audiototext?model=Tailect_V4.1' \
  --data-urlencode 'file=http://audio.internal/path/audio.wav?filename1=record.sdp'
```

只有白名单内 HTTP(S) 主机可用。响应必须是完整 WAV；HTML、JSON、流式 SDP 或其它伪装内容会返回错误。

### 4.3 成功响应

HTTP 状态始终为 200；业务状态看 body 的 `code`：

```json
{
  "code": 200,
  "language": "zh",
  "data": [
    {"lid": "1", "text": "识别文本。", "begin": 1280, "end": 2240}
  ],
  "file_name": "audio.wav",
  "message": "",
  "uuid": "非空请求UUID"
}
```

时间戳来自项目本地 `Qwen3-ForcedAligner-0.6B`。对齐失败或没有时间戳时返回明确业务错误，不生成全零时间戳，也不联网寻找替代模型。

### 4.4 失败响应

```json
{
  "code": 500,
  "language": "",
  "data": [],
  "file_name": "",
  "message": "[E001] missing required parameter: model",
  "uuid": "非空请求UUID"
}
```

主要错误码：

| 错误码 | 含义 |
| --- | --- |
| `E001` / `E002` | 缺少模型名 / 模型名不支持 |
| `E003` / `E004` | 请求过大 / 文件名或 WAV 内容非法 |
| `E005` / `E006` | 速率超限 / API Key 错误 |
| `E007` / `E008` | 空文件 / ffmpeg 转换失败 |
| `E009` / `E010` | 模型服务未就绪 / 缺少 file |
| `E011` / `E012` | FIFO 队列已满 / 等待超时 |
| `E013`–`E015` | URL 非法、下载失败、响应不是 WAV |
| `E016` | 本地 ForcedAligner 未返回时间戳 |
| `E020`–`E022` | CSV 不存在、JSON 非法、修正行不存在 |

## 5. CSV 与人工修正 API

模型端 CSV 按实际客户端 IP 分目录保存到 `outputs/fanyin_output/`，不会信任请求中的 `client_ip_hint` 来伪造目录。每次保存同时更新 SQLite 修订号、版本 UUID 和 SHA-256。

保存：

```http
POST /translator/csv
Content-Type: application/json

{
  "record_key": "业务记录键",
  "csv_filename": "记录.csv",
  "csv_text": "完整CSV文本",
  "write_event": "recognition_complete",
  "client_id": "可选客户端标识"
}
```

查询状态与读取：

```http
GET /translator/csv/status?record_key=业务记录键&filename=记录.csv
GET /translator/csv?record_key=业务记录键&filename=记录.csv
```

修正一行：

```http
POST /translator/feedback
Content-Type: application/json

{
  "record_key": "业务记录键",
  "csv_filename": "记录.csv",
  "segment_no": 1,
  "corrected_text": "修正后的文本",
  "feedback_history": false
}
```

写 CSV 使用同目录临时文件加原子替换，避免中途产生半截正式文件。

## 6. 油猴脚本

V4.1 专用文件位于仓库根目录 `spyware-translator-v4.1/`。它使用独立 localStorage、唯一 DOM ID、唯一模型选项，不修改原 `spyware-translator/`。

默认设置：

- 模型服务：`http://127.0.0.1:8885`
- 模型：`Tailect_V4.1`
- 本机 CSV 助手：`http://127.0.0.1:18885`
- 浏览器任务并发：1

模型服务在其它内网电脑时，只修改脚本面板中的服务 IP。健康检查会同时验证 `/health` 和 `health.model=Tailect_V4.1`，避免误连旧模型。

## 7. 验收命令

不加载 GPU 模型的单元测试：

```bash
PYTHONPATH=. python -m unittest tests.test_v1_platform -v
```

油猴静态检查：

```bash
node ../spyware-translator-v4.1/tests/userscript_static_test.mjs
```

模型启动后的真实合同探测：

```bash
node ../spyware-translator-v4.1/tests/tailect_v41_probe.mjs \
  http://127.0.0.1:8885 Tailect_V4.1 ../prompt材料/bian.wav
```

这台开发机未在实施过程中启动模型或占用端口；真实 GPU 加载、显存峰值、识别准确率和两机浏览器联调必须在离线生产环境按上述命令验收。

## 8. 未来双卡方向（本版本未启用）

5070 Ti 接入时，建议运行两个完全独立的 worker，每个进程只看到一张 GPU，由网关 FIFO 把下一个任务交给空闲 worker。4090 和 5070 Ti 显存、速度不同，不适合 tensor parallel；也不要让两个进程共享一份 vLLM CUDA 上下文。本版本只交付单 4090、单模型进程，避免在没有实测前改变当前显存配置。
