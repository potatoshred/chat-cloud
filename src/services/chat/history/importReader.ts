import type { Session } from '../types.js'
import { BackupError, fail } from './errors.js'
import type { SessionIndexEntry } from './format.js'
import { INDEX_PATH, MANIFEST_PATH, USER_PATH, parseSessionPath, sessionFilesDir } from './paths.js'
import { checkManifest, readSessionFile, readSessionIndex } from './schema.js'
import { toLocalSession } from './toLocal.js'
import {
  ArchiveError,
  isZipFile,
  readArchive,
  readEntry,
  readTextEntry,
  skipEntry,
  type ArchiveEntry,
} from './zipReader.js'

export type ImportProgress = {
  parsedSessions: number
  sessions: number
  files: number
  phase: 'reading' | 'importing' | 'finalizing'
  /** 会话批次准备与写入的累计墙钟耗时；两者可重叠，不能相加当作总耗时。 */
  readMs?: number
  saveMs?: number
  waitingForSave?: boolean
}
export type ImportReaderOptions = { edge: boolean; existingIds: string[]; server?: boolean }
export type ImportChunk =
  | { type: 'sessions'; sessions: Session[] }
  | { type: 'sessionsJson'; json: string; count: number }
  | { type: 'file'; id: string; blob: Blob; mime: string; name: string }
  | {
      type: 'complete'
      types: Map<string, string>
      skippedSessions: string[]
      skippedExisting: string[]
    }

export const readJson = async (entry: ArchiveEntry): Promise<unknown> => {
  const text = await readTextEntry(entry)
  try {
    return JSON.parse(text)
  } catch {
    return fail('backupInvalidJson')
  }
}

const imageType = (bytes: Uint8Array): string => {
  const startsWith = (...prefix: number[]) => prefix.every((byte, index) => bytes[index] === byte)
  const header = new TextDecoder('ascii').decode(bytes.subarray(0, 12))
  if (startsWith(0xff, 0xd8, 0xff)) {
    return 'image/jpeg'
  }
  if (startsWith(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a)) {
    return 'image/png'
  }
  if (header.startsWith('GIF87a') || header.startsWith('GIF89a')) {
    return 'image/gif'
  }
  if (header.startsWith('RIFF') && header.slice(8, 12) === 'WEBP') {
    return 'image/webp'
  }
  if (startsWith(0x42, 0x4d)) {
    return 'image/bmp'
  }
  if (startsWith(0x49, 0x49, 0x2a, 0) || startsWith(0x4d, 0x4d, 0, 0x2a)) {
    return 'image/tiff'
  }
  if (header.slice(4, 8) === 'ftyp' && ['avif', 'avis'].includes(header.slice(8, 12))) {
    return 'image/avif'
  }
  return ''
}

/** 仅处理归档，不访问页面或存储。每次拉取最多准备一批，上传速度决定解包速度。 */
export async function* readImport(
  file: File,
  options: ImportReaderOptions,
  onParsed: (count: number) => void,
  signal?: AbortSignal
): AsyncGenerator<ImportChunk> {
  const existing = new Set(options.existingIds)
  const seen = new Set<string>()
  const images = new Map<string, string>()
  const stored = new Map<string, string>()
  const skippedSessions: string[] = []
  const skippedExisting: string[] = []
  const batchCount = options.edge ? 20 : 25
  const batchBytes = options.edge ? 256 * 1024 : 12 * 1024 * 1024
  const encoder = new TextEncoder()
  let sessions: Session[] = []
  let sessionJson: string[] = []
  let bytes = 0
  let manifest = false
  let index: SessionIndexEntry[] | undefined
  let currentSessionId: string | undefined
  let reportedAt = 0
  let yieldedAt = performance.now()
  const takeSessions = (): ImportChunk => {
    onParsed(seen.size)
    reportedAt = performance.now()
    const chunk: ImportChunk = options.server
      ? { type: 'sessionsJson', json: `[${sessionJson.join(',')}]`, count: sessions.length }
      : { type: 'sessions', sessions }
    sessions = []
    sessionJson = []
    bytes = 0
    return chunk
  }
  try {
    if (!(await isZipFile(file))) {
      fail('backupUnrecognized')
    }
    for await (const entry of readArchive(file)) {
      signal?.throwIfAborted()
      // Worker 不需要主动让出；不支持 Worker 的环境每约 12ms 交还页面执行权。
      if (signal && performance.now() - yieldedAt >= 12) {
        await new Promise<void>((resolve) => setTimeout(resolve, 0))
        yieldedAt = performance.now()
        signal.throwIfAborted()
      }
      const { path } = entry
      const sessionId = parseSessionPath(path)
      if (!manifest) {
        if (path !== MANIFEST_PATH) {
          fail('backupUnrecognized')
        }
        checkManifest(await readJson(entry))
        manifest = true
      } else if (path === USER_PATH && !index && seen.size === 0) {
        await skipEntry(entry)
      } else if (sessionId !== null && !index) {
        const local = toLocalSession(readSessionFile(await readJson(entry)))
        if (local.session.id !== sessionId || seen.has(sessionId)) {
          fail('backupIncomplete')
        }
        seen.add(sessionId)
        currentSessionId = sessionId
        if (seen.size === 1 || performance.now() - reportedAt >= 100) {
          onParsed(seen.size)
          reportedAt = performance.now()
        }
        if (existing.has(sessionId)) {
          if (skippedExisting.length < 20) {
            skippedExisting.push(local.session.title || sessionId)
          }
        } else {
          const json = JSON.stringify(local.session)
          const size = encoder.encode(json).byteLength
          if (options.edge && size > 1_900_000) {
            if (skippedSessions.length < 20) {
              skippedSessions.push(local.session.title || sessionId)
            }
          } else {
            // 接近单会话上限的记录单独上传，避免外加前一批后超过请求体上限。
            if (size >= batchBytes && sessions.length) {
              yield takeSessions()
            }
            for (const [imagePath, id] of local.images) {
              images.set(imagePath, id)
            }
            sessions.push(local.session)
            if (options.server) {
              sessionJson.push(json)
            }
            bytes += size
            if (sessions.length >= batchCount || bytes >= batchBytes) {
              yield takeSessions()
            }
          }
        }
      } else if (path === INDEX_PATH && !index) {
        index = readSessionIndex(await readJson(entry))
        if (sessions.length) {
          yield takeSessions()
        }
      } else if (
        index
          ? seen.has(/^chat_sessions\/([^/]+)_files\//.exec(path)?.[1] ?? '')
          : currentSessionId && path.startsWith(sessionFilesDir(currentSessionId))
      ) {
        // 跳过的会话及未引用、重复的图片仍校验 CRC，但不上传。
        const id = images.get(path)
        if (id === undefined || stored.has(id)) {
          await skipEntry(entry)
          continue
        }
        if (sessions.length) {
          yield takeSessions()
        }
        const blob = await readEntry(entry)
        const mime = imageType(new Uint8Array(await blob.slice(0, 16).arrayBuffer()))
        stored.set(id, mime)
        yield { type: 'file', id, blob, mime, name: path.split('/').pop() ?? id }
      } else {
        fail('backupIncomplete')
      }
    }
  } catch (error) {
    throw error instanceof ArchiveError ? new BackupError('backupIncomplete') : error
  }
  if (!manifest) {
    fail('backupUnrecognized')
  }
  const listed = new Set(index?.map((entry) => entry.id))
  if (
    !index ||
    listed.size !== index.length ||
    listed.size !== seen.size ||
    [...seen].some((id) => !listed.has(id))
  ) {
    fail('backupIncomplete')
  }
  if (sessions.length) {
    yield takeSessions()
  }
  onParsed(seen.size)
  yield { type: 'complete', types: stored, skippedSessions, skippedExisting }
}
