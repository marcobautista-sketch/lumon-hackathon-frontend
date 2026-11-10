import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Link, useParams, useSearchParams } from 'react-router-dom'
import { apiFetch } from '../lib/apiClient'
import { ApiError } from '../lib/types'
import type {
  Bin,
  Cell,
  FileRules,
  FileSummary,
  RefinementResponse,
  Tile,
} from '../files/fileTypes'
import {
  BIN_NAMES,
  bfsGroup,
  binFromChar,
  computeBinForGroup,
  decodeTremor,
  isScary,
  isValidSize,
  readTileCell,
} from '../files/refineUtils'
import { useTiles } from '../files/useTiles'

const CELL_SIZE = 20 // px - tamano de cada celda en la grilla
const VIEWPORT_HEIGHT = 480
const VIEWPORT_WIDTH = 800
// Buffer de celdas fuera del viewport para pre-cargar (reduce parpadeo).
const PREFETCH_MARGIN = 2

export function RefinePage() {
  const { id } = useParams<{ id: string }>()
  const fileId = Number(id)
  const [params, setParams] = useSearchParams()

  const [file, setFile] = useState<FileSummary | null>(null)
  const [rules, setRules] = useState<FileRules | null>(null)
  const [loadingMeta, setLoadingMeta] = useState(true)
  const [metaError, setMetaError] = useState<string | null>(null)

  const { tiles, getTile, fetchTile, invalidate, pending } = useTiles(fileId)

  const [selectedGroup, setSelectedGroup] = useState<{ cells: Cell[]; bin: Bin; incomplete: boolean } | null>(null)
  const [refining, setRefining] = useState(false)
  const [refineMsg, setRefineMsg] = useState<string | null>(null)

  // Scroll position via URL (?r=<fila>&c=<col>).
  const urlR = Number(params.get('r') ?? 0)
  const urlC = Number(params.get('c') ?? 0)
  const scrollerRef = useRef<HTMLDivElement>(null)

  // Cargar metadata del archivo + reglas.
  useEffect(() => {
    let cancelled = false
    setLoadingMeta(true)
    setMetaError(null)
    Promise.all([
      apiFetch<FileSummary>(`/files/${fileId}`),
      apiFetch<FileRules>(`/files/${fileId}/rules`),
    ])
      .then(([f, r]) => {
        if (cancelled) return
        setFile(f)
        setRules(r)
      })
      .catch((err: unknown) => {
        if (!cancelled) setMetaError(err instanceof ApiError ? err.body.message : 'Error al cargar el archivo.')
      })
      .finally(() => {
        if (!cancelled) setLoadingMeta(false)
      })
    return () => { cancelled = true }
  }, [fileId])

  // Posicionar scroll al cargar / cambiar URL.
  useEffect(() => {
    if (!file || !scrollerRef.current) return
    scrollerRef.current.scrollTo({ left: urlC * CELL_SIZE, top: urlR * CELL_SIZE })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [file])

  // Determinar que tiles son visibles segun el scroll + pedirlos.
  const [viewport, setViewport] = useState({ scrollTop: 0, scrollLeft: 0 })
  useEffect(() => {
    if (!file) return
    const tileSize = file.tileSize
    const firstTileRow = Math.max(0, Math.floor(viewport.scrollTop / CELL_SIZE / tileSize) - PREFETCH_MARGIN)
    const lastTileRow = Math.min(
      Math.ceil(file.rows / tileSize) - 1,
      Math.ceil((viewport.scrollTop + VIEWPORT_HEIGHT) / CELL_SIZE / tileSize) + PREFETCH_MARGIN,
    )
    const firstTileCol = Math.max(0, Math.floor(viewport.scrollLeft / CELL_SIZE / tileSize) - PREFETCH_MARGIN)
    const lastTileCol = Math.min(
      Math.ceil(file.cols / tileSize) - 1,
      Math.ceil((viewport.scrollLeft + VIEWPORT_WIDTH) / CELL_SIZE / tileSize) + PREFETCH_MARGIN,
    )
    for (let tr = firstTileRow; tr <= lastTileRow; tr++) {
      for (let tc = firstTileCol; tc <= lastTileCol; tc++) {
        if (!getTile(tr, tc)) void fetchTile(tr, tc)
      }
    }
  }, [file, viewport, getTile, fetchTile])

  // Lectura de celda global (r,c).
  const readGlobalCell = useCallback(
    (r: number, c: number) => {
      if (!file) return null
      const tr = Math.floor(r / file.tileSize)
      const tc = Math.floor(c / file.tileSize)
      const t = getTile(tr, tc)
      if (!t) return null
      const localR = r - t.originRow
      const localC = c - t.originCol
      if (localR < 0 || localR >= t.rows || localC < 0 || localC >= t.cols) return null
      return readTileCell(t, localR, localC)
    },
    [file, getTile],
  )

  // Seleccion de grupo: BFS que puede necesitar cargar tiles vecinos.
  const selectGroupAt = useCallback(
    async (r: number, c: number) => {
      if (!file || !rules) return
      setRefineMsg(null)
      setParams((p) => { const n = new URLSearchParams(p); n.set('r', String(r)); n.set('c', String(c)); return n }, { replace: true })
      // Primero: BFS con lo que haya en cache. Si falta un tile, pedirlo y repetir.
      let attempts = 0
      while (attempts < 20) {
        const res = bfsGroup(r, c, file.rows, file.cols, rules, readGlobalCell)
        if (res !== null) {
          if (res.cells.length === 0) {
            setSelectedGroup(null)
            return
          }
          const bin = computeBinForGroup(res.cells, res.digits, rules)
          setSelectedGroup({ cells: res.cells, bin, incomplete: !isValidSize(res.cells.length, rules) })
          return
        }
        // Grupo incompleto: pedir todos los tiles que podrian contener celdas vecinas.
        // Estrategia simple: pedir tiles vecinos al actual.
        const tr = Math.floor(r / file.tileSize)
        const tc = Math.floor(c / file.tileSize)
        await Promise.all(
          [-1, 0, 1].flatMap((dr) =>
            [-1, 0, 1].map((dc) => {
              const nr = tr + dr
              const nc = tc + dc
              if (nr < 0 || nc < 0) return Promise.resolve(null)
              return getTile(nr, nc) ? Promise.resolve(null) : fetchTile(nr, nc)
            }),
          ),
        )
        attempts++
      }
    },
    [file, rules, readGlobalCell, getTile, fetchTile, setParams],
  )

  // Refinar: POST con Idempotency-Key. MISMA key entre reintentos.
  const idempotencyKeyRef = useRef<string>('')
  const refineSelected = useCallback(
    async (bin: Bin) => {
      if (!file || !selectedGroup || refining) return
      setRefining(true)
      setRefineMsg(null)
      // Generar una key unica por intencion del usuario (una sola, aunque haya reintento).
      if (!idempotencyKeyRef.current) {
        idempotencyKeyRef.current = crypto.randomUUID()
      }
      try {
        const res = await apiFetch<RefinementResponse>(`/files/${fileId}/refinements`, {
          method: 'POST',
          extraHeaders: { 'Idempotency-Key': idempotencyKeyRef.current },
          body: { bin, cells: selectedGroup.cells },
        })
        setRefineMsg(`✓ Refinado como ${BIN_NAMES[bin]}. Progreso: ${Math.round(res.file.progress.overall * 100)}%.`)
        // Invalidar los tiles afectados por el refinamiento.
        const tileSet = new Set<string>()
        for (const cell of res.cells) {
          const tr = Math.floor(cell.r / file.tileSize)
          const tc = Math.floor(cell.c / file.tileSize)
          tileSet.add(`${tr},${tc}`)
        }
        tileSet.forEach((k) => {
          const [tr, tc] = k.split(',').map(Number)
          invalidate(tr, tc)
          void fetchTile(tr, tc)
        })
        setSelectedGroup(null)
        idempotencyKeyRef.current = '' // nueva intencion despues
        // Refrescar file para ver nuevo progreso.
        setFile((f) => (f ? { ...f, progress: res.file.progress, refinedGroups: res.file.refinedGroups, mistakes: res.file.mistakes } : f))
      } catch (err) {
        if (err instanceof ApiError) {
          setRefineMsg(`✗ ${err.body.error}: ${err.body.message}`)
          if (err.body.error === 'ALREADY_REFINED' || err.body.error === 'GROUP_CLAIMED') {
            // Re-pedir los tiles afectados.
            for (const cell of selectedGroup.cells) {
              const tr = Math.floor(cell.r / file.tileSize)
              const tc = Math.floor(cell.c / file.tileSize)
              invalidate(tr, tc)
              void fetchTile(tr, tc)
            }
            setSelectedGroup(null)
            idempotencyKeyRef.current = ''
          }
        } else {
          setRefineMsg('✗ Error inesperado.')
        }
      } finally {
        setRefining(false)
      }
    },
    [file, fileId, selectedGroup, refining, invalidate, fetchTile],
  )

  const selectedSet = useMemo(() => {
    const s = new Set<string>()
    if (selectedGroup) for (const { r, c } of selectedGroup.cells) s.add(`${r},${c}`)
    return s
  }, [selectedGroup])

  if (loadingMeta) {
    return (
      <main className="flex min-h-screen items-center justify-center bg-slate-950 text-slate-300">
        Cargando archivo…
      </main>
    )
  }
  if (metaError || !file || !rules) {
    return (
      <main className="flex min-h-screen flex-col items-center justify-center gap-2 bg-slate-950 text-slate-100">
        <p role="alert" className="text-red-300">{metaError ?? 'No se pudo cargar.'}</p>
        <Link to="/files" className="underline">Volver al listado</Link>
      </main>
    )
  }

  const totalW = file.cols * CELL_SIZE
  const totalH = file.rows * CELL_SIZE
  const tilesCols = Math.ceil(file.cols / file.tileSize)
  const tilesRows = Math.ceil(file.rows / file.tileSize)

  return (
    <main className="min-h-screen bg-slate-950 px-4 py-4 text-slate-100">
      <div className="mx-auto max-w-6xl space-y-3">
        <header className="flex items-center justify-between">
          <div>
            <h1 className="text-xl font-semibold">{file.name}</h1>
            <p className="text-xs text-slate-400">
              {file.rows}×{file.cols} · tile {file.tileSize} · reglas: umbral {rules.tremorThreshold}, conectividad {rules.connectivity}, {rules.binning.strategy}
            </p>
          </div>
          <Link to="/files" className="text-sm underline text-slate-400">← Archivos</Link>
        </header>

        <section className="flex flex-wrap items-center gap-2 text-xs">
          <span className="rounded bg-slate-800 px-2 py-1">Progreso: {Math.round(file.progress.overall * 100)}%</span>
          <span className="rounded bg-sky-800/40 px-2 py-1">WO {Math.round(file.progress.WO * 100)}%</span>
          <span className="rounded bg-emerald-800/40 px-2 py-1">FC {Math.round(file.progress.FC * 100)}%</span>
          <span className="rounded bg-amber-800/40 px-2 py-1">DR {Math.round(file.progress.DR * 100)}%</span>
          <span className="rounded bg-rose-800/40 px-2 py-1">MA {Math.round(file.progress.MA * 100)}%</span>
          <span className="text-slate-400">Errores: {file.mistakes}</span>
          {pending > 0 && <span className="text-slate-400">· pidiendo {pending} tiles…</span>}
        </section>

        {file.status === 'COMPLETE' && (
          <section className="rounded bg-emerald-900/30 p-3 text-sm">
            ✓ Este archivo esta COMPLETO. Todos los grupos fueron refinados.
          </section>
        )}

        <div className="flex flex-col gap-3 lg:flex-row">
          {/* Grilla con scroll */}
          <div
            ref={scrollerRef}
            onScroll={(e) => {
              const el = e.currentTarget
              setViewport({ scrollTop: el.scrollTop, scrollLeft: el.scrollLeft })
            }}
            className="relative overflow-auto border border-slate-800 bg-slate-900"
            style={{ width: VIEWPORT_WIDTH, height: VIEWPORT_HEIGHT }}
            role="grid"
            aria-rowcount={file.rows}
            aria-colcount={file.cols}
          >
            <div style={{ width: totalW, height: totalH, position: 'relative' }}>
              {/* Renderizar solo tiles cargados (los no cargados dejan un hueco; el layout no salta porque el contenedor tiene total W/H). */}
              {Array.from({ length: tilesRows }).map((_, tr) =>
                Array.from({ length: tilesCols }).map((__, tc) => {
                  const tile = tiles[`${tr},${tc}`] as Tile | undefined
                  if (!tile) return null
                  return (
                    <TileView
                      key={`${tr},${tc}`}
                      tile={tile}
                      cellSize={CELL_SIZE}
                      tremorThreshold={rules.tremorThreshold}
                      selected={selectedSet}
                      onPick={(r, c) => selectGroupAt(r, c)}
                    />
                  )
                }),
              )}
            </div>
          </div>

          {/* Panel lateral */}
          <aside className="flex-1 space-y-3 rounded border border-slate-800 bg-slate-900 p-3">
            <h2 className="text-sm font-medium">Seleccion</h2>
            {!selectedGroup ? (
              <p className="text-sm text-slate-400">
                Clic en una celda que <strong>da miedo</strong> (resaltada en rosa) para seleccionar su grupo.
              </p>
            ) : (
              <>
                <p className="text-sm">
                  Grupo de <strong>{selectedGroup.cells.length}</strong> celdas.
                </p>
                {selectedGroup.incomplete ? (
                  <p role="alert" className="text-sm text-amber-300">
                    Este grupo es ruido (fuera del rango {rules.minGroupSize}-{rules.maxGroupSize}). No se puede refinar.
                  </p>
                ) : (
                  <>
                    <p className="text-sm text-slate-400">
                      Caja sugerida: <strong className="text-slate-100">{BIN_NAMES[selectedGroup.bin]} ({selectedGroup.bin})</strong>
                    </p>
                    <div className="grid grid-cols-2 gap-2">
                      {(['WO', 'FC', 'DR', 'MA'] as Bin[]).map((b) => (
                        <button
                          key={b}
                          type="button"
                          disabled={refining}
                          onClick={() => refineSelected(b)}
                          className="rounded border border-slate-700 bg-slate-800 py-2 text-sm disabled:opacity-50"
                        >
                          {BIN_NAMES[b]} ({b})
                        </button>
                      ))}
                    </div>
                    <button
                      type="button"
                      onClick={() => setSelectedGroup(null)}
                      className="text-xs text-slate-400 underline"
                    >
                      Cancelar seleccion
                    </button>
                  </>
                )}
              </>
            )}
            {refineMsg && <p className="rounded bg-slate-800 p-2 text-sm">{refineMsg}</p>}
          </aside>
        </div>
      </div>
    </main>
  )
}

// Un tile dibujado como celdas absolutas dentro del gran contenedor.
function TileView({
  tile, cellSize, tremorThreshold, selected, onPick,
}: {
  tile: Tile
  cellSize: number
  tremorThreshold: number
  selected: Set<string>
  onPick: (r: number, c: number) => void
}) {
  const tremorBytes = useMemo(() => decodeTremor(tile.tremor), [tile.tremor])
  const cells: React.ReactNode[] = []
  for (let lr = 0; lr < tile.rows; lr++) {
    for (let lc = 0; lc < tile.cols; lc++) {
      const idx = lr * tile.cols + lc
      const value = tile.values[idx]
      const tremor = tremorBytes[idx] ?? 0
      const binChar = tile.bins[idx] ?? '.'
      const bin = binFromChar(binChar)
      const r = tile.originRow + lr
      const c = tile.originCol + lc
      const isSel = selected.has(`${r},${c}`)
      const scary = isScary(tremor, { tremorThreshold } as FileRules)
      let cls = 'absolute flex items-center justify-center text-[11px] leading-none select-none'
      let style: React.CSSProperties = {
        left: lc * cellSize,
        top: lr * cellSize,
        width: cellSize,
        height: cellSize,
      }
      if (bin) {
        const binColor = bin === 'WO' ? 'bg-sky-700' : bin === 'FC' ? 'bg-emerald-700' : bin === 'DR' ? 'bg-amber-700' : 'bg-rose-700'
        cls += ' ' + binColor + ' text-slate-100/80'
      } else if (isSel) {
        cls += ' bg-indigo-500 text-slate-100 cursor-pointer'
      } else if (scary) {
        cls += ' bg-pink-900/60 text-pink-200 cursor-pointer hover:bg-pink-700'
        // Intensidad del tremor como opacidad del borde.
        const intensity = Math.min(1, tremor / 100)
        style = { ...style, borderColor: `rgba(236, 72, 153, ${intensity})`, borderWidth: 1, borderStyle: 'solid' }
      } else {
        cls += ' text-slate-500'
      }
      cells.push(
        <div
          key={idx}
          role="gridcell"
          aria-rowindex={r + 1}
          aria-colindex={c + 1}
          aria-selected={isSel}
          className={cls}
          style={style}
          onClick={scary && !bin ? () => onPick(r, c) : undefined}
        >
          {value}
        </div>,
      )
    }
  }
  return (
    <div
      style={{
        position: 'absolute',
        left: tile.originCol * cellSize,
        top: tile.originRow * cellSize,
        width: tile.cols * cellSize,
        height: tile.rows * cellSize,
      }}
    >
      {cells}
    </div>
  )
}
