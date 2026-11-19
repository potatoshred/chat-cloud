# Cloudflare 免费版（Workers + D1）

`deploy/auth` 的纯免费移植：不用 R2、不用 Workers Paid、不用 Zero Trust（这三个都要绑卡）。
同一个 Worker 同时承担静态资源、`/data` 存储、`/api` 代理与登录。

## 与容器版的差异

| 项 | 容器版 | 这里 |
| --- | --- | --- |
| 数据库 | 本地 SQLite（同步） | D1（异步，`db.batch` 代替事务） |
| 附件 | 单文件 64MB | **单文件 ≤ 1.9MB**（D1 单行上限 2MB） |
| 登录 | scrypt（CPU 约 100ms） | HMAC 常量时间比较（免费版 10ms CPU 放不下 scrypt） |
| 会话状态 | 进程内 Map | 签名 Cookie（多 isolate 可用） |
| 搜索 | 全量扫描内存索引 | 写入时建 `search_docs` 表，查询用 `instr()` |
| 导入 | 12MB/批 | **0.5MB/批、3 条/批**；>1.9MB 的附件跳过 |
| 限额 | 无 | 10 万请求/天、10ms CPU、D1 500MB/库、10 万行写/天 |
| 同步 | 30 秒轮询 + 空闲暂停 | **不轮询**：只在打开、回到页面、回复结束后同步 |
| 用量 | 余额 + 24h 日志 | **只有余额**（24h 统计要扫全部消息，D1 读额度不划算） |

## 为什么不用 Pages

不需要 Pages。`wrangler.jsonc` 里是 `main` + `assets`，也就是「一个 Worker 顺带托管静态资源」：

- 根目录的 `wrangler.jsonc` 配了 `main`，`wrangler deploy` 会直接给出 `https://<worker>.<你的子域>.workers.dev`，HTTPS、Cookie、SPA 回退都能用；
- 只有 `/data/*`、`/api/*`、`/auth/*`、`/login`、`/logout` 会触发 Worker（`run_worker_first`），其余静态文件由边缘直接返回，不占 10 万次/天的 Worker 请求；
- Pages 的价值是 Git 集成和预览环境，这里用不上；以后要换自定义域名，只改 `routes`，代码不动。

注意：`workers.dev` 在部分网络（尤其中国大陆）可能不可达；需要稳定访问就把自己的域名挂到同一个 Worker 上（域名本身要在 Cloudflare 托管）。

## 一键部署按钮

Cloudflare 的 Deploy to Cloudflare 按钮会：把仓库克隆到你的 GitHub 账号 → 读取**根目录**的 `wrangler.jsonc` → 自动创建 D1 并回填 `database_id` → 用 Workers Builds 构建并部署。配置放在子目录时，Cloudflare 会把这个仓库当成「纯静态资源」，因而无法添加运行时变量和密钥。

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/potatoshred/chat-demo)

点击后的步骤：

1. 授权 GitHub，Cloudflare 把仓库复制到你自己的账号；
2. 确认 Worker 名称、D1 名称，按提示填 `AUTH_USERNAME`、`AUTH_PASSWORD`、`DEEPSEEK_API_KEY`（来自 `.dev.vars.example`）；
3. **把 Build command 改成 `pnpm cf:build`**（默认填入的 `pnpm build` 是静态版，不带 `CHAT_EDGE`）；
4. Deploy command 保持仓库里的 `deploy` 脚本：自动建表（`d1 migrations apply`）再部署。

之后每次 push 到 main，Workers Builds 会自动重新构建并部署；构建失败时线上保持上一个版本。

注意：按钮只认**默认分支**（`main`）。`cf:build` 还会把 `cloudflare/_headers` 复制进 `dist`，用来给 `index.html` 加 `no-store`、给带哈希的静态文件加长缓存。

## 部署

前置：Cloudflare 账号（免费版无需信用卡）、Node 20+。**命令在仓库根目录执行**（`wrangler.jsonc` 在根目录，Deploy 按钮也只读根目录配置）。

```sh
# 1. 建库，把输出的 database_id 填进根目录的 wrangler.jsonc
npx wrangler d1 create deepseek-chat

# 2. 建表
npx wrangler d1 execute deepseek-chat --remote --file=cloudflare/schema.sql

# 3. 构建前端（EDGE 开关会收紧附件上限与导入批次）
pnpm cf:build

# 4. 配置密钥
npx wrangler secret put AUTH_USERNAME
npx wrangler secret put AUTH_PASSWORD      # 至少 14 位；同时用于派生 Cookie 签名密钥
npx wrangler secret put DEEPSEEK_API_KEY

# 5. 发布
npx wrangler deploy
```

绑定自定义域名后，用 `wrangler.jsonc` 的 `routes` 配置；默认的 `*.workers.dev` 也能直接用。

## 已知限制

- **附件 ≤0.5MB**：超过 500KB 的 JPEG/PNG/WebP 会在浏览器里多轮压缩：每轮先降质量（0.9→0.75→0.6），仍超标就缩小尺寸再来一轮，直到 ≤500KB（实测 20MB 的 PNG 压到 419KB）。历史导入同样先压缩再入库，单次导入的附件总量预算 100MB（暂存 + 最终各一份），超出或无法压缩的才跳过并提示数量。
- **导入会建立搜索索引**：暂存阶段就抽好片段（`staged_docs`），提交时用 `INSERT ... SELECT` 复制，导入完成即可搜索。
- **流式期间不建索引**：只在回复结束（done/stopped/error）时重建，避免每 10 秒一次的全量索引写满 D1 写额度。
- **流式检查点 10 秒**：容器版是 2 秒；免费版为减少写入拉长到 10 秒，崩溃时最多丢 10 秒输出。
- **登录限速只在单个 isolate 内生效**：没有 KV/Durable Objects，尽力而为。
- **大会话可能 413**：单个会话 JSON 上限约 1.8MB；超长上下文需要拆表（后续工作）。
- **10ms CPU**：免费版对每请求的 CPU 有硬上限，历史规模很大时 `state`/搜索可能触发 1102；额度是硬停，不是限速。

## 本地测试

Worker 用 `node:sqlite` 写的 D1 替身跑单测，无需联网、无需 wrangler：

```sh
node --test cloudflare/worker.test.mjs
```
