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
    {
      id: 'u1',
      role: 'user',
      content: '你好世界',
      files: [],
      createdAt: 1,
      parentId: null,
      selectedChildId: 'a1',
    },
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

/** 两个请求都完成预读后才执行批次，稳定覆盖版本校验到写入之间的窗口。 */
const synchronizeBatches = (db, count = 2) => {
  const batch = db.batch.bind(db)
  let release
  const ready = new Promise((resolve) => {
    release = resolve
  })
  db.batch = async (statements) => {
    count -= 1
    if (count === 0) {
      db.batch = batch
      release()
    }
    await ready
    return batch(statements)
  }
}

const beforeNextBatch = (db, run) => {
  const batch = db.batch.bind(db)
  db.batch = async (statements) => {
    db.batch = batch
    await run()
    return batch(statements)
  }
}

test('login issues a cookie and /data requires it', async () => {
  const { env } = fixture()
  assert.equal((await call(env, '/data/state')).status, 401)
  assert.equal((await call(env, '/auth/session')).status, 401)

  const wrong = await worker.fetch(
    new Request('https://chat.example/login', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        csrf:
          /name="csrf" value="([^"]+)"/.exec(await (await call(env, '/login')).text())?.[1] ?? '',
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

for (const existing of [false, true]) {
  test(`concurrent ${existing ? 'updates' : 'creates'} accept one session write and leave only its index`, async () => {
    const { db, env } = fixture()
    const cookie = await login(env)
    const { generation } = await (await call(env, '/data/state', { cookie })).json()
    const revision = existing
      ? (
          await (
            await call(env, '/data/sessions/s1', {
              method: 'PUT',
              cookie,
              body: { generation, revision: null, session: sessionOf('s1') },
            })
          ).json()
        ).revision
      : null
    const sessions = [sessionOf('s1', 'device-A'), sessionOf('s1', 'device-B')]
    synchronizeBatches(db)
    const responses = await Promise.all(
      sessions.map((session) =>
        call(env, '/data/sessions/s1', {
          method: 'PUT',
          cookie,
          body: { generation, revision, session },
        })
      )
    )
    assert.deepEqual(responses.map((response) => response.status).sort(), [200, 409])
    const winner = responses.findIndex((response) => response.status === 200)
    const saved = await (await call(env, '/data/sessions/s1', { cookie })).json()
    assert.equal(saved.session.title, sessions[winner].title)
    const rejectedTitle = sessions[1 - winner].title
    const search = await (
      await call(env, '/data/search', {
        method: 'POST',
        cookie,
        body: { query: rejectedTitle },
      })
    ).json()
    assert.equal(search.total, 0)
    assert.equal(
      (await (await call(env, '/data/state', { cookie })).json()).version,
      existing ? '2' : '1'
    )
    assert.equal(await db.prepare("SELECT value FROM meta WHERE key='conflict'").first(), null)
  })
}

test('concurrent draft writes accept only one revision', async () => {
  const { db, env } = fixture()
  const cookie = await login(env)
  const { generation } = await (await call(env, '/data/state', { cookie })).json()
  for (const revision of [null, 'current']) {
    const current =
      revision === null
        ? null
        : (await (await call(env, '/data/drafts', { cookie })).json()).drafts[0].revision
    synchronizeBatches(db)
    const responses = await Promise.all(
      ['draft-A', 'draft-B'].map((text) =>
        call(env, '/data/drafts/new', {
          method: 'PUT',
          cookie,
          body: { generation, revision: current, draft: { text, attachments: [] } },
        })
      )
    )
    assert.deepEqual(responses.map((response) => response.status).sort(), [200, 409])
    const winner = responses.findIndex((response) => response.status === 200)
    const saved = await (await call(env, '/data/drafts', { cookie })).json()
    assert.equal(saved.drafts[0].draft.text, ['draft-A', 'draft-B'][winner])
  }
})

test('delete rechecks the session revision inside its atomic batch', async () => {
  const { db, env } = fixture()
  const cookie = await login(env)
  const { generation } = await (await call(env, '/data/state', { cookie })).json()
  const version = await (
    await call(env, '/data/sessions/s1', {
      method: 'PUT',
      cookie,
      body: { generation, revision: null, session: sessionOf('s1') },
    })
  ).json()
  beforeNextBatch(db, async () => {
    assert.equal(
      (
        await call(env, '/data/sessions/s1', {
          method: 'PATCH',
          cookie,
          body: { ...version, title: 'concurrent rename' },
        })
      ).status,
      200
    )
  })
  const removed = await call(env, '/data/sessions/s1', { method: 'DELETE', cookie, body: version })
  assert.equal(removed.status, 409)
  const saved = await (await call(env, '/data/sessions/s1', { cookie })).json()
  assert.equal(saved.session.title, 'concurrent rename')
  assert.equal((await (await call(env, '/data/state', { cookie })).json()).version, '2')
})

test('a draft cannot be written after its owning session is deleted', async () => {
  const { db, env } = fixture()
  const cookie = await login(env)
  const { generation } = await (await call(env, '/data/state', { cookie })).json()
  const version = await (
    await call(env, '/data/sessions/s1', {
      method: 'PUT',
      cookie,
      body: { generation, revision: null, session: sessionOf('s1') },
    })
  ).json()
  beforeNextBatch(db, async () => {
    assert.equal(
      (await call(env, '/data/sessions/s1', { method: 'DELETE', cookie, body: version })).status,
      200
    )
  })
  const saved = await call(env, '/data/drafts/session%3As1', {
    method: 'PUT',
    cookie,
    body: { generation, revision: null, draft: { text: 'stale draft', attachments: [] } },
  })
  assert.equal(saved.status, 409)
  assert.deepEqual((await (await call(env, '/data/drafts', { cookie })).json()).drafts, [])
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
    (await call(env, '/data/settings', { method: 'PATCH', cookie, body: { model: 42 } })).status,
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

  const found = await (
    await call(env, '/data/search', { method: 'POST', cookie, body: { query: '你好' } })
  ).json()
  assert.equal(found.total, 1)
  assert.equal(found.hits[0].sessionId, 's1')
  assert.match(found.hits[0].snippet, /你好世界/)

  const none = await (
    await call(env, '/data/search', { method: 'POST', cookie, body: { query: '不存在' } })
  ).json()
  assert.equal(none.total, 0)

  const usage = await (await call(env, '/data/usage', { cookie })).json()
  assert.equal(usage.totals.requests, 1)
  assert.equal(usage.totals.inputTokens, 10)
  assert.equal(usage.totals.outputTokens, 5)
  assert.equal(usage.totals.cacheReadTokens, 2)
  assert.equal(usage.entries[0].reasoningEffort, 'high')
  assert.equal(usage.entries[0].firstTokenMs, 800)
})

test('streaming replies are indexed only once they finish', async () => {
  const { env } = fixture()
  const cookie = await login(env)
  const generation = (await (await call(env, '/data/state', { cookie })).json()).generation

  const streamingSession = sessionOf('s2', '流式会话')
  streamingSession.messages[1].status = 'streaming'
  await call(env, '/data/sessions/s2', {
    method: 'PUT',
    cookie,
    body: { generation, revision: null, session: streamingSession },
  })
  const during = await (
    await call(env, '/data/search', { method: 'POST', cookie, body: { query: '回答内容' } })
  ).json()
  assert.equal(during.total, 0)

  const finished = await (await call(env, '/data/sessions/s2', { cookie })).json()
  streamingSession.messages[1].status = 'done'
  assert.equal(
    (
      await call(env, '/data/sessions/s2', {
        method: 'PUT',
        cookie,
        body: { generation, revision: finished.revision, session: streamingSession },
      })
    ).status,
    200
  )
  const afterDone = await (
    await call(env, '/data/search', { method: 'POST', cookie, body: { query: '回答内容' } })
  ).json()
  assert.equal(afterDone.total, 1)
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
    (
      await call(env, `${staging}/files/f9`, {
        method: 'PUT',
        cookie,
        headers: { 'content-type': 'image/png' },
        body: new Uint8Array(8),
      })
    ).status,
    200
  )
  assert.equal(
    (await call(env, `${staging}/types`, { method: 'PATCH', cookie, body: { f9: 'image/png' } }))
      .status,
    200
  )
  const committed = await (
    await call(env, `${staging}/commit`, { method: 'POST', cookie, body: { mode: 'append' } })
  ).json()
  assert.equal(committed.importedCount, 1)
  assert.equal(committed.skippedCount, 1)
  assert.equal(committed.sessions.length, 2)
  assert.equal((await call(env, '/data/files/f9', { cookie })).status, 200)

  // 导入的会话立刻可搜索，不需要再保存一次。
  const found = await (
    await call(env, '/data/search', { method: 'POST', cookie, body: { query: '你好' } })
  ).json()
  assert.equal(found.total, 2)
})

test('import commit rejects a session write made after its version precheck', async () => {
  const { db, env } = fixture()
  const cookie = await login(env)
  const { generation } = await (await call(env, '/data/state', { cookie })).json()
  const version = await (
    await call(env, '/data/sessions/old', {
      method: 'PUT',
      cookie,
      body: { generation, revision: null, session: sessionOf('old') },
    })
  ).json()
  const { id } = await (await call(env, '/data/imports', { method: 'POST', cookie })).json()
  await call(env, `/data/imports/${id}/sessions`, {
    method: 'PUT',
    cookie,
    body: [sessionOf('imported')],
  })
  beforeNextBatch(db, async () => {
    assert.equal(
      (
        await call(env, '/data/sessions/old', {
          method: 'PATCH',
          cookie,
          body: { ...version, title: 'keep concurrent edit' },
        })
      ).status,
      200
    )
  })
  const commit = await call(env, `/data/imports/${id}/commit`, {
    method: 'POST',
    cookie,
    body: { mode: 'replace' },
  })
  assert.equal(commit.status, 409)
  const state = await (await call(env, '/data/state', { cookie })).json()
  assert.equal(state.generation, generation)
  assert.equal(state.version, '2')
  assert.deepEqual(
    state.sessions.map((session) => session.title),
    ['keep concurrent edit']
  )
  assert.ok(await db.prepare('SELECT id FROM imports WHERE id=?').bind(id).first())
  assert.ok(await db.prepare('SELECT id FROM staged_sessions WHERE owner=?').bind(id).first())
})

for (const kind of ['session', 'file']) {
  test(`a ${kind} write cannot cross a concurrent history replacement`, async () => {
    const { db, env } = fixture()
    const cookie = await login(env)
    const { generation } = await (await call(env, '/data/state', { cookie })).json()
    const { id } = await (await call(env, '/data/imports', { method: 'POST', cookie })).json()
    await call(env, `/data/imports/${id}/sessions`, {
      method: 'PUT',
      cookie,
      body: [sessionOf('imported')],
    })
    beforeNextBatch(db, async () => {
      assert.equal(
        (
          await call(env, `/data/imports/${id}/commit`, {
            method: 'POST',
            cookie,
            body: { mode: 'replace' },
          })
        ).status,
        200
      )
    })
    const saved =
      kind === 'session'
        ? await call(env, '/data/sessions/stale', {
            method: 'PUT',
            cookie,
            body: { generation, revision: null, session: sessionOf('stale') },
          })
        : await call(env, '/data/files/stale', {
            method: 'PUT',
            cookie,
            headers: { 'x-chat-generation': generation },
            body: new Uint8Array([1]),
          })
    assert.equal(saved.status, 409)
    const state = await (await call(env, '/data/state', { cookie })).json()
    assert.deepEqual(
      state.sessions.map((session) => session.id),
      ['imported']
    )
    assert.equal(state.version, '1')
    assert.equal((await call(env, '/data/files/stale', { cookie })).status, 404)
  })
}

test('new imports collect expired and orphaned staging without removing active imports', async () => {
  const { db, env } = fixture()
  const cookie = await login(env)
  const tasks = []
  for (const name of ['expired', 'orphaned', 'active']) {
    const { id } = await (await call(env, '/data/imports', { method: 'POST', cookie })).json()
    tasks.push({ id, name })
    assert.equal(
      (
        await call(env, `/data/imports/${id}/sessions`, {
          method: 'PUT',
          cookie,
          body: [sessionOf(name)],
        })
      ).status,
      200
    )
    assert.equal(
      (
        await call(env, `/data/imports/${id}/files/${name}`, {
          method: 'PUT',
          cookie,
          body: new Uint8Array([1]),
        })
      ).status,
      200
    )
  }
  await db.prepare('UPDATE imports SET expires=0 WHERE id=?').bind(tasks[0].id).run()
  await db.prepare('DELETE FROM imports WHERE id=?').bind(tasks[1].id).run()
  assert.equal((await call(env, '/data/imports', { method: 'POST', cookie })).status, 200)
  for (const { id, name } of tasks) {
    for (const table of ['staged_sessions', 'staged_files', 'staged_docs']) {
      const count = (
        await db.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE owner=?`).bind(id).first()
      ).n
      assert.equal(count > 0, name === 'active')
    }
  }
  const commit = await call(env, `/data/imports/${tasks[2].id}/commit`, {
    method: 'POST',
    cookie,
    body: { mode: 'append' },
  })
  assert.equal(commit.status, 200)
  assert.equal((await commit.json()).importedCount, 1)
  assert.equal((await call(env, '/data/files/active', { cookie })).status, 200)
})

test('delete removes exclusive originals and keeps shared session and draft attachments', async () => {
  const { db, env } = fixture()
  const cookie = await login(env)
  const { generation } = await (await call(env, '/data/state', { cookie })).json()
  const files = Array.from({ length: 120 }, (_, index) => ({
    id: `f${index}`,
    name: `f${index}.png`,
    size: 1,
    isImage: true,
    mimeType: 'image/png',
  }))
  for (const id of [...files.map((file) => file.id), 'draft-only']) {
    await db
      .prepare('INSERT INTO files VALUES (?,?,?)')
      .bind(id, 'image/png', new Uint8Array([1]))
      .run()
  }
  const session = sessionOf('s1')
  session.messages = [0, 1, 2].map((index) => ({
    ...session.messages[0],
    id: `u${index}`,
    files: files.slice(index * 40, (index + 1) * 40),
  }))
  const version = await (
    await call(env, '/data/sessions/s1', {
      method: 'PUT',
      cookie,
      body: { generation, revision: null, session },
    })
  ).json()
  const shared = sessionOf('s2')
  shared.messages[0].files = [files[0]]
  await call(env, '/data/sessions/s2', {
    method: 'PUT',
    cookie,
    body: { generation, revision: null, session: shared },
  })
  await call(env, '/data/drafts/new', {
    method: 'PUT',
    cookie,
    body: { generation, revision: null, draft: { text: 'keep', attachments: [files[1]] } },
  })
  await call(env, '/data/drafts/session%3As1', {
    method: 'PUT',
    cookie,
    body: {
      generation,
      revision: null,
      draft: {
        text: 'delete',
        attachments: [{ id: 'draft-only', name: 'draft.png', isImage: true }],
      },
    },
  })
  assert.equal(
    (await call(env, '/data/sessions/s1', { method: 'DELETE', cookie, body: version })).status,
    200
  )
  assert.equal((await db.prepare('SELECT COUNT(*) AS n FROM files').first()).n, 2)
  assert.equal((await call(env, '/data/files/f0', { cookie })).status, 200)
  assert.equal((await call(env, '/data/files/f1', { cookie })).status, 200)
  assert.equal((await call(env, '/data/files/draft-only', { cookie })).status, 404)
  const drafts = await (await call(env, '/data/drafts', { cookie })).json()
  assert.deepEqual(drafts.drafts.find((draft) => draft.id === 'session:s1').draft, {
    text: '',
    attachments: [],
  })
})

test('types update only rewrites chats that carry attachments', async () => {
  const { env } = fixture()
  const cookie = await login(env)
  const created = await (await call(env, '/data/imports', { method: 'POST', cookie })).json()
  const staging = `/data/imports/${created.id}`
  const sessions = Array.from({ length: 12 }, (_, index) => sessionOf(`p${index}`, `批量 ${index}`))
  sessions[0].messages[0].files = [
    { id: 'img1', serverId: null, name: 'a.png', size: 10, isImage: true, mimeType: '' },
  ]
  assert.equal(
    (await call(env, `${staging}/sessions`, { method: 'PUT', cookie, body: sessions })).status,
    200
  )

  // 空映射直接返回，不扫暂存表。
  const empty = await call(env, `${staging}/types`, { method: 'PATCH', cookie, body: {} })
  assert.equal(empty.status, 200)
  assert.equal((await empty.json()).applied, 0)

  // 只有带附件的那一条会话需要重写 JSON。
  const updated = await call(env, `${staging}/types`, {
    method: 'PATCH',
    cookie,
    body: { img1: 'image/png' },
  })
  assert.equal(updated.status, 200)
  assert.equal((await updated.json()).applied, 1)

  await call(env, `${staging}/commit`, { method: 'POST', cookie, body: { mode: 'append' } })
  const session = await (await call(env, '/data/sessions/p0', { cookie })).json()
  assert.equal(session.session.messages[0].files[0].mimeType, 'image/png')
  const plain = await (await call(env, '/data/sessions/p1', { cookie })).json()
  assert.equal(plain.session.messages[0].files.length, 0)
})

test('replace import swaps data and rebuilds the search index', async () => {
  const { env } = fixture()
  const cookie = await login(env)
  const state = await (await call(env, '/data/state', { cookie })).json()
  await call(env, '/data/sessions/old', {
    method: 'PUT',
    cookie,
    body: { generation: state.generation, revision: null, session: sessionOf('old', '旧会话') },
  })

  const created = await (await call(env, '/data/imports', { method: 'POST', cookie })).json()
  const staging = `/data/imports/${created.id}`
  await call(env, `${staging}/sessions`, {
    method: 'PUT',
    cookie,
    body: [sessionOf('s9', '替换后')],
  })
  const committed = await (
    await call(env, `${staging}/commit`, { method: 'POST', cookie, body: { mode: 'replace' } })
  ).json()
  assert.equal(committed.importedCount, 1)
  assert.deepEqual(
    committed.sessions.map((session) => session.id),
    ['s9']
  )

  const found = await (
    await call(env, '/data/search', { method: 'POST', cookie, body: { query: '你好' } })
  ).json()
  assert.equal(found.total, 1)
  assert.equal(found.hits[0].sessionId, 's9')
})

test('state works even when meta rows are missing', async () => {
  const { db, env } = fixture()
  db.exec('DELETE FROM meta')
  const cookie = await login(env)
  const response = await call(env, '/data/state', { cookie })
  assert.equal(response.status, 200)
  const state = await response.json()
  assert.equal(typeof state.version, 'string')
  assert.equal(typeof state.generation, 'string')
})

test('missing tables report a migration hint', async () => {
  const db = createD1()
  const env = makeEnv(db)
  const cookie = await login(env)
  const response = await call(env, '/data/state', { cookie })
  assert.equal(response.status, 503)
  assert.match((await response.json()).error.message, /尚未初始化/)
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

test('api proxy does not send its key or follow redirects to another origin', async (t) => {
  let destinationCalls = 0
  const destination = createServer((_request, response) => {
    destinationCalls++
    response.end('unexpected destination')
  })
  await new Promise((resolve) => destination.listen(0, '127.0.0.1', resolve))
  const destinationUrl = `http://127.0.0.1:${destination.address().port}/capture`
  const upstream = createServer((request, response) => {
    request.resume()
    assert.equal(request.headers['x-api-key'], 'server-key')
    response.writeHead(303, { Location: destinationUrl, 'Content-Type': 'application/json' })
    response.end('{"redirect":true}')
  })
  await new Promise((resolve) => upstream.listen(0, '127.0.0.1', resolve))
  t.after(() => {
    upstream.closeAllConnections()
    destination.closeAllConnections()
    upstream.close()
    destination.close()
  })
  const { db } = fixture()
  const env = makeEnv(db, { DEEPSEEK_API_BASE_URL: `http://127.0.0.1:${upstream.address().port}` })
  const cookie = await login(env)
  const response = await call(env, '/api/anthropic/v1/messages', {
    method: 'POST',
    cookie,
    body: { model: 'test' },
  })
  assert.equal(response.status, 303)
  assert.equal(response.headers.get('location'), null)
  assert.deepEqual(await response.json(), { redirect: true })
  assert.equal(destinationCalls, 0)
})

after(() => {
  // node:sqlite 的内存库随进程结束释放。
})
