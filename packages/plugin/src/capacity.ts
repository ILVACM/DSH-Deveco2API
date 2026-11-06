/**
 * 上下文容量双数字记录与判定（纯函数层，无网络、无宿主依赖）。
 * @module src/capacity.ts
 */
import { join } from 'node:path'
import { DATA_DIR } from './catalog.ts'

export const CAPACITY_PATH = join(DATA_DIR, 'capacity.json')

export interface CapacityRecord {
  suggested: number
  actualMax: number
  measuredAt: string
  source: 'probe' | 'fallback'
}
export interface CapacityFile {
  schema: 'capacity/v1'
  updatedAt: string
  models: Record<string, CapacityRecord>
}

export const EMPTY_CAPACITY: CapacityFile = { schema: 'capacity/v1', updatedAt: '', models: {} }

/** 相近判定：suggested >= actualMax * 0.9（且 actualMax >= suggested）。 */
export function isSimilar(suggested: number, actualMax: number): boolean {
  return actualMax >= suggested && suggested >= actualMax * 0.9
}

/** 相近时 effectiveSuggested = floor(actualMax * 0.8)；否则保持 suggested。 */
export function effectiveSuggested(suggested: number, actualMax: number): number {
  if (isSimilar(suggested, actualMax)) return Math.floor(actualMax * 0.8)
  return suggested
}

export function readCapacityFile(raw: unknown): CapacityFile {
  if (!raw || typeof raw !== 'object') return { ...EMPTY_CAPACITY, models: {} }
  const rec = raw as { schema?: unknown; updatedAt?: unknown; models?: unknown }
  if (rec['schema'] !== 'capacity/v1' || !rec['models'] || typeof rec['models'] !== 'object') {
    return { ...EMPTY_CAPACITY, models: {} }
  }
  const models: Record<string, CapacityRecord> = {}
  for (const [id, value] of Object.entries(rec['models'] as Record<string, unknown>)) {
    if (!value || typeof value !== 'object') continue
    const v = value as Record<string, unknown>
    const suggested = v['suggested']
    const actualMax = v['actualMax']
    const measuredAt = v['measuredAt']
    const source = v['source']
    if (typeof suggested !== 'number' || typeof actualMax !== 'number' || typeof measuredAt !== 'string') continue
    models[id] = {
      suggested,
      actualMax,
      measuredAt,
      source: source === 'probe' ? 'probe' : 'fallback',
    }
  }
  return { schema: 'capacity/v1', updatedAt: typeof rec['updatedAt'] === 'string' ? rec['updatedAt'] : '', models }
}

export function serializeCapacity(file: CapacityFile): string {
  return JSON.stringify(file, null, 2)
}
