/**
 * catalog.ts 单测：parseCatalog 纯函数（P0 实测的响应形状）。
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { parseCatalog } from '../src/catalog.ts'

/** P0 实测的 modelConfig 响应形状（2026-11-03，version=15，3 模型，1 个 blacklist）。 */
const REAL_RESPONSE = {
  code: 200,
  body: {
    version: 15,
    inner_models: [
      {
        protocol: 'openai',
        group_name: 'mep',
        group_name_cn: 'mep',
        model_configs: [
          {
            id: 0,
            model_id: 'GLM-5.3',
            thinking_mode: 'on',
            input_modalities: ['text'],
            context_window: 170000,
            output: 32000,
            tool_call_mode: 'tool_calls',
            tool_choice: 'required',
            reasoning_effort: '{"level":["low","high","max"],"default":"high"}',
          },
          {
            id: 1,
            model_id: 'GLM-5.1',
            thinking_mode: 'on',
            input_modalities: ['text'],
            context_window: 170000,
            output: 32000,
            tool_call_mode: 'tool_calls',
            reasoning_effort: '{"level":["low","high","max"],"default":"high"}',
          },
          {
            id: 2,
            model_id: 'Qwen3_VL_235B_A22B_Instruct',
            thinking_mode: 'on',
            input_modalities: ['text', 'image'],
            context_window: 32000,
            output: 8192,
          },
        ],
        task_default_model_map: {
          ui_verification: 'Qwen3_VL_235B_A22B_Instruct',
          blacklist: 'Qwen3_VL_235B_A22B_Instruct',
          small_model: 'GLM-5.3',
        },
      },
    ],
  },
}

test('parseCatalog：真实响应解析出 3 模型 / 2 暴露 / blacklist 生效', () => {
  const { models, exposed, version } = parseCatalog(REAL_RESPONSE)
  assert.equal(version, 15)
  assert.equal(models.length, 3)
  assert.equal(exposed.length, 2)
  const exposedIds = exposed.map((m) => m.id)
  assert.ok(exposedIds.includes('GLM-5.1'))
  assert.ok(exposedIds.includes('GLM-5.3'))
  assert.ok(!exposedIds.includes('Qwen3_VL_235B_A22B_Instruct'))
})

test('parseCatalog：GLM-5.1 的元数据正确', () => {
  const { exposed } = parseCatalog(REAL_RESPONSE)
  const glm51 = exposed.find((m) => m.id === 'GLM-5.1')
  assert.ok(glm51)
  assert.equal(glm51.contextWindow, 170000)
  assert.equal(glm51.maxTokens, 32000)
  assert.equal(glm51.reasoning, true)
  assert.deepEqual(glm51.effortLevels, ['low', 'high', 'max'])
  assert.equal(glm51.defaultEffort, 'high')
})

test('parseCatalog：Qwen3_VL 被 blacklist 排除', () => {
  const { models, exposed } = parseCatalog(REAL_RESPONSE)
  const qwen = models.find((m) => m.id === 'Qwen3_VL_235B_A22B_Instruct')
  assert.ok(qwen)
  assert.equal(exposed.includes(qwen), false)
})

test('parseCatalog：空输入返回空目录', () => {
  assert.deepEqual(parseCatalog(null), { models: [], exposed: [], version: 0 })
  assert.deepEqual(parseCatalog({}), { models: [], exposed: [], version: 0 })
  assert.deepEqual(parseCatalog({ body: {} }), { models: [], exposed: [], version: 0 })
})

test('parseCatalog：旧版 reasoning_effort 纯数组形态', () => {
  const raw = {
    code: 200,
    body: {
      version: 1,
      inner_models: [
        {
          protocol: 'openai',
          model_configs: [
            {
              model_id: 'test-model',
              thinking_mode: 'on',
              context_window: 100000,
              output: '16384',
              reasoning_effort: '["low","high"]',
            },
          ],
        },
      ],
    },
  }
  const { exposed } = parseCatalog(raw)
  const model = exposed[0]
  assert.ok(model)
  assert.deepEqual(model.effortLevels, ['low', 'high'])
  assert.equal(model.defaultEffort, undefined)
  assert.equal(model.maxTokens, 16384)
})

test('parseCatalog：output 字符串数字化', () => {
  const raw = {
    code: 200,
    body: {
      version: 1,
      inner_models: [
        { protocol: 'openai', model_configs: [{ model_id: 'm1', thinking_mode: 'off', output: '4096' }] },
      ],
    },
  }
  const { exposed } = parseCatalog(raw)
  assert.equal(exposed[0]?.maxTokens, 4096)
  assert.equal(exposed[0]?.reasoning, false)
})

test('parseCatalog：无 blacklist 时全部暴露', () => {
  const raw = {
    code: 200,
    body: {
      version: 1,
      inner_models: [
        { protocol: 'openai', model_configs: [{ model_id: 'a' }, { model_id: 'b' }] },
      ],
    },
  }
  const { models, exposed } = parseCatalog(raw)
  assert.equal(models.length, 2)
  assert.equal(exposed.length, 2)
})
