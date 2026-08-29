# Tailect ASR v1 离线部署与联调手册

本文档面向语音转文本 v1 接口调用方和现场部署人员。当前服务提供 `POST /v1/audiototext`，接口字段对齐项目根目录的 `语音转文本v1接口.md`。


## 1. 健康检查

```shell
curl http://12.33.114.183:8885/health
```

典型返回：

```json
{
  "status": "ok",
  "model": "Taizhou",
  "server": "uvicorn",
  "cuda": true,
  "diarization": true,
  "diarization_model": "C:\\program5\\fanyin\\Tailect_ASR_Win10\\outputs\\api_runtime\\diarization\\speech_campplus_speaker-diarization_common_local",
  "max_upload_mb": 512,
  "audio_url_enabled": true,
  "audio_url_timeout_sec": 30.0,
  "audio_url_max_redirects": 5,
  "queue_timeout_sec": 600.0,
  "auth_enabled": true,
  "rate_limit_per_minute": 60,
  "offline": {
    "modelscope": true,
    "huggingface": true,
    "transformers": true
  }
}
```

## 2. 转写接口

URL：

```shell
POST http://12.33.114.183:8885/v1/audiototext
```

请求参数：

| 参数 | 必填 | 位置 | 说明 |
| ---- | ---- | ---- | ---- |
| model | 是 | query 或 form | `Taizhou` 或 `Tiantai` |
| file | 是 | multipart/form-data 或 form | 音频文件，或可直接下载 WAV 的 HTTP(S) URL |
| language | 否 | query 或 form | `zh/en/ja/ko/yue/auto`，为空时自动识别 |
| diarize | 否 | query 或 form | `true/false`，默认使用服务启动参数 |
| max_chars | 否 | query 或 form | 单条字幕行最大字符数，默认 40 |

示例：

```shell
curl -X POST "http://12.33.114.183:8885/v1/audiototext?model=Taizhou" ^
  -H "accept: application/json" ^
  -F "file=@files/bian.wav;type=audio/wav"
```

也可以继续使用同一个 `file` 字段提交音频 URL，不需要新增字段：

```shell
curl -X POST "http://12.33.114.183:8885/v1/audiototext?model=Taizhou" ^
  -H "accept: application/json" ^
  --data-urlencode "file=http://xxxx/audio.wav?filename1=2026061234.sdp"
```

URL 模式说明：

- 服务端会下载 URL 指向的内容，并沿用 `--max-upload-mb` 大小限制。
- `filename1=2026061234.sdp` 仅作为响应中的业务文件名，不用于判断音频格式。
- 服务端会检查下载内容的 WAV 文件头；响应内容不是有效 WAV 时拒绝识别。
- URL 仅支持 `http/https`。可通过环境变量 `TAILECT_AUDIO_URL_ALLOW_HOSTS`，或启动参数
  `--audio-url-allow-hosts`，配置允许访问的主机、IP 或 CIDR，多个规则以英文逗号分隔。
- `--audio-url-timeout-sec` 默认 30 秒，`--audio-url-max-redirects` 默认 5 次。

成功响应始终为 HTTP 200，body 的 `code=200`：

```json
{
  "code": 200,
  "language": "zh",
  "data": [
    {
      "lid": "1",
      "text": "滴滴出行来电：xxxx",
      "begin": 1280,
      "end": 2240
    }
  ],
  "file_name": "bian.wav",
  "message": "",
  "uuid": "4a7a0057-d754-4121-86f7-3d801bc18c17"
}
```

失败响应也按 v1 约定返回 HTTP 200，body 的 `code=500`：

```json
{
  "code": 500,
  "language": "",
  "data": [],
  "file_name": "",
  "message": "[E001] missing required parameter: model",
  "uuid": "4a7a0057-d754-4121-86f7-3d801bc18c17"
}
```

## 3. 错误信息

| 错误标识 | 场景 |
| -------- | ---- |
| `E001` | 缺少 `model` |
| `E002` | `model` 不在 `Taizhou/Tiantai` 公开别名内 |
| `E003` | 请求体、上传文件或远程音频超过 `--max-upload-mb` |
| `E004` | 音频扩展名不支持 |
| `E005` | 非 wav 音频需要转码，但离线包内未找到 ffmpeg |
| `E006` | 音频转码失败 |
| `E007` | 上传文件为空 |
| `E008` | 模型正忙，请求等待超过 `--queue-timeout-sec` |
| `E009` | 当前进程加载的模型和请求模型不一致 |
| `E010` | 缺少上传字段 `file` |
| `E011` | API Key 鉴权失败 |
| `E012` | 单客户端请求频率超过 `--rate-limit-per-minute` |
| `E013` | 音频 URL 无效、协议不支持或目标主机不在允许范围内 |
| `E014` | 音频 URL 下载失败、HTTP 状态异常或重定向过多 |
| `E015` | URL 响应内容不是有效 WAV 音频 |
| `E500` | 未分类服务异常 |

