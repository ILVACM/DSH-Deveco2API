/**
 * deveco2dsh 插件入口。
 *
 * 职责（按执行顺序）：
 * 1. 解析配置
 * 2. 构造 ModelCatalog（目录 = 模型白名单来源）
 * 3. 注册 LlmAdapter（**最先**——后续任何层失败都不能弄丢唯一的 provider）
 * 4. 启动目录刷新循环（后台）
 * 5. 注册释放钩子（停定时器）
 *
 * @module src/index.ts
 */

import { join } from 'node:path'
import { homedir } from 'node:os'
import { writeFile } from 'node:fs/promises'
import { ModelCatalog, type CatalogSnapshot } from './catalog.ts'
import { DevEcoAdapter, PROVIDER_ID } from './adapter/deveco-adapter.ts'
import { ensureValidToken, hasAuthFile } from './auth/refresh.ts'
import { resolveConfig, type DevEco2DshConfig } from './config.ts'

/**
 * 插件宿主 ctx 的结构性声明。
 * 不 import @deepseek-ai/* 类型——避免与宿主版本耦合（对齐 opencode2dsh 的做法）。
 */
export interface PluginContext {
  logger: { info(...args: unknown[]): void; warn(...args: unknown[]): void; error(...args: unknown[]): void }
  llm?: { registerAdapter(providers: string[], adapter: unknown): unknown }
  effect?(fn: () => () => void): unknown
  inject?(services: string[], callback: (ctx: PluginContext) => void | Promise<void>): unknown
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

  const adapter = new DevEcoAdapter(catalog, logger)

  // 注册最先——后续任何层（目录启动、凭据问题）失败都不能弄丢 provider 路由
  ctx.llm.registerAdapter([PROVIDER_ID], adapter)
  logger.info(`deveco2dsh: adapter 已注册为 "${PROVIDER_ID}"（目录在后台预热）`)

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
    })
  }
}
