import { create } from 'zustand'

/** 搜索命中后待定位的消息；nonce 保证同一目标可重复触发滚动。 */
export type RevealTarget = {
  sessionId: string
  messageId: string
  nonce: number
}

export const useReveal = create<{ target: RevealTarget | null }>(() => ({ target: null }))

let revealNonce = 0

/** 请求滚动定位到某条消息（由 MessageList 消费一次后清除）。 */
export const requestReveal = (sessionId: string, messageId: string) => {
  useReveal.setState({ target: { sessionId, messageId, nonce: ++revealNonce } })
}

export const clearReveal = () => {
  useReveal.setState({ target: null })
}
