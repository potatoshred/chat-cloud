import clsx from 'clsx'
import { useIsMobile } from '../../app/viewport.js'
import { useTranslate } from '../../i18n/index.js'
import type { Session } from '../../services/chat/types.js'
import { Button } from '../base/Button.js'
import { ChatInput } from '../chatInput/ChatInput.js'
import { MessageList } from '../messages/MessageList.js'
import { MobileHeader } from './MobileHeader.js'
import styles from './SessionView.module.css'

/** 标题栏：移动端是顶栏，桌面端是顶部标题 */
const SessionHeader = ({ title, siderCollapsed }: { title: string; siderCollapsed: boolean }) => {
  const isMobile = useIsMobile()
  return isMobile ? (
    <MobileHeader title={title} />
  ) : (
    <div className={styles.header}>
      <div className={clsx(styles.title, siderCollapsed && styles.withCollapsedSider)}>{title}</div>
    </div>
  )
}

/** 会话页：标题栏（移动端为顶栏）+ 消息列表，输入框吸底 */
export const SessionView = ({
  session,
  streaming,
  siderCollapsed,
}: {
  session: Session
  streaming: boolean
  siderCollapsed: boolean
}) => {
  const t = useTranslate()
  const title = session.title || t('untitledChat')
  return (
    <div className={styles.view}>
      <SessionHeader title={title} siderCollapsed={siderCollapsed} />
      <MessageList
        session={session}
        streaming={streaming}
        footer={
          <div className={styles.inputContainer}>
            <ChatInput sessionId={session.id} />
            <div className={styles.caveat}>{t('contentCaveat')}</div>
          </div>
        }
      />
    </div>
  )
}

/** 会话正文加载中：标题与输入框先就位，只占位消息区 */
export const SessionPending = ({
  sessionId,
  title,
  error,
  siderCollapsed,
  onRetry,
}: {
  sessionId: string
  title: string
  error: boolean
  siderCollapsed: boolean
  onRetry: () => void
}) => {
  const t = useTranslate()
  return (
    <div className={styles.view}>
      <SessionHeader title={title || t('untitledChat')} siderCollapsed={siderCollapsed} />
      <div className={styles.pending} role="status" aria-live="polite">
        <span>{error ? t('sessionLoadFailed') : t('sessionLoading')}</span>
        {error ? (
          <Button variant="outlined" size="m" onClick={onRetry}>
            {t('retry')}
          </Button>
        ) : null}
      </div>
      <div className={styles.inputContainer}>
        <ChatInput sessionId={sessionId} pending />
        <div className={styles.caveat}>{t('contentCaveat')}</div>
      </div>
    </div>
  )
}
