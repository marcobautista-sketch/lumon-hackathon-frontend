// Tipos de /files y /files/{id}/* segun Swagger (https://lumon-api.vercel.app/docs).

export type Bin = 'WO' | 'FC' | 'DR' | 'MA'
export const BINS: readonly Bin[] = ['WO', 'FC', 'DR', 'MA']

/** Letra que usa `tile.bins` para cada caja ('.' = sin refinar). */
export const BIN_CHAR: Record<Bin, string> = { WO: 'W', FC: 'F', DR: 'D', MA: 'M' }
export const CHAR_BIN: Record<string, Bin> = { W: 'WO', F: 'FC', D: 'DR', M: 'MA' }

export type FileStatus = 'ACTIVE' | 'COMPLETE'

/** Fraccion refinada (0 a 1) por caja y total. */
export interface Progress {
  WO: number
  FC: number
  DR: number
  MA: number
  overall: number
}

export interface DataFile {
  id: number
  name: string
  rows: number
  cols: number
  tileSize: number
  status: FileStatus
  progress: Progress
  refinedGroups: number
  totalGroups: number
  mistakes: number
  updatedAt: string
}

export interface FilePage {
  content: DataFile[]
  totalElements: number
  totalPages: number
  page: number
  size: number
}

export interface Rules {
  tremorThreshold: number
  connectivity: 4 | 8
  minGroupSize: number
  maxGroupSize: number
  binning: {
    strategy: 'DIGIT_SUM_MOD' | 'MAX_DIGIT_MOD'
    order: Bin[]
  }
}

/** Respuesta cruda de GET /files/{id}/tiles/{tileRow}/{tileCol}. */
export interface TileResponse {
  tileRow: number
  tileCol: number
  originRow: number
  originCol: number
  rows: number
  cols: number
  values: string
  /** base64, un byte (0-100) por celda */
  tremor: string
  bins: string
  version: number
}

export interface RefineResult {
  refinementId: number
  bin: Bin
  size: number
  file: Pick<DataFile, 'progress' | 'refinedGroups' | 'totalGroups' | 'mistakes' | 'status'>
}

export interface Cell {
  r: number
  c: number
}
