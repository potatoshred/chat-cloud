import assert from 'node:assert/strict'
import { once } from 'node:events'
import { scryptSync } from 'node:crypto'
import { test } from 'node:test'
import { createAuthServer, validateConfig } from './server.mjs'
import { PASSWORD_OPTIONS } from './password.mjs'

const password = 'test-only-long-password-测试'
const salt = Buffer.alloc(32, 7)
const key = scryptSync(password, salt, 64, PASSWORD_OPTIONS)
const config = {
  origin: 'http://localhost:8090', username: 'admin',
  passwordHash: `scrypt$65536$8$2$${salt.toString('hex')}$${key.toString('hex')}`,
}

async function fixture(t, overrides = {}) {
  let time = Date.now()
  const server = createAuthServer({ ...config, ...overrides }, { now: () => time })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  t.after(() => { server.closeAllConnections(); server.close() })
  const base = `http://127.0.0.1:${server.address().port}`
  const jar = new Map()
  const request = async (path, options = {}) => {
    const response = await fetch(base + path, {
      redirect: 'manual', ...options,
      headers: { Cookie: [...jar].map(([name, value]) => `${name}=${value}`).join('; '), ...options.headers },
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
  const login = async (submitted = password, headers = {}, username = config.username) => {
    const csrf = await challenge()
    return request('/auth/login', {
      method: 'POST', body: new URLSearchParams({ username, password: submitted, csrf }),
      headers: { Origin: overrides.origin ?? config.origin, ...headers },
    })
  }
  return { request, challenge, login, jar, advance: (ms) => { time += ms } }
}

test('configuration fails closed and requires HTTPS outside loopback', () => {
  for (const origin of ['http://chat.example.com', 'https://chat.example.com/', 'https://user:pass@chat.example.com', 'https://chat.example.com/path']) {
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
  const options = { method: 'POST', body: new URLSearchParams({ username: 'admin', password, csrf }), headers: { Origin: config.origin } }
  const response = await f.request('/auth/login', options)
  assert.equal(response.status, 303)
  assert.equal(response.headers.get('location'), '/')
  assert.equal((await f.request('/check')).status, 204)
  assert.deepEqual(await (await f.request('/auth/session')).json(), { authenticated: true })
  assert.equal((await f.request('/auth/login', { ...options, headers: { ...options.headers, Cookie: oldCookie } })).status, 403)
})

test('login rejects absent, cross-site, incorrect and expired CSRF proof', async (t) => {
  const f = await fixture(t)
  assert.equal((await f.login(password, { Origin: 'https://attacker.example' })).status, 403)
  assert.equal((await f.login(password, { 'Sec-Fetch-Site': 'cross-site' })).status, 403)
  const csrf = await f.challenge()
  const post = (value, origin) => f.request('/auth/login', { method: 'POST', body: new URLSearchParams({ username: 'admin', password, csrf: value }), headers: origin ? { Origin: origin } : {} })
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
  assert.equal((await f.request('/check', { headers: { Cookie: `chat_session=${'a'.repeat(43)}` } })).status, 401)
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
  const options = { method: 'POST', body: new URLSearchParams({ csrf }), headers: { Origin: config.origin } }
  assert.equal((await f.request('/auth/logout', { ...options, headers: { Origin: 'https://attacker.example' } })).status, 403)
  assert.equal((await f.request('/auth/logout', { ...options, body: new URLSearchParams({ csrf: 'wrong' }) })).status, 403)
  const logout = await f.request('/auth/logout', options)
  assert.equal(logout.status, 303)
  assert.match(logout.headers.getSetCookie()[0], /Max-Age=0/)
  assert.equal((await f.request('/check', { headers: { Cookie: `chat_session=${copied}` } })).status, 401)
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
  assert.match(cookies[0], /^__Host-chat_session=.*; Path=\/; HttpOnly; SameSite=Strict; Max-Age=43200; Secure$/)
  assert.ok(!cookies[0].includes('Domain='))
  const replacement = await fixture(t, { origin: 'https://chat.example.com' })
  assert.equal((await replacement.request('/check', { headers: { Cookie: `__Host-chat_session=${f.jar.get('__Host-chat_session')}` } })).status, 401)
})
