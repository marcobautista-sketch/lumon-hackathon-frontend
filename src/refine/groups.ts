import type { Bin, Cell, Rules } from './types'
import type { TileStore } from './tileStore'

export interface Group {
  cells: Cell[]
  /** Caja que corresponde segun las reglas, o null si es ruido. */
  bin: Bin | null
  noise: boolean
  /** true si el grupo crecio mas alla de maxGroupSize y se dejo de explorar. */
  truncated: boolean
}

const N4 = [
  [-1, 0],
  [1, 0],
  [0, -1],
  [0, 1],
] as const
const N8 = [...N4, [-1, -1], [-1, 1], [1, -1], [1, 1]] as const

export function isScary(tremor: number, rules: Rules): boolean {
  return tremor >= rules.tremorThreshold
}

/** Caja segun binning: DIGIT_SUM_MOD (suma % 4) o MAX_DIGIT_MOD (max % 4). */
export function binFor(digits: number[], rules: Rules): Bin {
  const idx =
    rules.binning.strategy === 'MAX_DIGIT_MOD'
      ? Math.max(...digits) % 4
      : digits.reduce((a, b) => a + b, 0) % 4
  return rules.binning.order[idx]
}

/**
 * Componente conexo (BFS) de celdas "que dan miedo" que contiene (r, c).
 *
 * La grilla nunca esta entera en memoria: si el BFS llega al borde de un
 * bloque no cargado, junta esas celdas pendientes, pide los bloques que
 * faltan (en paralelo, via store.load que deduplica) y sigue.
 *
 * Si el grupo supera maxGroupSize ya sabemos que es ruido: se corta para no
 * pedir media grilla.
 */
export async function findGroup(
  store: TileStore,
  rules: Rules,
  start: Cell,
  signal?: AbortSignal,
): Promise<Group | null> {
  const first = store.getCell(start.r, start.c)
  if (!first || !isScary(first.tremor, rules)) return null

  const neighbors = rules.connectivity === 8 ? N8 : N4
  const seen = new Set<number>()
  const id = (r: number, c: number) => r * store.cols + c
  const cells: Cell[] = []
  const digits: number[] = []
  let frontier: Cell[] = [start]
  seen.add(id(start.r, start.c))
  const limit = rules.maxGroupSize + 1
  let truncated = false

  while (frontier.length > 0) {
    const pending: Cell[] = []
    const queue = frontier
    frontier = []

    while (queue.length > 0) {
      const cur = queue.pop()!
      const cell = store.getCell(cur.r, cur.c)
      if (!cell) {
        pending.push(cur) // su bloque no esta cargado todavia
        continue
      }
      if (!isScary(cell.tremor, rules)) continue
      cells.push(cur)
      digits.push(cell.value)
      if (cells.length >= limit) {
        truncated = true
        break
      }
      for (const [dr, dc] of neighbors) {
        const r = cur.r + dr
        const c = cur.c + dc
        if (r < 0 || c < 0 || r >= store.rows || c >= store.cols) continue
        const k = id(r, c)
        if (seen.has(k)) continue
        seen.add(k)
        queue.push({ r, c })
      }
    }
    if (truncated) break
    if (pending.length === 0) break

    // Pedir los bloques que faltan y reprocesar esas celdas.
    const need = new Map<string, [number, number]>()
    for (const p of pending) {
      const [tr, tc] = store.tileOf(p.r, p.c)
      need.set(`${tr}:${tc}`, [tr, tc])
    }
    await Promise.all([...need.values()].map(([tr, tc]) => store.load(tr, tc)))
    if (signal?.aborted) throw new DOMException('cancelado', 'AbortError')
    frontier = pending
  }

  const size = cells.length
  const noise = truncated || size < rules.minGroupSize || size > rules.maxGroupSize
  return { cells, bin: noise ? null : binFor(digits, rules), noise, truncated }
}
