# fanyin

本仓库保存网页语音捕获、Tailect ASR 调用、悬浮窗展示与定位相关的代码改动。

## 仓库内容

- `spyware-translator/spyware-translator.user.js`
  - Tampermonkey 脚本，捕获网页中的 `/spyfile/audiostream.wav` 音频。
  - 调用本地/局域网 Tailect ASR Gradio 服务转写。
  - 在悬浮窗展示转写结果，并支持通话页、VX 页和列表弹窗页的来源定位。
  - 默认模型地址为 `http://127.0.0.1:7867`；如果模型部署在另一台机器，需要同步修改脚本中的 `modelBaseUrl` 和 `@connect`。
- `Tailect_ASR_Win10/一键启动WebUI.bat`
  - Tailect ASR Windows 启动脚本。
  - 配置离线 ModelScope/HF 环境变量，并以 `0.0.0.0:7867` 对外监听。
- `Tailect_ASR_Win10/WPy64-312101/python/Lib/site-packages/qwen_asr/cli/demo.py`
  - Tailect/Qwen ASR WebUI 入口。
  - 支持说话人分离模型离线加载，并保留 `--ip 0.0.0.0` 监听能力。
- `prompt材料/`
  - 保留页面结构、报文、截图和小体积示例音频，便于复现定位和转写场景。
  - 上传前已将报文里的 Cookie 值替换为占位符。
- `spyware-translator/temp/`
  - 保留本地 probe、mock server 和离线更新包等轻量调试材料。

## 未纳入 Git 的内容

以下内容体积大、可重新放置，或可能包含敏感信息，因此不上传到 GitHub：

- `Tailect_ASR_Win10/models/`
- `Tailect_ASR_Win10/WPy64-312101/`
- `Tailect_ASR_Win10/bin/`
- `Tailect_ASR_Win10/VC运行库/`
- `Tailect_ASR_Win10/outputs/`

其中 `WPy64-312101/` 虽整体排除，但保留了 `qwen_asr/cli` 里的小体积入口源码。部署到离线环境时，默认目标机器已经有完整的 `Tailect_ASR_Win10` 运行目录和模型目录，只需要覆盖仓库中跟踪的脚本文件。
