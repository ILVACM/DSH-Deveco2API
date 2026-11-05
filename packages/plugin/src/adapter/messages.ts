/**
 * DSH GenerateOptions → DevEco 上游请求 body 的转换。
 *
 * 从 opencode2dsh 的 messages.ts:239 `toPiContext` 移植并适配：
 * - 删掉 Zen 免费通道的 bash/read 工具门（DevEco 无此门禁）
 * - 剥离 `</think>` 泄漏（P0 实测 GLM-5.3 会把推理写进 content）
 * - 图片块丢弃（DevEco 模型全部 text-only，P0 验证 input_modalities=["text"]）
 *
 * @module src/adapter/messages.ts
 */

/** harness 侧的消息结构（结构性声明，不 import 宿主类型）。 */
export interface HarnessTool {
  name: string
  description: string
  parameters: unknown
}

export type HarnessBlock =
  | { type: 'text'; text: string }
  | { type: 'reasoning'; text: string }
  | { type: 'tool-call'; id: string; name: string; arguments: string }
  | { type: 'image'; [key: string]: unknown }
  | { type: 'tool-result'; toolCallId: string; content: HarnessBlock[]; isError?: boolean; [key: string]: unknown }

export interface HarnessMessage {
  role: 'system' | 'user' | 'assistant'
  content: HarnessBlock[]
  source?: { kind: string; provider?: string; model?: string; callId?: string; [key: string]: unknown }
}

export interface HarnessGenerateOptions {
  provider: string
  model: string
  messages: HarnessMessage[]
  system?: string
  tools?: HarnessTool[]
  maxTokens?: number
  temperature?: number
  reasoning?: string
  reasoningEffort?: string
  signal?: AbortSignal
  [key: string]: unknown
}

/** 上游 OpenAI Chat Completions 的消息格式。 */
export interface UpstreamMessage {
  role: 'system' | 'user' | 'assistant' | 'tool'
  content: string
  tool_call_id?: string
  tool_calls?: Array<{ id: string; type: 'function'; function: { name: string; arguments: string } }>
}

/** 上游请求 body。 */
export interface UpstreamRequestBody {
  model: string
  messages: UpstreamMessage[]
  stream: true
  max_tokens?: number
  temperature?: number
  tools?: Array<{ type: 'function'; function: { name: string; description: string; parameters: unknown } }>
  tool_choice?: 'auto' | 'none'
  reasoning_effort?: string
}

/**
 * 剥离 `</think>` 之前的泄漏内容（P0 实测发现）。
 *
 * GLM-5.3 会把内部推理写进 content，格式为：
 *   "...思考过程...</think>
   正文"
 * 取 `</think>` 之后的部分；若无标签则原样返回。
 */
export function stripThinkLeak(text: string): string {
  const index = text.indexOf('</think>')
  return index >= 0 ? text.slice(index + '</think>'.length) : text
}

/**
 * 把 DSH 的消息列表转成上游格式。
 *
 * 转换规则：
 * - system 消息 → OpenAI system role（合并多条）
 * - user 文本 → user role（图片块替换为占位符，DevEco 不支持）
 * - assistant 的 text/tool-call → assistant role（含 tool_calls 数组）
 * - tool-result → tool role（tool_call_id 回填）
 */
export function toUpstreamMessages(options: HarnessGenerateOptions): UpstreamMessage[] {
  const messages: UpstreamMessage[] = []
  const toolNames = new Map<string, string>()

  // 合并 system 消息（DSH 会把 system prompt 作为首条消息传入）
  const systemTexts: string[] = []
  if (typeof options.system === 'string' && options.system.length > 0) systemTexts.push(options.system)
  for (const message of options.messages) {
    if (message.role === 'system') {
      const text = message.content.filter((b) => b.type === 'text').map((b) => (b as { text: string }).text).join('\n')
      if (text.length > 0) systemTexts.push(text)
    }
  }
  if (systemTexts.length > 0) messages.push({ role: 'system', content: systemTexts.join('\n') })

  for (const message of options.messages) {
    if (message.role === 'system') continue

    if (message.role === 'assistant') {
      const texts: string[] = []
      const toolCalls: NonNullable<UpstreamMessage['tool_calls']> = []
      for (const block of message.content) {
        if (block.type === 'text') {
          const cleaned = stripThinkLeak((block as { text: string }).text)
          if (cleaned.trim().length > 0) texts.push(cleaned)
        } else if (block.type === 'tool-call') {
          const call = block as { id: string; name: string; arguments: string }
          toolNames.set(call.id, call.name)
          toolCalls.push({ id: call.id, type: 'function', function: { name: call.name, arguments: call.arguments } })
        }
      }
      messages.push({
        role: 'assistant',
        content: texts.join(''),
        ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
      })
      continue
    }

    // user 消息：文本块 + tool-result 块
    const userTexts: string[] = []
    const toolResults: Array<{ toolCallId: string; content: string; isError: boolean }> = []
    for (const block of message.content) {
      if (block.type === 'text') {
        userTexts.push((block as { text: string }).text)
      } else if (block.type === 'image') {
        // DevEco 模型 text-only：图片替换为占位符，保证消息序列完整
        userTexts.push('[image attachment: DevEco 模型不支持图片输入，已跳过]')
      } else if (block.type === 'tool-result') {
        const result = block as { toolCallId: string; content: HarnessBlock[]; isError?: boolean }
        const text = result.content
          .filter((b) => b.type === 'text')
          .map((b) => (b as { text: string }).text)
          .join('\n')
        toolResults.push({
          toolCallId: result.toolCallId,
          content: text.length > 0 ? text : '(no output)',
          isError: result.isError ?? false,
        })
      }
    }
    if (userTexts.length > 0) messages.push({ role: 'user', content: userTexts.join('\n') })
    for (const result of toolResults) {
      messages.push({ role: 'tool', content: result.content, tool_call_id: result.toolCallId })
    }
  }

  return messages
}

/**
 * 构造完整的上游请求 body。
 *
 * 默认值：
 * - stream: true（DSH 恒为流式；非流式路径 /no-stream/ 不在此处理）
 * - max_tokens: 目录声明的输出上限（不低于 128——P0 实测 GLM-5.3 会吃满小预算）
 * - tool_choice: 有工具时 auto，无工具时省略
 * - reasoning_effort: DSH 选择的思考档位直接透传（low/high/max 均合法；off/none 不合法，转 undefined）
 */
export function toUpstreamBody(options: HarnessGenerateOptions, catalogMaxTokens: number): UpstreamRequestBody {
  const messages = toUpstreamMessages(options)
  const tools = options.tools?.map((tool) => ({
    type: 'function' as const,
    function: { name: tool.name, description: tool.description, parameters: tool.parameters },
  }))
  const maxTokens = Math.max(options.maxTokens ?? 0, 128, Math.min(catalogMaxTokens, 8192))
  const effort = normalizeEffort(options.reasoningEffort ?? options.reasoning)

  const body: UpstreamRequestBody = {
    model: options.model,
    messages,
    stream: true,
    max_tokens: maxTokens,
    ...(tools && tools.length > 0 ? { tools, tool_choice: 'auto' as const } : {}),
    ...(options.temperature !== undefined ? { temperature: options.temperature } : {}),
    ...(effort !== undefined ? { reasoning_effort: effort } : {}),
  }
  return body
}

/**
 * 思考档位归一化。
 * 实测合法值：low / high / max / none；off 不合法（会触发 403）。
 * DSH 的 off → 不传（保持上游默认）。
 */
function normalizeEffort(effort: string | undefined): string | undefined {
  if (effort === undefined || effort === '') return undefined
  if (effort === 'off') return undefined
  const allowed = ['low', 'medium', 'high', 'xhigh', 'max', 'none']
  return allowed.includes(effort) ? effort : undefined
}
