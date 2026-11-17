import { SERVER_API } from '../api/config.js'
import * as local from './localDb.js'
import * as server from './serverDb.js'

export type { StoredFile } from './localDb.js'
const storage = SERVER_API ? server : local
export const {
  loadSessionSummaries,
  loadSession,
  saveSession,
  renameSession,
  deleteSession,
  saveFiles,
  loadFile,
  clearStaging,
  addStagingSession,
  saveStagingFiles,
  updateStagingFileTypes,
  commitStaging,
} = storage
export const reportStorageError = local.reportStorageError
