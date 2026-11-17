/** Recheck the server session when returning to an existing chat tab. */
export const bindAuthSession = () => {
  let active = true
  let pending = false
  const check = async () => {
    if (pending || document.visibilityState === 'hidden') {
      return
    }
    pending = true
    try {
      const response = await fetch('/auth/session', { cache: 'no-store', redirect: 'error' })
      // Static hosting and the upstream dev server do not provide this endpoint.
      if (active && response.status === 401 && response.headers.get('Content-Type')?.includes('application/json')) {
        window.location.replace('/login')
      }
    } catch {
      // Network errors do not prove that an existing session was revoked.
    } finally {
      pending = false
    }
  }
  const refresh = () => { void check() }
  refresh()
  const timer = window.setInterval(refresh, 30_000)
  window.addEventListener('focus', refresh)
  document.addEventListener('visibilitychange', refresh)
  return () => {
    active = false
    window.clearInterval(timer)
    window.removeEventListener('focus', refresh)
    document.removeEventListener('visibilitychange', refresh)
  }
}
