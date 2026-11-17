import { randomUUID } from 'node:crypto'
import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { DatabaseSync } from 'node:sqlite'

const MiB = 1024 * 1024
export class DataError extends Error {
  constructor(status, message) {
    super(message)
    this.status = status
  }
}
const fail = (status, message) => {
  throw new DataError(status, message)
}
const object = (value) => value && typeof value === 'object' && !Array.isArray(value)
const validId = (value) =>
  typeof value === 'string' && value.length > 0 && value.length <= 512 && !/[\x00-\x1f]/.test(value)
const conflict = () => fail(409, '数据已在另一页面或设备上修改。请备份未保存内容，再刷新页面重试。')
const fileIds = (session) => [
  ...new Set(session.messages.flatMap((m) => (m.role === 'user' ? m.files.map((f) => f.id) : []))),
]
const summary = ({ id, title, createdAt, updatedAt }) => ({ id, title, createdAt, updatedAt })

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
  for (const m of session.messages) {
    if (
      !object(m) ||
      !validId(m.id) ||
      ids.has(m.id) ||
      !Number.isFinite(m.createdAt) ||
      !['user', 'assistant'].includes(m.role)
    )
      fail(400, '消息格式无效。')
    ids.add(m.id)
    if (
      m.role === 'user' &&
      (typeof m.content !== 'string' ||
        !Array.isArray(m.files) ||
        m.files.some(
          (f) =>
            !object(f) ||
            !validId(f.id) ||
            typeof f.name !== 'string' ||
            typeof f.isImage !== 'boolean' ||
            typeof f.mimeType !== 'string' ||
            !Number.isFinite(f.size)
        ))
    )
      fail(400, '附件格式无效。')
    if (
      m.role === 'assistant' &&
      (!Array.isArray(m.blocks) ||
        !['pending', 'streaming', 'done', 'stopped', 'error'].includes(m.status))
    )
      fail(400, '回答格式无效。')
  }
  return session
}

async function body(request, limit, json = true) {
  if (json && request.headers['content-type']?.split(';')[0] !== 'application/json')
    fail(415, '需要 JSON 请求。')
  if (Number(request.headers['content-length'] || 0) > limit) fail(413, '数据过大。')
  const chunks = []
  let size = 0
  for await (const chunk of request) {
    size += chunk.length
    if (size > limit) fail(413, '数据过大。')
    chunks.push(chunk)
  }
  const bytes = Buffer.concat(chunks)
  if (!json) return bytes
  try {
    return JSON.parse(bytes.toString('utf8'))
  } catch {
    fail(400, 'JSON 格式无效。')
  }
}

/** One database on the persistent volume; history replacements are one SQLite transaction. */
export function createDataStore(filename) {
  if (filename !== ':memory:') mkdirSync(dirname(filename), { recursive: true, mode: 0o700 })
  const db = new DatabaseSync(filename)
  db.exec(`
    PRAGMA journal_mode=WAL;
    PRAGMA synchronous=FULL;
    PRAGMA foreign_keys=ON;
    PRAGMA busy_timeout=5000;
    PRAGMA temp_store=MEMORY;
    CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS sessions (id TEXT PRIMARY KEY, json TEXT NOT NULL, revision TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS session_meta (id TEXT PRIMARY KEY, json TEXT NOT NULL, files TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS files (id TEXT PRIMARY KEY, mime TEXT NOT NULL, bytes BLOB NOT NULL);
    CREATE TABLE IF NOT EXISTS drafts (id TEXT PRIMARY KEY, json TEXT NOT NULL, revision TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, json TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS imports (id TEXT PRIMARY KEY, version TEXT NOT NULL, expires INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS staged_sessions (owner TEXT REFERENCES imports(id) ON DELETE CASCADE, id TEXT, json TEXT NOT NULL, PRIMARY KEY(owner,id));
    CREATE TABLE IF NOT EXISTS staged_files (owner TEXT REFERENCES imports(id) ON DELETE CASCADE, id TEXT, mime TEXT NOT NULL, bytes BLOB NOT NULL, PRIMARY KEY(owner,id));
  `)
  // Lists read compact metadata, so polling never loads every conversation body into memory.
  const indexSession = `
    INSERT OR REPLACE INTO session_meta
    SELECT new.id,
      json_object('id',new.id,'title',json_extract(new.json,'$.title'),
        'createdAt',json_extract(new.json,'$.createdAt'),'updatedAt',json_extract(new.json,'$.updatedAt')),
      (SELECT json_group_array(DISTINCT json_extract(f.value,'$.id'))
       FROM json_each(new.json,'$.messages') m, json_each(m.value,'$.files') f
       WHERE json_extract(m.value,'$.role')='user');
  `
  db.exec(`
    CREATE TRIGGER IF NOT EXISTS index_insert AFTER INSERT ON sessions BEGIN ${indexSession} END;
    CREATE TRIGGER IF NOT EXISTS index_update AFTER UPDATE ON sessions BEGIN ${indexSession} END;
    CREATE TRIGGER IF NOT EXISTS index_delete AFTER DELETE ON sessions BEGIN DELETE FROM session_meta WHERE id=old.id; END;
    UPDATE sessions SET revision=revision WHERE id NOT IN (SELECT id FROM session_meta);
  `)
  const getMeta = (key) => db.prepare('SELECT value FROM meta WHERE key=?').get(key).value
  const setMeta = (key, value) =>
    db.prepare('INSERT OR REPLACE INTO meta VALUES (?,?)').run(key, String(value))
  db.prepare('INSERT OR IGNORE INTO meta VALUES (?,?)').run('generation', randomUUID())
  db.prepare('INSERT OR IGNORE INTO meta VALUES (?,?)').run('version', '0')
  const changed = () => setMeta('version', Number(getMeta('version')) + 1)
  const transaction = (run) => {
    db.exec('BEGIN IMMEDIATE')
    try {
      const result = run()
      db.exec('COMMIT')
      return result
    } catch (error) {
      try {
        db.exec('ROLLBACK')
      } catch {
        // The statement may have already ended the transaction (e.g. an implicit rollback).
        // Do not mask the original error with a secondary rollback failure.
      }
      throw error
    }
  }
  const state = () => ({
    generation: getMeta('generation'),
    version: getMeta('version'),
    sessions: db
      .prepare('SELECT m.json,s.revision FROM session_meta m JOIN sessions s ON s.id=m.id')
      .all()
      .map((row) => ({ ...summary(JSON.parse(row.json)), revision: row.revision })),
  })
  const checkGeneration = (generation) => {
    if (generation !== getMeta('generation')) conflict()
  }
  const checkRevision = (row, revision) => {
    if ((row?.revision ?? null) !== revision) conflict()
  }
  const checkImport = (id) => {
    const row = db.prepare('SELECT * FROM imports WHERE id=?').get(id)
    if (!row || row.expires <= Date.now()) fail(410, '导入暂存已过期，请重新导入。')
    return row
  }
  const settings = () =>
    Object.fromEntries(
      db
        .prepare('SELECT * FROM settings')
        .all()
        .map((row) => [row.key, JSON.parse(row.json)])
    )
  const removeUnreferenced = (candidates) => {
    if (candidates.length === 0) return
    const referenced = new Set()
    for (const row of db.prepare('SELECT files FROM session_meta').all())
      for (const id of JSON.parse(row.files)) referenced.add(id)
    for (const row of db.prepare('SELECT json FROM drafts').all())
      for (const file of JSON.parse(row.json).attachments) referenced.add(file.id)
    for (const id of candidates)
      if (!referenced.has(id)) db.prepare('DELETE FROM files WHERE id=?').run(id)
  }
  const json = (response, value, status = 200) => {
    response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' })
    response.end(JSON.stringify(value))
  }
  let active = 0

  const handle = async (request, response) => {
    if (active >= 8) fail(429, '存储请求过多，请稍后重试。')
    active++
    try {
      const url = new URL(request.url, 'http://storage')
      if (url.search) fail(404, '接口不存在。')
      const parts = url.pathname
        .split('/')
        .slice(2)
        .map((part) => {
          try {
            return decodeURIComponent(part)
          } catch {
            fail(400, '标识无效。')
          }
        })
      const [kind, id, operation] = parts
      const method = request.method
      if (kind === 'state' && parts.length === 1 && method === 'GET') {
        json(response, state())
        return
      }
      if (kind === 'sessions' && parts.length === 2 && validId(id)) {
        const read = () => db.prepare('SELECT * FROM sessions WHERE id=?').get(id)
        if (method === 'GET') {
          const row = read()
          json(
            response,
            row
              ? {
                  session: JSON.parse(row.json),
                  revision: row.revision,
                  generation: getMeta('generation'),
                }
              : null,
            row ? 200 : 404
          )
          return
        }
        const input = await body(request, 32 * MiB)
        if (!object(input)) fail(400, '请求格式无效。')
        const result = transaction(() => {
          checkGeneration(input.generation)
          const row = read()
          checkRevision(row, input.revision)
          if (method === 'DELETE') {
            const candidates = row ? fileIds(JSON.parse(row.json)) : []
            const draft = db.prepare('SELECT json FROM drafts WHERE id=?').get(`session:${id}`)
            if (draft) candidates.push(...JSON.parse(draft.json).attachments.map((f) => f.id))
            db.prepare('DELETE FROM sessions WHERE id=?').run(id)
            if (draft)
              db.prepare('UPDATE drafts SET json=?,revision=? WHERE id=?').run(
                '{"text":"","attachments":[]}',
                randomUUID(),
                `session:${id}`
              )
            removeUnreferenced(candidates)
          } else if (method === 'PUT' || method === 'PATCH') {
            const session =
              method === 'PATCH'
                ? { ...JSON.parse(row?.json ?? 'null'), title: input.title }
                : input.session
            validateSession(session, id)
            const revision = randomUUID()
            db.prepare('INSERT OR REPLACE INTO sessions VALUES (?,?,?)').run(
              id,
              JSON.stringify(session),
              revision
            )
            changed()
            return { revision, generation: getMeta('generation') }
          } else fail(405, '方法不支持。')
          changed()
          return { ok: true }
        })
        json(response, result)
        return
      }
      if (kind === 'files' && parts.length === 2 && validId(id)) {
        if (method === 'GET') {
          const row = db.prepare('SELECT * FROM files WHERE id=?').get(id)
          if (!row) fail(404, '附件不存在。')
          response.writeHead(200, {
            'Content-Type': row.mime || 'application/octet-stream',
            'Content-Disposition': 'attachment',
          })
          response.end(row.bytes)
          return
        }
        if (method === 'PUT') {
          const bytes = await body(request, 64 * MiB, false)
          checkGeneration(request.headers['x-chat-generation'])
          // Immutable IDs prevent an old client from replacing another session's original.
          db.prepare('INSERT OR IGNORE INTO files VALUES (?,?,?)').run(
            id,
            request.headers['content-type'] || '',
            bytes
          )
          json(response, { ok: true })
          return
        }
      }
      if (kind === 'settings' && parts.length === 1) {
        if (method === 'GET') {
          json(response, settings())
          return
        }
        if (method === 'PATCH') {
          const input = await body(request, 8192)
          const validators = {
            locale: (v) => ['zh-CN', 'en-US'].includes(v),
            themePreference: (v) => ['system', 'dark', 'light'].includes(v),
            ttsVoice: (v) => ['stella', 'tide'].includes(v),
            location: (v) =>
              v === null ||
              (object(v) && typeof v.region === 'string' && /^[A-Z]{2}$/.test(v.region)),
            thinking: (v) => typeof v === 'boolean',
            search: (v) => typeof v === 'boolean',
            siderCollapsed: (v) => typeof v === 'boolean',
          }
          if (
            !object(input) ||
            Object.entries(input).some(
              ([key, value]) => !Object.hasOwn(validators, key) || !validators[key](value)
            )
          )
            fail(400, '设置格式无效。')
          transaction(() => {
            for (const [key, value] of Object.entries(input))
              db.prepare('INSERT OR REPLACE INTO settings VALUES (?,?)').run(
                key,
                JSON.stringify(value)
              )
          })
          json(response, settings())
          return
        }
      }
      if (kind === 'drafts' && parts.length === 1 && method === 'GET') {
        json(response, {
          generation: getMeta('generation'),
          drafts: db
            .prepare('SELECT * FROM drafts')
            .all()
            .map((row) => ({ id: row.id, draft: JSON.parse(row.json), revision: row.revision })),
        })
        return
      }
      if (kind === 'drafts' && parts.length === 2 && validId(id) && method === 'PUT') {
        const input = await body(request, 2 * MiB)
        if (!object(input)) fail(400, '请求格式无效。')
        const result = transaction(() => {
          checkGeneration(input.generation)
          const previous = db.prepare('SELECT * FROM drafts WHERE id=?').get(id)
          checkRevision(previous, input.revision)
          if (
            id !== 'new' &&
            (!id.startsWith('session:') ||
              !db.prepare('SELECT id FROM sessions WHERE id=?').get(id.slice(8)))
          )
            conflict()
          if (
            !object(input.draft) ||
            typeof input.draft.text !== 'string' ||
            !Array.isArray(input.draft.attachments) ||
            input.draft.attachments.some(
              (f) =>
                !object(f) ||
                !validId(f.id) ||
                typeof f.name !== 'string' ||
                typeof f.isImage !== 'boolean'
            )
          )
            fail(400, '草稿格式无效。')
          // Keep empty tombstones so stale clients cannot resurrect a sent/deleted draft.
          const revision = randomUUID()
          db.prepare('INSERT OR REPLACE INTO drafts VALUES (?,?,?)').run(
            id,
            JSON.stringify(input.draft),
            revision
          )
          if (previous) removeUnreferenced(JSON.parse(previous.json).attachments.map((f) => f.id))
          return { revision, generation: getMeta('generation') }
        })
        json(response, result)
        return
      }
      if (kind === 'imports') {
        if (parts.length === 1 && method === 'POST') {
          db.prepare('DELETE FROM imports WHERE expires<=?').run(Date.now())
          if (db.prepare('SELECT COUNT(*) AS n FROM imports').get().n >= 8)
            fail(429, '导入任务过多，请稍后重试。')
          const id = randomUUID()
          db.prepare('INSERT INTO imports VALUES (?,?,?)').run(
            id,
            getMeta('version'),
            Date.now() + 24 * 60 * 60 * 1000
          )
          json(response, { id })
          return
        }
        if (!validId(id)) fail(400, '导入标识无效。')
        if (parts.length === 2 && method === 'DELETE') {
          db.prepare('DELETE FROM imports WHERE id=?').run(id)
          json(response, { ok: true })
          return
        }
        checkImport(id)
        if (parts.length === 3 && operation === 'commit' && method === 'POST') {
          // mode lives in an optional JSON body. Legacy clients send no body / no Content-Type,
          // which defaults to 'replace' so their behavior (and "clear all = empty replace") is unchanged.
          const hasJson = request.headers['content-type']?.split(';')[0] === 'application/json'
          const input = hasJson ? await body(request, 4096) : {}
          const mode = object(input) && input.mode !== undefined ? input.mode : 'replace'
          if (mode !== 'append' && mode !== 'replace') fail(400, '导入模式无效。')
          const result = transaction(() => {
            if (checkImport(id).version !== getMeta('version')) conflict()
            let importedCount = 0
            let skippedCount = 0
            if (mode === 'append') {
              // Keep every existing chat, draft and original. Import only ids not already present.
              skippedCount = db
                .prepare(
                  'SELECT COUNT(*) AS n FROM staged_sessions s JOIN sessions t ON t.id=s.id WHERE s.owner=?'
                )
                .get(id).n
              importedCount = db.prepare('SELECT COUNT(*) AS n FROM staged_sessions WHERE owner=?').get(id).n - skippedCount
              db.prepare(
                `INSERT INTO sessions(id,json,revision)
                 SELECT s.id,s.json,lower(hex(randomblob(16))) FROM staged_sessions s
                 WHERE s.owner=? AND NOT EXISTS (SELECT 1 FROM sessions t WHERE t.id=s.id)`
              ).run(id)
              // Originals are immutable by id; OR IGNORE preserves existing/shared originals.
              db.prepare(
                'INSERT OR IGNORE INTO files(id,mime,bytes) SELECT id,mime,bytes FROM staged_files WHERE owner=?'
              ).run(id)
            } else {
              db.exec('DELETE FROM sessions; DELETE FROM files; DELETE FROM drafts;')
              db.prepare(
                'INSERT INTO sessions SELECT id,json,lower(hex(randomblob(16))) FROM staged_sessions WHERE owner=?'
              ).run(id)
              db.prepare('INSERT INTO files SELECT id,mime,bytes FROM staged_files WHERE owner=?').run(id)
              importedCount = db.prepare('SELECT COUNT(*) AS n FROM staged_sessions WHERE owner=?').get(id).n
            }
            db.prepare('DELETE FROM imports WHERE id=?').run(id)
            setMeta('generation', randomUUID())
            changed()
            return { ...state(), importedCount, skippedCount }
          })
          json(response, result)
          return
        }
        if (parts.length === 3 && operation === 'types' && method === 'PATCH') {
          const types = await body(request, 8 * MiB)
          if (!object(types) || Object.values(types).some((v) => typeof v !== 'string'))
            fail(400, '附件类型无效。')
          transaction(() => {
            for (const row of db
              .prepare('SELECT id,json FROM staged_sessions WHERE owner=?')
              .all(id)) {
              const session = JSON.parse(row.json)
              for (const message of session.messages)
                if (message.role === 'user') {
                  for (const file of message.files)
                    file.mimeType = Object.hasOwn(types, file.id) ? types[file.id] : ''
                }
              db.prepare('UPDATE staged_sessions SET json=? WHERE owner=? AND id=?').run(
                JSON.stringify(session),
                id,
                row.id
              )
            }
          })
          json(response, { ok: true })
          return
        }
        if (parts.length === 3 && operation === 'sessions' && method === 'PUT') {
          // Batch staging: one request carries many sessions so a large history does not need
          // thousands of round trips (each of which can be dropped by the tunnel). Staging is
          // temporary and cleared on failure, so idempotent per-row upserts need no transaction.
          const sessions = await body(request, 64 * MiB)
          if (!Array.isArray(sessions)) fail(400, '请求格式无效。')
          checkImport(id)
          const insert = db.prepare('INSERT OR REPLACE INTO staged_sessions VALUES (?,?,?)')
          for (const session of sessions) {
            validateSession(session, session?.id)
            insert.run(id, session.id, JSON.stringify(session))
          }
          json(response, { ok: true })
          return
        }
        if (parts.length === 4 && validId(parts[3]) && method === 'PUT') {
          const entryId = parts[3]
          if (operation === 'sessions') {
            const session = validateSession(await body(request, 32 * MiB), entryId)
            checkImport(id)
            db.prepare('INSERT OR REPLACE INTO staged_sessions VALUES (?,?,?)').run(
              id,
              entryId,
              JSON.stringify(session)
            )
          } else if (operation === 'files') {
            const bytes = await body(request, 64 * MiB, false)
            checkImport(id)
            db.prepare('INSERT OR REPLACE INTO staged_files VALUES (?,?,?,?)').run(
              id,
              entryId,
              request.headers['content-type'] || '',
              bytes
            )
          } else fail(404, '接口不存在。')
          json(response, { ok: true })
          return
        }
      }
      fail(404, '接口不存在。')
    } finally {
      active--
    }
  }
  return { handle, close: () => db.close() }
}
