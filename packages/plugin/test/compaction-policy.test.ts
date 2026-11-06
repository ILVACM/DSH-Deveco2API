import test from 'node:test'
import assert from 'node:assert/strict'
import { solveModelPolicy, buildModelPolicies } from '../src/compaction-policy.ts'

test('GLM-5.3 反推参数使宿主阈值精确 = floor(actualMax×0.8)', () => {
  const s = solveModelPolicy({ actualMax: 202752, reservedCompletionTokens: 32000, targetRatio: 0.8 })
  assert.equal(s.thresholdTokens, 162201)
  // 宿主公式 min(W×ratio, W−O−headroom)，O 取最坏 32000 与常见 8192 都应恒等于 target
  for (const O of [32000, 8192, 128]) {
    assert.equal(Math.min(s.contextWindow * s.thresholdRatio, s.contextWindow - O - s.headroomTokens), 162201)
  }
  assert.equal(s.headroomTokens, 0)
  assert.equal(s.contextWindow, 162201 + 32000)
})

test('buildModelPolicies 只产出 deveco2dsh 路由 + 给出反推 W', () => {
  const f = buildModelPolicies([
    { id: 'GLM-5.3', actualMax: 202752, reservedCompletionTokens: 32000 },
    { id: 'GLM-5.1', actualMax: 202752, reservedCompletionTokens: 32000 },
  ])
  assert.equal(f.modelPolicies.length, 2)
  assert.ok(f.modelPolicies.every((p) => p.provider === 'deveco2dsh'))
  assert.deepEqual(f.modelPolicies.map((p) => p.model), ['GLM-5.3', 'GLM-5.1'])
  assert.equal(f.suggestedContextWindow['GLM-5.3'], 194201)
  assert.equal(f.suggestedContextWindow['GLM-5.1'], 194201)
})

test('空列表返回空', () => {
  assert.deepEqual(buildModelPolicies([]), { modelPolicies: [], suggestedContextWindow: {} })
})
