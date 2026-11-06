import test from 'node:test'
import assert from 'node:assert/strict'
import { buildSnapshot, registerStatusBridge } from '../src/status-bridge.ts'

const cap = {
  schema: 'capacity/v1' as const,
  updatedAt: 't',
  models: { 'GLM-5.3': { suggested: 170000, actualMax: 202752, measuredAt: 't', source: 'probe' as const } },
}
const snap = buildSnapshot({
  catalogModels: [{ id: 'GLM-5.3', name: 'GLM-5.3', contextWindow: 170000 }],
  capacity: cap, used: 100000, probing: false, compacting: false, lastCompactedAt: 0, measuredAt: 't',
})

test('buildSnapshot 双数字 + measuredAt', () => {
  assert.equal(snap.models[0]?.effectiveSuggested, 170000)
  assert.equal(snap.models[0]?.actualMax, 202752)
  assert.equal(snap.measuredAt, 't')
  assert.deepEqual(snap.occupancy, { used: 100000, contextWindow: 170000 })
})

test('4 个端点全部 /plugins/<包名>/ + exact + 两参 handler', () => {
  const specs: Array<{ kind: string; path: string; handler: (req: unknown, res: unknown) => unknown }> = []
  registerStatusBridge({ webServer: { register: (spec) => { specs.push(spec); return undefined } } }, {
    getSnapshot: () => snap,
    onProbe: async () => snap,
    onCompact: async () => ({ ok: true, message: '' }),
    onRefreshModels: async () => snap,
  })
  assert.equal(specs.length, 4)
  assert.ok(specs.every((s) => s.kind === 'exact'))
  assert.ok(specs.every((s) => s.path.startsWith('/plugins/dsh-deveco2api-plugin/')))
  assert.ok(specs.every((s) => s.handler.length === 2))
  assert.deepEqual(specs.map((s) => s.path), [
    '/plugins/dsh-deveco2api-plugin/status',
    '/plugins/dsh-deveco2api-plugin/probe',
    '/plugins/dsh-deveco2api-plugin/compact',
    '/plugins/dsh-deveco2api-plugin/refresh-models',
  ])
})

test('/probe 与 /refresh-models 返回完整快照（非 {ok:true}）', async () => {
  const specs: Array<{ path: string; handler: (req: unknown, res: unknown) => unknown }> = []
  registerStatusBridge({ webServer: { register: (spec) => { specs.push(spec); return undefined } } }, {
    getSnapshot: () => snap,
    onProbe: async () => snap,
    onCompact: async () => ({ ok: true, message: '' }),
    onRefreshModels: async () => snap,
  })
  const writes: string[] = []
  const fakeRes = { writeHead: () => {}, end: (s: string) => { writes.push(s) } }
  const fakeReq = { socket: { remoteAddress: '127.0.0.1' } }
  const probe = specs.find((s) => s.path.endsWith('/probe'))!
  probe.handler(fakeReq, fakeRes)
  await new Promise((r) => setTimeout(r, 50))
  assert.ok(writes.length >= 1)
  const body = JSON.parse(writes[writes.length - 1]!)
  assert.ok(Array.isArray(body.models))
  assert.equal(body.measuredAt, 't')
})
