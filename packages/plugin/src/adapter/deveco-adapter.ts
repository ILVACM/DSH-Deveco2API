/**
 * DevEco LlmAdapter：dsh-llm 契约的六方法实现。
 *
 * 契约（结构性声明，不 import 宿主类型——对齐 opencode2dsh 的做法）：
 *   providerInfo / providerRetryPolicy / imageRequestPricing / listModels / resolveModel / prepareCall
 *   stream 不是独立方法，由 prepareCall 返回。
 *
 * 注册约束（P0 实测 + dsh-llm 源码确认）：
 *   - providerInfo(provider).id 必须严格等于注册名
 *   - providerRetryPolicy 必须存在（返回 undefined = 用宿主默认策略）
 *   - 流必须以 usage → finish 收尾
 *
 * @module src/adapter/deveco-adapter.ts
 */

import { toStreamChunks, type HarnessChunk } from './events.ts'
import { toUpstreamBody, type HarnessGenerateOptions } from './messages.ts'
import { streamChat } from './wire.ts'
import { ensureValidToken, type RefreshFailure } from '../auth/refresh.ts'
import type { ModelCatalog, CatalogModel } from '../catalog.ts'
import { effectiveSuggested as effectiveSuggestedFn, type CapacityFile } from '../capacity.ts'
import { solveModelPolicy } from '../compaction-policy.ts'
import { guardBeforeRequest, type HostServices, type CompactState } from '../context-guard.ts'

export const PROVIDER_ID = 'deveco2dsh'

/** 目录就绪前的兜底值。 */
const DEFAULT_CONTEXT_WINDOW = 170_000
const DEFAULT_MAX_TOKENS = 32_000

/** DSH 思考档位 → 上游 reasoning_effort（off 不合法，P0 实测）。 */
const EFFORT_LADDER = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'] as const

export interface DevEcoReasoningEffort {
  id: string
  name: string
  description?: string
}

export interface PluginContext {
  logger: { info(...args: unknown[]): void; warn(...args: unknown[]): void; error(...args: unknown[]): void }
  llm?: { registerAdapter(providers: string[], adapter: unknown): unknown }
}

/** DSH 的 resolveModel 返回形状。 */
interface ResolvedModel {
  provider: string
  id: string
  name: string
  inputModalities: string[]
  context: { contextWindow: number }
  defaultMaxTokens: number
  reasoning?: { efforts: DevEcoReasoningEffort[] }
}

export class DevEcoAdapter {
  #catalog: ModelCatalog
  #logger: PluginContext['logger'] | undefined
  #opts: {
    capacity?: () => CapacityFile
    services?: HostServices
    getSession?: () => unknown
    state?: CompactState
    cooldownMs?: number
    blockOnOversizedHistory?: boolean
  } | undefined

  constructor(
    catalog: ModelCatalog,
    logger?: PluginContext['logger'],
    opts?: {
      capacity?: () => CapacityFile
      services?: HostServices
      getSession?: () => unknown
      state?: CompactState
      cooldownMs?: number
      blockOnOversizedHistory?: boolean
    },
  ) {
    this.#catalog = catalog
    this.#logger = logger
    this.#opts = opts
  }

  /** 必须返回与注册名一致的 id。 */
  providerInfo(provider: string): { id: string; name: string } {
    return { id: provider, name: PROVIDER_ID }
  }

  /** undefined = 宿主默认重试策略（重试权交给 DSH，插件内不重试）。 */
  providerRetryPolicy(_provider: string): undefined {
    return undefined
  }

  /** 无图片计价（DevEco 模型 text-only）。 */
  imageRequestPricing(_provider: string, _model: string): undefined {
    return undefined
  }

  /** 目录当前暴露的模型（白名单来源——8c 发现上游不校验未知模型）。 */
  listModels(provider: string): Array<{ provider: string; id: string; name: string; inputModalities: string[] }> {
    return this.#catalog.list().map((model) => ({
      provider,
      id: model.id,
      name: model.name,
      inputModalities: ['text'],
    }))
  }

  resolveModel(provider: string, model: string): ResolvedModel {
    const info = this.#catalog.get(model)
    const resolved: ResolvedModel = {
      provider,
      id: model,
      name: info?.name ?? model,
      inputModalities: ['text'],
      context: { contextWindow: contextWindowFor(info, this.#opts?.capacity?.(), model) },
      defaultMaxTokens: Math.max(info?.maxTokens ?? DEFAULT_MAX_TOKENS, 128),
    }
    const efforts = reasoningEfforts(info)
    if (efforts) resolved.reasoning = { efforts }
    return resolved
  }

  async prepareCall(
    provider: string,
    model: string,
    _signal?: AbortSignal,
  ): Promise<{ model: ResolvedModel; stream: (options: HarnessGenerateOptions) => AsyncGenerator<HarnessChunk> }> {
    return {
      model: this.resolveModel(provider, model),
      stream: (options) => this.#stream(options),
    }
  }

  /**
   * 一次流式对话：取 token → 白名单校验 → 构造请求 → 转译事件。
   *
   * 失败路径全部产出 `finish.error`（不抛异常、不静默空回复）：
   * - 未登录 / JWT 过期 → AUTH
   * - 模型不在白名单 → INVALID_REQUEST（防 8c 静默回落）
   */
  async *#stream(options: HarnessGenerateOptions): AsyncGenerator<HarnessChunk> {
    const contextWindow = this.resolveModel(options.provider, options.model).context.contextWindow

    // 1. 白名单校验（8c：上游对未知模型静默回落，必须自己挡）
    if (!this.#catalog.get(options.model)) {
      const available = this.#catalog.list().map((m) => m.id).join(', ')
      yield* yieldTerminalError(
        `模型 "${options.model}" 不在 DevEco 目录白名单内（当前可用：${available || '目录加载中'}）`,
        'INVALID_REQUEST',
      )
      return
    }

    // 2. 取有效 token
    const token = await ensureValidToken()
    if (!token.ok) {
      yield* yieldTerminalError(describeRefreshFailure(token.failure), 'AUTH')
      return
    }

    // 2.5 上下文守护（每次发请求之前；取不到宿主服务/共享状态则跳过）
    // 触发线用「建议上下文」effectiveSuggested，与 resolveModel() 报给 DSH 的
    // 反推 W 分离：W 供 compaction-basic 算阈值，effectiveSuggested 才是插件自己的线。
    const services = this.#opts?.services
    const state = this.#opts?.state
    if (services && state) {
      const info = this.#catalog.get(options.model)
      const suggested = info?.suggested ?? info?.contextWindow ?? DEFAULT_CONTEXT_WINDOW
      const rec = this.#opts?.capacity?.()?.models?.[options.model]
      const effectiveSuggested = rec ? effectiveSuggestedFn(suggested, rec.actualMax) : suggested
      const guard = await guardBeforeRequest({
        services,
        session: this.#opts?.getSession?.() ?? null,
        effectiveSuggested,
        state,
        cooldownMs: this.#opts?.cooldownMs ?? 60_000,
        blockOnOversizedHistory: this.#opts?.blockOnOversizedHistory ?? true,
      })
      if (guard.decision.triggered) {
        this.#logger?.info?.(`deveco2dsh: 上下文守护触发压缩 (${guard.decision.reason}, used=${guard.decision.used}, usedAfter=${guard.usedAfter})`)
      }
      // 压后复核不达标 → 绝不带着必然超限的历史发请求
      if (guard.blocked) {
        yield* yieldTerminalError(guard.message, 'CONTEXT_WINDOW_EXCEEDED')
        return
      }
    }

    // 3. 构造请求
    const catalogMax = this.#catalog.get(options.model)?.maxTokens ?? DEFAULT_MAX_TOKENS
    const body = toUpstreamBody(options, catalogMax)

    // 4. 发请求 + 转译
    try {
      const result = await streamChat({
        access: token.access,
        body,
        signal: options.signal ?? undefined,
      })
      const chunks = toStreamChunks(result.events, contextWindow)
      for await (const chunk of chunks) {
        yield chunk
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      this.#logger?.warn?.(`deveco2dsh: stream failed: ${message}`)
      yield* yieldTerminalError(message, classifyTransportError(message))
    }
  }
}

/** 产出 usage + finish.error 两个终止 chunk（保证流以 usage→finish 收尾）。 */
async function* yieldTerminalError(message: string, code: string): AsyncGenerator<HarnessChunk> {
  yield { type: 'usage', usage: { inputTokens: 0, outputTokens: 0 } }
  yield { type: 'finish', reason: { kind: 'error', failure: { message, code } } }
}

function describeRefreshFailure(failure: RefreshFailure): string {
  if (failure.kind === 'not_logged_in') {
    return `${failure.message}（请先执行 deveco auth login 登录华为账号）`
  }
  if (failure.kind === 'jwt_expired') {
    return failure.message
  }
  return `凭据刷新失败：${failure.message}`
}

function classifyTransportError(message: string): string {
  if (/timeout|timed?\s*out/i.test(message)) return 'TIMEOUT'
  if (/network|connection|socket|fetch|ECONN|terminated|premature/i.test(message)) return 'TRANSPORT'
  return 'UPSTREAM'
}

/** 目录声明的思考档位 → DSH 的档位选择器。 */
function reasoningEfforts(info: CatalogModel | undefined): DevEcoReasoningEffort[] | undefined {
  if (!info?.reasoning) return undefined
  // 目录声明的档位（low/high/max）→ 加上 off（DSH 需要"关思考"选项）
  const declared = info.effortLevels.filter((level) => (EFFORT_LADDER as readonly string[]).includes(level))
  const levels = declared.length > 0 ? ['off', ...declared] : ['off', 'low', 'medium', 'high']
  return levels.map((level) => ({
    id: level,
    name: level.charAt(0).toUpperCase() + level.slice(1),
    ...(level === 'off' ? { description: '关闭思考（不向上游传 reasoning_effort，保持默认）' } : {}),
  }))
}

/**
 * resolveModel() 报给 DSH 的 contextWindow。
 *
 * 分离原则：这个值同时被 dsh-compaction-basic 用作宿主公式的 W，
 * 因此按「目标阈值 = floor(actualMax × 0.8)」反推得到（W = target + OMax），
 * 使宿主 min(W×ratio, W−O−headroom) 恒等于目标；与插件自己的触发线
 * （effectiveSuggested，见 #stream 守护块）是两个独立数字。
 */
function contextWindowFor(
  info: CatalogModel | undefined,
  file: CapacityFile | undefined,
  model: string,
): number {
  const suggested = info?.suggested ?? info?.contextWindow ?? DEFAULT_CONTEXT_WINDOW
  const OMax = info?.maxTokens ?? DEFAULT_MAX_TOKENS
  const rec = file?.models?.[model]
  if (!rec) return suggested
  return solveModelPolicy({
    actualMax: rec.actualMax,
    reservedCompletionTokens: OMax,
    targetRatio: 0.8,
  }).contextWindow
}

export { yieldTerminalError }
