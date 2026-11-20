# DeepSeek Chat（单用户部署）

基于 [deepseek-ai/chat-demo](https://github.com/deepseek-ai/chat-demo) 改造的个人聊天应用。前端是纯静态页面，后端只负责三件事：登录鉴权、同步数据、转发 DeepSeek 请求。因为服务端足够轻，同一份代码既可以白嫖 Cloudflare 的免费额度，也可以用 Docker 跑在自己的机器上。

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/potatoshred/chat-demo)

## 这份代码做了什么

- **换设备接着聊**：对话记录、消息分支、附件、草稿和设置都存在服务端，手机和电脑登录同一个账号就能同步。
- **API Key 不进浏览器**：所有 DeepSeek 请求统一由服务端转发，Key 只留在服务器或 Cloudflare 的密钥配置里，前端源码和网络面板里都看不到。
- **聊天功能齐全**：支持调节深度思考强度、联网搜索、上传图片与文件、语音朗读，以及 Markdown、数学公式、Mermaid 图表渲染。
- **历史记录随时搬家**：可以直接导入从 DeepSeek 官方导出的历史 ZIP，也能一键把全部对话打包导出备份。
- **导入过程透明**：导入时实时显示已写入的会话和附件数；遇到超大或重复内容会自动跳过并按名称列出来，不会悄悄丢数据，也不会因为一条脏数据卡死整包导入。
- **带基础防线的单用户登录**：独立登录页、CSRF 校验、登录限速、HttpOnly Cookie，未登录时所有页面和接口都无法访问。
- **用量心里有数**：设置页可直接看账户余额；容器版还会保留最近 24 小时的请求明细（输入/缓存/输出 token、搜索次数、思考强度、首字延迟与 TPS）。
- **三种部署方式任选**：Cloudflare Workers、Cloudflare Pages、本地 Docker，前端体验完全一致，只是额度和运维方式不同。

## 怎么选部署方式

不用纠结完整参数，先看你手头有什么：

- **有自己的域名（且托管在 Cloudflare）** → 选 **Workers**。一键部署最省事，静态文件还不消耗每日请求额度，绑上自己的域名后也不用担心 `workers.dev` 在国内打不开。
- **没有域名，主要在国内直接访问** → 选 **Pages**。`pages.dev` 在国内的连通性通常比 `workers.dev` 好不少，代价是每次加载静态文件也会计入每日请求额度。
- **经常传大文件、想自己攥着数据，或者在局域网里用** → 选 **本地容器**。没有第三方额度限制，全部数据落盘在自己的机器上。

| | Workers | Pages | 本地容器 |
| --- | --- | --- | --- |
| 成本 | 免费额度内 0 元 | 免费额度内 0 元 | 一台服务器 + 域名（可选） |
| 运维负担 | 无 | 无 | 自己管 Docker、备份和证书 |
| 数据存在哪 | Cloudflare D1 | Cloudflare D1 | 本地数据卷（SQLite） |
| 单附件上限 | **0.5MB**（图片会自动压缩） | 0.5MB | 图片 64MB / 其他 32MB |
| 单会话上限 | 约 1.9MB | 约 1.9MB | 32MB |
| 每日额度 | 10 万请求/天、10ms CPU | 同左，但**静态文件也算请求** | 无限制 |
| 多端同步 | 打开/切回页面、回复结束时 | 同左 | 30 秒轮询 + 切回页面 |
| 用量页面 | 仅账户余额 | 仅账户余额 | 余额 + 24 小时请求明细 |
| 适合谁 | 有域名、日常主力使用 | 没域名、看重直接可访问 | 数据自持、大附件、内网部署 |

> Cloudflare 免费版额度是**硬上限**：当天用完就会直接报错，不会降速凑合用。具体数字可以看下文的 [Workers 免费额度说明](#workers-的免费额度与限制)。

---

## 一、Cloudflare Workers（免费，静态资源不计费）

一个 Worker 同时搞定 `/data` 数据接口、`/api` 转发和前端静态资源，数据存在 D1 数据库里。不需要配 Pages，也不用绑信用卡。

### 方式 A：点按钮一键部署

点击页面顶部的 **Deploy to Cloudflare** 按钮（或直接打开 <https://deploy.workers.cloudflare.com/?url=https://github.com/potatoshred/chat-demo>）。授权 GitHub 后，Cloudflare 会自动把仓库复制到你的账号下，你**只需要填两处**：

1. **填两个密钥**：`AUTH_PASSWORD`（登录密码，至少 14 位）和 `DEEPSEEK_API_KEY`，注意类型都要选「密钥（Secret）」。
2. **改登录名（可选）**：默认是 `admin`。想换的话，去新仓库的 `wrangler.jsonc` 里改 `vars.AUTH_USERNAME` 再重新部署即可。

> 项目名称默认是 `chat-demo`。如果这个 GitHub 账号下已经有同名仓库（比如源仓库本身），表单会提示「已存在具有该名称的存储库」，换个名字（如 `chat-cf`）即可。D1 名称保持默认的 `deepseek-chat`——它必须和 `wrangler.jsonc` 里的 `database_name` 一致，否则部署脚本会另建一个库。

其余的 Worker 名称、D1 数据库、构建和部署命令、建表迁移全部走默认值，不用动，直接点部署。跑完后打开 `https://<项目名>.<你的子域>.workers.dev`（项目名没改就是 `chat-demo`），用刚才设的账号密码就能登录。

### 方式 B：在本地用命令行部署

如果你更习惯在终端里操作，准备好 Node.js 24+、pnpm，并登录 Wrangler：

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

以后更新代码只需要跑 `pnpm cf:build && pnpm run deploy`，已经写进去的密钥会一直保留。

这里注意一定要写 `pnpm run deploy`，不要省掉 `run`：Workers Builds 默认用的 pnpm 9 会把 `pnpm deploy` 当成内置的 workspace 命令，直接报错 `ERR_PNPM_CANNOT_DEPLOY`。如果你不想建 `.secrets` 临时文件，也可以在首次部署后分别执行 `npx wrangler secret put AUTH_PASSWORD` 和 `npx wrangler secret put DEEPSEEK_API_KEY` 手动录入。

万一当前令牌没有 D1 的创建/列表权限，可以先去控制台手动建好数据库，把 UUID 填进 `wrangler.jsonc` 的 `database_id`，或者在部署时传入环境变量 `D1_DATABASE_ID=<uuid>`。

### 绑定自定义域名

`workers.dev` 在国内网络基本打不开。平时要稳定使用，建议挂一个托管在 Cloudflare 上的自定义域名：

1. 进入 Worker → **Settings → Domains & Routes → Add → Custom Domain**，填上你的域名（比如 `chat.example.com`）；
2. 或者直接在 `wrangler.jsonc` 里加上路由配置：

```jsonc
"routes": [{ "pattern": "chat.example.com", "custom_domain": true }]
```

绑好后会自动配好证书，Cookie、HTTPS 和登录逻辑都不需要额外改代码。

### 为什么免费版的登录实现不一样

免费版每次请求只有 10ms 的 CPU 时间，跑不动容器版那种耗时 100–200ms 的带盐 scrypt 哈希。所以边缘版换成了「口令派生密钥 + HMAC 签名 Cookie」的方案：

- 校验时做常量时间比较，想伪造 Cookie 必须先猜中登录密码，安全性门槛与直接撞库登录一致；
- **改密码会立刻踢掉所有已登录设备**，想"登出所有设备"时改一次密码就行；
- 因为密码是唯一的根凭据，请务必用 **16 位以上的随机字符串**。

### 日常怎么更新

- **用一键按钮建的仓库**：把新代码 push 到你自己那份仓库的 `main` 分支，Workers Builds 会自动重新构建并发布。就算某次构建失败，线上也会保留上一个正常版本，D1 里的数据不会丢。
- **命令行手动部署的**：拉取最新代码后重跑 `pnpm cf:build && pnpm run deploy`。数据库迁移是增量执行的，只会跑 `cloudflare/migrations/` 里新增的脚本，不会清空已有聊天记录。

### 优缺点盘点

**讨喜的地方**

- 真·零成本、零运维，自带 HTTPS 和全球边缘节点；
- 不用操心服务器续费、证书过期和数据备份（D1 自带 7 天 Time Travel 时间点恢复）；
- 配置全在代码库里，push 即发布；
- 聊天数据和 API Key 都不落地浏览器。

**需要接受的妥协**

- 额度到了就停：单库 500MB、每天 10 万次请求、单次 10ms CPU，超了要等第二天 UTC 零点恢复；
- 单个附件上限 **0.5MB**（超大的 JPEG/PNG/WebP 会在浏览器里自动多轮压缩，压不进 0.5MB 的文件无法上传）；
- 单条对话的 JSON 上限约 1.9MB，导入历史时遇到特别长的巨型对话会自动跳过；
- 为了省额度去掉了后台定时轮询，多设备同时打开时，要等切回页面或当前回复生成完才会拉取新状态；
- 用量页只能看余额，没有 24 小时请求日志。

### Workers 的免费额度与限制

| 项目 | 免费版上限 | 实际影响 |
| --- | --- | --- |
| Worker 请求数 | 10 万次/天 | 静态文件不走 Worker 不计数；只有 `/data`、`/api`、`/auth`、`/login`、`/logout` 会消耗额度 |
| CPU 时间 | 10ms/请求 | 极长对话的序列化或超大批量导入可能撞线报错 `1102` |
| D1 存储空间 | 5GB/账号，500MB/单库 | 纯文字聊天很难用完，主要空间杀手是图片附件 |
| D1 读写行数 | 500 万读/天、10 万写/天 | 导入一份 1,700 条对话的历史包大约消耗 3 万行写入 |
| D1 单行大小 | 2MB | 附件限制 0.5MB、单会话限制 1.9MB 都是为了给单行留余量 |
| 单次调用查询数 | 50 次 | 导入和 MIME 类型回写都已经拆成按页处理，避免撞上限 |

更细的底层设计、迁移脚本说明和故障排查可以看 [cloudflare/README.md](cloudflare/README.md)。

---

## 二、Cloudflare Pages（想要 `pages.dev` 域名时选它）

如果你没有自己的域名，又希望在国内网络下大概率能直接打开，可以把项目发到 Pages 上。它利用 Pages 的 advanced mode，把同一个 Worker 脚本作为 `_worker.js` 跑起来。

不过**官方的一键部署按钮不支持创建 Pages 项目**，得在控制台里点几下手动建。

### 偷懒做法：先一键跑通 Workers，再切到 Pages

从零配一个 Pages 项目要手动建库、建表、绑变量，步骤略碎。最省心的路子是**先借一键按钮把脏活干完**，再把 Pages 接上去——两边共用同一个 D1 数据库，一条数据都不用搬：

1. 按上一节的方法点按钮部署好 Workers，这时 D1 数据库和表结构都已经自动建好了；
2. 照着下面的步骤建一个 Pages 项目，在 Bindings 里直接选**同一个** `deepseek-chat` 数据库；
3. 在 Pages 项目设置里重新填一遍 `AUTH_USERNAME`（普通变量），以及 `AUTH_PASSWORD`、`DEEPSEEK_API_KEY` 两个密钥（Secrets 是跟具体项目绑定的，不会跨 Worker 和 Pages 自动共享）；
4. 打开分配给你的 `pages.dev` 地址，测试登录和聊天正常后，就可以把原来的 Worker 停掉或删掉了——**删 Worker 不会连带删掉 D1 数据库**。

切换期间两边甚至可以同时在线读写同一个库；不过平时建议只留一个入口，免得两边同时编辑同一条对话触发 409 冲突。

### 完整配置步骤

1. **建数据库**（如果还没建过）：进入控制台 → **Storage & Databases → D1 → Create**，名称填 `deepseek-chat`。
2. **初始化表结构**：在本地仓库根目录执行下面的命令（直接按库名操作，不用去改配置文件里的占位 ID）：

   ```sh
   npx wrangler d1 execute deepseek-chat --remote --file=cloudflare/schema.sql
   ```

   不想在本地敲命令的话，也可以打开控制台里 D1 的 Console 标签页，把 `cloudflare/schema.sql` 的内容整段粘进去执行。如果你走的是上面"先 Workers 后 Pages"的路子，表早就建好了；而且 `schema.sql` 里全是 `IF NOT EXISTS` 和 `INSERT OR IGNORE`，手抖多跑一遍也是安全的。
3. **创建 Pages 项目**：控制台 → **Workers & Pages → Create → Pages**，连接你的 Git 仓库：
   - **Build command** 填：`pnpm build`（Pages 环境自带 `CF_PAGES` 变量，构建脚本认出后会自动生成 `dist/_worker.js` 和 `_headers`）
   - **Build output directory** 填：`dist`
4. **绑定数据库**：进入 Pages 项目的 **Settings → Bindings**，添加 D1 数据库，变量名填 `DB`，数据库选 `deepseek-chat`。
5. **配置变量与密钥**：进入 **Settings → Variables and Secrets**：
   - 添加普通变量 `AUTH_USERNAME`（比如 `admin`）
   - 添加两个**密钥（Secret）**：`AUTH_PASSWORD` 和 `DEEPSEEK_API_KEY`
6. 重新触发一次部署，完成后打开 `https://<项目名>.pages.dev` 即可登录。

> 注意：Pages 项目**完全不读**仓库根目录的 `wrangler.jsonc`，所有数据库绑定、变量、密钥和自定义域名都得在 Pages 的网页控制台里配。
> 另外，非生产分支的预览部署（Preview）默认也会连到同一个正式 D1 数据库，不想测试分支污染正式数据的话，建议在项目设置里关掉预览部署。

### 优缺点盘点

**讨喜的地方**

- 自带 `pages.dev` 域名，国内直连的可用性普遍比 `workers.dev` 强；
- 底层和 Workers 共用同一个 D1 数据库，哪天想切回 Workers 随时能切；
- 顺手白嫖 Pages 的 Git 分支预览等生态能力。

**需要接受的妥协**

- advanced mode 会接管**所有**请求，连 HTML、JS、CSS、字体这些静态文件也会算进每天 10 万次的请求额度里（打开一次页面大概消耗 15–20 次请求，折合每天能打开五千次左右，个人用依然绰绰有余，但不如 Workers 版划算）；
- D1 容量、10ms CPU、0.5MB 附件、1.9MB 单会话等限制和 Workers 版一模一样；
- 绑定和变量全配在网页控制台里，不随代码进 Git，哪天删项重建得手动重配一遍；
- 以后如果有新增的数据库迁移脚本，Pages 构建时不会自动跑，得自己手动执行一次 SQL。

---

## 三、本地容器（Docker Compose）

如果你有自己的云服务器、VPS 或家里常开的 NAS，直接用 Docker Compose 跑是最痛快的：Nginx 负责吐静态资源，Node 进程负责登录、本地 SQLite 读写和 API 代理。完全挣脱第三方额度束缚，图片上限放宽到 64MB、其他文件 32MB、单条会话 32MB。

### 快速跑起来

只要机器上装好 Docker 和 Docker Compose 就行：

```sh
git clone https://github.com/potatoshred/chat-demo.git
cd chat-demo
cp .env.example .env
chmod 600 .env
```

打开 `.env` 填好你自己的账号密码和 Key：

```dotenv
AUTH_USERNAME=admin
AUTH_PASSWORD='replace-with-your-own-long-password'
DEEPSEEK_API_KEY=sk-your-deepseek-api-key
DEEPSEEK_API_BASE_URL=https://api.deepseek.com
```

构建并后台启动：

```sh
docker compose up -d --build
docker compose ps
```

本机直接浏览器打开 <http://localhost:8090> 就能登录。出于安全考虑，容器默认只监听宿主机的 `127.0.0.1:8090` 回环地址；如果你装在远程服务器上，想先临时连上去看看，可以在本地开一条 SSH 隧道：

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

密码里如果包含 `$`、`#` 等特殊字符，记得用单引号包起来。每次修改 `.env` 后要运行 `docker compose up -d --no-build` 让新变量生效（单纯 `docker compose restart` 不会重新加载环境变量）。改密码会让当前所有已登录会话立刻失效，原有聊天记录不受影响。

### 配域名与 HTTPS

正式对外访问时，把域名解析到你的服务器，在宿主机已有的 Nginx / Caddy 等反向代理上配好 SSL 证书，再反代到 `http://127.0.0.1:8090`：

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

注意 `Host` 和 `X-Forwarded-Proto` 这两个头**必须原样传过去**：后端靠它们校验请求来源，并在识别到 HTTPS 时自动切换成更严格的 `Secure` + `__Host-` 前缀 Cookie。如果你的入口反代也跑在 Docker 容器里，可以把它们挂到同一个 Docker 网络下，直接反代到 `http://chat:8080`。

**不想开公网端口？可以用 Cloudflare Tunnel：**

1. 去 Cloudflare 控制台建一个 `cloudflared` 类型的 Tunnel，拿到 token；
2. 在 `.env` 里加上 `CLOUDFLARE_TUNNEL_TOKEN=...`；
3. 把 `compose.yaml` 里 `cloudflared` 那一段服务的注释取消掉；
4. 在控制台把 Tunnel 的公网域名指向容器内网地址 `http://chat:8080`；
5. 执行 `docker compose up -d --no-build`，再用 `docker compose logs --tail=50 cloudflared` 看看连接状态。

`compose.yaml` 里默认写死了 `--protocol http2`（走 TCP），专门照顾国内不少网络环境下 UDP 7844 端口被限流或封禁的情况；如果你的服务器 UDP 很通畅，可以删掉这个参数让它默认走 QUIC。

### 数据存哪、怎么备份与更新

- 所有聊天记录、附件、草稿和设置都装在命名卷 `chat_data` 挂载的 `/data/chat.sqlite` 里（实际 Docker 卷名会带上 Compose 项目名作前缀）。
- 平常想随手备个份，直接点网页设置里的「导出所有历史对话」就能把所有聊天和图片打包下载下来（非图片类的普通文件附件只保留元信息）。
- **做完整冷备**（连同 SQLite 的 WAL 日志一起完整归档，先停写再打包最稳妥）：

  ```sh
  mkdir -p backups
  docker compose stop auth
  docker compose run --rm -T --no-deps --entrypoint sh auth -c 'tar -C /data -czf - .' > backups/chat-data.tar.gz
  docker compose start auth
  ```

- **从冷备恢复**（建议恢复前先把当前数据也备一份，解压会直接覆盖同名文件）：

  ```sh
  docker compose stop auth
  docker compose run --rm -T --no-deps --entrypoint sh auth -c 'tar -C /data -xzf -' < backups/chat-data.tar.gz
  docker compose start auth
  ```

- **日常更新代码**：`git pull --ff-only && docker compose up -d --build`，重建容器会自动接着用原来的数据卷。
- **状态自检**：`curl --fail http://127.0.0.1:8090/healthz`，或者看日志 `docker compose logs --tail=50 chat auth`。

> 千万小心：`docker compose down -v` 里的 `-v` 会**连数据卷一起删得干干净净**！换服务器或改 Compose 项目目录名时，也记得先把卷里的数据导出来。

### 可选：构建镜像时需要走代理

如果服务器直连拉取 npm 包很慢，需要借宿主机的代理构建镜像，可以分两步单独 build 再启动：

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

这里的代理参数只在打包镜像那一刻生效；容器跑起来之后请求 DeepSeek API 还是走服务器本身的网络。

### 优缺点盘点

**讨喜的地方**

- 彻底告别第三方额度焦虑：图片 64MB、其他文件 32MB、单会话 32MB，每天想聊多少次都行；
- 数据实打实落在自己硬盘上，适合对隐私敏感或纯内网环境，冷备和迁移都很直接；
- 后台每 30 秒自动轮询 + 切回窗口同步，多端同时打开时同步最及时；设置页还能看最近 24 小时的详细请求日志；
- 登录使用标准的带盐 scrypt 哈希，并带有 5 分钟内最多试错 5 次的防爆破限制。

**需要接受的妥协**

- 得自己有一台服务器或 NAS，续费、配证书、做备份、升级系统都要亲力亲为；
- 单点部署，没有 Cloudflare 的全球边缘加速，机器一关机或断网服务就停了；
- 登录会话保存在服务端内存里，每次重启 `auth` 容器所有设备都要重新输一次密码；
- 传多了高清大图会实打实吃硬盘空间，得自己留心磁盘余量。

---

## 几种形态共通的使用细节

### 多设备同步与冲突处理

- **同步时机**：容器版每隔 30 秒以及切回浏览器标签页时都会自动检查更新（页面静置满 5 分钟或切到后台时会暂停轮询）；Workers 和 Pages 版为了省请求数，只在刚打开页面、切回标签页、以及每次 AI 回复生成完毕时同步。
- **边生成边存盘**：AI 正在流式输出时，前端会定期把已生成的部分落盘（容器版每 2 秒一次，边缘版每 10 秒一次），整条回复结束后再存一次最终版；输入框里的草稿在停笔约 400ms 后自动保存。
- **同时改同一条对话怎么办**：如果两台设备恰好同时修改了同一个会话或草稿，后提交但版本落后的那一方会收到 409 冲突提示。遇到这种情况先别急着关页面，把刚写好还没存上的字复制出来，刷新一下页面再粘回去提交即可。
- 刚发完消息或改完长文时，留意一眼保存状态，等落盘完成再关标签页；断网期间没来得及同步上去的内容可能会丢失。

### 导入与导出历史记录

- 在「设置 → 数据管理 → 导入历史」里可以直接上传从 DeepSeek 官方导出的历史 ZIP 包，支持**追加**和**替换**两种模式。
- **追加模式很省额度**：前端解压时会先比对本地已知的会话 ID，已经存在老对话会直接跳过，既不写暂存表也不重复上传附件，只把新增的对话挑出来上传。
- **事务式暂存**：无论哪种模式，导入的数据都会先写进服务端的暂存区，整包校验无误后才会一次性提交生效；中途哪怕断网失败，原有的聊天记录也毫发无损。被跳过的超大会话、超大附件或重复会话，结束后都会在弹窗里列出具体名称。
- 免费版（Workers / Pages）对单次导入的附件总大小设有 **100MB** 的保护上限（因为暂存表和正式表在提交瞬间各占一份），超出预算的附件会被跳过。

---

## 本地开发与调试

本地开发需要 Node.js 24 和 pnpm 12.6.0：

```sh
pnpm install --frozen-lockfile
pnpm dev
```

直接跑 `pnpm dev` 或在本地裸跑 `pnpm build` 时，构建出来的是**纯前端直连模式**：不需要启动任何后端，在网页设置里填上 API Key 就能直接请求 DeepSeek，聊天数据存在浏览器的 IndexedDB 里。想在本地联调完整的服务端登录与存储，请用上面的 Docker Compose 启动。

现在的 `pnpm build`（底层调用 `scripts/build.mjs`）会自动根据当前宿主环境的变量决定打哪一种包，构建日志第一行会明确打印 `[build] target=...`：

| 运行环境 | 触发条件 | 构建产物 |
| --- | --- | --- |
| Workers Builds | 检测到 `WORKERS_CI=1` | 服务端模式 + 免费额度参数 + `dist/_headers` |
| Cloudflare Pages | 检测到 `CF_PAGES` | 同上，并额外把 Worker 复制为 `dist/_worker.js` |
| Docker 构建 | `Dockerfile` 传入 `CHAT_SERVER_API=true` | 服务端模式 + 容器版宽松参数 |
| 本地终端 / GitHub Actions | 无上述环境变量 | 纯静态直连模式（数据存 IndexedDB） |

想在本地手动强制打出某一种产物，显式传变量或调快捷脚本即可：`pnpm cf:build`（打边缘版）、`CHAT_SERVER_API=true pnpm build`（打容器版）。

提交代码前可以跑一遍类型检查、Lint 和两套后端的单元测试：

```sh
pnpm type
pnpm lint
node --test deploy/auth/server.test.mjs      # 容器版后端测试
node --test cloudflare/worker.test.mjs      # Workers 版后端测试
```
