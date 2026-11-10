import { apiFetch } from '../lib/apiClient'
import { backoffDelay, isAbortError, isTransient } from '../lib/retry'
import { ApiError } from '../lib/types'
import type { TileResponse } from './types'

/** Un bloque ya decodificado y listo para leer celda por celda. */
export interface Tile {
  tileRow: number
  tileCol: number
  originRow: number
  originCol: number
  rows: number
  cols: number
  /** Digito (0-9) por celda, por filas. */
  values: Uint8Array
  /** Temblor (0-100) por celda, decodificado del base64. */
  tremor: Uint8Array
  /** '.', 'W', 'F', 'D', 'M' por celda. Mutable: se actualiza al refinar. */
  bins: string[]
  version: number
}

function decodeBase64(b64: string): Uint8Array {
  const bin = atob(b64)
  const out = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i)
  return out
}

function decodeTile(t: TileResponse): Tile {
  const values = new Uint8Array(t.values.length)
  for (let i = 0; i < t.values.length; i++) values[i] = t.values.charCodeAt(i) - 48
  return {
    tileRow: t.tileRow,
    tileCol: t.tileCol,
    originRow: t.originRow,
    originCol: t.originCol,
    rows: t.rows,
    cols: t.cols,
    values,
    tremor: decodeBase64(t.tremor),
    bins: t.bins.split(''),
    version: t.version,
  }
}

const key = (tr: number, tc: number) => `${tr}:${tc}`

interface Job {
  tr: number
  tc: number
  /** pinned = lo necesita la busqueda de un grupo: no se cancela por scroll. */
  pinned: boolean
  /** true cuando ya salio la request HTTP (no esta solo en la cola). */
  running: boolean
  attempt: number
  controller: AbortController
  waiters: { resolve: (t: Tile) => void; reject: (e: unknown) => void }[]
}

// El backend permite 40 bloques cada 10 s por sesion. Nos quedamos un poco
// por debajo para no provocar 429 en condiciones normales; si igual llega un
// 429 (otra pestaña, caos), se respeta Retry-After.
const WINDOW_MS = 10_000
const MAX_PER_WINDOW = 36
const MAX_CONCURRENT = 6

/**
 * Cache + planificador de bloques de un archivo.
 *
 * Garantias (CP2):
 *  - Cada bloque se pide una sola vez: si ya esta en cache se reutiliza y si
 *    ya hay una request en vuelo, los demas interesados esperan esa misma.
 *  - Bloques que salieron de la vista antes de responder -> AbortController.
 *  - 429: no se pide NADA hasta que pase Retry-After.
 *  - 503 / red: reintento con espera creciente.
 */
export class TileStore {
  readonly tileSize: number
  readonly tileRows: number
  readonly tileCols: number

  private cache = new Map<string, Tile>()
  private jobs = new Map<string, Job>()
  private queue: string[] = []
  private blockedUntil = 0
  private sentAt: number[] = []
  private active = 0
  private timer: ReturnType<typeof setTimeout> | null = null
  private listeners = new Set<() => void>()
  private wanted = new Set<string>()
  /** Se incrementa con cada cambio; sirve como "version" para React. */
  revision = 0
  /** Momento hasta el que estamos frenados por 429 (para mostrarlo en UI). */
  rateLimitedUntil = 0

  private readonly fileId: number
  readonly rows: number
  readonly cols: number

  constructor(fileId: number, rows: number, cols: number, tileSize: number) {
    this.fileId = fileId
    this.rows = rows
    this.cols = cols
    this.tileSize = tileSize
    this.tileRows = Math.ceil(rows / tileSize)
    this.tileCols = Math.ceil(cols / tileSize)
  }

  // --- Suscripcion (React) ---------------------------------------------------
  subscribe = (fn: () => void) => {
    this.listeners.add(fn)
    return () => {
      this.listeners.delete(fn)
    }
  }
  getRevision = () => this.revision
  private emit() {
    this.revision++
    for (const fn of this.listeners) fn()
  }

  // --- Lectura sincrona ------------------------------------------------------
  getTile(tr: number, tc: number): Tile | undefined {
    return this.cache.get(key(tr, tc))
  }

  /** Datos de una celda global, o undefined si su bloque no esta cargado. */
  getCell(r: number, c: number): { value: number; tremor: number; bin: string } | undefined {
    if (r < 0 || c < 0 || r >= this.rows || c >= this.cols) return undefined
    const t = this.cache.get(key(Math.floor(r / this.tileSize), Math.floor(c / this.tileSize)))
    if (!t) return undefined
    const i = (r - t.originRow) * t.cols + (c - t.originCol)
    return { value: t.values[i], tremor: t.tremor[i], bin: t.bins[i] }
  }

  tileOf(r: number, c: number): [number, number] {
    return [Math.floor(r / this.tileSize), Math.floor(c / this.tileSize)]
  }

  // --- Pedidos ---------------------------------------------------------------

  /**
   * Bloques que la vista necesita AHORA. Encola los que faltan y cancela los
   * que estaban pendientes pero ya no se ven (salvo los "pinned").
   */
  setWanted(tiles: [number, number][]) {
    const next = new Set(tiles.map(([tr, tc]) => key(tr, tc)))
    this.wanted = next
    // Cancelar lo que ya no hace falta.
    for (const [k, job] of this.jobs) {
      if (!next.has(k) && !job.pinned) this.cancel(k, job)
    }
    // Encolar lo que falta.
    for (const [tr, tc] of tiles) this.request(tr, tc, false)
    this.pump()
  }

  /** Promesa del bloque (para la busqueda de grupos). No se cancela por scroll. */
  load(tr: number, tc: number): Promise<Tile> {
    const cached = this.cache.get(key(tr, tc))
    if (cached) return Promise.resolve(cached)
    const job = this.request(tr, tc, true)
    const p = new Promise<Tile>((resolve, reject) => job.waiters.push({ resolve, reject }))
    this.pump()
    return p
  }

  /** Olvida bloques (ej. tras 409 ALREADY_REFINED) y los vuelve a pedir. */
  invalidate(tiles: [number, number][]) {
    for (const [tr, tc] of tiles) {
      const k = key(tr, tc)
      this.cache.delete(k)
      const job = this.jobs.get(k)
      if (job) this.cancel(k, job)
    }
    this.emit()
    for (const [tr, tc] of tiles) {
      if (this.wanted.has(key(tr, tc))) this.request(tr, tc, false)
    }
    this.pump()
  }

  /** stream.reset: todo lo cacheado puede estar viejo -> volver a pedirlo. */
  invalidateAll() {
    this.invalidate([...this.cache.values()].map((t) => [t.tileRow, t.tileCol] as [number, number]))
  }

  /** Marca celdas como refinadas en la cache, sin volver a pedir la grilla. */
  markRefined(cells: { r: number; c: number }[], binChar: string) {
    for (const { r, c } of cells) {
      const t = this.cache.get(key(Math.floor(r / this.tileSize), Math.floor(c / this.tileSize)))
      if (!t) continue
      t.bins[(r - t.originRow) * t.cols + (c - t.originCol)] = binChar
    }
    this.emit()
  }

  /**
   * Cancela todo lo pendiente al salir de la grilla. No "mata" el store: en
   * desarrollo React (StrictMode) desmonta y vuelve a montar, y el store tiene
   * que seguir funcionando despues. La cache se conserva.
   */
  dispose() {
    if (this.timer) clearTimeout(this.timer)
    this.timer = null
    for (const [k, job] of this.jobs) this.cancel(k, job)
  }

  private request(tr: number, tc: number, pinned: boolean): Job {
    const k = key(tr, tc)
    const existing = this.jobs.get(k)
    if (existing) {
      // Ya hay uno en cola o en vuelo: NO se duplica, solo se reutiliza.
      if (pinned) existing.pinned = true
      return existing
    }
    const job: Job = {
      tr,
      tc,
      pinned,
      running: false,
      attempt: 0,
      controller: new AbortController(),
      waiters: [],
    }
    if (this.cache.has(k)) return job // no se encola: ya esta
    this.jobs.set(k, job)
    if (pinned) this.queue.unshift(k)
    else this.queue.push(k)
    return job
  }

  private cancel(k: string, job: Job) {
    job.controller.abort()
    this.jobs.delete(k)
    this.queue = this.queue.filter((q) => q !== k)
    const err = new DOMException('Bloque cancelado', 'AbortError')
    for (const w of job.waiters) w.reject(err)
  }

  private schedule(ms: number) {
    if (this.timer) clearTimeout(this.timer)
    this.timer = setTimeout(() => {
      this.timer = null
      this.pump()
    }, ms)
  }

  private pump() {
    while (this.active < MAX_CONCURRENT && this.queue.length > 0) {
      const now = Date.now()
      // 429 activo: no se pide nada hasta que pase Retry-After.
      if (now < this.blockedUntil) {
        this.schedule(this.blockedUntil - now)
        return
      }
      // Ventana deslizante propia para no llegar al limite.
      this.sentAt = this.sentAt.filter((t) => now - t < WINDOW_MS)
      if (this.sentAt.length >= MAX_PER_WINDOW) {
        this.schedule(WINDOW_MS - (now - this.sentAt[0]) + 20)
        return
      }
      const k = this.queue.shift()
      if (!k) return
      const job = this.jobs.get(k)
      if (!job || job.running) continue
      this.sentAt.push(now)
      void this.run(k, job)
    }
  }

  private async run(k: string, job: Job) {
    job.running = true
    this.active++
    try {
      const res = await apiFetch<TileResponse>(
        `/files/${this.fileId}/tiles/${job.tr}/${job.tc}`,
        { signal: job.controller.signal },
      )
      if (this.jobs.get(k) !== job) return // fue cancelado mientras volvia
      const tile = decodeTile(res)
      this.cache.set(k, tile)
      this.jobs.delete(k)
      for (const w of job.waiters) w.resolve(tile)
      this.emit()
    } catch (err) {
      if (isAbortError(err) || this.jobs.get(k) !== job) return
      job.running = false
      if (err instanceof ApiError && err.status === 429) {
        // Frenar TODO hasta que pase Retry-After y reencolar este bloque.
        const wait = (err.retryAfter ?? 1) * 1000
        this.blockedUntil = Date.now() + wait
        this.rateLimitedUntil = this.blockedUntil
        this.queue.unshift(k)
        this.emit()
      } else if (isTransient(err) && job.attempt < 5) {
        const delay = backoffDelay(job.attempt, err)
        job.attempt++
        setTimeout(() => {
          if (this.jobs.get(k) !== job) return
          this.queue.unshift(k)
          this.pump()
        }, delay)
      } else {
        this.jobs.delete(k)
        for (const w of job.waiters) w.reject(err)
      }
    } finally {
      this.active--
      this.pump()
    }
  }
}
