/**
 * 双层 AES-256-GCM 凭据解密（从 test/P0/probe.ts 移植，P0 已实测验证）。
 *
 * DevEco Code 的本地凭据布局（temp/deveco-code-develop/.../local-crypto.ts）：
 *
 *   KEK  ~/.config/deveco/keys/kek-v{1,2,3}.bin        32 字节随机密钥
 *   DEK  ~/.config/deveco/token.dek                     被 KEK 包裹的 WrappedDekData
 *   密文 ~/.local/share/deveco/auth.json                逐字段加密（敏感键集合见 SENSITIVE_AUTH_KEYS）
 *   JWT  ~/.config/deveco/token.enc                     整体封装
 *
 * 本模块只做解密——写回由 store.ts 负责（刷新 token 后需要重新加密）。
 *
 * @module src/auth/crypto.ts
 */

import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto'

/** 被 KEK 包裹的 DEK（token.dek 的形状）。 */
export interface WrappedDek {
  version: number
  algorithm: string
  kekId: string
  encryptedDek: string
  iv: string
  authTag: string
  timeStamp: number
}

/** 逐字段加密的密文 blob（auth.json / token.enc 里敏感字段的形状）。 */
export interface EncryptedBlob {
  version: number
  algorithm: string
  ciphertext: string
  iv: string
  authTag: string
  timeStamp: number
}

/** 运行时未知 JSON 的安全断言。 */
function isEncryptedBlob(value: unknown): value is EncryptedBlob {
  if (!value || typeof value !== 'object') return false
  const blob = value as Partial<EncryptedBlob>
  return (
    typeof blob.algorithm === 'string' &&
    typeof blob.ciphertext === 'string' &&
    typeof blob.iv === 'string' &&
    typeof blob.authTag === 'string'
  )
}

function isWrappedDek(value: unknown): value is WrappedDek {
  if (!value || typeof value !== 'object') return false
  const wrapped = value as Partial<WrappedDek>
  return (
    typeof wrapped.kekId === 'string' &&
    typeof wrapped.encryptedDek === 'string' &&
    typeof wrapped.iv === 'string' &&
    typeof wrapped.authTag === 'string'
  )
}

function b64(value: string): Buffer {
  return Buffer.from(value, 'base64')
}

/** AES-256-GCM 解密一个 blob，返回 utf8 字符串（对齐 local-crypto.ts decryptForLocalStorage）。 */
export function decryptBlob(blob: EncryptedBlob, key: Buffer): string {
  const decipher = createDecipheriv('aes-256-gcm', key, b64(blob.iv))
  decipher.setAuthTag(b64(blob.authTag))
  return Buffer.concat([decipher.update(b64(blob.ciphertext)), decipher.final()]).toString('utf8')
}

/** AES-256-GCM 加密一个字符串（对齐 encryptForLocalStorage；写回凭据用）。 */
export function encryptBlob(plaintext: string, key: Buffer): EncryptedBlob {
  const iv = randomBytes(12)
  const cipher = createCipheriv('aes-256-gcm', key, iv)
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()])
  return {
    version: 1,
    algorithm: 'aes-256-gcm',
    ciphertext: ciphertext.toString('base64'),
    iv: iv.toString('base64'),
    authTag: cipher.getAuthTag().toString('base64'),
    timeStamp: Date.now(),
  }
}

/**
 * 解包 DEK：读 token.dek（JSON），按 kekId 找 KEK 文件，解出 32 字节 DEK。
 * 注意 KEK 文件名从 kekId 动态解析（不硬编码 kek-v1 —— 源码支持三套轮换）。
 */
export function unwrapDek(wrapped: WrappedDek, kek: Buffer): Buffer {
  if (kek.length !== 32) {
    throw new Error(`KEK 长度异常：${kek.length}（应为 32）`)
  }
  const decipher = createDecipheriv('aes-256-gcm', kek, b64(wrapped.iv))
  decipher.setAuthTag(b64(wrapped.authTag))
  const dek = Buffer.concat([decipher.update(b64(wrapped.encryptedDek)), decipher.final()])
  if (dek.length !== 32) {
    throw new Error(`DEK 长度异常：${dek.length}（应为 32）`)
  }
  return dek
}

/** 类型守卫导出（store.ts 用）。 */
export { isEncryptedBlob, isWrappedDek }

/** 解析 JWT payload（不校验签名，只读声明——userId / exp 等供报告与账号切换检测用）。 */
export function parseJwtPayload(jwt: string): Record<string, unknown> {
  const parts = jwt.split('.')
  if (parts.length !== 3) throw new Error(`JWT 不是 3 段（实际 ${parts.length} 段）`)
  const payloadPart = parts[1] ?? ''
  const base64Url = payloadPart.replace(/-/g, '+').replace(/_/g, '/')
  const padded = base64Url.padEnd(base64Url.length + ((4 - (base64Url.length % 4)) % 4), '=')
  const parsed: unknown = JSON.parse(Buffer.from(padded, 'base64').toString('utf8'))
  if (!parsed || typeof parsed !== 'object') throw new Error('JWT payload 不是对象')
  return parsed as Record<string, unknown>
}
