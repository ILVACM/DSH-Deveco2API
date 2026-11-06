/**
 * 上下文守护：每轮请求前读占用、单线判定（建议上下文）、调用 DSH 压缩。
 * 共享「刚压过」标记：防短时间内重复压缩 + 供 GUI/缓存强制刷新。
 * 全部依赖以 HostServices 注入，取不到则降级。
 * @module src/context-guard.ts
 */
export interface HostServices {
  tokenMeter?: { measure(session: unknown): { totalTokens: number } | Promise<{ totalTokens: number }> }
  compaction?: { compactNow(...args: unknown[]): Promise<unknown> | unknown }
  sessionProjections?: unknown
}
export interface GuardDecision {
  used: number
  effectiveSuggested: number
  triggered: boolean
  reason: 'over-suggested' | 'cooldown' | 'none'
}
/** 压后复核结果：blocked=true 表示「不许带着必然超限的历史发请求」。 */
export interface GuardResult {
  decision: GuardDecision
  usedAfter: number
  blocked: boolean
  message: string
}

/** 共享「刚压过」标记：任意一方压缩成功后写；冷却窗口内其他方跳过。 */
export interface CompactState {
  lastCompactedAt: number
  compacting: boolean
}
export interface GuardOptions {
  services: HostServices
  session: unknown
  effectiveSuggested: number
  state: CompactState
  cooldownMs: number
  nowMs?: number
  blockOnOversizedHistory?: boolean
}

export function createCompactState(): CompactState {
  return { lastCompactedAt: 0, compacting: false }
}

export function evaluate(
  used: number, effectiveSuggested: number, state: CompactState, nowMs: number, cooldownMs: number
): GuardDecision {
  const base = { used, effectiveSuggested }
  if (state.compacting || nowMs - state.lastCompactedAt < cooldownMs) {
    return { ...base, triggered: false, reason: 'cooldown' }
  }
  if (used >= effectiveSuggested) return { ...base, triggered: true, reason: 'over-suggested' }
  return { ...base, triggered: false, reason: 'none' }
}

/** 读占用（取不到 tokenMeter 时返回 0，降级）。 */
async function measureUsed(services: HostServices, session: unknown): Promise<number> {
  try {
    if (!services.tokenMeter) return 0
    const m = await services.tokenMeter.measure(session)
    return typeof m?.totalTokens === 'number' ? m.totalTokens : 0
  } catch { return 0 }
}

export async function guardBeforeRequest(opts: GuardOptions): Promise<GuardResult> {
  const { services, session, effectiveSuggested, state, cooldownMs } = opts
  const nowMs = opts.nowMs ?? Date.now()
  const block = opts.blockOnOversizedHistory ?? true
  const used = await measureUsed(services, session)
  const decision = evaluate(used, effectiveSuggested, state, nowMs, cooldownMs)
  if (!decision.triggered || !services.compaction) {
    return { decision, usedAfter: used, blocked: false, message: '' }
  }
  state.compacting = true
  try {
    await services.compaction.compactNow(session)
    state.lastCompactedAt = Date.now()
  } catch {
    return { decision, usedAfter: used, blocked: false, message: '' }
  } finally {
    state.compacting = false
  }
  // 压后复核：DSH 侧压缩可能只压一次仍超窗口（跨模型切换 0.5M ≫ 203K）
  const usedAfter = await measureUsed(services, session)
  if (usedAfter >= effectiveSuggested && block) {
    return {
      decision,
      usedAfter,
      blocked: true,
      message: `上下文仍为 ${usedAfter} token（≥ 建议上下文 ${effectiveSuggested}），已阻止本次请求；请先手动 /compact 或开启新会话`,
    }
  }
  return { decision, usedAfter, blocked: false, message: '' }
}

export async function manualCompact(services: HostServices, state: CompactState): Promise<{ ok: boolean; message: string }> {
  if (!services.compaction) return { ok: false, message: '压缩服务当前不可用' }
  state.compacting = true
  try {
    await services.compaction.compactNow(null)
    state.lastCompactedAt = Date.now()
    return { ok: true, message: '已触发压缩' }
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : String(error) }
  } finally {
    state.compacting = false
  }
}

/** 压缩完成后强制同步状态（供 DSH 侧压缩完成后的桥接回调调用）。 */
export function refreshAfterCompaction(state: CompactState, nowMs: number): void {
  state.lastCompactedAt = nowMs
  state.compacting = false
}
