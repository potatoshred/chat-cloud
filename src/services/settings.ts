import { create } from 'zustand'
import type { TtsVoice } from './api/speech.js'
import { normalizeLocation, type UserLocation } from './location.js'
import { SERVER_API } from './api/config.js'
import { storageFailure, storageJson } from './serverStorage.js'
import { subscribeSync } from './syncTicker.js'

export type Locale = 'zh-CN' | 'en-US'

/** 主题偏好；默认跟随系统 */
export type ThemePreference = 'light' | 'dark' | 'system'

/** 思考强度；默认 high */
export type ReasoningEffort = 'low' | 'high' | 'max'

/** 容器部署存于服务端；静态部署保留上游 localStorage 行为。 */
type Settings = {
  apiKey: string | null
  locale: Locale
  themePreference: ThemePreference
  location: UserLocation | null
  ttsVoice: TtsVoice
  thinking: boolean
  reasoningEffort: ReasoningEffort
  model: string
  search: boolean
  siderCollapsed: boolean
}

const KEYS = {
  apiKey: 'chat-demo:api-key',
  locale: 'chat-demo:locale',
  location: 'chat-demo:location',
  themePreference: 'chat-demo:theme-preference',
  ttsVoice: 'chat-demo:tts-voice',
  thinking: 'chat-demo:thinking',
  reasoningEffort: 'chat-demo:reasoning-effort',
  model: 'chat-demo:model',
  search: 'chat-demo:search',
  siderCollapsed: 'chat-demo:sider-collapsed',
} as const

/**
 * 服务端模式的本地快照：只为首屏秒开，页面启动时先按上次的值渲染，
 * 服务端返回后再覆盖。静态部署直接读 localStorage，不需要它。
 */
const SNAPSHOT_KEY = 'chat-demo:settings-snapshot'
let snapshot: Record<string, string> | null = null
const snapshotValues = (): Record<string, string> => {
  if (snapshot === null) {
    try {
      const parsed = JSON.parse(localStorage.getItem(SNAPSHOT_KEY) ?? '{}') as unknown
      snapshot =
        parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)
          ? Object.fromEntries(
              Object.entries(parsed).filter((entry): entry is [string, string] => {
                return typeof entry[1] === 'string'
              })
            )
          : {}
    } catch {
      snapshot = {}
    }
  }
  return snapshot
}
const persistSnapshot = () => {
  try {
    localStorage.setItem(SNAPSHOT_KEY, JSON.stringify(snapshotValues()))
  } catch {
    // 存储不可用时只是失去首屏加速
  }
}
/** 是否有可用于首屏的设置快照。 */
export const hasCachedSettings = (): boolean =>
  !SERVER_API || Object.keys(snapshotValues()).length > 0

const read = (key: string) => {
  try {
    if (SERVER_API) {
      return snapshotValues()[key] ?? null
    }
    return localStorage.getItem(key)
  } catch {
    return null
  }
}

const write = (key: string, value: string | null) => {
  try {
    if (SERVER_API) {
      // API Key 只经服务端，绝不写本地快照。
      if (key === KEYS.apiKey) {
        return
      }
      const values = snapshotValues()
      snapshot =
        value === null
          ? Object.fromEntries(Object.entries(values).filter(([name]) => name !== key))
          : { ...values, [key]: value }
      persistSnapshot()
      return
    }
    if (value === null) {
      localStorage.removeItem(key)
    } else {
      localStorage.setItem(key, value)
    }
  } catch {
    // 存储不可用时只在内存中生效
  }
}

/** 位置选择模式跟随浏览器语言，与应用内选择的界面语言无关。 */
export const isChineseBrowser = (): boolean =>
  (typeof navigator === 'undefined' ? 'zh' : navigator.language).toLowerCase().startsWith('zh')

const initialLocale = (): Locale => {
  const saved = read(KEYS.locale)
  if (saved === 'zh-CN' || saved === 'en-US') {
    return saved
  }
  return isChineseBrowser() ? 'zh-CN' : 'en-US'
}

const initialLocation = (): UserLocation | null => {
  try {
    const location = normalizeLocation(JSON.parse(read(KEYS.location) ?? 'null'))
    if (!location) {
      return null
    }
    return isChineseBrowser()
      ? location.region === 'CN' && location.province
        ? location
        : null
      : { region: location.region }
  } catch {
    return null
  }
}

/** 未保存过时跟随系统 */
const initialThemePreference = (): ThemePreference => {
  const saved = read(KEYS.themePreference)
  return saved === 'light' || saved === 'dark' ? saved : 'system'
}

/** 未保存过时使用服务端默认音色 stella（海星） */
const initialTtsVoice = (): TtsVoice => (read(KEYS.ttsVoice) === 'tide' ? 'tide' : 'stella')

/** 未保存过时使用服务端默认强度 high */
const initialReasoningEffort = (): ReasoningEffort => {
  const saved = read(KEYS.reasoningEffort)
  return saved === 'low' || saved === 'high' || saved === 'max' ? saved : 'high'
}

const DEFAULT_MODEL = 'deepseek-flash'
/** 未保存过时使用默认模型 */
const initialModel = (): string => read(KEYS.model) || DEFAULT_MODEL

export const useSettings = create<Settings>(() => ({
  apiKey: SERVER_API ? null : read(KEYS.apiKey),
  locale: initialLocale(),
  location: initialLocation(),
  themePreference: initialThemePreference(),
  ttsVoice: initialTtsVoice(),
  thinking: read(KEYS.thinking) === 'true',
  reasoningEffort: initialReasoningEffort(),
  model: initialModel(),
  search: read(KEYS.search) === 'true',
  siderCollapsed: read(KEYS.siderCollapsed) === 'true',
}))

export const setLocale = (locale: Locale) => {
  write(KEYS.locale, locale)
  useSettings.setState({ locale })
}

export const setLocation = (value: UserLocation | null) => {
  const location = normalizeLocation(value)
  write(KEYS.location, location ? JSON.stringify(location) : null)
  useSettings.setState({ location })
}

export const setThemePreference = (themePreference: ThemePreference) => {
  write(KEYS.themePreference, themePreference)
  useSettings.setState({ themePreference })
}

export const setTtsVoice = (ttsVoice: TtsVoice) => {
  write(KEYS.ttsVoice, ttsVoice)
  useSettings.setState({ ttsVoice })
}

export const setApiKey = (apiKey: string | null) => {
  write(KEYS.apiKey, apiKey)
  useSettings.setState({ apiKey })
}

export const setThinking = (thinking: boolean) => {
  write(KEYS.thinking, String(thinking))
  useSettings.setState({ thinking })
}

export const setReasoningEffort = (reasoningEffort: ReasoningEffort) => {
  write(KEYS.reasoningEffort, reasoningEffort)
  useSettings.setState({ reasoningEffort })
}

export const setModel = (model: string) => {
  write(KEYS.model, model)
  useSettings.setState({ model })
}

export const setSearch = (search: boolean) => {
  write(KEYS.search, String(search))
  useSettings.setState({ search })
}

export const setSiderCollapsed = (siderCollapsed: boolean) => {
  write(KEYS.siderCollapsed, String(siderCollapsed))
  useSettings.setState({ siderCollapsed })
}

let settingsQueue: Promise<unknown> = Promise.resolve()
let settingsPending = 0
let settingsSequence = 0
let initialized = false
let applyingRemote = false
const encodeSetting = (key: keyof Settings, value: unknown): string | null => {
  if (value === null || value === undefined) {
    return null
  }
  return key === 'location' ? JSON.stringify(value) : String(value)
}
const applyRemote = (value: Partial<Settings>) => {
  applyingRemote = true
  useSettings.setState({ ...value, apiKey: null })
  applyingRemote = false
  // 同步到本地快照，下次首屏直接按这份值渲染。
  for (const [key, item] of Object.entries(value)) {
    if (key === 'apiKey') {
      continue
    }
    write(KEYS[key as keyof typeof KEYS], encodeSetting(key as keyof Settings, item))
  }
}
export const initServerSettings = async () => {
  if (!SERVER_API || initialized) {
    return
  }
  applyRemote(await storageJson<Partial<Settings>>('settings'))
  initialized = true
  useSettings.subscribe((state, previous) => {
    if (applyingRemote) {
      return
    }
    const patch = Object.fromEntries(
      Object.keys(KEYS)
        .filter(
          (key) =>
            key !== 'apiKey' && state[key as keyof Settings] !== previous[key as keyof Settings]
        )
        .map((key) => [key, state[key as keyof Settings]])
    )
    if (Object.keys(patch).length === 0) {
      return
    }
    settingsPending++
    settingsSequence++
    settingsQueue = settingsQueue
      .then(() => storageJson('settings', 'PATCH', patch))
      .catch(storageFailure)
      .finally(() => {
        settingsPending--
      })
  })
  const refresh = async () => {
    if (settingsPending || document.visibilityState === 'hidden') {
      return
    }
    const sequence = settingsSequence
    try {
      const value = await storageJson<Partial<Settings>>('settings')
      if (!settingsPending && sequence === settingsSequence) {
        applyRemote(value)
      }
    } catch {
      /* A failed refresh leaves the last loaded settings visible. */
    }
  }
  subscribeSync(() => {
    void refresh()
  })
}
