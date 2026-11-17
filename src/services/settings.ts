import { create } from 'zustand'
import type { TtsVoice } from './api/speech.js'
import { normalizeLocation, type UserLocation } from './location.js'
import { SERVER_API } from './api/config.js'
import { storageFailure, storageJson } from './serverStorage.js'

export type Locale = 'zh-CN' | 'en-US'

/** 主题偏好；默认跟随系统 */
export type ThemePreference = 'light' | 'dark' | 'system'

/** 容器部署存于服务端；静态部署保留上游 localStorage 行为。 */
type Settings = {
  apiKey: string | null
  locale: Locale
  themePreference: ThemePreference
  location: UserLocation | null
  ttsVoice: TtsVoice
  thinking: boolean
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
  search: 'chat-demo:search',
  siderCollapsed: 'chat-demo:sider-collapsed',
} as const

const read = (key: string) => {
  if (SERVER_API) {
    return null
  }
  try {
    return localStorage.getItem(key)
  } catch {
    return null
  }
}

const write = (key: string, value: string | null) => {
  if (SERVER_API) {
    return
  }
  try {
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

export const useSettings = create<Settings>(() => ({
  apiKey: SERVER_API ? null : read(KEYS.apiKey),
  locale: initialLocale(),
  location: initialLocation(),
  themePreference: initialThemePreference(),
  ttsVoice: initialTtsVoice(),
  thinking: read(KEYS.thinking) === 'true',
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
const applyRemote = (value: Partial<Settings>) => {
  applyingRemote = true
  useSettings.setState({ ...value, apiKey: null })
  applyingRemote = false
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
  window.addEventListener('focus', () => {
    void refresh()
  })
  window.setInterval(() => {
    void refresh()
  }, 5000)
}
