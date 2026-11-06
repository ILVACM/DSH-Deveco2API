/**
 * 自写 SSE 事件流 → DSH harness chunk 的转译。
 *
 * `toStreamChunks` 的转译逻辑整搬自 opencode2dsh（其 events.ts:132），
 * 唯一改动是事件源从 pi-ai AssistantMessageEvent 换成本地 SSE 解析器
 * 产出的同形事件（见 wire.ts 的 `SseToEventStream`）。
 *
 * DSH chunk 词汇表（dsh-llm 契约，7 种）：
 *   block-start / text-delta / reasoning-delta / tool-call-delta / block-end / usage / finish
 * 流必须以 usage → finish 终止。
 *
 * @module src/adapter/events.ts
 */

/** harness chunk（结构性声明，不 import 宿主类型——避免版本耦合）。 */
export type HarnessChunk =
  | { type: 'block-start'; index: number; blockType: 'text' | 'reasoning' | 'tool-call' }
  | { type: 'text-delta'; index: number; text: string }
  | { type: 'block-end'; index: number; block: { type: 'text'; text: string } | { type: 'reasoning'; text: string } | { type: 'tool-call'; id: string; name: string; arguments: string } }
  | { type: 'reasoning-delta'; index: number; text: string }
  | { type: 'tool-call-delta'; index: number; id: string; name?: string; argumentsDelta: string }
  | { type: 'usage'; usage: { inputTokens: number; outputTokens: number; cacheReadTokens?: number; cacheWriteTokens?: number } }
  | { type: 'finish'; reason: FinishReason; replayState?: unknown }

export type FinishReason =
  | { kind: 'stop' }
  | { kind: 'max-tokens' }
  | { kind: 'tool-calls' }
  | { kind: 'aborted'; failure: { message: string; code: string } }
  | { kind: 'error'; failure: { message: string; code: string } }

/**
 * 上游事件（与 pi-ai AssistantMessageEvent 同形，wire.ts 产出）。
 * 这样 events.ts 的转译逻辑可以逐行对齐 opencode2dsh 的实现。
 */
export type UpstreamEvent =
  | { type: 'start'; partial: PartialMessage }
  | { type: 'text_start'; contentIndex: number; partial: PartialMessage }
  | { type: 'text_delta'; contentIndex: number; delta: string; partial: PartialMessage }
  | { type: 'text_end'; contentIndex: number; content: string; partial: PartialMessage }
  | { type: 'thinking_start'; contentIndex: number; partial: PartialMessage }
  | { type: 'thinking_delta'; contentIndex: number; delta: string; partial: PartialMessage }
  | { type: 'thinking_end'; contentIndex: number; content: string; partial: PartialMessage }
  | { type: 'toolcall_start'; contentIndex: number; partial: PartialMessage }
  | { type: 'toolcall_delta'; contentIndex: number; delta: string; partial: PartialMessage }
  | { type: 'toolcall_end'; contentIndex: number; toolCall: { id: string; name: string; arguments: Record<string, unknown> }; partial: PartialMessage }
  | { type: 'done'; message: DoneMessage }
  | { type: 'error'; error: DoneMessage }

export interface PartialMessage {
  content: Array<{ type: string; id?: string; name?: string; [key: string]: unknown }>
  [key: string]: unknown
}

export interface DoneMessage {
  api: string
  provider: string
  model: string
  content: Array<{ type: string; [key: string]: unknown }>
  usage: { input: number; output: number; cacheRead: number; cacheWrite: number; totalTokens: number }
  stopReason: 'stop' | 'length' | 'toolUse' | 'error' | 'aborted'
  errorMessage?: string
  [key: string]: unknown
}

const CONTEXT_WINDOW_EXCEEDED = 'CONTEXT_WINDOW_EXCEEDED'
const EMPTY_RESPONSE = 'EMPTY_RESPONSE'
const QUOTA_EXCEEDED = 'QUOTA_EXCEEDED'

/**
 * 错误分类：把上游五花八门的文案映射成稳定错误码。
 * 分类顺序重要——先匹配更具体的（REGION / AUTH / QUOTA），再泛化（RATE_LIMIT / SERVER）。
 */
export function classifyError(text: string): string {
  // DevEco 特征：errorCode:4016 / "invalid accessToken"
  if (/errorCode["\s:]*4016|invalid\s+accessToken/i.test(text)) return 'AUTH'
  // 通用 401/403
  if (/\b(?:401|403)\b/.test(text)) return 'AUTH'
  if (/insufficient|quota|billing|FreeUsageLimit/i.test(text)) return QUOTA_EXCEEDED
  if (/\b429\b|rate.?limit/i.test(text)) return 'RATE_LIMIT'
  if (/\b413\b|payload too large|request body too large/i.test(text)) return 'INVALID_REQUEST'
  if (/\b400\b|invalid.?request/i.test(text)) return 'INVALID_REQUEST'
  if (/\b5\d\d\b/.test(text)) return 'SERVER'
  if (/\btime(?:d)?\s*out\b|timeout/i.test(text)) return 'TIMEOUT'
  if (/\b(?:network|connection|socket|fetch)\b|\bECONN[A-Z]+\b|terminated|premature close/i.test(text)) return 'TRANSPORT'
  return 'UPSTREAM'
}

function isContextOverflow(message: DoneMessage, contextWindow: number): boolean {
  return message.stopReason === 'stop' && message.usage.input > contextWindow
}

/** 停止原因 → FinishReason（对齐 opencode2dsh events.ts:85-113）。 */
function mapStopReason(message: DoneMessage, contextWindow: number): FinishReason {
  if (isContextOverflow(message, contextWindow)) {
    return {
      kind: 'error',
      failure: {
        message: message.errorMessage ?? `context window exceeded (input ${message.usage.input} > ${contextWindow})`,
        code: CONTEXT_WINDOW_EXCEEDED,
      },
    }
  }
  switch (message.stopReason) {
    case 'stop': {
      const hasContent = message.content.some((b) => b.type === 'text' || b.type === 'tool-call')
      if (!hasContent) {
        return {
          kind: 'error',
          failure: { message: `model "${message.model}" returned a completed response with no content`, code: EMPTY_RESPONSE },
        }
      }
      return { kind: 'stop' }
    }
    case 'length':
      return { kind: 'max-tokens' }
    case 'toolUse':
      return { kind: 'tool-calls' }
    case 'aborted':
      return { kind: 'aborted', failure: { message: message.errorMessage ?? 'stream aborted', code: 'ABORTED' } }
    case 'error':
      return {
        kind: 'error',
        failure: { message: message.errorMessage ?? 'stream error', code: classifyError(message.errorMessage ?? '') },
      }
  }
}

function mapUsage(usage: DoneMessage['usage']): Extract<HarnessChunk, { type: 'usage' }>['usage'] {
  return {
    inputTokens: usage.input,
    outputTokens: usage.output,
    ...(usage.cacheRead > 0 ? { cacheReadTokens: usage.cacheRead } : {}),
    ...(usage.cacheWrite > 0 ? { cacheWriteTokens: usage.cacheWrite } : {}),
  }
}

/**
 * 把上游事件流翻译成 harness chunks。
 * 上游从不中途 throw：失败以 `error` 事件到达，转成 error/aborted finish。
 */
export async function* toStreamChunks(events: AsyncIterable<UpstreamEvent>, contextWindow: number): AsyncGenerator<HarnessChunk> {
  const toolIds = new Map<number, { id: string; name: string }>()
  for await (const event of events) {
    switch (event.type) {
      case 'start':
        break
      case 'text_start':
        yield { type: 'block-start', index: event.contentIndex, blockType: 'text' }
        break
      case 'text_delta':
        yield { type: 'text-delta', index: event.contentIndex, text: event.delta }
        break
      case 'text_end':
        yield { type: 'block-end', index: event.contentIndex, block: { type: 'text', text: event.content } }
        break
      case 'thinking_start':
        yield { type: 'block-start', index: event.contentIndex, blockType: 'reasoning' }
        break
      case 'thinking_delta':
        yield { type: 'reasoning-delta', index: event.contentIndex, text: event.delta }
        break
      case 'thinking_end':
        yield { type: 'block-end', index: event.contentIndex, block: { type: 'reasoning', text: event.content } }
        break
      case 'toolcall_start': {
        const partial = event.partial.content[event.contentIndex]
        const id = partial?.type === 'toolCall' ? (typeof partial.id === 'string' ? partial.id : '') : ''
        const name = partial?.type === 'toolCall' ? (typeof partial.name === 'string' ? partial.name : '') : ''
        toolIds.set(event.contentIndex, { id, name })
        yield { type: 'block-start', index: event.contentIndex, blockType: 'tool-call' }
        break
      }
      case 'toolcall_delta': {
        const known = toolIds.get(event.contentIndex)
        yield {
          type: 'tool-call-delta',
          index: event.contentIndex,
          id: known?.id ?? '',
          ...(known?.name !== undefined && known.name.length > 0 ? { name: known.name } : {}),
          argumentsDelta: event.delta,
        }
        break
      }
      case 'toolcall_end':
        yield {
          type: 'block-end',
          index: event.contentIndex,
          block: {
            type: 'tool-call',
            id: event.toolCall.id,
            name: event.toolCall.name,
            arguments: JSON.stringify(event.toolCall.arguments),
          },
        }
        break
      case 'done':
        yield { type: 'usage', usage: mapUsage(event.message.usage) }
        yield { type: 'finish', reason: mapStopReason(event.message, contextWindow) }
        return
      case 'error':
        yield { type: 'usage', usage: mapUsage(event.error.usage) }
        yield { type: 'finish', reason: mapStopReason(event.error, contextWindow) }
        return
    }
  }
  throw new Error('deveco2dsh: 上游事件流未以 done/error 终止')
}
