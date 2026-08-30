# r8 双声道合并增量包

本包只更新现有生产 release 中的两个文件：

```text
tailect/core/audio_input.py
tailect/core/v1_router.py
```

它不更新模型、镜像、油猴、Nginx、启动脚本或推理参数。双声道 WAV 会在进入 ASR、ForcedAligner 和说话人分离前显式合并为单声道；单声道 WAV 保持不变。

## 应用

在解压后的包目录执行：

```bash
cd /home/gezhi/fanyin/fanyin-new4.1-incremental-20260830-r8
sha256sum -c SHA256SUMS

RELEASE_ROOT=/home/gezhi/fanyin/releases/new4.1-20260829 \
bash migration/apply_r8_stereo_downmix.sh
```

脚本只备份并复制文件，不自动停止或重启容器。然后执行：

```bash
cd /home/gezhi/fanyin/releases/new4.1-20260829
bash wxz/deploy/run_v4_1_single_4090.sh stop
bash wxz/deploy/run_v4_1_single_4090.sh start
```

检查：

```bash
curl -sS http://127.0.0.1:6006/health
curl -sS http://127.0.0.1:8885/health

docker logs --since 20m tailect-v41-model 2>&1 | \
grep -E '\[AUDIO\] merged|Ready|ERROR|Traceback' | tail -n 100
```

双声道音频请求后应出现：

```text
[AUDIO] merged 2 channels to mono: ...
```

## 回退

应用脚本会记录最近一次备份路径。执行：

```bash
cd /home/gezhi/fanyin/fanyin-new4.1-incremental-20260830-r8

RELEASE_ROOT=/home/gezhi/fanyin/releases/new4.1-20260829 \
bash migration/rollback_r8_stereo_downmix.sh

cd /home/gezhi/fanyin/releases/new4.1-20260829
bash wxz/deploy/run_v4_1_single_4090.sh stop
bash wxz/deploy/run_v4_1_single_4090.sh start
```

回退脚本不会删除 r8 文件、备份或迁移包。

