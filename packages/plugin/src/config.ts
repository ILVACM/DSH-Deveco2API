/**
 * 插件配置 schema（schemastery）。
 * DSH 0.1.7+ 读取此导出生成"设置 → 插件"页面的可编辑字段。
 * 命名空间 = cordis.patch.yml 的 Loader entry id（deveco2dsh）。
 * @module src/config.ts
 */
import Schema from '@deepseek-ai/schemastery'

export interface DevEco2DshConfig {
  refreshSeconds?: number
  firstEventMs?: number
  bodyIdleMs?: number
  capacityProbeIntervalSeconds?: number
  similarityRatio?: number
  safetyRatio?: number
  dshThresholdRatio?: number
  compactCooldownMs?: number
  blockOnOversizedHistory?: boolean
  uiShowModelList?: boolean
  uiShowOccupancy?: boolean
  uiEnableManualProbe?: boolean
  uiEnableManualCompact?: boolean
  capacityAutoProbe?: boolean
}

export const defaults = {
  refreshSeconds: 300,
  firstEventMs: 30_000,
  bodyIdleMs: 120_000,
  capacityProbeIntervalSeconds: 86400,
  similarityRatio: 0.9,
  safetyRatio: 0.8,
  dshThresholdRatio: 0.8,
  compactCooldownMs: 60_000,
  blockOnOversizedHistory: true,
  uiShowModelList: true,
  uiShowOccupancy: true,
  uiEnableManualProbe: true,
  uiEnableManualCompact: true,
  capacityAutoProbe: false,
}

export type ResolvedConfig = Required<Pick<DevEco2DshConfig, 'refreshSeconds'>> & DevEco2DshConfig

export function resolveConfig(config: DevEco2DshConfig = {}): ResolvedConfig {
  return { ...defaults, ...config }
}

export const Config = Schema.object({
  refreshSeconds: Schema.number().default(defaults.refreshSeconds).min(10).max(3600).description('模型目录刷新周期（秒），默认 300'),
  firstEventMs: Schema.number().default(defaults.firstEventMs).min(1_000).max(600_000).description('首帧等待上限（毫秒），默认 30000'),
  bodyIdleMs: Schema.number().default(defaults.bodyIdleMs).min(1_000).max(600_000).description('流中静默上限（毫秒），默认 120000'),
  capacityProbeIntervalSeconds: Schema.number().default(defaults.capacityProbeIntervalSeconds).min(86400).max(604800).description('自动探测间隔（秒，仅 capacityAutoProbe=true 时生效），默认 86400'),
  similarityRatio: Schema.number().default(defaults.similarityRatio).min(0).max(1).description('相近判定阈值，默认 0.9'),
  safetyRatio: Schema.number().default(defaults.safetyRatio).min(0).max(1).description('相近时建议值设为实际值的比例，默认 0.8'),
  dshThresholdRatio: Schema.number().default(defaults.dshThresholdRatio).min(0).max(1).description('DSH 自身压缩阈值占实际最大值的比例，默认 0.8'),
  compactCooldownMs: Schema.number().default(defaults.compactCooldownMs).min(0).max(600000).description('「刚压过」标记冷却窗口（毫秒），默认 60000'),
  blockOnOversizedHistory: Schema.boolean().default(defaults.blockOnOversizedHistory).description('压后复核仍超建议上下文时阻断请求，默认 true'),
  uiShowModelList: Schema.boolean().default(defaults.uiShowModelList).description('设置页是否展示可用模型列表，默认 true'),
  uiShowOccupancy: Schema.boolean().default(defaults.uiShowOccupancy).description('设置页是否展示当前上下文占用，默认 true'),
  uiEnableManualProbe: Schema.boolean().default(defaults.uiEnableManualProbe).description('「刷新实际最大上下文」按钮是否可用，默认 true'),
  uiEnableManualCompact: Schema.boolean().default(defaults.uiEnableManualCompact).description('「立即压缩上下文」按钮是否可用，默认 true'),
  capacityAutoProbe: Schema.boolean().default(defaults.capacityAutoProbe).description('是否启用自动探测（默认 false，仅人工刷新）'),
})
