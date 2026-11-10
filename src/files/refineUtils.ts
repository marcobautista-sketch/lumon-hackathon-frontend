import type { Bin, Cell, FileRules, Tile } from './fileTypes'

/** Decodifica el campo tremor (base64) a un array de bytes. */
export function decodeTremor(base64: string): Uint8Array {
  const bin = atob(base64)
  const out = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i)
  return out
}

/** Caja segun un char de bins. '.' = sin refinar. */
export function binFromChar(ch: string): Bin | null {
  switch (ch) {
    case 'W': return 'WO'
    case 'F': return 'FC'
    case 'D': return 'DR'
    case 'M': return 'MA'
    default: return null
  }
}

/** Da miedo si tremor >= tremorThreshold. */
export function isScary(tremor: number, rules: FileRules): boolean {
  return tremor >= rules.tremorThreshold
}

/** Vecinos segun connectivity (4 u 8). */
export function neighborDeltas(connectivity: 4 | 8): Array<[number, number]> {
  if (connectivity === 4) return [[-1, 0], [1, 0], [0, -1], [0, 1]]
  return [[-1, -1], [-1, 0], [-1, 1], [0, -1], [0, 1], [1, -1], [1, 0], [1, 1]]
}

/**
 * Determina a que caja (WO/FC/DR/MA) va un grupo segun las reglas.
 * DIGIT_SUM_MOD: indice = (sum(digitos) % 4).
 * MAX_DIGIT_MOD: indice = (max(digitos) % 4).
 */
export function computeBinForGroup(_cells: Cell[], digits: number[], rules: FileRules): Bin {
  let index: number
  if (rules.binning.strategy === 'DIGIT_SUM_MOD') {
    const sum = digits.reduce((acc, d) => acc + d, 0)
    index = sum % 4
  } else {
    const max = digits.reduce((acc, d) => (d > acc ? d : acc), 0)
    index = max % 4
  }
  return rules.binning.order[index]
}

/** Grupo valido en tamano? */
export function isValidSize(size: number, rules: FileRules): boolean {
  return size >= rules.minGroupSize && size <= rules.maxGroupSize
}

/** Lee una celda de un tile por indice (r,c) locales al tile. */
export function readTileCell(tile: Tile, localRow: number, localCol: number): { value: number; tremor: number; bin: string } {
  const idx = localRow * tile.cols + localCol
  const value = Number(tile.values[idx])
  const tremorBytes = decodeTremor(tile.tremor)
  const tremor = tremorBytes[idx] ?? 0
  const bin = tile.bins[idx] ?? '.'
  return { value, tremor, bin }
}

/**
 * BFS por un grupo conexo que da miedo, empezando en (r,c) globales.
 * Recibe una funcion getCell(r,c) que devuelve la celda o null si no se puede
 * leer (p. ej. porque el tile no esta cargado todavia; en ese caso el caller
 * puede pedirlo y volver a llamar).
 * Si alguna celda no esta disponible, devuelve null (grupo incompleto).
 */
export function bfsGroup(
  startR: number,
  startC: number,
  totalRows: number,
  totalCols: number,
  rules: FileRules,
  getCell: (r: number, c: number) => { value: number; tremor: number; bin: string } | null,
): { cells: Cell[]; digits: number[] } | null {
  const first = getCell(startR, startC)
  if (!first || !isScary(first.tremor, rules)) return { cells: [], digits: [] }

  const deltas = neighborDeltas(rules.connectivity)
  const visited = new Set<string>()
  const queue: Cell[] = [{ r: startR, c: startC }]
  const cells: Cell[] = []
  const digits: number[] = []
  visited.add(`${startR},${startC}`)

  while (queue.length > 0) {
    const { r, c } = queue.shift()!
    const cell = getCell(r, c)
    if (!cell) return null // tile aun no disponible -> grupo incompleto
    if (!isScary(cell.tremor, rules)) continue
    cells.push({ r, c })
    digits.push(cell.value)

    for (const [dr, dc] of deltas) {
      const nr = r + dr
      const nc = c + dc
      if (nr < 0 || nr >= totalRows || nc < 0 || nc >= totalCols) continue
      const key = `${nr},${nc}`
      if (visited.has(key)) continue
      visited.add(key)
      queue.push({ r: nr, c: nc })
    }
  }
  return { cells, digits }
}

/** Nombre humano de la caja. */
export const BIN_NAMES: Record<Bin, string> = {
  WO: 'Woe',
  FC: 'Frolic',
  DR: 'Dread',
  MA: 'Malice',
}
