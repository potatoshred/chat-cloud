# DeepSeek Chat（单用户部署）

基于 [deepseek-ai/chat-demo](https://github.com/deepseek-ai/chat-demo) 的个人聊天应用。前端是纯静态页面，后端只做三件事：登录、存数据、转发 DeepSeek 请求——因此同一份代码可以跑在 Cloudflare 的免费额度里，也可以用 Docker 跑在自己的服务器上。

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/potatoshred/chat-demo)

## 特性

- **一份数据，多设备**：聊天记录、消息分支、附件、草稿、设置都存在服务端，换设备登录即可继续。
- **API Key 不下发浏览器**：所有 DeepSeek 请求由服务端代理，Key 只存在服务器/D1 的配置里。
- **完整聊天能力**：深度思考强度、联网搜索、图片与文件附件、语音朗读、Markdown/公式/图表渲染。
- **历史迁移**：可导入 DeepSeek 导出的历史 ZIP，也可一键导出全部对话做备份。
- **导入有进度和明细**：显示已写入的会话/附件数量；超过限制而跳过的会话、附件会按名字列出，不会静默丢失。
- **单用户登录保护**：独立登录页、CSRF 校验、登录限速、HttpOnly Cookie；登录后所有页面与接口都受保护。
- **可观测**：设置页显示账户余额，容器版另有 24 小时请求日志（输入/缓存/输出、搜索次数、思考强度、首字延迟与 TPS）。
- **三种部署形态**：Cloudflare Workers（免费）、Cloudflare Pages、本地 Docker，功能一致，限制不同。

## 怎么选

| | Workers | Pages | 本地容器 |
| --- | --- | --- | --- |
| 成本 | 免费额度内 0 元 | 免费额度内 0 元 | 一台服务器 + 域名（可选） |
| 运维 | 无 | 无 | 自己维护 Docker、备份、证书 |
| 数据位置 | Cloudflare D1 | Cloudflare D1 | 自己的数据卷（SQLite） |
| 单附件上限 | **0.5MB**（浏览器内压缩） | 0.5MB | 图片 64MB / 其他 32MB |
| 单会话上限 | 约 1.9MB | 约 1.9MB | 32MB |
| 额度 | 10 万请求/天、10ms CPU | 同上，且**静态文件也计数** | 无 |
| 实时性 | 打开/回页/回复结束同步 | 同左 | 30 秒轮询 + 回页同步 |
| 用量页 | 仅余额 | 仅余额 | 余额 + 24h 日志 |
| 适合 | 个人日常、手机+电脑 | 想用 `pages.dev` 域名 | 数据自持、大附件、内网 |

> 免费额度是**硬停**：用尽当天直接报错，不会限速降级。详细数值见 [Workers 限制](#workers-的免费额度与限制)。

---

## 一、Cloudflare Workers（推荐，免费）

一个 Worker 同时提供 `/data` 接口、`/api` 代理和静态资源，数据存 D1。不需要 Pages，也不需要信用卡。

### 方式 A：一键部署按钮

点顶部的 **Deploy to Cloudflare** 按钮，或打开
<https://deploy.workers.cloudflare.com/?url=https://github.com/potatoshred/chat-demo>。

1. 授权 GitHub。Cloudflare 会把仓库**复制到你自己的账号**（不是 fork），后续自动更新发生在这份副本里。
2. 确认 Worker 名称（默认 `chat-demo`）和 D1 名称（`deepseek-chat`）。
3. 填写两个密钥（按钮只会提示这两个）：
   - `AUTH_PASSWORD`：登录密码，至少 14 位
   - `DEEPSEEK_API_KEY`：DeepSeek Key

   登录名不在这里填：它是普通变量，来自 `wrangler.jsonc` 的 `vars.AUTH_USERNAME`（默认 `admin`），要改就直接改那一行再重新部署。
4. **Build command** 保持 `pnpm build`（构建脚本会识别 `WORKERS_CI=1`，自动切到服务端 + 免费额度参数）。
5. **Deploy command** 必须是 **`node scripts/cloudflare-deploy.mjs`**（或 `pnpm run deploy`）。这一栏只在项目创建时确定，之后再改仓库不会同步——不设置就会因为占位 `database_id` 报 `10181`。
6. 点部署。脚本会：按名字找 D1 → 没有就创建并把真实 ID 写回配置 → 执行全部迁移 → 部署 Worker。
7. 访问 `https://chat-demo.<你的子域>.workers.dev`，用 `wrangler.jsonc` 里的用户名 + 第 3 步设置的密码登录。

> 第一次部署若提示 `The following required secrets have not been set`，说明两个 Secret 还没加或没重新部署——加上后点「重试部署」即可。

### 方式 B：命令行部署

需要 Node.js 24+、pnpm，以及已登录的 Wrangler。

```sh
pnpm install --frozen-lockfile
npx wrangler login

# 边缘构建：服务端模式 + 免费额度参数 + _headers
pnpm cf:build

# 两个运行时密钥，只在首次部署时需要（.secrets 已在 .gitignore 里；JSON 不受 $ 展开影响）
cat > .secrets <<'JSON'
{ "AUTH_PASSWORD": "换成至少14位的密码", "DEEPSEEK_API_KEY": "sk-你的key" }
JSON

# 建库（没有时）、跑迁移、部署，并把密钥一并写入
pnpm run deploy -- --secrets-file .secrets
rm .secrets
```

之后更新代码只需要 `pnpm cf:build && pnpm run deploy`，密钥会保留。
注意要写 `pnpm run deploy`：pnpm 9（Workers Builds 默认版本）会把 `pnpm deploy` 当成内置的 workspace 部署命令并报 `ERR_PNPM_CANNOT_DEPLOY`。也可以不用 `.secrets`，改为
`npx wrangler secret put AUTH_PASSWORD` / `npx wrangler secret put DEEPSEEK_API_KEY`。

如果构建令牌或本机账号没有 D1 权限，先手动建库，把 ID 填进 `wrangler.jsonc` 的 `database_id`，或在部署时提供 `D1_DATABASE_ID=<uuid>`。

### 自定义域名

1. 域名托管在 Cloudflare；
2. Worker → Settings → Domains & Routes → Add → Custom Domain，填 `chat.example.com`；
3. 或者写进 `wrangler.jsonc`：

```jsonc
"routes": [{ "pattern": "chat.example.com", "custom_domain": true }]
```

`workers.dev` 在部分网络（尤其中国大陆）不可达，需要稳定访问就用自定义域名；Cookie、HTTPS、登录逻辑都不用改。

### 登录方式与代价

免费版每请求只有 10ms CPU，装不下容器版那种带盐 scrypt（约 100–200ms），所以改用「口令派生密钥 + HMAC 签名 Cookie」：

- 校验是常量时间比较，伪造 Cookie 需要知道登录口令，和直接登录的门槛相同；
- **改密码会让所有设备立即掉线**，可以当作"登出所有设备"用；
- 口令务必 16 位以上随机串，这是唯一凭据。

### 日常更新

用按钮创建的副本：向 Cloudflare 复制出的那个仓库的 `main` push，Workers Builds 会自动重建部署；构建失败时线上保持上一个版本，D1 数据不受影响。

手动部署的：拉代码后重跑 `pnpm cf:build && pnpm run deploy`。迁移是增量的，只执行 `cloudflare/migrations/` 里没跑过的文件；重复执行也不会清数据。

### 优缺点

**优点**

- 零成本、零运维，自动 HTTPS 与全球边缘；
- 不用管服务器、证书、备份（D1 自带 7 天 Time Travel）；
- 一个仓库一套配置，push 即发布；
- 数据和 Key 都不在浏览器里。

**缺点**

- 额度硬限制：单库 500MB、10 万请求/天、10ms CPU/请求，超了当天不可用；
- 附件只能到 **0.5MB**（超过的 JPEG/PNG/WebP 会在浏览器里多轮压缩，压不下来会被拒绝）；
- 单条会话 JSON 超过约 1.9MB 会被拒绝，超大会话在导入时跳过；
- 没有轮询同步：多设备之间要等切回页面或一条回复结束才刷新；
- 用量页只显示余额，没有 24 小时日志。

### Workers 的免费额度与限制

| 项 | 免费额度 | 影响 |
| --- | --- | --- |
| Worker 请求 | 10 万/天 | 静态文件不计入，只有 `/data`、`/api`、`/auth`、`/login`、`/logout` 触发 Worker |
| CPU | 10ms/请求 | 大会话序列化、超大导入可能触发 `1102` |
| D1 存储 | 5GB/账号，500MB/库 | 会话正文够用，附件是主要占用 |
| D1 行读/写 | 500 万读/天、10 万写/天 | 一次 1,700 会话的导入约消耗 3 万行写入 |
| D1 单行/对象 | 2MB | 附件上限 0.5MB、会话上限 1.9MB 都由此而来 |
| 单次调用查询数 | 50 | 导入、类型回写都按页处理以留出余量 |

更多实现细节、迁移与故障排查见 [cloudflare/README.md](cloudflare/README.md)。

---

## 二、Cloudflare Pages（`pages.dev` 域名）

Pages 的 advanced mode 可以把同一个 Worker 作为 `_worker.js` 运行。**一键按钮不支持 Pages**，需要手动建项目；静态资源和 API 走同一个 Function。

### 步骤

1. 若还没有数据库：控制台 → **Storage & Databases → D1 → Create**，名字填 `deepseek-chat`。
2. 建表（在仓库根目录执行，命令按库名找，不需要先改配置）：

   ```sh
   npx wrangler d1 execute deepseek-chat --remote --file=cloudflare/schema.sql
   ```

   也可以在 D1 的 Console 里整段执行 `cloudflare/schema.sql`。和 Workers 共用同一个库时，表通常已经存在，`schema.sql` 全是 `IF NOT EXISTS` / `INSERT OR IGNORE`，重复执行安全。
3. 控制台 → Workers & Pages → Create → **Pages** → 连接 Git 仓库：
   - Build command：`pnpm build`（Pages 会注入 `CF_PAGES`，构建脚本自动附带 `_worker.js` 和 `_headers`）
   - Build output directory：`dist`
4. 项目 Settings → **Bindings** → 添加 D1：变量名 `DB`，选择 `deepseek-chat`。
5. Settings → **Variables and Secrets**：
   - `AUTH_USERNAME`（普通变量）
   - `AUTH_PASSWORD`、`DEEPSEEK_API_KEY`（类型选**密钥**）
6. 部署完成后访问 `https://<项目名>.pages.dev`，用配置的账号密码登录。

想先在本地确认产物，可以跑 `pnpm cf:build:pages`，然后检查 `dist/_worker.js` 是否存在。

> Pages 项目**不会读取**根目录的 `wrangler.jsonc`，绑定、变量、密钥都在项目设置里配；改用自定义域名时也在这里加。
> 预览部署（非生产分支）默认也用同一套绑定，会读写正式 D1；不需要时在项目里关掉预览部署。

### 优缺点

**优点**

- 有 `pages.dev` 域名，国内可达性通常比 `workers.dev` 好一些；
- 可以和 Workers 共用同一个 D1，随时切换形态；
- 分支预览、Git 集成与 Pages 生态一致。

**缺点**

- advanced mode 会拦截**所有**请求，静态 HTML/JS/CSS 也计入 10 万/天（Worker 版静态不计数）；
- D1、CPU、附件、会话大小限制与 Workers 完全相同；
- 配置分散在面板里，不在版本库中，重建项目要重新配一遍；
- 迁移需要手动执行（Pages 构建不会跑 `wrangler d1 migrations apply`）；
- 构建多一步写入 `dist/_worker.js`，产物比 Worker 版略大。

---

## 三、本地容器（Docker Compose）

跑在自己的服务器或 NAS 上：Nginx 提供静态资源，Node 服务负责登录、SQLite 存储和 API 代理。没有第三方额度：图片最大 64MB、其他文件 32MB、单会话 32MB。

### 快速开始

需要 Docker 与 Docker Compose。

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

启动并检查：

```sh
docker compose up -d --build
docker compose ps
```

打开 <http://localhost:8090> 登录。默认只绑定主机回环地址，远程服务器可用 SSH 隧道：

```sh
ssh -L 8090:127.0.0.1:8090 your-user@your-server
```

### 配置项

| 变量 | 用途 | 默认值 |
| --- | --- | --- |
| `AUTH_USERNAME` | 登录名，1–64 位字母、数字或 `_.@-` | `admin` |
| `AUTH_PASSWORD` | 登录密码，必填，14–256 字符 | 无 |
| `DEEPSEEK_API_KEY` | DeepSeek API Key，必填 | 无 |
| `DEEPSEEK_API_BASE_URL` | 上游 API 根地址 | `https://api.deepseek.com` |
| `CHAT_SUBNET` | Docker 网络子网，冲突时调整 | `172.29.255.0/24` |
| `CLOUDFLARE_TUNNEL_TOKEN` | 启用 `cloudflared` 时必填 | 无 |

含 `$`、`#` 的值用单引号包裹。改完 `.env` 执行 `docker compose up -d --no-build`（`restart` 不会更新环境变量）。改密码会让所有登录失效，数据保留。

### 域名与 HTTPS

把域名解析到服务器，在入口反向代理配证书并转发到 `http://127.0.0.1:8090`：

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

代理必须转发 `Host` 和 `X-Forwarded-Proto`：应用据此校验来源，并在 HTTPS 下使用 `Secure` + `__Host-` Cookie。入口代理若也在容器里，让它与 `chat` 同网络并代理到 `chat:8080`。

**可选：Cloudflare Tunnel**（不开放入站端口）

1. 控制台创建使用 `cloudflared` 的 Tunnel，复制令牌；
2. `.env` 加 `CLOUDFLARE_TUNNEL_TOKEN=...`；
3. 取消 `compose.yaml` 里 `cloudflared` 服务的注释；
4. Tunnel 公网主机名指向 `http://chat:8080`；
5. `docker compose up -d --no-build`，看 `docker compose logs --tail=50 cloudflared`。

模板固定 `--protocol http2`（TCP），适合 UDP 7844 被封的网络；UDP 通畅时可删掉以启用 QUIC。

### 数据、备份与更新

- 聊天记录、附件、草稿、设置都在命名卷 `chat_data` 的 `/data/chat.sqlite`（实际卷名带 Compose 项目前缀）。
- 网页「导出所有历史对话」可备份聊天与图片；非图片附件只有文件信息。
- 完整备份（含 WAL，停写后归档整个目录）：

  ```sh
  mkdir -p backups
  docker compose stop auth
  docker compose run --rm -T --no-deps --entrypoint sh auth -c 'tar -C /data -czf - .' > backups/chat-data.tar.gz
  docker compose start auth
  ```

- 恢复：先备份当前数据，再解回同一路径（同名文件会被覆盖）：

  ```sh
  docker compose stop auth
  docker compose run --rm -T --no-deps --entrypoint sh auth -c 'tar -C /data -xzf -' < backups/chat-data.tar.gz
  docker compose start auth
  ```
- 更新：`git pull --ff-only && docker compose up -d --build`；重建容器复用数据卷。
- 排查：`curl --fail http://127.0.0.1:8090/healthz`、`docker compose logs --tail=50 chat auth`。

> `docker compose down -v` 或删除数据卷会**删除全部数据**；更换 Compose 项目名/服务器时需迁移卷。

### 可选：通过代理构建

构建机需要代理下载依赖时，分开构建两个镜像再启动：

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

这些参数只作用于构建阶段；运行时访问 DeepSeek API 走服务器自身的网络。

### 优缺点

**优点**

- 没有第三方额度：图片 64MB、其他文件 32MB、单会话 32MB，也没有每日请求数上限；
- 数据完全自持，可内网/离线部署，备份和迁移路径清晰；
- 30 秒轮询 + 回页同步，多设备实时性最好；用量页有完整 24h 日志；
- 登录用带盐 scrypt 校验，并限制 5 分钟 5 次尝试。

**缺点**

- 需要一台服务器、域名（可选）和持续的运维：证书、备份、升级都要自己做；
- 单机部署，没有边缘加速，服务器故障即不可用；
- 认证服务重启会撤销全部登录（会话在内存里），需要重新登录；
- 附件和数据库占磁盘，需要自己监控容量。

---

## 通用行为

### 同步与冲突

- 容器版每 30 秒及切回窗口时检查更新，静置 5 分钟或切后台暂停；Workers/Pages 只在打开页面、切回页面、回复结束后同步。
- 生成中的回答定期保存（容器 2 秒、免费版 10 秒），结束后再保存一次；草稿在停止编辑约 400ms 后保存。
- 同一对话或草稿被两个设备同时修改时，过期写入会被拒绝（409）。先复制未保存文字，再刷新重试。
- 请等待保存完成再关闭页面；网络中断时未保存的部分可能丢失。

### 导入与导出

- 设置 → 数据管理 → 导入历史：支持 DeepSeek 导出的 ZIP，可选**追加**或**替换**。
- 追加模式会先跳过已存在的会话，不再上传附件，只写新增内容。
- 导入先进入暂存区，全部成功才提交；失败保留原数据。会话/附件被跳过时会列出名字。
- 免费版对单次导入的附件总量有 100MB 预算（暂存 + 最终各一份），超出部分跳过。

---

## 本地开发

需要 Node.js 24 和 pnpm 12.6.0。

```sh
pnpm install --frozen-lockfile
pnpm dev
```

开发服务器和 `pnpm build` 走**浏览器直连**模式：在页面里配置 API Key，数据存 IndexedDB，不需要后端。要连服务端就用 Docker Compose。

构建入口会按环境选目标，日志第一行会打印 `[build] target=...`：

| 环境 | 判定 | 产物 |
| --- | --- | --- |
| Workers Builds | `WORKERS_CI=1` | 服务端 + 免费额度参数 + `_headers` |
| Cloudflare Pages | `CF_PAGES` | 同上，另加 `_worker.js` |
| Docker | `CHAT_SERVER_API=true` | 服务端，保留容器版参数 |
| 本地 / GitHub Actions | 无标记 | 纯静态，直连上游 API |

强制指定：`pnpm cf:build`（边缘）、`CHAT_SERVER_API=true pnpm build`（容器）。

检查：

```sh
pnpm type
pnpm lint
node --test deploy/auth/server.test.mjs      # 容器版后端
node --test cloudflare/worker.test.mjs      # Workers 版后端
```
