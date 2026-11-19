import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { after, test } from 'node:test'
import { createD1, migrate } from './dev/d1.mjs'
import worker from './worker.mjs'

const PASSWORD = 'correct-horse-battery'
const setCookieOf = (response) => (response.headers.get('set-cookie') ?? '').split(';')[0]

const makeEnv = (db, extra = {}) => ({
  DB: db,
  AUTH_USERNAME: 'admin',
  AUTH_PASSWORD: PASSWORD,
  SESSION_SECRET: 'test-secret',
  DEEPSEEK_API_KEY: 'server-key',
  ASSETS: { fetch: async () => new Response('asset') },
  ...extra,
})

const call = (env, path, { method = 'GET', body, cookie, headers = {} } = {}) => {
  const init = { method, headers: { ...headers } }
  if (body !== undefined) {
    if (body instanceof Uint8Array || body instanceof ArrayBuffer || body instanceof Blob) {
      init.body = body
    } else if (typeof body === 'string') {
      init.body = body
    } else {
      init.body = JSON.stringify(body)
      init.headers['content-type'] ??= 'application/json'
    }
  }
  if (cookie) init.headers.cookie = cookie
  if (path.startsWith('/data/')) init.headers['x-chat-request'] = '1'
  if (method !== 'GET' && path.startsWith('/data/')) init.headers.origin = 'https://chat.example'
  return worker.fetch(new Request(`https://chat.example${path}`, init), env)
}

const login = async (env) => {
  const page = await call(env, '/login')
  assert.equal(page.status, 200)
  const csrf = /name="csrf" value="([^"]+)"/.exec(await page.text())?.[1]
  assert.ok(csrf)
  const response = await worker.fetch(
    new Request('https://chat.example/login', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ csrf, username: 'admin', password: PASSWORD }),
    }),
    env
  )
  assert.equal(response.status, 303)
  return setCookieOf(response)
}

const fixture = () => {
  const db = createD1()
  migrate(db)
  return { db, env: makeEnv(db) }
}

const sessionOf = (id, title = '测试会话') => ({
  id,
  title,
  createdAt: 1,
  updatedAt: 2,
  rootMessageId: 'u1',
  messages: [
    { id: 'u1', role: 'user', content: '你好世界', files: [], createdAt: 1, parentId: null, selectedChildId: 'a1' },
    {
      id: 'a1',
      role: 'assistant',
      parentId: 'u1',
      model: 'deepseek-flash',
      thinking: true,
      reasoningEffort: 'high',
      prefix: true,
      status: 'done',
      createdAt: Date.now(),
      firstTokenMs: 800,
      durationMs: 2400,
      blocks: [{ type: 'text', text: '回答内容' }],
      usage: {
        input_tokens: 10,
        output_tokens: 5,
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: 2,
      },
    },
  ],
})

test('login issues a cookie and /data requires it', async () => {
  const { env } = fixture()
  assert.equal((await call(env, '/data/state')).status, 401)
  assert.equal((await call(env, '/auth/session')).status, 401)

  const wrong = await worker.fetch(
    new Request('https://chat.example/login', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        csrf: /name="csrf" value="([^"]+)"/.exec(await (await call(env, '/login')).text())?.[1] ?? '',
        username: 'admin',
        password: 'wrong-password-here',
      }),
    }),
    env
  )
  assert.equal(wrong.status, 200)
  assert.match(await wrong.text(), /用户名或密码不正确/)

  const cookie = await login(env)
  assert.equal((await call(env, '/auth/session', { cookie })).status, 200)
  const state = await call(env, '/data/state', { cookie })
  assert.equal(state.status, 200)
  assert.deepEqual((await state.json()).sessions, [])
})

test('sessions round-trip with revision checks and state summaries', async () => {
  const { env } = fixture()
  const cookie = await login(env)
  const generation = (await (await call(env, '/data/state', { cookie })).json()).generation

  const created = await call(env, '/data/sessions/s1', {
    method: 'PUT',
    cookie,
    body: { generation, revision: null, session: sessionOf('s1') },
  })
  assert.equal(created.status, 200)
  const { revision } = await created.json()

  const state = await (await call(env, '/data/state', { cookie })).json()
  assert.equal(state.sessions.length, 1)
  assert.equal(state.sessions[0].title, '测试会话')
  assert.equal(state.sessions[0].revision, revision)

  const loaded = await (await call(env, '/data/sessions/s1', { cookie })).json()
  assert.equal(loaded.session.messages.length, 2)
  assert.equal(loaded.revision, revision)

  // 旧 revision 写入必须冲突。
  const stale = await call(env, '/data/sessions/s1', {
    method: 'PUT',
    cookie,
    body: { generation, revision: null, session: sessionOf('s1', '旧标题') },
  })
  assert.equal(stale.status, 409)

  const renamed = await call(env, '/data/sessions/s1', {
    method: 'PATCH',
    cookie,
    body: { generation, revision, title: '新标题' },
  })
  assert.equal(renamed.status, 200)
  const afterRename = await (await call(env, '/data/state', { cookie })).json()
  assert.equal(afterRename.sessions[0].title, '新标题')

  const removed = await call(env, '/data/sessions/s1', {
    method: 'DELETE',
    cookie,
    body: { generation, revision: (await renamed.json()).revision },
  })
  assert.equal(removed.status, 200)
  assert.equal((await call(env, '/data/sessions/s1', { cookie })).status, 404)
})

test('drafts, settings and files stay in sync', async () => {
  const { env } = fixture()
  const cookie = await login(env)
  const generation = (await (await call(env, '/data/state', { cookie })).json()).generation

  const saved = await call(env, '/data/drafts/new', {
    method: 'PUT',
    cookie,
    body: {
      generation,
      revision: null,
      draft: { text: '草稿', attachments: [{ id: 'f1', name: 'a.png', isImage: true }] },
    },
  })
  assert.equal(saved.status, 200)
  const drafts = await (await call(env, '/data/drafts', { cookie })).json()
  assert.equal(drafts.drafts[0].draft.text, '草稿')

  const settings = await call(env, '/data/settings', {
    method: 'PATCH',
    cookie,
    body: { thinking: true, reasoningEffort: 'max' },
  })
  assert.equal(settings.status, 200)
  assert.equal((await settings.json()).reasoningEffort, 'max')
  assert.equal(
    (
      await call(env, '/data/settings', { method: 'PATCH', cookie, body: { model: 42 } })
    ).status,
    400
  )

  const bytes = new Uint8Array(1024).fill(7)
  const uploaded = await call(env, '/data/files/f1', {
    method: 'PUT',
    cookie,
    headers: { 'content-type': 'image/png', 'x-chat-generation': generation },
    body: bytes,
  })
  assert.equal(uploaded.status, 200)
  const downloaded = await call(env, '/data/files/f1', { cookie })
  assert.equal(downloaded.status, 200)
  assert.equal(downloaded.headers.get('content-type'), 'image/png')
  assert.equal(new Uint8Array(await downloaded.arrayBuffer()).length, 1024)

  // D1 单行上限 2MB：超限直接 413，而不是写坏数据库。
  const tooBig = await call(env, '/data/files/f2', {
    method: 'PUT',
    cookie,
    headers: { 'content-type': 'application/octet-stream', 'x-chat-generation': generation },
    body: new Uint8Array(1_950_000),
  })
  assert.equal(tooBig.status, 413)
})

test('search and 24h usage read the written index', async () => {
  const { env } = fixture()
  const cookie = await login(env)
  const state = await (await call(env, '/data/state', { cookie })).json()

  await call(env, '/data/sessions/s1', {
    method: 'PUT',
    cookie,
    body: { generation: state.generation, revision: null, session: sessionOf('s1') },
  })

  const found = await (await call(env, '/data/search', { method: 'POST', cookie, body: { query: '你好' } })).json()
  assert.equal(found.total, 1)
  assert.equal(found.hits[0].sessionId, 's1')
  assert.match(found.hits[0].snippet, /你好世界/)

  const none = await (await call(env, '/data/search', { method: 'POST', cookie, body: { query: '不存在' } })).json()
  assert.equal(none.total, 0)

  const usage = await (await call(env, '/data/usage', { cookie })).json()
  assert.equal(usage.totals.requests, 1)
  assert.equal(usage.totals.inputTokens, 10)
  assert.equal(usage.totals.outputTokens, 5)
  assert.equal(usage.totals.cacheReadTokens, 2)
  assert.equal(usage.entries[0].reasoningEffort, 'high')
  assert.equal(usage.entries[0].firstTokenMs, 800)
})

test('import staging commits in append mode', async () => {
  const { env } = fixture()
  const cookie = await login(env)
  const state = await (await call(env, '/data/state', { cookie })).json()
  await call(env, '/data/sessions/s0', {
    method: 'PUT',
    cookie,
    body: { generation: state.generation, revision: null, session: sessionOf('s0', '已有会话') },
  })

  const created = await (await call(env, '/data/imports', { method: 'POST', cookie })).json()
  const staging = `/data/imports/${created.id}`
  assert.equal(
    (
      await call(env, `${staging}/sessions`, {
        method: 'PUT',
        cookie,
        body: [sessionOf('s1', '导入一'), sessionOf('s0', '重复')],
      })
    ).status,
    200
  )
  assert.equal(
    (await call(env, `${staging}/files/f9`, { method: 'PUT', cookie, headers: { 'content-type': 'image/png' }, body: new Uint8Array(8) })).status,
    200
  )
  assert.equal(
    (await call(env, `${staging}/types`, { method: 'PATCH', cookie, body: { f9: 'image/png' } })).status,
    200
  )
  const committed = await (await call(env, `${staging}/commit`, { method: 'POST', cookie, body: { mode: 'append' } })).json()
  assert.equal(committed.importedCount, 1)
  assert.equal(committed.skippedCount, 1)
  assert.equal(committed.sessions.length, 2)
  assert.equal((await call(env, '/data/files/f9', { cookie })).status, 200)
})

test('api proxy injects the server key and forwards requests', async (t) => {
  const received = []
  const upstream = createServer((request, response) => {
    const chunks = []
    request.on('data', (chunk) => chunks.push(chunk))
    request.on('end', () => {
      received.push({
        method: request.method,
        url: request.url,
        authorization: request.headers.authorization,
        apiKey: request.headers['x-api-key'],
        body: Buffer.concat(chunks).toString(),
      })
      response.writeHead(200, { 'Content-Type': 'application/json' })
      response.end(JSON.stringify({ ok: true }))
    })
  })
  await new Promise((resolve) => upstream.listen(0, '127.0.0.1', resolve))
  t.after(() => upstream.close())
  const { port } = upstream.address()

  const { db } = fixture()
  const env = makeEnv(db, { DEEPSEEK_API_BASE_URL: `http://127.0.0.1:${port}` })
  const cookie = await login(env)

  const balance = await call(env, '/api/user/balance', { cookie })
  assert.equal(balance.status, 200)
  assert.equal((await balance.json()).ok, true)
  assert.equal(received[0].method, 'GET')
  assert.equal(received[0].url, '/user/balance')
  assert.equal(received[0].authorization, 'Bearer server-key')

  const messages = await call(env, '/api/anthropic/v1/messages', {
    method: 'POST',
    cookie,
    body: { model: 'deepseek-flash' },
  })
  assert.equal(messages.status, 200)
  assert.equal(received[1].url, '/anthropic/v1/messages')
  assert.equal(received[1].apiKey, 'server-key')
  assert.equal(received[1].body, JSON.stringify({ model: 'deepseek-flash' }))

  assert.equal((await call(env, '/api/admin', { cookie })).status, 404)
})

after(() => {
  // node:sqlite 的内存库随进程结束释放。
})
