import test from 'node:test'
import assert from 'node:assert/strict'
import { parseUpstreamEvents } from '../src/adapter/wire.ts'
import type { UpstreamEvent } from '../src/adapter/events.ts'

/** 构造假 SSE 原文：每个 delta 一帧，末帧带 finish_reason。 */
function sse(deltas: Array<Record<string, unknown>>, finishReason = 'tool_calls'): string {
  const frames = deltas.map((delta, index) => {
    const choice: Record<string, unknown> = { delta }
    if (index === deltas.length - 1) choice['finish_reason'] = finishReason
    const payload = {
      model: 'GLM-5.1',
      choices: [choice],
      usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
    }
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

/** 参数分 3 帧传完的完整工具调用。 */
const splitArgsFrames = [
  { tool_calls: [{ index: 0, id: 'call_1', function: { name: 'get_weather', arguments: '{"city"' } }] },
  { tool_calls: [{ index: 0, function: { arguments: ':"北京"' } }] },
  { tool_calls: [{ index: 0, function: { arguments: '}' } }] },
]

test('T2：参数分片累积后解析为完整对象', async () => {
  const events = await collect(sse(splitArgsFrames))
  const end = events.find((e) => e.type === 'toolcall_end')
  assert.ok(end)
  if (end?.type === 'toolcall_end') {
    assert.equal(end.toolCall.id, 'call_1')
    assert.equal(end.toolCall.name, 'get_weather')
    assert.deepEqual(end.toolCall.arguments, { city: '北京' })
  }
})

test('T1：tool-call 块进入 done.message.content，类型为 tool-call', async () => {
  const events = await collect(sse(splitArgsFrames))
  const done = events[events.length - 1]
  assert.equal(done?.type, 'done')
  if (done?.type === 'done') {
    const toolBlock = done.message.content.find((b) => b.type === 'tool-call')
    assert.ok(toolBlock)
    assert.equal(toolBlock?.['id'], 'call_1')
    assert.equal(toolBlock?.['name'], 'get_weather')
    assert.equal(toolBlock?.['arguments'], '{"city":"北京"}')
    assert.equal(done.message.stopReason, 'toolUse')
  }
})

test('T2 降级：非法 JSON 参数保留原文，不丢参', async () => {
  const events = await collect(sse([
    { tool_calls: [{ index: 0, id: 'call_2', function: { name: 'broken', arguments: '{not json' } }] },
  ]))
  const done = events[events.length - 1]
  if (done?.type === 'done') {
    const toolBlock = done.message.content.find((b) => b.type === 'tool-call')
    assert.equal(toolBlock?.['arguments'], '{"__raw":"{not json"}')
  }
  const end = events.find((e) => e.type === 'toolcall_end')
  if (end?.type === 'toolcall_end') {
    assert.deepEqual(end.toolCall.arguments, { __raw: '{not json' })
  }
})

test('T3：toolcall_start 的 partial 能取到 id/name', async () => {
  const events = await collect(sse(splitArgsFrames))
  const start = events.find((e) => e.type === 'toolcall_start')
  assert.ok(start)
  if (start?.type === 'toolcall_start') {
    const block = start.partial.content[start.contentIndex]
    assert.equal(block?.['id'], 'call_1')
    assert.equal(block?.['name'], 'get_weather')
  }
})

test('编号：正文块与工具块不撞号，且编号等于数组下标', async () => {
  const events = await collect(sse([
    { content: '我先看天气' },
    ...splitArgsFrames,
  ]))
  const done = events[events.length - 1]
  assert.equal(done?.type, 'done')
  if (done?.type === 'done') {
    assert.deepEqual(done.message.content.map((b) => b.type), ['text', 'tool-call'])
    assert.equal(done.message.content[0]?.['text'], '我先看天气')
    assert.equal(done.message.content[1]?.['type'], 'tool-call')
  }
  const textStart = events.find((e) => e.type === 'text_start')
  const toolStart = events.find((e) => e.type === 'toolcall_start')
  if (textStart?.type === 'text_start' && toolStart?.type === 'toolcall_start') {
    assert.notEqual(textStart.contentIndex, toolStart.contentIndex)
  }
})

test('工具调用与内联思考并存：块顺序为 thinking → text → tool-call', async () => {
  const events = await collect(sse([
    { content: '思考</think>正文' },
    ...splitArgsFrames,
  ]))
  const done = events[events.length - 1]
  if (done?.type === 'done') {
    assert.deepEqual(done.message.content.map((b) => b.type), ['thinking', 'text', 'tool-call'])
  }
})
