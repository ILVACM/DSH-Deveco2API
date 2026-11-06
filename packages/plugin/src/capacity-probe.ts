/**
 * 探测②：插件自测模型真实上下文上限（独立请求、串行退避、失败降级）。
 * 绝不采信目录标定；绝不复用用户会话。
 * @module src/capacity-probe.ts
 */
import type { CapacityFile } from './capacity.ts'

export interface ProbeDeps {
  getAccess: () => Promise<string | null>
  fetchImpl?: typeof fetch
  now?: () => number
}
export interface ProbeResult {
  actualMax: number
  source: 'probe' | 'fallback'
  measuredAt: string
}

const URL_CHAT = 'https://cn.devecostudio.huawei.com/sse/codeGenie/maas/v2/chat/completions'
const MAX_CONTEXT_RE = /maximum context length is (\d+) tokens/
const PROBE_GAP_MS = 12_000

/** 从上游错误报文提取硬上限；无匹配返回 null。 */
export function parseMaxContext(message: string): number | null {
  const m = MAX_CONTEXT_RE.exec(message)
  if (!m) return null
  const n = Number(m[1])
  return Number.isFinite(n) && n > 0 ? n : null
}

/** 对单个模型发必然超限的超长请求，读取真实上限；失败降级回 suggested。 */
export async function probeActualMax(model: string, deps: ProbeDeps): Promise<ProbeResult> {
  const now = deps.now ?? Date.now
  const measuredAt = new Date(now()).toISOString()
  const access = await deps.getAccess()
  const fetchImpl = deps.fetchImpl ?? fetch
  if (!access) return { actualMax: 0, source: 'fallback', measuredAt }
  try {
    // 构造必然超限的输入：高密度随机词，约 230K+ token
    const words = Array.from({ length: 58000 }, (_, i) => 'w' + (i * 7919 % 100003))
    const body = {
      model,
      messages: [{ role: 'user', content: words.join(' ') + '\n只回复：OK' }],
      stream: true,
      max_tokens: 8,
    }
    const res = await fetchImpl(URL_CHAT, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${access}`,
        'Chat-Id': cryptoRandom(),
        'Session-Id': cryptoRandom(),
        lang: 'en',
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(60_000),
    })
    const text = await res.text()
    const max = parseMaxContext(text)
    if (max !== null) return { actualMax: max, source: 'probe', measuredAt }
    return { actualMax: 0, source: 'fallback', measuredAt }
  } catch {
    return { actualMax: 0, source: 'fallback', measuredAt }
  }
}

/** 串行 + 间隔 + 退避刷新全部模型；失败沿用 suggested 作 fallback 值。 */
export async function refreshAllCapacities(
  modelIds: string[], suggested: Record<string, number>, deps: ProbeDeps
): Promise<CapacityFile> {
  const models: CapacityFile['models'] = {}
  for (let i = 0; i < modelIds.length; i++) {
    const id = modelIds[i]!
    const r = await probeActualMax(id, deps)
    const s = suggested[id] ?? 0
    models[id] = {
      suggested: s,
      actualMax: r.source === 'probe' ? r.actualMax : s,
      measuredAt: r.measuredAt,
      source: r.source,
    }
    if (i < modelIds.length - 1) await sleep(PROBE_GAP_MS)
  }
  return {
    schema: 'capacity/v1',
    updatedAt: new Date((deps.now ?? Date.now)()).toISOString(),
    models,
  }
}

export function createProbeScheduler(opts: { intervalSeconds: number; run: () => Promise<void> }): {
  start(): void
  stop(): void
  trigger(): Promise<void>
} {
  let timer: ReturnType<typeof setInterval> | null = null
  let running = false
  const runOnce = async (): Promise<void> => {
    if (running) return
    running = true
    try { await opts.run() } finally { running = false }
  }
  return {
    start() {
      void runOnce()
      timer = setInterval(() => void runOnce(), opts.intervalSeconds * 1000)
      timer.unref?.()
    },
    stop() { if (timer) { clearInterval(timer); timer = null } },
    async trigger() { await runOnce() },
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}
function cryptoRandom(): string {
  // 32 位 hex，与 wire.ts 形状一致；不引 node:crypto 以免与客户端 bundle 冲突
  let out = ''
  for (let i = 0; i < 32; i++) out += Math.floor(Math.random() * 16).toString(16)
  return out
}

/** 手动探测选项。 */
export interface ProbeNowOptions {
  stepGapMs?: number
  totalTimeoutMs?: number
  maxRetriesPerStep?: number
}
export interface ProbeNowDeps {
  getAccess: () => Promise<string | null>
  fetchImpl?: typeof fetch
  now?: () => number
  sleep?: (ms: number) => Promise<void>
  onResult?: (modelId: string, result: { actualMax: number; source: 'probe' | 'fallback' | 'error'; measuredAt: string; error?: string }) => void
}
export interface ProbeNowResult {
  id: string
  actualMax: number
  source: 'probe' | 'fallback' | 'error'
  measuredAt: string
  error?: string
}

const RATE_LIMIT_RE = /UserSessionLimitExceeded|New session request rate exceeded|\b429\b|rate.?limit/i

/** 构造约 targetTokens 规模的随机词内容（与 probeActualMax 同一生成方式）。 */
function buildProbeContent(targetTokens: number): string {
  const count = Math.max(1, Math.floor(targetTokens / 3.5))
  const words = Array.from({ length: count }, (_, i) => 'w' + (i * 7919 % 100003))
  return words.join(' ') + '\n只回复：OK'
}

/**
 * 手动探测：温和逼近 + 限流退避 + 逐步回调。
 * 从 floor(suggested×1.15) 起，每步 +max(10000, 8%)，命中上限即停；串行、绝不并发。
 */
export async function probeNow(
  modelIds: string[],
  suggested: Record<string, number>,
  deps: ProbeNowDeps,
  opts: ProbeNowOptions = {},
): Promise<ProbeNowResult[]> {
  const stepGapMs = opts.stepGapMs ?? 20_000
  const totalTimeoutMs = opts.totalTimeoutMs ?? 90_000
  const maxRetriesPerStep = opts.maxRetriesPerStep ?? 3
  const now = deps.now ?? Date.now
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)))
  const fetchImpl = deps.fetchImpl ?? fetch
  const access = await deps.getAccess()
  const out: ProbeNowResult[] = []

  for (const id of modelIds) {
    const startedAt = now()
    let target = Math.floor((suggested[id] ?? 170000) * 1.15)
    let done: ProbeNowResult | null = null
    while (done === null) {
      if (now() - startedAt > totalTimeoutMs) {
        done = { id, actualMax: 0, source: 'error', measuredAt: new Date(now()).toISOString(), error: 'probe timeout' }
        break
      }
      if (!access) {
        done = { id, actualMax: 0, source: 'error', measuredAt: new Date(now()).toISOString(), error: 'not logged in' }
        break
      }
      let retries = 0
      let text = ''
      let threw: string | null = null
      while (retries <= maxRetriesPerStep) {
        try {
          const res = await fetchImpl(URL_CHAT, {
            method: 'POST',
            headers: {
              'content-type': 'application/json',
              authorization: `Bearer ${access}`,
              'Chat-Id': cryptoRandom(),
              'Session-Id': cryptoRandom(),
              lang: 'en',
            },
            body: JSON.stringify({
              model: id,
              messages: [{ role: 'user', content: buildProbeContent(target) }],
              stream: true,
              max_tokens: 8,
            }),
            signal: AbortSignal.timeout(60_000),
          })
          text = await res.text()
          if (RATE_LIMIT_RE.test(text) && retries < maxRetriesPerStep) {
            retries += 1
            await sleep(retries === 1 ? 30_000 : 60_000)
            continue
          }
          break
        } catch (error) {
          threw = error instanceof Error ? error.message : String(error)
          if (retries < maxRetriesPerStep) { retries += 1; await sleep(30_000); continue }
          break
        }
      }
      if (threw !== null) {
        done = { id, actualMax: 0, source: 'error', measuredAt: new Date(now()).toISOString(), error: threw }
        break
      }
      const hit = parseMaxContext(text)
      if (hit !== null) {
        done = { id, actualMax: hit, source: 'probe', measuredAt: new Date(now()).toISOString() }
        break
      }
      if (RATE_LIMIT_RE.test(text)) {
        done = { id, actualMax: 0, source: 'error', measuredAt: new Date(now()).toISOString(), error: 'rate limited' }
        break
      }
      // 未命中且无错误：加长一步继续逼近
      target = target + Math.max(10_000, Math.floor(target * 0.08))
      await sleep(stepGapMs)
    }
    out.push(done)
    deps.onResult?.(id, done)
    if (modelIds.indexOf(id) < modelIds.length - 1) await sleep(stepGapMs)
  }
  return out
}
