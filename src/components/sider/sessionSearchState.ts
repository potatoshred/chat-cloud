import { create } from 'zustand'

/** 居中的会话搜索浮层开关。 */
export const useSessionSearch = create<{ open: boolean }>(() => ({ open: false }))

export const openSessionSearch = () => useSessionSearch.setState({ open: true })
export const closeSessionSearch = () => useSessionSearch.setState({ open: false })
