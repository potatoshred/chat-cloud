# Cloudflare 部署操作指南

本指南根据原截图序列整理，示例仓库为 `potatoshred/chat-cloud`，D1 数据库名为 `deepseek-chat`。实际部署时请替换成自己的仓库名和数据库名。

![项目 README 首页与一键部署入口](image-1.png)

## 准备事项

- 一个 Cloudflare 账号（免费版无需信用卡）和一个可绑定的 GitHub 账号；
- 准备好登录密码（至少 14 位）与 DeepSeek API Key；
- 三条配置的作用：
  - `AUTH_USERNAME`：登录名，不敏感；
  - `AUTH_PASSWORD`：登录密码，必须作为 **Secret** 保存；
  - `DEEPSEEK_API_KEY`：DeepSeek API Key，必须作为 **Secret** 保存。

---

## 一、Workers 一键部署

### 1. 登录 Cloudflare

打开 README 顶部的 **Deploy to Cloudflare** 按钮，进入 Cloudflare 登录页，可用 GitHub、Google、Apple 或邮箱登录。

![Cloudflare 登录页](image.png)

### 2. 进入应用配置表单

登录后进入 **Set up your application**。表单会创建仓库并自动连接 Workers Builds，之后每次推送到生产分支都会触发部署。

![Set up your application 表单](image-3.png)

### 3. 选择 Git 账号

在 **Git account** 下拉框中选择已连接的账号；若列表为空，选择 **New GitHub connection** 或 **New GitLab connection** 新建连接。

![选择 Git 账号](image-2.png)

### 4. 填写项目名与数据库

- **Project name**：默认 `chat-cloud`。如果账号下已有同名仓库，表单会提示「已存在具有该名称的存储库」，改成其他名字（如 `chat-cloud-cf`）即可；
- **Select D1 database**：选择 **+ Create new**；
- **Name your D1 Database**：填 `deepseek-chat`，必须与 `wrangler.jsonc` 中的 `database_name` 一致；
- **Database location hint**：保持 **Automatic**；
- **Enable read replication**：保持关闭。

![项目名与 D1 配置](image-4.png)

### 5. 填写两个密钥

在表单的密钥区域填写：

- `AUTH_PASSWORD`：自己的登录密码；
- `DEEPSEEK_API_KEY`：DeepSeek API Key。

两项类型都要选 **Secret**，保存后值不再可见。

![填写 AUTH_PASSWORD 与 DEEPSEEK_API_KEY](image-5.png)

### 6. 确认命令与预览设置

表单下方会显示：

- `AUTH_USERNAME`：`admin`（来自 `wrangler.jsonc` 的 `vars`，无需在此修改）；
- **Build command**：`pnpm run build`；
- **Deploy command**：`pnpm run deploy`；
- **Preview command**：`npx wrangler preview`；
- **Enable Preview builds**：保持关闭；
- **Protect with Cloudflare Access**：保持关闭。

确认后点 **Deploy**。`pnpm run deploy` 会执行 `scripts/cloudflare-deploy.mjs`：自动建库（若不存在）、执行迁移、部署 Worker。

![确认构建与部署命令](image-6.png)

### 7. 等待仓库与构建完成

提交后先创建仓库，再执行构建。日志中应能看到 succeeds 的 build 记录。

![正在创建仓库](image-7.png)

![构建成功记录](image-8.png)

### 8. 启用 workers.dev 地址

构建完成后，Overview 中默认可能显示 **No URLs enabled**，且 Domains 为 0。进入 **Domains** 标签，打开 Production 与 Preview 的 `workers.dev` 开关。

![Overview 显示 URLs 未启用](image-9.png)

![Domains 标签中启用 workers.dev](image-10.png)

打开后页面右上角会出现 **Visit** 按钮，地址形如 `https://chat-cloud.<子域>.workers.dev`。

![workers.dev 已启用](image-11.png)

> `workers.dev` 在部分地区网络不可达。需要稳定访问时，请在同一个页面用 **Add Domain** 绑定托管在 Cloudflare 的自定义域名。

### 9. 登录并验证

打开 Worker 地址，用 `AUTH_USERNAME` 与 `AUTH_PASSWORD` 登录，确认可以发送消息。

首次导入历史时，弹窗会显示实时进度，包括已解析/已保存的会话数和附件数，以及读取与保存的累计耗时。

![导入历史时的进度弹窗](image-12.png)

> 导入期间请保持页面在前台。

---

## 二、Pages 部署（pages.dev）

Pages 需要单独创建项目；一键按钮不支持 Pages。推荐先用上一节部署 Workers，让 D1 和表结构就绪，再把 Pages 接到同一个数据库。

### 1. 创建应用

进入 **Workers & Pages**，点击 **Create application**。

![Workers & Pages 列表](image-13.png)

### 2. 进入 Pages 创建流程

在创建页底部点击 **Continue to Pages**。

![选择 Continue to Pages](image-14.png)

### 3. 导入 Git 仓库

选择 **Import an existing Git repository**。

![Pages 入门页](image-15.png)

### 4. 选择仓库

选择 `potatoshred/chat-cloud`（或你自己的仓库），点击 **Begin setup**。

![选择仓库](image-16.png)

### 5. 配置构建

- **Project name**：`chat-cloud`，下方会显示自动分配的 `chat-cloud-xxx.pages.dev`；
- **Production branch**：`main`；
- **Framework preset**：`None`；
- **Build command**：`pnpm build`；
- **Build output directory**：`dist`。

点击 **Save and Deploy**。Pages 会注入 `CF_PAGES`，构建脚本自动生成 `dist/_worker.js` 与 `_headers`。

![Pages 构建配置](image-17.png)

### 6. 等待部署完成

![正在构建和部署](image-18.png)

部署成功后页面给出 `pages.dev` 地址。

![部署成功](image-20.png)

### 7. 配置变量与密钥

进入 Pages 项目的 **Settings → Variables and secrets**，添加三项：

| 类型 | 名称 | 值 |
| --- | --- | --- |
| Secret | `AUTH_PASSWORD` | 自己的登录密码 |
| Secret | `DEEPSEEK_API_KEY` | 自己的 API Key |
| Text | `AUTH_USERNAME` | `admin`（或想要的用户名） |

Pages 不读取仓库里的 `wrangler.jsonc`，所以三项都必须在控制台添加。

![Variables and secrets 页面](image-21.png)

![添加 AUTH_PASSWORD Secret](image-23.png)

![添加 DEEPSEEK_API_KEY Secret](image-24.png)

![添加 AUTH_USERNAME 文本变量](image-31.png)

添加完成后应能看到三条配置，两个 Secret 显示为 `Value encrypted`。

![三条变量与密钥的最终状态](image-30.png)

### 8. 绑定 D1 数据库

在同一页面的 **Bindings** 区域点击 **Add**，选择 **D1 database**。

![添加资源绑定](image-26.png)

配置：

- **Variable name**：`DB`
- **D1 database**：`deepseek-chat`

![绑定 D1 数据库](image-27.png)

完成后 Bindings 中应出现 `DB → deepseek-chat`。

![D1 绑定结果](image-28.png)

### 9. 重新部署使配置生效

变量、密钥和绑定是在创建部署时写入的，修改后必须重新部署。进入 **Deployments**，在最近一次部署的 `...` 菜单中选择 **Retry deployment**。

![重新部署](image-22.png)

完成后打开 `https://<项目名>.pages.dev`，用上面配置的用户名和密码登录。

---

## 三、形态切换与清理

Workers 和 Pages 可以共用同一个 D1，切换期间两者能同时在线。建议日常只保留一个入口，避免两个页面同时编辑同一会话触发 409 冲突。

确认 Pages 正常后，可以在 **Workers & Pages** 列表中删除不再使用的 Worker。**删除 Worker 不会删除 D1 数据库**，数据仍可供 Pages 使用。

![从应用列表删除旧 Worker](image-29.png)

---

## 常见问题

| 现象 | 原因与处理 |
| --- | --- |
| 部署报 `10181`，提示 `database_id` 为 `0000...` | 部署命令不是 `pnpm run deploy`。改成该命令后重试，脚本会自动建库并写回 ID。 |
| 提示 `required secrets have not been set` | 两个 Secret 未添加或未重新部署。添加后点 **Retry deployment**。 |
| 出现两个 `AUTH_USERNAME` | 同名的变量与 Secret 冲突。Workers 用 `wrangler.jsonc` 的 `vars`，Pages 用控制台的 Text 变量，二者只留一个。 |
| 构建成功但打不开 | 检查 Workers 的 `workers.dev` 开关是否打开，或 Pages 是否已完成首次部署。 |
| 导入后搜不到 | 新版本的导入会在暂存阶段建立搜索索引；若仍搜不到，重新保存该会话一次。 |
| 额度用尽 | Cloudflare 免费额度是硬停，需等次日 UTC 零点重置。 |
