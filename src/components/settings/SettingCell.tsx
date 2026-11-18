import clsx from 'clsx'
import type { ReactNode } from 'react'
import { useTranslate } from '../../i18n/index.js'
import type { TranslationKey, TranslationMessage } from '../../i18n/index.js'
import styles from './Settings.module.css'

export type Status = (TranslationMessage & { error?: boolean; reason?: TranslationKey }) | null

/** 设置行：左侧标签与说明（或状态），右侧操作控件。 */
export const SettingCell = ({
  label,
  description,
  status,
  action,
  className,
}: {
  label: string
  description?: string
  status: Status
  action: ReactNode
  className?: string
}) => {
  const t = useTranslate()
  return (
    <div className={clsx(styles.cell, styles.row, className)}>
      <div className={styles.text}>
        <div className={styles.label}>{label}</div>
        {status || description ? (
          <div className={clsx(styles.description, status?.error && styles.error)}>
            {status
              ? t(status.key, status.reason ? { message: t(status.reason) } : status.params)
              : description}
          </div>
        ) : null}
      </div>
      {action}
    </div>
  )
}
