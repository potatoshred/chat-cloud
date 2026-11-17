# 单用户登录与容器部署

本工作区基于 [deepseek-ai/chat-demo](https://github.com/deepseek-ai/chat-demo) 的
`5d5dd754ebc1948e977ddb880a9eb5aa25f37b4c`（2026-11-13，v0.1.1），
增加独立登录页、服务端 API 代理和 SQLite 存储，适合单用户跨设备使用。

## 设置账号并启动

需要 Docker 和 Docker Compose。先在项目根目录创建环境变量文件：

```sh
cp .env.example .env
chmod 600 .env
```

编辑 `.env`，设置 `AUTH_USERNAME`、`AUTH_PASSWORD` 和 `DEEPSEEK_API_KEY`，再启动：

```sh
docker compose up -d --build
docker compose ps
```

打开 <http://localhost:8090>，登录后即可聊天，无需在网页填写 API Key。
默认账号为 `admin`；密码由 `.env` 中的 `AUTH_PASSWORD` 设置，长度至少 14 个字符，
建议使用密码管理器生成。密码含 `$`、`#` 等字符时，在 `.env` 中用单引号包裹以保留原值。
访问地址自动从请求识别，无需设置 `APP_ORIGIN`。使用不同设备登录同一服务即可共享数据。

## 环境变量

Compose 将下面的变量传入 `auth` 服务，在容器启动时读取。也可以在容器管理面板中设置。

| 变量 | 用途 | 默认值 |
| --- | --- | --- |
| `AUTH_USERNAME` | 单用户登录名，1–64 位字母、数字或 `_.@-` | `admin` |
| `AUTH_PASSWORD` | 登录密码，必填，14–256 个字符 | 无 |
| `DEEPSEEK_API_KEY` | DeepSeek API Key，必填 | 无 |
| `DEEPSEEK_API_BASE_URL` | 上游 API 的根地址 | `https://api.deepseek.com` |

`.env` 示例：

```dotenv
AUTH_USERNAME=admin
AUTH_PASSWORD='replace-with-your-own-long-password'
DEEPSEEK_API_KEY=sk-your-deepseek-api-key
DEEPSEEK_API_BASE_URL=https://api.deepseek.com
```

Key 只在服务端添加到上游请求中，不注入静态文件、不下发给浏览器。
登录密码在启动时生成带随机盐的 scrypt 哈希，再用于验证。
原始密码仍在 `.env` 和容器环境变量中，因此 `.env` 权限应保持 600，
并限制主机及 Docker 的访问权限。`.env` 已从 Git 和镜像构建上下文中排除，不要提交或分享它。
修改变量后执行 `docker compose up -d --no-build`，Compose 会重建配置变更的容器，
无需重新构建镜像；直接 `docker compose restart` 不会更新容器环境变量。

API 根地址会自动拼接 `/anthropic/v1/messages`、`/anthropic/v1/files`、
`/v1/tools/asr`、`/v1/tools/tts` 和 `/models`，不要给官方地址额外加 `/v1`。
自定义上游需要支持这些协议及搜索、链接阅读等扩展；仅兼容 OpenAI 聊天接口的服务不够。
请求体上限为 32 MiB，同一时间最多转发 8 个 API 请求。

## 通过 7890 代理构建

Linux 主机的本地代理监听在 `127.0.0.1:7890` 时，可以分别构建两个镜像，再启动：

```sh
docker build --network=host --target auth \
  --build-arg HTTP_PROXY=http://127.0.0.1:7890 \
  --build-arg HTTPS_PROXY=http://127.0.0.1:7890 \
  --build-arg NO_PROXY=localhost,127.0.0.1 \
  -t deepseek-chat-auth:local .
docker build --network=host --target runtime \
  --build-arg HTTP_PROXY=http://127.0.0.1:7890 \
  --build-arg HTTPS_PROXY=http://127.0.0.1:7890 \
  --build-arg NO_PROXY=localhost,127.0.0.1 \
  -t deepseek-chat-demo:local .
docker compose up -d --no-build
```

代理参数用于构建阶段下载 npm 依赖，不写入运行时镜像环境。
基础镜像的拉取由 Docker 守护进程负责，需要它可以访问镜像仓库。
容器运行时由 `auth` 服务请求上游 API，需要服务器能够访问该 API。
构建代理参数不影响容器运行时的网络。

## 本地或 SSH 隧道访问

Compose 只向主机回环地址开放 `127.0.0.1:8090`。
项目网络默认使用 `172.29.255.0/24`，以适应当前主机已耗尽的 Docker 默认地址池；
若与其他网络冲突，可用 `CHAT_SUBNET=其他空闲网段 docker compose up -d` 调整。
在远程服务器部署并通过 SSH 隧道使用时：

```sh
ssh -L 8090:127.0.0.1:8090 your-user@your-server
```

然后在自己的电脑打开 <http://localhost:8090>。本地访问或已加密的 SSH 隧道可使用 HTTP；
通过网络访问请配置 HTTPS。

## 使用域名和 HTTPS

无需配置 `APP_ORIGIN`。应用通过转发的 Host 和协议识别当前站点，并继续校验登录、API 和数据请求的来源。

在入口反向代理配置有效的 HTTPS 证书，代理到主机 `http://127.0.0.1:8090`。
例如主机上的 Nginx：

```nginx
server {
    listen 443 ssl;
    server_name chat.example.com;
    ssl_certificate /path/to/fullchain.pem;
    ssl_certificate_key /path/to/privkey.pem;

    location / {
        proxy_pass http://127.0.0.1:8090;
        proxy_set_header Host $http_host;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
}
```

入口代理必须覆盖 `Host` 与 `X-Forwarded-Proto`，HTTPS 请求转发 `https`，以启用 Secure Cookie。
保持 8090 仅对回环或可信入口代理开放，`auth` 不发布端口。
80 端口只用于证书验证和 HTTPS 跳转，确认 HTTPS 工作正常后配置 HSTS。
如果入口代理也在容器里，让它与 `chat` 加入同一个网络，代理到 `chat:8080`；
代理容器中的 `127.0.0.1` 指向它自身。
`auth` 服务不应发布主机端口或直接暴露到公网。

## 登录如何工作

```text
浏览器 → HTTPS 入口 → chat（Nginx）→ 受保护的静态页面
                         ↓ /api/、/data/ 与登录验证
                     auth（Node.js）→ DeepSeek API
                         ↓                ↑
                   SQLite 数据卷       环境变量中的 Key
```

- `/login` 是独立的中文表单页面，支持密码管理器、手机布局和深浅色外观，页面不加载第三方资源。
- 密码在服务器端使用 scrypt 验证，参数为 N=65536、r=8、p=2，随机盐 32 字节。
  前端只提交密码，不接收密码哈希。
- 登录成功生成随机会话 ID。服务端内存保存其 SHA-256 摘要，Cookie 使用 `HttpOnly`、
  `SameSite=Strict`；HTTPS 配置另外使用 `Secure` 和 `__Host-` 前缀。
  Cookie 不写入 localStorage，不需要 JavaScript 读取。
- 会话固定 12 小时过期。重启认证服务会撤销全部会话；退出登录立即撤销当前会话。
  在聊天设置 → 通用设置中点击“退出登录”，或直接打开 `/logout` 确认退出。
- 登录和退出均要求同源 POST 与服务端 CSRF 校验；登录挑战 10 分钟过期。
  登录验证全站共限每 5 分钟 5 次，成功后清零，并限制并发密码计算。
  被限速后需要等待；更换 IP 或伪造代理头无法绕过限制。
- Nginx 通过 `auth_request` 保护 HTML、静态脚本、样式和其余资源。
  只有登录、退出确认、必要的认证接口和健康检查开放；认证服务不可用时拒绝访问。
  所有页面与资源使用 `no-store`，以便请求重新校验会话。
- 已打开的聊天标签页在切回或每 30 秒检查一次会话，失效时回到登录页。
- 聊天、附件和语音请求经同源 `/api/` 转发。服务端再次校验会话和请求来源，
  仅允许指定的 API 路径与方法，并用环境变量中的 Key 替换上游认证信息。
  流式回复及时转发，浏览器停止生成时关闭对应上游连接。

容器模式的 API Key 保存在服务端环境变量中，浏览器不再读取以前保存的 Key。
如果以前在网页里手动保存过 API Key，可在浏览器站点数据中删除旧值。
已发送给上游的内容不会因退出网站而撤回。

## 会话存储与持久化

聊天记录、全部消息分支、附件原件、导入的历史、未发送的草稿及应用设置都保存在**服务端 SQLite**，
数据库文件为 `auth` 容器的 `/data/chat.sqlite`。Compose 的命名卷 `chat_data` 挂载到 `/data`，
实际卷名带 Compose 项目前缀（通常是 `chat_chat_data`）。浏览器只保留登录 Cookie 和当前页面的内存缓存，
容器模式不再把聊天或设置写入 IndexedDB / localStorage。

| 操作 | 服务端数据 |
| --- | --- |
| 更换浏览器、设备、域名或端口 | 连接同一服务并登录后可访问相同数据 |
| 清除浏览器站点数据、退出登录 | 保留 |
| 重启、重建、更新容器或 `docker compose down` | 保留；认证服务重启需重新登录 |
| 修改 `.env` 中的账号密码 | 保留，旧登录全部失效 |
| `docker compose down -v`、删除数据卷 | **删除数据** |
| 更换 Compose 项目名称或迁移到另一服务器 | 需要显式迁移或恢复原数据卷 |
| 应用内导入历史、删除全部对话 | 替换/清空服务端历史、附件和草稿，影响所有设备；保留设置 |

已打开页面每 5 秒、切回窗口或选择会话时检查服务端变化，生成中的回答每 2 秒保存进度，结束时再保存。
草稿文字与附件在编辑暂停约 400 毫秒后保存到服务端。网络请求完成前关闭页面仍可能丢失尚未保存的部分。
同一对话或草稿同时在多端编辑时使用版本检查：过期的写入会被拒绝并提示刷新，防止静默覆盖。
遇到冲突请先复制尚未保存的文字，再刷新读取服务端版本。

导入 ZIP 仍在浏览器中解析与校验，解析后的会话和图片上传到独立的服务端暂存区，
全部成功后用一个 SQLite 事务替换正式数据；失败保留原有历史。
导入期间若另一设备修改了历史，提交会被拒绝，请重新导入。
未完成的暂存任务 24 小时过期，下次新建导入时回收。

以前浏览器里的旧历史**不会自动迁移**。升级前在原网页导出 ZIP，升级后重新导入一次即可写入服务端。
旧浏览器数据库保持原样。此前导出 ZIP 只包含图片原件，非图片附件如需保留原件请重新上传。

### 备份与恢复

网页“导出所有历史对话”可备份聊天与图片，便于再次导入；不包含非图片原件、设置和草稿。
完整备份请备份数据卷。为保持 SQLite 与 WAL 一致，先停止写入，再一起归档整个 `/data` 目录：

```sh
mkdir -p backups
docker compose stop auth
docker compose run --rm --no-deps --entrypoint sh auth -c 'tar -C /data -czf - .' > backups/chat-data.tar.gz
docker compose start auth
```

恢复到目标项目的数据卷（会覆盖同名文件，请先备份当前卷）：

```sh
docker compose stop auth
docker compose run --rm -T --no-deps --entrypoint sh auth -c 'tar -C /data -xzf -' < backups/chat-data.tar.gz
docker compose start auth
```

归档包含聊天、附件和设置等私人内容，请妥善保存。不要只复制运行中的 `chat.sqlite` 而遗漏 WAL 文件。

## 修改密码或访问地址

修改 `.env` 中的 `AUTH_USERNAME` 或 `AUTH_PASSWORD`，再执行：

```sh
docker compose up -d --no-build
```

Compose 会用新环境变量替换认证容器，原有登录全部失效，服务端聊天保留。
无需重新构建镜像，也不需要单独生成密码文件。旧版本的 `secrets/auth.json` 已不再读取。
更换域名时调整 HTTPS 入口代理即可，不再需要设置或修改 `APP_ORIGIN`。
旧 `.env` 中的 `APP_ORIGIN` 可删除，Compose 已不再传入此变量。

## 检查与更新

```sh
curl --fail http://127.0.0.1:8090/healthz
docker compose logs --tail=50 chat auth
node --test deploy/auth/server.test.mjs
```

Nginx 和认证服务都以非 root 用户运行，使用只读根文件系统（数据卷可写）、移除 Linux capabilities，
并设置 `no-new-privileges`。Node.js 24 用于构建和认证，pnpm 12.6.0 与上游 CI 一致。
运行镜像保留 MIT 许可证。生产环境可把基础镜像固定到经过验证的 digest，定期更新重建。

Docker 构建使用 `CHAT_SERVER_API=true`，让前端请求同源 `/api/`；
API Key 和上游地址由上述运行时环境变量控制。
直接 `pnpm dev`、`pnpm build` 或使用 GitHub Pages 时仍采用上游的浏览器直连模式，
需要在设置中填写 Key，数据保存在浏览器中，并且没有容器登录保护。
不要把 API Key 或登录密码放进构建参数或前端环境变量。
