#!/usr/bin/env node
/**
 * Cloudflare 一键部署用的 deploy 脚本：
 * 1. 确保 D1 存在（没有就创建），并把真实 database_id 写回 wrangler.jsonc；
 * 2. 执行未应用的迁移；
 * 3. 部署 Worker。
 *
 * Deploy to Cloudflare 按钮/Workers Builds 会调用 `pnpm deploy`。占位 ID 不能直接用，
 * 而自动预置资源并非在所有流程里都会发生，所以这里自己兜底。
 */
import { execFileSync } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'

const configPath = 'wrangler.jsonc'
const wrangler = (...args) =>
  execFileSync('npx', ['--yes', 'wrangler@latest', ...args], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'inherit'],
  })

const parse = (output) => {
  try {
    const value = JSON.parse(output)
    return Array.isArray(value) ? value : (value?.result ?? value?.databases ?? [])
  } catch {
    return []
  }
}

const uuidOf = (value) =>
  value?.uuid ?? value?.database_id ?? value?.id ?? value?.database?.uuid ?? null

const config = readFileSync(configPath, 'utf8')
const databaseName = /"database_name"\s*:\s*"([^"]+)"/.exec(config)?.[1]
if (!databaseName) {
  throw new Error('wrangler.jsonc 里找不到 database_name')
}

const idPattern = /"database_id"\s*:\s*"([^"]*)"/
const current = idPattern.exec(config)?.[1] ?? ''
const placeholders = new Set(['', '00000000-0000-0000-0000-000000000000'])
const isUuid = (value) => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)

// 允许用构建变量直接指定，跳过 API（构建令牌可能没有 D1 权限）。
const override = process.env.D1_DATABASE_ID ?? ''
let databaseId = isUuid(current) && !placeholders.has(current) ? current : null
if (!databaseId && isUuid(override)) {
  databaseId = override
}

if (!databaseId) {
  let existing = null
  try {
    existing = parse(wrangler('d1', 'list', '--json')).find((db) => db?.name === databaseName)
  } catch {
    console.error('[deploy] 无法列出 D1（构建令牌可能缺少 D1 权限），尝试直接创建')
  }
  databaseId = existing ? uuidOf(existing) : null
  if (!databaseId) {
    console.log(`[deploy] 创建 D1 数据库 ${databaseName}`)
    // --update-config 让 wrangler 自己把 database_id 写回 wrangler.jsonc。
    const created = wrangler(
      'd1',
      'create',
      databaseName,
      '--update-config',
      '--binding',
      'DB',
      '--use-remote'
    )
    databaseId =
      idPattern.exec(readFileSync(configPath, 'utf8'))?.[1] ??
      /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i.exec(created)?.[0] ??
      null
  }
  if (!databaseId || placeholders.has(databaseId)) {
    throw new Error('无法获取 D1 database_id，请检查 Cloudflare API Token 权限')
  }
  const latest = readFileSync(configPath, 'utf8')
  if (idPattern.exec(latest)?.[1] !== databaseId) {
    writeFileSync(configPath, latest.replace(idPattern, `"database_id": "${databaseId}"`))
  }
  console.log(`[deploy] database_id = ${databaseId}`)
}

wrangler('d1', 'migrations', 'apply', 'DB', '--remote')
wrangler('deploy')
