import { useMemo } from 'react'
import { useTranslate } from '../../i18n/index.js'
import { useSettings } from '../../services/settings.js'
import { formatDateTime } from '../../utils/format.js'
import { Button } from '../base/Button.js'
import { IconRefreshOutline16 } from '../base/icons.js'
import { SettingCell } from './SettingCell.js'
import { useUsage } from './useUsage.js'
import styles from './Settings.module.css'

const STATUS_KEYS = {
  done: 'settingsUsageStatusDone',
  stopped: 'settingsUsageStatusStopped',
  error: 'settingsUsageStatusError',
} as const

const EMPTY = '—'

/** 用量：账户余额 + 最近 24 小时请求汇总与明细。 */
export const UsageSection = () => {
  const t = useTranslate()
  const locale = useSettings((state) => state.locale)
  const { balance, report, loading, balanceError, usageError, refresh } = useUsage()
  const number = useMemo(() => new Intl.NumberFormat(locale), [locale])
  const format = (value: number) => number.format(value)

  const balanceText = (() => {
    if (balanceError) {
      return balanceError
    }
    if (!balance) {
      return t('settingsUsageBalanceDescription')
    }
    if (!balance.is_available) {
      return t('settingsUsageUnavailable')
    }
    const infos = Array.isArray(balance.balance_infos) ? balance.balance_infos : []
    if (infos.length === 0) {
      return t('settingsUsageBalanceDescription')
    }
    return infos
      .map((info) =>
        t('settingsUsageBalanceLine', {
          currency: info.currency,
          total: info.total_balance,
          granted: info.granted_balance,
          toppedUp: info.topped_up_balance,
        })
      )
      .join(' · ')
  })()

  const metrics = [
    { key: 'requests', label: t('settingsUsageRequests'), value: report?.totals.requests },
    { key: 'input', label: t('settingsUsageInputTokens'), value: report?.totals.inputTokens },
    { key: 'output', label: t('settingsUsageOutputTokens'), value: report?.totals.outputTokens },
    { key: 'cache', label: t('settingsUsageCacheRead'), value: report?.totals.cacheReadTokens },
    { key: 'searches', label: t('settingsUsageSearches'), value: report?.totals.searches },
  ]

  return (
    <>
      <SettingCell
        label={t('settingsUsageBalance')}
        description={balanceText}
        status={null}
        action={
          <Button
            variant="outlined"
            size="m"
            className={styles.modelRefresh}
            aria-label={t('settingsUsageRefresh')}
            disabled={loading}
            onClick={() => void refresh()}
          >
            <IconRefreshOutline16 />
            {t(loading ? 'settingsUsageRefreshing' : 'settingsUsageRefresh')}
          </Button>
        }
      />
      <div className={styles.usageSection}>
        <div className={styles.usageHeading}>{t('settingsUsageWindow')}</div>
        <div className={styles.usageMetrics}>
          {metrics.map((metric) => (
            <div key={metric.key} className={styles.usageMetric}>
              <span className={styles.usageMetricValue}>
                {metric.value === undefined ? EMPTY : format(metric.value)}
              </span>
              <span className={styles.usageMetricLabel}>{metric.label}</span>
            </div>
          ))}
        </div>
      </div>
      <div className={styles.usageSection}>
        <div className={styles.usageHeading}>
          <span>{t('settingsUsageLogs')}</span>
          {report?.truncated ? (
            <span className={styles.usageHint}>{t('settingsUsageLogsTruncated')}</span>
          ) : null}
        </div>
        {usageError ? (
          <div className={styles.usageEmpty}>
            <span>{usageError}</span>
            <Button variant="outlined" size="s" onClick={() => void refresh()}>
              {t('retry')}
            </Button>
          </div>
        ) : !report ? (
          <div className={styles.usageEmpty}>{t('settingsUsageLoading')}</div>
        ) : report.entries.length === 0 ? (
          <div className={styles.usageEmpty}>{t('settingsUsageLogsEmpty')}</div>
        ) : (
          <div className={styles.usageList}>
            <div className={styles.usageRowHeader}>
              <span>{t('settingsUsageColumnTime')}</span>
              <span>{t('settingsUsageColumnModel')}</span>
              <span>{t('settingsUsageColumnTokens')}</span>
              <span>{t('settingsUsageColumnSearches')}</span>
              <span>{t('settingsUsageColumnStatus')}</span>
            </div>
            {report.entries.map((entry) => {
              const statusKey =
                STATUS_KEYS[entry.status as keyof typeof STATUS_KEYS] ?? null
              return (
                <div
                  key={`${entry.sessionId}:${entry.messageId}`}
                  className={styles.usageRow}
                  title={entry.sessionTitle}
                >
                  <span className={styles.usageTime}>
                    {formatDateTime(entry.at, locale) ?? EMPTY}
                  </span>
                  <span className={styles.usageModel}>{entry.model ?? EMPTY}</span>
                  <span className={styles.usageTokens}>
                    {format(entry.inputTokens)} / {format(entry.outputTokens)}
                  </span>
                  <span className={styles.usageSearches}>
                    {entry.searches > 0 ? format(entry.searches) : EMPTY}
                  </span>
                  <span className={styles.usageStatus}>
                    {statusKey ? t(statusKey) : entry.status}
                  </span>
                </div>
              )
            })}
          </div>
        )}
        <p className={styles.usageNote}>{t('settingsUsageNote')}</p>
      </div>
    </>
  )
}
