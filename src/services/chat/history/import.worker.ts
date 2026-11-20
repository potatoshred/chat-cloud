import { BackupError } from './errors.js'
import { readImport, type ImportChunk } from './importReader.js'
import type { ImportRequest, ImportResponse } from './importProtocol.js'

let reader: AsyncGenerator<ImportChunk> | undefined
const send = (message: ImportResponse) => globalThis.postMessage(message)
globalThis.addEventListener('message', async (event: MessageEvent<ImportRequest>) => {
  const request = event.data
  try {
    if (request.type === 'start') {
      reader = readImport(request.file, request.options, (parsedSessions) =>
        send({ type: 'progress', parsedSessions })
      )
      send({ id: request.id, type: 'ready' })
    } else {
      if (!reader) {
        throw new Error('History import reader has not started')
      }
      send({ id: request.id, type: 'result', result: await reader.next() })
    }
  } catch (error) {
    send({
      id: request.id,
      type: 'error',
      ...(error instanceof BackupError ? { key: error.key } : {}),
      message: error instanceof Error ? error.message : String(error),
    })
  }
})
