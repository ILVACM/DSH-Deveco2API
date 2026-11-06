/**
 * DSH 自身压缩阈值的声明式参数求解。
 *
 * 宿主公式（已核实 dsh-compaction-basic 源码）：
 *   thresholdTokens = floor(min(W × thresholdRatio, W − O − headroomTokens))
 *   W = ctx.llm.resolveModelInfo().context.contextWindow（插件报的值）
 *   O = 本次请求实际 maxTokens（动态，最坏为目录 output）
 *
 * 目标语义：thresholdTokens === floor(actualMax × targetRatio)（「DSH 80%」）。
 * 做法：把「目标语义」与「传给 DSH 的参数」分离——不直接把目标值塞给宿主，
 * 而是按目标反向推导一组参数，使 min(...) 恒等于目标，且与动态 O 无关：
 *   1. W 取 target + OMax（OMax = 目录 output，最坏情况），保证 W − O ≥ target
 *   2. ratio = target / W                 → W×ratio = target
 *   3. headroom = 0                      → W−O−headroom = W−O ≥ target
 *   因而 min(W×ratio, W−O−headroom) = target，恒成立。
 *
 * @module src/compaction-policy.ts
 */

export interface ModelPolicy {
  provider: string
  model: string
  thresholdRatio: number
  headroomTokens: number
}
/** 供部署合入 dsh-compaction-basic.config 的声明式产物。 */
export interface CompactionPolicyFile {
  modelPolicies: ModelPolicy[]
  /** 反推得到的、建议插件 resolveModel() 报给 DSH 的 contextWindow（按模型）。 */
  suggestedContextWindow: Record<string, number>
}

export interface SolveInput {
  actualMax: number
  /** 目录 output（最坏 O）；用于反推 W。 */
  reservedCompletionTokens: number
  targetRatio: number
}
export interface SolvedPolicy {
  /** 反推得到的 W：应作为该模型 resolveModel().context.contextWindow 报给 DSH。 */
  contextWindow: number
  thresholdRatio: number
  headroomTokens: number
  thresholdTokens: number
}

/** 按目标反向推导参数，使宿主公式的 min(...) 精确等于 target。 */
export function solveModelPolicy(input: SolveInput): SolvedPolicy {
  const target = Math.floor(input.actualMax * input.targetRatio)
  const OMax = Math.max(0, Math.floor(input.reservedCompletionTokens))
  const W = target + OMax
  const ratio = target / W
  const headroom = 0
  return { contextWindow: W, thresholdRatio: ratio, headroomTokens: headroom, thresholdTokens: target }
}

export function buildModelPolicies(
  models: Array<{ id: string; actualMax: number; reservedCompletionTokens: number }>,
  targetRatio = 0.8,
): CompactionPolicyFile {
  const modelPolicies: ModelPolicy[] = []
  const suggestedContextWindow: Record<string, number> = {}
  for (const m of models) {
    const s = solveModelPolicy({
      actualMax: m.actualMax,
      reservedCompletionTokens: m.reservedCompletionTokens,
      targetRatio,
    })
    modelPolicies.push({
      provider: 'deveco2dsh',
      model: m.id,
      thresholdRatio: s.thresholdRatio,
      headroomTokens: s.headroomTokens,
    })
    suggestedContextWindow[m.id] = s.contextWindow
  }
  return { modelPolicies, suggestedContextWindow }
}
