/**
 * 凭据文件读写：auth.json / token.enc / token.dek / keys/。
 *
 * 全程只读 token.enc / keys/（绝写）；auth.json 只在 token 刷新成功后写回
 * （先备份 + CAS 校验，对齐 deveco CLI 的 token-refresh.ts 语义）。
 *
 * 路径约定（Windows 实测）：
 *   data   = %USERPROFILE%\.local\share\deveco
 *   config = %USERPROFILE%\.config\deveco
 *
 * @module src/auth/store.ts
 */

import { existsSync } from 'node:fs'
import { copyFile, readFile, rename, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { decryptBlob, isEncryptedBlob, isWrappedDek, parseJwtPayload, unwrapDek } from './crypto.ts'

export const DATA_DIR = join(homedir(), '.local', 'share', 'deveco')
export const CONFIG_DIR = join(homedir(), '.config', 'deveco')

export const AUTH_PATH = join(DATA_DIR, 'auth.json')
export const TOKEN_ENC_PATH = join(CONFIG_DIR, 'token.enc')
export const TOKEN_DEK_PATH = join(CONFIG_DIR, 'token.dek')
export const KEYS_DIR = join(CONFIG_DIR, 'keys')

/** 解密后的完整凭据视图。 */
export interface DevEcoCredentials {
  access: string
  /** 本机实测为空字符串——刷新只靠 JWT，不靠 refresh token。 */
  refresh: string
  /** 毫秒时间戳（auth.json 里明文存储）。 */
  expires: number
  isRealName: boolean
  type: string
  /** token.enc 解出的长期 JWT（约 30 天有效）。 */
  jwt: string
  /** JWT payload 里的 userId，供账号切换检测。 */
  userId: string
  /** auth.json.deveco.access 的原始密文（CAS 写回时比对用）。 */
  accessCiphertext: string
}

/**
 * 读取并解密全部凭据。任何一步失败都抛错（调用方决定降级策略）。
 * 全程不写盘——刷新与写回由 refresh.ts 负责。
 */
export async function loadCredentials(): Promise<DevEcoCredentials> {
  // 1. token.dek → kekId → KEK 文件 → DEK
  if (!existsSync(TOKEN_DEK_PATH)) {
    throw new Error(`找不到 token.dek：${TOKEN_DEK_PATH}（请先执行 deveco auth login）`)
  }
  const wrappedUnknown: unknown = JSON.parse(await readFile(TOKEN_DEK_PATH, 'utf8'))
  if (!isWrappedDek(wrappedUnknown)) {
    throw new Error('token.dek 缺少 kekId/encryptedDek/iv/authTag 字段')
  }
  const kekPath = join(KEYS_DIR, `${wrappedUnknown.kekId}.bin`)
  if (!existsSync(kekPath)) {
    throw new Error(`密钥文件缺失或已轮换：${kekPath}（请重新执行 deveco auth login）`)
  }
  const dek = unwrapDek(wrappedUnknown, await readFile(kekPath))

  // 2. auth.json → deveco.access / refresh / expires / isRealName
  if (!existsSync(AUTH_PATH)) {
    throw new Error(`找不到 auth.json：${AUTH_PATH}（请先执行 deveco auth login）`)
  }
  const authRaw: Record<string, unknown> = JSON.parse(await readFile(AUTH_PATH, 'utf8'))
  const deveco = authRaw['deveco'] as Record<string, unknown> | undefined
  if (!deveco) throw new Error('auth.json 缺少 deveco 条目（请先执行 deveco auth login）')
  const accessBlob = deveco['access']
  if (!isEncryptedBlob(accessBlob)) throw new Error('deveco.access 不是合法的加密 blob')
  const refreshBlob = deveco['refresh']
  const access = decryptBlob(accessBlob, dek)
  const refresh = isEncryptedBlob(refreshBlob) ? decryptBlob(refreshBlob, dek) : ''

  // 3. token.enc → JWT
  if (!existsSync(TOKEN_ENC_PATH)) {
    throw new Error(`找不到 token.enc：${TOKEN_ENC_PATH}（刷新依赖长期 JWT，请重新登录）`)
  }
  const tokenEncUnknown: unknown = JSON.parse(await readFile(TOKEN_ENC_PATH, 'utf8'))
  if (!isEncryptedBlob(tokenEncUnknown)) throw new Error('token.enc 不是合法的加密 blob')
  const jwt = decryptBlob(tokenEncUnknown, dek)

  const payload = parseJwtPayload(jwt)

  return {
    access,
    refresh,
    expires: typeof deveco['expires'] === 'number' ? deveco['expires'] : 0,
    isRealName: deveco['isRealName'] === true,
    type: typeof deveco['type'] === 'string' ? deveco['type'] : '',
    jwt,
    userId: typeof payload['userId'] === 'string' ? payload['userId'] : '',
    accessCiphertext: accessBlob.ciphertext,
  }
}

/**
 * 把新的 access token 写回 auth.json（CAS 校验 + 原子替换）。
 *
 * CAS：写盘前重读磁盘上的 access 密文，若与读入时不同（说明 deveco CLI
 * 或其他进程已经刷新过），放弃本次写回并返回 false——沿用磁盘上的新值。
 *
 * @param oldCiphertext  读入时的 access 密文（CAS 比对基准）
 * @param newAccess      刷新后的新 access token
 * @param dekPath       DEK 路径（写回需要重新加密）
 */
export async function writeBackAccess(oldCiphertext: string, newAccess: string): Promise<boolean> {
  if (!existsSync(AUTH_PATH)) return false
  const currentRaw: Record<string, unknown> = JSON.parse(await readFile(AUTH_PATH, 'utf8'))
  const currentEntry = currentRaw['deveco'] as Record<string, unknown> | undefined
  const currentBlob = currentEntry?.['access']
  if (!isEncryptedBlob(currentBlob)) return false
  if (currentBlob.ciphertext !== oldCiphertext) {
    // CAS 失败：磁盘已被其他进程更新，放弃写回
    return false
  }

  // 备份 → 重新加密 → tmp 原子替换
  const backupPath = `${AUTH_PATH}.deveco2dsh.bak`
  await copyFile(AUTH_PATH, backupPath).catch(() => {})

  const tokenDekUnknown: unknown = JSON.parse(await readFile(TOKEN_DEK_PATH, 'utf8'))
  if (!isWrappedDek(tokenDekUnknown)) return false
  const kekPath = join(KEYS_DIR, `${tokenDekUnknown.kekId}.bin`)
  const dek = unwrapDek(tokenDekUnknown, await readFile(kekPath))

  const { encryptBlob } = await import('./crypto.ts')
  const nextRaw = {
    ...currentRaw,
    deveco: {
      ...currentEntry,
      access: encryptBlob(newAccess, dek),
      expires: Date.now() + 30 * 60 * 1000,
    },
  }
  const tmpPath = `${AUTH_PATH}.deveco2dsh.tmp`
  await writeFile(tmpPath, JSON.stringify(nextRaw, null, 2), { mode: 0o600 })
  await rename(tmpPath, AUTH_PATH)
  return true
}
