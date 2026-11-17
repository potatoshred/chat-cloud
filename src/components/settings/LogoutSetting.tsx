import { useEffect, useState } from 'react'
import { useTranslate } from '../../i18n/index.js'
import { Button } from '../base/Button.js'

/** Only the container deployment provides authentication; keep upstream static hosting usable. */
export const LogoutSetting = () => {
  const t = useTranslate()
  const [authenticated, setAuthenticated] = useState(false)
  useEffect(() => {
    const controller = new AbortController()
    void fetch('/auth/session', { cache: 'no-store', signal: controller.signal })
      .then(async (response) => {
        if (response.ok && response.headers.get('Content-Type')?.includes('application/json')) {
          const session: unknown = await response.json()
          if (session && typeof session === 'object' && 'authenticated' in session) {
            setAuthenticated(session.authenticated === true)
          }
        }
      })
      .catch(() => {
        // Static hosting and a disconnected server do not expose a login state.
      })
    return () => controller.abort()
  }, [])
  return authenticated ? (
    <Button variant="outlined" size="m" onClick={() => window.location.assign('/logout')}>
      {t('logout')}
    </Button>
  ) : null
}
