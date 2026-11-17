import { useEffect, useRef, useState, type ReactNode } from 'react'
import { useTranslate } from '../../i18n/index.js'
import { IconCloseOutline16, IconSearchOutline16 } from '../base/icons.js'
import { searchSessions } from '../../services/chat/db.js'
import { revealMessage, selectSession } from '../../services/chat/store.js'
import type { SessionSearchResult } from '../../services/chat/types.js'
import { closeMobileSider } from './mobileSiderState.js'
import styles from './SessionSearch.module.css'

/** 高亮片段中的关键词（大小写不敏感），不构造正则避免特殊字符问题。 */
const highlight = (text: string, query: string): ReactNode => {
  const q = query.trim()
  if (!q) {
    return text
  }
  const lower = text.toLowerCase()
  const target = q.toLowerCase()
  const nodes: ReactNode[] = []
  let cursor = 0
  for (let at = lower.indexOf(target, cursor); at >= 0; at = lower.indexOf(target, cursor)) {
    if (at > cursor) {
      nodes.push(text.slice(cursor, at))
    }
    nodes.push(<mark key={at}>{text.slice(at, at + q.length)}</mark>)
    cursor = at + q.length
  }
  if (cursor < text.length) {
    nodes.push(text.slice(cursor))
  }
  return nodes
}

/** 侧边栏会话搜索：防抖请求所有会话正文，点击结果跳到对应消息。 */
export const SessionSearch = () => {
  const t = useTranslate()
  const [query, setQuery] = useState('')
  const [result, setResult] = useState<SessionSearchResult | null>(null)
  const [loading, setLoading] = useState(false)
  const [failed, setFailed] = useState(false)
  const inputRef = useRef<HTMLInputElement>(null)
  const trimmed = query.trim()

  useEffect(() => {
    if (!trimmed) {
      setResult(null)
      setFailed(false)
      setLoading(false)
      return
    }
    let cancelled = false
    setLoading(true)
    const timer = window.setTimeout(() => {
      searchSessions(trimmed)
        .then((value) => {
          if (!cancelled) {
            setResult(value)
            setFailed(false)
          }
        })
        .catch(() => {
          if (!cancelled) {
            setResult(null)
            setFailed(true)
          }
        })
        .finally(() => {
          if (!cancelled) {
            setLoading(false)
          }
        })
    }, 250)
    return () => {
      cancelled = true
      window.clearTimeout(timer)
    }
  }, [trimmed])

  const openHit = (sessionId: string, messageId: string | null) => {
    if (messageId) {
      revealMessage(sessionId, messageId)
    } else {
      selectSession(sessionId)
    }
    closeMobileSider()
    setQuery('')
    setResult(null)
  }

  const roleLabel = (role: string) =>
    role === 'user'
      ? t('searchSessionsRoleUser')
      : role === 'assistant'
        ? t('searchSessionsRoleAssistant')
        : t('searchSessionsRoleTitle')

  return (
    <div className={styles.search}>
      <div className={styles.field}>
        <IconSearchOutline16 />
        <input
          ref={inputRef}
          type="text"
          className={styles.input}
          value={query}
          placeholder={t('searchSessionsPlaceholder')}
          aria-label={t('searchSessionsPlaceholder')}
          onChange={(event) => setQuery(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Escape') {
              setQuery('')
            }
          }}
        />
        {trimmed ? (
          <button
            type="button"
            className={styles.clear}
            aria-label={t('searchSessionsClear')}
            onClick={() => {
              setQuery('')
              inputRef.current?.focus()
            }}
          >
            <IconCloseOutline16 />
          </button>
        ) : null}
      </div>
      {trimmed ? (
        <div className={styles.panel} role="listbox" aria-label={t('searchSessionsPlaceholder')}>
          {loading ? (
            <div className={styles.hint}>{t('searchSessionsSearching')}</div>
          ) : failed ? (
            <div className={styles.hint}>{t('searchSessionsFailed')}</div>
          ) : result && result.hits.length > 0 ? (
            <>
              <div className={styles.count}>
                {t('searchSessionsResultCount', { count: result.total })}
              </div>
              {result.hits.map((hit) => (
                <button
                  key={`${hit.sessionId}-${hit.messageId ?? 'title'}`}
                  type="button"
                  role="option"
                  className={styles.hit}
                  onClick={() => openHit(hit.sessionId, hit.messageId)}
                >
                  <span className={styles.hitHead}>
                    <span className={styles.hitTitle}>{hit.sessionTitle || t('newChat')}</span>
                    <span className={styles.hitRole}>{roleLabel(hit.role)}</span>
                  </span>
                  <span className={styles.hitSnippet}>{highlight(hit.snippet, trimmed)}</span>
                </button>
              ))}
            </>
          ) : (
            <div className={styles.hint}>{t('searchSessionsNoResult')}</div>
          )}
        </div>
      ) : null}
    </div>
  )
}
