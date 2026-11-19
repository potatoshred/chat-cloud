/**
 * Cloudflare 免费版（Workers + D1 + 静态资源）入口。
 *
 * 与 deploy/auth 保持同一套 /data 与 /api 协议，前端无需改协议即可切换：
 * - 无 R2：附件直接存 D1，单文件上限 2MB（D1 单行/BLOB 上限）；
 * - 无交互式事务：多写操作用 db.batch()；
 * - 免费版 10ms CPU：避免在请求路径里解析大 JSON，摘要用 SQL json_extract，搜索用写入时建立的索引。
 *
 * 未实现（相对 Node 版）：导入历史的全文索引重建、附件 >2MB、跨 isolate 的登录限速。
 */

const MiB = 1024 * 1024
const SESSION_TTL = 12 * 60 * 60
const LOGIN_CSRF_TTL = 10 * 60
// D1 单行/BLOB 上限 2,000,000 字节，留出 JSON 外壳余量。
const FILE_LIMIT = 1_900_000
const SESSION_LIMIT = 1_800_000
const USAGE_HOURS = 24
const USAGE_LIMIT = 200
const USAGE_STATUSES = ['done', 'stopped', 'error']
const SEARCH_KINDS = new Set(['search', 'deep_search', 'image_search', 'deep_image_search'])
const REASONING_EFFORTS = new Set(['low', 'high', 'max'])

class HttpError extends Error {
  constructor(status, message) {
    super(message)
    this.status = status
  }
}

const fail = (status, message) => {
  throw new HttpError(status, message)
}

const object = (value) => value !== null && typeof value === 'object' && !Array.isArray(value)
const validId = (value) =>
  typeof value === 'string' && value.length > 0 && value.length <= 512 && !/[\x00-\x1f]/.test(value)
const conflict = () => fail(409, '数据已在另一页面或设备上修改。请备份未保存内容，再刷新页面重试。')

const encoder = new TextEncoder()
const decoder = new TextDecoder()
const base64url = (bytes) => {
  let binary = ''
  for (const byte of new Uint8Array(bytes)) binary += String.fromCharCode(byte)
  return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '')
}

const hmacKey = (secret) =>
  crypto.subtle.importKey('raw', encoder.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, [
    'sign',
  ])

const sign = async (secret, purpose, value) =>
  base64url(await crypto.subtle.sign('HMAC', await hmacKey(secret), encoder.encode(`${purpose}:${value}`)))

/** 字符串常量时间比较：先各自 HMAC，再逐字节异或，避免长度不同直接短路。 */
const sameSecret = async (secret, left, right) =>
  timingSafeEqualText(await sign(secret, 'cmp', left), await sign(secret, 'cmp', right))

const timingSafeEqualText = (left, right) => {
  if (left.length !== right.length) return false
  let diff = 0
  for (let index = 0; index < left.length; index += 1) {
    diff |= left.charCodeAt(index) ^ right.charCodeAt(index)
  }
  return diff === 0
}

// 不额外要求 SESSION_SECRET：直接由登录口令派生签名密钥。
// 代价是改口令会让所有设备掉线；只要口令足够长，签名强度与单独密钥等价。
const secretOf = (env) => `session:${env.AUTH_PASSWORD}`

/** 会话 Cookie：exp 签名，无服务端状态，适合多 isolate。 */
const issueCookie = async (env, ttl = SESSION_TTL) => {
  const expires = Math.floor(Date.now() / 1000) + ttl
  return `${expires}.${await sign(secretOf(env), 'sess', expires)}`
}

const verifyCookie = async (env, value) => {
  const [expires, signature] = String(value ?? '').split('.')
  if (!expires || !signature || !/^\d+$/.test(expires)) return false
  if (Number(expires) * 1000 <= Date.now()) return false
  return timingSafeEqualText(await sign(secretOf(env), 'sess', expires), signature)
}

const cookieValue = (request, name) => {
  const header = request.headers.get('cookie') ?? ''
  for (const part of header.split(';')) {
    const [key, ...rest] = part.trim().split('=')
    if (key === name) return rest.join('=')
  }
  return ''
}

const json = (value, status = 200) =>
  new Response(JSON.stringify(value), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' },
  })

const html = (body, status = 200, headers = {}) =>
  new Response(body, {
    status,
    headers: {
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'no-store',
      'X-Frame-Options': 'DENY',
      'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'same-origin',
      ...headers,
    },
  })

const redirect = (location, headers = {}) =>
  new Response(null, { status: 303, headers: { Location: location, 'Cache-Control': 'no-store', ...headers } })

async function readBody(request, limit, { parseJson = true } = {}) {
  const length = Number(request.headers.get('content-length') ?? 0)
  if (length > limit) fail(413, '数据过大。')
  const buffer = await request.arrayBuffer()
  if (buffer.byteLength > limit) fail(413, '数据过大。')
  if (!parseJson) return buffer
  const type = (request.headers.get('content-type') ?? '').split(';')[0]
  if (type !== 'application/json') fail(415, '需要 JSON 请求。')
  try {
    return JSON.parse(decoder.decode(buffer))
  } catch {
    fail(400, 'JSON 格式无效。')
  }
}

const all = async (db, sql, ...args) => (await db.prepare(sql).bind(...args).all()).results
const first = (db, sql, ...args) => db.prepare(sql).bind(...args).first()
const run = (db, sql, ...args) => db.prepare(sql).bind(...args).run()

const getMeta = async (db, key) => (await first(db, 'SELECT value FROM meta WHERE key=?', key))?.value
const putMeta = (db, key, value) =>
  db.prepare('INSERT OR REPLACE INTO meta VALUES (?,?)').bind(key, String(value))
/** 版本号自增放在 SQL 里，避免“读-改-写”在并发请求间丢更新。 */
const bumpVersion = (db) =>
  db.prepare("UPDATE meta SET value = CAST(value AS INTEGER) + 1 WHERE key='version'").bind()
const bumpGeneration = (db) => putMeta(db, 'generation', crypto.randomUUID())

const stateOf = async (db) => ({
  generation: await getMeta(db, 'generation'),
  version: await getMeta(db, 'version'),
  sessions: (
    await all(
      db,
      `SELECT id, revision,
              COALESCE(json_extract(json,'$.title'), '') AS title,
              json_extract(json,'$.createdAt') AS createdAt,
              json_extract(json,'$.updatedAt') AS updatedAt
         FROM sessions`
    )
  ).map((row) => ({
    id: row.id,
    title: row.title ?? '',
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    revision: row.revision,
  })),
})

const checkGeneration = async (db, generation) => {
  if (generation !== (await getMeta(db, 'generation'))) conflict()
}

const checkRevision = (row, revision) => {
  if ((row?.revision ?? null) !== revision) conflict()
}

function validateSession(session, id) {
  if (
    !object(session) ||
    !validId(session.id) ||
    session.id !== id ||
    typeof session.title !== 'string' ||
    !Number.isFinite(session.createdAt) ||
    !Number.isFinite(session.updatedAt) ||
    !Array.isArray(session.messages)
  ) {
    fail(400, '会话格式无效。')
  }
  const ids = new Set()
  for (const message of session.messages) {
    if (
      !object(message) ||
      !validId(message.id) ||
      ids.has(message.id) ||
      !Number.isFinite(message.createdAt) ||
      !['user', 'assistant'].includes(message.role)
    ) {
      fail(400, '消息格式无效。')
    }
    ids.add(message.id)
    if (
      message.role === 'user' &&
      (typeof message.content !== 'string' ||
        !Array.isArray(message.files) ||
        message.files.some(
          (file) =>
            !object(file) ||
            !validId(file.id) ||
            typeof file.name !== 'string' ||
            typeof file.isImage !== 'boolean' ||
            typeof file.mimeType !== 'string' ||
            !Number.isFinite(file.size)
        ))
    ) {
      fail(400, '附件格式无效。')
    }
    if (
      message.role === 'assistant' &&
      (!Array.isArray(message.blocks) ||
        !['pending', 'streaming', 'done', 'stopped', 'error'].includes(message.status))
    ) {
      fail(400, '回答格式无效。')
    }
  }
  return session
}

// ---------- 搜索与用量：与 deploy/auth/data-store.mjs 同规则 ----------

const CITATION = /\s*\[citation:\d+\]/g
const cleanText = (text) => (typeof text === 'string' ? text.replace(CITATION, '') : '')

function extractSearchDocs(session) {
  const docs = []
  const title = typeof session.title === 'string' ? session.title : ''
  if (title.trim()) docs.push({ messageId: '', role: 'title', text: title })
  for (const message of Array.isArray(session.messages) ? session.messages : []) {
    if (!message || typeof message.id !== 'string') continue
    if (message.role === 'user') {
      const text = cleanText(message.content)
      if (text.trim()) docs.push({ messageId: message.id, role: 'user', text })
    } else if (message.role === 'assistant' && Array.isArray(message.blocks)) {
      const parts = []
      for (const block of message.blocks) {
        if (block?.type === 'text' && !block.isTemplate) {
          const text = cleanText(block.text)
          if (text.trim()) parts.push(text)
        }
      }
      if (parts.length) {
        docs.push({ messageId: message.id, role: 'assistant', text: parts.join('\n') })
      }
    }
  }
  return docs
}

const replaceSearchDocs = (db, id, session) => {
  const updatedAt = Number.isFinite(session.updatedAt) ? session.updatedAt : 0
  return [
    db.prepare('DELETE FROM search_docs WHERE session_id=?').bind(id),
    ...extractSearchDocs(session).map((doc) =>
      db
        .prepare('INSERT INTO search_docs VALUES (?,?,?,?,?)')
        .bind(id, doc.messageId, doc.role, doc.text, updatedAt)
    ),
  ]
}

const snippetOf = (text, query) => {
  const at = text.toLowerCase().indexOf(query.toLowerCase())
  if (at < 0) return null
  const radius = 40
  let start = Math.max(0, at - radius)
  let end = Math.min(text.length, at + query.length + radius)
  if (start > 0 && /[\uDC00-\uDFFF]/.test(text[start])) start -= 1
  if (end < text.length && /[\uDC00-\uDFFF]/.test(text[end])) end += 1
  return `${start > 0 ? '…' : ''}${text.slice(start, end)}${end < text.length ? '…' : ''}`
}

async function searchSessions(db, query) {
  if (!query) return { query, total: 0, truncated: false, hits: [] }
  const rows = await all(
    db,
    `SELECT d.session_id, d.message_id, d.role, d.text, d.updated_at,
            COALESCE(json_extract(s.json,'$.title'), '') AS title
       FROM search_docs d JOIN sessions s ON s.id = d.session_id
      WHERE instr(lower(d.text), lower(?)) > 0
      ORDER BY d.updated_at DESC
      LIMIT 200`,
    query
  )
  const hits = []
  for (const row of rows) {
    const snippet = snippetOf(row.text, query)
    if (snippet === null) continue
    hits.push({
      sessionId: row.session_id,
      sessionTitle: row.title ?? '',
      messageId: row.message_id || null,
      role: row.role,
      snippet,
      updatedAt: row.updated_at,
    })
  }
  return { query, total: hits.length, truncated: hits.length > 50, hits: hits.slice(0, 50) }
}

const tokenCount = (value) => (Number.isFinite(value) && value > 0 ? Math.round(value) : 0)
const millis = (value) => (Number.isFinite(value) && value >= 0 ? Math.round(value) : null)

async function usageReport(db) {
  const since = Date.now() - USAGE_HOURS * 3600_000
  const rows = await all(
    db,
    `SELECT s.id AS sessionId,
            COALESCE(json_extract(s.json,'$.title'), '') AS sessionTitle,
            json_extract(m.value,'$.id') AS messageId,
            json_extract(m.value,'$.createdAt') AS at,
            json_extract(m.value,'$.model') AS model,
            json_extract(m.value,'$.status') AS status,
            json_extract(m.value,'$.thinking') AS thinking,
            json_extract(m.value,'$.reasoningEffort') AS reasoningEffort,
            json_extract(m.value,'$.firstTokenMs') AS firstTokenMs,
            json_extract(m.value,'$.durationMs') AS durationMs,
            json_extract(m.value,'$.usage.input_tokens') AS inputTokens,
            json_extract(m.value,'$.usage.output_tokens') AS outputTokens,
            json_extract(m.value,'$.usage.cache_creation_input_tokens') AS cacheCreationTokens,
            json_extract(m.value,'$.usage.cache_read_input_tokens') AS cacheReadTokens,
            json_extract(m.value,'$.usage.server_tool_use.web_search_requests') AS webSearches,
            json_extract(m.value,'$.blocks') AS blocks
       FROM sessions s, json_each(s.json,'$.messages') m
      WHERE json_extract(m.value,'$.role')='assistant'
        AND json_extract(m.value,'$.usage') IS NOT NULL
        AND json_extract(m.value,'$.status') IN ('done','stopped','error')
        AND json_extract(m.value,'$.createdAt') >= ?`,
    since
  )
  const entries = []
  for (const row of rows) {
    let searches = tokenCount(row.webSearches)
    if (searches === 0) {
      try {
        const blocks = typeof row.blocks === 'string' ? JSON.parse(row.blocks) : []
        for (const block of Array.isArray(blocks) ? blocks : []) {
          if (block?.type === 'server_tool_use' && SEARCH_KINDS.has(block.kind)) searches += 1
        }
      } catch {
        // 旧数据里的 blocks 解析失败时按 0 次搜索处理。
      }
    }
    entries.push({
      sessionId: row.sessionId,
      sessionTitle: row.sessionTitle ?? '',
      messageId: row.messageId ?? '',
      at: row.at,
      model: row.model ?? null,
      status: row.status,
      inputTokens: tokenCount(row.inputTokens),
      outputTokens: tokenCount(row.outputTokens),
      cacheCreationTokens: tokenCount(row.cacheCreationTokens),
      cacheReadTokens: tokenCount(row.cacheReadTokens),
      searches,
      thinking: row.thinking === 1 || row.thinking === true,
      reasoningEffort: REASONING_EFFORTS.has(row.reasoningEffort) ? row.reasoningEffort : null,
      firstTokenMs: millis(row.firstTokenMs),
      durationMs: millis(row.durationMs),
    })
  }
  entries.sort((a, b) => b.at - a.at)
  const totals = {
    requests: entries.length,
    inputTokens: 0,
    outputTokens: 0,
    cacheCreationTokens: 0,
    cacheReadTokens: 0,
    searches: 0,
  }
  for (const entry of entries) {
    totals.inputTokens += entry.inputTokens
    totals.outputTokens += entry.outputTokens
    totals.cacheCreationTokens += entry.cacheCreationTokens
    totals.cacheReadTokens += entry.cacheReadTokens
    totals.searches += entry.searches
  }
  return { hours: USAGE_HOURS, since, totals, entries: entries.slice(0, USAGE_LIMIT), truncated: entries.length > USAGE_LIMIT }
}

// ---------- /data 路由 ----------

async function deleteSession(db, id) {
  const row = await first(db, 'SELECT json FROM sessions WHERE id=?', id)
  const candidates = new Set()
  if (row) {
    try {
      for (const message of JSON.parse(row.json).messages ?? []) {
        if (message.role === 'user') for (const file of message.files ?? []) candidates.add(file.id)
      }
    } catch {
      // 损坏的会话仍然可以删除。
    }
  }
  const draft = await first(db, 'SELECT json FROM drafts WHERE id=?', `session:${id}`)
  if (draft) {
    try {
      for (const file of JSON.parse(draft.json).attachments ?? []) candidates.add(file.id)
    } catch {
      // ignore
    }
  }
  const statements = [
    db.prepare('DELETE FROM sessions WHERE id=?').bind(id),
    db.prepare('DELETE FROM search_docs WHERE session_id=?').bind(id),
  ]
  if (draft) {
    statements.push(
      db
        .prepare('UPDATE drafts SET json=?, revision=? WHERE id=?')
        .bind('{"text":"","attachments":[]}', crypto.randomUUID(), `session:${id}`)
    )
  }
  await db.batch(statements)
  if (candidates.size > 0) {
    await db
      .prepare(
        `DELETE FROM files WHERE id IN (${[...candidates].map(() => '?').join(',')})
           AND id NOT IN (
             SELECT json_extract(f.value,'$.id')
               FROM sessions s, json_each(s.json,'$.messages') m, json_each(m.value,'$.files') f
              WHERE json_extract(m.value,'$.role')='user'
             UNION
             SELECT json_extract(f.value,'$.id')
               FROM drafts d, json_each(d.json,'$.attachments') f)`
      )
      .bind(...candidates)
      .run()
  }
  await db.batch([bumpVersion(db)])
}

async function handleData(request, env, url) {
  const db = env.DB
  const parts = url.pathname
    .slice('/data/'.length)
    .split('/')
    .map((part) => decodeURIComponent(part))
  const [kind, id, operation] = parts
  const method = request.method

  if (kind === 'state' && parts.length === 1) {
    if (method === 'GET') return json(await stateOf(db))
    if (method === 'POST') {
      const input = await readBody(request, 2048)
      if (!object(input) || typeof input.since !== 'string') fail(400, '版本无效。')
      const version = await getMeta(db, 'version')
      const generation = await getMeta(db, 'generation')
      if (input.since === version && input.generation === generation) {
        return json({ unchanged: true, generation, version })
      }
      return json(await stateOf(db))
    }
  }

  if (kind === 'search' && parts.length === 1 && method === 'POST') {
    const input = await readBody(request, 4096)
    if (!object(input) || typeof input.query !== 'string') fail(400, '搜索关键词无效。')
    return json(await searchSessions(db, input.query.trim()))
  }

  if (kind === 'usage' && parts.length === 1 && method === 'GET') {
    return json(await usageReport(db))
  }

  if (kind === 'sessions' && parts.length === 2 && validId(id)) {
    if (method === 'GET') {
      const row = await first(db, 'SELECT json, revision FROM sessions WHERE id=?', id)
      if (!row) return json(null, 404)
      return json({
        session: JSON.parse(row.json),
        revision: row.revision,
        generation: await getMeta(db, 'generation'),
      })
    }
    const input = await readBody(request, SESSION_LIMIT)
    if (!object(input)) fail(400, '请求格式无效。')
    await checkGeneration(db, input.generation)
    const row = await first(db, 'SELECT json, revision FROM sessions WHERE id=?', id)
    checkRevision(row, input.revision)

    if (method === 'DELETE') {
      await deleteSession(db, id)
      return json({ ok: true })
    }
    if (method !== 'PUT' && method !== 'PATCH') fail(405, '方法不支持。')

    let session
    if (method === 'PATCH') {
      if (!row) conflict()
      session = { ...JSON.parse(row.json), title: input.title }
    } else {
      session = input.session
    }
    validateSession(session, id)
    const body = JSON.stringify(session)
    if (body.length > SESSION_LIMIT) fail(413, '会话过大：单个会话上限约 1.8MB。')
    const revision = crypto.randomUUID()
    const statements = [db.prepare('INSERT OR REPLACE INTO sessions VALUES (?,?,?)').bind(id, body, revision)]
    if (method === 'PATCH') {
      // 改名只动标题文档，避免整会话重建索引。
      statements.push(db.prepare("DELETE FROM search_docs WHERE session_id=? AND role='title'").bind(id))
      if (session.title.trim()) {
        statements.push(
          db
            .prepare('INSERT INTO search_docs VALUES (?,?,?,?,?)')
            .bind(id, '', 'title', session.title, session.updatedAt ?? 0)
        )
      }
    } else if (!session.messages.some((m) => m.role === 'assistant' && (m.status === 'pending' || m.status === 'streaming'))) {
      // 流式过程中每 10 秒就要保存一次；全量重建索引会把 D1 写额度瞬间打满。
      statements.push(...replaceSearchDocs(db, id, session))
    }
    statements.push(bumpVersion(db))
    await db.batch(statements)
    return json({ revision, generation: await getMeta(db, 'generation') })
  }

  if (kind === 'files' && parts.length === 2 && validId(id)) {
    if (method === 'GET') {
      const row = await first(db, 'SELECT mime, bytes FROM files WHERE id=?', id)
      if (!row) fail(404, '附件不存在。')
      return new Response(row.bytes, {
        headers: {
          'Content-Type': row.mime || 'application/octet-stream',
          'Content-Disposition': 'attachment',
          'Cache-Control': 'no-store',
        },
      })
    }
    if (method === 'PUT') {
      await checkGeneration(db, request.headers.get('x-chat-generation'))
      const bytes = await readBody(request, FILE_LIMIT, { parseJson: false })
      await run(
        db,
        'INSERT OR IGNORE INTO files VALUES (?,?,?)',
        id,
        request.headers.get('content-type') || '',
        bytes
      )
      return json({ ok: true })
    }
  }

  if (kind === 'settings' && parts.length === 1) {
    if (method === 'GET') return json(await readSettings(db))
    if (method === 'PATCH') {
      const input = await readBody(request, 8192)
      const validators = {
        locale: (value) => ['zh-CN', 'en-US'].includes(value),
        themePreference: (value) => ['system', 'dark', 'light'].includes(value),
        ttsVoice: (value) => ['stella', 'tide'].includes(value),
        location: (value) =>
          value === null || (object(value) && typeof value.region === 'string' && /^[A-Z]{2}$/.test(value.region)),
        thinking: (value) => typeof value === 'boolean',
        reasoningEffort: (value) => ['low', 'high', 'max'].includes(value),
        model: (value) => typeof value === 'string' && value.length > 0 && value.length <= 256,
        search: (value) => typeof value === 'boolean',
        siderCollapsed: (value) => typeof value === 'boolean',
      }
      if (
        !object(input) ||
        Object.entries(input).some(
          ([key, value]) => !Object.hasOwn(validators, key) || !validators[key](value)
        )
      ) {
        fail(400, '设置格式无效。')
      }
      const updates = Object.entries(input).map(([key, value]) =>
        db.prepare('INSERT OR REPLACE INTO settings VALUES (?,?)').bind(key, JSON.stringify(value))
      )
      if (updates.length > 0) await db.batch(updates)
      return json(await readSettings(db))
    }
  }

  if (kind === 'drafts' && parts.length === 1 && method === 'GET') {
    const rows = await all(db, 'SELECT id, json, revision FROM drafts')
    return json({
      generation: await getMeta(db, 'generation'),
      drafts: rows.map((row) => ({ id: row.id, draft: JSON.parse(row.json), revision: row.revision })),
    })
  }

  if (kind === 'drafts' && parts.length === 2 && validId(id) && method === 'PUT') {
    const input = await readBody(request, 512 * 1024)
    if (!object(input)) fail(400, '请求格式无效。')
    await checkGeneration(db, input.generation)
    const previous = await first(db, 'SELECT json, revision FROM drafts WHERE id=?', id)
    checkRevision(previous, input.revision)
    if (id !== 'new') {
      if (!id.startsWith('session:')) conflict()
      if (!(await first(db, 'SELECT id FROM sessions WHERE id=?', id.slice(8)))) conflict()
    }
    if (
      !object(input.draft) ||
      typeof input.draft.text !== 'string' ||
      !Array.isArray(input.draft.attachments) ||
      input.draft.attachments.some(
        (file) =>
          !object(file) || !validId(file.id) || typeof file.name !== 'string' || typeof file.isImage !== 'boolean'
      )
    ) {
      fail(400, '草稿格式无效。')
    }
    const revision = crypto.randomUUID()
    await run(
      db,
      'INSERT OR REPLACE INTO drafts VALUES (?,?,?)',
      id,
      JSON.stringify(input.draft),
      revision
    )
    return json({ revision, generation: await getMeta(db, 'generation') })
  }

  if (kind === 'imports') return handleImports(request, db, parts, method)

  fail(404, '接口不存在。')
}

const readSettings = async (db) =>
  Object.fromEntries(
    (await all(db, 'SELECT key, json FROM settings')).map((row) => [row.key, JSON.parse(row.json)])
  )

const checkImport = async (db, id) => {
  const row = await first(db, 'SELECT version, expires FROM imports WHERE id=?', id)
  if (!row || row.expires <= Date.now()) fail(410, '导入暂存已过期，请重新导入。')
  return row
}

async function handleImports(request, db, parts, method) {
  const [, id, operation, entryId] = parts
  if (parts.length === 1 && method === 'POST') {
    await run(db, 'DELETE FROM imports WHERE expires<=?', Date.now())
    const count = await first(db, 'SELECT COUNT(*) AS n FROM imports')
    if (count.n >= 8) fail(429, '导入任务过多，请稍后重试。')
    const created = crypto.randomUUID()
    await run(db, 'INSERT INTO imports VALUES (?,?,?)', created, await getMeta(db, 'version'), Date.now() + 24 * 3600_000)
    return json({ id: created })
  }
  if (!validId(id)) fail(400, '导入标识无效。')
  if (parts.length === 2 && method === 'DELETE') {
    await db.batch([
      db.prepare('DELETE FROM staged_sessions WHERE owner=?').bind(id),
      db.prepare('DELETE FROM staged_files WHERE owner=?').bind(id),
      db.prepare('DELETE FROM staged_docs WHERE owner=?').bind(id),
      db.prepare('DELETE FROM imports WHERE id=?').bind(id),
    ])
    return json({ ok: true })
  }
  const staging = await checkImport(db, id)

  if (parts.length === 3 && operation === 'commit' && method === 'POST') {
    const type = (request.headers.get('content-type') ?? '').split(';')[0]
    const input = type === 'application/json' ? await readBody(request, 4096) : {}
    const mode = object(input) && input.mode !== undefined ? input.mode : 'replace'
    if (mode !== 'append' && mode !== 'replace') fail(400, '导入模式无效。')
    if (staging.version !== (await getMeta(db, 'version'))) conflict()

    const total = (await first(db, 'SELECT COUNT(*) AS n FROM staged_sessions WHERE owner=?', id)).n
    const skippedCount =
      mode === 'append'
        ? (
            await first(
              db,
              `SELECT COUNT(*) AS n FROM staged_sessions s
                WHERE s.owner=? AND EXISTS (SELECT 1 FROM sessions t WHERE t.id=s.id)`,
              id
            )
          ).n
        : 0
    const importedCount = total - skippedCount
    const statements = []

    if (mode === 'append') {
      // 先清掉“即将新增”的会话可能残留的文档，再把暂存索引复制过去；最后插入会话。
      statements.push(
        db
          .prepare(
            `DELETE FROM search_docs WHERE session_id IN (
               SELECT s.id FROM staged_sessions s
                WHERE s.owner=? AND NOT EXISTS (SELECT 1 FROM sessions t WHERE t.id=s.id))`
          )
          .bind(id),
        db
          .prepare(
            `INSERT OR REPLACE INTO search_docs (session_id,message_id,role,text,updated_at)
             SELECT d.session_id,d.message_id,d.role,d.text,d.updated_at
               FROM staged_docs d
              WHERE d.owner=? AND d.session_id IN (
                SELECT s.id FROM staged_sessions s
                 WHERE s.owner=? AND NOT EXISTS (SELECT 1 FROM sessions t WHERE t.id=s.id))`
          )
          .bind(id, id),
        db
          .prepare(
            `INSERT INTO sessions (id,json,revision)
             SELECT s.id,s.json,lower(hex(randomblob(16))) FROM staged_sessions s
              WHERE s.owner=? AND NOT EXISTS (SELECT 1 FROM sessions t WHERE t.id=s.id)`
          )
          .bind(id),
        db.prepare('INSERT OR IGNORE INTO files SELECT id,mime,bytes FROM staged_files WHERE owner=?').bind(id)
      )
    } else {
      // 一条 INSERT 里无法给每行生成不同 UUID：先写同一个哨兵值，再统一改写成随机 revision。
      const sentinel = `import-${crypto.randomUUID()}`
      statements.push(
        db.prepare('DELETE FROM sessions').bind(),
        db.prepare('DELETE FROM search_docs').bind(),
        db.prepare('DELETE FROM files').bind(),
        db.prepare('DELETE FROM drafts').bind(),
        db.prepare('INSERT INTO sessions SELECT id,json,? FROM staged_sessions WHERE owner=?').bind(sentinel, id),
        db.prepare('INSERT INTO files SELECT id,mime,bytes FROM staged_files WHERE owner=?').bind(id),
        db.prepare('UPDATE sessions SET revision=lower(hex(randomblob(16))) WHERE revision=?').bind(sentinel),
        db.prepare('INSERT INTO search_docs SELECT session_id,message_id,role,text,updated_at FROM staged_docs WHERE owner=?').bind(id)
      )
    }
    statements.push(
      db.prepare('DELETE FROM staged_sessions WHERE owner=?').bind(id),
      db.prepare('DELETE FROM staged_files WHERE owner=?').bind(id),
      db.prepare('DELETE FROM staged_docs WHERE owner=?').bind(id),
      db.prepare('DELETE FROM imports WHERE id=?').bind(id),
      bumpVersion(db),
      bumpGeneration(db)
    )
    await db.batch(statements)
    return json({ ...(await stateOf(db)), importedCount, skippedCount })
  }

  if (parts.length === 3 && operation === 'types' && method === 'PATCH') {
    const types = await readBody(request, 256 * 1024)
    if (!object(types) || Object.values(types).some((value) => typeof value !== 'string')) {
      fail(400, '附件类型无效。')
    }
    const rows = await all(db, 'SELECT id, json FROM staged_sessions WHERE owner=?', id)
    const statements = []
    for (const row of rows) {
      const session = JSON.parse(row.json)
      for (const message of session.messages) {
        if (message.role !== 'user') continue
        for (const file of message.files) {
          file.mimeType = Object.hasOwn(types, file.id) ? types[file.id] : ''
        }
      }
      statements.push(
        db.prepare('UPDATE staged_sessions SET json=? WHERE owner=? AND id=?').bind(JSON.stringify(session), id, row.id)
      )
    }
    if (statements.length > 0) await db.batch(statements)
    return json({ ok: true })
  }

  if (parts.length === 3 && operation === 'sessions' && method === 'PUT') {
    const sessions = await readBody(request, 1024 * 1024)
    if (!Array.isArray(sessions)) fail(400, '请求格式无效。')
    const statements = []
    for (const session of sessions) {
      validateSession(session, session?.id)
      statements.push(
        db.prepare('INSERT OR REPLACE INTO staged_sessions VALUES (?,?,?)').bind(id, session.id, JSON.stringify(session)),
        db.prepare('DELETE FROM staged_docs WHERE owner=? AND session_id=?').bind(id, session.id)
      )
      const updatedAt = Number.isFinite(session.updatedAt) ? session.updatedAt : 0
      for (const doc of extractSearchDocs(session)) {
        statements.push(
          db
            .prepare('INSERT INTO staged_docs VALUES (?,?,?,?,?,?)')
            .bind(id, session.id, doc.messageId, doc.role, doc.text, updatedAt)
        )
      }
    }
    if (statements.length > 0) await db.batch(statements)
    return json({ ok: true })
  }

  if (parts.length === 4 && validId(entryId) && method === 'PUT') {
    if (operation === 'sessions') {
      const session = validateSession(await readBody(request, SESSION_LIMIT), entryId)
      const updatedAt = Number.isFinite(session.updatedAt) ? session.updatedAt : 0
      await db.batch([
        db.prepare('INSERT OR REPLACE INTO staged_sessions VALUES (?,?,?)').bind(id, entryId, JSON.stringify(session)),
        db.prepare('DELETE FROM staged_docs WHERE owner=? AND session_id=?').bind(id, entryId),
        ...extractSearchDocs(session).map((doc) =>
          db
            .prepare('INSERT INTO staged_docs VALUES (?,?,?,?,?,?)')
            .bind(id, entryId, doc.messageId, doc.role, doc.text, updatedAt)
        ),
      ])
      return json({ ok: true })
    }
    if (operation === 'files') {
      const bytes = await readBody(request, FILE_LIMIT, { parseJson: false })
      await run(
        db,
        'INSERT OR REPLACE INTO staged_files VALUES (?,?,?,?)',
        id,
        entryId,
        request.headers.get('content-type') || '',
        bytes
      )
      return json({ ok: true })
    }
  }
  fail(404, '接口不存在。')
}

// ---------- /api 代理 ----------

const API_ROUTES = new Map([
  ['/models', 'GET'],
  ['/user/balance', 'GET'],
  ['/anthropic/v1/messages', 'POST'],
  ['/anthropic/v1/files', 'POST'],
  ['/v1/tools/asr', 'POST'],
  ['/v1/tools/tts', 'POST'],
])
const FILE_PATH = /^\/anthropic\/v1\/files\/[A-Za-z0-9_-]{1,256}$/

async function handleApi(request, env, url) {
  const path = url.pathname.slice('/api'.length)
  const allowed = API_ROUTES.get(path) === request.method || (request.method === 'DELETE' && FILE_PATH.test(path))
  if (!allowed) fail(404, 'API endpoint not found')

  const base = new URL(env.DEEPSEEK_API_BASE_URL || 'https://api.deepseek.com')
  base.pathname = base.pathname.replace(/\/$/, '') + path
  const headers = new Headers({ 'accept-encoding': 'identity' })
  for (const name of ['content-type', 'accept', 'anthropic-beta', 'anthropic-version']) {
    const value = request.headers.get(name)
    if (value) headers.set(name, value)
  }
  if (path.startsWith('/anthropic/')) headers.set('x-api-key', env.DEEPSEEK_API_KEY)
  else headers.set('authorization', `Bearer ${env.DEEPSEEK_API_KEY}`)

  const streaming = request.method !== 'GET' && request.method !== 'HEAD'
  const upstream = await fetch(base, {
    method: request.method,
    headers,
    body: streaming ? request.body : undefined,
    // Node 的 undici 要求流式请求体显式声明；Workers 运行时会忽略这个字段。
    ...(streaming ? { duplex: 'half' } : {}),
  })
  const outgoing = new Headers()
  for (const name of ['content-type', 'content-encoding', 'retry-after']) {
    const value = upstream.headers.get(name)
    if (value) outgoing.set(name, value)
  }
  outgoing.set('Cache-Control', 'no-store')
  return new Response(upstream.body, { status: upstream.status, headers: outgoing })
}

// ---------- 登录 ----------

const loginPage = (csrf, message = '') => html(`<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>登录 · DeepSeek 聊天</title>
<style>
  :root { color-scheme: light dark; }
  body { margin:0; min-height:100vh; display:grid; place-items:center; background:#f6f7f9; color:#1b1d21;
         font:14px/1.6 -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", sans-serif; }
  form { width:min(360px, 90vw); padding:28px; border-radius:16px; background:#fff; box-shadow:0 12px 40px rgba(0,0,0,.08); }
  h1 { margin:0 0 18px; font-size:18px; }
  label { display:block; margin-bottom:12px; font-size:13px; color:#5b6472; }
  input { width:100%; box-sizing:border-box; margin-top:6px; padding:10px 12px; border:1px solid #d6dae1;
          border-radius:10px; font:inherit; background:transparent; color:inherit; }
  button { width:100%; margin-top:8px; padding:11px; border:0; border-radius:10px; background:#4666ff;
           color:#fff; font:inherit; font-weight:600; cursor:pointer; }
  .error { margin:0 0 12px; color:#c62929; font-size:13px; }
</style></head>
<body><form method="post" action="/login">
  <h1>登录 DeepSeek 聊天</h1>
  ${message ? `<p class="error">${message}</p>` : ''}
  <input type="hidden" name="csrf" value="${csrf}">
  <label>用户名<input name="username" autocomplete="username" required></label>
  <label>密码<input name="password" type="password" autocomplete="current-password" required></label>
  <button type="submit">登录</button>
</form></body></html>`)

const loginCsrf = async (env) => {
  const expires = Math.floor(Date.now() / 1000) + LOGIN_CSRF_TTL
  return `${expires}.${await sign(secretOf(env), 'csrf', expires)}`
}

const verifyCsrf = async (env, value) => {
  const [expires, signature] = String(value ?? '').split('.')
  if (!expires || !signature || Number(expires) * 1000 <= Date.now()) return false
  return timingSafeEqualText(await sign(secretOf(env), 'csrf', expires), signature)
}

// 失败次数按 isolate 记内存：免费版没有 KV/DO，只能做到尽力而为。
const attempts = new Map()

async function handleLogin(request, env, url) {
  if (request.method === 'GET') {
    if (await verifyCookie(env, cookieValue(request, 'chat_session'))) return redirect('/')
    return loginPage(await loginCsrf(env))
  }
  if (request.method !== 'POST') fail(405, '方法不支持。')
  const form = await request.formData()
  const key = request.headers.get('cf-connecting-ip') ?? 'unknown'
  const record = attempts.get(key)
  const now = Date.now()
  if (record && record.until > now) fail(429, '尝试次数过多，请稍后再试。')
  const csrf = form.get('csrf')
  if (!(await verifyCsrf(env, csrf))) return loginPage(await loginCsrf(env), '页面已过期，请重试。')
  const username = String(form.get('username') ?? '')
  const password = String(form.get('password') ?? '')
  const ok =
    (await sameSecret(secretOf(env), `user:${username}`, `user:${env.AUTH_USERNAME}`)) &&
    (await sameSecret(secretOf(env), `pass:${password}`, `pass:${env.AUTH_PASSWORD}`))
  if (!ok) {
    const failures = (record?.failures ?? 0) + 1
    attempts.set(key, { failures, until: failures >= 5 ? now + 5 * 60_000 : 0 })
    return loginPage(await loginCsrf(env), '用户名或密码不正确。')
  }
  attempts.delete(key)
  return redirect('/', {
    'Set-Cookie': `chat_session=${await issueCookie(env)}; Path=/; HttpOnly; SameSite=Lax; Secure; Max-Age=${SESSION_TTL}`,
  })
}

const logout = () =>
  redirect('/login', {
    'Set-Cookie': 'chat_session=; Path=/; HttpOnly; SameSite=Lax; Secure; Max-Age=0',
  })

// ---------- 入口 ----------

const needsAuth = (path) =>
  path.startsWith('/data/') || path.startsWith('/api/')

export default {
  async fetch(request, env) {
    const url = new URL(request.url)
    try {
      if (url.pathname === '/login') return await handleLogin(request, env, url)
      if (url.pathname === '/logout') return logout()
      if (url.pathname === '/auth/session') {
        if (!(await verifyCookie(env, cookieValue(request, 'chat_session')))) {
          return json({ error: { message: '未登录' } }, 401)
        }
        return json({ ok: true })
      }
      if (needsAuth(url.pathname)) {
        if (!(await verifyCookie(env, cookieValue(request, 'chat_session')))) {
          return json({ error: { message: '未登录' } }, 401)
        }
        if (url.pathname.startsWith('/data/')) {
          if (request.headers.get('x-chat-request') !== '1') fail(403, '缺少请求标记。')
          const origin = request.headers.get('origin')
          if (request.method !== 'GET' && origin && origin !== url.origin) fail(403, '跨域请求被拒绝。')
        }
        if (url.pathname.startsWith('/api/')) return await handleApi(request, env, url)
        return await handleData(request, env, url)
      }
      if (env.ASSETS) return env.ASSETS.fetch(request)
      return new Response('Not found', { status: 404 })
    } catch (error) {
      if (error instanceof HttpError) return json({ error: { message: error.message } }, error.status)
      console.error(error)
      return json({ error: { message: '服务器内部错误' } }, 500)
    }
  },
}
