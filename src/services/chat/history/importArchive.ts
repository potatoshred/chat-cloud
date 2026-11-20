import * as db from '../db.js'
import type { StoredFile } from '../localDb.js'
import { BackupError, fail } from './errors.js'
import { EDGE_API, SERVER_API } from '../../api/config.js'
import { addStagingSessionsJson } from '../serverDb.js'
import { compressImage, isCompressibleImage } from '../../attachments.js'
import { readImportChunks } from './importClient.js'
import { readJson, type ImportChunk, type ImportProgress } from './importReader.js'
import { MANIFEST_PATH } from './paths.js'
import { checkManifest } from './schema.js'
import { ArchiveError, isZipFile, readArchive } from './zipReader.js'

export type { ImportProgress } from './importReader.js'

/** 暂存与正式附件峰值各占一份，免费版每个归档最多保存 100MB 附件。 */
const EDGE_FILE_BUDGET = 100 * 1024 * 1024
let skipped = { files: [] as string[], sessions: [] as string[], existing: [] as string[] }
export const takeSkippedFiles = () => {
  const result = skipped
  skipped = { files: [], sessions: [], existing: [] }
  return result
}

/** 检查通过后才停止正在生成的回答，错误归档不影响现有会话。 */
export const checkArchiveFormat = async (file: File): Promise<void> => {
  if (!(await isZipFile(file))) {
    fail('backupUnrecognized')
  }
  try {
    for await (const entry of readArchive(file)) {
      if (entry.path !== MANIFEST_PATH) {
        fail('backupUnrecognized')
      }
      checkManifest(await readJson(entry))
      return
    }
  } catch (error) {
    throw error instanceof ArchiveError ? new BackupError('backupIncomplete') : error
  }
  fail('backupUnrecognized')
}

/**
 * 解包与转换在浏览器 Worker 中执行。始终只上传一批，同时最多预读下一批；
 * 校验失败或上传失败先停止后台读取，之后由调用方清理暂存，正式记录保持原状。
 */
export const importArchive = async (
  file: File,
  onProgress?: (progress: ImportProgress) => void,
  options: { skipExisting?: boolean } = {}
): Promise<void> => {
  skipped = { files: [], sessions: [], existing: [] }
  const existingIds = options.skipExisting
    ? (await db.loadSessionSummaries()).map((summary) => summary.id)
    : []
  const progress: ImportProgress = {
    parsedSessions: 0,
    sessions: 0,
    files: 0,
    phase: 'reading',
    readMs: 0,
    saveMs: 0,
  }
  let reading = false
  let saving = false
  const report = () => onProgress?.({ ...progress, waitingForSave: saving && !reading })
  const controller = new AbortController()
  const reader = readImportChunks(
    file,
    { edge: EDGE_API, server: SERVER_API, existingIds },
    (count) => {
      progress.parsedSessions = count
      progress.phase = 'importing'
      report()
    },
    controller.signal
  )
  let pendingFiles: StoredFile[] = []
  let pendingFileBytes = 0
  let importedFileBytes = 0
  const batchCount = EDGE_API ? 20 : 25
  const batchBytes = EDGE_API ? 256 * 1024 : 12 * 1024 * 1024
  const flushFiles = async () => {
    if (!pendingFiles.length) {
      return
    }
    await db.saveStagingFiles(pendingFiles)
    progress.files += pendingFiles.length
    pendingFiles = []
    pendingFileBytes = 0
    report()
  }
  const saveFile = async (chunk: Extract<ImportChunk, { type: 'file' }>) => {
    let blob = chunk.blob
    if (EDGE_API && isCompressibleImage(chunk.mime) && blob.size > 500 * 1024) {
      blob = await compressImage(new File([blob], chunk.name, { type: chunk.mime }))
    }
    if (EDGE_API && (blob.size > 1_900_000 || importedFileBytes + blob.size > EDGE_FILE_BUDGET)) {
      if (skipped.files.length < 20) {
        skipped.files.push(chunk.name)
      }
      return
    }
    importedFileBytes += blob.size
    pendingFiles.push({ id: chunk.id, blob: new Blob([blob], { type: blob.type || chunk.mime }) })
    pendingFileBytes += blob.size
    if (pendingFiles.length >= batchCount || pendingFileBytes >= batchBytes) {
      await flushFiles()
    }
  }
  // 把失败作为值立即接住，预读在当前批上传期间失败也不会产生未处理的 rejection。
  const pull = () => {
    reading = true
    const started = performance.now()
    return reader.next().then(
      (result) => {
        reading = false
        if (
          !result.done &&
          (result.value.type === 'sessions' || result.value.type === 'sessionsJson')
        ) {
          // 只统计请求下一批到准备完成；结果在队列里等待上传的时间不计入解析。
          progress.readMs = (progress.readMs ?? 0) + performance.now() - started
        }
        report()
        return { ok: true as const, result }
      },
      (error: unknown) => {
        reading = false
        return { ok: false as const, error }
      }
    )
  }
  const saveSessions = async (
    chunk: Extract<ImportChunk, { type: 'sessions' | 'sessionsJson' }>
  ) => {
    saving = true
    report()
    const started = performance.now()
    try {
      if (chunk.type === 'sessionsJson') {
        await addStagingSessionsJson(chunk.json)
        progress.sessions += chunk.count
      } else {
        await db.addStagingSessions(chunk.sessions)
        progress.sessions += chunk.sessions.length
      }
    } finally {
      progress.saveMs = (progress.saveMs ?? 0) + performance.now() - started
      saving = false
      report()
    }
  }
  let next = pull()
  try {
    while (true) {
      const reply = await next
      if (!reply.ok) {
        throw reply.error
      }
      if (reply.result.done) {
        fail('backupIncomplete')
      }
      const chunk = reply.result.value
      if (chunk.type === 'complete') {
        skipped.sessions = chunk.skippedSessions
        skipped.existing = chunk.skippedExisting
        progress.phase = 'finalizing'
        report()
        await flushFiles()
        await db.updateStagingFileTypes(chunk.types)
        return
      }
      next = pull()
      if (chunk.type === 'sessionsJson' || chunk.type === 'sessions') {
        await saveSessions(chunk)
      } else {
        await saveFile(chunk)
      }
    }
  } finally {
    controller.abort()
    await next
    await reader.return(undefined)
  }
}
