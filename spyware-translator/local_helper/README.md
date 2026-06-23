# 本机 CSV 助手

更新时间：2026-06-23

本目录提供 userscript 运行端的本地助手服务。浏览器脚本不能直接静默写入 `C:\fanyin_output`，因此由该助手接收 userscript 请求并完成本机 CSV 保存、读取和“打开文件路径”。

## 默认配置

- 监听地址：`http://127.0.0.1:18885`
- 默认输出目录：`C:\fanyin_output`

可通过环境变量调整：

```bat
set FANYIN_LOCAL_HELPER_PORT=18885
set FANYIN_OUTPUT_DIR=C:\fanyin_output
```

## 启动方式

双击：

```text
启动本机CSV助手.bat
```

正式离线包会附带：

```text
runtime\node.exe
```

启动 BAT 优先使用这个便携运行时，因此离线电脑不需要安装 Node.js，也不需要访问互联网。只有开发目录没有 `runtime\node.exe` 时，BAT 才会回退使用系统 `PATH` 中的 Node。

该 BAT 需要在运行 userscript、打开侦控网页的电脑上启动，并在使用期间保持窗口运行。userscript 控制台显示“本机 CSV 助手未启动或无法连接”时，先启动该 BAT，再点击“检测本机助手”。

命令行：

```bat
node local_csv_helper.mjs
```

## 制作离线客户端包

开发电脑双击：

```text
制作离线客户端包.bat
```

也可以直接执行 ASCII 文件名的 PowerShell 脚本，以兼容 Windows PowerShell 5.1：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\build_offline_client.ps1
```

打包脚本会：

- 自动查找 `FANYIN_NODE_EXE`、已有 `runtime\node.exe` 或系统 `node.exe`。
- 校验运行时为 Windows x64，并要求 Node.js 18 或更高版本。
- 复制 userscript、本机助手、启动 BAT 和便携 `node.exe`。
- 生成 Node 版本、架构和 SHA-256 清单。
- 输出到 `spyware-translator\temp\offline_client_package\` 并生成 ZIP。

便携 Node 只进入离线交付包，`local_helper\runtime\` 已加入 `.gitignore`，不会提交到 Git。

## 助手不可用时

userscript 中“CSV另存”和“打开文件路径”会同时存在：

- “CSV另存”不依赖本机助手，优先使用内存结果，不足时读取模型端 CSV。
- 浏览器支持 File System Access API 时会直接弹出保存位置选择窗口。
- 原生保存选择器不可用时会退回浏览器普通下载，保存位置由浏览器下载设置决定。
- “打开文件路径”仍需要本机助手，并且只在本机 CSV 已确认落盘时启用。
- 助手状态中的连接地址来自 userscript 配置，例如 `127.0.0.1:18885`；`primary_ip` 仅作为模型端 CSV 分目录标识。

## 接口

- `GET /local/health`
- `GET /local/ip`
- `GET /local/csv/status?filename=xxx.csv&outputDir=C:\fanyin_output`
- `GET /local/csv?filename=xxx.csv&outputDir=C:\fanyin_output`
- `POST /local/csv/save`
- `POST /local/csv/open-path`
- `POST /local/feedback`

兼容旧调用路径：

- `GET /csv/status`
- `GET /csv`
- `POST /csv/save`
- `POST /csv/open-path`
- `POST /feedback`

`/local/csv/open-path` 会调用 Windows Explorer 打开 CSV 所在目录并选中文件。助手使用 `/select,"完整文件路径"` 的 Windows 参数格式，支持带空格和中文的目录及文件名。feedback 历史默认不写入，只有 userscript 控制台开启后才追加本地 `feedback.jsonl`。

`GET /local/health` 会返回 `service=fanyin-local-csv-helper`。userscript 会校验该身份，避免把模型 API 地址误当成本机助手地址。
