# R9：8885 复用 6006 原生分段 ASR 增量包（E016 修正版）

本包面向当前运行 R8 或早期 R9 的 Ubuntu release。它解决三个问题：

1. 撤销错误 R8 在服务端加入的双声道合并；声道合并继续由 Windows 油猴脚本 `0.5.2` 完成，服务端不主动改写已是 WAV 的声道。
2. 让 `8885/v1/audiototext?diarize=1` 与 `6006/asr?diarization=true` 复用同一套“说话人分段 → 短片段批量 ASR”核心，同时保持各自的响应 JSON。
3. `diarize=1` 直接把 6006 原生 `speaker_segments` 转成平台字幕行，不再对拼接全文执行第二次 ForcedAligner，修复生产样本的 `[E016] local ForcedAligner did not cover the full transcript`。

R9 不更新模型、Docker 镜像、CUDA/vLLM 参数、端口、Nginx、CSV 数据或项目外服务。

## 1. 完整性检查

```bash
cd /home/gezhi/fanyin/fanyin-new4.1-incremental-20260831-r9
sha256sum -c SHA256SUMS
```

## 2. 应用到现有 release

```bash
RELEASE_ROOT=/home/gezhi/fanyin/releases/new4.1-20260829 \
bash migration/apply_r9_api_parity.sh
```

应用脚本会先把所有被覆盖文件复制到：

```text
/home/gezhi/fanyin/releases/new4.1-20260829/wxz/hotfix_backups/r9_api_parity_时间戳/
```

脚本不会停止、重启或删除容器。它会拒绝包含 R8 服务端 downmix 标记的错误 payload，
也会拒绝向已经含有本次 E016 修正的 release 重复应用。R8 和没有该修正的早期 R9
都可以应用。脚本会先完成全部备份并写入回滚指针，再开始覆盖 release 文件。

## 3. 重启本项目

Python 未开启热重载，必须重启本项目容器才会加载 R9：

```bash
cd /home/gezhi/fanyin/releases/new4.1-20260829
bash wxz/deploy/run_v4_1_single_4090.sh stop
bash wxz/deploy/run_v4_1_single_4090.sh start
```

这会短暂中断 6006/8885，只能在确认的维护窗口执行。脚本不会删除容器，也不影响项目外服务。

## 4. 健康检查

```bash
curl -fsS http://127.0.0.1:6006/health
curl -fsS http://127.0.0.1:8885/health
```

确认源码状态：

```bash
! grep -Eq 'pan=mono|audio channel merge|_mono\.wav|merged .*channels to mono' \
  tailect/core/audio_input.py

grep -F 'def transcribe_diarized_segments(' tailect/core/inference_engine.py
grep -F 'service.transcribe_diarized_segments(' tailect/core/v1_adapter.py
grep -F 'build_diarized_caption_rows(' tailect/core/v1_adapter.py
```

## 5. 同音频严格验收

将 `0051409.wav` 放到 Ubuntu 项目范围内的临时验收目录，然后执行：

```bash
TEST_AUDIO_FILE=/home/gezhi/fanyin/releases/new4.1-20260829/tailect/tests/0051409.wav \
RELEASE_ROOT=/home/gezhi/fanyin/releases/new4.1-20260829 \
bash migration/acceptance_r9_api_parity.sh
```

脚本会连续调用 6006 和 8885，并要求：

- 6006 `diarization_status=ok`；
- 8885 `code=200`；
- 8885 所有字幕文字拼接后与 6006 `overall_text` 完全一致；
- 8885 每行的文字、毫秒时间和 `lid` 都是 6006 原生 `speaker_segments` 的严格转换；
- `lid` 从 `1` 连续编号；
- 双人样本至少产生两个 `lid`。
- `language` 可接收但不会控制模型；已移除的 `max_chars` 返回 `E017`。

结果保留在 `tailect/log/acceptance_r9_*`，不会自动删除。

也可以继续使用 Windows 内网的两条 `curl.exe` 命令复测。上传项统一写为：

```powershell
-F "file=@D:/fanyin/tailect/tests/0051409.wav;type=audio/wav"
```

## 6. 油猴脚本

R9 payload 同时携带当前 `spyware-translator-v4.1.user.js`。Windows 浏览器需要确认版本为 `0.5.2`，多声道 PCM WAV 在浏览器本机合并为单声道后再上传。服务端不得出现 R8 的 `[AUDIO] merged ... channels to mono` 日志。

## 7. 回滚

```bash
cd /home/gezhi/fanyin/fanyin-new4.1-incremental-20260831-r9

RELEASE_ROOT=/home/gezhi/fanyin/releases/new4.1-20260829 \
bash migration/rollback_r9_api_parity.sh

cd /home/gezhi/fanyin/releases/new4.1-20260829
bash wxz/deploy/run_v4_1_single_4090.sh stop
bash wxz/deploy/run_v4_1_single_4090.sh start
```

回滚只恢复应用 R9 前备份的文件；R9 包、备份和验收结果全部保留。
