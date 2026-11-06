import test from 'node:test'
import assert from 'node:assert/strict'
import {
  effectiveSuggested, isSimilar, readCapacityFile, serializeCapacity,
  type CapacityFile,
} from '../src/capacity.ts'

test('effectiveSuggested 三个固定用例', () => {
  assert.equal(effectiveSuggested(170000, 202752), 170000)
  assert.equal(effectiveSuggested(190000, 200000), 160000)
  assert.equal(effectiveSuggested(202752, 202752), 162201)
})

test('isSimilar 判定', () => {
  assert.equal(isSimilar(170000, 202752), false)
  assert.equal(isSimilar(190000, 200000), true)
  assert.equal(isSimilar(300000, 200000), false)
})

test('readCapacityFile 解析合法记录', () => {
  const raw = {
    schema: 'capacity/v1', updatedAt: '2026-11-05T00:00:00Z',
    models: { 'GLM-5.3': { suggested: 170000, actualMax: 202752, measuredAt: 'x', source: 'probe' } },
  }
  const f = readCapacityFile(raw)
  assert.equal(f.models['GLM-5.3']?.actualMax, 202752)
  assert.equal(f.models['GLM-5.3']?.source, 'probe')
})

test('readCapacityFile 非法输入返回空', () => {
  assert.deepEqual(readCapacityFile(null).models, {})
  assert.deepEqual(readCapacityFile({}).models, {})
  assert.deepEqual(readCapacityFile({ schema: 'x' }).models, {})
})

test('serializeCapacity 往返', () => {
  const f: CapacityFile = { schema: 'capacity/v1', updatedAt: 't', models: { m: { suggested: 1, actualMax: 2, measuredAt: 't', source: 'fallback' } } }
  assert.deepEqual(readCapacityFile(JSON.parse(serializeCapacity(f))), f)
})
