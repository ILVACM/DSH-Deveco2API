import test from 'node:test'
import assert from 'node:assert/strict'
import { splitInlineThinking, parseUpstreamEvents } from '../src/adapter/wire.ts'
import type { UpstreamEvent } from '../src/adapter/events.ts'

/** 构造假 SSE 原文：每个 delta 一帧，末帧带 finish_reason。 */
function sse(deltas: Array<Record<string, unknown>>, finishReason = 'stop'): string {
  const frames = deltas.map((delta, index) => {
    const choice: Record<string, unknown> = { delta }
    if (index === deltas.length - 1) choice['finish_reason'] = finishReason
    const payload = { model: 'GLM-5.1', choices: [choice] }
    return `id: ${index}\ndata: ${JSON.stringify(payload)}\n`
  })
  return frames.join('\n')
}

async function collect(raw: string): Promise<UpstreamEvent[]> {
  const out: UpstreamEvent[] = []
  for await (const event of parseUpstreamEvents(Promise.resolve(raw), 200, 'text/event-stream')) {
    out.push(event)
  }
  return out
}

const types = (events: UpstreamEvent[]): string[] => events.map((e) => e.type)

test('splitInlineThinking：无标签 → 整段正文，hasTag=false', () => {
  const split = splitInlineThinking('纯正文')
  assert.equal(split.hasTag, false)
  assert.equal(split.thinkingRaw, '')
  assert.equal(split.textRaw, '纯正文')
  assert.equal(split.textStart, 0)
  assert.equal(split.textEnd, 3)
})

test('splitInlineThinking：只有闭合标签 → 之前思考、之后正文', () => {
  const split = splitInlineThinking('思考</think>正文')
  assert.equal(split.hasTag, true)
  assert.equal(split.thinkingRaw, '思考')
  assert.equal(split.textRaw, '正文')
})

test('splitInlineThinking：开闭标签齐全', () => {
  const split = splitInlineThinking('<think>思考</think>正文')
  assert.equal(split.thinkingRaw, '思考')
  assert.equal(split.textRaw, '正文')
})

test('splitInlineThinking：只有开标签（未闭合）', () => {
  const split = splitInlineThinking('<think>思考')
  assert.equal(split.hasTag, true)
  assert.equal(split.thinkingRaw, '思考')
  assert.equal(split.textRaw, '')
})

test('splitInlineThinking：空串', () => {
  const split = splitInlineThinking('')
  assert.equal(split.hasTag, false)
  assert.equal(split.thinkingRaw, '')
  assert.equal(split.textRaw, '')
})

test('splitInlineThinking：标签后有空行 → 正文去掉前导空白', () => {
  const split = splitInlineThinking('思考</think>\n\n正文')
  assert.equal(split.thinkingRaw, '思考')
  assert.equal(split.textRaw, '正文')
})

test('splitInlineThinking：闭合标签前缀为空 → 无思考', () => {
  const split = splitInlineThinking('</think>正文')
  assert.equal(split.thinkingRaw, '')
  assert.equal(split.textRaw, '正文')
})

test('端到端：内联思考切成 reasoning 块，正文切成 text 块', async () => {
  const events = await collect(sse([{ content: '思考内容</think>正文内容' }]))
  assert.deepEqual(types(events), [
    'thinking_start', 'thinking_delta', 'text_start', 'text_delta',
    'thinking_end', 'text_end', 'done',
  ])
  const delta = events[1]
  assert.equal(delta?.type, 'thinking_delta')
  if (delta?.type === 'thinking_delta') assert.equal(delta.delta, '思考内容')
  const textDelta = events[3]
  assert.equal(textDelta?.type, 'text_delta')
  if (textDelta?.type === 'text_delta') assert.equal(textDelta.delta, '正文内容')
  const thinkingEnd = events[4]
  if (thinkingEnd?.type === 'thinking_end') assert.equal(thinkingEnd.content, '思考内容')
  const textEnd = events[5]
  if (textEnd?.type === 'text_end') assert.equal(textEnd.content, '正文内容')
})

test('端到端：无标签时事件序列与改前一致（text_start/delta/end + done）', async () => {
  const events = await collect(sse([{ content: '第一段' }, { content: '第二段' }]))
  assert.deepEqual(types(events), ['text_start', 'text_delta', 'text_delta', 'text_end', 'done'])
  const done = events[events.length - 1]
  assert.equal(done?.type, 'done')
  if (done?.type === 'done') {
    assert.equal(done.message.stopReason, 'stop')
    assert.deepEqual(done.message.content, [{ type: 'text', text: '第一段第二段' }])
  }
})

test('端到端：结构化 reasoning_content 与内联标签并存 → 丢弃内联（D2）', async () => {
  const events = await collect(sse([
    { reasoning_content: '结构化思考' },
    { content: '内联思考</think>正文内容' },
  ]))
  assert.deepEqual(types(events), [
    'thinking_start', 'thinking_delta', 'text_start', 'text_delta',
    'thinking_end', 'text_end', 'done',
  ])
  const thinkingDelta = events[1]
  if (thinkingDelta?.type === 'thinking_delta') assert.equal(thinkingDelta.delta, '结构化思考')
  const textDelta = events[3]
  if (textDelta?.type === 'text_delta') assert.equal(textDelta.delta, '正文内容')
  const thinkingEnd = events[4]
  if (thinkingEnd?.type === 'thinking_end') assert.equal(thinkingEnd.content, '结构化思考')
})
