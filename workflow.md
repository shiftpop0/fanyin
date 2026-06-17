## 2026-06-16 阶段 1：启动复现与基础转写验证

- 目标：复现 `Tiantai`、`Taizhou` 启动路径，采集控制台输出，并确认 `Taizhou` 是否在模型加载或 WebUI 启动阶段失败。
- 执行方式：使用 `Tailect_ASR_Win10/WPy64-312101/python/python.exe` 直接加载模型，设置离线环境变量 `MODELSCOPE_OFFLINE=1`、`HF_HUB_OFFLINE=1`、`TRANSFORMERS_OFFLINE=1`，不修改源码和模型文件。
- `Tiantai` 最小加载结果：ASR 主模型和 ForcedAligner 加载成功，CUDA 可用，设备为 `NVIDIA GeForce RTX 3060 Laptop GPU`，耗时约 7.39 秒。
- `Taizhou` 最小加载结果：ASR 主模型和 ForcedAligner 加载成功，CUDA 可用，耗时约 5.69 秒。
- `Taizhou` 完整 WebUI 启动结果：`python -m tailect_asr.cli.demo --asr-checkpoint models/ASR/Taizhou --aligner-checkpoint models/ForcedAligner --backend transformers --ip 0.0.0.0 --port 7867` 启动成功，Gradio 监听 `0.0.0.0:7867`。
- `Tiantai` 完整 WebUI 启动结果：同路径启动成功，Gradio 监听 `0.0.0.0:7867`。
- `Taizhou` 转写验证：通过现有 `spyware-translator/temp/tailect_http_probe.mjs` 调用 Gradio 接口，样本 `prompt材料/bian.wav` 转写成功，识别语言为 `Chinese`，生成 6 行 SRT 字幕。
- 重要观察：当前环境未复现“选择 Taizhou 模型启动失败”。静态结构和实际加载均通过，后续应把该问题记录为“历史环境/特定启动方式/控制台编码或依赖环境差异待验证”，并建议新增启动日志和 preflight 探针。
- 重要观察：Gradio 启动期间出现 `GET https://api.gradio.app/pkg-version` 日志，说明当前 WebUI 启动并非完全无外联；服务化交付时应避免依赖 Gradio 启动链或显式关闭版本检查/分析请求。
- 日志位置：`Tailect_ASR_Win10/outputs/logs/probe_taizhou_webui_stdout.log`、`probe_taizhou_webui_stderr.log`、`probe_tiantai_webui_stdout.log`、`probe_tiantai_webui_stderr.log`、`probe_taizhou_transcribe_webui_stdout.log`、`probe_taizhou_transcribe_webui_stderr.log`。

## 2026-06-16 阶段 2：说话人分离离线加载诊断

- 目标：验证 CAM++ 说话人分离在当前本地模型包中是否可加载、可推理，并定位严格离线环境下的风险点。
- 只读直连测试：直接使用 `modelscope.pipelines.pipeline(task='speaker-diarization', model=models/models/iic/speech_campplus_speaker-diarization_common)` 加载本地 CAM++ 主模型，加载成功。
- 只读直连推理：对 `prompt材料/bian.wav` 执行说话人分离，推理成功，返回形如 `{'text': [[0.02, 0.65, 0], ...]}` 的说话人时间段。
- WebUI 真实路径测试：为避免改写原始 CAM++ 配置，复制一份主模型目录到 `Tailect_ASR_Win10/outputs/logs/sd_model_probe_copy_20260616_150307`，将 `TAILECT_SD_MODEL_PATH` 指向该诊断副本，再通过 Gradio `diarize=true` 调用 Taizhou 转写。
- WebUI 真实路径结果：说话人分离初始化成功，SRT 预览中出现 `[角色 0]`，说明当前环境下 WebUI 的说话人分离功能可用。
- 原始配置确认：`Tailect_ASR_Win10/models/models/iic/speech_campplus_speaker-diarization_common/configuration.json` 仍保持远端子模型 ID，没有被本次诊断改写。
- 风险 1：主 CAM++ 配置仍写 `damo/speech_campplus_sv_zh-cn_16k-common`、`damo/speech_campplus-transformer_scl_zh-cn_16k-common`、`damo/speech_fsmn_vad_zh-cn-16k-common-pytorch`，项目代码依赖运行时修补配置来转成本地绝对路径，严格离线部署不够确定。
- 风险 2：ModelScope 日志仍出现 `Downloading Model from https://www.modelscope.cn ...`，即使最终命中本地缓存。该日志说明当前路径仍经过 hub/cache 解析语义，不适合作为对外服务的稳定离线链路。
- 风险 3：FunASR VAD 加载时默认触发 PyPI 版本检查，源码位置为 `funasr/auto/auto_model.py` 中 `check_for_update(disable=kwargs.get("disable_update", False))`；`funasr/utils/version_checker.py` 会访问 `https://pypi.org/pypi/funasr/json`。服务化时应显式禁用或补丁化处理。
- 风险 4：当前 WebUI 只把说话人标记拼进 SRT 文本，如 `[角色 0] 文本`，没有结构化返回 `lid`。对接 v1 接口时必须把 speaker id 结构化成 `data[].lid`。

## 2026-06-16 阶段 3：v1 接口适配范围梳理

- 目标：对照 `语音转文本v1接口.md`，确认当前项目与 `POST /v1/audiototext` 的差距，以及需要修改的文件/模块范围。
- 当前接口现状：项目没有现成 `/v1/audiototext` 服务；现有调用方式是 Gradio 私有接口 `/gradio_api/upload`、`/gradio_api/call/run`、`/gradio_api/call/run/{event_id}`，不适合直接对第三方公开。
- 可复用能力：`Qwen3ASRModel.from_pretrained()` 和 `transcribe(audio=..., return_time_stamps=True)` 可直接作为 v1 服务内部核心调用，避免绕 Gradio 上传、排队、SSE。
- 直接转写验证：Taizhou 直接调用 `Qwen3ASRModel.transcribe()` 成功，样本返回 `language=Chinese`、文本和 33 个词/字级时间戳。时间戳单位为秒，需要转换为毫秒。
- 分段策略：v1 `data[]` 暂按“字幕行切段”实现，不直接返回词/字级时间戳。可复用 WebUI `_generate_srt_content()` 的断句思路，但需要输出结构化列表，而不是 SRT 字符串。
- 语言映射：内部返回 `Chinese`、`English`、`Japanese`、`Korean`、`Cantonese` 等；v1 需要 `zh`、`en`、`ja`、`ko`、`yue`。其他语言可暂定映射为空、原样或扩展码，需在文档中说明。
- 模型别名：按用户确认，外部公开 `Taizhou`、`Tiantai`。第一版建议“一进程加载一个模型”，`model` 参数用于校验别名；如要单服务多模型热切换，需要额外做模型缓存、互斥锁和显存释放。
- 服务框架：离线运行包中已存在 `flask=3.1.3`、`fastapi=0.135.1`、`uvicorn=0.42.0`、`gradio=6.9.0`、`requests=2.32.5`，新增 v1 服务无需联网安装依赖。建议优先使用 Flask/FastAPI 独立服务，而不是继续包装 Gradio。
- 需要新增/调整的范围：新增 `tailect_asr/cli/api_v1.py` 或同等入口；新增 API 启动 bat；抽出音频预处理、字幕行切段、说话人分离、语言映射、错误响应；新增 probe/验收脚本；补部署文档。
- 额外风险：现有 WebUI `_convert_media_to_standard_wav()` 使用 `tempfile.mktemp()`，并在转写结束后 `os.remove(processed_path)` 清理临时转码文件。后续若按用户约束实现服务侧逻辑，应避免删除文件，或将清理策略改为移动到 `del/`/保留诊断目录。

## 2026-06-16 阶段 4：评估书输出与最终核对

- 目标：形成接口对接评估书，明确当前验证结论、现有问题、服务化推荐方案、建议修改范围和验收标准。
- 输出文件：`本地模型语音转文本v1接口对接评估书.md`。
- 文档核心结论：不建议直接开放 Gradio 私有接口；建议新增独立 `/v1/audiototext` HTTP 适配服务，内部直接调用 `Qwen3ASRModel.transcribe()`，再结构化输出 `language/data[].lid/text/begin/end`。
- 文档已纳入用户确认项：外部模型别名为 `Taizhou`、`Tiantai`；`data[]` 暂按“字幕行切段”；说话人分离当前不是主工作方向，但必须先解决结构化 `lid` 和严格离线稳定性。
- 文档已纳入实测结果：当前环境未复现 Taizhou 启动失败；Taizhou/Tiantai 均可启动；Taizhou 可转写；说话人分离在当前环境可运行，但存在外联和运行时配置修补风险。
- 最终核对：未删除任何文件；未修改运行源码；新增诊断日志和说话人分离诊断副本位于 `Tailect_ASR_Win10/outputs/logs`；原始 CAM++ 配置保持远端 ID，未被诊断过程改写。

## 2026-06-16 阶段 5：新增 v1 API 与模型自检入口

- 目标：按评估书 P0 继续实现，新增 `/v1/audiototext` 服务入口和模型 preflight 自检入口。
- 新增文件：`Tailect_ASR_Win10/WPy64-312101/python/Lib/site-packages/tailect_asr/cli/api_v1.py`。
- 新增能力：提供 Flask 服务，包含 `POST /v1/audiototext` 和 `GET /health`；外部模型别名支持 `Taizhou`、`Tiantai`；请求文件保留在 `outputs/api_uploads/<uuid>/`，不做删除清理。
- 新增能力：API 内部直接调用 `Qwen3ASRModel.transcribe()`，不依赖 Gradio 上传/排队/SSE；将内部 `Chinese/English/Japanese/Korean/Cantonese` 映射为 v1 的 `zh/en/ja/ko/yue`。
- 新增能力：按字幕行切段生成结构化 `data[]`，字段包含 `lid`、`text`、`begin`、`end`；说话人分离结果通过时间重叠映射到 `lid`，内部 speaker 0 对外映射为 `"1"`。
- 新增能力：服务启动时生成服务自有的 CAM++ 本地配置副本，位置为 `outputs/api_runtime/diarization/speech_campplus_speaker-diarization_common_local`，避免改写原始模型配置。
- 新增能力：在服务入口中 patch FunASR 更新检查，避免默认访问 PyPI 检查版本。
- 新增文件：`Tailect_ASR_Win10/WPy64-312101/python/Lib/site-packages/tailect_asr/cli/preflight.py`。
- 新增能力：preflight 会检查 ASR/ForcedAligner 文件布局、生成本地说话人分离配置、加载模型，并可用 `prompt材料/bian.wav` 做转写和说话人分离冒烟测试。
- 更新文件：`Tailect_ASR_Win10/WPy64-312101/python/Lib/site-packages/tailect_asr/__main__.py`，补充 `api_v1` 和 `preflight` 入口提示。
- 静态检查：`python -m py_compile` 通过；`python -m tailect_asr.cli.api_v1 --help` 和 `python -m tailect_asr.cli.preflight --help` 均可正常输出。
- 删除约束检查：新增 Python/JS/BAT 文件未使用 `os.remove`、`unlink`、`rmtree` 等删除调用。

## 2026-06-16 阶段 6：新增 Windows 启动与联调脚本

- 目标：补齐用户可直接双击/命令行调用的服务启动脚本和 probe。
- 新增文件：`Tailect_ASR_Win10/一键启动API服务.bat`。
- 脚本能力：设置 WinPython、模型目录、离线环境变量和代理清空变量；交互选择 `Taizhou`/`Tiantai`；默认启动 `http://127.0.0.1:8885/v1/audiototext?model=<模型名>`。
- 新增文件：`Tailect_ASR_Win10/一键模型自检.bat`。
- 脚本能力：交互选择模型并运行 `python -m tailect_asr.cli.preflight --model <模型名> --diarize`。
- 新增文件：`spyware-translator/temp/tailect_v1_probe.mjs`。
- probe 能力：请求 `/health`，上传 `prompt材料/bian.wav` 到 `/v1/audiototext?model=Taizhou`，打印 `code/language/uuid/data[]` 摘要，便于后续接口验收。

## 2026-06-16 阶段 7：preflight 与 v1 API 联调验收

- 目标：验证新增 API 和自检入口在当前本机模型包内可运行，并确认 `Taizhou`/`Tiantai` 两个公开别名的基础可用性。
- `Taizhou` 自检：`python -m tailect_asr.cli.preflight --model Taizhou --diarize` 通过；CUDA 可用，设备为 `NVIDIA GeForce RTX 3060 Laptop GPU`；ASR、ForcedAligner、CAM++ 本地配置副本均检查通过；模型加载约 7.09 秒。
- `Taizhou` 样本验收：自检使用 `prompt材料/bian.wav` 完成转写与说话人分离，返回 `row_count=5`，首行结构为 `{'lid': '1', 'text': '滴滴出行来电：', 'begin': 1280, 'end': 2320}`。
- `Taizhou` v1 API 验收：启动 `python -m tailect_asr.cli.api_v1 --model Taizhou --host 127.0.0.1 --port 8885 --diarize` 后，`spyware-translator/temp/tailect_v1_probe.mjs` 调用 `/health` 和 `/v1/audiototext?model=Taizhou` 成功；返回 `code=200`、`language=zh`、6 条按字幕行切段的 `data[]`。
- `Tiantai` 自检：`python -m tailect_asr.cli.preflight --model Tiantai --diarize --skip-transcribe` 通过；ASR、ForcedAligner、CAM++ 本地配置副本检查通过，模型加载约 8.73 秒。
- 离线相关观察：新增 API/preflight 已 patch FunASR 更新检查，日志中出现 `funasr version: 1.3.1. update check disabled by Tailect API.`；ModelScope 对本地目录仍可能打印类似 hub/cache 语义的日志，但本次验收未触发必需外网下载。
- 日志位置：`Tailect_ASR_Win10/outputs/logs/probe_api_v1_taizhou_stdout.log`、`Tailect_ASR_Win10/outputs/logs/probe_api_v1_taizhou_stderr.log`。

## 2026-06-16 阶段 8：最终清理、跟踪范围与剩余风险

- 目标：收尾确认没有遗留本轮启动的本地模型服务进程，整理 Git 可见性，并记录剩余上线风险。
- 进程状态：发现并停止了此前验证 WebUI 时留下的 `python -m tailect_asr.cli.demo` 进程；再次检查后未见 `python/python3` 模型服务进程。
- Git 可见性：调整顶层 `.gitignore` 和 `Tailect_ASR_Win10/WPy64-312101/python/Lib/site-packages/.gitignore`，仅放行 `tailect_asr` 的最小包入口、`api_v1.py`、`preflight.py`、新 BAT 脚本、评估书和 probe；原有 `demo.py/serve.py` 等运行环境文件仍保持忽略。
- 删除约束：本阶段未执行任何文件删除操作；新增服务也保留上传文件到 `outputs/api_uploads/<uuid>/`，不做删除清理。
- 剩余风险 1：当前 API 使用 Flask 内置开发服务器启动，对生产暴露时应改为 Windows 服务/进程守护加生产 WSGI 容器，或至少加反向代理、鉴权、限流和日志轮转。
- 剩余风险 2：`data[]` 暂按“字幕行”切段，能满足本版接口形状，但后续如果要求说话人切段、整句切段或更精细时间轴，需要调整分段策略。
- 剩余风险 3：本机环境未复现 `Taizhou` 启动失败；新增 preflight 可作为后续现场排查入口，若用户环境仍失败，优先比对自检输出中的模型文件、CUDA、路径编码和离线配置。

## 2026-06-16 阶段 9：v1 接口交付加固

- 目标：继续第 1 步，按 `语音转文本v1接口.md` 固化请求/响应、错误结构、联调验收脚本和对接文档。
- API 调整：`model` 收紧为公开别名 `Taizhou`、`Tiantai`；缺少 `model`、非法 `model`、缺少 `file`、空文件、上传过大、音频格式不支持、队列等待超时等场景统一返回 HTTP 200 + body `code=500`。
- 错误信息：新增 `E001` 到 `E010` 以及 `E500` 标识，写入 `message` 字段，保持顶层字段 `code/language/data/file_name/message/uuid` 不变。
- 上传处理：新增上传大小限制、分块保存、空文件检查和音频后缀检查；上传文件仍保留在 `outputs/api_uploads/<uuid>/`，不做删除清理。
- probe 调整：`spyware-translator/temp/tailect_v1_probe.mjs` 增强为合同验收脚本，覆盖 `/health`、缺 `model`、非法 `model`、缺 `file`、空文件、成功转写和响应 schema。
- 文档输出：新增 `Tailect_ASR_Win10/API_v1_离线部署与联调手册.md`，包含离线约束、启动方式、curl 示例、成功/失败响应、错误标识、`lid` 规则、验收脚本和日志位置。
- 静态验证：`api_v1.py`、`preflight.py` 通过 `py_compile`；`tailect_v1_probe.mjs` 通过 `node --check`；API/preflight 的 `--help` 均可正常输出。

## 2026-06-16 阶段 10：离线生产运行与说话人分离加固

- 目标：继续第 2 步和第 3 步，把服务运行方式、日志、启动自检、并发控制和说话人分离链路改成离线可运行版。
- 生产运行：当前离线包检测到 `fastapi`、`uvicorn` 可用，未检测到 `waitress`；API 默认改为 `--server uvicorn` 单进程运行，保留 `--server flask` 作为兼容降级。
- 日志：新增 `outputs/logs/api_v1_<model>_<yyyyMMdd>.log`，记录请求 `uuid`、模型、文件名、行数、识别语种、diarize 状态、耗时和异常堆栈；日志按 20MB 轮转，最多保留 5 个历史文件。
- 并发控制：模型推理仍保持单进程单模型；请求通过内部锁排队，`--queue-timeout-sec` 默认 600 秒，超时返回 `E008`。
- 鉴权与限流：新增可选 API Key 鉴权，支持 `TAILECT_API_KEY`、`--api-key`、`X-API-Key` 和 `Authorization: Bearer <key>`；新增内存限流，`--rate-limit-per-minute` 默认单客户端每分钟 60 次。
- 离线启动自检：新增 `run_startup_checks()`，检查 ASR/ForcedAligner 必要文件、uvicorn 可用性、本地 `ffmpeg.exe`、CAM++ 本地配置副本和离线环境变量。
- 说话人分离：`prepare_local_diarization_model()` 会校验 CAM++ 子模型配置已被写成本地存在路径；API 运行时如单次 diarization 推理失败，默认按 `--diarization-fallback` 降级为单说话人 `lid="1"` 并写日志；preflight 默认严格，不把降级当成通过。
- Windows 脚本：`一键启动API服务.bat` 改为 uvicorn 离线服务模式，显式传入 `--startup-check`、`--max-upload-mb 512`、`--queue-timeout-sec 600`、`--diarization-fallback`；`一键模型自检.bat` 改为离线严格自检。
- 验收结果：`Taizhou` 离线 preflight 通过；`Taizhou` uvicorn API 联调通过，合同 probe 返回 `code=200`、`language=zh`、6 条字幕行，并验证四类错误响应；`Tiantai` 离线 preflight 通过。
- 鉴权验证：使用 `--api-key local-test-key` 启动服务后，无 key 请求返回 `[E011] unauthorized request`；带 `X-API-Key: local-test-key` 的请求进入正常参数校验并返回 `[E001] missing required parameter: model`，证明鉴权链路生效。
- 服务清理：验收结束后已停止本轮启动的 `tailect_asr.cli.api_v1` 进程。

## 2026-06-17 阶段 11：交付清单与配置化服务管理

- 目标：在用户自行执行断网测试的前提下，继续完成交付文件整理、配置化启动和 Windows 启停/状态管理。
- API 配置化：`tailect_asr.cli.api_v1` 新增 `--config` 参数，读取 JSON 配置；命令行显式参数优先于配置文件，避免部署默认值覆盖临时调试参数。
- 新增配置文件：`Tailect_ASR_Win10/api_v1_config.json`，包含 `model/host/port/server/max_upload_mb/queue_timeout_sec/rate_limit_per_minute/diarize/diarization_fallback/api_key_env` 等默认部署参数。
- 新增服务管理脚本：`Tailect_ASR_Win10/api_v1_service.ps1`，支持 `start/stop/status`，统一设置离线环境变量、清空代理、按配置启动 API、写入 PID 文件、查询端口监听和停止 PID 文件指向的 API 进程。
- 新增 BAT 入口：`API服务-启动.bat`、`API服务-停止.bat`、`API服务-状态.bat`，便于现场人员不用直接执行 PowerShell 命令。
- 新增交付清单：`本地模型v1接口交付清单.md`，列出必交付文件、不应纳入 Git 的内容、默认服务配置、验收命令、离线验收说明和当前已知约束。
- 文档更新：`Tailect_ASR_Win10/API_v1_离线部署与联调手册.md` 已补充配置文件、服务启动/停止/状态脚本和配置项说明。
- Git 范围：`.gitignore` 显式放行新增配置、PowerShell 服务脚本、服务 BAT 入口和离线联调手册；模型、WinPython 大运行时、outputs、日志和音频仍保持忽略。
- 验证结果：`py_compile` 通过；配置文件可被 `api_v1` 解析为 `Taizhou 0.0.0.0 8885 uvicorn 512 60`；`api_v1_service.ps1 status` 可正常输出配置、端口和进程状态；通过 `api_v1_service.ps1 start` 成功启动服务并写入 PID，`tailect_v1_probe.mjs` 合同验收通过，随后通过 `api_v1_service.ps1 stop` 正常停止服务。
- 删除约束：本阶段未执行文件删除；脚本不删除 PID 或日志，仅覆盖写入 PID/停止记录文件。
