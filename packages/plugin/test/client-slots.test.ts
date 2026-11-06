import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const read = (p: string): string => readFileSync(join(process.cwd(), 'src', 'client', p), 'utf8')
const constantsSrc = read('constants.ts')
const indexSrc = read('index.ts')
const cardSrc = read('CapacityCard.tsx')
const bridgeSrc = readFileSync(join(process.cwd(), 'src', 'status-bridge.ts'), 'utf8')

test('constants.ts 使用设置分区常量，且已移除 plugins.* 槽常量', () => {
  assert.match(constantsSrc, /export const SETTINGS_SECTION_ID = 'deveco2dsh'/)
  assert.match(constantsSrc, /export const SLOT_SECTION = 'settings\.section'/)
  assert.match(constantsSrc, /export const SLOT_SECTION_ICON = 'settings\.section\.icon'/)
  assert.match(constantsSrc, /export const SETTINGS_ORDER = 35/)
  assert.doesNotMatch(constantsSrc, /plugins\.bundle\.config|plugins\.row\.config|plugins\.item/)
})

test('client/index.ts 只注册 settings.section 与同 id 图标', () => {
  assert.match(indexSrc, /slots\.inject\(SLOT_SECTION/)
  assert.match(indexSrc, /slots\.inject\(SLOT_SECTION_ICON/)
  assert.match(indexSrc, /id: SETTINGS_SECTION_ID/)
  assert.match(indexSrc, /order: SETTINGS_ORDER/)
  assert.doesNotMatch(indexSrc, /plugins\.bundle\.config|plugins\.row\.config|plugins\.item/)
  assert.doesNotMatch(indexSrc, /BUNDLE_KEY|ROW_KEY/)
})

test('CapacityCard 检查 res.ok 且不再残留 /deveco2dsh/ 路径', () => {
  assert.match(cardSrc, /if \(!r\.ok\)/)
  assert.doesNotMatch(cardSrc, /\/deveco2dsh\//)
  assert.match(cardSrc, /API_BASE/)
})

test('客户端与服务端 API_BASE 值一致且不跨端 import', () => {
  assert.match(constantsSrc, /export const API_BASE = `\/plugins\/\$\{PKG\}`/)
  assert.match(bridgeSrc, /const API_BASE = '\/plugins\/dsh-deveco2api-plugin'/)
  assert.doesNotMatch(bridgeSrc, /from '\.\/client\//)
})

test('locales.ts 的 NS 为设置分区 id', () => {
  const localesSrc = read('locales.ts')
  assert.match(localesSrc, /export const NS = 'deveco2dsh'/)
})
