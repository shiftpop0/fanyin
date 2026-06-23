# Tailect ASR v1 离线部署与联调手册

本文档面向语音转文本 v1 接口调用方和现场部署人员。当前服务提供 `POST /v1/audiototext`，接口字段对齐项目根目录的 `语音转文本v1接口.md`。

## 1. 离线运行约束

- 服务使用随包 WinPython，不需要联网安装依赖。
- 默认设置 `MODELSCOPE_OFFLINE=1`、`HF_HUB_OFFLINE=1`、`TRANSFORMERS_OFFLINE=1`。
- 启动脚本会清空 `HTTP_PROXY`、`HTTPS_PROXY`、`ALL_PROXY`，并设置 `NO_PROXY=127.0.0.1,localhost`。
- 对外公开模型别名只支持 `Taizhou`、`Tiantai`。
- 说话人分离使用服务运行目录下的本地配置副本：`outputs/api_runtime/diarization/speech_campplus_speaker-diarization_common_local`。
- API 不改写原始模型目录下的 CAM++ 配置文件。
- 上传文件保留在 `outputs/api_uploads/<uuid>/`，服务不会删除上传文件或转码文件。

## 2. 配置与启动服务

推荐使用配置化服务脚本：

```bat
Tailect_ASR_Win10\API服务-启动.bat
```

启动脚本会轮询 `http://127.0.0.1:<port>/health`，只有返回 `status=ok` 后才报告启动成功，默认最长等待 180 秒。如果模型进程提前退出或超时，脚本返回非零退出码并提示 stderr 日志位置。

如果配置端口已被占用：

- 占用者是健康的 Tailect v1 API 时，脚本复用该进程并刷新 PID 文件。
- 占用者不是 Tailect v1 API 时，脚本拒绝启动并返回非零退出码。

默认配置文件：

```text
Tailect_ASR_Win10/api_v1_config.json
```

常用配置项：

| 配置项 | 默认值 | 说明 |
| ------ | ------ | ---- |
| `model` | `Taizhou` | 当前服务进程加载的模型别名 |
| `host` | `0.0.0.0` | 监听地址 |
| `port` | `8885` | 监听端口 |
| `server` | `uvicorn` | 离线包内默认服务引擎 |
| `max_upload_mb` | `512` | 上传大小上限 |
| `queue_timeout_sec` | `600` | 请求排队等待上限 |
| `rate_limit_per_minute` | `60` | 单客户端每分钟请求上限 |
| `diarize` | `true` | 是否启用说话人分离 |
| `diarization_fallback` | `true` | 说话人分离失败时是否降级为单说话人 |
| `api_key_env` | `TAILECT_API_KEY` | API Key 环境变量名 |

命令行显式参数优先级高于配置文件。

状态检查：

```bat
Tailect_ASR_Win10\API服务-状态.bat
```

停止服务：

```bat
Tailect_ASR_Win10\API服务-停止.bat
```

也可以使用交互式启动器：

```bat
Tailect_ASR_Win10\一键启动API服务.bat
```

也可以直接传入模型名和端口：

```bat
Tailect_ASR_Win10\一键启动API服务.bat Taizhou 8885
```

手工启动：

```bat
cd /d Tailect_ASR_Win10
WPy64-312101\python\python.exe -m tailect_asr.cli.api_v1 ^
  --config api_v1_config.json
```

默认运行方式为 `uvicorn` 单进程。不要配置多 worker；多 worker 会重复加载大模型并显著增加显存占用。

生产联调时建议设置 API Key：

```bat
set TAILECT_API_KEY=请替换为实际密钥
```

设置后调用方需传入 `X-API-Key` 请求头，或使用 `Authorization: Bearer <key>`。未设置 `TAILECT_API_KEY` 时，服务保持本机联调模式，不启用 API Key 鉴权。

## 3. 健康检查

```shell
curl http://127.0.0.1:8885/health
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

## 4. 转写接口

URL：

```shell
POST http://127.0.0.1:8885/v1/audiototext
```

请求参数：

| 参数 | 必填 | 位置 | 说明 |
| ---- | ---- | ---- | ---- |
| model | 是 | query 或 form | `Taizhou` 或 `Tiantai` |
| file | 是 | multipart/form-data | 音频文件 |
| language | 否 | query 或 form | `zh/en/ja/ko/yue/auto`，为空时自动识别 |
| diarize | 否 | query 或 form | `true/false`，默认使用服务启动参数 |
| max_chars | 否 | query 或 form | 单条字幕行最大字符数，默认 40 |

示例：

```shell
curl -X POST "http://127.0.0.1:8885/v1/audiototext?model=Taizhou" ^
  -H "accept: application/json" ^
  -H "X-API-Key: 请替换为实际密钥" ^
  -F "file=@prompt材料/bian.wav;type=audio/wav"
```

成功响应始终为 HTTP 200，body 的 `code=200`：

```json
{
  "code": 200,
  "language": "zh",
  "data": [
    {
      "lid": "1",
      "text": "滴滴出行来电：",
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

## 5. 错误信息

| 错误标识 | 场景 |
| -------- | ---- |
| `E001` | 缺少 `model` |
| `E002` | `model` 不在 `Taizhou/Tiantai` 公开别名内 |
| `E003` | 请求体或上传文件超过 `--max-upload-mb` |
| `E004` | 音频扩展名不支持 |
| `E005` | 非 wav 音频需要转码，但离线包内未找到 ffmpeg |
| `E006` | 音频转码失败 |
| `E007` | 上传文件为空 |
| `E008` | 模型正忙，请求等待超过 `--queue-timeout-sec` |
| `E009` | 当前进程加载的模型和请求模型不一致 |
| `E010` | 缺少上传字段 `file` |
| `E011` | API Key 鉴权失败 |
| `E012` | 单客户端请求频率超过 `--rate-limit-per-minute` |
| `E500` | 未分类服务异常 |

## 6. 说话人分离与 lid

- 当前版本 `data[]` 暂按字幕行切段。
- `lid` 为字符串，从 `"1"` 开始。
- 若启用 `--diarization-fallback`，说话人分离单次推理失败时不会阻断 ASR；服务会记录异常日志，并按单说话人返回 `lid="1"`。
- 模型自检默认不启用降级；自检失败表示说话人分离离线链路需要排查。

## 7. 自检与验收

模型自检：

```bat
Tailect_ASR_Win10\一键模型自检.bat
```

可跳过交互选择，直接指定模型：

```bat
Tailect_ASR_Win10\一键模型自检.bat Taizhou
Tailect_ASR_Win10\一键模型自检.bat Tiantai
```

联调验收：

```shell
node spyware-translator/temp/tailect_v1_probe.mjs http://127.0.0.1:8885 Taizhou prompt材料/bian.wav
```

验收脚本会检查：

- `/health`
- 缺少 `model`
- 非法 `model`
- 缺少 `file`
- 空文件
- 正常上传转写
- v1 顶层字段和 `data[]` 字段完整性

## 8. 日志

API 日志位于：

```text
Tailect_ASR_Win10/outputs/logs/api_v1_<model>_<yyyyMMdd>.log
```

日志记录请求 `uuid`、模型、文件名、行数、识别语种、是否启用说话人分离、耗时和异常堆栈。

日志默认按 20MB 轮转，最多保留 5 个历史文件。
