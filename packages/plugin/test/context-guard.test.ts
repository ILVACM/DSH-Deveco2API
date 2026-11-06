import test from 'node:test'
import assert from 'node:assert/strict'
import {
  evaluate, guardBeforeRequest, manualCompact, createCompactState, refreshAfterCompaction,
  type HostServices,
} from '../src/context-guard.ts'

test('evaluate 单线：只有达到建议上下文才触发', () => {
  const s = createCompactState()
  const none = evaluate(100000, 170000, s, 1_000_000, 60_000)
  assert.equal(none.triggered, false)
  assert.equal(none.reason, 'none')
  const hit = evaluate(170000, 170000, s, 1_000_000, 60_000)
  assert.equal(hit.triggered, true)
  assert.equal(hit.reason, 'over-suggested')
})

test('evaluate 冷却窗口内不重复触发', () => {
  const s = createCompactState()
  s.lastCompactedAt = 1_000_000
  const d = evaluate(200000, 170000, s, 1_010_000, 60_000)
  assert.equal(d.triggered, false)
  assert.equal(d.reason, 'cooldown')
})

test('guardBeforeRequest 命中压缩且压后达标 → 不阻断', async () => {
  let called = 0
  let used = 180000
  const services: HostServices = {
    tokenMeter: { measure: () => ({ totalTokens: used }) },
    compaction: { compactNow: () => { called++; used = 120000 } },
  }
  const s = createCompactState()
  const r = await guardBeforeRequest({ services, session: null, effectiveSuggested: 170000, state: s, cooldownMs: 60_000, nowMs: 1_000_000 })
  assert.equal(r.decision.triggered, true)
  assert.equal(called, 1)
  assert.ok(s.lastCompactedAt > 0)
  assert.equal(r.usedAfter, 120000)
  assert.equal(r.blocked, false)
})

test('guardBeforeRequest 压后复核仍超 → 阻断（跨模型切换场景）', async () => {
  let called = 0
  const services: HostServices = {
    tokenMeter: { measure: () => ({ totalTokens: 500000 }) },  // 0.5M，压完仍是 0.5M
    compaction: { compactNow: () => { called++ } },
  }
  const s = createCompactState()
  const r = await guardBeforeRequest({ services, session: null, effectiveSuggested: 170000, state: s, cooldownMs: 60_000, nowMs: 1_000_000 })
  assert.equal(r.decision.triggered, true)
  assert.equal(called, 1)
  assert.equal(r.usedAfter, 500000)
  assert.equal(r.blocked, true)
  assert.match(r.message, /阻止本次请求/)
})

test('blockOnOversizedHistory=false 时不阻断（沿用宿主默认）', async () => {
  const services: HostServices = {
    tokenMeter: { measure: () => ({ totalTokens: 500000 }) },
    compaction: { compactNow: () => {} },
  }
  const s = createCompactState()
  const r = await guardBeforeRequest({ services, session: null, effectiveSuggested: 170000, state: s, cooldownMs: 60_000, nowMs: 1_000_000, blockOnOversizedHistory: false })
  assert.equal(r.blocked, false)
})

test('guardBeforeRequest 服务缺失时降级不抛错', async () => {
  const s = createCompactState()
  const r = await guardBeforeRequest({ services: {}, session: null, effectiveSuggested: 170000, state: s, cooldownMs: 60_000, nowMs: 1_000_000 })
  assert.equal(r.decision.used, 0)
  assert.equal(r.decision.triggered, false)
  assert.equal(r.blocked, false)
})

test('manualCompact 服务缺失返回 ok:false', async () => {
  const s = createCompactState()
  assert.deepEqual(await manualCompact({}, s), { ok: false, message: '压缩服务当前不可用' })
})

test('refreshAfterCompaction 强制同步状态', () => {
  const s = createCompactState()
  s.compacting = true
  refreshAfterCompaction(s, 555)
  assert.equal(s.lastCompactedAt, 555)
  assert.equal(s.compacting, false)
})
