// Tipos de los endpoints /files del contrato (ver Swagger).

export type FileStatus = 'ACTIVE' | 'COMPLETE'
export type Bin = 'WO' | 'FC' | 'DR' | 'MA'

export interface FileProgress {
  WO: number
  FC: number
  DR: number
  MA: number
  overall: number
}

export interface FileSummary {
  id: number
  name: string
  rows: number
  cols: number
  tileSize: number
  status: FileStatus
  progress: FileProgress
  refinedGroups: number
  totalGroups: number
  mistakes: number
  updatedAt: string
}

export interface FilesPage {
  content: FileSummary[]
  totalElements: number
  totalPages: number
  page: number
  size: number
}

export interface FileRules {
  tremorThreshold: number
  connectivity: 4 | 8
  minGroupSize: number
  maxGroupSize: number
  binning: {
    strategy: 'DIGIT_SUM_MOD' | 'MAX_DIGIT_MOD'
    order: Bin[]
  }
}

export interface Tile {
  tileRow: number
  tileCol: number
  originRow: number
  originCol: number
  rows: number
  cols: number
  /** Un char por celda ('0'-'9'), por filas. */
  values: string
  /** base64; cada byte = tremor (0-100) de una celda, mismo orden. */
  tremor: string
  /** Un char por celda: '.' sin refinar, o 'W'/'F'/'D'/'M'. */
  bins: string
  version: number
}

export interface Cell {
  r: number
  c: number
}

export interface RefinementResponse {
  id: number
  bin: Bin
  cells: Cell[]
  file: {
    id: number
    progress: FileProgress
    refinedGroups: number
    mistakes: number
  }
}
