# 单用户登录与容器部署

本工作区基于 `deepseek-ai/chat-demo` 的
`5d5dd754ebc1948e977ddb880a9eb5aa25f37b4c`（2026-11-13，v0.1.1），
增加独立的账号密码登录页，适合自己使用。

## 设置账号并启动

在项目根目录执行。默认账号为 `admin`；密码在终端中交互输入，不会显示或进入命令历史。
需要 Python 3 和 Docker Compose。

```sh
python3 deploy/setup-auth.py --origin http://localhost:8090
docker compose up -d --build
docker compose ps
```

打开 <http://localhost:8090>，使用刚设置的账号密码登录，再在聊天设置中填写自己的 DeepSeek API Key。
密码至少 14 个字符，建议使用密码管理器生成。可以用 `--username yourname` 修改账号。
地址必须与浏览器地址栏的**协议、域名和端口**完全一致，且末尾不加 `/`。
例如使用 `http://localhost:8090` 配置后，不要改用 `http://127.0.0.1:8090` 登录。

配置保存在 `secrets/auth.json`，目录权限为 700、文件权限为 600，
已从 Git 和 Docker 构建上下文中排除。文件只包含账号、站点地址和密码哈希。
认证容器默认使用 UID/GID 1000；如果配置文件所属用户不同，按脚本提示设置
`AUTH_UID` 和 `AUTH_GID` 后启动 Compose。

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
聊天请求由访问者浏览器发出，不会自动经过服务器的代理。

## 本地或 SSH 隧道访问

Compose 只向主机回环地址开放 `127.0.0.1:8090`。
项目网络默认使用 `172.29.255.0/24`，以适应当前主机已耗尽的 Docker 默认地址池；
若与其他网络冲突，可用 `CHAT_SUBNET=其他空闲网段 docker compose up -d` 调整。
在远程服务器部署并通过 SSH 隧道使用时，站点地址仍可设置为 `http://localhost:8090`：

```sh
ssh -L 8090:127.0.0.1:8090 your-user@your-server
```

然后在自己的电脑打开 <http://localhost:8090>。HTTP 仅允许 `localhost` 或回环地址，
适用于本地访问或已加密的 SSH 隧道。

## 使用域名和 HTTPS

如果通过公网域名访问，先用实际域名设置账号：

```sh
python3 deploy/setup-auth.py --origin https://chat.example.com
```

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
    }
}
```

80 端口只用于证书验证和 HTTPS 跳转，确认 HTTPS 工作正常后配置 HSTS。
如果入口代理也在容器里，让它与 `chat` 加入同一个网络，代理到 `chat:8080`；
代理容器中的 `127.0.0.1` 指向它自身。
`auth` 服务不应发布主机端口或直接暴露到公网。

## 登录如何工作

```text
浏览器 → HTTPS 入口 → chat（Nginx）→ 受保护的静态页面
                         ↓ 每次请求验证
                     auth（Node.js）
                         ↓ 只读挂载
                   secrets/auth.json
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

这是一层单用户网站访问控制。聊天仍由浏览器直接调用 DeepSeek，
API Key 仍保存在浏览器 localStorage，聊天和附件仍保存在 IndexedDB。
退出登录会保留这些本地数据；已发送给 DeepSeek 的请求也不会因退出网站而自动撤回。
共享电脑上需要在应用里清除聊天和 API Key，或使用独立的浏览器配置/隐私窗口。
如需把 DeepSeek Key 完全移出浏览器，需要另外实现 API 后端代理。

## 修改密码或站点地址

```sh
python3 deploy/setup-auth.py --origin https://chat.example.com --username admin --force
docker compose restart auth
```

脚本会生成新的随机盐并原子替换配置，重启后原有登录全部失效。
密钥目录通过只读挂载提供给认证容器；修改配置不需要重新构建镜像。
不要提交或分享 `secrets/auth.json`。

## 检查与更新

```sh
curl --fail http://127.0.0.1:8090/healthz
docker compose logs --tail=50 chat auth
node --test deploy/auth/server.test.mjs
```

Nginx 和认证服务都以非 root 用户运行，使用只读文件系统、移除 Linux capabilities，
并设置 `no-new-privileges`。Node.js 24 用于构建和认证，pnpm 12.6.0 与上游 CI 一致。
运行镜像保留 MIT 许可证。生产环境可把基础镜像固定到经过验证的 digest，定期更新重建。

API 地址仍由 `rspack.config.ts` 在构建时确定，默认 `https://api.deepseek.com`；
`docker run -e` 不会改变已构建的前端。不要把 API Key 或登录密码放进构建参数或前端环境变量。
