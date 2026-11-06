import test from 'node:test'
import assert from 'node:assert/strict'
import { probeNow, parseMaxContext } from '../src/capacity-probe.ts'

const overLimit = 'event: error data: {"error":{"message":"This model\'s maximum context length is 202752 tokens."}}'

function makeFetch(handler: (body: string) => string): typeof fetch {
  return (async (_url: unknown, init: unknown) => {
    const body = (init as { body?: string }).body ?? ''
    const text = handler(body)
    return { text: async () => text } as unknown as Response
  }) as unknown as typeof fetch
}

test('parseMaxContext 提取 202752', () => {
  assert.equal(parseMaxContext(overLimit), 202752)
})

test('probeNow 逐步逼近，命中即停，返回实测值', async () => {
  let calls = 0
  const deps = {
    getAccess: async () => 'tok',
    fetchImpl: makeFetch((body) => {
      calls += 1
      // 前两次不超限（正常回复），第三次超限
      return calls >= 3 ? overLimit : 'data: {"choices":[{"delta":{"content":"OK"}}]}'
    }),
    sleep: async () => {},
    now: () => 1000,
  }
  const out = await probeNow(['GLM-5.3'], { 'GLM-5.3': 170000 }, deps, { stepGapMs: 0, totalTimeoutMs: 60_000 })
  assert.equal(out.length, 1)
  assert.equal(out[0]?.source, 'probe')
  assert.equal(out[0]?.actualMax, 202752)
  assert.equal(calls, 3)
})

test('probeNow 遇限流退避后仍可成功', async () => {
  let calls = 0
  const deps = {
    getAccess: async () => 'tok',
    fetchImpl: makeFetch(() => {
      calls += 1
      if (calls === 1) return 'event: error data: {"error":{"type":"UserSessionLimitExceeded"}}'
      return overLimit
    }),
    sleep: async () => {},
    now: () => 1000,
  }
  const out = await probeNow(['GLM-5.3'], { 'GLM-5.3': 170000 }, deps, { stepGapMs: 0, totalTimeoutMs: 60_000 })
  assert.equal(out[0]?.source, 'probe')
  assert.equal(out[0]?.actualMax, 202752)
})

test('probeNow 未登录返回 error', async () => {
  const out = await probeNow(['GLM-5.3'], { 'GLM-5.3': 170000 }, {
    getAccess: async () => null, sleep: async () => {}, now: () => 1000,
  })
  assert.equal(out[0]?.source, 'error')
  assert.match(String(out[0]?.error), /not logged in/)
})

test('probeNow 超时降级', async () => {
  let t = 0
  const out = await probeNow(['GLM-5.3'], { 'GLM-5.3': 170000 }, {
    getAccess: async () => 'tok',
    fetchImpl: makeFetch(() => 'data: {"choices":[{"delta":{"content":"OK"}}]}'),
    sleep: async () => { t += 50_000 },
    now: () => t,
  }, { stepGapMs: 0, totalTimeoutMs: 40_000 })
  assert.equal(out[0]?.source, 'error')
  assert.match(String(out[0]?.error), /timeout/)
})
