import assert from 'node:assert/strict'
import { File } from 'node:buffer'
import { mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'
import { after, before, test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { zipSync } from 'fflate'
import { rspack } from '@rspack/core'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const require = createRequire(import.meta.url)
let directory
let readImport
let readArchive
let readEntry

// 与前端使用相同的编译器和模块，测试无需浏览器或远端数据库。
before(async () => {
  directory = await mkdtemp(path.join(os.tmpdir(), 'chat-import-test-'))
  const compiler = rspack({
    mode: 'none',
    target: 'node',
    context: root,
    entry: {
      reader: './src/services/chat/history/importReader.ts',
      zip: './src/services/chat/history/zipReader.ts',
    },
    output: { path: directory, filename: '[name].cjs', library: { type: 'commonjs2' } },
    resolve: { extensions: ['.ts', '.js'], extensionAlias: { '.js': ['.ts', '.js'] } },
    module: {
      rules: [
        {
          test: /\.ts$/,
          loader: 'builtin:swc-loader',
          options: { jsc: { parser: { syntax: 'typescript' }, target: 'es2022' } },
        },
      ],
    },
  })
  try {
    await new Promise((resolve, reject) =>
      compiler.run((error, stats) => {
        if (error) reject(error)
        else if (stats.hasErrors()) reject(new Error(stats.toString({ all: false, errors: true })))
        else resolve()
      })
    )
  } finally {
    await new Promise((resolve, reject) =>
      compiler.close((error) => (error ? reject(error) : resolve()))
    )
  }
  ;({ readImport } = require(path.join(directory, 'reader.cjs')))
  ;({ readArchive, readEntry } = require(path.join(directory, 'zip.cjs')))
})
after(async () => {
  if (directory) await rm(directory, { recursive: true, force: true })
})

const now = '2026-01-01T00:00:00.000Z'
const png = Uint8Array.from([137, 80, 78, 71, 13, 10, 26, 10])
const json = (value) => new TextEncoder().encode(JSON.stringify(value))
const session = (id, content = '中文会话🙂', attachment = false) => ({
  id,
  title: id,
  current_message_id: 1,
  inserted_at: now,
  updated_at: now,
  messages: [
    {
      id: 1,
      parent_id: null,
      role: 'USER',
      status: 'FINISHED',
      thinking_enabled: false,
      search_enabled: false,
      accumulated_token_usage: 0,
      inserted_at: now,
      fragments: [
        { type: 'REQUEST', content },
        ...(attachment
          ? [
              {
                type: 'FILE',
                files: [
                  {
                    id: 'photo',
                    file_name: 'photo.png',
                    file_size: png.length,
                    token_usage: null,
                    inserted_at: now,
                    export_path: `chat_sessions/${id}_files/photo.png`,
                    is_image: true,
                    width: 1,
                    height: 1,
                  },
                ],
              },
            ]
          : []),
      ],
    },
  ],
})
const archive = (sessions, { interleaved = false, badIndex = false } = {}) => {
  const files = { 'manifest.json': json({ export_format_version: 3 }) }
  const attachments = {}
  for (const item of sessions) {
    files[`chat_sessions/${item.id}.json`] = json(item)
    if (item.messages[0].fragments.some((fragment) => fragment.type === 'FILE')) {
      ;(interleaved ? files : attachments)[`chat_sessions/${item.id}_files/photo.png`] = png
    }
  }
  files['chat_session_index.json'] = json(
    (badIndex ? sessions.slice(1) : sessions).map((item) => ({
      id: item.id,
      title: item.title,
      message_count: item.messages.length,
      inserted_at: now,
      updated_at: now,
    }))
  )
  Object.assign(files, attachments)
  return new File([zipSync(files)], 'history.zip')
}
const collect = async (file, options = {}) => {
  const progress = []
  const chunks = []
  for await (const chunk of readImport(file, { edge: true, existingIds: [], ...options }, (count) =>
    progress.push(count)
  ))
    chunks.push(chunk)
  return {
    chunks,
    sessions: chunks
      .filter((chunk) => chunk.type === 'sessions')
      .flatMap((chunk) => chunk.sessions),
    progress,
    result: chunks.at(-1),
  }
}

test('reads many sessions with bounded batches and few file reads', async () => {
  const file = archive(Array.from({ length: 1000 }, (_, i) => session(`s${i}`)))
  const slice = file.slice.bind(file)
  let reads = 0
  file.slice = (...args) => {
    reads++
    return slice(...args)
  }
  const result = await collect(file)
  assert.equal(result.sessions.length, 1000)
  assert.ok(
    result.chunks
      .filter((chunk) => chunk.type === 'sessions')
      .every((chunk) => chunk.sessions.length <= 20)
  )
  assert.ok(reads < 100, `unexpected small file reads: ${reads}`)
  assert.equal(result.progress.at(-1), 1000)
  assert.ok(result.progress.every((count, index) => !index || count >= result.progress[index - 1]))
})

test('stream decoding preserves Chinese text and emoji across chunk boundaries', async () => {
  const content = '中文🙂𠀀'.repeat(10000)
  const result = await collect(archive([session('s', content)]))
  assert.equal(result.sessions[0].messages[0].content, content)
})

test('skips existing sessions and their attachments in both archive layouts', async () => {
  for (const interleaved of [false, true]) {
    const result = await collect(
      archive([session('old', '已有', true), session('new')], { interleaved }),
      { existingIds: ['old'] }
    )
    assert.deepEqual(
      result.sessions.map((item) => item.id),
      ['new']
    )
    assert.equal(result.chunks.filter((chunk) => chunk.type === 'file').length, 0)
    assert.deepEqual(result.result.skippedExisting, ['old'])
  }
})

test('large sessions use individual requests and oversized sessions are skipped', async () => {
  const result = await collect(
    archive([
      session('small'),
      session('large', '大'.repeat(610000)),
      session('oversized', '大'.repeat(650000)),
    ])
  )
  assert.deepEqual(
    result.sessions.map((item) => item.id),
    ['small', 'large']
  )
  assert.ok(
    result.chunks
      .filter((chunk) => chunk.type === 'sessions')
      .every((chunk) => chunk.sessions.length === 1)
  )
  assert.deepEqual(result.result.skippedSessions, ['oversized'])
})

test('container imports retain sessions above the D1 row limit', async () => {
  const result = await collect(archive([session('large', '大'.repeat(650000))]), { edge: false })
  assert.equal(result.sessions.length, 1)
  assert.deepEqual(result.result.skippedSessions, [])
})

test('attachment identity, bytes and MIME survive import', async () => {
  const result = await collect(archive([session('s', '图片', true)]))
  const chunk = result.chunks.find((chunk) => chunk.type === 'file')
  assert.equal(chunk.id, 'photo')
  assert.equal(chunk.mime, 'image/png')
  assert.deepEqual(new Uint8Array(await chunk.blob.arrayBuffer()), png)
  assert.equal(result.result.types.get('photo'), 'image/png')
})

test('rejects an index mismatch even after staging batches', async () => {
  await assert.rejects(
    collect(
      archive(
        Array.from({ length: 30 }, (_, i) => session(`s${i}`)),
        { badIndex: true }
      )
    ),
    { key: 'backupIncomplete' }
  )
})

test('detects CRC damage after earlier sessions have been read', async () => {
  const file = archive(Array.from({ length: 30 }, (_, i) => session(`s${i}`)))
  const bytes = new Uint8Array(await file.arrayBuffer())
  const view = new DataView(bytes.buffer)
  const name = new TextDecoder()
  let target
  for (let offset = 0; offset + 46 < bytes.length; offset++) {
    if (view.getUint32(offset, true) !== 0x02014b50) continue
    const length = view.getUint16(offset + 28, true)
    if (name.decode(bytes.subarray(offset + 46, offset + 46 + length)) !== 'chat_sessions/s25.json')
      continue
    target = view.getUint32(offset + 42, true)
    const crc = view.getUint32(offset + 16, true) ^ 1
    view.setUint32(offset + 16, crc, true)
    view.setUint32(target + 14, crc, true)
    break
  }
  assert.ok(target)
  await assert.rejects(collect(new File([bytes], 'corrupt.zip')), { key: 'backupIncomplete' })
})

test('reads headers and payloads crossing the cache window boundary', async () => {
  const payload = Uint8Array.from({ length: 2560000 }, (_, i) => i & 255)
  const file = new File(
    [zipSync({ padding: new Uint8Array(1024 * 1024 - 47), '跨边界🙂.bin': payload }, { level: 0 })],
    'boundary.zip'
  )
  let count = 0
  for await (const entry of readArchive(file)) {
    const data = new Uint8Array(await (await readEntry(entry)).arrayBuffer())
    if (entry.path === '跨边界🙂.bin') assert.deepEqual(data, payload)
    count++
  }
  assert.equal(count, 2)
})

test('fallback parser stops when the import is cancelled', async () => {
  const controller = new AbortController()
  const reader = readImport(
    archive(Array.from({ length: 30 }, (_, i) => session(`s${i}`))),
    { edge: true, existingIds: [] },
    () => {},
    controller.signal
  )
  await reader.next()
  controller.abort()
  await assert.rejects(reader.next(), { name: 'AbortError' })
})

test('server batches are serialized off the page thread without changing session data', async () => {
  const sessions = [session('small', '中文🙂'), session('large', '大'.repeat(610000))]
  const local = await collect(archive(sessions))
  const remote = await collect(archive(sessions), { server: true })
  const batches = remote.chunks.filter((chunk) => chunk.type === 'sessionsJson')
  assert.equal(remote.sessions.length, 0)
  assert.deepEqual(
    batches.flatMap((chunk) => JSON.parse(chunk.json)),
    JSON.parse(JSON.stringify(local.sessions))
  )
  assert.ok(batches.every((chunk) => JSON.parse(chunk.json).length === chunk.count))
})
