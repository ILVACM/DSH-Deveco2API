/**
 * GUI 数据桥：聚合 catalog + capacity + 占用 的只读快照；注册 4 个 action。
 * /probe 与 /refresh-models 同步返回完整快照（不再 fire-and-forget）。
 * 路由挂在 /plugins/<包名>/ 前缀下，Desktop forwarder 才会转发。
 * @module src/status-bridge.ts
 */
import { effectiveSuggested, type CapacityFile } from './capacity.ts'

/** 服务端自写常量：与客户端 constants.ts 的 API_BASE 值相等，但不跨端 import。 */
const API_BASE = '/plugins/dsh-deveco2api-plugin'

export interface StatusSnapshot {
  models: Array<{
    id: string; name: string; effectiveSuggested: number; actualMax: number
    source: string; measuredAt: string; similar: boolean
  }>
  occupancy: { used: number; contextWindow: number } | null
  probing: boolean
  compacting: boolean
  lastCompactedAt: number
  capacityReady: boolean
  measuredAt: string
}
export interface StatusInput {
  catalogModels: Array<{ id: string; name: string; contextWindow: number }>
  capacity: CapacityFile
  used: number | null
  probing: boolean
  compacting: boolean
  lastCompactedAt: number
  measuredAt: string
}

export function buildSnapshot(input: StatusInput): StatusSnapshot {
  const models = input.catalogModels.map((m) => {
    const c = input.capacity.models[m.id]
    const suggested = m.contextWindow
    const actualMax = c?.actualMax ?? 0
    return {
      id: m.id,
      name: m.name,
      effectiveSuggested: c ? effectiveSuggested(suggested, actualMax) : suggested,
      actualMax,
      source: c?.source ?? 'none',
      measuredAt: c?.measuredAt ?? '',
      similar: c ? suggested >= actualMax * 0.9 : false,
    }
  })
  return {
    models,
    occupancy: input.used === null ? null : { used: input.used, contextWindow: Math.max(...models.map((m) => m.effectiveSuggested), 0) },
    probing: input.probing,
    compacting: input.compacting,
    lastCompactedAt: input.lastCompactedAt,
    capacityReady: Object.keys(input.capacity.models).length > 0,
    measuredAt: input.measuredAt,
  }
}

export interface BridgeContext {
  webServer?: {
    register(spec: {
      kind: 'exact'
      path: string
      handler: (req: unknown, res: unknown) => unknown
    }): unknown
  }
}
export interface BridgeDeps {
  getSnapshot: () => StatusSnapshot
  onProbe: () => Promise<StatusSnapshot>
  onCompact: () => Promise<{ ok: boolean; message: string }>
  onRefreshModels: () => Promise<StatusSnapshot>
}

/** 宿主真实 API：kind:'exact' + (req,res) 两参 handler。 */
function json(res: unknown, status: number, body: unknown): void {
  const r = res as { writeHead?(s: number, h: Record<string, string>): void; end?(s: string): void }
  if (typeof r?.writeHead === 'function' && typeof r?.end === 'function') {
    r.writeHead(status, { 'content-type': 'application/json' })
    r.end(JSON.stringify(body))
  }
}

function isLoopback(req: unknown): boolean {
  const r = req as { socket?: { remoteAddress?: string } }
  const addr = r?.socket?.remoteAddress ?? ''
  return addr === '127.0.0.1' || addr === '::1' || addr === '::ffff:127.0.0.1' || addr === ''
}

export function registerStatusBridge(ctx: BridgeContext, deps: BridgeDeps): void {
  if (!ctx.webServer || typeof ctx.webServer.register !== 'function') return
  const send = (req: unknown, res: unknown, fn: () => void): void => {
    if (!isLoopback(req)) { json(res, 403, { error: 'forbidden' }); return }
    try { fn() } catch (error) { json(res, 500, { error: error instanceof Error ? error.message : String(error) }) }
  }
  ctx.webServer.register({
    kind: 'exact',
    path: `${API_BASE}/status`,
    handler: (req, res) => send(req, res, () => json(res, 200, deps.getSnapshot())),
  })
  ctx.webServer.register({
    kind: 'exact',
    path: `${API_BASE}/probe`,
    handler: (req, res) => send(req, res, () => {
      void deps.onProbe().then((snap) => json(res, 200, snap)).catch((e) => json(res, 500, { error: String(e) }))
    }),
  })
  ctx.webServer.register({
    kind: 'exact',
    path: `${API_BASE}/compact`,
    handler: (req, res) => send(req, res, () => {
      void deps.onCompact().then((r) => json(res, 200, r)).catch((e) => json(res, 500, { error: String(e) }))
    }),
  })
  ctx.webServer.register({
    kind: 'exact',
    path: `${API_BASE}/refresh-models`,
    handler: (req, res) => send(req, res, () => {
      void deps.onRefreshModels().then((snap) => json(res, 200, snap)).catch((e) => json(res, 500, { error: String(e) }))
    }),
  })
}
