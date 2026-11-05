/**
 * events.ts 单测：toStreamChunks 的 chunk 序列 + classifyError + stripThinkLeak。
 * 用 P0 实测的 SSE 帧构造上游事件流，断言产出正确的 harness chunk 序列。
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { toStreamChunks, classifyError, type UpstreamEvent, type DoneMessage } from '../src/adapter/events.ts'
import { stripThinkLeak, toUpstreamBody, type HarnessGenerateOptions } from '../src/adapter/messages.ts'

test('toStreamChunks：text_start/delta/end → block-start/text-delta/block-end', async () => {
  const events: UpstreamEvent[] = [
    { type: 'start', partial: emptyPartial() },
    { type: 'text_start', contentIndex: 0, partial: emptyPartial() },
    { type: 'text_delta', contentIndex: 0, delta: '你', partial: emptyPartial() },
    { type: 'text_delta', contentIndex: 0, delta: '好', partial: emptyPartial() },
    { type: 'text_end', contentIndex: 0, content: '你好', partial: emptyPartial() },
    { type: 'done', message: makeDone('你好') },
  ]
  const chunks = await collect(toStreamChunks(asyncIter(events), 170000))
  assert.deepEqual(
    chunks.map((c) => c.type),
    ['block-start', 'text-delta', 'text-delta', 'block-end', 'usage', 'finish'],
  )
  assert.equal((chunks[1] as { text: string }).text, '你')
  assert.equal((chunks[3] as { block: { text: string } }).block.text, '你好')
  assert.deepEqual((chunks[5] as { reason: { kind: string } }).reason.kind, 'stop')
})

test('toStreamChunks：thinking_start/delta/end → reasoning 块', async () => {
  const events: UpstreamEvent[] = [
    { type: 'thinking_start', contentIndex: 0, partial: emptyPartial() },
    { type: 'thinking_delta', contentIndex: 0, delta: '推理中', partial: emptyPartial() },
    { type: 'thinking_end', contentIndex: 0, content: '推理中', partial: emptyPartial() },
    { type: 'done', message: makeDone('', '推理中') },
  ]
  const chunks = await collect(toStreamChunks(asyncIter(events), 170000))
  assert.equal((chunks[0] as { blockType: string }).blockType, 'reasoning')
  assert.equal(chunks[1]?.type, 'reasoning-delta')
  assert.equal((chunks[2] as { block: { type: string } }).block.type, 'reasoning')
})

test('toStreamChunks：finish_reason=length → max-tokens', async () => {
  const done = makeDone('partial text')
  done.stopReason = 'length'
  const events: UpstreamEvent[] = [{ type: 'done', message: done }]
  const chunks = await collect(toStreamChunks(asyncIter(events), 170000))
  assert.deepEqual((chunks[1] as { reason: { kind: string } }).reason.kind, 'max-tokens')
})

test('toStreamChunks：error 事件 → error finish + 错误分类', async () => {
  const error = makeDone('', '')
  error.errorMessage = 'errorCode:4016 invalid accessToken. (HTTP 200)'
  error.stopReason = 'error'
  const events: UpstreamEvent[] = [{ type: 'error', error }]
  const chunks = await collect(toStreamChunks(asyncIter(events), 170000))
  const finish = chunks[1] as { reason: { kind: string; failure: { code: string } } }
  assert.equal(finish.reason.kind, 'error')
  assert.equal(finish.reason.failure.code, 'AUTH')
})

test('toStreamChunks：done 但 content 全空 → EMPTY_RESPONSE', async () => {
  const done = makeDone('', '')
  const events: UpstreamEvent[] = [{ type: 'done', message: done }]
  const chunks = await collect(toStreamChunks(asyncIter(events), 170000))
  const finish = chunks[1] as { reason: { kind: string; failure: { code: string } } }
  assert.equal(finish.reason.kind, 'error')
  assert.equal(finish.reason.failure.code, 'EMPTY_RESPONSE')
})

test('toStreamChunks：流未终止 → throw', async () => {
  const events: UpstreamEvent[] = [
    { type: 'start', partial: emptyPartial() },
  ]
  await assert.rejects(async () => {
    for await (const chunk of toStreamChunks(asyncIter(events), 170000)) {
      void chunk
    }
  }, /未以 done\/error 终止/)
})

test('classifyError：P0 实测的四种错误形态', () => {
  // 8a 坏 token（裸 JSON）
  assert.equal(classifyError('errorCode:4016 invalid accessToken.'), 'AUTH')
  // 401/403
  assert.equal(classifyError('HTTP 403 forbidden'), 'AUTH')
  // 429 / 限流
  assert.equal(classifyError('429 rate limit exceeded'), 'RATE_LIMIT')
  // 配额
  assert.equal(classifyError('FreeUsageLimitError quota exceeded'), 'QUOTA_EXCEEDED')
  // 5xx
  assert.equal(classifyError('500 internal server error'), 'SERVER')
  // 超时
  assert.equal(classifyError('request timed out after 30s'), 'TIMEOUT')
  // 传输
  assert.equal(classifyError('fetch failed ECONNRESET'), 'TRANSPORT')
  // 兜底
  assert.equal(classifyError('something unexpected'), 'UPSTREAM')
})

test('stripThinkLeak：剥离 </think> 之前的泄漏（P0 实测 GLM-5.3 行为）', () => {
  assert.equal(stripThinkLeak('思考过程</think>正文内容'), '正文内容')
  assert.equal(stripThinkLeak('无标签正文'), '无标签正文')
  assert.equal(stripThinkLeak(''), '')
})

test('toUpstreamBody：基础构造 + max_tokens 下限 128（P0 实测 GLM-5.3 吃满小预算）', () => {
  const body = toUpstreamBody(makeOptions(), 32000)
  assert.equal(body.model, 'GLM-5.1')
  assert.equal(body.stream, true)
  assert.ok((body.max_tokens ?? 0) >= 128)
})

test('toUpstreamBody：reasoning_effort 透传 + off 归一化为不传（P0 实测 off 非法）', () => {
  const withHigh = toUpstreamBody({ ...makeOptions(), reasoningEffort: 'high' }, 32000)
  assert.equal(withHigh.reasoning_effort, 'high')
  const withOff = toUpstreamBody({ ...makeOptions(), reasoningEffort: 'off' }, 32000)
  assert.equal(withOff.reasoning_effort, undefined)
  const withInvalid = toUpstreamBody({ ...makeOptions(), reasoningEffort: 'invalid-value' }, 32000)
  assert.equal(withInvalid.reasoning_effort, undefined)
})

test('toUpstreamBody：assistant 的 tool-call 转成 tool_calls 数组', () => {
  const options = makeOptions()
  options.messages.push({
    role: 'assistant',
    content: [
      { type: 'text', text: '我来调用工具' },
      { type: 'tool-call', id: 'tc_001', name: 'get_weather', arguments: '{"city":"北京"}' },
    ],
  })
  options.messages.push({
    role: 'user',
    content: [{ type: 'tool-result', toolCallId: 'tc_001', content: [{ type: 'text', text: '晴 25°C' }] }],
  })
  const body = toUpstreamBody(options as never, 32000)
  const assistant = body.messages.find((m) => m.role === 'assistant')
  assert.ok(assistant)
  assert.ok(assistant.tool_calls)
  assert.equal(assistant.tool_calls?.[0]?.id, 'tc_001')
  const tool = body.messages.find((m) => m.role === 'tool')
  assert.ok(tool)
  assert.equal(tool?.tool_call_id, 'tc_001')
})

// ===== 辅助 =====

function emptyPartial() {
  return { content: [] }
}

function makeDone(text: string, thinking = ''): DoneMessage {
  const content: DoneMessage['content'] = []
  if (thinking) content.push({ type: 'thinking', thinking })
  if (text) content.push({ type: 'text', text })
  return {
    api: 'openai-completions',
    provider: 'deveco2dsh',
    model: 'GLM-5.1',
    content,
    usage: { input: 10, output: 2, cacheRead: 0, cacheWrite: 0, totalTokens: 12 },
    stopReason: 'stop',
  }
}

function makeOptions(): HarnessGenerateOptions {
  return {
    provider: 'deveco2dsh',
    model: 'GLM-5.1',
    system: '你是一个助手',
    messages: [
      {
        role: 'user',
        content: [{ type: 'text', text: '只回复两个字：可用' }],
      },
    ],
    tools: [
      { name: 'get_weather', description: '查天气', parameters: { type: 'object', properties: {} } },
    ],
  }
}

async function* asyncIter<T>(items: T[]): AsyncGenerator<T> {
  for (const item of items) yield item
}

async function collect<T>(gen: AsyncGenerator<T>): Promise<T[]> {
  const out: T[] = []
  for await (const item of gen) out.push(item)
  return out
}
