import { showToast } from '../components/base/toastState.js'

export class StorageError extends Error {
  constructor(
    message: string,
    public status: number
  ) {
    super(message)
  }
}

export const storageRequest = async (path: string, init: RequestInit = {}): Promise<Response> => {
  const response = await fetch(`/data/${path}`, {
    cache: 'no-store',
    credentials: 'same-origin',
    redirect: 'error',
    ...init,
    headers: { 'X-Chat-Request': '1', ...init.headers },
  })
  if (!response.ok) {
    if (response.status === 401) {
      window.location.replace('/login')
    }
    const data = (await response.json().catch(() => null)) as {
      error?: { message?: string }
    } | null
    const error = new StorageError(
      data?.error?.message ?? `服务端存储请求失败 (${response.status})`,
      response.status
    )
    if (response.status === 409) {
      showToast(error.message)
    }
    throw error
  }
  return response
}

export const storageJson = async <T>(path: string, method = 'GET', value?: unknown): Promise<T> =>
  (
    await storageRequest(path, {
      method,
      ...(value === undefined
        ? {}
        : { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(value) }),
    })
  ).json() as Promise<T>

export const storageFailure = (error: unknown) => {
  showToast(error instanceof Error ? error.message : '服务端保存失败，请检查网络后重试。')
}
