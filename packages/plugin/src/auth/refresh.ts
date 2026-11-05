/**
 * access token 有效性管理：过期检测 + 刷新 + 单飞去重 + 失败冷却。
 *
 * 刷新协议（对齐 deveco login-service.ts:382-422，P0 已实测）：
 *   GET https://cn.devecostudio.huawei.com/authrouter/auth/api/jwToken/check
 *   headers: { refresh: "true", jwtToken: <长期 JWT> }
 *   → 200 { status, userInfo: { accessToken, refreshToken, nationalCode, realName } }
 *
 * 不需要 refresh token（本机实测 refresh 为空字符串）——只靠 token.enc 里的 JWT。
 *
 * @module src/auth/refresh.ts
 */

import { existsSync } from 'node:fs'
import { AUTH_PATH, loadCredentials, writeBackAccess, type DevEcoCredentials } from './store.ts'

const URL_REFRESH = 'https://cn.devecostudio.huawei.com/authrouter/auth/api/jwToken/check'

/** access token 有效期 30 分钟（对齐 ACCESS_TOKEN_EXPIRES_MS）。 */
const ACCESS_TOKEN_TTL_MS = 30 * 60 * 1000
/** 刷新失败后的冷却窗口（对齐 REFRESH_COOLDOWN_MS）。 */
const REFRESH_COOLDOWN_MS = 30_000
/** 单次 HTTP 超时。 */
const REFRESH_TIMEOUT_MS = 15_000

/** 刷新失败的错误分类（调用方据此决定报错文案）。 */
export type RefreshFailure =
  | { kind: 'not_logged_in'; message: string }
  | { kind: 'jwt_expired'; message: string }
  | { kind: 'network'; message: string }

export type EnsureResult = { ok: true; access: string; credentials: DevEcoCredentials } | { ok: false; failure: RefreshFailure }

/** 模块级单飞状态：同一时刻只允许一个刷新在飞行。 */
let inflightRefresh: Promise<string | null> | null = null
let lastRefreshFailedAt = 0
/** 缓存的有效凭据（避免每次请求都读盘解密——解密有 4 次 AES-GCM 开销）。 */
let cachedCredentials: DevEcoCredentials | null = null
let cachedAt = 0
/** 凭据磁盘缓存有效期：只要 access 没过期就直接复用。 */
const CREDENTIALS_CACHE_MS = 5_000

/**
 * 获取一个当前有效的 access token。
 *
 * 行为：
 * 1. 缓存有效（未过期 + 未超缓存窗）→ 直接返回
 * 2. 磁盘上的 access 未过期 → 更新缓存并返回
 * 3. 已过期 → 刷新（单飞）；成功后写回磁盘（CAS）；失败按冷却窗口降级
 */
export async function ensureValidToken(): Promise<EnsureResult> {
  // 冷却期内直接返回上次失败原因，不重复打上游
  if (lastRefreshFailedAt > 0 && Date.now() - lastRefreshFailedAt < REFRESH_COOLDOWN_MS) {
    return {
      ok: false,
      failure: { kind: 'network', message: 'token 刷新最近失败，30 秒冷却中（请稍后重试或重新登录 deveco）' },
    }
  }

  // 快缓存
  if (cachedCredentials && Date.now() - cachedAt < CREDENTIALS_CACHE_MS && cachedCredentials.expires > Date.now()) {
    return { ok: true, access: cachedCredentials.access, credentials: cachedCredentials }
  }

  // 读盘
  let credentials: DevEcoCredentials
  try {
    credentials = await loadCredentials()
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    return { ok: false, failure: { kind: 'not_logged_in', message } }
  }

  // 未过期 → 缓存并返回
  if (credentials.expires > Date.now()) {
    cachedCredentials = credentials
    cachedAt = Date.now()
    return { ok: true, access: credentials.access, credentials }
  }

  // 已过期 → 刷新（单飞）
  const newAccess = await refreshWithInflightDedup(credentials)
  if (newAccess === null) {
    lastRefreshFailedAt = Date.now()
    return {
      ok: false,
      failure: { kind: 'jwt_expired', message: 'JWT 已过期（约 30 天有效期），请执行 `deveco auth login` 重新登录' },
    }
  }

  // 写回（CAS；失败说明磁盘已被其他进程更新，重新读一次即可）
  const wroteBack = await writeBackAccess(credentials.accessCiphertext, newAccess)
  if (!wroteBack) {
    // 磁盘被其他进程更新过——重读，拿到那个进程写入的新 token
    try {
      credentials = await loadCredentials()
      cachedCredentials = credentials
      cachedAt = Date.now()
      if (credentials.expires > Date.now()) {
        return { ok: true, access: credentials.access, credentials }
      }
    } catch {
      // 重读失败：用内存里的新 token 继续（下次请求会再走读盘路径）
    }
  }

  const updated: DevEcoCredentials = { ...credentials, access: newAccess, expires: Date.now() + ACCESS_TOKEN_TTL_MS }
  cachedCredentials = updated
  cachedAt = Date.now()
  return { ok: true, access: newAccess, credentials: updated }
}

/** 单飞刷新：并发调用共享同一个飞行中的 Promise。 */
async function refreshWithInflightDedup(credentials: DevEcoCredentials): Promise<string | null> {
  if (inflightRefresh) return inflightRefresh
  inflightRefresh = doRefresh(credentials)
    .catch(() => null)
    .finally(() => {
      inflightRefresh = null
    })
  return inflightRefresh
}

async function doRefresh(credentials: DevEcoCredentials): Promise<string | null> {
  const response = await fetch(URL_REFRESH, {
    headers: { refresh: 'true', jwtToken: credentials.jwt },
    signal: AbortSignal.timeout(REFRESH_TIMEOUT_MS),
  })
  if (response.status !== 200) {
    return null
  }
  const raw = (await response.json()) as {
    status?: unknown
    userInfo?: { accessToken?: unknown; nationalCode?: unknown; realName?: unknown }
  }
  if (raw.status !== true) return null
  const access = typeof raw.userInfo?.accessToken === 'string' ? raw.userInfo.accessToken : ''
  if (!access) return null
  return access
}

/** 账号切换检测：当前 userId 与上次缓存不同时清空目录缓存。 */
export function currentUserId(): string | null {
  return cachedCredentials?.userId ?? null
}

/** 测试钩子：清空模块级状态。 */
export function resetForTest(): void {
  inflightRefresh = null
  lastRefreshFailedAt = 0
  cachedCredentials = null
  cachedAt = 0
}

/** auth.json 是否存在（供启动时快速判断"是否登录过"）。 */
export function hasAuthFile(): boolean {
  return existsSync(AUTH_PATH)
}
