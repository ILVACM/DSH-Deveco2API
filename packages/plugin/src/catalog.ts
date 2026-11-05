/**
 * 模型目录：GET /codeGenie/modelConfig → 解析 → blacklist 过滤 → 磁盘缓存 → 周期刷新。
 *
 * 数据源（对齐 deveco-models.ts:102-232，P0 已实测）：
 *   GET https://cn.devecostudio.huawei.com/codeGenie/modelConfig?localVersion=0&pluginVersion=CLI.<ver>
 *   header: Authorization: Bearer <access>
 *   → { code, body: { version, inner_models: [ { protocol, group_name, model_configs[], task_default_model_map } ] } }
 *
 * blacklist 在 task_default_model_map["blacklist"]（逗号分隔的 model_id）。
 * 被排除的模型不进 exposed 列表——这就是 P1 的模型白名单（8c 发现：
 * 上游对未知模型静默回落到 deepseek-v4-flash，绝不能把校验交给上游）。
 *
 * @module src/catalog.ts
 */

import { existsSync, readFileSync } from 'node:fs'
import { mkdir, rename, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { homedir } from 'node:os'

const URL_CATALOG = 'https://cn.devecostudio.huawei.com/codeGenie/modelConfig'

export const DATA_DIR = join(homedir(), '.dsh', 'deveco2dsh')

export interface CatalogModel {
  id: string
  name: string
  contextWindow: number
  maxTokens: number
  reasoning: boolean
  /** 目录声明的思考档位（如 ["low","high","max"]）。 */
  effortLevels: string[]
  defaultEffort?: string
}

export interface CatalogSnapshot {
  status: 'pending' | 'ready' | 'stale' | 'error'
  total: number
  exposed: number
  lastRefresh?: string
  lastError?: string
}

export interface CatalogOptions {
  /** 刷新周期（秒），默认 300。 */
  refreshSeconds?: number
  /** 启动时空目录的快速重试间隔（毫秒），默认 15 秒。 */
  startupRetryMs?: number
  /** 启动快速重试的最大次数，默认 4。 */
  maxStartupRetries?: number
  /** 每轮刷新后的回调（健康快照写盘用）。 */
  onRefresh?: (snapshot: CatalogSnapshot, lastError: string) => void
  /** fetch 注入（测试用）。 */
  fetchImpl?: typeof fetch
  /** access token 提供者（auth/refresh.ts 的 ensureValidToken 包装）。 */
  getAccess: () => Promise<string | null>
}

/**
 * 解析 modelConfig 响应（纯函数，单测覆盖）。
 *
 * 解析规则（对齐 deveco-models.ts）：
 * - task_default_model_map 取最后一个带该字段的 group
 * - blacklist 是逗号分隔的 model_id 列表
 * - reasoning_effort 是 JSON 字符串：{"level":[...],"default":"..."} 或旧版纯数组
 * - thinking_mode === "on" → reasoning
 * - context_window / output 数字化
 */
export function parseCatalog(raw: unknown): { models: CatalogModel[]; exposed: CatalogModel[]; version: number } {
  if (!raw || typeof raw !== 'object') return { models: [], exposed: [], version: 0 }
  const body = (raw as Record<string, unknown>)['body']
  if (!body || typeof body !== 'object') return { models: [], exposed: [], version: 0 }

  const version = typeof (body as Record<string, unknown>)['version'] === 'number' ? ((body as Record<string, unknown>)['version'] as number) : 0
  const innerModels = (body as Record<string, unknown>)['inner_models']
  if (!Array.isArray(innerModels)) return { models: [], exposed: [], version }

  const models: CatalogModel[] = []
  let blacklistIds: string[] = []
  let seenIds = new Set<string>()

  for (const group of innerModels) {
    if (!group || typeof group !== 'object') continue
    const record = group as Record<string, unknown>

    const configs = record['model_configs']
    if (Array.isArray(configs)) {
      for (const config of configs) {
        if (!config || typeof config !== 'object') continue
        const cfg = config as Record<string, unknown>
        const modelId = typeof cfg['model_id'] === 'string' ? (cfg['model_id'] as string) : ''
        if (!modelId || seenIds.has(modelId)) continue
        seenIds.add(modelId)

        const reasoning = cfg['thinking_mode'] === 'on'
        const efforts = parseReasoningEffort(cfg['reasoning_effort'])
        models.push({
          id: modelId,
          name: modelId,
          contextWindow: typeof cfg['context_window'] === 'number' ? (cfg['context_window'] as number) : 32768,
          maxTokens: parseOutputLimit(cfg['output']),
          reasoning,
          effortLevels: efforts.levels,
          ...(efforts.defaultEffort !== undefined ? { defaultEffort: efforts.defaultEffort } : {}),
        })
      }
    }

    const taskMap = record['task_default_model_map']
    if (taskMap && typeof taskMap === 'object') {
      const blacklist = (taskMap as Record<string, unknown>)['blacklist']
      if (typeof blacklist === 'string' && blacklist) {
        blacklistIds = blacklist.split(',').map((s) => s.trim()).filter(Boolean)
      }
    }
  }

  const exposed = models.filter((m) => !blacklistIds.includes(m.id))
  return { models, exposed, version }
}

function parseOutputLimit(output: unknown): number {
  if (typeof output === 'number') return output
  if (typeof output === 'string') {
    const n = parseInt(output, 10)
    if (!isNaN(n) && n > 0) return n
  }
  return 8192
}

function parseReasoningEffort(raw: unknown): { levels: string[]; defaultEffort?: string } {
  if (typeof raw !== 'string' || !raw) return { levels: [] }
  try {
    const parsed: unknown = JSON.parse(raw)
    if (Array.isArray(parsed)) {
      const levels = parsed.filter((v): v is string => typeof v === 'string')
      return { levels }
    }
    if (parsed && typeof parsed === 'object') {
      const obj = parsed as { level?: unknown; default?: unknown }
      const levels = Array.isArray(obj.level) ? obj.level.filter((v): v is string => typeof v === 'string') : []
      const defaultEffort = typeof obj.default === 'string' && levels.includes(obj.default) ? obj.default : undefined
      return { levels, ...(defaultEffort !== undefined ? { defaultEffort } : {}) }
    }
    return { levels: [] }
  } catch {
    return { levels: [] }
  }
}

/**
 * 模型目录服务：定时拉取 + 磁盘缓存 + 启动快速重试。
 * 所有网络状态在内存；只有磁盘缓存持久化。
 */
export class ModelCatalog {
  #models: CatalogModel[] = []
  #exposed: CatalogModel[] = []
  #version = 0
  #lastError = ''
  #timer: ReturnType<typeof setInterval> | null = null
  #stopped = false
  #refreshSeconds: number
  #startupRetryMs: number
  #maxStartupRetries: number
  #onRefresh?: CatalogOptions['onRefresh']
  #fetchImpl: typeof fetch
  #getAccess: () => Promise<string | null>
  #cachePath: string

  constructor(options: CatalogOptions) {
    this.#refreshSeconds = options.refreshSeconds ?? 300
    this.#startupRetryMs = options.startupRetryMs ?? 15_000
    this.#maxStartupRetries = options.maxStartupRetries ?? 4
    this.#onRefresh = options.onRefresh
    this.#fetchImpl = options.fetchImpl ?? fetch
    this.#getAccess = options.getAccess
    this.#cachePath = join(DATA_DIR, 'models.json')
  }

  /** 当前暴露的模型列表（白名单来源）。 */
  list(): CatalogModel[] {
    return this.#exposed
  }

  /** 按 id 查找模型元数据。 */
  get(id: string): CatalogModel | undefined {
    return this.#exposed.find((m) => m.id === id)
  }

  /** 目录版本号（上游每次变更递增）。 */
  version(): number {
    return this.#version
  }

  /** 健康快照。 */
  snapshot(): CatalogSnapshot {
    const hasData = this.#exposed.length > 0
    return {
      status: this.#lastError ? (hasData ? 'stale' : 'error') : hasData ? 'ready' : 'pending',
      total: this.#models.length,
      exposed: this.#exposed.length,
      ...(this.#lastError ? { lastError: this.#lastError } : {}),
    }
  }

  /**
   * 启动刷新循环：立即刷一轮；若空目录快速重试（应对开机网络未就绪）；
   * 之后按 refreshSeconds 周期刷新。
   */
  async start(): Promise<void> {
    await this.refreshOnce()
    let attempts = 0
    while (this.#exposed.length === 0 && attempts < this.#maxStartupRetries && !this.#stopped) {
      attempts += 1
      await new Promise((resolve) => setTimeout(resolve, this.#startupRetryMs))
      if (this.#stopped) return
      await this.refreshOnce()
    }
    if (this.#stopped) return
    this.#timer = setInterval(() => {
      void this.refreshOnce()
    }, this.#refreshSeconds * 1000)
    this.#timer.unref?.()
  }

  /** 停止刷新循环。 */
  stop(): void {
    this.#stopped = true
    if (this.#timer) {
      clearInterval(this.#timer)
      this.#timer = null
    }
  }

  /** 单轮刷新：拉目录 → 解析 → 更新内存 → 写磁盘缓存。 */
  async refreshOnce(): Promise<void> {
    const access = await this.#getAccess()
    if (!access) {
      this.#lastError = '无法获取 access token（请检查 deveco 登录状态）'
      this.#notify()
      return
    }
    try {
      // localVersion 恒为 0：始终拿全量目录。实测用当前 version 作为
      // localVersion 会让服务端返回空增量（认为是同一版本的重复请求）。
      const url = `${URL_CATALOG}?localVersion=0&pluginVersion=CLI.0.0.0`
      const response = await this.#fetchImpl(url, {
        headers: { authorization: `Bearer ${access}` },
        signal: AbortSignal.timeout(10_000),
      })
      if (!response.ok) {
        this.#lastError = `modelConfig HTTP ${response.status}`
        this.#notify()
        return
      }
      const raw: unknown = await response.json()
      const parsed = parseCatalog(raw)
      if (parsed.models.length === 0) {
        this.#lastError = 'modelConfig 返回空目录'
        this.#notify()
        return
      }
      this.#models = parsed.models
      this.#exposed = parsed.exposed
      this.#version = parsed.version
      this.#lastError = ''
      await this.#writeCache()
      this.#notify()
    } catch (error) {
      this.#lastError = error instanceof Error ? error.message : String(error)
      this.#notify()
    }
  }

  /** 从磁盘缓存恢复（断网启动兜底）。 */
  async loadCache(): Promise<boolean> {
    if (!existsSync(this.#cachePath)) return false
    try {
      const raw: unknown = JSON.parse(readFileSync(this.#cachePath, 'utf8'))
      if (!raw || typeof raw !== 'object') return false
      const record = raw as { models?: unknown; version?: unknown; blacklisted?: unknown }
      if (!Array.isArray(record['models'])) return false
      const models = record['models'].filter((m): m is CatalogModel => !!m && typeof m === 'object' && typeof (m as CatalogModel).id === 'string')
      if (models.length === 0) return false
      const blacklist = Array.isArray(record['blacklisted']) ? record['blacklisted'].filter((v): v is string => typeof v === 'string') : []
      this.#models = models
      this.#exposed = models.filter((m) => !blacklist.includes(m.id))
      this.#version = typeof record['version'] === 'number' ? (record['version'] as number) : 0
      return true
    } catch {
      return false
    }
  }

  async #writeCache(): Promise<void> {
    try {
      await mkdir(DATA_DIR, { recursive: true })
      const tmp = `${this.#cachePath}.${process.pid}.tmp`
      await writeFile(tmp, JSON.stringify({ version: this.#version, models: this.#exposed, blacklisted: this.#models.filter(m => !this.#exposed.includes(m)).map(m => m.id) }, null, 2), 'utf8')
      await rename(tmp, this.#cachePath)
    } catch {
      // 缓存写盘失败不影响主流程
    }
  }

  #notify(): void {
    this.#onRefresh?.(this.snapshot(), this.#lastError)
  }
}
