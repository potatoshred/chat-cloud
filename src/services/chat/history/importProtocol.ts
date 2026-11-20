import type { TranslationKey } from '../../../i18n/index.js'
import type { ImportChunk, ImportReaderOptions } from './importReader.js'

export type ImportRequest =
  | { id: number; type: 'start'; file: File; options: ImportReaderOptions }
  | { id: number; type: 'next' }
export type ImportReply =
  | { id: number; type: 'ready' }
  | { id: number; type: 'result'; result: IteratorResult<ImportChunk, void> }
  | { id: number; type: 'error'; key?: TranslationKey; message: string }
export type ImportResponse = ImportReply | { type: 'progress'; parsedSessions: number }
