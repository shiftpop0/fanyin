# Spyware Translator 离线环境更新包

这个更新包只包含本次需要更新的代码文件，不包含模型文件。

离线环境的 `Tailect_ASR_Win10` 内容如果和开发环境相同，就不需要另外拷贝说话人分离子模型目录。更新脚本会检查这些目录是否存在，并把 `configuration.json` 中的子模型引用改成本地路径。

## 使用方式

1. 将整个 `offline_update_package` 文件夹复制到离线机器。
2. 双击运行 `一键更新离线环境.bat`。
3. 如果脚本没有自动找到项目根目录，输入包含 `Tailect_ASR_Win10` 的目录，例如 `D:\fanyiin`。
4. 更新完成后，重新运行 `Tailect_ASR_Win10\一键启动WebUI.bat`。
5. 如果浏览器里的 Tampermonkey 脚本没有自动同步，请把更新后的 `spyware-translator\spyware-translator.user.js` 导入或复制到 Tampermonkey。

## 会更新的文件

- `Tailect_ASR_Win10\一键启动WebUI.bat`
- `Tailect_ASR_Win10\WPy64-312101\python\Lib\site-packages\qwen_asr\cli\demo.py`
- `spyware-translator\spyware-translator.user.js`

## 备份位置

脚本会先备份原文件，备份目录形如：

```text
spyware-translator\temp\offline_update_backup_yyyyMMdd_HHmmss
```

## 说话人分离离线检查

脚本会检查以下目录：

- `Tailect_ASR_Win10\models\models\iic\speech_campplus_speaker-diarization_common`
- `Tailect_ASR_Win10\models\models\damo\speech_campplus_sv_zh-cn_16k-common`
- `Tailect_ASR_Win10\models\models\damo\speech_campplus-transformer_scl_zh-cn_16k-common`
- `Tailect_ASR_Win10\models\models\damo\speech_fsmn_vad_zh-cn-16k-common-pytorch`

这些目录存在时，脚本会预先把 diarization 的 `configuration.json` 改成当前离线机的本地绝对路径，避免运行时访问 ModelScope。
