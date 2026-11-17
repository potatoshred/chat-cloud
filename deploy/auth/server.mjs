import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { fileURLToPath } from 'node:url'
import { hashPassword, parsePasswordHash, verifyPassword } from './password.mjs'
import { createApiProxy } from './api-proxy.mjs'
import { createDataStore, DataError } from './data-store.mjs'

const SESSION_TTL = 12 * 60 * 60 * 1000
const LOGIN_TTL = 10 * 60 * 1000
const ATTEMPT_WINDOW = 5 * 60 * 1000
const token = () => randomBytes(32).toString('base64url')
const digest = (value) => createHash('sha256').update(value).digest('hex')
const escape = (value) =>
  String(value).replace(
    /[&<>"']/g,
    (char) =>
      ({
        '&': '&amp;',
        '<': '&lt;',
        '>': '&gt;',
        '"': '&quot;',
        "'": '&#39;',
      })[char]
  )
const equal = (left, right) =>
  timingSafeEqual(
    createHash('sha256').update(String(left)).digest(),
    createHash('sha256').update(String(right)).digest()
  )

export function validateConfig(config) {
  if (!config) throw new Error('Missing configuration')
  if (config.origin) {
    const url = new URL(config.origin)
    const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)
    if (
      url.origin !== config.origin ||
      url.username ||
      url.password ||
      !(url.protocol === 'https:' || (url.protocol === 'http:' && loopback))
    ) {
      throw new Error(
        'Origin must be an HTTPS origin, or HTTP on localhost/loopback, without a trailing slash'
      )
    }
  }
  if (typeof config.username !== 'string' || !/^[a-zA-Z0-9_.@-]{1,64}$/.test(config.username)) {
    throw new Error('Username must contain 1–64 letters, numbers, or _.@-')
  }
  parsePasswordHash(config.passwordHash)
  return config
}

export async function loadAuthConfig(env = process.env) {
  return validateConfig({
    origin: env.APP_ORIGIN || undefined,
    username: env.AUTH_USERNAME || 'admin',
    passwordHash: await hashPassword(env.AUTH_PASSWORD),
  })
}

function cookieValue(request, name) {
  const values = (request.headers.cookie ?? '')
    .split(';')
    .map((part) => part.trim())
    .filter((part) => part.startsWith(`${name}=`))
  if (values.length !== 1) return ''
  const value = values[0].slice(name.length + 1)
  return /^[A-Za-z0-9_-]{43}$/.test(value) ? value : ''
}

class RequestError extends Error {
  constructor(status, message) {
    super(message)
    this.status = status
  }
}

async function readForm(request) {
  if (
    request.headers['content-type']?.split(';')[0].trim() !== 'application/x-www-form-urlencoded'
  ) {
    throw new RequestError(415, '请使用登录表单提交。')
  }
  if (Number(request.headers['content-length'] ?? 0) > 4096)
    throw new RequestError(413, '表单内容过长。')
  const chunks = []
  let size = 0
  for await (const chunk of request) {
    size += chunk.length
    if (size > 4096) throw new RequestError(413, '表单内容过长。')
    chunks.push(chunk)
  }
  const form = new URLSearchParams(Buffer.concat(chunks).toString('utf8'))
  for (const key of form.keys()) {
    if (!['username', 'password', 'csrf'].includes(key) || form.getAll(key).length !== 1) {
      throw new RequestError(400, '表单格式无效，请重新打开登录页。')
    }
  }
  return form
}

function page({ title, description, content, error = '' }) {
  return `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="color-scheme" content="light dark"><title>${escape(title)} · DeepSeek Chat</title>
<link rel="icon" href="/favicon.ico" sizes="16x16 32x32 48x48">
<link rel="icon" href="/favicon.svg" type="image/svg+xml" sizes="any">
<link rel="stylesheet" href="/auth/style.css"></head><body>
<main class="card"><div class="brand"><span class="mark" aria-hidden="true">✦</span><span>DeepSeek Chat<span class="brand-note">PERSONAL SPACE</span></span></div>
<h1>${escape(title)}</h1><p class="description">${escape(description)}</p>
${error ? `<p class="error" role="alert">${escape(error)}</p>` : ''}
${content}<p class="footnote">DeepSeek Chat · 仅限本人访问</p></main></body></html>`
}

export function createAuthServer(rawConfig, { now = Date.now, apiProxy, dataStore } = {}) {
  const config = validateConfig(rawConfig)
  const sessions = new Map()
  const challenges = new Map()
  const style = readFileSync(new URL('./style.css', import.meta.url))
  let attempts = []
  let hashing = false

  // Only Nginx can reach this service. It forwards the public Host and sanitized scheme.
  const origin = (request) => {
    if (config.origin) return config.origin
    const host = request.headers.host
    const scheme = request.headers['x-forwarded-proto'] || 'http'
    if (!host || /[\s,/@\\?#]/.test(host) || !['http', 'https'].includes(scheme))
      throw new RequestError(400, '访问地址无效。')
    const value = `${scheme}://${host}`
    try {
      if (new URL(value).origin !== value) throw new Error()
    } catch {
      throw new RequestError(400, '访问地址无效。')
    }
    return value
  }
  const names = (request) =>
    origin(request).startsWith('https:')
      ? { session: '__Host-chat_session', login: '__Host-chat_login' }
      : { session: 'chat_session', login: 'chat_login' }
  const cookie = (request, name, value, age) =>
    `${name}=${value}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${age}${origin(request).startsWith('https:') ? '; Secure' : ''}`
  const put = (map, key, value, limit) => {
    for (const [id, entry] of map) if (entry.expires <= now()) map.delete(id)
    if (map.size >= limit) map.delete(map.keys().next().value)
    map.set(key, value)
  }
  const session = (request) => {
    const key = digest(cookieValue(request, names(request).session))
    const entry = sessions.get(key)
    if (!entry || entry.expires <= now() || entry.origin !== origin(request)) {
      sessions.delete(key)
      return null
    }
    return { ...entry, key }
  }
  const redirect = (response, path) => {
    response.writeHead(303, { Location: path })
    response.end()
  }
  const html = (response, body, status = 200) => {
    response.writeHead(status, { 'Content-Type': 'text/html; charset=utf-8' })
    response.end(body)
  }
  const json = (response, body, status = 200) => {
    response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' })
    response.end(JSON.stringify(body))
  }
  const loginPage = (request, response, error = '', status = 200) => {
    const id = token()
    const csrf = token()
    put(challenges, digest(id), { csrf, origin: origin(request), expires: now() + LOGIN_TTL }, 256)
    response.setHeader('Set-Cookie', cookie(request, names(request).login, id, LOGIN_TTL / 1000))
    html(
      response,
      page({
        title: '登录你的聊天空间',
        description: '欢迎回来，输入账号和密码以继续。',
        error,
        content: `<form method="post" action="/auth/login">
<input type="hidden" name="csrf" value="${csrf}">
<label for="username">账号</label><input id="username" name="username" type="text" autocomplete="username" autocapitalize="none" spellcheck="false" maxlength="64" required autofocus>
<label for="password">密码</label><input id="password" name="password" type="password" autocomplete="current-password" maxlength="256" required>
<button type="submit">登录<span aria-hidden="true"> →</span></button></form>`,
      }),
      status
    )
  }

  const server = createServer({ maxHeaderSize: 8192 }, async (request, response) => {
    response.setHeader('Cache-Control', 'no-store')
    response.setHeader('X-Content-Type-Options', 'nosniff')
    response.setHeader('X-Frame-Options', 'DENY')
    response.setHeader('Referrer-Policy', 'same-origin')
    response.setHeader(
      'Content-Security-Policy',
      "default-src 'none'; img-src 'self'; style-src 'self'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'"
    )
    try {
      const path = request.url?.split('?')[0]
      if (path === '/api' || path?.startsWith('/api/') || path?.startsWith('/data/')) {
        if (!session(request)) {
          json(response, { error: { message: '请先登录。' } }, 401)
          return
        }
        // Custom headers cannot be added by cross-origin forms; no CORS is enabled.
        if (
          request.headers['x-chat-request'] !== '1' ||
          request.headers['sec-fetch-site'] === 'cross-site' ||
          (request.headers.origin && request.headers.origin !== origin(request)) ||
          (request.method !== 'GET' && request.headers.origin !== origin(request))
        ) {
          json(response, { error: { message: '请求来源不匹配。' } }, 403)
          return
        }
        if (path.startsWith('/data/')) {
          if (!dataStore) {
            json(response, { error: { message: '服务端存储不可用。' } }, 503)
            return
          }
          await dataStore.handle(request, response)
          return
        }
        if (!apiProxy) {
          json(response, { error: { message: '服务端尚未配置 API。' } }, 503)
          return
        }
        await apiProxy(request, response)
        return
      }
      if (request.method === 'GET' && path === '/healthz') {
        response.writeHead(200, { 'Content-Type': 'text/plain' })
        response.end('ok\n')
        return
      }
      if (request.method === 'GET' && path === '/check') {
        response.writeHead(session(request) ? 204 : 401)
        response.end()
        return
      }
      if (request.method === 'GET' && path === '/auth/style.css') {
        response.writeHead(200, { 'Content-Type': 'text/css; charset=utf-8' })
        response.end(style)
        return
      }
      if (request.method === 'GET' && path === '/auth/session') {
        const current = session(request)
        json(response, { authenticated: Boolean(current) }, current ? 200 : 401)
        return
      }
      if (request.method === 'GET' && path === '/login') {
        if (session(request)) redirect(response, '/')
        else loginPage(request, response)
        return
      }
      if (request.method === 'GET' && path === '/logout') {
        const current = session(request)
        if (!current) {
          redirect(response, '/login')
          return
        }
        html(
          response,
          page({
            title: '退出登录',
            description: '退出后需要重新登录，服务端保存的聊天记录会保留。',
            content: `<form method="post" action="/auth/logout"><input type="hidden" name="csrf" value="${current.csrf}"><button type="submit">确认退出</button><a class="back" href="/">返回聊天</a></form>`,
          })
        )
        return
      }
      if (request.method === 'POST' && ['/auth/login', '/auth/logout'].includes(path)) {
        if (
          request.headers.origin !== origin(request) ||
          request.headers['sec-fetch-site'] === 'cross-site'
        ) {
          throw new RequestError(403, '请求来源不匹配，请从本站重新打开登录页。')
        }
        const form = await readForm(request)
        if (path === '/auth/logout') {
          const current = session(request)
          if (!current || !equal(form.get('csrf') ?? '', current.csrf)) {
            throw new RequestError(403, '会话已失效，请重新打开页面。')
          }
          sessions.delete(current.key)
          response.setHeader('Set-Cookie', [
            cookie(request, names(request).session, '', 0),
            cookie(request, names(request).login, '', 0),
          ])
          response.setHeader('Clear-Site-Data', '"cache"')
          redirect(response, '/login')
          return
        }
        const challengeKey = digest(cookieValue(request, names(request).login))
        const challenge = challenges.get(challengeKey)
        if (
          !challenge ||
          challenge.origin !== origin(request) ||
          challenge.expires <= now() ||
          !equal(form.get('csrf') ?? '', challenge.csrf)
        ) {
          throw new RequestError(403, '登录页已过期，请刷新后重试。')
        }
        challenges.delete(challengeKey)
        attempts = attempts.filter((time) => time > now() - ATTEMPT_WINDOW)
        if (hashing || attempts.length >= 5) {
          response.setHeader(
            'Retry-After',
            hashing
              ? '2'
              : String(Math.max(1, Math.ceil((attempts[0] + ATTEMPT_WINDOW - now()) / 1000)))
          )
          loginPage(request, response, '尝试过于频繁，请稍后再试。', 429)
          return
        }
        const username = form.get('username') ?? ''
        const password = form.get('password') ?? ''
        if (!username || username.length > 64 || !password || password.length > 256) {
          throw new RequestError(400, '请输入有效的账号和密码。')
        }
        attempts.push(now())
        hashing = true
        let passwordMatches
        try {
          passwordMatches = await verifyPassword(password, config.passwordHash)
        } finally {
          hashing = false
        }
        if (!passwordMatches || !equal(username, config.username)) {
          loginPage(request, response, '账号或密码不正确。', 401)
          return
        }
        attempts = []
        // Each successful login creates a fresh opaque session ID.
        const id = token()
        put(
          sessions,
          digest(id),
          { csrf: token(), origin: origin(request), expires: now() + SESSION_TTL },
          16
        )
        response.setHeader('Set-Cookie', [
          cookie(request, names(request).session, id, SESSION_TTL / 1000),
          cookie(request, names(request).login, '', 0),
        ])
        redirect(response, '/')
        return
      }
      throw new RequestError(404, '页面不存在。')
    } catch (error) {
      if (error instanceof DataError) {
        if (!response.destroyed && !response.headersSent)
          json(response, { error: { message: error.message } }, error.status)
        return
      }
      if (!(error instanceof RequestError)) console.error('Authentication request failed', error)
      if (!response.destroyed && !response.headersSent)
        html(
          response,
          page({
            title: '暂时无法继续',
            description:
              error instanceof RequestError ? error.message : '服务暂不可用，请稍后重试。',
            content: '<a class="back" href="/login">返回登录页</a>',
          }),
          error instanceof RequestError ? error.status : 503
        )
    }
  })
  server.requestTimeout = 120000
  server.headersTimeout = 10000
  server.keepAliveTimeout = 5000
  return server
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  try {
    const config = await loadAuthConfig()
    const apiProxy = createApiProxy({
      apiKey: process.env.DEEPSEEK_API_KEY,
      baseURL: process.env.DEEPSEEK_API_BASE_URL || 'https://api.deepseek.com',
    })
    process.umask(0o077)
    const dataStore = createDataStore(process.env.CHAT_DATA_PATH || '/data/chat.sqlite')
    const server = createAuthServer(config, { apiProxy, dataStore })
    server.listen(3000, '0.0.0.0', () =>
      console.log('Single-user login service listening on port 3000')
    )
    for (const signal of ['SIGINT', 'SIGTERM'])
      process.on(signal, () =>
        server.close(() => {
          dataStore.close()
          process.exit(0)
        })
      )
  } catch (error) {
    console.error(`Cannot start login service: ${error.message}`)
    process.exit(1)
  }
}
