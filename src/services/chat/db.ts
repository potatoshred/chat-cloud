import { SERVER_API } from '../api/config.js'
import * as local from './localDb.js'
import * as server from './serverDb.js'

export type { StoredFile } from './localDb.js'
export type { ImportMode } from './types.js'
const storage = SERVER_API ? server : local
export const {
  peekSessionSummaries,
  loadSessionSummaries,
  loadSession,
  searchSessions,
  loadUsage,
  saveSession,
  renameSession,
  deleteSession,
  saveFiles,
  loadFile,
  clearStaging,
  addStagingSession,
  addStagingSessions,
  saveStagingFiles,
  updateStagingFileTypes,
  commitStaging,
} = storage
export const reportStorageError = local.reportStorageError
