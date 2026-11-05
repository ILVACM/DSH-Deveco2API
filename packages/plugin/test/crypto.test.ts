/**
 * crypto.ts 单测：解密往返 + 类型守卫 + JWT 解析。
 * 用真实的加密→解密验证往返正确性（不 mock crypto——它是 Node 内建模块）。
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { createCipheriv, randomBytes } from 'node:crypto'
import { decryptBlob, encryptBlob, isEncryptedBlob, parseJwtPayload, unwrapDek, type WrappedDek } from '../src/auth/crypto.ts'

test('encryptBlob → decryptBlob 往返', () => {
  const key = randomBytes(32)
  const plaintext = 'DgEAAIYySa测试-token-内容'
  const blob = encryptBlob(plaintext, key)
  assert.ok(isEncryptedBlob(blob))
  assert.equal(decryptBlob(blob, key), plaintext)
})

test('encryptBlob → decryptBlob 空字符串往返（refresh token 为空的场景）', () => {
  const key = randomBytes(32)
  const blob = encryptBlob('', key)
  assert.equal(decryptBlob(blob, key), '')
})

test('unwrapDek：合法包裹解出 32 字节', () => {
  const kek = randomBytes(32)
  const dek = randomBytes(32)
  // 手工构造一个 WrappedDek（等价于 local-crypto.ts wrapDekWithKek）
  const iv = randomBytes(12)
  const cipher = createCipheriv('aes-256-gcm', kek, iv)
  const encryptedDek = Buffer.concat([cipher.update(dek), cipher.final()])
  const wrapped: WrappedDek = {
    version: 1,
    algorithm: 'aes-256-gcm',
    kekId: 'kek-v1',
    encryptedDek: encryptedDek.toString('base64'),
    iv: iv.toString('base64'),
    authTag: cipher.getAuthTag().toString('base64'),
    timeStamp: Date.now(),
  }
  // unwrapDek 的 DEK 解密走 decryptBlob 的 utf8 路径——不对，unwrapDek 返回 Buffer
  // 这里的正确期望是：解出的 Buffer 是 DEK 的**字符串形式**经 utf8 解码
  // 但 local-crypto.ts 的 unwrapDek 返回 Buffer（直接 update+final，不转 utf8）
  // 而 crypto.ts 的 unwrapDek 也返回 Buffer。所以这里比较 Buffer。
  const result = unwrapDek(wrapped, kek)
  assert.equal(result.length, 32)
  assert.ok(result.equals(dek))
})

test('unwrapDek：错误密钥抛错', () => {
  const kek = randomBytes(32)
  const wrongKek = randomBytes(32)
  const iv = randomBytes(12)
  const cipher = createCipheriv('aes-256-gcm', kek, iv)
  const encryptedDek = Buffer.concat([cipher.update(randomBytes(32)), cipher.final()])
  const wrapped: WrappedDek = {
    version: 1,
    algorithm: 'aes-256-gcm',
    kekId: 'kek-v1',
    encryptedDek: encryptedDek.toString('base64'),
    iv: iv.toString('base64'),
    authTag: cipher.getAuthTag().toString('base64'),
    timeStamp: Date.now(),
  }
  // 错误密钥 → authTag 校验失败 → 抛错
  assert.throws(() => unwrapDek(wrapped, wrongKek))
})

test('unwrapDek：密钥长度异常抛错', () => {
  const wrapped: WrappedDek = {
    version: 1,
    algorithm: 'aes-256-gcm',
    kekId: 'kek-v1',
    encryptedDek: '',
    iv: '',
    authTag: '',
    timeStamp: Date.now(),
  }
  assert.throws(() => unwrapDek(wrapped, randomBytes(16)), /长度异常/)
})

test('isEncryptedBlob：非法输入返回 false', () => {
  assert.equal(isEncryptedBlob(null), false)
  assert.equal(isEncryptedBlob('string'), false)
  assert.equal(isEncryptedBlob({}), false)
  assert.equal(isEncryptedBlob({ algorithm: 'aes-256-gcm' }), false)
})

test('parseJwtPayload：标准 JWT 解出 payload', () => {
  const payload = { userId: '30086000744743676', exp: 1798000000 }
  const header = b64url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }))
  const body = b64url(JSON.stringify(payload))
  const jwt = `${header}.${body}.signature`
  const parsed = parseJwtPayload(jwt)
  assert.equal(parsed['userId'], payload.userId)
  assert.equal(parsed['exp'], payload.exp)
})

test('parseJwtPayload：非 3 段抛错', () => {
  assert.throws(() => parseJwtPayload('only.one'), /3 段/)
  assert.throws(() => parseJwtPayload(''), /3 段/)
})

function b64url(text: string): string {
  return Buffer.from(text, 'utf8').toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}
