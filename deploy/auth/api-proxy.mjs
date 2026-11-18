import { request as httpRequest } from 'node:http'
import { request as httpsRequest } from 'node:https'
import { Transform } from 'node:stream'

export const MAX_API_BODY = 32 * 1024 * 1024
const FILE_PATH = /^\/anthropic\/v1\/files\/[A-Za-z0-9_-]{1,256}$/
const ROUTES = new Map([
  ['/models', 'GET'],
  ['/user/balance', 'GET'],
  ['/anthropic/v1/messages', 'POST'],
  ['/anthropic/v1/files', 'POST'],
  ['/v1/tools/asr', 'POST'],
  ['/v1/tools/tts', 'POST'],
])

export function createApiProxy({ apiKey, baseURL = 'https://api.deepseek.com' }) {
  if (typeof apiKey !== 'string' || !apiKey.trim() || /[\s\x00-\x1f\x7f]/.test(apiKey)) {
    throw new Error('Set DEEPSEEK_API_KEY to a valid API key')
  }
  const base = new URL(baseURL)
  if (!['https:', 'http:'].includes(base.protocol) || base.username || base.password || base.search || base.hash) {
    throw new Error('DEEPSEEK_API_BASE_URL must be an HTTP(S) URL without credentials, query, or fragment')
  }
  const prefix = base.pathname.replace(/\/$/, '')
  let active = 0

  return async (request, response) => {
    const fail = (status, message) => {
      if (response.destroyed) return
      if (response.headersSent) { response.destroy(); return }
      response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' })
      response.end(JSON.stringify({ error: { message } }))
    }
    const path = request.url.slice('/api'.length)
    if (!(ROUTES.get(path) === request.method || (request.method === 'DELETE' && FILE_PATH.test(path)))) {
      fail(404, 'API endpoint not found'); return
    }
    if (Number(request.headers['content-length'] ?? 0) > MAX_API_BODY) {
      fail(413, 'Request exceeds the 32 MiB upload limit'); return
    }
    if (active >= 8) { fail(429, 'Too many concurrent API requests'); return }

    const target = new URL(base)
    target.pathname = prefix + path
    const headers = { 'accept-encoding': 'identity' }
    for (const name of ['content-type', 'accept', 'anthropic-beta', 'anthropic-version']) {
      if (request.headers[name]) headers[name] = request.headers[name]
    }
    if (path.startsWith('/anthropic/')) headers['x-api-key'] = apiKey
    else headers.authorization = `Bearer ${apiKey}`

    active++
    try {
      await new Promise((resolve) => {
        let upstream
        const finish = () => { upstream?.destroy(); resolve() }
        response.once('finish', finish)
        response.once('close', finish)
        upstream = (target.protocol === 'https:' ? httpsRequest : httpRequest)(target, {
          method: request.method, headers,
        }, (result) => {
          const returned = { 'X-Accel-Buffering': 'no' }
          // Never relay upstream cookies, redirects, or credential-bearing headers.
          for (const name of ['content-type', 'content-encoding', 'retry-after']) {
            if (result.headers[name]) returned[name] = result.headers[name]
          }
          if (response.destroyed) { result.destroy(); return }
          response.writeHead(result.statusCode ?? 502, returned)
          response.flushHeaders()
          result.on('error', () => fail(502, 'Upstream response interrupted'))
          result.pipe(response)
        })
        upstream.setTimeout(300_000, () => upstream.destroy(new Error('Upstream timeout')))
        upstream.on('error', () => fail(502, 'Unable to reach the configured API service'))
        request.once('aborted', () => upstream.destroy())
        let uploaded = 0
        const limit = new Transform({
          transform(chunk, encoding, callback) {
            uploaded += chunk.length
            if (uploaded > MAX_API_BODY) callback(new Error('Upload limit exceeded'))
            else callback(null, chunk)
          },
        })
        limit.on('error', () => {
          request.unpipe(limit)
          request.resume()
          fail(413, 'Request exceeds the 32 MiB upload limit')
          upstream.destroy()
        })
        request.on('error', () => upstream.destroy())
        request.pipe(limit).pipe(upstream)
      })
    } finally {
      active--
    }
  }
}
