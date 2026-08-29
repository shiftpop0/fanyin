# fanyin

更新时间：2026-08-29

本项目用于把侦控网页中的语音流接入本地 Tailect ASR 模型，并在网页端完成音频切片合并、v1 API 转写、CSV 缓存、结果查看和人工修正反馈。

## new4.1 当前实现

`new4.1` 分支新增当前 Linux/Docker 离线模型服务 `tailect/`，公开模型名固定为 `Tailect_V4.1`。现有 FastAPI 通用 API 继续监听 6006；平台标准接口由离线 Nginx 监听 8885，并转发至同一 6006 模型进程。首期只按单张 4090、单模型进程、FIFO 并发 1 部署，保持项目已验证的 `vllm_gpu_memory_utilization=0.7`。

V4.1 油猴脚本和本机 CSV 助手位于独立目录 `spyware-translator-v4.1/`，默认调用 `http://127.0.0.1:8885`，使用独立配置和缓存，不修改下文所述的历史 `spyware-translator/` 与 `Tailect_ASR_Win10/`。

- 模型服务说明：[`tailect/README.md`](tailect/README.md)
- V4.1 接口、白名单和单 4090 部署：[`tailect/API_V4.1_离线接口与部署.md`](tailect/API_V4.1_离线接口与部署.md)
- V4.1 油猴安装：[`spyware-translator-v4.1/README.md`](spyware-translator-v4.1/README.md)
- 完整实施计划：[`new4.1_API与油猴脚本扩展实施计划.md`](new4.1_API与油猴脚本扩展实施计划.md)

以下内容保留为原 `main` 分支 Windows/旧脚本实现的历史说明。

## 工作流

1. 在模型端启动 Tailect ASR v1 API 服务，默认地址为 `http://127.0.0.1:8885`。
2. 在运行 userscript 的电脑上双击 `spyware-translator\local_helper\启动本机CSV助手.bat`，启动本机 CSV 助手。正式离线包已附带 `local_helper\runtime\node.exe`，不需要联网安装 Node.js。默认地址为 `http://127.0.0.1:18885`，默认保存目录为 `C:\fanyin_output`。
3. 网页加载或播放语音时，`spyware-translator.user.js` 捕获 `/spyfile/audiostream.wav?targetfile=...&index=...` 音频请求。
4. userscript 从 `index=0` 开始探测音频切片，默认无切片数量上限，直到连续失败达到控制台配置的阈值。
5. 切片会按最长 10 分钟合并为识别单元，然后调用 `/v1/audiototext`。
6. 识别结果以 CSV 保存到两端：
   - 模型端：`C:\fanyin_output\{client_ip}\`
   - 脚本端：本机 CSV 助手配置的目录，默认 `C:\fanyin_output\`
7. 普通语音列表会在“序号”右侧新增“识别内容”列；VX 和通用语音界面会在音频旁新增识别/展开入口。
8. 展开弹窗可播放语音、查看带时间戳的转写文本、重新识别、CSV另存、打开本机 CSV 文件路径，以及提交单行修正。
9. 修正提交会覆盖更新本地和模型端 CSV；feedback 历史能力保留但默认关闭。

## 本次更新

- 修复 Windows BAT 的 LF 换行导致的 CMD 命令拆分问题，统一为 UTF-8 + CRLF。
- API 服务启动脚本现在会等待 `/health` 返回 `status=ok` 后才报告成功。
- API 服务启动时会拒绝被非 Tailect 进程占用的端口，并返回非零退出码。
- API 服务停止后会清空陈旧 PID；状态脚本会同时显示进程、监听端口和健康信息。
- `一键启动WebUI.bat` 支持直接传入模型名，例如 `一键启动WebUI.bat Taizhou`。
- `一键启动API服务.bat`、模型自检和 WebUI 启动器会传递真实 Python 退出码。
- userscript 从 Gradio 私有接口切换到 v1 API。
- 新增音频切片合并，支持 `index=0..N` 连续探测，默认无切片上限。
- 新增说话人识别开关，默认关闭。
- 新增 CSV 双端保存和缓存读取，避免重复识别。
- 新增模型端 CSV/feedback 接口和全局 SQLite 同步状态库。
- 新增脚本端本机 CSV 助手，支持保存、读取和“打开文件路径”。
- 优化控制台悬浮窗，支持拖拽、调整大小、配置持久化。
- 控制台明确区分“模型服务”和“本机 CSV 助手”，为 API Key、本机助手、切片上限、失败阈值、识别列宽和 feedback 历史补充用途说明。
- 自动识别和说话人识别开关增加开启状态颜色；“全部重新识别”增加覆盖 CSV 的二次确认；保存配置、服务检测和接口错误增加可见提示。
- 本机 CSV 助手未启动时，控制台会提示在 userscript 所在电脑上双击 `启动本机CSV助手.bat`；本机保存失败不会阻止模型端 CSV 保存。
- 本机助手增加 `/csv/save`、`/csv/open-path` 等兼容路由；模型 API 收到误发的本机助手路由时会返回明确的 `LOCAL_HELPER_REQUIRED` 提示。
- 普通列表新增“识别内容”列，VX/通用语音界面新增识别入口。
- 普通列表业务字段改为按 Wijmo 表头、列绑定和行数据读取，不再依赖固定单元格下标；侦控号码、对方号码、预估时长和通话开始时间不会因横向虚拟化而串列。
- 未捕获音频的普通列表按钮统一为“等待点开音频”。点击后脚本只等待 60 秒，不自动读取隐藏音频路径，也不自动双击列表；用户手动点开语音后才捕获并识别。
- 修复“识别内容”列扩宽时误改 FlexGrid 外层视口的问题，表头、数据内容和横向滚动占位现在分别同步。
- 音频性能记录只消费一次，并忽略脚本自己下载的切片，避免旧音频在切换列表行后被重复绑定到新任务。
- 普通语音任务标题、业务去重键和 CSV 文件名统一为“案件名称+侦控号码+对方号码+通话开始时间+预估时长（秒）+index=0”；同一通话被反复打开且底层 `targetfile` 不同时仍合并为一条任务。
- VX 任务使用“VX+联系人+收发方向+消息时间+语音时长+index=0”，同样按业务字段去重。
- VX 的“重新识别”和“展开”按钮固定显示在音频行右侧，不再落到播放器下方。
- 说话人识别只保留开关；开启时由模型自动判断人数，聚类编号按首次出现顺序规范为 1、2、3……。
- 说话人识别默认关闭；升级到当前脚本时会一次性清理旧版本遗留的开启状态，之后仍可手动开启并保存。
- 所有“打开文件路径”入口统一由本机 CSV 助手在资源管理器中定位并选中对应 CSV，支持中文和带空格的文件名。
- “CSV另存”和“打开文件路径”同时保留；前者不依赖本机助手，优先调用浏览器原生文件保存选择器，后者用于在资源管理器中选中已经落盘的本机 CSV。
- 本机助手状态显示实际连接端点，例如 `127.0.0.1:18885`；助手检测到的网卡 IP 单独标为“模型端 CSV 归档 IP”，只用于模型端 `{ip}` 目录。
- 新增 Windows x64 离线客户端打包脚本，离线包包含 userscript、本机助手和便携 `node.exe`，源码仓库不提交 Node 运行时。
- CSV 正式格式只保留中文表头；旧英文表头缓存不再读取，重新识别后会以中文 CSV 覆盖双端文件。
- 修复自动识别与本机 CSV 查询并发导致的重复识别：新音频会先完成缓存检查，确认没有中文 CSV 后才进入自动识别队列。
- 控制台音频列表新增刷新按钮，可重新检测模型服务和本机助手、清理旧提示、扫描最新音频并重新读取本机 CSV 状态，刷新本身不会自动提交新发现音频。
- 列表和 VX 操作按钮只在状态变化时更新，避免定时扫描期间替换用户正在点击的 DOM 节点。
- 展开弹窗支持音频播放、时间戳文本查看、重新识别和单行修正。
- 移除复制按钮和定位功能。
- 扩展本地 mock server，用于验证普通列表、VX、多切片、CSV 保存和修正反馈流程。

## 主要文件

- `spyware-translator/spyware-translator.user.js`
  - Tampermonkey userscript 主体。
  - 负责捕获网页音频、合并切片、调用 v1 API、保存 CSV、渲染控制台和弹窗。

- `spyware-translator/local_helper/`
  - 脚本端本机 CSV 助手。
  - 默认监听 `127.0.0.1:18885`。
  - 双击 `启动本机CSV助手.bat` 可启动；优先使用同目录 `runtime\node.exe`，没有便携运行时时才回退系统 Node。
  - `制作离线客户端包.bat` 用于生成包含 Windows x64 便携 Node 的离线客户端 ZIP。

- `Tailect_ASR_Win10/WPy64-312101/python/Lib/site-packages/tailect_asr/cli/api_v1.py`
  - Tailect ASR v1 API 服务。
  - 提供 `/v1/audiototext`、`/translator/csv`、`/translator/csv/status`、`/translator/feedback` 等接口。

- `Tailect_ASR_Win10/api_v1_service.ps1`
  - API 服务 start/stop/status 管理脚本。

- `Tailect_ASR_Win10/api_v1_config.json`
  - API 服务配置文件。

- `spyware-translator/temp/mock_server.mjs`
  - 本地功能验证 mock server。

- `spyware-translator/v1_csv_feedback_task_plan.md`
  - 本轮需求的详细任务计划、目标、测试方案和最终确认口径。

## 启动方式

模型端：

```bat
Tailect_ASR_Win10\API服务-启动.bat
```

交互式/指定模型 API 启动：

```bat
Tailect_ASR_Win10\一键启动API服务.bat Taizhou 8885
```

WebUI 指定模型启动：

```bat
Tailect_ASR_Win10\一键启动WebUI.bat Taizhou
```

脚本端本机 CSV 助手：

```bat
spyware-translator\local_helper\启动本机CSV助手.bat
```

该 BAT 必须运行在打开侦控网页、安装 userscript 的电脑上。模型服务位于另一台电脑时，模型电脑不需要代替浏览器电脑打开本机文件路径。

制作离线 userscript 客户端包：

```bat
spyware-translator\local_helper\制作离线客户端包.bat
```

默认输出到 `spyware-translator\temp\offline_client_package\`。生成物包含便携 Node，但 `local_helper\runtime\` 和离线 ZIP 不纳入 Git。

服务状态：

```bat
Tailect_ASR_Win10\API服务-状态.bat
```

停止模型端 API：

```bat
Tailect_ASR_Win10\API服务-停止.bat
```

## 验证入口

本地 mock：

```bat
node spyware-translator\temp\mock_server.mjs
```

打开：

```text
http://127.0.0.1:37867/grid
http://127.0.0.1:37867/grid?helper=off
http://127.0.0.1:37867/vx
```

`/grid` 用于验证表头字段映射和“等待点开音频”：先点击列表中的“等待点开音频”，再手动双击“案件名称”打开详情。第二行每次打开会产生不同 `targetfile`，用于验证业务去重。`/grid?helper=off` 用于验证本机助手未启动提示。

## 常见问题

### 控制台提示本机 CSV 助手未启动

在运行 userscript 的电脑上双击：

```bat
spyware-translator\local_helper\启动本机CSV助手.bat
```

然后在控制台点击“检测本机助手”。正式离线包不需要安装 Node.js，启动脚本会优先使用包内 `runtime\node.exe`。助手未启动时，音频仍可发送给模型识别，模型端 CSV 仍会保存，“CSV另存”仍可使用；受影响的是浏览器电脑上的自动 CSV 保存、读取本机缓存和“打开文件路径”。

### `/local/csv/save` 或 `/local/csv/open-path` 请求失败

- 正确目标：`http://127.0.0.1:18885/local/csv/save`
- 正确目标：`http://127.0.0.1:18885/local/csv/open-path`
- 这两个接口属于本机 CSV 助手，不属于模型端 `8885` 服务。
- 如果浏览器和模型运行在两台电脑上，`127.0.0.1:18885` 始终指向浏览器所在电脑。

静态检查：

```bat
node --check spyware-translator\spyware-translator.user.js
node --check spyware-translator\local_helper\local_csv_helper.mjs
node --check spyware-translator\temp\mock_server.mjs
Tailect_ASR_Win10\WPy64-312101\python\python.exe -m py_compile Tailect_ASR_Win10\WPy64-312101\python\Lib\site-packages\tailect_asr\cli\api_v1.py
```

## 未纳入 Git 的运行时内容

以下内容体积较大、可重新放置，或可能包含本地运行数据，默认不纳入 Git：

- `Tailect_ASR_Win10/models/`
- `Tailect_ASR_Win10/bin/`
- `Tailect_ASR_Win10/outputs/`
- WinPython 大运行时目录中的非交付文件
- `spyware-translator/local_helper/runtime/`（仅进入离线交付包）
- `spyware-translator/temp/offline_client_package/`
