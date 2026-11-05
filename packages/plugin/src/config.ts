/**
 * 插件配置 schema（schemastery）。
 *
 * DSH 0.1.7+ 读取这个导出来生成"设置 → 插件"页面的可编辑字段。
 * 命名空间 = cordis.patch.yml 里的 Loader entry id（deveco2dsh）。
 *
 * @module src/config.ts
 */

import Schema from '@deepseek-ai/schemastery'

export interface DevEco2DshConfig {
  /** 模型目录刷新周期（秒）。 */
  refreshSeconds?: number
  /** 首帧等待上限（毫秒）。 */
  firstEventMs?: number
  /** 流中静默上限（毫秒）。 */
  bodyIdleMs?: number
}

export const defaults = {
  refreshSeconds: 300,
  firstEventMs: 30_000,
  bodyIdleMs: 120_000,
}

export type ResolvedConfig = Required<Pick<DevEco2DshConfig, 'refreshSeconds'>> & DevEco2DshConfig

export function resolveConfig(config: DevEco2DshConfig = {}): ResolvedConfig {
  return { ...defaults, ...config }
}

export const Config = Schema.object({
  refreshSeconds: Schema.number()
    .default(defaults.refreshSeconds)
    .min(10)
    .max(3600)
    .description('模型目录刷新周期（秒），默认 300'),
  firstEventMs: Schema.number()
    .default(defaults.firstEventMs)
    .min(1_000)
    .max(600_000)
    .description('首帧等待上限（毫秒），默认 30000；慢速冷启动可调大'),
  bodyIdleMs: Schema.number()
    .default(defaults.bodyIdleMs)
    .min(1_000)
    .max(600_000)
    .description('流中静默上限（毫秒），默认 120000'),
})
