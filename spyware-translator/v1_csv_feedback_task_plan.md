# spyware-translator v1 API、音频合并、CSV 缓存与反馈改造计划

## 1. 背景与目标

本次改造目标是把 `spyware-translator.user.js` 从“捕获单段音频并调用 Gradio WebUI 私有接口”的实验形态，升级为面向实际侦控语音场景的可持续使用工具：

- 全面使用本地模型 v1 API：`POST /v1/audiototext?model=Taizhou`。
- 支持网页音频切片自动合并，按最长 10 分钟为一个识别单元。
- 支持普通语音列表界面、VX 语音界面，以及后续相似语音界面的通用捕获、识别、缓存、查看和反馈。
- 识别结果自动保存为 CSV，用于避免重复识别、便于查看和回溯。
- 结果同时尽量保存在模型端和脚本运行端，适配“运行 userscript 的电脑”和“运行模型服务的电脑”不是同一台机器的场景。
- 浮窗由“结果列表”调整为“控制台”，行内或语音项内提供展开、手动识别、音频播放、CSV 查看、修正反馈等操作。
- 反馈内容只需落盘到当前项目或本地输出目录，不需要转发业务系统。

## 2. 关键约束

### 2.1 两台电脑场景

实际部署可能是：

- A 电脑：打开 spyware 页面并运行 userscript。
- B 电脑：运行 Tailect ASR v1 API 服务。

因此，保存策略必须拆成两个层面：

- 模型端保存：B 电脑收到 v1 API 请求后，把 CSV 和反馈落盘到 `C:\fanyin_output\{client_ip}`。其中 `{client_ip}` 优先使用 HTTP 请求来源 IP，也允许前端显式传入 `client_ip` 作为辅助字段。
- 脚本端保存：A 电脑上的浏览器脚本不能直接静默写入 `C:\fanyin_output\` 这类任意本地目录。需要提供脚本端本地助手服务，或使用浏览器下载/IndexedDB 作为降级。

建议实现三层脚本端保存策略：

1. 优先：userscript 调用脚本端本地助手，例如 `http://127.0.0.1:18885/local/csv/save`，由助手写入 `C:\fanyin_output\`。
2. 次选：支持浏览器 File System Access API，让用户首次选择目录后保存目录句柄。
3. 降级：写入 IndexedDB，并提供“导出 CSV”按钮触发浏览器下载。

### 2.2 浏览器权限边界

userscript 可以抓网页音频、发 HTTP 请求、构造 CSV、触发下载，但不能稳定做到：

- 静默写入绝对路径 `C:\fanyin_output\`。
- 打开 Windows 资源管理器到某个目录。
- 枚举本机目录内已有 CSV。

这些能力需要模型端 API 或脚本端本地助手提供。

### 2.3 冗余要求

字段缺失不得影响识别主流程。例如普通语音列表中如果缺少“对方号码”，仍必须可以：

- 捕获音频。
- 合并音频。
- 调用 v1 API。
- 保存 CSV。
- 弹窗查看结果。

缺失字段只影响标题和文件名，应使用稳定 fallback：

- 空字段写作 `未知案件`、`未知侦控号码`、`未知对方号码`、`未知时长`、`未知开始时间`。
- 如果页面字段不足，使用 `targetfile`、音频 URL hash、捕获时间补足唯一性。

## 3. 总体架构

### 3.1 组件划分

1. `spyware-translator.user.js`
   - 捕获网页音频 URL。
   - 识别普通语音列表、VX 语音、通用音频容器的上下文。
   - 按 `targetfile`、行字段、消息字段生成 call key。
   - 下载并合并切片。
   - 调用 v1 API。
   - 调用 CSV/反馈接口。
   - 渲染控制台浮窗、行内按钮、结果弹窗、修正弹窗。

2. `tailect_asr.cli.api_v1`
   - 保持现有 `/v1/audiototext` 识别接口。
   - 增加 CSV 和反馈辅助接口。
   - 按请求来源 IP 保存模型端 CSV：`C:\fanyin_output\{client_ip}`。
   - 支持打开模型端 CSV 所在目录。

3. 脚本端本地助手服务
   - 建议放在 `spyware-translator/local_helper` 或 `spyware-translator/temp` 下。
   - 可用 Node.js 或 Python 实现。
   - 监听 `127.0.0.1`，避免暴露到局域网。
   - 写入脚本端目录：默认 `C:\fanyin_output\`，可由控制台浮窗配置。
   - 支持打开脚本端 CSV 所在目录。

### 3.2 推荐数据流

1. 页面加载或用户播放语音。
2. userscript 捕获 `/spyfile/audiostream.wav?targetfile=xxx.wav&index=0`。
3. userscript 建立通话任务，按普通列表/VX/通用音频提取上下文。
4. 查询模型端 CSV 状态和脚本端本地助手 CSV 状态。
5. 如果已有非空 CSV，显示展开按钮，点击直接展示 CSV 内容。
6. 如果没有 CSV，自动识别开启时加入识别队列；自动识别关闭时只显示可手动识别入口。
7. 识别时下载 `index=0..N` 切片。普通列表优先用预估时长计算 N，VX 优先用消息时长计算 N，缺失时从 0 开始探测直到 404 或连续失败。
8. 按最长 10 分钟合并音频，逐段调用 v1 API。
9. 合并多个识别结果，并修正后续段落 `begin/end` 时间偏移。
10. 保存 CSV 到模型端。
11. 保存 CSV 到脚本端本地助手；如果助手不可用，则写 IndexedDB 并提示可导出。
12. 更新行内按钮状态，展开弹窗显示音频播放器和时间戳文本。
13. 用户点击修正按钮，提交后更新当前 CSV，并追加反馈落盘。

## 4. 音频合并设计

### 4.1 分组 key

普通语音列表：

- 优先字段：案件名、侦控号码、对方号码、预估时长、通话开始时间。
- URL 字段：`targetfile`。
- 稳定 key：`normal:{caseName}:{controlNumber}:{peerNumber}:{duration}:{startedAt}:{targetfile}`。

VX 语音：

- 优先字段：联系人/发送人、消息时间、语音时长、消息方向、`targetfile`。
- 稳定 key：`vx:{user}:{time}:{duration}:{direction}:{targetfile}`。

通用音频：

- 优先字段：可见容器标题、时长、`targetfile`。
- 稳定 key：`generic:{title}:{duration}:{targetfile}`。

### 4.2 index 范围

普通列表中如果有预估时长：

- 切片粒度按 60 秒估算。
- 6 分钟音频应请求 `index=0..5`。
- `expectedCount = ceil(durationSeconds / 60)`。
- 实际下载时允许末尾缺失，连续 2 个 index 失败后停止。

没有时长时：

- 从 `index=0` 开始探测。
- 单个通话最多探测到可配置上限，例如 60 段。
- 连续 2 个 404/空音频停止。

### 4.3 合并规则

- 每个下载到的 wav 先解析 header。
- 如果格式一致，直接拼接 PCM data，并重写 wav header。
- 如果格式不一致，尝试使用 Web Audio 解码后重采样为统一 PCM，再编码 wav。
- 每个识别单元最长 10 分钟。
- 超过 10 分钟则拆为多个合并段，逐段调用 API。
- 对第 2 段及以后返回的 `begin/end` 加上段起始偏移。

### 4.4 异常冗余

- 某个中间 index 下载失败：记录 warning，继续尝试后续 index；如果后续存在有效音频，则仍可识别。
- index=0 下载失败：任务失败，但不影响其他任务。
- wav 解析失败：尝试直接上传原始 blob；如果 API 失败，再提示音频格式问题。
- 合并后音频为空：不调用模型，写入错误状态，不生成非空 CSV。

## 5. CSV 保存设计

### 5.1 文件名

普通语音列表文件名：

```text
案件名+侦控号码+对方号码+预估时长+通话开始时间.csv
```

示例：

```text
001专案+12312312311(xxx)+8613213213222+34s+2026-01-01 16_30_15.csv
```

所有字段需清理 Windows 非法字符：

```text
< > : " / \ | ? * 控制字符
```

VX 文件名：

```text
VX+联系人或发送人+消息时间+语音时长+targetfile.csv
```

通用音频文件名：

```text
Audio+标题+时长+targetfile.csv
```

### 5.2 保存路径

模型端：

```text
C:\fanyin_output\{client_ip}\{csv_file_name}
```

脚本端：

```text
{configuredLocalOutputDir}\{csv_file_name}
```

控制台浮窗默认配置：

```text
C:\fanyin_output\
```

### 5.3 CSV 字段

建议字段：

```csv
record_key,scene,title,case_name,control_number,peer_number,duration_seconds,started_at,targetfile,index_range,segment_no,lid,begin_ms,end_ms,begin_time,end_time,text,corrected_text,is_corrected,source_audio_url,model,language,uuid,created_at,updated_at
```

说明：

- `text` 保存模型原始识别结果。
- `corrected_text` 保存修正后的文本。
- 展示时优先显示 `corrected_text`，为空则显示 `text`。
- `begin_ms/end_ms` 用于精确定位。
- `begin_time/end_time` 是可读时间，如 `00:01.280`。
- `index_range` 记录该 CSV 由哪些切片合并而来，如 `0-5`。

### 5.4 CSV 状态

CSV 分三态：

- 不存在：未识别，不显示展开按钮，除非用户悬浮或启用手动识别按钮。
- 存在但为空或只有表头：识别中或异常中断，显示加载状态。
- 存在且有数据行：显示展开按钮，弹窗读取 CSV 展示。

## 6. 服务端接口计划

### 6.1 识别接口

继续使用：

```http
POST /v1/audiototext?model=Taizhou&diarize=0
Content-Type: multipart/form-data
```

前端控制项：

- `model`: 默认 `Taizhou`。
- `diarize`: 默认 `0`，由悬浮窗开关控制。
- `language`: 默认自动识别。
- `max_chars`: 沿用服务默认或前端配置。

### 6.2 模型端 CSV 接口

新增：

```http
GET /translator/csv/status?record_key=...&filename=...
```

返回：

```json
{
  "code": 200,
  "exists": true,
  "empty": false,
  "row_count": 6,
  "path": "C:\\fanyin_output\\192.168.1.23\\xxx.csv"
}
```

新增：

```http
GET /translator/csv?record_key=...&filename=...
```

返回 CSV 文本或 JSON 包装。

新增：

```http
POST /translator/csv
Content-Type: application/json
```

用于保存或覆盖模型端 CSV。

新增：

```http
POST /translator/csv/open-dir
Content-Type: application/json
```

在模型服务所在电脑打开目录。

### 6.3 反馈接口

新增：

```http
POST /translator/feedback
Content-Type: application/json
```

请求体包含：

```json
{
  "record_key": "...",
  "csv_filename": "...",
  "segment_no": 1,
  "begin_ms": 1280,
  "end_ms": 2240,
  "lid": "1",
  "original_text": "...",
  "corrected_text": "...",
  "context": {
    "scene": "normal",
    "title": "...",
    "case_name": "...",
    "control_number": "...",
    "peer_number": "..."
  }
}
```

落盘：

```text
C:\fanyin_output\{client_ip}\feedback.jsonl
```

同时更新对应 CSV 行的 `corrected_text/is_corrected/updated_at`。

### 6.4 脚本端本地助手接口

建议实现：

```http
GET /local/health
GET /local/ip
GET /local/csv/status?filename=...
GET /local/csv?filename=...
POST /local/csv/save
POST /local/csv/open-dir
POST /local/feedback
```

本地助手只监听 `127.0.0.1`。

## 7. UI 改造计划

### 7.1 控制台悬浮窗

控制台包含：

- 自动识别开关。
- 手动识别当前选中/最近捕获音频。
- 说话人识别开关，默认关闭。
- 模型服务地址配置。
- 脚本端保存目录配置，默认 `C:\fanyin_output\`。
- 脚本端本地助手状态。
- 当前队列数量和当前任务状态。
- 导出/打开目录按钮。
- 面板收起按钮。

交互能力：

- 支持拖动。
- 支持手动调整外框大小。
- 位置、大小、开关、模型地址、保存目录写入 localStorage。

### 7.2 普通语音列表

在序号单元格中注入操作按钮：

- 已有 CSV：显示展开按钮。
- CSV 为空或识别中：显示加载按钮或 spinner。
- 未识别且自动识别关闭：可显示手动识别按钮。
- 未识别且自动识别开启但未捕获音频：不显示展开按钮，避免干扰页面。

展开弹窗标题：

```text
案件名+侦控号码+对方号码+预估时长+通话开始时间
```

弹窗内容：

- 音频播放器。
- 切片 index 列表和下载状态。
- CSV 来源：模型端、脚本端、IndexedDB。
- 时间戳列表。
- 每行右侧修正图标按钮。
- 重新识别按钮。
- 导出 CSV/打开目录按钮。

### 7.3 VX 界面

VX 场景没有普通列表的序号单元格，改为在语音气泡或语音容器旁注入小型操作按钮：

- 手动识别。
- 展开结果。
- 加载状态。

上下文标题：

```text
VX+联系人或发送人+消息时间+语音时长
```

保存、缓存、修正反馈逻辑与普通列表一致。

### 7.4 通用音频界面

对其它类似音频 DOM：

- 在最近的音频容器旁提供小按钮。
- 标题使用可见文本、时长、targetfile。
- 缺少字段不阻断识别。

## 8. 修正反馈设计

每一条时间戳行右侧增加图标按钮：

- 使用内联 SVG，形状类似 pencil/edit，避免中文按钮占空间。
- 悬停 tooltip：`修正`。

点击后弹出修正浮窗：

- textarea 初始填充当前展示文本。
- 显示时间戳、说话人、原始文本。
- 提交按钮。
- 取消按钮。

提交后：

1. 更新弹窗中的当前行。
2. 更新内存缓存。
3. 更新脚本端 CSV。
4. 更新模型端 CSV。
5. 追加模型端 `feedback.jsonl`。
6. 如果脚本端本地助手可用，也追加脚本端反馈记录。
7. 如果任一端失败，提示具体失败端，但不回滚已成功端。

## 9. 任务拆分

### 阶段 1：文档与接口契约

- 完成本计划文档。
- 明确模型端 CSV/反馈 API schema。
- 明确脚本端本地助手 API schema。

### 阶段 2：服务端辅助接口

- 在 `api_v1.py` 增加 CSV 保存、读取、状态、打开目录接口。
- 增加反馈落盘接口。
- 增加路径清理和 client IP 目录解析。
- 增加 CORS 支持，允许 userscript 跨主机调用。
- 保持 `/v1/audiototext` 兼容原合同。

### 阶段 3：脚本端本地助手

- 新增本地助手脚本和启动说明。
- 支持 `C:\fanyin_output\` 默认目录。
- 支持保存 CSV、读取 CSV、打开目录、反馈落盘。
- 提供 health 接口给 userscript 检测。

### 阶段 4：userscript 后端切换

- 默认使用 v1 API。
- 保留 Gradio 旧接口为可选 fallback 或删除。
- 支持模型服务地址配置。
- 识别请求显式传 `diarize=0/1`。

### 阶段 5：音频切片合并

- 改造 key：从 `targetfile+index` 单段 key 改为通话级 key。
- 下载 index 序列。
- wav 合并。
- 10 分钟拆段。
- 多段结果合并并修正时间偏移。

### 阶段 6：CSV 缓存与重复识别规避

- 生成统一 CSV。
- 查询模型端和脚本端状态。
- 已有 CSV 时不重复识别。
- 空 CSV 显示加载状态。
- 识别完成后双端保存。

### 阶段 7：普通列表 UI

- 改造悬浮窗为控制台。
- 支持拖动、resize、localStorage。
- 注入序号单元格按钮。
- 新增展开弹窗。
- 移除定位功能。
- 移除复制按钮，改为导出/打开目录。

### 阶段 8：VX 与通用音频 UI

- 给 VX 语音气泡注入识别/展开按钮。
- 复用 CSV、音频播放、修正反馈弹窗。
- 给通用音频容器提供 fallback 操作。

### 阶段 9：反馈闭环

- 每行时间戳增加修正图标。
- 新增修正浮窗。
- 提交后更新 CSV 和反馈 jsonl。
- 支持失败提示和重试。

### 阶段 10：联调与交付

- 更新 mock server。
- 增加多切片 mock。
- 增加 VX mock 验证。
- 增加文档说明。
- 完成静态检查和端到端验证。

## 10. 测试方案

### 10.1 静态检查

JavaScript：

```bat
node --check spyware-translator\spyware-translator.user.js
node --check spyware-translator\temp\mock_server.mjs
```

Python：

```bat
Tailect_ASR_Win10\WPy64-312101\python\python.exe -m py_compile ^
  Tailect_ASR_Win10\WPy64-312101\python\Lib\site-packages\tailect_asr\cli\api_v1.py
```

### 10.2 服务端接口测试

使用轻量测试或 probe 覆盖：

- `/health`。
- `/v1/audiototext?model=Taizhou&diarize=0`。
- `/translator/csv/status` 不存在。
- `/translator/csv` 保存后读取。
- 空 CSV 状态。
- 非空 CSV 状态。
- `/translator/feedback` 更新 CSV 并追加 jsonl。
- `/translator/csv/open-dir` 在 Windows 下可打开目录。

### 10.3 脚本端本地助手测试

覆盖：

- `/local/health`。
- 保存 CSV 到 `C:\fanyin_output\`。
- 读取 CSV。
- 打开 CSV 所在目录。
- feedback 落盘。
- helper 不存在时 userscript 降级到 IndexedDB/下载。

### 10.4 音频切片测试

在 mock server 增加：

- `targetfile=grid-call-001.wav&index=0..5` 返回有效 wav。
- `index=6` 返回 404。
- 预估时长 360 秒时只请求 0..5。
- 预估时长缺失时探测到连续失败后停止。
- 中间某段失败时仍尝试后续段，并在 UI 中显示 warning。
- 合并结果可被 v1 API 或 mock v1 API 接收。

### 10.5 普通列表 UI 测试

使用 `/grid` mock 页面验证：

- 序号单元格按钮注入。
- 未识别时不显示展开按钮，或显示手动识别按钮。
- 识别中显示加载状态。
- 已有 CSV 时展开弹窗读取 CSV。
- 标题为“案件名+侦控号码+对方号码+预估时长+通话开始时间”。
- 缺少对方号码仍能识别并生成 fallback 文件名。
- 定位按钮不存在。
- 复制按钮不存在。
- 导出/打开目录按钮存在。

### 10.6 VX UI 测试

使用 `/vx` mock 页面验证：

- 语音气泡旁出现手动识别/展开按钮。
- VX 标题和 CSV 文件名可用。
- 音频播放器可播放。
- 时间戳列表显示正常。
- 修正反馈可更新 CSV。
- 缺少用户名/时间/时长时仍能识别。

### 10.7 控制台浮窗测试

验证：

- 自动识别开关生效。
- 手动识别单个任务生效。
- 说话人识别默认关闭。
- 开启说话人识别后请求带 `diarize=1`。
- 面板拖动后刷新页面位置保持。
- 面板 resize 后刷新页面尺寸保持。
- 模型服务地址和脚本端保存路径写入 localStorage。
- helper 不在线时有明确状态，不影响模型端识别。

### 10.8 端到端测试

模型端与脚本端同机：

1. 启动 v1 API。
2. 启动脚本端本地助手。
3. 打开 mock 普通列表页面。
4. 执行自动识别。
5. 确认 `C:\fanyin_output\127.0.0.1` 或本机 IP 下有模型端 CSV。
6. 确认 `C:\fanyin_output\` 下有脚本端 CSV。
7. 修正一行文本。
8. 确认两端 CSV 更新，反馈 jsonl 追加。

模型端与脚本端异机：

1. B 电脑启动 v1 API。
2. A 电脑配置模型服务地址为 `http://B_IP:8885`。
3. A 电脑启动脚本端本地助手。
4. A 电脑运行 userscript。
5. 确认 B 电脑 `C:\fanyin_output\{A_IP}` 有 CSV。
6. 确认 A 电脑 `C:\fanyin_output\` 有 CSV。
7. helper 关闭后再次识别，确认模型端仍保存，脚本端降级可导出。

## 11. 风险与缓解

### 11.1 client IP 不准确

如果中间有代理或 NAT，模型端看到的 IP 可能不是浏览器主机真实 IP。

缓解：

- 前端调用 `/local/ip` 获取脚本端 IP，随请求传 `client_ip_hint`。
- 服务端目录优先使用可信来源 IP，也记录 hint。

### 11.2 浏览器无法脚本端落盘

缓解：

- 提供本地助手。
- 没有助手时保存 IndexedDB。
- 提供导出 CSV 按钮。

### 11.3 页面虚拟滚动导致按钮丢失

缓解：

- MutationObserver + 定时轻扫。
- 按行字段重复绑定，避免重复注入。
- 行 DOM 消失不影响任务状态。

### 11.4 切片缺失或服务端切片规则变化

缓解：

- 预估时长计算 + URL 探测双策略。
- 连续失败停止。
- 记录 index_range 和 warning。

### 11.5 CSV 文件名过长

缓解：

- 文件名清理后限制长度。
- 超长部分截断。
- 末尾追加短 hash 保证唯一。

### 11.6 识别耗时长

缓解：

- 队列串行处理。
- UI 显示加载状态。
- 空 CSV 作为处理中标记。
- 失败可重新识别。

## 12. 待确认问题

1. 是否允许在 userscript 运行端部署一个本地助手服务？如果允许，我建议优先做它，因为这是“脚本端默认保存到 C:\fanyin_output\”和“打开目录”的最稳方案。
2. 模型端是否必须打开的是模型端目录，脚本端是否打开的是脚本端目录？我建议两个按钮区分为“打开模型端目录”和“打开本机目录”。
3. 普通列表中“手动识别单个识别”更偏向放在序号单元格按钮内，还是控制台里对“当前选中行/最近捕获音频”操作？我建议两者都支持：序号单元格最直观，控制台作为兜底。
4. CSV 更新时是否允许覆盖原文件？我建议允许覆盖 CSV，同时 feedback 用 jsonl 追加保留历史。
5. 如果模型端和脚本端 CSV 内容冲突，以哪一端为准？我建议以最近 `updated_at` 为准，修正提交后双端同步。

