# DeepSeek Chat（单用户部署）

基于 [deepseek-ai/chat-demo](https://github.com/deepseek-ai/chat-demo) 的个人聊天应用，
提供独立登录页、Docker 部署和服务端数据存储。同一账号可在电脑、手机等设备上访问相同的聊天记录。

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/potatoshred/chat-demo)

> 不想自己跑服务器？点上面的按钮可以部署到 Cloudflare Workers + D1 的免费额度内（无需信用卡），
> 详见 [cloudflare/README.md](cloudflare/README.md)。

- 在 `.env` 中配置登录账号、密码和 DeepSeek API Key。
- 聊天记录、附件原件、草稿及设置保存在服务端 SQLite，通过 Docker 数据卷持久化。
- 浏览器通过服务端代理调用 DeepSeek API，API Key 保留在服务器端。
- 支持导入 DeepSeek 导出的历史 ZIP，以及导出聊天备份。

## 快速开始

需要 Docker 和 Docker Compose。

```sh
git clone https://github.com/potatoshred/chat-demo.git
cd chat-demo
cp .env.example .env
chmod 600 .env
```

编辑 `.env`：

```dotenv
AUTH_USERNAME=admin
AUTH_PASSWORD='replace-with-your-own-long-password'
DEEPSEEK_API_KEY=sk-your-deepseek-api-key
DEEPSEEK_API_BASE_URL=https://api.deepseek.com
```

将示例密码和 API Key 替换为自己的值，然后启动：

```sh
docker compose up -d --build
docker compose ps
```

打开 <http://localhost:8090>，使用配置的账号密码登录。

默认端口只绑定主机回环地址。部署在远程服务器时，可以使用 SSH 隧道访问，
或按下文配置 HTTPS 域名：

```sh
ssh -L 8090:127.0.0.1:8090 your-user@your-server
```

建立隧道后，在自己的电脑打开 <http://localhost:8090>。

## 一键部署到 Cloudflare（免费）

点顶部的 **Deploy to Cloudflare** 按钮，或直接打开
<https://deploy.workers.cloudflare.com/?url=https://github.com/potatoshred/chat-demo>。

点击后 Cloudflare 会把仓库复制到你的账号、自动创建 D1、构建并部署，最后给出
`https://<名字>.<子域>.workers.dev` 地址。需要改一处：**Build command 填 `pnpm cf:build`**
（默认填的是静态版 `pnpm build`）。

免费版与容器版的差异：

- 附件单张 ≤0.5MB（浏览器内多轮压缩后才上传）；
- 不轮询同步：只在打开页面、回到页面、回复结束后同步；
- 用量页只显示余额，不显示 24 小时日志；
- 单库 500MB、10 万请求/天、10ms CPU/请求，额度用尽当天会直接报错。

`workers.dev` 在部分网络不可达，需要稳定访问时把自己的域名挂到同一个 Worker 上即可。
完整步骤见 [cloudflare/README.md](cloudflare/README.md)。

## 配置

Compose 在容器启动时读取以下变量：

| 变量 | 用途 | 默认值 |
| --- | --- | --- |
| `AUTH_USERNAME` | 登录名，1–64 位字母、数字或 `_.@-` | `admin` |
| `AUTH_PASSWORD` | 登录密码，必填，14–256 个字符 | 无 |
| `DEEPSEEK_API_KEY` | DeepSeek API Key，必填 | 无 |
| `DEEPSEEK_API_BASE_URL` | 上游 API 根地址 | `https://api.deepseek.com` |
| `CHAT_SUBNET` | Docker 网络子网；与其他网络冲突时调整 | `172.29.255.0/24` |
| `CLOUDFLARE_TUNNEL_TOKEN` | Cloudflare Tunnel 令牌；启用 `cloudflared` 时必填 | 无 |

密码建议由密码管理器生成。含 `$`、`#` 等字符时，在 `.env` 中用单引号包裹以保留原值。
`.env` 包含密码和 Key，应保持权限为 600，并限制主机及 Docker 的访问权限。
此文件已从 Git 和镜像构建上下文中排除。

修改 `.env` 后执行：

```sh
docker compose up -d --no-build
```

Compose 会替换配置变化的容器。修改账号密码后，原有登录失效，聊天数据保留。
直接执行 `docker compose restart` 不会更新容器环境变量。

使用自定义 API 地址时，服务需要支持 Anthropic 消息和文件协议，以及本应用使用的工具、语音等扩展。
仅兼容 OpenAI 聊天接口的服务无法直接替代。官方根地址保持 `https://api.deepseek.com`，
应用会自动拼接接口路径。

## 数据存储与跨设备访问

聊天记录、全部消息分支、附件原件、导入历史、未发送的草稿和应用设置保存在服务端 SQLite。
数据库路径为 `auth` 容器中的 `/data/chat.sqlite`，Compose 将命名卷 `chat_data` 挂载到 `/data`。
实际卷名带有 Compose 项目前缀，例如 `chat-demo_chat_data`。

各设备登录同一服务即可访问相同数据。页面每 30 秒及切回窗口时检查更新，静置 5 分钟或切到后台后暂停轮询，有操作时立即恢复并同步；
生成中的回答每 2 秒保存进度，结束后再保存。草稿在编辑暂停约 400 毫秒后保存。
请等待保存完成后再关闭页面；网络中断时，尚未保存的部分可能丢失。
同时编辑同一对话或草稿时，过期的写入会被拒绝，避免覆盖另一设备保存的内容。
遇到冲突，请先复制尚未保存的文字，再刷新页面。

| 操作 | 数据变化 |
| --- | --- |
| 刷新页面、更换浏览器或设备 | 登录后可访问相同数据 |
| 清除浏览器站点数据、退出登录 | 服务端数据保留 |
| 重启、重建、更新容器或 `docker compose down` | 数据保留；认证服务重启后需重新登录 |
| 修改登录账号密码 | 数据保留，原有登录失效 |
| `docker compose down -v` 或删除数据卷 | **删除数据** |
| 更换 Compose 项目名称或迁移服务器 | 需要迁移或恢复原数据卷 |
| 导入历史或删除全部对话 | 替换或清空服务端历史、附件和草稿，影响所有设备；保留设置 |

在“设置 → 数据管理”中导入 DeepSeek 历史 ZIP。导入先写入独立暂存区，
校验和上传全部成功后才替换现有历史；失败时保留原记录。
导入期间若另一设备修改了历史，提交会被拒绝，请重新导入。

如需迁移其他静态部署中的浏览器历史，先在原站点导出 ZIP，再在这里导入。
ZIP 中缺少的附件原件需重新上传。

## 备份与恢复

网页“导出所有历史对话”可备份聊天与图片，便于再次导入。
该 ZIP 中的非图片附件只有文件信息，不包含原件，也不包含设置和草稿。

完整备份请归档数据卷。先停止认证服务以暂停写入，再归档整个 `/data` 目录：

```sh
mkdir -p backups
docker compose stop auth
docker compose run --rm -T --no-deps --entrypoint sh auth -c 'tar -C /data -czf - .' > backups/chat-data.tar.gz
docker compose start auth
```

恢复到目标项目的数据卷时，先备份当前数据，再执行以下命令。同名文件将被覆盖：

```sh
docker compose stop auth
docker compose run --rm -T --no-deps --entrypoint sh auth -c 'tar -C /data -xzf -' < backups/chat-data.tar.gz
docker compose start auth
```

备份包含私人聊天、附件和设置，请妥善保存。
SQLite 运行时可能同时使用 WAL 文件，因此应归档整个目录，避免只复制正在使用的 `chat.sqlite`。

## 使用域名和 HTTPS

将域名解析到服务器，在入口反向代理配置 HTTPS 证书，并转发到 `http://127.0.0.1:8090`。
主机 Nginx 示例：

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

将示例域名和证书路径替换为实际值，然后通过 `https://chat.example.com` 访问。
代理需覆盖 `Host` 和 `X-Forwarded-Proto`，应用据此校验请求来源并设置 HTTPS 登录 Cookie。
保留 8090 的回环绑定，`auth` 服务仅在容器网络内部访问。

如果入口代理也运行在容器中，让它与 `chat` 加入同一网络，代理到 `chat:8080`。
代理容器中的 `127.0.0.1` 指向该代理容器自身。

### 可选：Cloudflare Tunnel

`compose.yaml` 已包含默认注释的 `cloudflared` 服务。启用后可通过 Cloudflare 提供的 HTTPS 域名访问，
无需开放服务器入站端口。

1. 在 Cloudflare 控制台创建使用 `cloudflared` 的 Tunnel，并复制其令牌。
2. 在 `.env` 中添加 `CLOUDFLARE_TUNNEL_TOKEN=你的隧道令牌`。
3. 取消 `compose.yaml` 中 `cloudflared` 服务配置的注释。
4. 在该 Tunnel 中添加公网主机名，例如 `chat.example.com`，服务类型选择 HTTP，地址填写 `chat:8080`（完整地址为 `http://chat:8080`）。保留默认的 Host 转发设置。
5. 启动服务：

   ```sh
   docker compose up -d --no-build
   docker compose logs --tail=50 cloudflared
   ```

然后打开 `https://chat.example.com`，使用应用的账号密码登录。
`cloudflared` 通过容器网络连接 `chat:8080`。

模板固定使用 `--protocol http2`：connector 与 Cloudflare 边缘走 TCP，适合 UDP 7844 被封、
日志里出现 `failed to dial to edge with quic` 反复重连的网络。若服务器 UDP 通畅、想要 QUIC 的低延迟，
把 `compose.yaml` 里的 `--protocol http2` 删掉（或改成 `--protocol auto`）后 `docker compose up -d cloudflared`。

## 登录与访问保护

登录密码在服务器端通过带随机盐的 scrypt 哈希验证。
登录 Cookie 使用 `HttpOnly`、`SameSite=Strict`，HTTPS 下同时使用 `Secure` 和 `__Host-` 前缀。
登录和退出要求同源请求及 CSRF 校验，密码验证全站限制为每 5 分钟 5 次尝试。

登录会话有效期为 12 小时。重启认证服务会撤销全部登录；
在“设置 → 通用设置”中退出登录会撤销当前会话。
聊天页面、静态资源、API 代理及数据接口均受登录保护。
通过网络访问时请配置 HTTPS；本机访问或加密的 SSH 隧道可使用 HTTP。

## 检查与更新

检查服务状态和日志：

```sh
curl --fail http://127.0.0.1:8090/healthz
docker compose logs --tail=50 chat auth
```

更新代码并重建容器：

```sh
git pull --ff-only
docker compose up -d --build
```

更新前建议备份数据卷。Compose 项目名称和数据卷保持一致时，重建容器会复用已有数据。

## 可选：通过代理构建

Linux 主机需要代理下载构建依赖时，可分别构建两个镜像，再启动 Compose。
以下以监听在 `127.0.0.1:7890` 的 HTTP 代理为例：

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

这些参数仅用于构建阶段下载依赖。基础镜像的拉取由 Docker 守护进程负责，
运行时访问 DeepSeek API 的网络由服务器提供。

## 本地开发

需要 Node.js 24 和 pnpm 12.6.0。

```sh
pnpm install --frozen-lockfile
pnpm dev
```

直接运行开发服务器或构建静态页面时，使用上游的浏览器直连模式：
在网页中配置 API Key，数据保存在浏览器中。完整的登录保护和服务端存储通过 Docker Compose 运行。

代码检查：

```sh
pnpm type
pnpm lint
node --test deploy/auth/server.test.mjs
```
