import type {
  SearchHitRole,
  Session,
  SessionSearchHit,
  SessionSearchResult,
} from './types.js'

// 会话全文检索的文本提取与片段规则。
// 服务端 deploy/auth/data-store.mjs 的 extractSearchDocs / makeSnippet 是同一套规则，改动需同步。
const CITATION = /\s*\[citation:\d+\]/g
const cleanText = (text: unknown) => (typeof text === 'string' ? text.replace(CITATION, '') : '')

type Doc = { messageId: string | null; role: SearchHitRole; text: string }

/** 提取可搜索片段：标题、用户正文、助手正文（不含模板块/思考/工具密文）。 */
const extractDocs = (session: Session): Doc[] => {
  const docs: Doc[] = []
  const title = session.title ?? ''
  if (title.trim()) {
    docs.push({ messageId: null, role: 'title', text: title })
  }
  for (const message of session.messages) {
    if (message.role === 'user') {
      const text = cleanText(message.content)
      if (text.trim()) {
        docs.push({ messageId: message.id, role: 'user', text })
      }
      continue
    }
    const parts: string[] = []
    for (const block of message.blocks) {
      if (block.type === 'text' && !block.isTemplate) {
        const text = cleanText(block.text)
        if (text.trim()) {
          parts.push(text)
        }
      }
    }
    if (parts.length) {
      docs.push({ messageId: message.id, role: 'assistant', text: parts.join('\n') })
    }
  }
  return docs
}

/** 关键词命中处的片段：前后各取约 40 字，按代理对边界对齐。未命中返回 null。 */
const snippetOf = (text: string, query: string): string | null => {
  const at = text.toLowerCase().indexOf(query.toLowerCase())
  if (at < 0) {
    return null
  }
  const radius = 40
  let start = Math.max(0, at - radius)
  let end = Math.min(text.length, at + query.length + radius)
  if (start > 0 && /[\uDC00-\uDFFF]/.test(text[start])) {
    start--
  }
  if (end < text.length && /[\uDC00-\uDFFF]/.test(text[end])) {
    end++
  }
  return `${start > 0 ? '…' : ''}${text.slice(start, end)}${end < text.length ? '…' : ''}`
}

/** 本地（IndexedDB）部署的全量搜索：与服务器版规则和返回结构一致。 */
export const searchSessionsIn = (sessions: Session[], query: string): SessionSearchResult => {
  const trimmed = query.trim()
  const hits: SessionSearchHit[] = []
  if (trimmed) {
    for (const session of sessions) {
      const sessionTitle = session.title ?? ''
      for (const doc of extractDocs(session)) {
        const snippet = snippetOf(doc.text, trimmed)
        if (snippet === null) {
          continue
        }
        hits.push({
          sessionId: session.id,
          sessionTitle,
          messageId: doc.messageId,
          role: doc.role,
          snippet,
          updatedAt: session.updatedAt,
        })
      }
    }
  }
  hits.sort((a, b) => b.updatedAt - a.updatedAt)
  return { query: trimmed, total: hits.length, truncated: hits.length > 50, hits: hits.slice(0, 50) }
}
