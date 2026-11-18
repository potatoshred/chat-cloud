import type { Session } from './types.js'

/**
 * 用量统计的提取规则。
 * 服务端 deploy/auth/data-store.mjs 有同规则实现，改动需同步。
 */
export type UsageRecord = {
  sessionId: string
  sessionTitle: string
  messageId: string
  /** 回复创建时间（客户端时钟） */
  at: number
  model: string | null
  status: string
  inputTokens: number
  outputTokens: number
  cacheCreationTokens: number
  cacheReadTokens: number
  searches: number
  /** 是否开启深度思考 */
  thinking: boolean
  /** 思考强度；关闭思考或历史消息缺省时为 null */
  reasoningEffort: string | null
  /** 首字耗时（毫秒）；没有内容或未记录时为 null */
  firstTokenMs: number | null
  /** 请求总耗时（毫秒）；未记录时为 null */
  durationMs: number | null
}

export type UsageTotals = {
  requests: number
  inputTokens: number
  outputTokens: number
  cacheCreationTokens: number
  cacheReadTokens: number
  searches: number
}

export type UsageReport = {
  hours: number
  since: number
  totals: UsageTotals
  entries: UsageRecord[]
  truncated: boolean
}

export const USAGE_HOURS = 24
export const USAGE_LIMIT = 200

const USAGE_STATUSES = new Set(['done', 'stopped', 'error'])
const SEARCH_KINDS = new Set(['search', 'deep_search', 'image_search', 'deep_image_search'])

const tokenCount = (value: unknown) =>
  typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.round(value) : 0

const millis = (value: unknown) =>
  typeof value === 'number' && Number.isFinite(value) && value >= 0 ? Math.round(value) : null

const countSearches = (message: Session['messages'][number]): number => {
  const reported =
    message.role === 'assistant' ? message.usage?.server_tool_use?.web_search_requests : undefined
  if (typeof reported === 'number' && Number.isFinite(reported) && reported > 0) {
    return Math.round(reported)
  }
  if (message.role !== 'assistant' || !Array.isArray(message.blocks)) {
    return 0
  }
  let searches = 0
  for (const block of message.blocks) {
    if (block.type === 'server_tool_use' && SEARCH_KINDS.has(block.kind)) {
      searches++
    }
  }
  return searches
}

/** 从一条会话提取每条助手回复的用量；导入历史（无 usage）与生成中的回复跳过。 */
export const collectUsage = (session: Session): Omit<UsageRecord, 'sessionId' | 'sessionTitle'>[] => {
  const records: Omit<UsageRecord, 'sessionId' | 'sessionTitle'>[] = []
  for (const message of Array.isArray(session.messages) ? session.messages : []) {
    if (message.role !== 'assistant') {
      continue
    }
    if (!message.usage || !Number.isFinite(message.createdAt)) {
      continue
    }
    if (!USAGE_STATUSES.has(message.status)) {
      continue
    }
    records.push({
      messageId: message.id,
      at: message.createdAt,
      model: message.model ?? null,
      status: message.status,
      inputTokens: tokenCount(message.usage.input_tokens),
      outputTokens: tokenCount(message.usage.output_tokens),
      cacheCreationTokens: tokenCount(message.usage.cache_creation_input_tokens),
      cacheReadTokens: tokenCount(message.usage.cache_read_input_tokens),
      searches: countSearches(message),
      thinking: message.thinking === true,
      reasoningEffort: message.reasoningEffort ?? null,
      firstTokenMs: millis(message.firstTokenMs),
      durationMs: millis(message.durationMs),
    })
  }
  return records
}

/** 只缓存原始记录，24 小时窗口在每次查询时计算（窗口会随时间滑动）。 */
export const summarizeUsage = (records: UsageRecord[], now: number): UsageReport => {
  const since = now - USAGE_HOURS * 3600_000
  const recent = records.filter((record) => record.at >= since).sort((a, b) => b.at - a.at)
  const totals: UsageTotals = {
    requests: recent.length,
    inputTokens: 0,
    outputTokens: 0,
    cacheCreationTokens: 0,
    cacheReadTokens: 0,
    searches: 0,
  }
  for (const record of recent) {
    totals.inputTokens += record.inputTokens
    totals.outputTokens += record.outputTokens
    totals.cacheCreationTokens += record.cacheCreationTokens
    totals.cacheReadTokens += record.cacheReadTokens
    totals.searches += record.searches
  }
  return {
    hours: USAGE_HOURS,
    since,
    totals,
    entries: recent.slice(0, USAGE_LIMIT),
    truncated: recent.length > USAGE_LIMIT,
  }
}
