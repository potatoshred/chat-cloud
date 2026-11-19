import { useCallback, useEffect, useRef, useState } from 'react'
import { ApiError, fetchBalance } from '../../services/api/client.js'
import { classifyApiError } from '../../services/api/errors.js'
import type { UserBalance } from '../../services/api/types.js'
import { loadUsage } from '../../services/chat/db.js'
import type { UsageReport } from '../../services/chat/usage.js'
import { EDGE_API } from '../../services/api/config.js'
import { useSettings } from '../../services/settings.js'
import { useTranslate } from '../../i18n/index.js'

/** 余额与 24 小时用量：进入页面时加载一次，也可手动刷新；两部分互相独立。 */
export const useUsage = () => {
  const t = useTranslate()
  const apiKey = useSettings((state) => state.apiKey)
  const [balance, setBalance] = useState<UserBalance | null>(null)
  const [report, setReport] = useState<UsageReport | null>(null)
  const [loading, setLoading] = useState(false)
  const [balanceCause, setBalanceCause] = useState<unknown>(null)
  const [usageCause, setUsageCause] = useState<unknown>(null)
  const busy = useRef(false)
  const alive = useRef(true)

  const describe = (cause: unknown) => {
    const condition = classifyApiError(cause)
    if (condition === 'unauthorized') {
      return t('apiKeyInvalid')
    }
    if (condition === 'network') {
      return t('commonNetworkErrorToast')
    }
    return t('settingsUsageLoadFailed', {
      message:
        cause instanceof ApiError && cause.localMessage
          ? t(cause.localMessage.key, cause.localMessage.params)
          : cause instanceof Error
            ? cause.message
            : String(cause),
    })
  }

  const refresh = useCallback(async () => {
    if (busy.current) {
      return
    }
    busy.current = true
    setLoading(true)
    // 免费版只保留余额：24 小时用量需要扫描全部消息，D1 读额度不划算。
    const [balanceResult, usageResult] = await Promise.allSettled([
      fetchBalance(apiKey ?? ''),
      EDGE_API ? Promise.resolve(null) : loadUsage(),
    ])
    if (alive.current) {
      if (balanceResult.status === 'fulfilled') {
        setBalance(balanceResult.value)
        setBalanceCause(null)
      } else {
        setBalanceCause(balanceResult.reason)
      }
      if (EDGE_API) {
        setReport(null)
      } else if (usageResult.status === 'fulfilled') {
        setReport(usageResult.value)
        setUsageCause(null)
      } else {
        setUsageCause(usageResult.reason)
      }
      setLoading(false)
    }
    busy.current = false
  }, [apiKey])

  useEffect(() => {
    alive.current = true
    void refresh()
    return () => {
      alive.current = false
    }
  }, [refresh])

  return {
    balance,
    report,
    loading,
    balanceError: balanceCause === null ? null : describe(balanceCause),
    usageError: usageCause === null ? null : describe(usageCause),
    refresh,
  }
}
