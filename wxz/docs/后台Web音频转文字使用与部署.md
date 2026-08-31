# Tailect V4.1 后台 Web 使用与部署

## 1. 功能范围

后台 Web 是现有 8885 平台 API 的内网页面：

- 上传一个本地音频文件。
- 调用 `POST /v1/audiototext` 转成文字。
- 上传阶段显示真实上传百分比。
- 上传完成后显示“模型处理中”；现有同步 API 不提供模型内部百分比，因此页面不会显示虚假处理进度。
- 浏览器请求最长等待 12 分钟；Nginx 当前 700 秒上游超时通常会先返回明确的网关错误。
- 完成后展示时间戳、说话人编号和分段文字，并支持复制全文；API 返回的 `language`
  单独标为“模型检测标签（仅供参考）”，相近方言可能误判，不能替代人工定性。
- 不包含跨语言翻译，不新增模型或模型进程。

页面不会把音频或结果写入 localStorage/IndexedDB。8885 API 在请求结束后清理该请求的上传文件和转换文件，不长期保留音频。

## 2. 目录

- 前端源码：`tailect/web/`
- 生产构建：`tailect/web/dist/`
- Nginx 配置：`wxz/deploy/nginx_platform_8885.conf`
- 单 4090 启动脚本：`wxz/deploy/run_v4_1_single_4090.sh`

## 3. 本地开发

需要 Node.js 和 pnpm：

```bash
cd tailect/web
pnpm install --frozen-lockfile
pnpm dev
```

开发服务器默认把 `/health` 和 `/v1` 代理到 `http://127.0.0.1:8885`。

如 8885 位于另一台内网服务器：

```bash
VITE_DEV_PROXY_TARGET=http://192.168.1.10:8885 pnpm dev
```

浏览器打开 Vite 输出的地址。该变量只用于开发代理，不会写入生产构建。

## 4. 构建与检查

```bash
cd tailect/web
pnpm install --frozen-lockfile
pnpm lint
pnpm test
pnpm build
antd lint ./src --format json
```

构建完成后必须存在：

```text
tailect/web/dist/index.html
tailect/web/dist/assets/
```

生产机完全离线且没有 Node.js 时，应在有相同源码的构建机完成 `pnpm build`，再把整个 `dist/` 随离线发布包带到生产机。

`dist/` 属于构建产物并被 Git 忽略；Git 提交不会自动携带它。制作生产离线包时必须显式检查并收录 `dist/index.html` 和 `dist/assets/`。

## 5. 8885 部署

生产离线增量包：

```text
fanyin-new4.1-web-console-20260831-r2.tar.gz
大小：324406 字节
SHA256：7bbbfc4837eba55baff21a8a96678ad3d9873d5bef0d59ea82683db21f8914a8
SOURCE_COMMIT：dc22ab0322bbed64ecfd16525ab0b301bf511e5a
```

该包包含已构建的 `dist/`、Nginx 静态站点配置、平台容器启动脚本及可回退的
文件级应用脚本。完整生产操作见包内 `migration/README_web_console.md`。

新的 8885 结构：

```text
GET  /                  -> 前端 index.html
GET  /assets/*          -> 前端静态资源
GET  /health            -> 6006 FastAPI
POST /v1/audiototext    -> 6006 FastAPI
*    /translator/*      -> 6006 FastAPI
其它路径                 -> 平台 JSON 404
```

首次使用新容器：

```bash
cd wxz/deploy
bash run_v4_1_single_4090.sh start
```

脚本会检查 `tailect/web/dist/index.html`，并把 `dist/` 只读挂载到 Nginx 的 `/usr/share/nginx/html`。

### 已存在旧的 8885 容器

旧容器没有前端目录挂载，Docker 无法给已有容器追加 mount。启动脚本会检测并拒绝继续，不会删除或覆盖旧容器。

在确认容器名属于本项目后，先停止并改名保留：

```bash
docker stop tailect-v41-platform
docker rename tailect-v41-platform tailect-v41-platform-pre-web
bash run_v4_1_single_4090.sh start
```

旧容器仍然保留，可用于回滚。若备份名已经存在，应换一个明确的新名字，不要覆盖。

## 6. 访问与使用

内网浏览器打开：

```text
http://模型服务器内网IP:8885/
```

1. 确认“服务状态”为“服务就绪”。
2. 选择音频。
3. “区分说话人”默认开启，使 8885 直接使用 6006 原生片段并避开全局 ForcedAligner
   的 `E016`；只有明确需要整段模式时才关闭。识别语言由新模型自动检测。
4. 如果服务设置了 `TAILECT_API_KEY`，输入 API Key；它只保存在当前页面内存中。
5. 点击“开始转写”。
6. 等待上传和模型处理完成，查看或复制结果。

刷新页面后，页面中的已选音频、API Key 和结果都会消失。

## 7. 验证

```bash
curl -fsS http://127.0.0.1:8885/health
curl -I http://127.0.0.1:8885/
curl -I http://127.0.0.1:8885/assets/实际构建文件名.js
```

API 验证：

```bash
curl -sS -X POST \
  'http://127.0.0.1:8885/v1/audiototext?model=Tailect_V4.1&diarize=1' \
  -F 'file=@/path/to/audio.wav;type=audio/wav'
```

成功响应的 `code` 为 `200`。接口的业务失败也可能使用 HTTP 200，页面会继续检查响应体 `code` 和 `message`。

## 8. 回滚

停止当前项目平台容器：

```bash
docker stop tailect-v41-platform
```

旧容器仍以 `tailect-v41-platform-pre-web` 保留。回滚前先确认 8885 没有被其它服务占用，再按现场容器命名规则恢复。不要删除容器或项目文件。
