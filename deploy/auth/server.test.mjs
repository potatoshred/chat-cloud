import assert from 'node:assert/strict'
import { once } from 'node:events'
import { scryptSync } from 'node:crypto'
import { createServer, request as httpRequest } from 'node:http'
import { test } from 'node:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createDataStore } from './data-store.mjs'
import { createAuthServer, loadAuthConfig, validateConfig } from './server.mjs'
import { createApiProxy, MAX_API_BODY } from './api-proxy.mjs'
import { PASSWORD_OPTIONS, verifyPassword } from './password.mjs'

const password = 'test-only-long-password-测试'
const salt = Buffer.alloc(32, 7)
const key = scryptSync(password, salt, 64, PASSWORD_OPTIONS)
const config = {
  origin: 'http://localhost:8090',
  username: 'admin',
  passwordHash: `scrypt$65536$8$2$${salt.toString('hex')}$${key.toString('hex')}`,
}

// Node fetch discards custom Host headers; use HTTP for reverse-proxy origin tests.
async function fetchWithHost(url, options) {
  const prepared = new Request(url, options)
  const payload = prepared.body ? Buffer.from(await prepared.arrayBuffer()) : undefined
  return new Promise((resolve, reject) => {
    const request = httpRequest(
      url,
      { method: prepared.method, headers: Object.fromEntries(prepared.headers) },
      async (response) => {
        try {
          const chunks = []
          for await (const chunk of response) chunks.push(chunk)
          const headers = new Headers()
          for (const [key, values] of Object.entries(response.headers))
            for (const value of Array.isArray(values) ? values : [values])
              if (value !== undefined) headers.append(key, value)
          resolve(
            new Response([204, 304].includes(response.statusCode) ? null : Buffer.concat(chunks), {
              status: response.statusCode,
              headers,
            })
          )
        } catch (error) {
          reject(error)
        }
      }
    )
    request.on('error', reject)
    request.end(payload)
  })
}

async function fixture(t, overrides = {}, options = {}) {
  let time = Date.now()
  const server = createAuthServer({ ...config, ...overrides }, { now: () => time, ...options })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  t.after(() => {
    server.closeAllConnections()
    server.close()
  })
  const base = `http://127.0.0.1:${server.address().port}`
  const jar = new Map()
  const request = async (path, options = {}) => {
    const send =
      overrides.origin === undefined && Object.hasOwn(overrides, 'origin') ? fetchWithHost : fetch
    const response = await send(base + path, {
      redirect: 'manual',
      ...options,
      headers: {
        ...(overrides.origin === undefined && Object.hasOwn(overrides, 'origin')
          ? { Host: 'localhost:8090' }
          : {}),
        Cookie: [...jar].map(([name, value]) => `${name}=${value}`).join('; '),
        ...options.headers,
      },
    })
    for (const value of response.headers.getSetCookie()) {
      const [name, content] = value.split(';')[0].split('=')
      if (content) jar.set(name, content)
      else jar.delete(name)
    }
    return response
  }
  const challenge = async () => {
    const response = await request('/login')
    assert.equal(response.status, 200)
    const body = await response.text()
    return body.match(/name="csrf" value="([A-Za-z0-9_-]+)"/)[1]
  }
  const login = async (
    submitted = password,
    headers = {},
    username = overrides.username ?? config.username
  ) => {
    const csrf = await challenge()
    return request('/auth/login', {
      method: 'POST',
      body: new URLSearchParams({ username, password: submitted, csrf }),
      headers: { Origin: overrides.origin ?? config.origin, ...headers },
    })
  }
  return {
    request,
    challenge,
    login,
    jar,
    base,
    advance: (ms) => {
      time += ms
    },
  }
}

test('environment credentials are hashed with a fresh salt and support a custom username', async (t) => {
  const env = { APP_ORIGIN: config.origin, AUTH_USERNAME: 'my-account', AUTH_PASSWORD: password }
  const first = await loadAuthConfig(env)
  const second = await loadAuthConfig(env)
  assert.equal(first.origin, config.origin)
  assert.equal(first.username, 'my-account')
  assert.notEqual(first.passwordHash, second.passwordHash)
  assert.equal(first.password, undefined)
  assert.ok(!JSON.stringify(first).includes(password))
  assert.equal(await verifyPassword(password, first.passwordHash), true)
  assert.equal(await verifyPassword('wrong-password', first.passwordHash), false)
  const f = await fixture(t, first)
  assert.equal((await f.login()).status, 303)
  assert.equal((await f.request('/check')).status, 204)
  const defaults = await loadAuthConfig({ AUTH_PASSWORD: password })
  assert.equal(defaults.username, 'admin')
  assert.equal(defaults.origin, undefined)
})

test('missing or weak environment passwords and invalid origins fail startup', async () => {
  for (const AUTH_PASSWORD of [undefined, '', 'short', ' '.repeat(20), 'x'.repeat(257)]) {
    await assert.rejects(loadAuthConfig({ AUTH_PASSWORD }), /AUTH_PASSWORD/)
  }
  await assert.rejects(
    loadAuthConfig({ AUTH_PASSWORD: password, APP_ORIGIN: 'http://remote.example.com' }),
    /HTTPS/
  )
  await assert.rejects(
    loadAuthConfig({ AUTH_PASSWORD: password, AUTH_USERNAME: 'invalid name' }),
    /Username/
  )
})

test('changing environment credentials rejects the previous password and existing session cookies', async (t) => {
  const first = await fixture(t, await loadAuthConfig({ AUTH_PASSWORD: password }))
  await first.login()
  const cookie = first.jar.get('chat_session')
  const newPassword = 'another-long-test-password'
  const second = await fixture(t, await loadAuthConfig({ AUTH_PASSWORD: newPassword }))
  assert.equal(
    (await second.request('/check', { headers: { Cookie: `chat_session=${cookie}` } })).status,
    401
  )
  assert.equal((await second.login(password)).status, 401)
  assert.equal((await second.login(newPassword)).status, 303)
})

test('configuration fails closed and requires HTTPS outside loopback', () => {
  for (const origin of [
    'http://chat.example.com',
    'https://chat.example.com/',
    'https://user:pass@chat.example.com',
    'https://chat.example.com/path',
  ]) {
    assert.throws(() => validateConfig({ ...config, origin }))
  }
  assert.throws(() => validateConfig({ ...config, passwordHash: '' }))
  assert.equal(validateConfig({ ...config, origin: 'https://chat.example.com' }).username, 'admin')
})

test('login form is public; credentials, internal paths and sessions stay private', async (t) => {
  const f = await fixture(t)
  assert.equal((await f.request('/healthz')).status, 200)
  assert.equal((await f.request('/check')).status, 401)
  const response = await f.request('/login')
  const html = await response.text()
  assert.equal(response.headers.get('cache-control'), 'no-store')
  // no-referrer makes browser form navigations send Origin: null, breaking CSRF checks.
  assert.equal(response.headers.get('referrer-policy'), 'same-origin')
  assert.match(response.headers.get('content-security-policy'), /default-src 'none'/)
  assert.match(response.headers.get('set-cookie'), /HttpOnly; SameSite=Strict/)
  assert.match(html, /autocomplete="current-password"/)
  assert.ok(!html.includes(config.passwordHash) && !html.includes(password))
  assert.equal((await f.request('/auth/session')).status, 401)
  assert.equal((await f.request('/auth/check')).status, 404)
  assert.equal((await f.request('/auth/style.css')).status, 200)
})

test('password and username are both checked; challenges cannot be replayed', async (t) => {
  const f = await fixture(t)
  assert.equal((await f.login('incorrect-password')).status, 401)
  assert.equal((await f.login(password, {}, 'another-user')).status, 401)
  const csrf = await f.challenge()
  const oldCookie = [...f.jar].map(([k, v]) => `${k}=${v}`).join('; ')
  const options = {
    method: 'POST',
    body: new URLSearchParams({ username: 'admin', password, csrf }),
    headers: { Origin: config.origin },
  }
  const response = await f.request('/auth/login', options)
  assert.equal(response.status, 303)
  assert.equal(response.headers.get('location'), '/')
  assert.equal((await f.request('/check')).status, 204)
  assert.deepEqual(await (await f.request('/auth/session')).json(), { authenticated: true })
  assert.equal(
    (
      await f.request('/auth/login', {
        ...options,
        headers: { ...options.headers, Cookie: oldCookie },
      })
    ).status,
    403
  )
})

test('login rejects absent, cross-site, incorrect and expired CSRF proof', async (t) => {
  const f = await fixture(t)
  assert.equal((await f.login(password, { Origin: 'https://attacker.example' })).status, 403)
  assert.equal((await f.login(password, { 'Sec-Fetch-Site': 'cross-site' })).status, 403)
  const csrf = await f.challenge()
  const post = (value, origin) =>
    f.request('/auth/login', {
      method: 'POST',
      body: new URLSearchParams({ username: 'admin', password, csrf: value }),
      headers: origin ? { Origin: origin } : {},
    })
  assert.equal((await post(csrf)).status, 403)
  assert.equal((await post('forged', config.origin)).status, 403)
  f.advance(10 * 60 * 1000 + 1)
  assert.equal((await post(csrf, config.origin)).status, 403)
})

test('session IDs rotate, forged cookies fail, and expiry is enforced on the server', async (t) => {
  const f = await fixture(t)
  await f.login()
  const first = f.jar.get('chat_session')
  assert.equal((await f.request('/login')).status, 303)
  f.jar.delete('chat_session')
  await f.login()
  assert.notEqual(f.jar.get('chat_session'), first)
  assert.equal(
    (await f.request('/check', { headers: { Cookie: `chat_session=${'a'.repeat(43)}` } })).status,
    401
  )
  f.advance(12 * 60 * 60 * 1000 + 1)
  assert.equal((await f.request('/check')).status, 401)
})

test('logout requires same-origin POST and CSRF, and revokes a stolen copy of the cookie', async (t) => {
  const f = await fixture(t)
  await f.login()
  const copied = f.jar.get('chat_session')
  const response = await f.request('/logout')
  const csrf = (await response.text()).match(/name="csrf" value="([A-Za-z0-9_-]+)"/)[1]
  assert.equal((await f.request('/check')).status, 204)
  assert.equal((await f.request('/auth/logout')).status, 404)
  const options = {
    method: 'POST',
    body: new URLSearchParams({ csrf }),
    headers: { Origin: config.origin },
  }
  assert.equal(
    (
      await f.request('/auth/logout', {
        ...options,
        headers: { Origin: 'https://attacker.example' },
      })
    ).status,
    403
  )
  assert.equal(
    (await f.request('/auth/logout', { ...options, body: new URLSearchParams({ csrf: 'wrong' }) }))
      .status,
    403
  )
  const logout = await f.request('/auth/logout', options)
  assert.equal(logout.status, 303)
  assert.match(logout.headers.getSetCookie()[0], /Max-Age=0/)
  assert.equal(
    (await f.request('/check', { headers: { Cookie: `chat_session=${copied}` } })).status,
    401
  )
})

test('failed logins are globally limited; forwarded IP headers cannot bypass the limit', async (t) => {
  const f = await fixture(t)
  for (let i = 0; i < 5; i++) {
    assert.equal((await f.login('wrong', { 'X-Forwarded-For': `192.0.2.${i}` })).status, 401)
  }
  const response = await f.login()
  assert.equal(response.status, 429)
  assert.ok(Number(response.headers.get('retry-after')) > 0)
  f.advance(5 * 60 * 1000 + 1)
  assert.equal((await f.login()).status, 303)
})

test('HTTPS sessions use host-only Secure cookies and restart clears sessions', async (t) => {
  const f = await fixture(t, { origin: 'https://chat.example.com' })
  const response = await f.login()
  const cookies = response.headers.getSetCookie()
  assert.match(
    cookies[0],
    /^__Host-chat_session=.*; Path=\/; HttpOnly; SameSite=Strict; Max-Age=43200; Secure$/
  )
  assert.ok(!cookies[0].includes('Domain='))
  const replacement = await fixture(t, { origin: 'https://chat.example.com' })
  assert.equal(
    (
      await replacement.request('/check', {
        headers: { Cookie: `__Host-chat_session=${f.jar.get('__Host-chat_session')}` },
      })
    ).status,
    401
  )
})

const serverKey = 'sk-test-only-server-key'
async function upstreamFixture(t, handler) {
  const server = createServer(handler)
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  t.after(() => {
    server.closeAllConnections()
    server.close()
  })
  return { server, baseURL: `http://127.0.0.1:${server.address().port}` }
}

const apiHeaders = { Origin: config.origin, 'X-Chat-Request': '1' }

test('proxy requires a runtime key and validates upstream URLs', () => {
  for (const apiKey of [undefined, '', ' ', 'key\r\nInjected: header']) {
    assert.throws(() => createApiProxy({ apiKey }))
  }
  for (const baseURL of [
    'file:///tmp/key',
    'https://user:pass@example.com',
    'https://example.com?key=secret',
    'https://example.com/#fragment',
  ]) {
    assert.throws(() => createApiProxy({ apiKey: serverKey, baseURL }))
  }
})

test('proxy checks sessions, same-origin requests and route allowlist before contacting upstream', async (t) => {
  let calls = 0
  const upstream = await upstreamFixture(t, (_request, response) => {
    calls++
    response.end('{}')
  })
  const f = await fixture(
    t,
    {},
    { apiProxy: createApiProxy({ apiKey: serverKey, baseURL: upstream.baseURL }) }
  )
  assert.equal((await f.request('/api/models', { headers: apiHeaders })).status, 401)
  assert.equal(
    (
      await f.request('/api/anthropic/v1/messages', {
        method: 'POST',
        headers: apiHeaders,
        body: '{}',
      })
    ).status,
    401
  )
  await f.login()
  assert.equal((await f.request('/api/models')).status, 403)
  assert.equal(
    (
      await f.request('/api/models', {
        headers: { ...apiHeaders, Origin: 'https://attacker.example' },
      })
    ).status,
    403
  )
  assert.equal(
    (await f.request('/api/models', { headers: { ...apiHeaders, 'Sec-Fetch-Site': 'cross-site' } }))
      .status,
    403
  )
  assert.equal(
    (
      await f.request('/api/anthropic/v1/messages', {
        method: 'POST',
        headers: { 'X-Chat-Request': '1' },
        body: '{}',
      })
    ).status,
    403
  )
  for (const path of [
    '/api/admin',
    '/api/https://attacker.example',
    '/api/models?url=https://attacker.example',
    '/api/anthropic/v1/files/evil%2Fpath',
  ]) {
    assert.equal((await f.request(path, { headers: apiHeaders })).status, 404)
  }
  assert.equal(
    (await f.request('/api/models', { method: 'POST', headers: apiHeaders, body: '{}' })).status,
    404
  )
  assert.equal(calls, 0)
  assert.equal((await f.request('/api/models', { headers: { 'X-Chat-Request': '1' } })).status, 200)
  assert.equal(calls, 1)
})

test('proxy injects the server key, preserves multipart/binary requests, and strips browser credentials', async (t) => {
  const calls = []
  const upstream = await upstreamFixture(t, async (request, response) => {
    const chunks = []
    for await (const chunk of request) chunks.push(chunk)
    calls.push({
      path: request.url,
      method: request.method,
      headers: request.headers,
      body: Buffer.concat(chunks),
    })
    response.setHeader('Set-Cookie', 'untrusted=1')
    response.setHeader('x-api-key', serverKey)
    response.setHeader(
      'Content-Type',
      request.url.endsWith('/tts') ? 'application/octet-stream' : 'application/json'
    )
    response.end(request.url.endsWith('/tts') ? Buffer.from([0, 1, 128, 255]) : '{"ok":true}')
  })
  const f = await fixture(
    t,
    {},
    { apiProxy: createApiProxy({ apiKey: serverKey, baseURL: upstream.baseURL + '/gateway/' }) }
  )
  await f.login()
  const headers = {
    ...apiHeaders,
    Authorization: 'Bearer browser-key',
    'x-api-key': 'browser-key',
    'anthropic-beta': 'files-api-2025-04-14',
  }
  const form = new FormData()
  form.append('file', new Blob(['test-attachment-bytes']), 'sample.txt')
  const upload = await f.request('/api/anthropic/v1/files', {
    method: 'POST',
    headers,
    body: form,
  })
  assert.equal(upload.status, 200)
  assert.equal(upload.headers.get('set-cookie'), null)
  assert.equal(upload.headers.get('x-api-key'), null)
  assert.equal(calls[0].path, '/gateway/anthropic/v1/files')
  assert.equal(calls[0].headers['x-api-key'], serverKey)
  assert.equal(calls[0].headers.authorization, undefined)
  assert.equal(calls[0].headers.cookie, undefined)
  assert.equal(calls[0].headers.origin, undefined)
  assert.equal(calls[0].headers['anthropic-beta'], 'files-api-2025-04-14')
  assert.match(calls[0].headers['content-type'], /multipart\/form-data; boundary=/)
  assert.match(calls[0].body.toString(), /test-attachment-bytes/)
  assert.equal(
    (await f.request('/api/anthropic/v1/files/file_test-1', { method: 'DELETE', headers })).status,
    200
  )
  assert.equal(calls[1].method, 'DELETE')
  const tts = await f.request('/api/v1/tools/tts', {
    method: 'POST',
    headers: { ...headers, 'Content-Type': 'application/json' },
    body: '{"text":"test"}',
  })
  assert.deepEqual(Buffer.from(await tts.arrayBuffer()), Buffer.from([0, 1, 128, 255]))
  assert.equal(calls[2].headers.authorization, `Bearer ${serverKey}`)
  assert.equal(calls[2].headers['x-api-key'], undefined)
  assert.equal(calls[2].body.toString(), '{"text":"test"}')
  assert.equal(
    (await f.request('/api/v1/tools/asr', { method: 'POST', headers, body: form })).status,
    200
  )
  assert.match(calls[3].body.toString(), /sample.txt/)
  assert.equal((await f.request('/api/models', { headers })).status, 200)
  assert.equal(calls[4].headers.authorization, `Bearer ${serverKey}`)
  const session = await (await f.request('/auth/session')).text()
  assert.ok(!session.includes(serverKey))
})

test('SSE reaches the browser before upstream completes and client cancellation closes upstream', async (t) => {
  let release
  const gate = new Promise((resolve) => {
    release = resolve
  })
  let disconnected
  const closed = new Promise((resolve) => {
    disconnected = resolve
  })
  const upstream = await upstreamFixture(t, async (request, response) => {
    for await (const _chunk of request) {
      /* Drain the prompt. */
    }
    response.on('close', disconnected)
    response.writeHead(200, { 'Content-Type': 'text/event-stream' })
    response.write('event: ping\ndata: {}\n\n')
    await gate
    response.end('event: message_stop\ndata: {}\n\n')
  })
  t.after(() => release())
  const f = await fixture(
    t,
    {},
    { apiProxy: createApiProxy({ apiKey: serverKey, baseURL: upstream.baseURL }) }
  )
  await f.login()
  const controller = new AbortController()
  const response = await f.request('/api/anthropic/v1/messages', {
    method: 'POST',
    headers: apiHeaders,
    body: '{}',
    signal: controller.signal,
  })
  assert.equal(response.headers.get('content-type'), 'text/event-stream')
  const first = await response.body.getReader().read()
  assert.match(new TextDecoder().decode(first.value), /event: ping/)
  controller.abort()
  await Promise.race([
    closed,
    new Promise((_, reject) => {
      const timer = setTimeout(() => reject(new Error('Upstream request was not cancelled')), 2000)
      timer.unref()
    }),
  ])
})

test('proxy limits upload size and returns upstream errors without following redirects', async (t) => {
  let calls = 0
  const upstream = await upstreamFixture(t, (_request, response) => {
    calls++
    response.writeHead(calls === 1 ? 429 : 302, {
      'Content-Type': 'application/json',
      'Retry-After': '10',
      Location: 'https://attacker.example',
    })
    response.end('{"error":{"message":"quota reached"}}')
  })
  const f = await fixture(
    t,
    {},
    { apiProxy: createApiProxy({ apiKey: serverKey, baseURL: upstream.baseURL }) }
  )
  await f.login()
  const limited = await f.request('/api/models', { headers: apiHeaders })
  assert.equal(limited.status, 429)
  assert.equal(limited.headers.get('retry-after'), '10')
  assert.equal(limited.headers.get('location'), null)
  assert.match(await limited.text(), /quota reached/)
  const redirect = await f.request('/api/models', { headers: apiHeaders })
  assert.equal(redirect.status, 302)
  assert.equal(redirect.headers.get('location'), null)
  const oversized = await new Promise((resolve, reject) => {
    const request = httpRequest(
      f.base + '/api/anthropic/v1/files',
      {
        method: 'POST',
        headers: {
          ...apiHeaders,
          Cookie: [...f.jar].map(([name, value]) => `${name}=${value}`).join('; '),
          'Content-Length': MAX_API_BODY + 1,
        },
      },
      (response) => {
        response.resume()
        resolve(response.statusCode)
      }
    )
    request.on('error', reject)
    request.end()
  })
  assert.equal(oversized, 413)
  assert.equal(calls, 2)
})

test('automatic origin supports public HTTPS and rejects origin forgery and challenge reuse across hosts', async (t) => {
  const f = await fixture(t, { origin: undefined })
  const publicHeaders = { Host: 'chat.example.com', 'X-Forwarded-Proto': 'https' }
  const loginPage = await f.request('/login', { headers: publicHeaders })
  assert.match(loginPage.headers.get('set-cookie'), /^__Host-chat_login=.*; Secure$/)
  const csrf = (await loginPage.text()).match(/name="csrf" value="([A-Za-z0-9_-]+)"/)[1]
  const post = (headers) =>
    f.request('/auth/login', {
      method: 'POST',
      headers,
      body: new URLSearchParams({ username: 'admin', password, csrf }),
    })
  assert.equal((await post({ ...publicHeaders, Origin: 'https://attacker.example' })).status, 403)
  assert.equal(
    (
      await post({
        ...publicHeaders,
        Host: 'other.example.com',
        Origin: 'https://other.example.com',
      })
    ).status,
    403
  )
  const success = await post({ ...publicHeaders, Origin: 'https://chat.example.com' })
  assert.equal(success.status, 303)
  assert.match(success.headers.getSetCookie()[0], /^__Host-chat_session=.*; Secure$/)
  assert.equal((await f.request('/check', { headers: publicHeaders })).status, 204)
  assert.equal(
    (await f.request('/check', { headers: { ...publicHeaders, Host: 'other.example.com' } }))
      .status,
    401
  )
  assert.equal(
    (await f.request('/login', { headers: { Host: 'bad.example,evil.example' } })).status,
    400
  )
})

const storedSession = (id = 'shared-chat') => ({
  id,
  title: '跨设备聊天',
  createdAt: 1,
  updatedAt: 2,
  messages: [{ id: 'question', role: 'user', content: '原始内容', files: [], createdAt: 1 }],
  rootMessageId: 'question',
})
async function storageFixture(t, filename = ':memory:') {
  const dataStore = createDataStore(filename)
  const f = await fixture(t, {}, { dataStore })
  t.after(() => dataStore.close())
  const data = async (path, method = 'GET', value) => {
    const response = await f.request('/data/' + path, {
      method,
      headers: {
        ...apiHeaders,
        ...(value === undefined ? {} : { 'Content-Type': 'application/json' }),
      },
      ...(value === undefined ? {} : { body: JSON.stringify(value) }),
    })
    return { status: response.status, value: await response.json() }
  }
  return { ...f, data }
}

test('server data requires authentication and same-origin proof, validates input, and detects stale cross-device writes', async (t) => {
  const f = await storageFixture(t)
  assert.equal((await f.data('state')).status, 401)
  await f.login()
  assert.equal((await f.request('/data/state')).status, 403)
  assert.equal(
    (
      await f.request('/data/state', {
        headers: { ...apiHeaders, Origin: 'https://attacker.example' },
      })
    ).status,
    403
  )
  assert.equal(
    (
      await f.request('/data/settings', {
        method: 'PATCH',
        headers: { 'X-Chat-Request': '1', 'Content-Type': 'application/json' },
        body: '{}',
      })
    ).status,
    403
  )
  const state = (await f.data('state')).value
  const initial = { generation: state.generation, revision: null }
  assert.equal(
    (await f.data('sessions/shared-chat', 'PUT', { ...initial, session: { id: 'wrong' } })).status,
    400
  )
  assert.equal((await f.data('sessions/shared-chat', 'PUT', null)).status, 400)
  const a = await f.data('sessions/shared-chat', 'PUT', { ...initial, session: storedSession() })
  assert.equal(a.status, 200)
  const b = (await f.data('sessions/shared-chat')).value
  const newer = await f.data('sessions/shared-chat', 'PUT', {
    ...a.value,
    session: { ...b.session, title: '手机保存的新标题' },
  })
  assert.equal(newer.status, 200)
  assert.equal(
    (await f.data('sessions/shared-chat', 'PUT', { ...a.value, session: storedSession() })).status,
    409
  )
  assert.equal((await f.data('sessions/shared-chat', 'DELETE', a.value)).status, 409)
  assert.equal((await f.data('sessions/shared-chat')).value.session.title, '手机保存的新标题')
  assert.equal((await f.data('sessions/shared-chat', 'DELETE', newer.value)).status, 200)
  assert.equal(
    (await f.data('sessions/shared-chat', 'PUT', { ...newer.value, session: storedSession() }))
      .status,
    409
  )
  assert.deepEqual((await f.data('state')).value.sessions, [])
})

test('imports are isolated, atomic, detect changes during upload, and invalidate old clients', async (t) => {
  const f = await storageFixture(t)
  await f.login()
  const state = (await f.data('state')).value
  const oldVersion = (
    await f.data('sessions/shared-chat', 'PUT', {
      generation: state.generation,
      revision: null,
      session: storedSession(),
    })
  ).value
  const start = async () => (await f.data('imports', 'POST')).value.id
  const left = await start(),
    right = await start()
  const imported = storedSession('imported')
  assert.equal((await f.data(`imports/${left}/sessions/imported`, 'PUT', imported)).status, 200)
  assert.equal(
    (await f.data(`imports/${right}/sessions/imported`, 'PUT', { id: 'invalid' })).status,
    400
  )
  assert.equal((await f.data(`imports/${right}`, 'DELETE')).status, 200)
  assert.equal((await f.data('state')).value.sessions[0].id, 'shared-chat')
  const replacement = await f.data(`imports/${left}/commit`, 'POST')
  assert.equal(replacement.status, 200)
  assert.deepEqual(
    replacement.value.sessions.map((s) => s.id),
    ['imported']
  )
  assert.notEqual(replacement.value.generation, state.generation)
  assert.equal(
    (await f.data('sessions/shared-chat', 'PUT', { ...oldVersion, session: storedSession() }))
      .status,
    409
  )
  assert.equal(
    (
      await f.data('drafts/new', 'PUT', {
        generation: state.generation,
        revision: null,
        draft: { text: 'old', attachments: [] },
      })
    ).status,
    409
  )
  const race = await start()
  const row = (await f.data('sessions/imported')).value
  await f.data('sessions/imported', 'PATCH', { ...row, title: '导入期间另一设备保存' })
  assert.equal((await f.data(`imports/${race}/commit`, 'POST')).status, 409)
  assert.equal((await f.data('sessions/imported')).value.session.title, '导入期间另一设备保存')
})

test('SQLite retains sessions, binary originals, settings and drafts after reopening on the same data directory', async (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'chat-data-test-'))
  t.after(() => rmSync(directory, { recursive: true, force: true }))
  const filename = join(directory, 'chat.sqlite')
  const f = await storageFixture(t, filename)
  await f.login()
  const generation = (await f.data('state')).value.generation
  await f.data('sessions/shared-chat', 'PUT', {
    generation,
    revision: null,
    session: storedSession(),
  })
  const bytes = Buffer.from([0, 1, 128, 255])
  assert.equal(
    (
      await f.request('/data/files/original', {
        method: 'PUT',
        headers: { ...apiHeaders, 'X-Chat-Generation': generation, 'Content-Type': 'image/png' },
        body: bytes,
      })
    ).status,
    200
  )
  assert.equal(
    (
      await f.data('settings', 'PATCH', {
        themePreference: 'dark',
        thinking: true,
        location: { region: 'CN', province: '110000' },
      })
    ).status,
    200
  )
  assert.equal((await f.data('settings', 'PATCH', { apiKey: 'must-not-store' })).status, 400)
  const draft = {
    text: '在手机继续编辑',
    attachments: [
      { id: 'original', name: 'image.png', type: 'image/png', isImage: true, lastModified: 1 },
    ],
  }
  const firstDraft = await f.data('drafts/new', 'PUT', { generation, revision: null, draft })
  assert.equal(firstDraft.status, 200)
  assert.equal(
    (
      await f.data('drafts/new', 'PUT', {
        generation,
        revision: null,
        draft: { text: 'stale', attachments: [] },
      })
    ).status,
    409
  )
  // A separate database connection emulates the replacement container; WAL is also read correctly.
  const second = await storageFixture(t, filename)
  await second.login()
  assert.equal((await second.data('sessions/shared-chat')).value.session.title, '跨设备聊天')
  assert.deepEqual((await second.data('settings')).value, {
    themePreference: 'dark',
    thinking: true,
    location: { region: 'CN', province: '110000' },
  })
  assert.deepEqual((await second.data('drafts')).value.drafts[0].draft, draft)
  const file = await second.request('/data/files/original', { headers: apiHeaders })
  assert.equal(file.headers.get('content-type'), 'image/png')
  assert.deepEqual(Buffer.from(await file.arrayBuffer()), bytes)
  const clear = (await second.data('imports', 'POST')).value.id
  await second.data(`imports/${clear}/commit`, 'POST')
  assert.deepEqual((await second.data('drafts')).value.drafts, [])
  assert.equal((await second.request('/data/files/original', { headers: apiHeaders })).status, 404)
  assert.equal((await second.data('settings')).value.themePreference, 'dark')
})

test('imported originals commit with their sessions and deleting a chat preserves originals still referenced by another chat', async (t) => {
  const f = await storageFixture(t)
  await f.login()
  const id = (await f.data('imports', 'POST')).value.id
  const session = storedSession('with-image')
  session.messages[0].files = [
    { id: 'shared-image', serverId: null, name: 'photo.png', size: 4, isImage: true, mimeType: '' },
  ]
  assert.equal((await f.data(`imports/${id}/sessions/with-image`, 'PUT', session)).status, 200)
  assert.equal(
    (
      await f.request(`/data/imports/${id}/files/shared-image`, {
        method: 'PUT',
        headers: { ...apiHeaders, 'Content-Type': 'image/png' },
        body: Buffer.from([1, 2, 3, 4]),
      })
    ).status,
    200
  )
  await f.data(`imports/${id}/types`, 'PATCH', { 'shared-image': 'image/png' })
  assert.equal((await f.request('/data/files/shared-image', { headers: apiHeaders })).status, 404)
  await f.data(`imports/${id}/commit`, 'POST')
  const first = (await f.data('sessions/with-image')).value
  assert.equal(first.session.messages[0].files[0].mimeType, 'image/png')
  const secondSession = { ...first.session, id: 'second-reference' }
  const second = (
    await f.data('sessions/second-reference', 'PUT', {
      generation: first.generation,
      revision: null,
      session: secondSession,
    })
  ).value
  await f.data('sessions/with-image', 'DELETE', first)
  assert.equal((await f.request('/data/files/shared-image', { headers: apiHeaders })).status, 200)
  await f.data('sessions/second-reference', 'DELETE', second)
  assert.equal((await f.request('/data/files/shared-image', { headers: apiHeaders })).status, 404)
})
