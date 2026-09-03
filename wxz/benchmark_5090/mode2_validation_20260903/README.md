# 6006 `mode=2` RTX 5090 验收材料索引

测试日期：2026-09-03

状态：代码与开发服务器真实模型验收通过；未部署生产

## 1. 核心入口

- [完整验收报告](./RTX5090_mode2真实模型验收报告_20260903.md)
- [实施计划与实施记录](../../../doc/6006_mode参数与mode2独立VAD分段转译模式实施计划_20260903.md)
- [原 `/asr_raw` 静默截断问题单](../短音频_asr_raw_静默截断技术问题单_20260903.md)

## 2. Git 保留的复现材料

| 文件 | 用途 |
| --- | --- |
| [`remote_run_mode2_matrix.sh`](./remote_run_mode2_matrix.sh) | 问题样本、参数合同、音频边界和 mode 兼容矩阵 |
| [`remote_run_mode2_extended.sh`](./remote_run_mode2_extended.sh) | 1、10、20、30 分钟扩展样本测试 |
| [`remote_start_no_diarization.py`](./remote_start_no_diarization.py) | 构造说话人模块不可用、VAD 可用的隔离服务 |
| [`summarize_mode2_results.py`](./summarize_mode2_results.py) | 从原始响应生成脱敏结构化摘要 |
| [`results/problem_samples_comparison.json`](./results/problem_samples_comparison.json) | 四个核心问题样本的 mode 2、mode 1、旧 raw 对照 |
| [`results/matrix_summary.json`](./results/matrix_summary.json) | 验收矩阵结构化摘要 |
| [`results/matrix_summary.csv`](./results/matrix_summary.csv) | 验收矩阵表格摘要 |

这些文件不包含音频、模型、服务器登录凭据或完整服务日志。摘要只保留状态、耗时、长度、
哈希、时间轴和合同校验等复核所需字段，不保留完整识别文本。

## 3. 仅本地和远端受控目录保留

以下材料用于深入审计，但不进入 Git：

- 测试 WAV 及其它媒体；
- 每个请求的完整响应与完整识别文本；
- 服务日志、容器检查结果和 GPU 秒级采样；
- 测试源码包、无音频结果归档及其展开副本；
- 模型目录和权重。

本地原始材料位于本目录的 `results/` 和归档文件中；远端原始材料保留在
`/root/fanyin4.1_20260902_130435/mode2_validation_20260903`。不得为了整理索引删除这些
材料，也不得将其整体强制加入 Git。

## 4. 结论边界

本次验收确认新 `mode=2` 真正使用独立 FSMN VAD 分段、请求期不依赖说话人模型，并能
对测试音频返回有时间戳、无说话人字段的完整结果。它不表示旧 `/asr_raw` 或
`diarization=false` 已修复，也不表示 8885 合同发生变化或生产服务已经部署新代码。
