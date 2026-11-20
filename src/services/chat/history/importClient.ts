import { BackupError } from './errors.js'
import { readImport, type ImportChunk, type ImportReaderOptions } from './importReader.js'
import type { ImportReply, ImportRequest, ImportResponse } from './importProtocol.js'

/** Worker 启动失败时回退到分时处理；解析开始后的格式错误直接交给导入事务回滚。 */
export async function* readImportChunks(
  file: File,
  options: ImportReaderOptions,
  onParsed: (count: number) => void,
  signal: AbortSignal
): AsyncGenerator<ImportChunk> {
  let worker: Worker | undefined
  if (typeof Worker !== 'undefined' && location.protocol !== 'file:') {
    try {
      worker = new Worker(new URL('./import.worker.ts', import.meta.url), { type: 'module' })
    } catch {
      // 浏览器限制后台线程时使用同一套解析与校验逻辑。
    }
  }
  if (!worker) {
    yield* readImport(file, options, onParsed, signal)
    return
  }
  const background = worker
  let nextId = 0
  let failure: { error: unknown } | undefined
  const pending = new Map<
    number,
    { resolve: (reply: ImportReply) => void; reject: (error: unknown) => void }
  >()
  const stop = (error: unknown) => {
    failure ??= { error }
    background.terminate()
    for (const task of pending.values()) {
      task.reject(error)
    }
    pending.clear()
  }
  const abort = () => stop(signal.reason)
  const request = (
    message: Omit<Extract<ImportRequest, { type: 'start' }>, 'id'> | { type: 'next' }
  ) =>
    new Promise<ImportReply>((resolve, reject) => {
      signal.throwIfAborted()
      if (failure) {
        reject(failure.error)
        return
      }
      const id = nextId++
      pending.set(id, { resolve, reject })
      try {
        background.postMessage({ ...message, id })
      } catch (error) {
        pending.delete(id)
        reject(error)
      }
    })
  background.onmessage = (event: MessageEvent<ImportResponse>) => {
    const reply = event.data
    if (reply.type === 'progress') {
      onParsed(reply.parsedSessions)
      return
    }
    const task = pending.get(reply.id)
    pending.delete(reply.id)
    if (reply.type === 'error') {
      task?.reject(reply.key ? new BackupError(reply.key) : new Error(reply.message))
    } else {
      task?.resolve(reply)
    }
  }
  background.onerror = (event) => {
    event.preventDefault()
    stop(new Error(event.message || 'History import worker failed'))
  }
  background.onmessageerror = () =>
    stop(new Error('History import worker message could not be read'))
  signal.addEventListener('abort', abort, { once: true })
  try {
    let ready = false
    const startupTimer = setTimeout(
      () => stop(new Error('History import worker did not start')),
      10_000
    )
    try {
      await request({ type: 'start', file, options })
      ready = true
    } catch (error) {
      signal.throwIfAborted()
      if (error instanceof BackupError) {
        throw error
      }
      stop(error)
    } finally {
      clearTimeout(startupTimer)
    }
    if (!ready) {
      yield* readImport(file, options, onParsed, signal)
      return
    }
    while (true) {
      const reply = await request({ type: 'next' })
      if (reply.type !== 'result') {
        throw new Error('Unexpected history import response')
      }
      if (reply.result.done) {
        return
      }
      yield reply.result.value
    }
  } finally {
    signal.removeEventListener('abort', abort)
    stop(new DOMException('History import reader closed', 'AbortError'))
  }
}
