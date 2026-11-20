#!/usr/bin/env node
/**
 * 统一构建入口：按部署环境推断使用哪套开关。
 *
 * - Workers Builds 注入 WORKERS_CI=1，Pages 注入 CF_PAGES → 服务端 + EDGE
 * - Docker 显式传 CHAT_SERVER_API=true → 服务端，但保持容器版的附件/轮询参数
 * - 其他（本地、GitHub Actions）→ 纯静态，直连上游 API
 *
 * 显式传入 CHAT_SERVER_API / CHAT_EDGE 时以传入值为准，方便临时验证。
 */
import { spawnSync } from 'node:child_process'
import { copyFileSync, existsSync, rmSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const env = { ...process.env }

// CF_PAGES 在 Pages 构建里是 "1"；用存在性判断，避免值变化导致漏判。
const pages = env.CF_PAGES !== undefined && env.CF_PAGES !== ''
const workersCi = env.WORKERS_CI === '1'
const hosted = workersCi || pages

const server = env.CHAT_SERVER_API === 'true' || hosted
const edge = env.CHAT_EDGE === 'true' || hosted
const target = edge ? 'edge' : server ? 'container' : 'standalone'

const reason = hosted ? (pages ? ', CF_PAGES' : ', WORKERS_CI=1') : ''
console.log(`[build] target=${target}${reason}`)

env.NODE_ENV = 'production'
env.CHAT_SERVER_API = server ? 'true' : 'false'
env.CHAT_EDGE = edge ? 'true' : 'false'

const bin = path.join(root, 'node_modules', '.bin', process.platform === 'win32' ? 'rspack.cmd' : 'rspack')
const command = existsSync(bin) ? bin : 'rspack'

rmSync(path.join(root, 'dist'), { recursive: true, force: true })
const result = spawnSync(command, ['build', '-c', 'rspack.config.ts'], {
  cwd: root,
  env,
  stdio: 'inherit',
})
if (result.error) {
  console.error(`[build] 无法执行 ${command}：${result.error.message}`)
  process.exit(1)
}
if (result.status !== 0) {
  process.exit(result.status ?? 1)
}

// 边缘构建的响应头（index.html 不缓存、静态资源长缓存、CSP）。
if (edge) {
  copyFileSync(path.join(root, 'cloudflare', '_headers'), path.join(root, 'dist', '_headers'))
}

// Pages 项目没有 wrangler 的 assets 配置，需要 _worker.js 才能跑 /data 与 /api。
if (pages) {
  copyFileSync(path.join(root, 'cloudflare', 'worker.mjs'), path.join(root, 'dist', '_worker.js'))
  console.log('[build] Pages：已写入 dist/_worker.js')
}
