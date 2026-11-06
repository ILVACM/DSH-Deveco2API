/** 设置页卡片：模型列表 + 双数字 + 占用 + 手动按钮（四态 + 直接渲染返回值）。 */
import * as React from 'react'
import { messages } from './locales.ts'
import { API_BASE } from './constants.ts'

type ModelRow = { id: string; name: string; effectiveSuggested: number; actualMax: number; source: string; measuredAt: string; similar: boolean }
type Snapshot = {
  models: ModelRow[]
  occupancy: { used: number; contextWindow: number } | null
  probing: boolean
  compacting: boolean
  lastCompactedAt: number
  capacityReady: boolean
  measuredAt: string
}

const t = messages.zh

/** 检查 res.ok 并解析；失败抛出带后端 error 文案的异常。 */
async function request(path: string, method: 'GET' | 'POST'): Promise<Snapshot> {
  const r = await fetch(`${API_BASE}${path}`, { method })
  const body = await r.json().catch(() => ({} as Record<string, unknown>))
  if (!r.ok) {
    const msg = (body as { error?: string }).error ?? `HTTP ${r.status}`
    throw new Error(msg)
  }
  return body as Snapshot
}

/** 实际最大上下文的四态显示。 */
function actualMaxCell(m: ModelRow): string {
  if (m.source === 'error') return `${t.probeFailed}${m.measuredAt ? '' : ''}`
  if (m.actualMax <= 0) return t.notMeasured
  if (m.source === 'fallback') return `${m.actualMax}（${t.fallback}）`
  return String(m.actualMax)
}

export function CapacityCard(): React.ReactElement {
  const [snap, setSnap] = React.useState<Snapshot | null>(null)
  const [busy, setBusy] = React.useState<string | null>(null)
  const [error, setError] = React.useState<string>('')

  const load = React.useCallback(async () => {
    try { setSnap(await request('/status', 'GET')); setError('') }
    catch (e) { setError(e instanceof Error ? e.message : String(e)) }
  }, [])
  React.useEffect(() => { void load() }, [load])

  const act = async (name: string, path: string): Promise<void> => {
    setBusy(name); setError('')
    try {
      // 直接用返回快照渲染（不再二次 fetch）
      setSnap(await request(path, 'POST'))
    } catch (e) { setError(e instanceof Error ? e.message : String(e)) }
    finally { setBusy(null) }
  }

  if (!snap) {
    return React.createElement('div', null,
      React.createElement('h3', null, t.title),
      React.createElement('p', null, error ? `${t.notAvailable}: ${error}` : t.notAvailable))
  }
  const inCooldown = snap.lastCompactedAt > 0 && Date.now() - snap.lastCompactedAt < 60_000
  const disabled = snap.probing || snap.compacting || inCooldown || busy !== null

  return React.createElement('div', null,
    React.createElement('h3', null, t.title),
    error ? React.createElement('p', { style: { color: 'crimson' } }, error) : null,
    React.createElement('button', { disabled, onClick: () => void act('refresh', '/refresh-models') }, t.refreshModels),
    ' ',
    React.createElement('button', { disabled, onClick: () => void act('probe', '/probe') },
      busy === 'probe' ? t.probing : t.refreshProbe),
    ' ',
    React.createElement('button', { disabled, onClick: () => void act('compact', '/compact') },
      snap.compacting || busy === 'compact' ? t.compacting : t.compact),
    snap.occupancy ? React.createElement('p', null,
      `${t.used}: ${snap.occupancy.used} / ${snap.occupancy.contextWindow}`) : null,
    React.createElement('h4', null, t.models),
    React.createElement('table', null,
      React.createElement('thead', null, React.createElement('tr', null,
        React.createElement('th', null, 'ID'),
        React.createElement('th', null, t.suggested),
        React.createElement('th', null, t.actualMax))),
      React.createElement('tbody', null, snap.models.map((m) =>
        React.createElement('tr', { key: m.id },
          React.createElement('td', null, m.id),
          React.createElement('td', null, String(m.effectiveSuggested)),
          React.createElement('td', null, actualMaxCell(m)))))),
    snap.measuredAt ? React.createElement('p', { style: { opacity: 0.7 } }, `${t.measuredAt}: ${snap.measuredAt}`) : null,
  )
}
export default CapacityCard
