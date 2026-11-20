# DeepSeek Chat（单用户部署）

基于 [deepseek-ai/chat-demo](https://github.com/deepseek-ai/chat-demo) 改造的个人聊天应用。前端为纯静态页面，服务端负责登录鉴权、数据同步与 DeepSeek 请求转发。由于服务端依赖较少，同一份代码可部署在 Cloudflare 免费额度内，也可通过 Docker 自建部署。

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/potatoshred/chat-demo)

## 项目特性

- **跨设备同步**：对话记录、消息分支、附件、草稿和设置均存储在服务端，手机与电脑登录同一账号即可访问相同数据。
- **API Key 不下发至浏览器**：所有 DeepSeek 请求由服务端转发，Key 仅保存在服务器或 Cloudflare 的密钥配置中，不会出现在前端源码或浏览器网络请求中。
- **完整的聊天能力**：支持思考强度调节、联网搜索、图片与文件上传、语音朗读，以及 Markdown、数学公式和 Mermaid 图表渲染。
- **历史记录迁移**：支持导入 DeepSeek 官方导出的历史 ZIP，也可将全部对话打包导出备份。
- **导入过程可视化**：导入时实时显示已写入的会话与附件数量；超出限制或已存在的内容会被跳过并列出名称，避免静默丢失，单条异常数据也不会导致整包失败。
- **单用户登录保护**：提供独立登录页、CSRF 校验、登录限速与 HttpOnly Cookie，未登录状态下无法访问页面和接口。
- **用量可查**：设置页可查看账户余额；容器版另提供最近 24 小时的请求明细（输入/缓存/输出 token、搜索次数、思考强度、首字延迟与 TPS）。
- **三种部署方式**：Cloudflare Workers、Cloudflare Pages 与本地 Docker，前端功能一致，区别仅在额度限制与运维方式。

## 部署方式选择

可根据以下条件快速选择：

- **有自有域名（托管在 Cloudflare）** → 选择 **Workers**。一键部署流程最简单，静态文件不计入每日请求额度；绑定自有域名后可避免 `workers.dev` 在部分地区不可达的问题。
- **没有自有域名，主要在国内访问** → 选择 **Pages**。`pages.dev` 的连通性通常优于 `workers.dev`，但静态文件也会计入每日请求额度。
- **需要上传大文件、要求数据自持或在内网使用** → 选择 **本地容器**。不受第三方平台额度限制，数据存储在自有服务器。

| | Workers | Pages | 本地容器 |
| --- | --- | --- | --- |
| 成本 | 免费额度内 0 元 | 免费额度内 0 元 | 一台服务器 + 域名（可选） |
| 运维负担 | 无 | 无 | 自己管 Docker、备份和证书 |
| 数据存在哪 | Cloudflare D1 | Cloudflare D1 | 本地数据卷（SQLite） |
| 单附件上限 | **0.5MB**（图片会自动压缩） | 0.5MB | 图片 64MB / 其他 32MB |
| 单会话上限 | 约 1.9MB | 约 1.9MB | 32MB |
| 每日额度 | 10 万请求/天、10ms CPU | 与 Workers 相同，但**静态文件也计入请求** | 无平台额度限制 |
| 多端同步 | 打开/切回页面、回复结束时 | 同左 | 30 秒轮询 + 切回页面 |
| 用量页面 | 仅账户余额 | 仅账户余额 | 余额 + 24 小时请求明细 |
| 适用场景 | 有自有域名、日常主力使用 | 无自有域名、重视直接可访问 | 数据自持、大附件、内网部署 |

> Cloudflare 免费版额度为**硬性上限**：用尽后当日请求会直接报错，不会降速降级。具体数值见下文的 [Workers 免费额度说明](#workers-的免费额度与限制)。

---

## 一、Cloudflare Workers（免费，静态资源不计费）

一个 Worker 同时提供 `/data` 数据接口、`/api` 转发和前端静态资源，数据存储在 D1 数据库中。无需配置 Pages，也无需信用卡。

### 方式 A：通过按钮一键部署

点击页面顶部的 **Deploy to Cloudflare** 按钮（或直接打开 <https://deploy.workers.cloudflare.com/?url=https://github.com/potatoshred/chat-demo>）。授权 GitHub 后，Cloudflare 会将仓库复制到你的账号下，仅需配置以下两项：

1. **填写两个密钥**：`AUTH_PASSWORD`（登录密码，至少 14 位）与 `DEEPSEEK_API_KEY`，类型均选择「密钥（Secret）」。
2. **修改登录名（可选）**：默认值为 `admin`。如需修改，在新仓库的 `wrangler.jsonc` 中调整 `vars.AUTH_USERNAME` 并重新部署。

> 项目名称默认为 `chat-demo`。如该 GitHub 账号下已存在同名仓库（例如源仓库本身），表单会提示「已存在具有该名称的存储库」，可改用其他名称（如 `chat-cf`）。D1 名称保持默认的 `deepseek-chat`，且须与 `wrangler.jsonc` 中的 `database_name` 一致，否则部署脚本会创建新的数据库。

其余配置（Worker 名称、D1 数据库、构建与部署命令、建表迁移）保持默认值，直接部署即可。完成后访问 `https://<项目名>.<你的子域>.workers.dev`（未修改项目名时为 `chat-demo`），使用上述账号密码登录。

### 方式 B：在本地用命令行部署

如需使用命令行部署，请准备 Node.js 24+、pnpm，并登录 Wrangler：

```sh
pnpm install --frozen-lockfile
npx wrangler login

# 构建边缘版前端（开启服务端模式、套用免费额度参数、复制 _headers）
pnpm cf:build

# 准备首次部署需要的两个密钥（.secrets 已在 .gitignore 中，用 JSON 避免 $ 等符号被 shell 展开）
cat > .secrets <<'JSON'
{ "AUTH_PASSWORD": "换成至少14位的密码", "DEEPSEEK_API_KEY": "sk-你的key" }
JSON

# 自动建库（若不存在）、执行表迁移、部署代码，并一次性写入密钥
pnpm run deploy -- --secrets-file .secrets
rm .secrets
```

后续更新代码只需执行 `pnpm cf:build && pnpm run deploy`，已写入的密钥会保留。

必须使用 `pnpm run deploy`，其中的 `run` 不可省略：Workers Builds 默认使用的 pnpm 9 会将 `pnpm deploy` 识别为内置 workspace 命令并报错 `ERR_PNPM_CANNOT_DEPLOY`。也可不使用临时文件，首次部署后分别执行 `npx wrangler secret put AUTH_PASSWORD` 和 `npx wrangler secret put DEEPSEEK_API_KEY` 写入密钥。

如当前令牌缺少 D1 的创建或列表权限，可先在控制台手动创建数据库，并将 UUID 填入 `wrangler.jsonc` 的 `database_id`，或在部署时提供环境变量 `D1_DATABASE_ID=<uuid>`。

### 绑定自定义域名

`workers.dev` 在部分地区网络不可达。如需稳定访问，建议绑定托管在 Cloudflare 的自定义域名：

1. 进入 Worker → **Settings → Domains & Routes → Add → Custom Domain**，填写域名（例如 `chat.example.com`）；
2. 或者直接在 `wrangler.jsonc` 里加上路由配置：

```jsonc
"routes": [{ "pattern": "chat.example.com", "custom_domain": true }]
```

绑定后 Cloudflare 会自动配置证书，Cookie、HTTPS 与登录逻辑无需修改。

### 免费版的登录实现差异

免费版每次请求的 CPU 时间上限为 10ms，无法承载容器版耗时约 100–200ms 的带盐 scrypt 哈希。因此边缘版采用「口令派生密钥 + HMAC 签名 Cookie」方案：

- 校验使用常量时间比较，伪造 Cookie 需要掌握登录口令，其安全门槛与直接登录一致；
- **修改密码会使所有已登录设备失效**，可用于强制登出全部设备；
- 密码是唯一根凭据，建议使用 **16 位以上的随机字符串**。

### 日常更新

- **通过按钮创建的仓库**：将新代码推送到该仓库的 `main` 分支，Workers Builds 会自动重新构建并发布。构建失败时线上仍保留上一个正常版本，D1 数据不受影响。
- **命令行部署的**：拉取最新代码后重新执行 `pnpm cf:build && pnpm run deploy`。数据库迁移为增量执行，仅应用 `cloudflare/migrations/` 中新增的脚本，不会清空现有数据。

### 优缺点

**优势**

- 零成本、无需运维，自带 HTTPS 与全球边缘节点；
- 无需管理服务器续费、证书过期与数据备份（D1 提供 7 天 Time Travel 时间点恢复）；
- 配置随代码库管理，推送即发布；
- 聊天数据与 API Key 均不会下发至浏览器。

**局限**

- 额度用尽后服务暂停：单库 500MB、每天 10 万次请求、单次 10ms CPU；超出后需等待 UTC 零点重置；
- 单个附件上限 **0.5MB**（超大的 JPEG/PNG/WebP 会在浏览器中多轮压缩，仍超过 0.5MB 的文件无法上传）；
- 单条会话的 JSON 上限约 1.9MB，导入历史时超长会话会被跳过；
- 为降低请求量，未启用后台定时轮询；多设备同时打开时，仅在切回页面或回复生成结束后获取最新状态；
- 用量页只能看余额，没有 24 小时请求日志。

### Workers 的免费额度与限制

| 项目 | 免费版上限 | 实际影响 |
| --- | --- | --- |
| Worker 请求数 | 10 万次/天 | 静态文件不走 Worker 不计数；只有 `/data`、`/api`、`/auth`、`/login`、`/logout` 会消耗额度 |
| CPU 时间 | 10ms/请求 | 极长对话的序列化或超大批量导入可能撞线报错 `1102` |
| D1 存储空间 | 5GB/账号，500MB/单库 | 纯文字聊天通常不会用尽，主要占用来自图片附件 |
| D1 读写行数 | 500 万读/天、10 万写/天 | 导入 1,700 条对话的历史包约消耗 3 万行写入 |
| D1 单行大小 | 2MB | 附件限制 0.5MB、单会话限制 1.9MB 都是为了给单行留余量 |
| 单次调用查询数 | 50 次 | 导入与 MIME 类型回写均按页处理，以避免触及上限 |

底层设计、迁移脚本说明与故障排查详见 [cloudflare/README.md](cloudflare/README.md)。

---

## 二、Cloudflare Pages（使用 `pages.dev` 域名）

如没有自有域名，且需要在国内网络直接访问，可将项目部署到 Pages。Pages 的 advanced mode 允许将同一个 Worker 脚本作为 `_worker.js` 运行。

**官方一键部署按钮不支持创建 Pages 项目**，需在控制台手动创建。

### 推荐路径：先部署 Workers，再切换到 Pages

从零配置 Pages 项目需要手动建库、建表和绑定变量，步骤较多。推荐**先通过一键按钮完成 Workers 部署**，再将 Pages 接入同一个 D1 数据库，无需迁移数据：

1. 按上一节的方法通过按钮部署 Workers，此时 D1 数据库与表结构已自动创建；
2. 照着下面的步骤建一个 Pages 项目，在 Bindings 里直接选**同一个** `deepseek-chat` 数据库；
3. 在 Pages 项目设置中重新配置 `AUTH_USERNAME`（普通变量），以及 `AUTH_PASSWORD`、`DEEPSEEK_API_KEY` 两个密钥（Secret 与具体项目绑定，不会在 Worker 与 Pages 之间自动共享）；
4. 访问分配的 `pages.dev` 地址，确认登录与聊天正常后，可停用或删除原 Worker；**删除 Worker 不会删除 D1 数据库**。

切换期间两者可同时读写同一数据库；建议日常仅保留一个入口，避免并发编辑同一会话触发 409 冲突。

### 完整配置步骤

1. **建数据库**（如果还没建过）：进入控制台 → **Storage & Databases → D1 → Create**，名称填 `deepseek-chat`。
2. **初始化表结构**：在本地仓库根目录执行以下命令（按库名操作，无需修改配置文件中的占位 ID）：

   ```sh
   npx wrangler d1 execute deepseek-chat --remote --file=cloudflare/schema.sql
   ```

   也可在控制台 D1 的 Console 标签页中整段执行 `cloudflare/schema.sql`。若已按上述路径部署 Workers，则无需此步；`schema.sql` 中的语句均为 `IF NOT EXISTS` 或 `INSERT OR IGNORE`，重复执行不会破坏数据。
3. **创建 Pages 项目**：控制台 → **Workers & Pages → Create → Pages**，连接 Git 仓库：
   - **Build command**：`pnpm build`（Pages 环境会注入 `CF_PAGES`，构建脚本据此生成 `dist/_worker.js` 与 `_headers`）
   - **Build output directory**：`dist`
4. **绑定数据库**：进入 Pages 项目的 **Settings → Bindings**，添加 D1 数据库，变量名填 `DB`，数据库选 `deepseek-chat`。
5. **配置变量与密钥**：进入 **Settings → Variables and Secrets**：
   - 添加普通变量 `AUTH_USERNAME`（比如 `admin`）
   - 添加两个**密钥（Secret）**：`AUTH_PASSWORD` 和 `DEEPSEEK_API_KEY`
6. 重新触发一次部署，完成后打开 `https://<项目名>.pages.dev` 即可登录。

> 注意：Pages 项目**不会读取**仓库根目录的 `wrangler.jsonc`，数据库绑定、变量、密钥与自定义域名均需在 Pages 控制台配置。
> 非生产分支的预览部署（Preview）默认使用同一个生产 D1 数据库；为避免预览分支写入生产数据，建议在项目设置中关闭预览部署。

### 优缺点

**优势**

- 自带 `pages.dev` 域名，在部分地区的连通性优于 `workers.dev`；
- 与 Workers 共用同一个 D1 数据库，可随时切换回 Workers；
- 可使用 Pages 的 Git 分支预览等生态能力。

**局限**

- advanced mode 会处理**所有**请求，HTML、JS、CSS、字体等静态文件同样计入每日 10 万次请求额度（打开一次页面约消耗 15–20 次请求，约合每日 5,000 次页面访问）；
- D1 容量、10ms CPU、0.5MB 附件、1.9MB 单会话等限制和 Workers 版一模一样；
- 绑定与变量配置在控制台中，不随代码进入 Git；项目重建后需手动重新配置；
- 新增数据库迁移脚本时，Pages 构建不会自动执行，需手动运行对应的 SQL。

---

## 三、本地容器（Docker Compose）

如有自有云服务器、VPS 或长期运行的 NAS，可使用 Docker Compose 自建部署：Nginx 提供静态资源，Node 进程负责登录、本地 SQLite 读写与 API 代理。该方式不受第三方平台额度限制，图片上限为 64MB、其他文件 32MB、单条会话 32MB。

### 快速开始

准备 Docker 与 Docker Compose：

```sh
git clone https://github.com/potatoshred/chat-demo.git
cd chat-demo
cp .env.example .env
chmod 600 .env
```

编辑 `.env`，填入账号、密码与 API Key：

```dotenv
AUTH_USERNAME=admin
AUTH_PASSWORD='replace-with-your-own-long-password'
DEEPSEEK_API_KEY=sk-your-deepseek-api-key
DEEPSEEK_API_BASE_URL=https://api.deepseek.com
```

构建并后台启动服务：

```sh
docker compose up -d --build
docker compose ps
```

在本机浏览器访问 <http://localhost:8090> 即可登录。出于安全考虑，容器默认只监听宿主机的 `127.0.0.1:8090` 回环地址；部署在远程服务器时，可建立 SSH 隧道进行临时访问：

```sh
ssh -L 8090:127.0.0.1:8090 your-user@your-server
```

### `.env` 配置项说明

| 变量 | 作用 | 默认值 |
| --- | --- | --- |
| `AUTH_USERNAME` | 登录用户名，支持 1–64 位字母、数字或 `_.@-` | `admin` |
| `AUTH_PASSWORD` | 登录密码（必填），长度 14–256 位 | 无 |
| `DEEPSEEK_API_KEY` | DeepSeek API Key（必填） | 无 |
| `DEEPSEEK_API_BASE_URL` | 上游 API 地址 | `https://api.deepseek.com` |
| `CHAT_SUBNET` | 容器内部网段，和宿主机现有网段冲突时再改 | `172.29.255.0/24` |
| `CLOUDFLARE_TUNNEL_TOKEN` | 启用内置 `cloudflared` 隧道时必填 | 无 |

密码中如包含 `$`、`#` 等特殊字符，需使用单引号包裹。每次修改 `.env` 后须执行 `docker compose up -d --no-build` 使新变量生效（`docker compose restart` 不会重新加载环境变量）。修改密码会使所有已登录会话失效，原有聊天记录不受影响。

### 配置域名与 HTTPS

正式对外访问时，将域名解析到服务器，在宿主机的 Nginx / Caddy 等反向代理上配置 SSL 证书，并反向代理至 `http://127.0.0.1:8090`：

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

`Host` 与 `X-Forwarded-Proto` 两个请求头**须原样传递**：后端据此校验请求来源，并在识别到 HTTPS 时启用更严格的 `Secure` + `__Host-` 前缀 Cookie。若入口代理同样运行在容器中，可将其与 `chat` 服务接入同一 Docker 网络，并代理至 `http://chat:8080`。

**可选：使用 Cloudflare Tunnel（无需开放公网端口）**

1. 在 Cloudflare 控制台创建 `cloudflared` 类型的 Tunnel，并记录令牌；
2. 在 `.env` 里加上 `CLOUDFLARE_TUNNEL_TOKEN=...`；
3. 取消 `compose.yaml` 中 `cloudflared` 服务配置的注释；
4. 在控制台把 Tunnel 的公网域名指向容器内网地址 `http://chat:8080`；
5. 执行 `docker compose up -d --no-build`，并通过 `docker compose logs --tail=50 cloudflared` 查看连接状态。

`compose.yaml` 默认使用 `--protocol http2`（走 TCP），适用于 UDP 7844 端口受限或被封锁的网络环境；若服务器 UDP 连通性良好，可移除该参数以使用 QUIC。

### 数据存储、备份与更新

- 聊天记录、附件、草稿与设置存储在命名卷 `chat_data` 挂载的 `/data/chat.sqlite` 中（实际卷名带 Compose 项目名前缀）。
- 可在设置页点击「导出所有历史对话」，将聊天记录与图片打包下载（非图片附件仅包含元信息）。
- **完整冷备份**（归档 SQLite 的 WAL 日志，建议先停止写入再打包）：

  ```sh
  mkdir -p backups
  docker compose stop auth
  docker compose run --rm -T --no-deps --entrypoint sh auth -c 'tar -C /data -czf - .' > backups/chat-data.tar.gz
  docker compose start auth
  ```

- **从冷备份恢复**（恢复前建议先备份当前数据；解压会覆盖同名文件）：

  ```sh
  docker compose stop auth
  docker compose run --rm -T --no-deps --entrypoint sh auth -c 'tar -C /data -xzf -' < backups/chat-data.tar.gz
  docker compose start auth
  ```

- **日常更新代码**：`git pull --ff-only && docker compose up -d --build`，重建容器会复用原有数据卷。
- **状态检查**：`curl --fail http://127.0.0.1:8090/healthz`，或通过日志查看：`docker compose logs --tail=50 chat auth`。

> 注意：`docker compose down -v` 会**同时删除数据卷**。更换服务器或修改 Compose 项目名称前，请先导出卷内数据。

### 可选：通过代理构建镜像

当服务器访问 npm registry 较慢时，可使用宿主机代理分别构建镜像后再启动服务：

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

上述代理参数仅在镜像构建阶段生效；运行时访问 DeepSeek API 使用服务器自身的网络。

### 优缺点

**优势**

- 不受第三方额度限制：图片 64MB、其他文件 32MB、单会话 32MB，无每日请求数上限；
- 数据存储于自有服务器，适合对隐私敏感或纯内网环境，备份与迁移路径清晰；
- 每 30 秒自动轮询，并在切回窗口时同步，多端同步较为及时；设置页提供最近 24 小时的详细请求日志；
- 登录使用标准的带盐 scrypt 哈希，并带有 5 分钟内最多试错 5 次的防爆破限制。

**局限**

- 需自行准备服务器或 NAS，并负责续费、证书配置、备份与系统升级；
- 单点部署，不具备 Cloudflare 的全球边缘加速；服务器宕机或断网时服务不可用；
- 登录会话保存在服务端内存中，重启 `auth` 容器后所有设备需重新登录；
- 大量高清图片会占用磁盘空间，需自行监控容量。

---

## 通用行为

### 多设备同步与冲突处理

- **同步时机**：容器版每 30 秒及切回标签页时检查更新（页面静置满 5 分钟或切到后台时暂停轮询）；Workers 与 Pages 版为降低请求量，仅在打开页面、切回标签页及回复生成结束时同步。
- **流式保存**：流式输出期间，前端会定期保存已生成的内容（容器版每 2 秒，边缘版每 10 秒），回复结束后再保存最终结果；草稿在停止编辑约 400ms 后自动保存。
- **并发冲突**：若两台设备同时修改同一会话或草稿，版本落后的一方会收到 409 冲突提示。发生此类冲突时，请先复制尚未保存的内容，刷新页面后重新提交。
- 发送消息或编辑长文后，请确认保存完成再关闭页面；网络中断期间未同步的内容可能丢失。

### 导入与导出历史记录

- 在「设置 → 数据管理 → 导入历史」里可以直接上传从 DeepSeek 官方导出的历史 ZIP 包，支持**追加**和**替换**两种模式。
- **追加模式可减少额度消耗**：前端解压时先比对现有会话 ID，已存在的会话会被跳过，不写入暂存表也不重复上传附件，仅上传新增会话。
- **事务式暂存**：无论哪种模式，导入数据都会先写入服务端暂存区，全部校验通过后才会提交；导入失败时现有数据不受影响。被跳过的会话与附件会在结果中按名称列出。
- 免费版（Workers / Pages）对单次导入的附件总量设有 **100MB** 上限（暂存表与正式表在提交时各保留一份），超出上限的附件会被跳过。

---

## 本地开发与调试

本地开发需要 Node.js 24 和 pnpm 12.6.0：

```sh
pnpm install --frozen-lockfile
pnpm dev
```

直接执行 `pnpm dev` 或 `pnpm build` 时，构建产物为**纯前端直连模式**：无需启动后端，在设置页填写 API Key 即可请求 DeepSeek，聊天数据存储于浏览器 IndexedDB。如需在本地联调服务端登录与存储，请使用上述 Docker Compose 部署。

当前 `pnpm build`（调用 `scripts/build.mjs`）会根据环境变量自动选择构建目标，构建日志首行会打印 `[build] target=...`：

| 运行环境 | 触发条件 | 构建产物 |
| --- | --- | --- |
| Workers Builds | 检测到 `WORKERS_CI=1` | 服务端模式 + 免费额度参数 + `dist/_headers` |
| Cloudflare Pages | 检测到 `CF_PAGES` | 同上，并额外把 Worker 复制为 `dist/_worker.js` |
| Docker 构建 | `Dockerfile` 传入 `CHAT_SERVER_API=true` | 服务端模式 + 容器版宽松参数 |
| 本地终端 / GitHub Actions | 无上述环境变量 | 纯静态直连模式（数据存 IndexedDB） |

如需在本地强制指定构建目标，可使用快捷脚本：`pnpm cf:build`（边缘版）、`CHAT_SERVER_API=true pnpm build`（容器版）。

提交代码前可执行类型检查、Lint 与两套后端的单元测试：

```sh
pnpm type
pnpm lint
node --test deploy/auth/server.test.mjs      # 容器版后端测试
node --test cloudflare/worker.test.mjs      # Workers 版后端测试
```
