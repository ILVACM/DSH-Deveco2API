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
 * v5.1 变更（plan.md v5.1）：
 * - 内联思考分离：上游把推理写进 content 时，按 `<think>` / `</think>` 切成 reasoning 块
 * - 工具调用修复：块进入 content、参数分片累积并解析、partial 与 content 同源、类型名统一
 *
 * @module src/adapter/wire.ts
 */

import { randomUUID } from 'node:crypto'
import type { UpstreamEvent, PartialMessage, DoneMessage } from './events.ts'
import type { UpstreamRequestBody } from './messages.ts'

const URL_CHAT = 'https://cn.devecostudio.huawei.com/sse/codeGenie/maas/v2/chat/completions'

/** 思考开标签字面量（P0 实测：GLM-5.3 会把推理写进 content）。 */
const THINK_OPEN = '<think>'
/** 思考闭标签字面量（P0 实测主流形态：只有闭合标签，无开标签）。 */
const THINK_CLOSE = '</think>'

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

/** 内联思考切分结果：字符串 + 在全文中的精确区间（区间供逐帧分发，避免二次实现）。 */
export interface InlineSplit {
  thinkingRaw: string
  textRaw: string
  hasTag: boolean
  /** 思考区间 [thinkingStart, thinkingEnd)；为空时两者相等且为 0 */
  thinkingStart: number
  thinkingEnd: number
  /** 正文区间 [textStart, textEnd) */
  textStart: number
  textEnd: number
}

/** 去掉所有思考标签字面量（防御性清理，plan §4.3 第 4 步）。 */
function stripThinkTags(text: string): string {
  return text.split(THINK_OPEN).join('').split(THINK_CLOSE).join('')
}

/** 区间内首个非空白字符下标；全空白则返回 end。 */
function trimStartOf(text: string, start: number, end: number): number {
  let i = start
  while (i < end && /\s/.test(text[i] as string)) i += 1
  return i
}

/** 区间内末个非空白字符的下一个下标；全空白则返回 start。 */
function trimEndOf(text: string, start: number, end: number): number {
  let i = end
  while (i > start && /\s/.test(text[i - 1] as string)) i -= 1
  return i
}

/**
 * 把整段 content 全文按 plan §4.3 规则切成「思考 / 正文」两部分。
 * 纯函数、无副作用、可单测。区间与字符串由同一次计算得出，不会互相矛盾。
 */
export function splitInlineThinking(full: string): InlineSplit {
  if (full.length === 0) {
    return { thinkingRaw: '', textRaw: '', hasTag: false, thinkingStart: 0, thinkingEnd: 0, textStart: 0, textEnd: 0 }
  }

  const closeIdx = full.indexOf(THINK_CLOSE)
  if (closeIdx >= 0) {
    // 形态 1（P0 主流）：闭合标签之前全是思考，之后是正文
    const tStart = trimStartOf(full, 0, closeIdx)
    const tEnd = trimEndOf(full, tStart, closeIdx)
    const xStart = trimStartOf(full, closeIdx + THINK_CLOSE.length, full.length)
    const xEnd = full.length
    const thinkingEmpty = tStart >= tEnd
    return {
      thinkingRaw: thinkingEmpty ? '' : stripThinkTags(full.slice(tStart, tEnd)),
      textRaw: stripThinkTags(full.slice(xStart, xEnd)),
      hasTag: true,
      thinkingStart: thinkingEmpty ? 0 : tStart,
      thinkingEnd: thinkingEmpty ? 0 : tEnd,
      textStart: xStart,
      textEnd: xEnd,
    }
  }

  const openIdx = full.indexOf(THINK_OPEN)
  if (openIdx >= 0) {
    // 形态 2：只有开标签、未闭合 → 开标签之前是正文，之后是思考
    const xStart = trimStartOf(full, 0, openIdx)
    const xEnd = openIdx
    const tRegionStart = openIdx + THINK_OPEN.length
    const tStart = trimStartOf(full, tRegionStart, full.length)
    const tEnd = trimEndOf(full, tStart, full.length)
    const thinkingEmpty = tStart >= tEnd
    return {
      thinkingRaw: thinkingEmpty ? '' : stripThinkTags(full.slice(tStart, tEnd)),
      textRaw: stripThinkTags(full.slice(xStart, xEnd)),
      hasTag: true,
      thinkingStart: thinkingEmpty ? 0 : tStart,
      thinkingEnd: thinkingEmpty ? 0 : tEnd,
      textStart: xStart,
      textEnd: xEnd,
    }
  }

  // 形态 3：无标签 → 整段为正文（与改前行为完全一致，零回归；不做任何修剪）
  return {
    thinkingRaw: '',
    textRaw: full,
    hasTag: false,
    thinkingStart: 0,
    thinkingEnd: 0,
    textStart: 0,
    textEnd: full.length,
  }
}

/** 判定全文某个字符位置属于思考 / 正文 / 丢弃。 */
function classifyPosition(pos: number, split: InlineSplit, dropThinking: boolean): 'reasoning' | 'text' | 'drop' {
  if (pos >= split.thinkingStart && pos < split.thinkingEnd) return dropThinking ? 'drop' : 'reasoning'
  if (pos >= split.textStart && pos < split.textEnd) return 'text'
  return 'drop'
}

/** 解析工具调用参数文本：失败降级为 `{ __raw }`，绝不静默丢参（plan §4.7.1）。 */
function parseToolArguments(argsText: string): Record<string, unknown> {
  const trimmed = argsText.trim()
  if (trimmed.length === 0) return {}
  try {
    const parsed: unknown = JSON.parse(trimmed)
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>
    }
    return { __raw: argsText }
  } catch {
    return { __raw: argsText }
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
 *
 * v5.1 三遍结构：
 *   第一遍：拼接 content 全文 + 判定是否已有结构化 reasoning_content
 *   第二遍：按 plan §4.3 切分全文；按 D2 决定是否丢弃内联思考；算出工具块起始编号
 *   第三遍：主循环按区间片段分发；收尾统一建块（编号 = content.length）
 */
export async function* parseUpstreamEvents(rawText: Promise<string>, status: number, contentType: string): AsyncGenerator<UpstreamEvent> {
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

  // ── 第一遍：拼接全文 + 判定结构化思考 ──
  let fullContent = ''
  let hasStructuredReasoning = false
  for (const frame of frames) {
    if (frame.event === 'error') continue
    const json = parseJsonSafe(frame.data)
    if (!json) continue
    const choice = extractChoice(json)
    if (!choice) continue
    const delta = choice['delta'] as Record<string, unknown> | undefined
    if (!delta) continue
    const reasoningDelta = delta['reasoning_content']
    if (typeof reasoningDelta === 'string' && reasoningDelta.length > 0) hasStructuredReasoning = true
    const contentDelta = delta['content']
    if (typeof contentDelta === 'string') fullContent += contentDelta
  }

  // ── 第二遍：切分 + D2 决策 + 工具块起始编号 ──
  const split = splitInlineThinking(fullContent)
  const dropInlineThinking = hasStructuredReasoning && split.hasTag
  const willHaveThinking = !dropInlineThinking && split.thinkingRaw.length > 0
  const willHaveText = split.textRaw.length > 0
  const toolBlockBase = (willHaveThinking ? 1 : 0) + (willHaveText ? 1 : 0)

  // ── 第三遍：主循环 ──
  const content: PartialMessage['content'] = []
  const partial: PartialMessage = { content }
  const toolBuffer: Array<{ id: string; name: string; argsText: string }> = []
  const toolOrdinal = new Map<number, number>()
  let textIndex = -1
  let thinkingIndex = -1
  let accumulatedText = ''
  let accumulatedThinking = ''
  let consumed = 0
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

    // tool_calls 增量：按上游 index 累积参数（T2），事件延后到收尾统一发出
    if (delta && Array.isArray(delta['tool_calls'])) {
      for (const tc of delta['tool_calls'] as Array<Record<string, unknown>>) {
        const upstreamIndex = typeof tc['index'] === 'number' ? (tc['index'] as number) : 0
        const id = typeof tc['id'] === 'string' ? (tc['id'] as string) : ''
        const fn = tc['function'] as Record<string, unknown> | undefined
        const name = typeof fn?.['name'] === 'string' ? (fn['name'] as string) : ''
        const argsDelta = typeof fn?.['arguments'] === 'string' ? (fn['arguments'] as string) : ''
        let ordinal = toolOrdinal.get(upstreamIndex)
        if (ordinal === undefined) {
          ordinal = toolBuffer.length
          toolOrdinal.set(upstreamIndex, ordinal)
          toolBuffer.push({ id, name, argsText: '' })
        } else {
          const entry = toolBuffer[ordinal]
          if (entry) {
            if (id && entry.id === '') entry.id = id
            if (name && entry.name === '') entry.name = name
          }
        }
        if (argsDelta.length > 0) {
          const entry = toolBuffer[ordinal]
          if (entry) entry.argsText += argsDelta
        }
      }
    }

    // reasoning_content 增量（结构化通道，行为不变）
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

    // content 增量：按预计算区间切成 reasoning / text / drop 片段（plan §4.6）
    if (delta && typeof delta['content'] === 'string' && (delta['content'] as string).length > 0) {
      const textDelta = delta['content'] as string
      const frameStart = consumed
      const frameEnd = consumed + textDelta.length
      consumed = frameEnd
      let cursor = frameStart
      while (cursor < frameEnd) {
        const kind = classifyPosition(cursor, split, dropInlineThinking)
        let next = cursor + 1
        while (next < frameEnd && classifyPosition(next, split, dropInlineThinking) === kind) next += 1
        const piece = fullContent.slice(cursor, next)
        cursor = next
        if (kind === 'drop' || piece.length === 0) continue
        if (kind === 'reasoning') {
          if (thinkingIndex < 0) {
            thinkingIndex = content.length
            yield { type: 'thinking_start', contentIndex: thinkingIndex, partial }
            content.push({ type: 'thinking', thinking: '' })
          }
          accumulatedThinking += piece
          yield { type: 'thinking_delta', contentIndex: thinkingIndex, delta: piece, partial }
        } else {
          if (textIndex < 0) {
            textIndex = content.length
            yield { type: 'text_start', contentIndex: textIndex, partial }
            content.push({ type: 'text', text: '' })
          }
          accumulatedText += piece
          yield { type: 'text_delta', contentIndex: textIndex, delta: piece, partial }
        }
      }
    }

    // finish_reason
    const reason = typeof choice['finish_reason'] === 'string' ? (choice['finish_reason'] as string) : ''
    if (reason === 'stop') finishReason = 'stop'
    else if (reason === 'length') finishReason = 'length'
    else if (reason === 'tool_calls') finishReason = 'toolUse'
  }

  // 收尾 1：思考块（编号最小）
  if (thinkingIndex >= 0) {
    yield { type: 'thinking_end', contentIndex: thinkingIndex, content: accumulatedThinking, partial }
    const block = content[thinkingIndex]
    if (block && block.type === 'thinking') block['thinking'] = accumulatedThinking
  }

  // 收尾 2：正文块
  if (textIndex >= 0) {
    yield { type: 'text_end', contentIndex: textIndex, content: accumulatedText, partial }
    const block = content[textIndex]
    if (block && block.type === 'text') block['text'] = accumulatedText
  }

  // 收尾 3：工具调用块（T1：推入 content；T3：先入数组再发事件，使 partial 可取到）
  const toolBlocks: Array<{ type: string; id: string; name: string; arguments: string }> = []
  for (let ordinal = 0; ordinal < toolBuffer.length; ordinal += 1) {
    const entry = toolBuffer[ordinal]
    if (!entry) continue
    const parsedArguments = parseToolArguments(entry.argsText)
    const block = {
      type: 'tool-call',
      id: entry.id,
      name: entry.name,
      arguments: JSON.stringify(parsedArguments),
    }
    const blockIndex = content.length
    content.push(block)
    toolBlocks.push(block)
    yield { type: 'toolcall_start', contentIndex: blockIndex, partial }
    if (entry.argsText.length > 0) {
      yield { type: 'toolcall_delta', contentIndex: blockIndex, delta: entry.argsText, partial }
    }
    yield { type: 'toolcall_end', contentIndex: blockIndex, toolCall: { id: entry.id, name: entry.name, arguments: parsedArguments }, partial }
  }

  // 空正文检查（P0 发现：思考吃满预算会导致 content 为空——上游仍返回 200）
  if (finishReason === 'stop' && accumulatedText.length === 0 && accumulatedThinking.length === 0 && toolBlocks.length === 0) {
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
