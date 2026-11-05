/**
 * P0 探针 —— DevEco Code 免费模型通道验证
 * ============================================================================
 *
 * 目的：在写 DSH 插件之前，用一条命令把「凭据链路 + 上游协议」全部验证一遍。
 *
 * 运行：
 *     node test/P0/probe.ts
 *
 * 零依赖：只用 Node 内建模块（node:fs / node:path / node:crypto / node:child_process
 * + 全局 fetch）。Node >= 22 可直接执行 .ts（类型剥离）。
 *
 * 参数：
 *     --only=N[,M]      只报告指定编号的检查（依赖项仍静默执行）
 *     --write           刷新成功后写回 auth.json（先备份 + CAS 校验）
 *     --model=GLM-5.3   对话测试用的模型（默认 GLM-5.1）
 *     --verbose         打印完整 SSE 帧 / 完整 JSON
 *     --no-color        关闭 ANSI 颜色（非 TTY 时自动关闭）
 *     --timeout=MS      单请求超时（默认 30000）
 *
 * 退出码：
 *     0 = FAIL == 0（PASS/SKIP/INFO 任意组合）
 *     1 = 至少 1 项 FAIL
 *     2 = 前置条件缺失（凭据文件找不到）
 *     3 = 脚本自身异常
 *
 * 四态：PASS / INFO（只记录不断言）/ SKIP（前置条件不满足）/ FAIL
 *
 * 安全：绝不打印完整 token；默认绝不写回凭据目录。
 *
 * @module test/P0/probe.ts
 */

import { existsSync } from 'node:fs'
import { copyFile, mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { createCipheriv, createDecipheriv, randomBytes, randomUUID } from 'node:crypto'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

// ===========================================================================
// §1 常量
// ===========================================================================

const BASE = 'https://cn.devecostudio.huawei.com'
const URL_REFRESH = `${BASE}/authrouter/auth/api/jwToken/check`
const URL_CATALOG = `${BASE}/codeGenie/modelConfig`
const URL_CHAT = `${BASE}/sse/codeGenie/maas/v2/chat/completions`
const URL_CHAT_NO_STREAM = `${BASE}/sse/codeGenie/maas/v2/no-stream/chat/completions`

const SCRIPT_DIR = import.meta.dirname
const RUNS_DIR = join(SCRIPT_DIR, 'runs')
const REPORT_PATH = join(RUNS_DIR, 'p0-report.json')
const OUTPUT_PATH = join(RUNS_DIR, 'last-output.txt')

const PROBE_PROMPT = '只回复两个字：可用'
const REASONING_PROMPT = '逐步推理：一个三位数各位立方和等于它本身，是哪个数？'
const UNKNOWN_MODEL = 'p0-probe-nonexistent-model'

/**
 * 6a 的输出预算。
 * 实测（2026-11-03）：
 *   GLM-5.1 —— 32 token 足够（正文 2 token，finish=stop）
 *   GLM-5.3 —— 32 token 会被内部推理吃满（正文 138 token 且 finish=length），
 *              128 token 才能正常收尾（finish=stop）
 * 因此给 6a 一个宽松预算，避免把「模型话多」误判成通道故障。
 */
const PROBE_MAX_TOKENS = 256
const REASONING_MAX_TOKENS = 512

// ===========================================================================
// §2 类型
// ===========================================================================

type ResultStatus = 'PASS' | 'INFO' | 'SKIP' | 'FAIL'

interface CheckResult {
  id: number
  name: string
  status: ResultStatus
  detail: Record<string, unknown>
  lines: string[]
  ms: number
}

interface SseEvent {
  id?: string
  event?: string
  data: string
}

interface ChatOutcome {
  http: number
  contentType: string
  firstMs: number
  ms: number
  raw: string
  events: SseEvent[]
  chunks: number
  content: string
  reasoning: string
  finish: string
  hasDone: boolean
  echoModel: string
  usagePerFrame: boolean
  hasIdLines: boolean
  errorEvent: string
  usage: { prompt?: number; completion?: number; total?: number }
}

interface CatalogModel {
  modelId: string
  contextWindow?: number
  output?: number
  thinkingMode?: string
  reasoningEffort?: unknown
  toolCallMode?: string
}

interface CatalogInfo {
  http: number
  code: number
  version: number
  groups: number
  models: CatalogModel[]
  blacklist: string[]
  exposed: string[]
  smallModel?: string
  raw: unknown
}

interface Ctx {
  dataDir: string
  configDir: string
  authPath: string
  tokenEncPath: string
  tokenDekPath: string
  keysDir: string
  kekId: string
  dek: Buffer | null
  access: string | null
  jwt: string | null
  oldAccessCiphertext: string | null
  expires: number
  isRealName: boolean
  jwtUserId: string
  devecoVersion: string
  devecoVersionSource: string
  catalog: CatalogInfo | null
  refreshed: boolean
  wroteBack: boolean
}

// ===========================================================================
// §3 输出层（Tee：同时写 stdout 与 runs/last-output.txt）
// ===========================================================================

const ARGS = parseArgs(process.argv.slice(2))
const USE_COLOR = !ARGS.noColor && process.stdout.isTTY === true

const C = {
  reset: '\x1b[0m',
  bold: '\x1b[1m',
  dim: '\x1b[2m',
  green: '\x1b[32m',
  red: '\x1b[31m',
  yellow: '\x1b[33m',
  cyan: '\x1b[36m',
  gray: '\x1b[90m',
}

const outputBuffer: string[] = []

function paint(text: string, code: string): string {
  return USE_COLOR ? `${code}${text}${C.reset}` : text
}

/** 写到 stdout，同时记录到缓冲区（供 last-output.txt）。 */
function emit(line = ''): void {
  outputBuffer.push(line)
  process.stdout.write(`${line}\n`)
}

/** 显示宽度：中日韩全角字符按 2 列计算。 */
function displayWidth(text: string): number {
  let width = 0
  for (const ch of text) {
    const cp = ch.codePointAt(0) ?? 0
    const wide =
      (cp >= 0x1100 && cp <= 0x115f) ||
      (cp >= 0x2e80 && cp <= 0xa4cf) ||
      (cp >= 0xac00 && cp <= 0xd7a3) ||
      (cp >= 0xf900 && cp <= 0xfaff) ||
      (cp >= 0xfe10 && cp <= 0xfe19) ||
      (cp >= 0xfe30 && cp <= 0xfe6f) ||
      (cp >= 0xff00 && cp <= 0xff60) ||
      (cp >= 0xffe0 && cp <= 0xffe6)
    width += wide ? 2 : 1
  }
  return width
}

function badge(status: ResultStatus): string {
  if (status === 'PASS') return paint('PASS', C.green)
  if (status === 'FAIL') return paint('FAIL', C.red)
  if (status === 'SKIP') return paint('SKIP', C.yellow)
  return paint('INFO', C.cyan)
}

/** 检查项标题行：`[3/8] 名称 ······ PASS`，点号按显示宽度补齐。 */
function titleLine(id: number, name: string, status: ResultStatus): string {
  const prefix = `[${id}/8] ${name} `
  const dots = Math.max(3, 54 - displayWidth(prefix))
  return `${prefix}${paint('·'.repeat(dots), C.gray)} ${badge(status)}`
}

/** 明细行：缩进 6 空格，`key : value` 对齐（key 按显示宽度补到 14 列）。 */
function detailLine(key: string, value: string): string {
  const width = displayWidth(key)
  const pad = Math.max(1, 14 - width)
  return `      ${key}${' '.repeat(pad)}: ${value}`
}

// ===========================================================================
// §4 工具函数
// ===========================================================================

function parseArgs(argv: string[]): {
  only: Set<number> | null
  write: boolean
  model: string
  verbose: boolean
  noColor: boolean
  timeoutMs: number
} {
  const result = {
    only: null as Set<number> | null,
    write: false,
    model: 'GLM-5.1',
    verbose: false,
    noColor: false,
    timeoutMs: 30_000,
  }
  for (const arg of argv) {
    if (arg.startsWith('--only=')) {
      const ids = arg
        .slice('--only='.length)
        .split(',')
        .map((part) => Number(part.trim()))
        .filter((n) => Number.isFinite(n) && n >= 0)
      result.only = new Set(ids)
    } else if (arg.startsWith('--model=')) {
      const value = arg.slice('--model='.length).trim()
      if (value) result.model = value
    } else if (arg.startsWith('--timeout=')) {
      const value = Number(arg.slice('--timeout='.length))
      if (Number.isFinite(value) && value > 0) result.timeoutMs = value
    } else if (arg === '--write') {
      result.write = true
    } else if (arg === '--verbose') {
      result.verbose = true
    } else if (arg === '--no-color') {
      result.noColor = true
    }
  }
  return result
}

/** token 掩码：前 8 + 后 4 + 长度，绝不输出完整值。 */
function mask(value: string | null | undefined): string {
  if (!value) return '(空)'
  if (value.length <= 16) return `*** (len ${value.length})`
  return `${value.slice(0, 8)}...${value.slice(-4)} (len ${value.length})`
}

function b64(value: string): Buffer {
  return Buffer.from(value, 'base64')
}

/** 32 位小写 hex（DevEco 的 Chat-Id / Session-Id 形状）。 */
function uuid32(): string {
  return randomUUID().replace(/-/g, '')
}

function formatMs(ms: number): string {
  return `${Math.round(ms)} ms`
}

function formatTime(epochMs: number): string {
  const d = new Date(epochMs)
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
}

function humanDuration(ms: number): string {
  const abs = Math.abs(ms)
  const min = Math.floor(abs / 60_000)
  const hour = Math.floor(min / 60)
  if (hour > 0) return `${hour}h${min % 60}m`
  if (min > 0) return `${min}m`
  return `${Math.floor(abs / 1000)}s`
}

/** 解析 SSE：DevEco 的帧是 `id: N` + `event:` + `data:` 的组合，以空行分隔。 */
function parseSse(raw: string): SseEvent[] {
  const events: SseEvent[] = []
  let current: { id?: string; event?: string; data: string[] } = { data: [] }

  const flush = () => {
    if (current.data.length > 0 || current.event !== undefined) {
      events.push({
        ...(current.id !== undefined ? { id: current.id } : {}),
        ...(current.event !== undefined ? { event: current.event } : {}),
        data: current.data.join('\n'),
      })
    }
    current = { data: [] }
  }

  for (const line of raw.split(/\r?\n/)) {
    if (line === '') {
      flush()
      continue
    }
    if (line.startsWith('id:')) current.id = line.slice(3).trim()
    else if (line.startsWith('event:')) current.event = line.slice(6).trim()
    else if (line.startsWith('data:')) current.data.push(line.slice(5).trim())
  }
  flush()
  return events
}

/** 从 SSE data 里安全取 JSON；解析失败返回 undefined。 */
function parseJsonSafe(text: string): Record<string, unknown> | undefined {
  const trimmed = text.trim()
  if (!trimmed || trimmed === '[DONE]') return undefined
  try {
    const parsed: unknown = JSON.parse(trimmed)
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>
    }
  } catch {
    /* 非 JSON 帧，忽略 */
  }
  return undefined
}

function pick(obj: unknown, ...keys: string[]): unknown {
  let current: unknown = obj
  for (const key of keys) {
    if (!current || typeof current !== 'object') return undefined
    current = (current as Record<string, unknown>)[key]
  }
  return current
}

function asString(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

function asNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

// ===========================================================================
// §5 凭据层（可直接搬进插件 packages/plugin/src/auth/）
// ===========================================================================

interface WrappedDek {
  version: number
  algorithm: string
  kekId: string
  encryptedDek: string
  iv: string
  authTag: string
  timeStamp: number
}

interface EncryptedBlob {
  version: number
  algorithm: string
  ciphertext: string
  iv: string
  authTag: string
  timeStamp: number
}

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

/** AES-256-GCM 解密一个 blob（对齐 local-crypto.ts decryptForLocalStorage）。 */
function decryptBlob(blob: EncryptedBlob, key: Buffer): string {
  const decipher = createDecipheriv('aes-256-gcm', key, b64(blob.iv))
  decipher.setAuthTag(b64(blob.authTag))
  const plain = Buffer.concat([decipher.update(b64(blob.ciphertext)), decipher.final()])
  return plain.toString('utf8')
}

/** 读 token.dek（被 KEK 包裹的 DEK）并解出 32 字节 DEK（二进制，不转 utf8）。 */
async function unwrapDekBinary(
  dekPath: string,
  keysDir: string,
): Promise<{ dek: Buffer; kekId: string; kekBytes: number }> {
  const wrapped = JSON.parse(await readFile(dekPath, 'utf8')) as WrappedDek
  if (typeof wrapped.kekId !== 'string' || !wrapped.kekId) {
    throw new Error('token.dek 缺少 kekId 字段')
  }
  const kekPath = join(keysDir, `${wrapped.kekId}.bin`)
  if (!existsSync(kekPath)) {
    throw new Error(`密钥文件缺失或已轮换：${kekPath}`)
  }
  const kek = await readFile(kekPath)
  if (kek.length !== 32) {
    throw new Error(`KEK 长度异常：${kek.length}（应为 32）`)
  }
  const decipher = createDecipheriv('aes-256-gcm', kek, b64(wrapped.iv))
  decipher.setAuthTag(b64(wrapped.authTag))
  const dek = Buffer.concat([decipher.update(b64(wrapped.encryptedDek)), decipher.final()])
  return { dek, kekId: wrapped.kekId, kekBytes: kek.length }
}

/** 解析 JWT payload（不校验签名，只读声明）。 */
function parseJwtPayload(jwt: string): Record<string, unknown> {
  const parts = jwt.split('.')
  if (parts.length !== 3) throw new Error(`JWT 不是 3 段（实际 ${parts.length} 段）`)
  const payloadPart = parts[1] ?? ''
  const base64Url = payloadPart.replace(/-/g, '+').replace(/_/g, '/')
  const padded = base64Url.padEnd(base64Url.length + ((4 - (base64Url.length % 4)) % 4), '=')
  const json = Buffer.from(padded, 'base64').toString('utf8')
  const parsed: unknown = JSON.parse(json)
  if (!parsed || typeof parsed !== 'object') throw new Error('JWT payload 不是对象')
  return parsed as Record<string, unknown>
}

/** 探测 deveco CLI 版本（best-effort，失败不影响判定）。 */
async function detectDevecoVersion(): Promise<{ version: string; source: string }> {
  const candidates = [
    'C:\\nodejs\\aliases\\default\\node_modules\\@deveco\\deveco-code\\package.json',
    join(process.env['APPDATA'] ?? '', 'npm', 'node_modules', '@deveco', 'deveco-code', 'package.json'),
    join(process.env['ProgramFiles'] ?? '', 'nodejs', 'node_modules', '@deveco', 'deveco-code', 'package.json'),
  ]
  for (const path of candidates) {
    if (!path || !existsSync(path)) continue
    try {
      const raw = JSON.parse(await readFile(path, 'utf8')) as { version?: unknown }
      if (typeof raw.version === 'string' && raw.version) {
        return { version: raw.version, source: path }
      }
    } catch {
      /* 继续尝试下一个候选 */
    }
  }
  try {
    const run = promisify(execFile)
    const out = await run('deveco', ['--version'], {
      shell: true,
      timeout: 15_000,
      windowsHide: true,
    } as never)
    const first = (out.stdout ?? '').trim().split(/\r?\n/)[0] ?? ''
    if (first) return { version: first, source: 'deveco --version' }
  } catch {
    /* 探测失败，走兜底 */
  }
  return { version: '0.0.0', source: 'fallback' }
}

// ===========================================================================
// §6 请求层（可直接搬进插件 packages/plugin/src/adapter/）
// ===========================================================================

interface HeaderOptions {
  chatId?: boolean
  contentType?: boolean
  sessionId?: boolean
  lang?: boolean
}

/** 构造推理请求头。默认给「最小必需三件套 + Session-Id + lang」。 */
function inferenceHeaders(access: string, options: HeaderOptions = {}): Record<string, string> {
  const headers: Record<string, string> = {}
  if (options.contentType !== false) headers['content-type'] = 'application/json'
  headers['authorization'] = `Bearer ${access}`
  if (options.chatId !== false) headers['Chat-Id'] = uuid32()
  if (options.sessionId !== false) headers['Session-Id'] = uuid32()
  if (options.lang !== false) headers['lang'] = 'en'
  return headers
}

/** 刷新 access token（对齐 login-service.ts refreshToken）。 */
async function refreshAccessToken(
  jwt: string,
  timeoutMs: number,
): Promise<{ http: number; status: boolean; access: string; nationalCode: string; realName: boolean }> {
  const response = await fetch(URL_REFRESH, {
    headers: { refresh: 'true', jwtToken: jwt },
    signal: AbortSignal.timeout(timeoutMs),
  })
  const raw = (await response.json()) as {
    status?: unknown
    userInfo?: { accessToken?: unknown; nationalCode?: unknown; realName?: unknown }
  }
  return {
    http: response.status,
    status: raw.status === true,
    access: asString(raw.userInfo?.accessToken),
    nationalCode: asString(raw.userInfo?.nationalCode),
    realName: raw.userInfo?.realName === true,
  }
}

/** 拉取模型目录。 */
async function fetchCatalog(access: string, version: string, timeoutMs: number): Promise<CatalogInfo> {
  const url = `${URL_CATALOG}?localVersion=0&pluginVersion=CLI.${version}`
  const response = await fetch(url, {
    headers: { authorization: `Bearer ${access}` },
    signal: AbortSignal.timeout(timeoutMs),
  })
  const raw = (await response.json()) as {
    code?: unknown
    body?: { version?: unknown; inner_models?: unknown }
  }

  const innerModels = Array.isArray(raw.body?.inner_models) ? raw.body.inner_models : []
  const models: CatalogModel[] = []
  let blacklist: string[] = []
  let smallModel: string | undefined

  for (const group of innerModels) {
    if (!group || typeof group !== 'object') continue
    const configs = (group as { model_configs?: unknown }).model_configs
    if (Array.isArray(configs)) {
      for (const config of configs) {
        if (!config || typeof config !== 'object') continue
        const record = config as Record<string, unknown>
        const modelId = asString(record['model_id'])
        if (!modelId) continue
        models.push({
          modelId,
          ...(asNumber(record['context_window']) !== undefined
            ? { contextWindow: asNumber(record['context_window']) }
            : {}),
          ...(asNumber(record['output']) !== undefined ? { output: asNumber(record['output']) } : {}),
          ...(asString(record['thinking_mode']) ? { thinkingMode: asString(record['thinking_mode']) } : {}),
          ...(record['reasoning_effort'] !== undefined ? { reasoningEffort: record['reasoning_effort'] } : {}),
          ...(asString(record['tool_call_mode']) ? { toolCallMode: asString(record['tool_call_mode']) } : {}),
        })
      }
    }
    const map = (group as { task_default_model_map?: unknown }).task_default_model_map
    if (map && typeof map === 'object') {
      const record = map as Record<string, unknown>
      const rawBlacklist = record['blacklist']
      if (typeof rawBlacklist === 'string' && rawBlacklist) {
        blacklist = rawBlacklist
          .split(',')
          .map((item) => item.trim())
          .filter(Boolean)
      }
      const small = record['small_model']
      if (typeof small === 'string' && small) smallModel = small
    }
  }

  const exposed = models.map((m) => m.modelId).filter((id) => !blacklist.includes(id))

  return {
    http: response.status,
    code: asNumber(raw.code) ?? 0,
    version: asNumber(raw.body?.version) ?? 0,
    groups: innerModels.length,
    models,
    blacklist,
    exposed,
    ...(smallModel !== undefined ? { smallModel } : {}),
    raw,
  }
}

/** 流式对话，逐块读 body 并解析 SSE。 */
async function chatStream(
  access: string,
  body: Record<string, unknown>,
  headers: Record<string, string>,
  timeoutMs: number,
): Promise<ChatOutcome> {
  const startedAt = Date.now()
  const response = await fetch(URL_CHAT, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  })

  const contentType = response.headers.get('content-type') ?? ''
  let firstMs = -1
  let chunks = 0
  let raw = ''

  const decoder = new TextDecoder()
  if (response.body) {
    const reader = response.body.getReader()
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      if (firstMs < 0) firstMs = Date.now() - startedAt
      chunks += 1
      raw += decoder.decode(value, { stream: true })
    }
    raw += decoder.decode()
  } else {
    raw = await response.text()
  }
  const ms = Date.now() - startedAt

  const events = parseSse(raw)
  let content = ''
  let reasoning = ''
  let finish = ''
  let echoModel = ''
  let usagePerFrame = false
  let hasIdLines = false
  let errorEvent = ''
  let usage: ChatOutcome['usage'] = {}

  for (const event of events) {
    if (event.id !== undefined) hasIdLines = true
    if (event.event === 'error') errorEvent = event.data
    const json = parseJsonSafe(event.data)
    if (!json) continue
    if (pick(json, 'usage')) usagePerFrame = true

    const model = asString(json['model'])
    if (model && !echoModel) echoModel = model

    const choice = (pick(json, 'choices') as unknown[] | undefined)?.[0] as Record<string, unknown> | undefined
    const delta = choice?.['delta'] as Record<string, unknown> | undefined
    if (delta) {
      const contentDelta = asString(delta['content'])
      const reasoningDelta = asString(delta['reasoning_content'])
      if (contentDelta) content += contentDelta
      if (reasoningDelta) reasoning += reasoningDelta
    }
    const reason = asString(choice?.['finish_reason'])
    if (reason) finish = reason

    const usageNode = pick(json, 'usage')
    if (usageNode && typeof usageNode === 'object') {
      const record = usageNode as Record<string, unknown>
      usage = {
        ...(asNumber(record['prompt_tokens']) !== undefined ? { prompt: asNumber(record['prompt_tokens']) } : {}),
        ...(asNumber(record['completion_tokens']) !== undefined
          ? { completion: asNumber(record['completion_tokens']) }
          : {}),
        ...(asNumber(record['total_tokens']) !== undefined ? { total: asNumber(record['total_tokens']) } : {}),
      }
    }
  }

  return {
    http: response.status,
    contentType,
    firstMs,
    ms,
    raw,
    events,
    chunks,
    content,
    reasoning,
    finish,
    hasDone: raw.includes('[DONE]'),
    echoModel,
    usagePerFrame,
    hasIdLines,
    errorEvent,
    usage,
  }
}

/** 非流式对话（调用方负责给对 URL）。 */
async function chatNoStream(
  url: string,
  access: string,
  body: Record<string, unknown>,
  headers: Record<string, string>,
  timeoutMs: number,
): Promise<{ http: number; contentType: string; raw: string; json?: Record<string, unknown> }> {
  const response = await fetch(url, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  })
  const contentType = response.headers.get('content-type') ?? ''
  const raw = await response.text()
  return {
    http: response.status,
    contentType,
    raw,
    ...(parseJsonSafe(raw) !== undefined ? { json: parseJsonSafe(raw) } : {}),
  }
}

// ===========================================================================
// §7 八项检查
// ===========================================================================

function makeResult(
  id: number,
  name: string,
  status: ResultStatus,
  detail: Record<string, unknown>,
  lines: string[],
  ms: number,
): CheckResult {
  return { id, name, status, detail, lines, ms }
}

/** [1] 环境自检 */
async function check1(ctx: Ctx): Promise<CheckResult> {
  const startedAt = Date.now()
  const lines: string[] = []
  const detail: Record<string, unknown> = {}

  const nodeMajor = Number(process.version.replace(/^v/, '').split('.')[0] ?? 0)
  const hasFetch = typeof fetch === 'function'
  const hasStream = typeof ReadableStream === 'function'
  const hasTimeout = typeof AbortSignal.timeout === 'function'

  lines.push(detailLine('node', `${process.version}  (>= 22 ${nodeMajor >= 22 ? '✓' : '✗'})`))
  lines.push(
    detailLine(
      'globals',
      `fetch : ${hasFetch ? 'ok' : 'missing'}   ReadableStream : ${hasStream ? 'ok' : 'missing'}   AbortSignal.timeout : ${hasTimeout ? 'ok' : 'missing'}`,
    ),
  )
  lines.push(detailLine('data dir', ctx.dataDir))
  lines.push(detailLine('config dir', ctx.configDir))

  const files: Array<[string, string]> = [
    ['auth.json', ctx.authPath],
    ['token.enc', ctx.tokenEncPath],
    ['token.dek', ctx.tokenDekPath],
  ]
  const fileStatus: Record<string, boolean> = {}
  for (const [name, path] of files) {
    fileStatus[name] = existsSync(path)
    lines.push(detailLine(name, `${fileStatus[name] ? 'ok' : 'MISSING'}  ${path}`))
  }

  // 动态解析 kekId（不硬编码 kek-v1）
  let kekId = ''
  let kekPath = ''
  let kekExists = false
  if (fileStatus['token.dek']) {
    try {
      const wrapped = JSON.parse(await readFile(ctx.tokenDekPath, 'utf8')) as WrappedDek
      kekId = asString(wrapped.kekId)
      kekPath = join(ctx.keysDir, `${kekId}.bin`)
      kekExists = existsSync(kekPath)
      ctx.kekId = kekId
      lines.push(detailLine('kekId', `${kekId || '(缺失)'}  →  ${kekPath} : ${kekExists ? 'ok' : 'MISSING'}`))
    } catch (error) {
      lines.push(detailLine('kekId', `读取 token.dek 失败：${error instanceof Error ? error.message : String(error)}`))
    }
  }

  detail['node'] = process.version
  detail['nodeMajor'] = nodeMajor
  detail['hasFetch'] = hasFetch
  detail['hasStream'] = hasStream
  detail['hasTimeout'] = hasTimeout
  detail['files'] = fileStatus
  detail['kekId'] = kekId
  detail['kekExists'] = kekExists

  const ok =
    nodeMajor >= 22 &&
    hasFetch &&
    hasStream &&
    hasTimeout &&
    fileStatus['auth.json'] === true &&
    fileStatus['token.enc'] === true &&
    fileStatus['token.dek'] === true &&
    kekExists

  const status: ResultStatus = ok ? 'PASS' : 'FAIL'
  if (!ok && fileStatus['auth.json'] !== true) {
    lines.push('      → 缺少 auth.json：请先执行 `deveco auth login`')
  }
  if (!ok && fileStatus['token.dek'] === true && !kekExists) {
    lines.push('      → 密钥文件缺失或已轮换，需重新登录')
  }
  return makeResult(1, '环境自检', status, detail, lines, Date.now() - startedAt)
}

/** [2] 解包 DEK（KEK → DEK） */
async function check2(ctx: Ctx): Promise<CheckResult> {
  const startedAt = Date.now()
  const lines: string[] = []
  const detail: Record<string, unknown> = {}

  try {
    const { dek, kekId, kekBytes } = await unwrapDekBinary(ctx.tokenDekPath, ctx.keysDir)
    ctx.dek = dek
    ctx.kekId = kekId
    lines.push(detailLine('kekId', kekId))
    lines.push(detailLine('kek bytes', String(kekBytes)))
    lines.push(detailLine('dek bytes', String(dek.length)))
    detail['kekId'] = kekId
    detail['kekBytes'] = kekBytes
    detail['dekBytes'] = dek.length
    const ok = kekBytes === 32 && dek.length === 32
    return makeResult(2, '解包 DEK（KEK → DEK）', ok ? 'PASS' : 'FAIL', detail, lines, Date.now() - startedAt)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    lines.push(detailLine('error', message))
    detail['error'] = message
    return makeResult(2, '解包 DEK（KEK → DEK）', 'FAIL', detail, lines, Date.now() - startedAt)
  }
}

/** [3] 解密 access / JWT */
async function check3(ctx: Ctx): Promise<CheckResult> {
  const startedAt = Date.now()
  const lines: string[] = []
  const detail: Record<string, unknown> = {}

  if (!ctx.dek) {
    lines.push(detailLine('error', 'DEK 未就绪（[2] 未通过）'))
    return makeResult(3, '解密 access / JWT', 'SKIP', detail, lines, Date.now() - startedAt)
  }

  try {
    const authRaw = JSON.parse(await readFile(ctx.authPath, 'utf8')) as Record<string, unknown>
    const deveco = authRaw['deveco'] as Record<string, unknown> | undefined
    if (!deveco) throw new Error('auth.json 缺少 deveco 条目')

    const type = asString(deveco['type'])
    const accessBlob = deveco['access']
    const refreshBlob = deveco['refresh']
    if (!isEncryptedBlob(accessBlob)) throw new Error('deveco.access 不是合法的加密 blob')

    const access = decryptBlob(accessBlob, ctx.dek)
    ctx.access = access
    ctx.oldAccessCiphertext = accessBlob.ciphertext
    ctx.expires = asNumber(deveco['expires']) ?? 0
    ctx.isRealName = deveco['isRealName'] === true

    let refreshLength = -1
    if (isEncryptedBlob(refreshBlob)) {
      try {
        refreshLength = decryptBlob(refreshBlob, ctx.dek).length
      } catch {
        refreshLength = -1
      }
    }

    // token.enc 里是 JWT
    const tokenEncBlob = JSON.parse(await readFile(ctx.tokenEncPath, 'utf8')) as EncryptedBlob
    if (!isEncryptedBlob(tokenEncBlob)) throw new Error('token.enc 不是合法的加密 blob')
    const jwt = decryptBlob(tokenEncBlob, ctx.dek)
    ctx.jwt = jwt
    const payload = parseJwtPayload(jwt)
    ctx.jwtUserId = asString(payload['userId'])
    const exp = asNumber(payload['exp'])

    const now = Date.now()
    const expired = ctx.expires > 0 ? now >= ctx.expires : true

    lines.push(detailLine('type', type))
    lines.push(detailLine('access', mask(access)))
    lines.push(detailLine('refresh', refreshLength >= 0 ? `(空字符串，len ${refreshLength})` : '解密失败'))
    lines.push(
      detailLine(
        'jwt',
        `3 段  userId=${ctx.jwtUserId || '(空)'}  exp=${exp ? formatTime(exp * 1000) : '(无)'}`,
      ),
    )
    lines.push(detailLine('expires', ctx.expires ? formatTime(ctx.expires) : '(缺失)'))
    lines.push(
      detailLine('状态', expired ? `已过期 ${humanDuration(now - ctx.expires)}  ← 将触发 [4]` : `有效（剩余 ${humanDuration(ctx.expires - now)}）`),
    )
    lines.push(detailLine('isRealName', String(ctx.isRealName)))

    detail['type'] = type
    detail['accessLen'] = access.length
    detail['refreshLen'] = refreshLength
    detail['jwtUserId'] = ctx.jwtUserId
    detail['jwtExp'] = exp ?? null
    detail['expires'] = ctx.expires
    detail['expired'] = expired
    detail['isRealName'] = ctx.isRealName

    const ok = type === 'oauth' && access.length >= 100 && jwt.split('.').length === 3
    return makeResult(3, '解密 access / JWT', ok ? 'PASS' : 'FAIL', detail, lines, Date.now() - startedAt)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    lines.push(detailLine('error', message))
    detail['error'] = message
    return makeResult(3, '解密 access / JWT', 'FAIL', detail, lines, Date.now() - startedAt)
  }
}

/** [4] token 刷新 */
async function check4(ctx: Ctx): Promise<CheckResult> {
  const startedAt = Date.now()
  const lines: string[] = []
  const detail: Record<string, unknown> = {}

  if (!ctx.access || !ctx.jwt) {
    lines.push(detailLine('error', 'access / JWT 未就绪（[3] 未通过）'))
    return makeResult(4, '刷新 access token', 'SKIP', detail, lines, Date.now() - startedAt)
  }

  const now = Date.now()
  if (ctx.expires > 0 && now < ctx.expires) {
    lines.push(detailLine('原因', `token 未过期（剩余 ${humanDuration(ctx.expires - now)}），无需刷新`))
    lines.push(detailLine('端点', 'GET /authrouter/auth/api/jwToken/check（已过期时才调）'))
    detail['reason'] = 'not_expired'
    detail['remainingMs'] = ctx.expires - now
    return makeResult(4, '刷新 access token', 'SKIP', detail, lines, Date.now() - startedAt)
  }

  try {
    const oldAccess = ctx.access
    const result = await refreshAccessToken(ctx.jwt, ARGS.timeoutMs)

    lines.push(detailLine('端点', 'GET /authrouter/auth/api/jwToken/check'))
    lines.push(detailLine('refresh=true', `status=${result.status}  nationalCode=${result.nationalCode}  realName=${result.realName}`))
    lines.push(detailLine('旧 access', mask(oldAccess)))
    lines.push(detailLine('新 access', mask(result.access)))

    const ok =
      result.http === 200 &&
      result.status === true &&
      result.access.length > 0 &&
      result.nationalCode === 'CN' &&
      result.realName === true

    if (ok) {
      ctx.access = result.access
      ctx.refreshed = true
    }

    // --write：备份 + CAS 写回
    if (ARGS.write && ok && ctx.dek) {
      try {
        const backupPath = `${ctx.authPath}.p0bak`
        await copyFile(ctx.authPath, backupPath)
        const currentRaw = JSON.parse(await readFile(ctx.authPath, 'utf8')) as Record<string, unknown>
        const currentEntry = currentRaw['deveco'] as Record<string, unknown> | undefined
        const currentBlob = currentEntry?.['access']
        const currentCiphertext = isEncryptedBlob(currentBlob) ? currentBlob.ciphertext : ''
        if (currentCiphertext !== ctx.oldAccessCiphertext) {
          lines.push(detailLine('写回', 'WARN：磁盘 access 已被其他进程改动（CAS 不符），放弃写回'))
          detail['wroteBack'] = false
          detail['writeBackReason'] = 'cas_mismatch'
        } else {
          const encrypted = encryptBlob(result.access, ctx.dek)
          const nextRaw = {
            ...currentRaw,
            deveco: {
              ...currentEntry,
              access: encrypted,
              expires: Date.now() + 30 * 60 * 1000,
            },
          }
          const tmpPath = `${ctx.authPath}.p0tmp`
          await writeFile(tmpPath, JSON.stringify(nextRaw, null, 2), { mode: 0o600 })
          await rename(tmpPath, ctx.authPath)
          ctx.wroteBack = true
          lines.push(detailLine('写回', `是（已备份 → ${backupPath}）`))
          detail['wroteBack'] = true
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        lines.push(detailLine('写回', `WARN：写回失败（${message}）`))
        detail['wroteBack'] = false
        detail['writeBackReason'] = message
      }
    } else {
      lines.push(detailLine('写回磁盘', ARGS.write ? '否（刷新未成功）' : '否（--write 未开启，仅内存使用）'))
      detail['wroteBack'] = false
    }

    detail['http'] = result.http
    detail['status'] = result.status
    detail['nationalCode'] = result.nationalCode
    detail['realName'] = result.realName
    detail['newAccessLen'] = result.access.length

    if (!ok) {
      lines.push('      → status=false 表示 JWT 已过期，请执行 `deveco auth login` 重新登录')
    }
    return makeResult(4, '刷新 access token', ok ? 'PASS' : 'FAIL', detail, lines, Date.now() - startedAt)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    lines.push(detailLine('error', message))
    detail['error'] = message
    return makeResult(4, '刷新 access token', 'FAIL', detail, lines, Date.now() - startedAt)
  }
}

/** AES-256-GCM 加密（仅 --write 用，对齐 local-crypto.ts encryptForLocalStorage）。 */
function encryptBlob(plaintext: string, key: Buffer): EncryptedBlob {
  const iv = randomBytes(12)
  const cipher = createCipheriv('aes-256-gcm', key, iv)
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()])
  const authTag = cipher.getAuthTag()
  return {
    version: 1,
    algorithm: 'aes-256-gcm',
    ciphertext: ciphertext.toString('base64'),
    iv: iv.toString('base64'),
    authTag: authTag.toString('base64'),
    timeStamp: Date.now(),
  }
}

// ===========================================================================
// §8 其余检查
// ===========================================================================

/** [5] 拉取模型目录 */
async function check5(ctx: Ctx): Promise<CheckResult> {
  const startedAt = Date.now()
  const lines: string[] = []
  const detail: Record<string, unknown> = {}

  if (!ctx.access) {
    lines.push(detailLine('error', 'access 未就绪（[3] 未通过）'))
    return makeResult(5, '拉取模型目录', 'SKIP', detail, lines, Date.now() - startedAt)
  }

  try {
    const catalog = await fetchCatalog(ctx.access, ctx.devecoVersion, ARGS.timeoutMs)
    ctx.catalog = catalog

    lines.push(detailLine('HTTP', `${catalog.http}   code=${catalog.code}   version=${catalog.version}   groups=${catalog.groups}`))
    lines.push(detailLine(`模型 (${catalog.models.length})`, catalog.models.map((m) => m.modelId).join(' | ')))
    lines.push(detailLine('blacklist', catalog.blacklist.length > 0 ? catalog.blacklist.join(' | ') : '(空)'))
    lines.push(detailLine(`暴露 (${catalog.exposed.length})`, catalog.exposed.join(' | ') || '(无)'))
    if (catalog.smallModel) lines.push(detailLine('small_model', catalog.smallModel))

    detail['http'] = catalog.http
    detail['code'] = catalog.code
    detail['version'] = catalog.version
    detail['groups'] = catalog.groups
    detail['models'] = catalog.models.map((m) => m.modelId)
    detail['blacklist'] = catalog.blacklist
    detail['exposed'] = catalog.exposed
    detail['smallModel'] = catalog.smallModel ?? null

    const hasKnown = catalog.exposed.some((id) => id === 'GLM-5.1' || id === 'GLM-5.3')
    const ok = catalog.http === 200 && catalog.code === 200 && catalog.exposed.length >= 1 && hasKnown

    if (!ok) {
      if (catalog.http === 401) lines.push('      → HTTP 401：token 失效，请重跑 [4] 或执行 `deveco auth login`')
      else if (catalog.exposed.length === 0) lines.push('      → 暴露模型为空：上游 blacklist 可能把所有模型都排除了')
      else lines.push('      → 暴露列表里既没有 GLM-5.1 也没有 GLM-5.3')
    }
    return makeResult(5, '拉取模型目录', ok ? 'PASS' : 'FAIL', detail, lines, Date.now() - startedAt)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    lines.push(detailLine('error', message))
    detail['error'] = message
    return makeResult(5, '拉取模型目录', 'FAIL', detail, lines, Date.now() - startedAt)
  }
}

/** [6] 流式对话（6a 断言 / 6b 记录） */
async function check6(ctx: Ctx): Promise<CheckResult> {
  const startedAt = Date.now()
  const lines: string[] = []
  const detail: Record<string, unknown> = {}

  if (!ctx.access) {
    lines.push(detailLine('error', 'access 未就绪（[3] 未通过）'))
    return makeResult(6, '流式对话', 'SKIP', detail, lines, Date.now() - startedAt)
  }

  const sub: Record<string, unknown> = {}

  // ---- 6a：最小必需头三件套（authorization + Chat-Id + content-type）----
  try {
    lines.push('      --- 6a 不传 thinking（断言）---')
    const headers = inferenceHeaders(ctx.access, { sessionId: false, lang: false })
    const outcome = await chatStream(
      ctx.access,
      {
        model: ARGS.model,
        messages: [{ role: 'user', content: PROBE_PROMPT }],
        stream: true,
        max_tokens: PROBE_MAX_TOKENS,
      },
      headers,
      ARGS.timeoutMs,
    )

    lines.push(detailLine('请求 model', `${ARGS.model}  → 回显 ${outcome.echoModel || '(无)'}`))
    lines.push(detailLine('HTTP', `${outcome.http}   ct=${outcome.contentType || '(无)'}`))
    lines.push(detailLine('首帧延迟', `${formatMs(outcome.firstMs)}      总耗时 : ${formatMs(outcome.ms)}      chunk : ${outcome.chunks}`))
    lines.push(detailLine('帧特征', `帧带 usage : ${outcome.usagePerFrame ? '✓' : '✗'}            帧前 id: ${outcome.hasIdLines ? '✓' : '✗'}`))
    lines.push(detailLine('正文', `${JSON.stringify(outcome.content)}  (len ${outcome.content.length})`))
    // 泄漏检测：某些模型会把内部推理写进 content（实测 GLM-5.3 会带 </think> 标签）
    const leakedReasoning = outcome.content.includes('</think') || outcome.content.includes('<think')
    if (leakedReasoning) {
      lines.push(detailLine('⚠ 泄漏', 'content 里出现 think 标签 → 插件需要剥离'))
    }
    lines.push(detailLine('finish', `${outcome.finish || '(无)'}          终止 : data: [DONE] ${outcome.hasDone ? '✓' : '✗'}`))
    if (outcome.errorEvent) {
      lines.push(detailLine('error 帧', outcome.errorEvent.slice(0, 300)))
    }
    if (ARGS.verbose) {
      lines.push('      --- 原始帧 ---')
      for (const event of outcome.events.slice(0, 20)) {
        lines.push(`      ${event.id !== undefined ? `id:${event.id} ` : ''}${event.event ? `event:${event.event} ` : ''}${event.data.slice(0, 300)}`)
      }
    }

    const ok6a =
      outcome.http === 200 &&
      outcome.contentType.includes('text/event-stream') &&
      outcome.content.length > 0 &&
      outcome.hasDone &&
      outcome.chunks >= 3 &&
      outcome.firstMs >= 0 &&
      outcome.firstMs < ARGS.timeoutMs

    sub['6a'] = {
      http: outcome.http,
      contentType: outcome.contentType,
      echoModel: outcome.echoModel,
      firstMs: outcome.firstMs,
      ms: outcome.ms,
      chunks: outcome.chunks,
      contentLen: outcome.content.length,
      content: outcome.content.slice(0, 500),
      finish: outcome.finish,
      hasDone: outcome.hasDone,
      usagePerFrame: outcome.usagePerFrame,
      idLines: outcome.hasIdLines,
      usage: outcome.usage,
      leakedReasoning,
      ok: ok6a,
    }

    if (!ok6a) {
      if (outcome.http === 429) lines.push('      → HTTP 429：账号配额耗尽，稍后重试')
      else if (outcome.errorEvent) lines.push('      → 收到 error 帧，见上')
    }

    // ---- 6b：传 thinking:enabled（只记录，不断言正文非空）----
    lines.push('      --- 6b 传 thinking:enabled（INFO，不断言）---')
    const outcome6b = await chatStream(
      ctx.access,
      {
        model: ARGS.model,
        messages: [{ role: 'user', content: REASONING_PROMPT }],
        stream: true,
        max_tokens: REASONING_MAX_TOKENS,
        thinking: { type: 'enabled' },
      },
      inferenceHeaders(ctx.access),
      ARGS.timeoutMs,
    )

    lines.push(detailLine('请求 model', `${ARGS.model}  max_tokens=${REASONING_MAX_TOKENS}`))
    lines.push(detailLine('思考 len', String(outcome6b.reasoning.length)))
    lines.push(detailLine('正文 len', String(outcome6b.content.length)))
    lines.push(detailLine('finish', outcome6b.finish || '(无)'))
    lines.push(
      detailLine(
        '结论',
        outcome6b.reasoning.length > 0 && outcome6b.content.length === 0
          ? '思考吃满预算 → 正文为空（已知行为，非故障）'
          : outcome6b.reasoning.length > 0
            ? '思考与正文同时存在'
            : '未观察到 reasoning_content（可能该模型未返回思考）',
      ),
    )

    sub['6b'] = {
      http: outcome6b.http,
      contentLen: outcome6b.content.length,
      reasoningLen: outcome6b.reasoning.length,
      finish: outcome6b.finish,
      echoModel: outcome6b.echoModel,
      sawReasoning: outcome6b.reasoning.length > 0,
    }

    detail['6a'] = sub['6a']
    detail['6b'] = sub['6b']
    detail['model'] = ARGS.model
    detail['sub'] = { '6b': 'INFO' as ResultStatus }

    return makeResult(6, '流式对话', ok6a ? 'PASS' : 'FAIL', detail, lines, Date.now() - startedAt)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    lines.push(detailLine('error', message))
    detail['error'] = message
    return makeResult(6, '流式对话', 'FAIL', detail, lines, Date.now() - startedAt)
  }
}

/** [7] 非流式对话（7a INFO / 7b 断言） */
async function check7(ctx: Ctx): Promise<CheckResult> {
  const startedAt = Date.now()
  const lines: string[] = []
  const detail: Record<string, unknown> = {}

  if (!ctx.access) {
    lines.push(detailLine('error', 'access 未就绪（[3] 未通过）'))
    return makeResult(7, '非流式对话', 'SKIP', detail, lines, Date.now() - startedAt)
  }

  const sub: Record<string, unknown> = {}
  try {
    // 7a 负向：打错路径
    lines.push('      --- 7a 负向（INFO，不断言）---')
    const negative = await chatStream(
      ctx.access,
      {
        model: ARGS.model,
        messages: [{ role: 'user', content: '说 ok' }],
        stream: false,
        max_tokens: 16,
      },
      inferenceHeaders(ctx.access),
      ARGS.timeoutMs,
    )
    const originalMessage = asString(pick(parseJsonSafe(negative.errorEvent) ?? {}, 'error', 'param', 'originalMessage'))
    lines.push(
      detailLine(
        '结果',
        `/chat/completions + stream:false → HTTP ${negative.http}${negative.errorEvent ? '，SSE 内错误' : ''}`,
      ),
    )
    if (originalMessage) lines.push(detailLine('originalMessage', originalMessage))
    sub['7a'] = {
      http: negative.http,
      hasErrorEvent: negative.errorEvent.length > 0,
      originalMessage,
    }

    // 7b 正向：正确路径
    lines.push('      --- 7b 正向（断言）---')
    const positive = await chatNoStream(
      URL_CHAT_NO_STREAM,
      ctx.access,
      {
        model: ARGS.model,
        messages: [{ role: 'user', content: '说 ok' }],
        stream: false,
        max_tokens: 16,
      },
      inferenceHeaders(ctx.access),
      ARGS.timeoutMs,
    )
    const content = asString(pick(positive.json ?? {}, 'choices', 0, 'message', 'content'))
    const usage = pick(positive.json ?? {}, 'usage')
    lines.push(detailLine('结果', `/no-stream/chat/completions → HTTP ${positive.http}   ct=${positive.contentType || '(无)'}`))
    lines.push(detailLine('content', `${JSON.stringify(content)}  (len ${content.length})`))
    if (usage && typeof usage === 'object') {
      const record = usage as Record<string, unknown>
      lines.push(
        detailLine(
          'usage',
          `prompt ${asNumber(record['prompt_tokens']) ?? '-'} / completion ${asNumber(record['completion_tokens']) ?? '-'} / total ${asNumber(record['total_tokens']) ?? '-'}`,
        ),
      )
    }
    if (ARGS.verbose && positive.json) {
      lines.push('      --- 完整 JSON ---')
      lines.push(`      ${JSON.stringify(positive.json).slice(0, 800)}`)
    }

    const ok7b =
      positive.http === 200 &&
      positive.contentType.includes('application/json') &&
      content.length > 0 &&
      usage !== undefined

    sub['7b'] = {
      http: positive.http,
      contentType: positive.contentType,
      contentLen: content.length,
      content,
      hasUsage: usage !== undefined,
      ok: ok7b,
    }

    detail['7a'] = sub['7a']
    detail['7b'] = sub['7b']
    detail['sub'] = { '7a': 'INFO' as ResultStatus }

    return makeResult(7, '非流式对话', ok7b ? 'PASS' : 'FAIL', detail, lines, Date.now() - startedAt)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    lines.push(detailLine('error', message))
    detail['error'] = message
    return makeResult(7, '非流式对话', 'FAIL', detail, lines, Date.now() - startedAt)
  }
}

/** [8] 错误形态识别（8a/8b 断言，8c INFO） */
async function check8(ctx: Ctx): Promise<CheckResult> {
  const startedAt = Date.now()
  const lines: string[] = []
  const detail: Record<string, unknown> = {}

  const sub: Record<string, unknown> = {}
  const failures: string[] = []

  // 8a 坏 token
  try {
    lines.push('      --- 8a 坏 token（断言）---')
    const response = await fetch(URL_CHAT, {
      method: 'POST',
      headers: inferenceHeaders('badtoken', { sessionId: false, lang: false }),
      body: JSON.stringify({
        model: ARGS.model,
        messages: [{ role: 'user', content: 'hi' }],
        stream: true,
        max_tokens: 8,
      }),
      signal: AbortSignal.timeout(ARGS.timeoutMs),
    })
    const raw = await response.text()
    const json = parseJsonSafe(raw)
    const errorCode = asNumber(json?.['errorCode'])
    lines.push(detailLine('HTTP', `${response.status}   ct=${response.headers.get('content-type') ?? '(无)'}`))
    lines.push(detailLine('body', raw.slice(0, 200)))
    const ok8a = response.status === 200 && errorCode === 4016
    if (!ok8a) failures.push('8a 坏 token 未返回预期的 200 + errorCode:4016')
    sub['8a'] = { http: response.status, errorCode: errorCode ?? null, raw: raw.slice(0, 400), ok: ok8a }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    lines.push(detailLine('8a error', message))
    failures.push(`8a 异常：${message}`)
    sub['8a'] = { error: message }
  }

  // 8b 缺 Chat-Id
  if (ctx.access) {
    try {
      lines.push('      --- 8b 缺 Chat-Id（断言）---')
      const response = await fetch(URL_CHAT, {
        method: 'POST',
        headers: inferenceHeaders(ctx.access, { chatId: false, sessionId: false, lang: false }),
        body: JSON.stringify({
          model: ARGS.model,
          messages: [{ role: 'user', content: 'hi' }],
          stream: true,
          max_tokens: 8,
        }),
        signal: AbortSignal.timeout(ARGS.timeoutMs),
      })
      const raw = await response.text()
      const json = parseJsonSafe(raw)
      const originalMessage = asString(pick(json ?? {}, 'error', 'param', 'originalMessage'))
      lines.push(detailLine('HTTP', `${response.status}`))
      lines.push(detailLine('originalMessage', originalMessage || '(无)'))
      const ok8b = response.status === 400 && originalMessage.includes('Chat-Id')
      if (!ok8b) failures.push('8b 缺 Chat-Id 未返回预期的 400 + Chat-Id 提示')
      sub['8b'] = { http: response.status, originalMessage, ok: ok8b }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      lines.push(detailLine('8b error', message))
      failures.push(`8b 异常：${message}`)
      sub['8b'] = { error: message }
    }

    // 8c 未知模型（INFO，重大发现）
    try {
      lines.push('      --- 8c 未知模型（INFO，重大发现）---')
      const outcome = await chatStream(
        ctx.access,
        {
          model: UNKNOWN_MODEL,
          messages: [{ role: 'user', content: PROBE_PROMPT }],
          stream: true,
          max_tokens: 64,
        },
        inferenceHeaders(ctx.access),
        ARGS.timeoutMs,
      )
      lines.push(detailLine('请求 model', UNKNOWN_MODEL))
      lines.push(detailLine('HTTP', `${outcome.http}   bytes=${outcome.raw.length}   chunks=${outcome.chunks}`))
      lines.push(detailLine('回显 model', outcome.echoModel || '(无)'))
      lines.push(detailLine('正文', `${JSON.stringify(outcome.content)}  (len ${outcome.content.length})`))
      lines.push(detailLine('终止', `data: [DONE] ${outcome.hasDone ? '✓' : '✗'}`))
      const fellBack = outcome.echoModel !== '' && outcome.echoModel !== UNKNOWN_MODEL
      if (fellBack) {
        lines.push('      ⚠ 上游对未知模型静默回落 → 插件必须自建模型白名单')
      } else if (outcome.raw.length > 0) {
        lines.push('      → 未观察到回落（本次可能命中排队/截断，属偶发）')
      } else {
        lines.push('      → 响应为空（本次可能命中排队，属偶发）')
      }
      sub['8c'] = {
        http: outcome.http,
        bytes: outcome.raw.length,
        chunks: outcome.chunks,
        echoModel: outcome.echoModel,
        contentLen: outcome.content.length,
        hasDone: outcome.hasDone,
        fellBack,
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      lines.push(detailLine('8c error', message))
      sub['8c'] = { error: message }
    }
  } else {
    lines.push('      --- 8b/8c 跳过：access 未就绪 ---')
    sub['8b'] = { skipped: true }
    sub['8c'] = { skipped: true }
  }

  detail['8a'] = sub['8a']
  detail['8b'] = sub['8b']
  detail['8c'] = sub['8c']
  detail['sub'] = { '8c': 'INFO' as ResultStatus }
  if (failures.length > 0) detail['failures'] = failures

  return makeResult(8, '错误形态识别', failures.length === 0 ? 'PASS' : 'FAIL', detail, lines, Date.now() - startedAt)
}

// ===========================================================================
// §9 编排
// ===========================================================================

const CHECK_NAMES: Record<number, string> = {
  1: '环境自检',
  2: '解包 DEK（KEK → DEK）',
  3: '解密 access / JWT',
  4: '刷新 access token',
  5: '拉取模型目录',
  6: '流式对话',
  7: '非流式对话',
  8: '错误形态识别',
}

/** 每个目标检查所需的依赖链。 */
const CHECK_DEPS: Record<number, number[]> = {
  1: [1],
  2: [1, 2],
  3: [1, 2, 3],
  4: [1, 2, 3, 4],
  5: [1, 2, 3, 4, 5],
  6: [1, 2, 3, 4, 6],
  7: [1, 2, 3, 4, 7],
  8: [1, 2, 3, 4, 8],
}

function resolvePlan(only: Set<number> | null): { run: number[]; report: Set<number> } {
  if (!only || only.size === 0) {
    return { run: [1, 2, 3, 4, 5, 6, 7, 8], report: new Set([1, 2, 3, 4, 5, 6, 7, 8]) }
  }
  const report = new Set<number>()
  const run = new Set<number>()
  for (const id of only) {
    if (id === 0) continue
    const deps = CHECK_DEPS[id]
    if (!deps) continue
    report.add(id)
    for (const dep of deps) run.add(dep)
  }
  const order = [1, 2, 3, 4, 5, 6, 7, 8].filter((id) => run.has(id))
  return { run: order, report }
}

const CHECK_FNS: Record<number, (ctx: Ctx) => Promise<CheckResult>> = {
  1: check1,
  2: check2,
  3: check3,
  4: check4,
  5: check5,
  6: check6,
  7: check7,
  8: check8,
}

// ===========================================================================
// §10 main
// ===========================================================================

async function main(): Promise<number> {
  const startedAt = Date.now()
  const ctx: Ctx = {
    dataDir: join(homedir(), '.local', 'share', 'deveco'),
    configDir: join(homedir(), '.config', 'deveco'),
    authPath: join(homedir(), '.local', 'share', 'deveco', 'auth.json'),
    tokenEncPath: join(homedir(), '.config', 'deveco', 'token.enc'),
    tokenDekPath: join(homedir(), '.config', 'deveco', 'token.dek'),
    keysDir: join(homedir(), '.config', 'deveco', 'keys'),
    kekId: '',
    dek: null,
    access: null,
    jwt: null,
    oldAccessCiphertext: null,
    expires: 0,
    isRealName: false,
    jwtUserId: '',
    devecoVersion: '0.0.0',
    devecoVersionSource: 'pending',
    catalog: null,
    refreshed: false,
    wroteBack: false,
  }

  emit(paint('═'.repeat(60), C.gray))
  emit(paint('  P0 探针 · DevEco Code 免费模型通道', C.bold))
  emit(`  test/P0/probe.ts   node ${process.version}`)
  emit(`  ${formatTime(startedAt)}`)
  if (ARGS.only) emit(`  模式：--only=${[...ARGS.only].join(',')}`)
  emit(paint('═'.repeat(60), C.gray))
  emit()

  // 前置条件：凭据目录必须存在
  if (!existsSync(ctx.authPath)) {
    emit(paint('  ❌ 找不到 auth.json：请先执行 `deveco auth login`', C.red))
    emit(`     期望路径：${ctx.authPath}`)
    emit()
    await flushOutput()
    return 2
  }

  // 版本探测
  const versionInfo = await detectDevecoVersion()
  ctx.devecoVersion = versionInfo.version
  ctx.devecoVersionSource = versionInfo.source

  const plan = resolvePlan(ARGS.only)
  const results: CheckResult[] = []
  let skippedBecauseDependency = false

  for (const id of plan.run) {
    const name = CHECK_NAMES[id] ?? `check${id}`
    const shouldReport = plan.report.has(id)

    if (skippedBecauseDependency) {
      if (shouldReport) {
        emit(titleLine(id, name, 'SKIP'))
        emit(detailLine('原因', '前置检查未通过，跳过'))
        emit()
      }
      results.push(makeResult(id, name, 'SKIP', { reason: 'dependency_failed' }, [], 0))
      continue
    }

    const fn = CHECK_FNS[id]
    if (!fn) continue
    const result = await fn(ctx)
    results.push(result)

    if (shouldReport) {
      emit(titleLine(id, result.name, result.status))
      for (const line of result.lines) emit(line)
      emit()
    }

    if (result.status === 'FAIL' && id <= 4) {
      // 凭据链断裂：后续检查无法进行
      skippedBecauseDependency = true
    }
  }

  // ---- 汇总 ----
  // 统计口径：顶层 8 项 + 子用例（6b / 7a / 8c 记为 INFO，计入 INFO 数）
  const counts = { PASS: 0, INFO: 0, SKIP: 0, FAIL: 0 }
  for (const result of results) {
    if (plan.report.has(result.id)) counts[result.status] += 1
  }
  // 子用例计数：只统计真正跑到的子项
  for (const result of results) {
    if (!plan.report.has(result.id)) continue
    const detail = result.detail
    const sub = detail['sub'] as Record<string, ResultStatus> | undefined
    if (!sub) continue
    for (const status of Object.values(sub)) counts[status] += 1
  }
  const failures = results.filter((r) => plan.report.has(r.id) && r.status === 'FAIL')

  emit(paint('═'.repeat(60), C.gray))
  emit(paint('  P0 结果汇总', C.bold))
  emit(paint('═'.repeat(60), C.gray))
  for (const result of results) {
    if (!plan.report.has(result.id)) continue
    const label = `  [${result.id}] ${CHECK_NAMES[result.id] ?? result.name}`
    const padded = `${label.padEnd(30, ' ')}`
    emit(`${padded}${badge(result.status)}${result.status === 'SKIP' ? paint('   (前置条件不满足)', C.gray) : ''}`)
  }
  emit()
  emit(`  统计：PASS ${counts.PASS} · INFO ${counts.INFO} · SKIP ${counts.SKIP} · FAIL ${counts.FAIL}`)
  emit()

  const ok = failures.length === 0
  if (ok) {
    emit(paint(`  ✅ P0 通过（FAIL=0）`, C.green + C.bold))
    emit('  结论：凭据链路与上游协议均已验证，可以进入 P1。')
  } else {
    emit(paint(`  ❌ P0 未通过（FAIL=${failures.length}）`, C.red + C.bold))
    emit(`  失败项：${failures.map((r) => `[${r.id}] ${CHECK_NAMES[r.id] ?? r.name}`).join('、')}`)
    emit()
    emit('  下一步：')
    for (const failure of failures) {
      if (failure.id === 1) emit('    · [1] 检查凭据文件是否存在；缺 auth.json 请先 `deveco auth login`')
      if (failure.id === 2) emit('    · [2] 密钥文件缺失或已轮换，需重新登录以重建 keys/ 与 token.dek')
      if (failure.id === 3) emit('    · [3] auth.json / token.enc 解密失败，需重新登录')
      if (failure.id === 4) emit('    · [4] jwToken/check 返回 status=false → JWT 已过期，执行 `deveco auth login`')
      if (failure.id === 5) emit('    · [5] HTTP 401 → token 失效；重跑 [4] 或重新登录')
      if (failure.id === 6) emit('    · [6] 429 表示配额耗尽；正文为空但 reasoning_content 有内容不算失败')
      if (failure.id === 7) emit('    · [7] 非流式必须走 /no-stream/chat/completions')
      if (failure.id === 8) emit('    · [8] 错误形态与预期不符，检查上游是否变更')
    }
  }
  emit()
  emit(`  报告：${REPORT_PATH}`)
  emit(`  输出：${OUTPUT_PATH}`)
  emit(paint('═'.repeat(60), C.gray))

  // ---- 写报告（即使在 finally 里也保证写出）----
  const report = {
    schema: 'p0-report/v1',
    startedAt: new Date(startedAt).toISOString(),
    finishedAt: new Date().toISOString(),
    node: process.version,
    host: `${process.platform} ${process.arch}`,
    devecoVersion: ctx.devecoVersion,
    devecoVersionSource: ctx.devecoVersionSource,
    account: {
      userId: ctx.jwtUserId || null,
      nationalCode: null,
      isRealName: ctx.isRealName,
    },
    refreshed: ctx.refreshed,
    wroteBack: ctx.wroteBack,
    summary: counts,
    ok,
    checks: results
      .filter((r) => plan.report.has(r.id))
      .map((r) => ({
        id: r.id,
        name: r.name,
        status: r.status,
        ms: r.ms,
        detail: r.detail,
      })),
  }

  await mkdir(RUNS_DIR, { recursive: true })
  await writeFile(REPORT_PATH, `${JSON.stringify(report, null, 2)}\n`, 'utf8')
  await flushOutput()

  return ok ? 0 : 1
}

async function flushOutput(): Promise<void> {
  try {
    await mkdir(RUNS_DIR, { recursive: true })
    await writeFile(OUTPUT_PATH, `${outputBuffer.join('\n')}\n`, 'utf8')
  } catch {
    /* 输出留档失败不影响主流程 */
  }
}

// ===========================================================================
// §11 入口
// ===========================================================================

main()
  .then((code) => {
    process.exitCode = code
  })
  .catch(async (error: unknown) => {
    const message = error instanceof Error ? `${error.message}\n${error.stack ?? ''}` : String(error)
    emit(paint(`\n  ❌ 脚本异常：${message}`, C.red))
    await flushOutput()
    process.exitCode = 3
  })
