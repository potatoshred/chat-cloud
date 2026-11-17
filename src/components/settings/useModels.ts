import { useState } from 'react'
import { ApiError, fetchModels } from '../../services/api/client.js'
import { classifyApiError } from '../../services/api/errors.js'
import type { ModelInfo } from '../../services/api/types.js'
import { useSettings } from '../../services/settings.js'
import { useTranslate } from '../../i18n/index.js'

/** 模型列表：仅在用户点刷新按钮时从官方 /models 拉取。 */
export const useModels = () => {
  const t = useTranslate()
  const apiKey = useSettings((state) => state.apiKey)
  const [models, setModels] = useState<ModelInfo[]>([])
  const [refreshing, setRefreshing] = useState(false)
  const [failure, setFailure] = useState<{ cause: unknown } | null>(null)
  const cause = failure?.cause
  const error =
    failure === null
      ? null
      : classifyApiError(cause) === 'unauthorized'
        ? t('apiKeyInvalid')
        : classifyApiError(cause) === 'network'
          ? t('commonNetworkErrorToast')
          : t('modelListLoadFailed', {
              message:
                cause instanceof ApiError && cause.localMessage
                  ? t(cause.localMessage.key, cause.localMessage.params)
                  : cause instanceof Error
                    ? cause.message
                    : String(cause),
            })

  const refresh = async () => {
    if (refreshing) {
      return
    }
    setRefreshing(true)
    setFailure(null)
    try {
      setModels(await fetchModels(apiKey ?? ''))
    } catch (e) {
      setFailure({ cause: e })
    } finally {
      setRefreshing(false)
    }
  }

  return { models, refreshing, error, refresh }
}
