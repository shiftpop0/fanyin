# Tailect V4.1 离线语音项目

当前分支只保留 Tailect V4.1 模型服务和 V4.1 专用油猴客户端，不包含旧项目的模型实现、测试材料或旧油猴目录。

## 目录

- `tailect/`：当前离线 ASR、ForcedAligner、TargetDiarization、通用 API 与平台 API 源码。
- `spyware-translator-v4.1/`：V4.1 专用油猴脚本、本机 CSV 助手及测试工具。
- `wxz/docs/`：本次扩展的计划、API、部署和油猴使用文档。
- `wxz/deploy/`：单 4090 启动脚本及 8885 平台 Nginx 配置。
- `del/`：本机保留的旧项目参考文件，不进入 Git。

## 当前部署结构

```text
通用调用方 -> :6006 FastAPI
平台/油猴  -> :8885 Nginx -> :6006 同一 FastAPI
模型       -> Tailect_V4.1 + 本地 Qwen3-ForcedAligner + TargetDiarization
首期 GPU   -> 单张 4090、单模型进程、FIFO 并发 1
```

项目完全离线运行，保持当前已经验证的 `vllm_gpu_memory_utilization=0.7`。模型权重、离线镜像压缩包、日志、上传音频、CSV、SQLite 和便携运行时均不提交 Git。

## 入口

- [当前模型项目说明](tailect/README.md)
- [V4.1 接口与部署手册](wxz/docs/Tailect_V4.1离线接口与部署.md)
- [V4.1 油猴使用说明](wxz/docs/油猴脚本V4.1使用说明.md)
- [完整实施计划](wxz/docs/new4.1_API与油猴脚本扩展实施计划.md)
- [单 4090 启动脚本](wxz/deploy/run_v4_1_single_4090.sh)
