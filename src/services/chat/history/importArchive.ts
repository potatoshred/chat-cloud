import * as db from '../db.js'
import type { StoredFile } from '../localDb.js'
import type { Session } from '../types.js'
import { BackupError, fail } from './errors.js'
import { EDGE_API } from '../../api/config.js'
import { compressImage, isCompressibleImage } from '../../attachments.js'
import type { SessionIndexEntry } from './format.js'
import { INDEX_PATH, MANIFEST_PATH, USER_PATH, parseSessionPath, sessionFilesDir } from './paths.js'
import { checkManifest, readSessionFile, readSessionIndex } from './schema.js'
import { toLocalSession } from './toLocal.js'
import {
  ArchiveError,
  isZipFile,
  readArchive,
  readEntry,
  skipEntry,
  type ArchiveEntry,
} from './zipReader.js'

/** 从原件字节补充图片 MIME；无法识别时为空字符串，图片身份仍由归档的 is_image 决定。 */
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

/** 免费版单个归档的附件预算：暂存与最终各存一份，100MB 对应峰值 200MB。 */
const EDGE_FILE_BUDGET = 100 * 1024 * 1024

/** 跳过的附件与会话：收尾时由界面展示名字列表。 */
let skippedNames: string[] = []
let skippedSessionNames: string[] = []
let importedFileBytes = 0
export const takeSkippedFiles = () => {
  const result = { files: skippedNames, sessions: skippedSessionNames }
  skippedNames = []
  skippedSessionNames = []
  return result
}

const utf8 = new TextEncoder()
const utf8Length = (text: string) => utf8.encode(text).byteLength

/** 导入进度：已写入暂存的会话数与附件数。 */
export type ImportProgress = { sessions: number; files: number }

const readJson = async (entry: ArchiveEntry): Promise<unknown> => {
  const text = await (await readEntry(entry)).text()
  try {
    return JSON.parse(text)
  } catch {
    return fail('backupInvalidJson')
  }
}

/**
 * 检查 ZIP 格式、首个 manifest 条目及格式版本。
 * 校验失败时保留正在生成的回答和现有暂存数据。
 */
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
 * 流式导入：manifest → user（不导入）→ 全部会话 JSON → index → 全部图片。
 * 也支持会话与图片交错排列、index 位于末尾的条目顺序。
 * 会话读完立即暂存，只保留图片路径映射；图片全部读完后逐会话回填 MIME，不改变图片身份。
 * 写入导入暂存存储；调用方负责先清空暂存，成功后替换正式数据，失败时清理暂存。
 */
export const importArchive = async (
  file: File,
  onProgress?: (progress: ImportProgress) => void
): Promise<void> => {
  if (!(await isZipFile(file))) {
    fail('backupUnrecognized')
  }
  const imported = new Set<string>()
  const images = new Map<string, string>()
  /** 已保存的原件：文件 ID → MIME。同一图片出现在多个会话目录时只保存一次。 */
  const stored = new Map<string, string>()
  importedFileBytes = 0
  skippedNames = []
  skippedSessionNames = []
  const skippedSessionIds = new Set<string>()
  let stagedSessions = 0
  let stagedFiles = 0
  const report = () => onProgress?.({ sessions: stagedSessions, files: stagedFiles })
  let manifest = false
  let index: SessionIndexEntry[] | undefined
  let currentSessionId: string | undefined

  // 攒批写入，避免每个会话/图片各发一个请求（1400+ 次往返经过隧道，极易被掐断）。
  // 按条数和累计大小双重上限触发，单批远小于服务端与 nginx 的 64MiB 限制。
  // Cloudflare 免费版单次请求解析受 10ms CPU 限制，批次要小得多。
  const BATCH_COUNT = EDGE_API ? 3 : 25
  // 按 UTF-8 字节算：中文会话的字符数远小于体积，按字符攒批会撞上服务端 1MB 上限。
  const BATCH_BYTES = EDGE_API ? 256 * 1024 : 12 * 1024 * 1024
  let pendingSessions: Session[] = []
  let pendingSessionBytes = 0
  let pendingFiles: StoredFile[] = []
  let pendingFileBytes = 0

  const flushSessions = async () => {
    if (pendingSessions.length === 0) {
      return
    }
    await db.addStagingSessions(pendingSessions)
    stagedSessions += pendingSessions.length
    pendingSessions = []
    pendingSessionBytes = 0
    report()
  }
  const flushFiles = async () => {
    if (pendingFiles.length === 0) {
      return
    }
    await db.saveStagingFiles(pendingFiles)
    stagedFiles += pendingFiles.length
    pendingFiles = []
    pendingFileBytes = 0
    report()
  }

  const saveImage = async (entry: ArchiveEntry, id: string) => {
    if (stored.has(id)) {
      await skipEntry(entry)
      return
    }
    const data = await readEntry(entry)
    const type = imageType(new Uint8Array(await data.slice(0, 16).arrayBuffer()))
    stored.set(id, type)
    let blob = data
    // 免费版：先压缩再入库，尽量不丢图片；只有压完仍超 2MB 或总预算用完才跳过。
    if (EDGE_API && isCompressibleImage(type) && blob.size > 500 * 1024) {
      const name = entry.path.split('/').pop() ?? id
      blob = await compressImage(new File([blob], name, { type }))
    }
    if (
      EDGE_API &&
      (blob.size > 1_900_000 || importedFileBytes + blob.size > EDGE_FILE_BUDGET)
    ) {
      if (skippedNames.length < 20) {
        skippedNames.push(entry.path.split('/').pop() ?? id)
      }
      return
    }
    importedFileBytes += blob.size
    pendingFiles.push({ id, blob: new Blob([blob], { type: blob.type || type }) })
    pendingFileBytes += blob.size
    if (pendingFiles.length >= BATCH_COUNT || pendingFileBytes >= BATCH_BYTES) {
      await flushFiles()
    }
  }

  try {
    for await (const entry of readArchive(file)) {
      const { path } = entry
      const sessionId = parseSessionPath(path)
      if (!manifest) {
        if (path !== MANIFEST_PATH) {
          fail('backupUnrecognized')
        }
        checkManifest(await readJson(entry))
        manifest = true
      } else if (path === USER_PATH && !index && imported.size === 0) {
        // 账号信息（已脱敏）不导入；文件可能缺失。
        await skipEntry(entry)
      } else if (sessionId !== null && !index) {
        const local = toLocalSession(readSessionFile(await readJson(entry)))
        if (local.session.id !== sessionId || imported.has(sessionId)) {
          fail('backupIncomplete')
        }
        const json = JSON.stringify(local.session)
        const bytes = utf8Length(json)
        if (EDGE_API && bytes > 1_900_000) {
          // 单个会话超过 D1 单行上限：跳过它，其余会话继续导入，并在结束时列出名字。
          skippedSessionIds.add(sessionId)
          if (skippedSessionNames.length < 20) {
            skippedSessionNames.push(local.session.title || sessionId)
          }
        } else {
          imported.add(sessionId)
          currentSessionId = sessionId
          for (const [imagePath, id] of local.images) {
            images.set(imagePath, id)
          }
          pendingSessions.push(local.session)
          pendingSessionBytes += bytes
          if (pendingSessions.length >= BATCH_COUNT || pendingSessionBytes >= BATCH_BYTES) {
            await flushSessions()
          }
        }
      } else if (path === INDEX_PATH && !index) {
        index = readSessionIndex(await readJson(entry))
      } else if (
        index
          ? imported.has(/^chat_sessions\/([^/]+)_files\//.exec(path)?.[1] ?? '')
          : currentSessionId && path.startsWith(sessionFilesDir(currentSessionId))
      ) {
        // 没有被引用的条目不保存，引用了但缺失的图片只展示文件名。
        const id = images.get(path)
        await (id === undefined ? skipEntry(entry) : saveImage(entry, id))
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
  // index 只列出成功写出的会话，与会话文件一一对应。
  const listed = new Set(index?.map((entry) => entry.id))
  const covered = new Set([...imported, ...skippedSessionIds])
  if (
    !index ||
    listed.size !== index.length ||
    listed.size !== covered.size ||
    [...covered].some((id) => !listed.has(id))
  ) {
    fail('backupIncomplete')
  }
  // 提交前冲刷剩余批次：先会话后图片，与逐条写入的顺序语义一致。
  await flushSessions()
  await flushFiles()
  await db.updateStagingFileTypes(stored)
}
