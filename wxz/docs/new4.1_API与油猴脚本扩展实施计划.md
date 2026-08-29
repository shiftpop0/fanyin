# new4.1 API 与油猴脚本扩展实施计划

编制日期：2026-08-29  
工作区：`C:\program5\fanyin4.1`  
目标远端：`https://github.com/shiftpop0/fanyin.git`  
目标分支：`new4.1`

## 1. 任务边界

本计划已由用户确认并进入实施。开发阶段不启动模型、不占用或终止任何端口进程；完成静态与离线合同测试后，再提交并推送远端 `new4.1` 分支。

后续实施目标：

1. 将当前 `tailect` 模型服务纳入远端 `fanyin.git` 的 `new4.1` 分支，同时保留 `origin/main` 的历史和旧版实现。
2. 在当前 FastAPI 服务上增加与旧项目一致的 v1 API、CSV、反馈、鉴权、限流、URL/SDP 兼容能力。
3. 复用并升级旧项目的油猴脚本，使其默认接入 Tailect V4.1 API，并继续支持切片捕获/合并、页面 UI、双端 CSV、缓存与人工修正。
4. 提供静态测试、合同测试、GPU 实机测试、浏览器 mock 回归和离线交付文档。

不纳入 Git：模型权重、14.9 GB 离线镜像 tar、运行时、日志、上传音频、输出 CSV/SQLite、测试产物、便携 Node 二进制及其它大文件。

## 2. 已完成的调研结论

### 2.1 Git 与目录现状

- 当前工作区已经接入目标 Git 仓库，当前实现位于 `new4.1` 分支。
- 当前根目录主要包含：
  - `tailect/`：源码、模型、测试及部署脚本。
  - `tailect-asr-qwen3-asr-full-diar-offline.tar`：约 14.9 GB，绝不能提交 Git。
  - `AGENTS.MD`：本工作区操作规则。
- 目标远端当前只有 `main` 分支；远端 `new4.1` 尚不存在。
- 旧项目只在调研阶段用于理解平台合同和油猴行为，完成复刻后不复制到当前分支。
- 推荐在当前根目录建立 Git，并以 `origin/main` 为基线创建 `new4.1`，不能建立无历史的 orphan 分支。远端旧实现只作为可复用代码与历史来源；`new4.1` 的实际产品范围只有当前 `Tailect_V4.1` 一个模型，不设计多模型切换或新旧模型并存。

### 2.2 当前模型服务能力

当前 `tailect` 是 Linux/Docker 取向的 FastAPI 离线服务，主要能力包括：

- Qwen3 ASR，支持 Transformers 与 vLLM 两种后端。
- `/asr_raw`、`/asr`、`/diarization`、`/forced_align`、`/punctuation`。
- 可选 `/api/stream/start|chunk|finish` 流式接口。
- 模型常驻内存；ASR 内有串行锁、重试、长音频切分与批量推理。
- 已具备 ForcedAligner，可把全文对齐为 `text/start/end` 秒级片段。
- 已具备说话人分离，可返回 `start/end/speaker`。

当前缺少旧油猴链路依赖的能力：

- 没有 `POST /v1/audiototext`。
- 没有 `/translator/csv/status`、`/translator/csv`、`/translator/feedback`。
- 没有 API Key、速率限制、可等待的队列超时、上传大小限制和稳定业务错误码。
- 没有 HTTP(S) WAV URL 下载、重定向安全校验和 `.sdp` WAV 别名兼容。
- 没有油猴脚本、本机 CSV 助手和对应离线客户端打包目录。
- 主 FastAPI 应用没有针对跨域/油猴访问的明确配置。

### 2.3 已发现的当前项目阻断项与风险

1. `core/config.py` 配置的 ASR 路径是 `model/Tailect_v4.0`，实际目录是 `model/Tailect_V4.1`；Linux 容器中会直接找不到模型。
2. README 又写成 `model/Tailect_v2.0`，代码、文档、真实目录三者不一致。
3. 根目录没有 `.gitignore`；14.9 GB 的 `.tar` 当前没有任何根级忽略保护。`tailect/.gitignore` 也未覆盖所有 WAV、测试输出和第三方 assets。
4. 当前入口默认 `auto_kill_port_occupier=True`，启动时可能终止非本项目进程。实施时必须改为“端口被占用则拒绝启动”，不能自动影响其它服务。
5. 当前仓库没有顶层 Python 依赖锁定/清单，仅第三方子目录存在零散 `requirements.txt`；离线镜像与源码的依赖版本不可审计。
6. `ASRWrapper.transcribe()` 丢弃了模型结果中的语言和时间戳，只保留文本。Qwen3-ASR 官方实现明确说明 `return_time_stamps=True` 需要在初始化时提供 `Qwen3-ForcedAligner`；当前项目已包含官方 `Qwen3-ForcedAligner-0.6B`，因此 v1 应按官方组合方式取得时间戳，不再设计其它对齐器或全零时间戳回退。
7. 当前说话人输出结构与旧 `api_v1.py` 的 ModelScope 输出结构不同，不能直接复制旧 `normalize_speaker_segments()`，必须写当前格式适配测试。
8. `TargetDiarization-main` 含第三方源码与演示资产；提交前应核对来源、许可证和真正需要跟踪的最小文件集合。
9. 当前已有代码会创建/清理临时文件；本次开发过程本身严格不删除文件，若必须淘汰文件则移动到 `./del`。运行期临时文件策略需在实现评审中单独确认，不能把业务输入误清理。

### 2.4 参考指南中必须继承的稳定契约

核心转写接口：

```http
POST /v1/audiototext?model=Tailect_V4.1&diarize=0|1&language=auto&max_chars=40
Content-Type: multipart/form-data
file=<完整或油猴合并后的音频>
```

也兼容 query/form：

```text
file=<HTTP(S) 完整 WAV URL>
```

返回结构保持：

```json
{
  "code": 200,
  "language": "zh",
  "data": [
    {"lid": "1", "text": "识别文本", "begin": 1280, "end": 2240}
  ],
  "file_name": "audio.wav",
  "message": "",
  "uuid": "非空任务 UUID"
}
```

模型端还需提供：

- `GET /health`
- `GET /translator/csv/status`
- `GET /translator/csv`
- `POST /translator/csv`
- `POST /translator/feedback`

浏览器电脑本机助手继续提供：

- `GET /local/health`
- `GET /local/ip`
- `GET /local/csv/status`
- `GET /local/csv`
- `POST /local/csv/save`
- `POST /local/csv/open-path`
- `POST /local/feedback`

## 3. 推荐目标架构

```text
业务网页
  -> 油猴脚本捕获 fetch/XHR/DOM/Performance 音频地址
  -> 探测 index=0..N 切片
  -> 浏览器下载并合并 PCM WAV；超长音频按 part 拆分
  -> multipart 上传至 tailect:8885/v1/audiototext（平台标准定制接口）
       -> 离线 Nginx/端口入口转发至同一 6006 FastAPI 模型进程
       -> v1 输入/安全/错误适配层
       -> 当前 UnifiedService：ASRWrapper（V4.1）
       -> 当前本地 ForcedAlignWrapper（Qwen3-ForcedAligner-0.6B）
       -> 当前 DiarizationWrapper 说话人片段
       -> 统一生成 lid/text/begin/end
  -> 油猴生成中文 CSV
       -> 模型端 /translator/* 保存
       -> 浏览器电脑 127.0.0.1:18885 /local/* 保存
```

设计原则：

- 保留当前 `/asr*`、`/diarization`、`/forced_align` 和流式接口，新增 v1 兼容层，不破坏现有调用方。
- 当前模型差异只进入模型适配层；HTTP、CSV、油猴不直接依赖 Qwen 私有结果对象。
- 油猴继续使用“切片下载—合并—multipart 上传”作为标准链路。只有上游明确提供单个完整 WAV 且模型电脑可直接访问时，才使用 URL 模式。
- 首期只按单张 4090、单个 Python 模型进程设计：现有通用 API 继续监听 6006，平台定制 API 通过 8885 暴露；显存中只加载一份当前项目模型。
- 8885 是正式的平台标准接口，不是旧接口兼容包袱；外部平台默认使用 8885，内部调用方可根据网络边界使用 8885，现有内部通用接口继续使用 6006。
- 双卡 FIFO 作为后续扩展预留，首期不引入双 worker 网关和油猴并发 2。
- 所有地址、端口、模型别名、上传限制、URL 白名单、输出目录由配置或环境变量提供，不写死现场密钥/IP。

## 4. 分阶段实施方案

### 阶段 A：Git 安全接入与提交边界

1. 在当前根目录先建立/补充根级 `.gitignore`，至少排除：
   - `*.tar`、`*.tar.gz`、`*.zip` 和离线运行时。
   - `tailect/model/`、所有模型权重格式。
   - `log/`、`outputs/`、上传目录、CSV、SQLite、PID、缓存。
   - WAV/MP3/MP4、测试结果和第三方 demo assets；确需保留的小测试夹具必须单独白名单并说明来源。
   - `del/`、`wxz/` 中的临时材料。
2. 在 `git init` 前后各做一次大文件清单；Git 建立后用 `git status --ignored`、`git check-ignore` 和 staged blob 大小扫描复核。
3. `git init`，添加 `origin`，fetch `origin/main`，从 `origin/main` 创建并跟踪本地 `new4.1`。
4. 若 checkout 与当前未跟踪文件发生冲突，停止并报告；冲突文件只允许移动到 `./del`，不允许覆盖或删除。
5. 保留远端旧版目录，新增当前 `tailect/` 源码；不要把 14.9 GB tar 或约 8.8 GB 模型目录纳入索引。

### 阶段 B：先修复 V4.1 基线

1. 把 ASR 模型路径、公开别名、健康检查、README 统一为 `Tailect_V4.1`（最终公开别名需用户确认）。
2. 增加集中配置项：服务版本、模型别名、6006/8885 端口角色、队列超时、上传上限、API Key 环境变量、速率限制、CSV 根目录、URL 超时/重定向、热加载白名单文件、CORS allowlist。
3. 默认关闭自动杀端口；端口被其它进程占用时清晰报错退出。
4. 增加不加载大模型的配置/路径静态自检；再增加单独的 GPU preflight，检查模型、ForcedAligner、说话人模型、CUDA、dtype、离线变量和真实样本推理。
5. 保持当前已验证的 `vllm_gpu_memory_utilization=0.7` 和其它核心推理参数；除修正 `Tailect_V4.1` 路径外，不以推测值覆盖生产测试参数。
6. 从离线镜像或可复现实机环境整理依赖版本清单，并说明 Docker 镜像导入及模型放置方式；运行期强制使用本地模型，禁止联网下载或远端回退。

### 阶段 C：实现 v1 API 兼容层

建议新增职责清晰的模块，避免继续膨胀 `core/api_server.py`：

- `core/v1_contract.py`：响应体、错误码、参数规范、语言映射。
- `core/v1_adapter.py`：调用当前 `UnifiedService`，输出统一时间戳与说话人字幕行。
- `core/audio_input.py`：限流保存、ffmpeg、WAV 头检查、URL/SDP 安全处理。
- `core/security.py`：API Key、Bearer、客户端速率限制、可信客户端 IP。
- `core/translator_store.py`：CSV、反馈、SQLite 同步状态与安全路径。
- `core/v1_router.py`：FastAPI 路由；在 `core/api_server.py` 中注册。

适配流程：

1. 校验 `model=Tailect_V4.1`、API Key、请求速率、文件/URL 二选一、大小与格式。
2. 首期以单进程有界 FIFO 队列保护整条 v1 推理链路；同一时间只执行一个顶层音频任务，队列满返回 `E011`、排队超时返回 `E012`，不能无限等待，也不能增加 uvicorn 模型副本。
3. 调用当前 ASR：
   - 以当前项目 README 和代码架构为准，保留 ASR 结果中的 `language` 和 `text`。
   - 直接调用当前 `UnifiedService.forced_align()` / `ForcedAlignWrapper.align()`，使用本地 `model/Qwen3-ForcedAligner-0.6B` 把 ASR 文本对齐为字/词级时间戳。
   - ForcedAligner 是当前项目明确列出的正式组成部分，不作为联网回退；如果本地对齐失败，返回明确错误，不尝试下载、替换或调用其它模型。
4. `diarize=1` 时调用当前 `DiarizationWrapper`；按字幕时间段与说话人时间段最大重叠分配 `lid`，再按首次出现顺序规范为 `1,2,3...`。
5. 依据标点和 `max_chars` 聚合字幕行，最终时间统一为整数毫秒，保证单调且 `begin <= end`。
6. 保持旧合同“业务成功/失败由 body.code 区分”的兼容行为，同时日志记录内部异常与 request UUID，不把堆栈或本机绝对路径返回浏览器。

错误码至少覆盖指南中的 `E001-E015`：缺参、非法模型、超大文件、格式错误、鉴权、空文件、排队超时、模型不匹配、URL 非法、下载失败、非 WAV 等。

URL/SDP 安全要求：

- 只允许 `http/https`，禁止 URL 内凭据。
- URL 功能默认拒绝所有主机；白名单放入独立 JSON 配置文件，允许运维人员直接增删业务主机/IP/CIDR，无需重启项目。
- 服务按文件修改时间热加载白名单，并以线程安全不可变快照提供给新请求；修改不会影响已经开始的下载。
- 配置解析失败时 URL 请求应 fail-closed 并在 `/health` 与日志报告配置错误，multipart 上传继续可用；修正文件后自动恢复。
- 白名单配置文件只在 Git 中提交不含现场地址的 `.example`，真实内网规则文件不提交。后续后台 Web 直接复用同一配置加载服务，无需改变下载校验逻辑。
- 每次重定向重新检查目标，禁用代理，限制重定向次数、响应大小和超时。
- 下载后检查 RIFF/RF64/BW64 + WAVE 文件头。
- `.sdp` 仅作为“内容确实是 WAV”的文件名别名，不实现 SDP 协议解析。

### 阶段 C2：8885 平台入口与未来双卡扩展边界

首期部署：

```text
通用调用方 -> :6006 当前 FastAPI
平台/油猴  -> :8885 离线 Nginx -> :6006 同一 FastAPI
GPU        -> 单张 4090
模型进程   -> 1 个
推理队列   -> 单进程 FIFO，并发 1
```

- 8885 只暴露平台标准所需的 `/health`、`/v1/audiototext`、`/translator/*` 等路由；其它内部通用端点继续由 6006 提供。
- 8885 与 6006 最终进入同一个 `UnifiedService`，不会重复加载 ASR、ForcedAligner、说话人和标点模型。
- 单卡启动脚本必须显式选择 4090 对应的宿主 GPU ID，但容器内部仍统一使用 `cuda:0`。
- 保持当前已实测的 `vllm_gpu_memory_utilization=0.7`，本轮不做显存调优实验。

未来启用 5070 Ti 时，再把单进程 FIFO 抽象为两个独立 worker 领取同一队列；本轮只预留 worker 注册/队列接口边界，不启动第二份模型、不引入 tensor parallel，也不改变油猴的串行队列。

### 阶段 D：实现模型端 CSV 与反馈

1. 从旧 `api_v1.py` 提取而非整文件复制 CSV/SQLite 能力。
2. 所有输出路径必须解析并验证在配置的 `translator_output_root` 内，拒绝绝对路径、`..` 和路径穿越。
3. 状态表记录 `client_ip/record_key/filename/revision/version_id/hash/write_event/updated_at`。
4. 保持“脚本端最后一次明确保存覆盖模型端”的现有业务策略，但写入采用临时文件 + 原子替换，避免半截 CSV。
5. API Key 与限流同时保护 `/translator/*`；`/local/*` 误发到模型端时返回 `LOCAL_HELPER_REQUIRED`。
6. 客户端 IP 只从连接地址或显式可信代理头获取，不能信任任意请求参数伪造目录名。

### 阶段 E：油猴脚本与本机助手

在独立的新目录 `spyware-translator-v4.1/` 中实现当前客户端。旧脚本只在设计阶段作为参考，完成复刻后不复制、不保留旧项目目录。当前客户端保留以下能力：

- fetch、XHR、DOM、Performance 四路音频捕获。
- `index=0..N` 切片探测、连续失败阈值、WAV 合并与超 10 分钟分 part。
- 普通列表/Wijmo、VX、通用音频 UI。
- 串行识别队列、弹窗播放、时间戳、修正、重识别。
- 25 列中文 CSV、双端保存、CSV 另存、打开路径、本机助手降级。

V4.1 必改项：

1. 提升 `@version` 与描述；加入/默认选择 `Tailect_V4.1`。
2. 油猴默认调用平台标准端口 `8885`；6006 保留给当前项目通用 API。本机助手仍固定浏览器电脑 `127.0.0.1:18885`。
3. 健康检查必须校验 `health.model` 与当前设置模型一致，错误中同时显示两者。
4. 使用 V4.1 专用 localStorage 命名空间，忽略旧模板遗留的 `Taizhou/Tiantai` 选择；界面只暴露当前 `Tailect_V4.1`。
5. 读取 CSV 缓存时复核“识别模型”列必须是 `Tailect_V4.1`，防止从旧模板环境迁移时误读不相干数据；当前项目本身不提供多模型缓存切换。
6. API Key 只保存在用户本机配置中，不写入发行脚本。
7. 正式包把 `@connect *` 收紧为实际业务域、模型服务和本机助手；若现场 IP 不固定，则在部署说明中解释保留通配符的风险。
8. 标准链路仍上传合并后的 WAV，不把 `index=0` 单片 URL 直接交给 API。
9. 复用 `local_helper`，检查 Node 18+、路径边界、CORS 和 Explorer 打开行为；重新生成离线包时不提交 `node.exe` 或 ZIP。

### 阶段 F：测试与验收

#### F1. 不加载模型的自动测试

- Python 格式/导入/单元测试。
- FastAPI TestClient + 假模型服务，覆盖所有 v1 顶层字段、错误码和 HTTP 兼容行为。
- 字幕聚合、时间戳毫秒转换、说话人最大重叠和编号稳定性。
- 上传大小、空文件、扩展名/WAV 头、`.sdp` 正反例。
- URL 协议、凭据、白名单、CIDR、每次重定向复核、超时、超大响应、HTML/JSON 冒充 WAV。
- API Key、Bearer、错误 Key、速率限制、队列超时。
- CSV 路径穿越、修订号/哈希、读取/覆盖、并发写入与本机助手误路由。
- 现有 `/asr*`、`/diarization`、流式路由不回归。
- userscript、本机助手、mock、probe 通过 `node --check`。

#### F2. GPU/离线实机测试

- 真实目录 `Tailect_V4.1` 在完全离线环境加载成功。
- Transformers 与实际交付后端（预计 vLLM）至少验证交付后端；记录 CUDA、显存峰值、首包/总耗时。
- 样本返回文本、语言和单调时间戳；时间戳由 Qwen3-ASR 官方支持的 `Qwen3-ForcedAligner-0.6B` 组合产生，失败时返回明确错误。
- 单张 4090、单个模型进程完成加载与真实推理；验证 FIFO 顺序、并发 1、队列上限与排队超时。
- `diarize=0/1` 均通过；失败时的降级策略与日志符合配置。
- 长音频切分、10 分钟油猴 part 偏移和队列串行行为通过。

#### F3. 浏览器与两台电脑联调

- mock 页面验证普通列表、VX、通用音频、虚拟滚动、60 秒等待点音频。
- 多切片合并后可播放，任务不因不同 `targetfile` 重复。
- V4.1 独立油猴目录和 localStorage 不读取原脚本目录的配置；缓存中的“识别模型”必须是 `Tailect_V4.1`。
- 模型电脑保存到 `{client_ip}` 目录，浏览器电脑保存到本机助手目录。
- 停止本机助手后，识别和浏览器“CSV 另存”仍可用。
- 断网后模型、API、油猴和本机助手全链路可运行。

### 阶段 G：文档、提交与推送

1. 合并当前 README 中的模型路径/部署说明，补一份 V4.1 API 与油猴联调手册，现场值统一写成变量，不写固定密钥/IP。
2. 生成 staged 文件清单和大文件报告，确认没有模型、tar、日志、音频、CSV、SQLite、运行时和敏感信息。
3. 推荐拆分提交，便于审查和回滚：
   - `chore: bootstrap new4.1 source and ignore offline artifacts`
   - `fix: align v4.1 model config and safe service startup`
   - `feat(api): add v1 transcription and translator endpoints`
   - `feat(userscript): connect v4.1 API and isolate caches`
   - `test: add v1 probes and browser mock coverage`
   - `docs: add v4.1 offline deployment and acceptance guide`
4. 每个提交后运行对应测试；最终确认 `new4.1` 相对 `origin/main` 的提交/文件差异。
5. 仅在用户确认重大决策且验收通过后，推送 `git push -u origin new4.1`。

## 5. 预计修改与新增文件

实际文件名可在实施时小幅调整，但职责不应混杂。

当前项目：

- 修改 `tailect/core/config.py`
- 修改 `tailect/core/api_server.py`
- 修改 `tailect/core/inference_engine.py`
- 修改 `tailect/unified_asr_diarization_transformer_offline.py`
- 修改 `tailect/README.md`
- 修改 `tailect/.gitignore`
- 新增 `tailect/core/v1_contract.py`
- 新增 `tailect/core/v1_adapter.py`
- 新增 `tailect/core/audio_input.py`
- 新增 `tailect/core/security.py`
- 新增 `tailect/core/translator_store.py`
- 新增 `tailect/core/v1_router.py`
- 新增 `tailect/config/audio_url_allowlist.json.example`
- 新增 `wxz/deploy/nginx_platform_8885.conf`
- 新增 `wxz/deploy/run_v4_1_single_4090.sh`，明确 6006 模型服务与 8885 平台入口
- 新增 `tailect/tests/test_v1_platform.py`
- 新增 v1 probe/preflight/部署配置与文档

从 `origin/main` 参考复用，但写入独立目录 `spyware-translator-v4.1/`：

- `spyware-translator-v4.1/spyware-translator-v4.1.user.js`
- `spyware-translator-v4.1/local_helper/local_csv_helper.mjs`
- `spyware-translator-v4.1/local_helper/build_offline_client.ps1`
- `spyware-translator-v4.1/tests/userscript_static_test.mjs`
- `spyware-translator-v4.1/tests/tailect_v41_probe.mjs`

仓库根目录：

- 新增/修改 `.gitignore`
- `wxz/docs/` 保留本计划书、部署说明、油猴说明和本机助手说明
- 视需要增加源码/第三方来源说明和许可证清单

## 6. 已确认决策与新增生产建议

用户已确认：

1. 当前产品范围只有 `Tailect_V4.1` 一个模型，不设计新旧模型并存。
2. 对外公开模型别名使用 `Tailect_V4.1`，内部通过配置映射到真实目录。
3. 6006 继续提供当前项目通用 API；8885 作为平台标准定制接口长期保留，供外部平台和内部调用方使用。
4. 时间戳按当前项目 README 和当前代码架构，使用本地 `Qwen3-ForcedAligner-0.6B`；不联网、不下载、不调用外部模型。
5. URL 输入使用可直接编辑并自动热加载的白名单配置文件，本轮不提供管理 API；为以后后台 Web 保留同一配置服务边界。
6. 首期只按单张 4090、单个模型进程、FIFO 并发 1 实施；保留当前已验证的 `vllm_gpu_memory_utilization=0.7`，不擅自调参。
7. 新油猴脚本、本机助手、测试和打包工具全部放在独立 `spyware-translator-v4.1/` 目录，不修改原油猴目录。

双卡方案按“未来两个独立 worker + FIFO”方向保留，但不进入首期启动路径；首期完成并取得实测基线后再启用 5070 Ti。

## 7. 完成标准

满足以下条件才算任务完成：

1. `new4.1` 基于 `origin/main`，远端分支成功建立且历史连续。
2. Git 中无模型权重、14.9 GB tar、运行时、日志、音频、CSV、SQLite、密钥或其它不应提交内容。
3. `/health` 返回正确 `Tailect_V4.1`；`/v1/audiototext` 和 `/translator/*` 通过合同测试。
4. 当前原有 API 与流式接口没有被破坏。
5. 油猴确实调用 V4.1 API，健康模型一致性检查生效，旧 CSV 缓存不会造成假测试通过。
6. 本机助手、双端 CSV、人工修正和降级行为通过两台电脑测试。
7. 完全断网可运行，真实模型/ForcedAligner/说话人分离测试有日志和性能记录。
8. 文档、配置、脚本、probe、油猴中的模型名、端口和错误码保持一致。

## 8. 推荐执行顺序摘要

1. 按第 6 节已确认决策实施；首期固定单 4090、单模型进程、油猴串行并发 1，无需再确认双卡参数。
2. 建立根级忽略保护，再接入 `origin/main` 并创建本地 `new4.1`。
3. 修复 V4.1 模型路径、服务启动安全和依赖/配置基线。
4. 实现 8885 平台 v1 适配、当前本地 ForcedAligner 时间戳、说话人映射、安全输入层和白名单配置热加载。
5. 实现 `/translator/*`。
6. 在独立目录实现 V4.1 油猴、本机助手和缓存隔离。
7. 完成自动测试、单 4090/FIFO 实机、浏览器 mock、两机断网联调。
8. 审查 Git 差异与大文件，再分批提交并推送 `new4.1`。
