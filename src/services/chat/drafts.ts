import { create } from 'zustand'
import type { TranslationMessage } from '../../i18n/index.js'
import { createId } from '../../utils/id.js'
import {
  cancelUpload,
  isImage,
  resolveMimeType,
  uploadAttachment,
  validateFiles,
  type UploadTask,
} from '../attachments.js'
import type { FileAttachment } from './types.js'
import { SERVER_API } from '../api/config.js'
import { storageFailure, storageJson } from '../serverStorage.js'
import { useSettings } from '../settings.js'
import { subscribeSync } from '../syncTicker.js'
import * as db from './db.js'
import { getKnownGeneration } from './serverDb.js'

export type DraftAttachment = {
  /** 本地标识，也是 IndexedDB 原件与上传任务的 key */
  id: string
  file: File
  isImage: boolean
}

type Draft = { text: string; attachments: DraftAttachment[] }

export const EMPTY_DRAFT: Draft = { text: '', attachments: [] }

/** null 是新对话的草稿；容器模式同步文字及附件原件到服务端。 */
export const useDrafts = create<{ drafts: Map<string | null, Draft> }>(() => ({
  drafts: new Map(),
}))

export const getDraft = (sessionId: string | null): Draft =>
  useDrafts.getState().drafts.get(sessionId) ?? EMPTY_DRAFT

const updateDraft = (sessionId: string | null, update: (draft: Draft) => Draft) => {
  useDrafts.setState((state) => {
    const draft = update(state.drafts.get(sessionId) ?? EMPTY_DRAFT)
    const drafts = new Map(state.drafts)
    if (draft.text || draft.attachments.length > 0) {
      drafts.set(sessionId, draft)
    } else {
      drafts.delete(sessionId)
    }
    return { drafts }
  })
  scheduleDraft(sessionId)
}

export const setDraftText = (sessionId: string | null, text: string) =>
  updateDraft(sessionId, (draft) => ({ ...draft, text }))

const upload = (attachment: DraftAttachment, apiKey: string) => {
  // 上传任务负责记录错误，输入框的附件卡片展示失败及重试入口。
  void uploadAttachment(
    apiKey,
    attachment.id,
    attachment.file,
    attachment.file.name,
    attachment.isImage
  ).catch(() => {})
}

/** 整批校验通过后才加入草稿并开始上传。 */
export const addDraftFiles = (
  sessionId: string | null,
  files: File[],
  apiKey: string
): TranslationMessage | null => {
  if (files.length === 0) {
    return null
  }
  const error = validateFiles(files, getDraft(sessionId).attachments.length)
  if (error) {
    return error
  }
  const added = files.map(
    (file): DraftAttachment => ({
      id: createId(),
      file,
      isImage: isImage(resolveMimeType(file)),
    })
  )
  updateDraft(sessionId, (draft) => ({ ...draft, attachments: [...draft.attachments, ...added] }))
  added.forEach((attachment) => upload(attachment, apiKey))
  return null
}

export const retryDraftAttachment = (
  sessionId: string | null,
  attachmentId: string,
  apiKey: string
) => {
  const attachment = getDraft(sessionId).attachments.find((item) => item.id === attachmentId)
  if (attachment) {
    upload(attachment, apiKey)
  }
}

/** 发送按钮和实际提交共用规则：有内容，且全部附件已上传成功。 */
export const prepareDraftMessage = (draft: Draft, tasks: Record<string, UploadTask>) => {
  const text = draft.text.trim()
  if (!text && draft.attachments.length === 0) {
    return null
  }
  const files: (FileAttachment & { serverId: string; blob: Blob })[] = []
  for (const attachment of draft.attachments) {
    const task = tasks[attachment.id]
    if (task?.status !== 'done' || !task.serverId) {
      return null
    }
    files.push({
      id: attachment.id,
      serverId: task.serverId,
      name: attachment.file.name,
      size: attachment.file.size,
      isImage: attachment.isImage,
      mimeType: resolveMimeType(attachment.file),
      blob: attachment.file,
    })
  }
  return { text, files }
}

export const removeDraftAttachment = (sessionId: string | null, attachmentId: string) => {
  const attachment = getDraft(sessionId).attachments.find((item) => item.id === attachmentId)
  if (!attachment) {
    return
  }
  cancelUpload(attachment.id)
  updateDraft(sessionId, (draft) => ({
    ...draft,
    attachments: draft.attachments.filter((item) => item.id !== attachmentId),
  }))
}

/** 发送成功后原件与 serverId 已交给会话，保留上传完成态。 */
export const clearSentDraft = (sessionId: string | null) => {
  updateDraft(sessionId, () => EMPTY_DRAFT)
}

/** 删除会话或替换历史成功后，释放尚未发送的草稿及上传任务。 */
export const clearDraft = (sessionId: string | null) => {
  getDraft(sessionId).attachments.forEach((attachment) => cancelUpload(attachment.id))
  updateDraft(sessionId, () => EMPTY_DRAFT)
  forgetDraft(sessionId)
}

/** 把本地草稿的版本绑定到当前 generation（commit 后 generation 会轮换）。 */
const syncDraftGeneration = () => {
  const current = getKnownGeneration()
  draftGeneration = current
  for (const [id, version] of draftVersions) {
    draftVersions.set(id, { ...version, generation: current })
  }
}

/**
 * 追加导入后调用：commit 轮换 generation 但草稿被保留，需就地 rebase 各草稿版本，
 * 否则下一次保存草稿会携带旧 generation，收到 409 冲突。
 */
export const rebaseDraftsAfterImport = () => {
  syncDraftGeneration()
}

export const clearAllDrafts = () => {
  for (const timer of draftTimers.values()) {
    window.clearTimeout(timer)
  }
  draftTimers.clear()
  dirtyDrafts.clear()
  draftVersions.clear()
  syncDraftGeneration()
  draftEpoch++
  for (const draft of useDrafts.getState().drafts.values()) {
    draft.attachments.forEach((attachment) => cancelUpload(attachment.id))
  }
  useDrafts.setState({ drafts: new Map() })
}

type SavedDraft = {
  text: string
  attachments: { id: string; name: string; type: string; isImage: boolean; lastModified: number }[]
}
type DraftVersion = { revision: string | null; generation: string }
const draftVersions = new Map<string | null, DraftVersion>()
const draftTimers = new Map<string | null, number>()
const dirtyDrafts = new Set<string | null>()
const savingDrafts = new Set<string | null>()
let draftGeneration = ''
let draftEpoch = 0
const draftId = (id: string | null) => (id === null ? 'new' : `session:${id}`)
const forgetDraft = (id: string | null) => {
  window.clearTimeout(draftTimers.get(id))
  draftTimers.delete(id)
  dirtyDrafts.delete(id)
  draftVersions.delete(id)
}
const scheduleDraft = (id: string | null) => {
  if (!SERVER_API) {
    return
  }
  if (!dirtyDrafts.has(id) && !draftVersions.has(id)) {
    draftVersions.set(id, { revision: null, generation: draftGeneration })
  }
  dirtyDrafts.add(id)
  window.clearTimeout(draftTimers.get(id))
  draftTimers.set(
    id,
    window.setTimeout(() => {
      void saveDraft(id)
    }, 400)
  )
}
const saveDraft = async (id: string | null) => {
  if (savingDrafts.has(id) || !dirtyDrafts.has(id)) {
    return
  }
  savingDrafts.add(id)
  const draft = getDraft(id)
  const epoch = draftEpoch
  const version = draftVersions.get(id) ?? { revision: null, generation: draftGeneration }
  try {
    await db.saveFiles(draft.attachments.map((item) => ({ id: item.id, blob: item.file })))
    if (epoch !== draftEpoch) {
      return
    }
    const saved = await storageJson<DraftVersion>(
      `drafts/${encodeURIComponent(draftId(id))}`,
      'PUT',
      {
        ...version,
        draft: {
          text: draft.text,
          attachments: draft.attachments.map((item) => ({
            id: item.id,
            name: item.file.name,
            type: item.file.type,
            isImage: item.isImage,
            lastModified: item.file.lastModified,
          })),
        },
      }
    )
    if (epoch !== draftEpoch) {
      return
    }
    draftVersions.set(id, saved)
    if (getDraft(id) === draft) {
      dirtyDrafts.delete(id)
    } else {
      scheduleDraft(id)
    }
  } catch (error) {
    if (epoch === draftEpoch) {
      storageFailure(error)
    }
  } finally {
    savingDrafts.delete(id)
  }
}
let refreshingDrafts = false
const refreshDrafts = async () => {
  if (refreshingDrafts) {
    return
  }
  refreshingDrafts = true
  const epoch = draftEpoch
  try {
    const data = await storageJson<{
      generation: string
      drafts: { id: string; draft: SavedDraft; revision: string }[]
    }>('drafts')
    if (epoch !== draftEpoch) {
      return
    }
    draftGeneration = data.generation
    const present = new Set<string | null>()
    for (const row of data.drafts) {
      const id = row.id === 'new' ? null : row.id.slice('session:'.length)
      present.add(id)
      if (
        dirtyDrafts.has(id) ||
        savingDrafts.has(id) ||
        (draftVersions.get(id)?.revision === row.revision &&
          draftVersions.get(id)?.generation === data.generation)
      ) {
        continue
      }
      const previous = getDraft(id)
      const attachments = await Promise.all(
        row.draft.attachments.map(async (item) => {
          const blob = await db.loadFile(item.id)
          if (!blob) {
            throw new Error('服务端草稿附件缺失，请刷新后重试。')
          }
          const file = new File([blob], item.name, {
            type: item.type,
            lastModified: item.lastModified,
          })
          return {
            id: item.id,
            file,
            isImage: item.isImage,
            previewUrl: item.isImage ? URL.createObjectURL(file) : null,
          }
        })
      )
      if (epoch !== draftEpoch || dirtyDrafts.has(id) || getDraft(id) !== previous) {
        attachments.forEach((item) => releaseAttachment(item, false))
        continue
      }
      previous.attachments.forEach((item) => releaseAttachment(item, true))
      const draft = { text: row.draft.text, attachments }
      useDrafts.setState((state) => {
        const drafts = new Map(state.drafts)
        if (draft.text || attachments.length) {
          drafts.set(id, draft)
        } else {
          drafts.delete(id)
        }
        return { drafts }
      })
      draftVersions.set(id, { revision: row.revision, generation: data.generation })
      attachments.forEach((item) => upload(item, useSettings.getState().apiKey ?? ''))
    }
    for (const id of draftVersions.keys()) {
      if (!present.has(id) && !dirtyDrafts.has(id) && !savingDrafts.has(id)) {
        getDraft(id).attachments.forEach((item) => releaseAttachment(item, true))
        useDrafts.setState((state) => {
          const drafts = new Map(state.drafts)
          drafts.delete(id)
          return { drafts }
        })
        draftVersions.delete(id)
      }
    }
  } finally {
    refreshingDrafts = false
  }
}
export const initServerDrafts = async () => {
  if (!SERVER_API) {
    return
  }
  await refreshDrafts()
  subscribeSync(() => {
    if (document.visibilityState !== 'hidden') {
      void refreshDrafts().catch(() => {})
    }
  })
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') {
      dirtyDrafts.forEach((id) => {
        void saveDraft(id)
      })
    }
  })
}
