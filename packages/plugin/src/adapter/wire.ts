/**
 * 自写 HTTP 流式请求层：直接对接 DevEco MaaS 端点。
 *
 * 为什么不用 pi-ai 的 openai-completions 模块（对齐计划 §6 偏差说明）：
 * DevEco 的协议与 pi-ai 内置的 openai SDK 假设有 4 处冲突（全部 P0 实测）：
 * 1. SSE 帧前有 `id: N` 行（标准 OpenAI 客户端忽略此行，但 pi-ai 的 SDK 假设无此行）
 * 2. 每帧都带 `usage`（OpenAI 只在末尾带一次）
 * 3. 坏 token 返回 HTTP 200 + 裸 JSON `errorCode:4016`（OpenAI SDK 期望 401 + error 字段）
 * 4. 未知模型静默回落到 deepseek-v4-flash（无错误）
 *
 * 自写约 300 行，全部行为已由 P0 probe.ts 逐项验证，且省掉 openai SDK 依赖。
 *
 * @module src/adapter/wire.ts
 */

import { randomUUID } from 'node:crypto'
import type { UpstreamEvent, PartialMessage, DoneMessage } from './events.ts'
import type { UpstreamRequestBody } from './messages.ts'

const URL_CHAT = 'https://cn.devecostudio.huawei.com/sse/codeGenie/maas/v2/chat/completions'

/** 32 位小写 hex（Chat-Id / Session-Id 形状，对齐 deveco 的 randomUUID().replace(/-/g,'')）。 */
function uuid32(): string {
  return randomUUID().replace(/-/g, '')
}

export interface WireOptions {
  access: string
  body: UpstreamRequestBody
  signal?: AbortSignal
  timeoutMs?: number
}

export interface WireResult {
  status: number
  contentType: string
  events: AsyncIterable<UpstreamEvent>
  rawText: Promise<string>
}

/**
 * 发起流式对话请求，返回事件流。
 *
 * 最小必需头三件套（P0 实测）：
 *   authorization + Chat-Id + content-type
 * 可选：Session-Id / lang
 */
export async function streamChat(options: WireOptions): Promise<WireResult> {
  const headers: Record<string, string> = {
    'content-type': 'application/json',
    authorization: `Bearer ${options.access}`,
    'Chat-Id': uuid32(),
    'Session-Id': uuid32(),
    lang: 'en',
  }

  const response = await fetch(URL_CHAT, {
    method: 'POST',
    headers,
    body: JSON.stringify(options.body),
    signal: options.signal ?? AbortSignal.timeout(options.timeoutMs ?? 60_000),
  })

  const contentType = response.headers.get('content-type') ?? ''
  const rawText = response.text()

  return {
    status: response.status,
    contentType,
    events: parseUpstreamEvents(rawText, response.status, contentType),
    rawText,
  }
}

/**
 * 把上游 SSE 原文解析成 pi-ai 同形事件流。
 *
 * 处理 DevEco 的四种非标准行为（全部 P0 实测）：
 * 1. `id: N` + `data: {...}` 交替 → 解析成 text_delta / thinking_delta / toolcall_* 事件
 * 2. 每帧带 `usage` → 只取末帧的作为 done.usage
 * 3. `event: error` 帧 → 产出 error 事件（HTTP 状态码可能是 200）
 * 4. 裸 JSON `{"errorCode":4016,...}` → 产出 error 事件（无 SSE 包装）
 */
async function* parseUpstreamEvents(rawText: Promise<string>, status: number, contentType: string): AsyncGenerator<UpstreamEvent> {
  const raw = await rawText

  // 情况 1：裸 JSON 错误（坏 token → HTTP 200 + errorCode JSON）
  if (contentType.includes('application/json')) {
    yield makeErrorEvent(raw, status)
    return
  }

  // 情况 2：SSE 流（正常响应 / HTTP 200 内的 SSE 错误 / HTTP 4xx SSE）
  const frames = parseSseFrames(raw)
  if (frames.length === 0) {
    yield makeErrorEvent(raw, status)
    return
  }

  // 遍历帧，逐帧产出事件
  let textIndex = -1
  let thinkingIndex = -1
  let toolCallIndex = -1
  const partial: PartialMessage = { content: [] }
  let content: DoneMessage['content'] = []
  let accumulatedText = ''
  let accumulatedThinking = ''
  const toolCalls: DoneMessage['content'] = []
  let usage: DoneMessage['usage'] = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0 }
  let finishReason: DoneMessage['stopReason'] = 'stop'
  let errorMessage: string | undefined
  let echoModel = ''

  for (const frame of frames) {
    // event: error 帧
    if (frame.event === 'error') {
      yield makeErrorEvent(frame.data, status)
      return
    }
    const json = parseJsonSafe(frame.data)
    if (!json) continue

    // 每帧都可能带 usage；只留最新
    const frameUsage = extractUsage(json)
    if (frameUsage) usage = frameUsage

    const model = typeof json['model'] === 'string' ? (json['model'] as string) : ''
    if (model && !echoModel) echoModel = model

    const choice = extractChoice(json)
    if (!choice) continue

    const delta = choice['delta'] as Record<string, unknown> | undefined

    // tool_calls 增量
    if (delta && Array.isArray(delta['tool_calls'])) {
      for (const tc of delta['tool_calls'] as Array<Record<string, unknown>>) {
        const index = typeof tc['index'] === 'number' ? (tc['index'] as number) : 0
        const id = typeof tc['id'] === 'string' ? (tc['id'] as string) : ''
        const fn = tc['function'] as Record<string, unknown> | undefined
        const name = typeof fn?.['name'] === 'string' ? (fn['name'] as string) : ''
        const argsDelta = typeof fn?.['arguments'] === 'string' ? (fn['arguments'] as string) : ''

        if (id && !toolCalls.some((c) => c.type === 'toolCall' && c.id === id)) {
          toolCallIndex += 1
          yield { type: 'toolcall_start', contentIndex: toolCallIndex, partial }
          toolCalls.push({ type: 'toolCall', id, name })
        }
        if (argsDelta.length > 0) {
          yield { type: 'toolcall_delta', contentIndex: toolCallIndex, delta: argsDelta, partial }
          const existing = toolCalls.find((c) => c.type === 'toolCall' && c.id === id)
          if (existing && existing.type === 'toolCall') {
            existing['arguments'] = ((existing['arguments'] as Record<string, unknown>) ?? {}) as Record<string, unknown>
          }
        }
      }
    }

    // reasoning_content 增量（thinking）
    if (delta && typeof delta['reasoning_content'] === 'string') {
      const thinkingDelta = delta['reasoning_content'] as string
      if (thinkingDelta.length > 0) {
        if (thinkingIndex < 0) {
          thinkingIndex = content.length
          yield { type: 'thinking_start', contentIndex: thinkingIndex, partial }
          content.push({ type: 'thinking', thinking: '' })
        }
        accumulatedThinking += thinkingDelta
        yield { type: 'thinking_delta', contentIndex: thinkingIndex, delta: thinkingDelta, partial }
      }
    }

    // content 增量
    if (delta && typeof delta['content'] === 'string' && (delta['content'] as string).length > 0) {
      const textDelta = delta['content'] as string
      if (textIndex < 0) {
        textIndex = content.length
        yield { type: 'text_start', contentIndex: textIndex, partial }
        content.push({ type: 'text', text: '' })
      }
      accumulatedText += textDelta
      yield { type: 'text_delta', contentIndex: textIndex, delta: textDelta, partial }
    }

    // finish_reason
    const reason = typeof choice['finish_reason'] === 'string' ? (choice['finish_reason'] as string) : ''
    if (reason === 'stop') finishReason = 'stop'
    else if (reason === 'length') finishReason = 'length'
    else if (reason === 'tool_calls') finishReason = 'toolUse'
  }

  // 收尾：产出 text_end / thinking_end / toolcall_end
  if (thinkingIndex >= 0) {
    yield { type: 'thinking_end', contentIndex: thinkingIndex, content: accumulatedThinking, partial }
    const block = content[thinkingIndex]
    if (block && block.type === 'thinking') block['thinking'] = accumulatedThinking
  }
  if (textIndex >= 0) {
    yield { type: 'text_end', contentIndex: textIndex, content: accumulatedText, partial }
    const block = content[textIndex]
    if (block && block.type === 'text') block['text'] = accumulatedText
  }
  for (const toolCall of toolCalls) {
    const call = toolCall as { type: string; id?: string; name?: string; [key: string]: unknown }
    yield {
      type: 'toolcall_end',
      contentIndex: toolCalls.indexOf(toolCall),
      toolCall: { id: typeof call['id'] === 'string' ? call['id'] : '', name: typeof call['name'] === 'string' ? call['name'] : '', arguments: {} },
      partial,
    }
  }

  // 空正文检查（P0 发现：思考吃满预算会导致 content 为空——上游仍返回 200）
  if (finishReason === 'stop' && accumulatedText.length === 0 && accumulatedThinking.length === 0 && toolCalls.length === 0) {
    errorMessage = `model "${echoModel}" returned a completed response with no content`
    finishReason = 'error'
  }

  const message: DoneMessage = {
    api: 'openai-completions',
    provider: 'deveco2dsh',
    model: echoModel,
    content,
    usage,
    stopReason: finishReason,
    ...(errorMessage !== undefined ? { errorMessage } : {}),
  }
  yield { type: 'done', message }
}

/** 解析 SSE 帧序列（`id: N` + `event:` + `data:` 组合，空行分隔）。 */
function parseSseFrames(raw: string): Array<{ id?: string; event?: string; data: string }> {
  const frames: Array<{ id?: string; event?: string; data: string }> = []
  let current: { id?: string; event?: string; data: string[] } = { data: [] }
  const flush = () => {
    if (current.data.length > 0 || current.event !== undefined) {
      frames.push({
        ...(current.id !== undefined ? { id: current.id } : {}),
        ...(current.event !== undefined ? { event: current.event } : {}),
        data: current.data.join('\n'),
      })
    }
    current = { data: [] }
  }
  for (const line of raw.split(/\r?\n/)) {
    if (line === '') {
      flush()
      continue
    }
    if (line.startsWith('id:')) current.id = line.slice(3).trim()
    else if (line.startsWith('event:')) current.event = line.slice(6).trim()
    else if (line.startsWith('data:')) current.data.push(line.slice(5).trim())
  }
  flush()
  return frames
}

function parseJsonSafe(text: string): Record<string, unknown> | undefined {
  const trimmed = text.trim()
  if (!trimmed || trimmed === '[DONE]') return undefined
  try {
    const parsed: unknown = JSON.parse(trimmed)
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>
    }
  } catch {
    // 非 JSON 帧
  }
  return undefined
}

function extractUsage(json: Record<string, unknown>): DoneMessage['usage'] | undefined {
  const usage = json['usage']
  if (!usage || typeof usage !== 'object') return undefined
  const record = usage as Record<string, unknown>
  const input = typeof record['prompt_tokens'] === 'number' ? (record['prompt_tokens'] as number) : 0
  const output = typeof record['completion_tokens'] === 'number' ? (record['completion_tokens'] as number) : 0
  const total = typeof record['total_tokens'] === 'number' ? (record['total_tokens'] as number) : input + output
  const cacheDetails = record['prompt_tokens_details'] as Record<string, unknown> | undefined
  const cacheRead = typeof cacheDetails?.['cached_tokens'] === 'number' ? (cacheDetails['cached_tokens'] as number) : 0
  return { input, output, cacheRead, cacheWrite: 0, totalTokens: total }
}

function extractChoice(json: Record<string, unknown>): Record<string, unknown> | undefined {
  const choices = json['choices']
  if (!Array.isArray(choices) || choices.length === 0) return undefined
  const choice = choices[0]
  if (!choice || typeof choice !== 'object') return undefined
  return choice as Record<string, unknown>
}

function makeErrorEvent(raw: string, status: number): UpstreamEvent {
  const message: DoneMessage = {
    api: 'openai-completions',
    provider: 'deveco2dsh',
    model: '',
    content: [],
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0 },
    stopReason: 'error',
    errorMessage: describeUpstreamError(raw, status),
  }
  return { type: 'error', error: message }
}

/** 从 HTTP 200 内的裸 JSON / SSE error 帧里提取人类可读错误信息。 */
export function describeUpstreamError(raw: string, status: number): string {
  // DevEco 特征：裸 errorCode JSON
  const json = parseJsonSafe(raw)
  if (json) {
    const errorCode = json['errorCode']
    const errorMsg = json['errorMsg']
    if (typeof errorCode === 'number' && typeof errorMsg === 'string') {
      return `errorCode:${errorCode} ${errorMsg} (HTTP ${status})`
    }
    // OpenAI 形状的 error 对象
    const error = json['error']
    if (error && typeof error === 'object') {
      const record = error as Record<string, unknown>
      const message = typeof record['message'] === 'string' ? (record['message'] as string) : ''
      const original = record['param'] as Record<string, unknown> | undefined
      const originalMessage = typeof original?.['originalMessage'] === 'string' ? (original['originalMessage'] as string) : ''
      const type = typeof record['type'] === 'string' ? (record['type'] as string) : ''
      const parts = [message, originalMessage, type].filter(Boolean).join(' | ')
      if (parts.length > 0) return `${parts} (HTTP ${status})`
    }
  }
  // 兜底：截断原文
  return `upstream error (HTTP ${status}): ${raw.slice(0, 200)}`
}
