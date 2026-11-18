import {
  retryStorage,
  StorageError,
  storageJson,
  storageRequest,
} from '../serverStorage.js'
import type { StoredFile } from './localDb.js'
import type {
  CommitSummary,
  ImportMode,
  Session,
  SessionSearchResult,
  SessionSummary,
} from './types.js'
import type { UsageReport } from './usage.js'

type Version = { revision: string | null; generation: string }
export type ServerState = {
  generation: string
  version: string
  sessions: (SessionSummary & { revision: string })[]
}
export type CommitResult = ServerState & { importedCount: number; skippedCount: number }
let generation = ''
export const getKnownGeneration = () => generation
const versions = new Map<string, Version>()
const uploadedFiles = new Map<string, string>()
let queue: Promise<unknown> = Promise.resolve()
const enqueue = <T>(run: () => Promise<T>): Promise<T> => {
  const task = queue.then(run)
  queue = task.catch(() => {})
  return task
}
const path = (kind: string, id: string) => `${kind}/${encodeURIComponent(id)}`
export const getGeneration = async () => {
  if (!generation) {
    generation = (await readServerState()).generation
  }
  return generation
}
/** 上次成功拉取的摘要，供下次打开时先渲染；版本不符会被服务端纠正。 */
const SNAPSHOT_KEY = 'chat-demo:state-snapshot'
const loadSnapshot = (): ServerState | null => {
  try {
    const value = JSON.parse(localStorage.getItem(SNAPSHOT_KEY) ?? 'null') as unknown
    if (
      value === null ||
      typeof value !== 'object' ||
      typeof (value as ServerState).version !== 'string' ||
      typeof (value as ServerState).generation !== 'string' ||
      !Array.isArray((value as ServerState).sessions)
    ) {
      return null
    }
    return value as ServerState
  } catch {
    return null
  }
}
const saveSnapshot = (state: ServerState) => {
  try {
    localStorage.setItem(SNAPSHOT_KEY, JSON.stringify(state))
  } catch {
    // 存储不可用时只是失去首屏加速
  }
}
/** Last full state; lets unchanged polls answer with a tiny marker. */
let cachedState: ServerState | null = loadSnapshot()
/** 同步取上次的摘要用于首屏；没有快照时返回 null。 */
export const peekSessionSummaries = (): SessionSummary[] | null => cachedState?.sessions ?? null
export const readServerState = async (): Promise<ServerState> => {
  const previous = cachedState
  if (previous) {
    const reply = await storageJson<ServerState | { unchanged: true }>('state', 'POST', {
      since: previous.version,
      generation: previous.generation,
    })
    if ('unchanged' in reply) {
      return previous
    }
    cachedState = reply
    generation = reply.generation
    saveSnapshot(reply)
    return reply
  }
  const state = await storageJson<ServerState>('state')
  cachedState = state
  generation = state.generation
  saveSnapshot(state)
  return state
}
export const isSessionCurrent = (id: string, revision: string, remoteGeneration: string) => {
  const version = versions.get(id)
  return version?.revision === revision && version.generation === remoteGeneration
}
export const loadSessionSummaries = async (): Promise<SessionSummary[]> =>
  (await readServerState()).sessions
/** 服务端全文搜索：先等在途写入，避免刚保存的会话搜不到。 */
export const searchSessions = async (query: string): Promise<SessionSearchResult> => {
  await queue
  return storageJson<SessionSearchResult>('search', 'POST', { query })
}
/** 最近 24 小时用量：同样先等在途写入，避免刚结束的回复统计不到。 */
export const loadUsage = async (): Promise<UsageReport> => {
  await queue
  return storageJson<UsageReport>('usage')
}
export const loadSession = async (id: string): Promise<Session | undefined> => {
  await queue
  try {
    const result = await storageJson<Version & { session: Session }>(path('sessions', id))
    versions.set(id, { revision: result.revision, generation: result.generation })
    return result.session
  } catch (error) {
    if (error instanceof StorageError && error.status === 404) {
      return undefined
    }
    throw error
  }
}
const putFiles = async (
  files: StoredFile[],
  prefix = 'files',
  currentGeneration = generation,
  retry = false
) => {
  for (const file of files) {
    if (prefix === 'files' && uploadedFiles.get(file.id) === currentGeneration) {
      continue
    }
    const upload = () =>
      storageRequest(path(prefix, file.id), {
        method: 'PUT',
        headers: {
          'Content-Type': file.blob.type || 'application/octet-stream',
          'X-Chat-Generation': currentGeneration,
        },
        body: file.blob,
      })
    if (retry) {
      await retryStorage(upload)
    } else {
      await upload()
    }
    if (prefix === 'files') {
      uploadedFiles.set(file.id, currentGeneration)
    }
  }
}
export const saveSession = (session: Session, files: StoredFile[] = []): Promise<void> =>
  enqueue(async () => {
    const version = versions.get(session.id) ?? {
      revision: null,
      generation: await getGeneration(),
    }
    await putFiles(files, 'files', version.generation)
    const result = await storageJson<Version>(path('sessions', session.id), 'PUT', {
      ...version,
      session,
    })
    versions.set(session.id, result)
  })
export const renameSession = (id: string, title: string): Promise<void> =>
  enqueue(async () => {
    // Unopened sessions have no local snapshot. Read a version for the atomic rename.
    const version = versions.get(id) ?? (await storageJson<Version>(path('sessions', id)))
    const result = await storageJson<Version>(path('sessions', id), 'PATCH', { ...version, title })
    versions.set(id, result)
  })
export const deleteSession = (id: string): Promise<void> =>
  enqueue(async () => {
    const version = versions.get(id) ?? (await storageJson<Version>(path('sessions', id)))
    await storageJson(path('sessions', id), 'DELETE', version)
    versions.delete(id)
  })
export const saveFiles = (files: StoredFile[]): Promise<void> =>
  enqueue(async () => putFiles(files, 'files', await getGeneration()))
export const loadFile = async (id: string): Promise<Blob | undefined> => {
  try {
    const blob = await (await storageRequest(path('files', id))).blob()
    if (generation) {
      uploadedFiles.set(id, generation)
    }
    return blob
  } catch (error) {
    if (error instanceof StorageError && error.status === 404) {
      return undefined
    }
    throw error
  }
}

// Each import has its own server-side staging area and a history version at start.
let stagingId: string | undefined
const staging = async () => {
  if (!stagingId) {
    stagingId = (await storageJson<{ id: string }>('imports', 'POST')).id
  }
  return `imports/${stagingId}`
}
export const clearStaging = async (): Promise<void> => {
  await queue
  if (stagingId) {
    await retryStorage(() => storageJson(`imports/${stagingId}`, 'DELETE'))
  }
  stagingId = undefined
  // Do not eagerly create a new task here: staging() creates one lazily on first write.
  // Eager creation leaked a never-used task on every failed import (capped at 8 by the server).
}
export const addStagingSession = async (session: Session): Promise<void> => {
  await retryStorage(
    async () => storageJson(path(`${await staging()}/sessions`, session.id), 'PUT', session),
    [400]
  )
}
/** 批量写入会话暂存：一次请求携带多个会话，减少经过隧道的请求数量。 */
export const addStagingSessions = async (sessions: Session[]): Promise<void> => {
  await retryStorage(async () => storageJson(`${await staging()}/sessions`, 'PUT', sessions), [400])
}
export const saveStagingFiles = async (files: StoredFile[]): Promise<void> =>
  putFiles(files, `${await staging()}/files`, generation, true)
export const updateStagingFileTypes = async (types: ReadonlyMap<string, string>): Promise<void> => {
  await retryStorage(
    async () => storageJson(`${await staging()}/types`, 'PATCH', Object.fromEntries(types)),
    [400]
  )
}
export const commitStaging = async (
  mode: ImportMode = 'replace'
): Promise<CommitSummary<SessionSummary & { revision: string }>> => {
  const state = await storageJson<CommitResult>(`${await staging()}/commit`, 'POST', { mode })
  generation = state.generation
  versions.clear()
  uploadedFiles.clear()
  stagingId = undefined
  window.dispatchEvent(new Event('chat-history-replaced'))
  return { sessions: state.sessions, importedCount: state.importedCount, skippedCount: state.skippedCount }
}
