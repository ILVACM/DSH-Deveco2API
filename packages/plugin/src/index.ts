/**
 * deveco2dsh 插件入口。
 *
 * 职责（按执行顺序）：
 * 1. 解析配置
 * 2. 构造 ModelCatalog（目录 = 模型白名单来源）
 * 3. 注册 LlmAdapter（**最先**——后续任何层失败都不能弄丢唯一的 provider）
 * 4. 装配上下文管理（capacity / 探测② / modelPolicies / status bridge）
 * 5. 启动目录刷新循环（后台）
 * 6. 注册释放钩子（停定时器）
 *
 * @module src/index.ts
 */

import { join } from 'node:path'
import { homedir } from 'node:os'
import { writeFile, mkdir } from 'node:fs/promises'
import { existsSync, readFileSync } from 'node:fs'
import { ModelCatalog, type CatalogSnapshot } from './catalog.ts'
import { DevEcoAdapter, PROVIDER_ID } from './adapter/deveco-adapter.ts'
import { ensureValidToken, hasAuthFile } from './auth/refresh.ts'
import { resolveConfig, type DevEco2DshConfig } from './config.ts'
import { readCapacityFile, serializeCapacity, CAPACITY_PATH, type CapacityFile } from './capacity.ts'
import { refreshAllCapacities, createProbeScheduler, probeNow } from './capacity-probe.ts'
import { registerStatusBridge, buildSnapshot, type StatusSnapshot } from './status-bridge.ts'
import { manualCompact, createCompactState, type CompactState } from './context-guard.ts'
import { buildModelPolicies } from './compaction-policy.ts'

/**
 * 插件宿主 ctx 的结构性声明。
 * 不 import @deepseek-ai/* 类型——避免与宿主版本耦合（对齐 opencode2dsh 的做法）。
 */
export interface PluginContext {
  logger: { info(...args: unknown[]): void; warn(...args: unknown[]): void; error(...args: unknown[]): void }
  llm?: { registerAdapter(providers: string[], adapter: unknown): unknown }
  effect?(fn: () => () => void): unknown
  inject?(services: string[], callback: (ctx: PluginContext) => void | Promise<void>): unknown
  webServer?: { register(spec: { kind: 'exact'; path: string; handler: (req: unknown, res: unknown) => unknown }): unknown }
}

/** 宿主上下文服务（结构性声明，经 ctx.inject 惰性获取，取不到则降级）。 */
export interface ContextServices {
  tokenMeter?: { measure(session: unknown): { totalTokens: number } | Promise<{ totalTokens: number }> }
  compaction?: { compactNow(...args: unknown[]): unknown }
  sessionProjections?: unknown
  /** sessions 服务：用于取「当前活跃 session」，替代写死的 () => null。 */
  sessions?: { current?(): unknown; active?(): unknown; get?(id: string): unknown }
}

export const name = 'deveco2dsh'

/**
 * DSH 0.1.7+ 读取此导出生成设置页（命名空间 = Loader entry id deveco2dsh）。
 */
export { Config } from './config.ts'

/**
 * 只声明 llm 一个硬依赖。
 * 注：settings 服务在 headless 组合里被禁用，声明它会让整个 fiber 永不激活。
 */
export const inject = ['llm'] as const

const DATA_DIR = join(homedir(), '.dsh', 'deveco2dsh')
const STATUS_PATH = join(DATA_DIR, 'status.json')

export function apply(ctx: PluginContext, config: DevEco2DshConfig = {}): void {
  const logger = ctx.logger
  const resolved = resolveConfig(config)

  if (!ctx.llm || typeof ctx.llm.registerAdapter !== 'function') {
    logger.error('deveco2dsh: llm 服务不可用，无法注册 adapter')
    return
  }

  // 健康快照：每轮刷新后写盘（排查用）
  const writeStatus = (snapshot: CatalogSnapshot, lastError: string): void => {
    void writeFile(
      STATUS_PATH,
      JSON.stringify({ ...snapshot, lastError, deveco2dshWrittenAt: new Date().toISOString() }, null, 2),
      'utf8',
    ).catch(() => {})
  }

  const catalog = new ModelCatalog({
    refreshSeconds: resolved.refreshSeconds,
    getAccess: async () => {
      const result = await ensureValidToken()
      return result.ok ? result.access : null
    },
    onRefresh: writeStatus,
  })

  // 上下文管理状态（后续装配块填充；adapter 通过 getter 闭包读取，故声明在前）
  let services: ContextServices = {}
  let capacityFile: CapacityFile = { schema: 'capacity/v1', updatedAt: '', models: {} }
  let scheduler: ReturnType<typeof createProbeScheduler> | null = null
  const compactState: CompactState = createCompactState()

  // 取当前活跃 session：只按 §3-T4 替换 1b 声明的三个候选方法探测，取不到返回 null
  const resolveActiveSession = (): unknown => {
    const s = services.sessions
    if (!s) return null
    try { if (typeof s.current === 'function') return s.current() } catch { /* 继续下一个 */ }
    try { if (typeof s.active === 'function') return s.active() } catch { /* 继续下一个 */ }
    return null
  }

  const adapter = new DevEcoAdapter(catalog, logger, {
    capacity: () => capacityFile,
    services,
    getSession: resolveActiveSession,
    state: compactState,
    cooldownMs: resolved.compactCooldownMs ?? 60_000,
    blockOnOversizedHistory: resolved.blockOnOversizedHistory ?? true,
  })

  // 注册最先——后续任何层（目录启动、凭据问题）失败都不能弄丢 provider 路由
  ctx.llm.registerAdapter([PROVIDER_ID], adapter)
  logger.info(`deveco2dsh: adapter 已注册为 "${PROVIDER_ID}"（目录在后台预热）`)

  // 装配上下文管理（同步、全部 try/catch 降级，失败不阻断 provider 注册）
  try {
    if (existsSync(CAPACITY_PATH)) {
      try { capacityFile = readCapacityFile(JSON.parse(readFileSync(CAPACITY_PATH, 'utf8'))) } catch { /* 沿用空记录 */ }
    }
    // 原地填充 services（adapter 持有同一对象引用，禁止重新赋值）
    ctx.inject?.(['tokenMeter', 'compaction', 'sessionProjections', 'sessions'], (sctx) => {
      const s = sctx as ContextServices
      services.tokenMeter = s.tokenMeter
      services.compaction = s.compaction
      services.sessionProjections = s.sessionProjections
      services.sessions = s.sessions
    })
    const persist = (): void => {
      void mkdir(DATA_DIR, { recursive: true })
        .then(() => writeFile(CAPACITY_PATH, serializeCapacity(capacityFile), 'utf8'))
        .catch(() => {})
    }
    // 按宿主公式自适应求解 DSH 自身压缩阈值 = floor(actualMax × 0.8)，只覆盖本插件路由
    const applyModelPolicies = (): void => {
      try {
        const policies = buildModelPolicies(
          catalog.list().map((m) => ({
            id: m.id,
            actualMax: capacityFile.models[m.id]?.actualMax ?? m.contextWindow,
            reservedCompletionTokens: m.maxTokens,
          })),
          resolved.dshThresholdRatio ?? 0.8,
        )
        // 声明式配置：写入插件数据目录，供部署时合入 cordis.patch.yml 的
        // dsh-compaction-basic.config.modelPolicies（不在此处运行时改宿主 config）
        void mkdir(DATA_DIR, { recursive: true })
          .then(() => writeFile(join(DATA_DIR, 'compaction-policies.json'), JSON.stringify(policies, null, 2), 'utf8'))
          .catch(() => {})
      } catch (error) {
        logger.warn(`deveco2dsh: modelPolicies 求解失败：${error instanceof Error ? error.message : String(error)}`)
      }
    }
    applyModelPolicies()
    scheduler = createProbeScheduler({
      intervalSeconds: resolved.capacityProbeIntervalSeconds ?? 86400,
      run: async () => {
        try {
          capacityFile = await refreshAllCapacities(
            catalog.list().map((m) => m.id),
            catalog.suggestedMap,
            { getAccess: async () => { const r = await ensureValidToken(); return r.ok ? r.access : null } },
          )
          persist()
          applyModelPolicies()
        } catch (error) {
          logger.warn(`deveco2dsh: 探测② 失败：${error instanceof Error ? error.message : String(error)}`)
        }
      },
    })
    if (resolved.capacityAutoProbe) scheduler.start()
    const snapshot = (): StatusSnapshot => {
      let used: number | null = null
      try { const m = services.tokenMeter?.measure(resolveActiveSession()); if (m && typeof m === 'object' && 'totalTokens' in m) used = (m as { totalTokens: number }).totalTokens } catch { used = null }
      return buildSnapshot({
        catalogModels: catalog.list().map((m) => ({ id: m.id, name: m.name, contextWindow: m.contextWindow })),
        capacity: capacityFile,
        used,
        probing: false,
        compacting: compactState.compacting,
        lastCompactedAt: compactState.lastCompactedAt,
        measuredAt: capacityFile.updatedAt,
      })
    }
    // 用 ctx.inject(['webServer']) 注册：Desktop 启动顺序不会让路由消失（对齐 workbuddy）
    ctx.inject?.(['webServer'], (sctx) => {
      const ws = (sctx as { webServer?: typeof ctx.webServer }).webServer
      registerStatusBridge({ webServer: ws }, {
        getSnapshot: () => snapshot(),
        onProbe: async () => {
          // 手动探测：同步等待 probeNow 完成，逐步落盘，返回最终快照
          if (catalog.list().length === 0) {
            logger.warn('deveco2dsh: 目录尚未就绪，手动探测已跳过')
            return snapshot()
          }
          try {
            const results = await probeNow(
              catalog.list().map((m) => m.id),
              catalog.suggestedMap,
              {
                getAccess: async () => { const r = await ensureValidToken(); return r.ok ? r.access : null },
                onResult: (id, r) => {
                  capacityFile = {
                    schema: 'capacity/v1',
                    updatedAt: new Date().toISOString(),
                    models: {
                      ...capacityFile.models,
                      [id]: {
                        suggested: catalog.suggestedMap[id] ?? 0,
                        actualMax: r.actualMax,
                        measuredAt: r.measuredAt,
                        source: r.source === 'error' ? 'fallback' : r.source,
                      },
                    },
                  }
                  persist()
                },
              },
            )
            void results
            persist()
            applyModelPolicies()
          } catch (error) {
            logger.warn(`deveco2dsh: 手动探测失败：${error instanceof Error ? error.message : String(error)}`)
          }
          return snapshot()
        },
        onCompact: async () => manualCompact(services, compactState),
        onRefreshModels: async () => { await catalog.refreshNow(); return snapshot() },
      })
    })
  } catch (error) {
    logger.warn(`deveco2dsh: 上下文管理装配失败，已降级：${error instanceof Error ? error.message : String(error)}`)
  }

  // 未登录提示（不阻塞注册——登录后自动恢复）
  if (!hasAuthFile()) {
    logger.warn('deveco2dsh: 未检测到 deveco 登录凭据，请先执行 `deveco auth login`（当前对话会报 AUTH 错误）')
  }

  // 目录启动：先从磁盘缓存恢复（断网兜底），再启动刷新循环
  void catalog
    .loadCache()
    .then((restored) => {
      if (restored) logger.info('deveco2dsh: 已从磁盘缓存恢复模型目录')
      return catalog.start()
    })
    .catch((error) => {
      logger.error(`deveco2dsh: 目录启动失败：${error instanceof Error ? error.message : String(error)}`)
    })

  // 释放钩子：停目录定时器
  const maybeEffect = ctx.effect
  if (typeof maybeEffect === 'function') {
    maybeEffect.call(ctx, () => () => {
      catalog.stop()
      scheduler?.stop()
    })
  }
}
