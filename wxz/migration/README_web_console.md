# 8885 后台 Web 离线增量包

该包修复访问 `http://模型服务器IP:8885/` 返回
`{"code":404,"message":"platform route not found"}` 的问题。它包含已经构建好的
Web `dist/`、新版 Nginx 配置及带 Web 只读挂载的启动脚本，不包含模型和镜像。

Web 默认开启“区分说话人”，请求使用 `diarize=1`，直接复用 6006 原生片段并避开
整段 ForcedAligner 的 `E016`。

当前包文件：

```text
fanyin-new4.1-web-console-20260831-r2.tar.gz
```

`r2` 将 API `language` 字段明确标注为“模型检测标签（仅供参考）”，避免把相近
方言的模型误判当成人工确认结果。归档文件大小、SHA-256 和源码提交以项目交接文档为准。

## 1. 校验并安装文件

```bash
cd /home/gezhi/fanyin/fanyin-new4.1-web-console-20260831-r2
sha256sum -c SHA256SUMS

RELEASE_ROOT=/home/gezhi/fanyin/releases/new4.1-20260829 \
bash migration/apply_web_console.sh
```

这一步只备份和复制项目内文件，不停止或重启容器。

## 2. 确认当前 8885 容器

```bash
docker ps -a --filter 'name=^/tailect-v41-platform$' \
  --format 'table {{.Names}}\t{{.Status}}\t{{.Ports}}'

docker inspect --format \
  '{{range .Mounts}}{{println .Source "->" .Destination}}{{end}}' \
  tailect-v41-platform
```

旧容器没有 `/usr/share/nginx/html` 挂载，Docker 不能向现有容器追加挂载。

## 3. 维护窗口激活 Web

以下命令只操作本项目明确命名的 8885 平台容器。先把旧容器停止并改名保留：

```bash
WEB_BACKUP_CONTAINER="tailect-v41-platform-pre-web-$(date '+%Y%m%d-%H%M%S')"
docker stop tailect-v41-platform
docker rename tailect-v41-platform "$WEB_BACKUP_CONTAINER"
printf 'Retained old platform container: %s\n' "$WEB_BACKUP_CONTAINER"

cd /home/gezhi/fanyin/releases/new4.1-20260829
bash wxz/deploy/run_v4_1_single_4090.sh start
```

模型容器如果已经运行，启动脚本不会重建它。旧平台容器仍保留用于回滚。

## 4. 验收

```bash
curl -fsS http://127.0.0.1:8885/health
curl -fsS http://127.0.0.1:8885/ | head
curl -I http://127.0.0.1:8885/
```

浏览器打开：

```text
http://12.33.114.138:8885/
```

页面应显示 Tailect V4.1 音频转写界面，“区分说话人”默认开启。

## 5. 回滚

先停止新平台容器，但不要删除：

```bash
docker stop tailect-v41-platform
docker rename tailect-v41-platform \
  "tailect-v41-platform-web-failed-$(date '+%Y%m%d-%H%M%S')"
```

用第 3 步输出的实际备份容器名恢复，不要猜测名称：

```bash
docker rename <实际备份容器名> tailect-v41-platform
docker start tailect-v41-platform
```

如还需要恢复文件：

```bash
RELEASE_ROOT=/home/gezhi/fanyin/releases/new4.1-20260829 \
bash migration/rollback_web_console.sh
```

回滚过程保留新旧容器、Web 文件、备份和日志，不执行删除。
