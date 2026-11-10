import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from 'react'
import { Link, useParams, useSearchParams } from 'react-router-dom'
import { useAuth } from '../auth/AuthContext'
import { apiFetch } from '../lib/apiClient'
import { backoffDelay, errorMessage, isAbortError, isTransient, sleep, withRetry } from '../lib/retry'
import { ApiError } from '../lib/types'
import {
  BIN_CHAR,
  BINS,
  type Bin,
  type Cell,
  type DataFile,
  type RefineResult,
  type Rules,
} from './types'
import { findGroup, isScary, type Group } from './groups'
import { Grid } from './Grid'
import { TileStore } from './tileStore'
import { onLumonEvent } from '../events/eventStream'
import type { Progress } from './types'

const BIN_LABEL: Record<Bin, string> = { WO: 'WO', FC: 'FC', DR: 'DR', MA: 'MA' }
const BIN_COLOR: Record<Bin, string> = {
  WO: 'bg-emerald-500',
  FC: 'bg-sky-500',
  DR: 'bg-violet-500',
  MA: 'bg-rose-500',
}

const GROUP_REASON: Record<string, string> = {
  BELOW_THRESHOLD: 'Alguna celda del grupo no da miedo.',
  NOT_CONNECTED: 'Las celdas no forman un solo grupo conexo.',
  INCOMPLETE: 'El grupo está incompleto. Vuelve a seleccionarlo.',
  SIZE_OUT_OF_RANGE: 'Ese grupo es ruido: su tamaño está fuera del rango permitido.',
}

interface Message {
  kind: 'ok' | 'error' | 'info'
  text: string
}

/** Una intención de refinar = una Idempotency-Key. Se reutiliza en cada reintento. */
interface Intent {
  key: string
  bin: Bin
  cells: Cell[]
}

function clampInt(v: string | null, max: number): number {
  const n = Number(v)
  if (!Number.isInteger(n) || n < 0) return 0
  return Math.min(n, Math.max(0, max - 1))
}

export default function RefinePage() {
  const { id } = useParams()
  const fileId = Number(id)
  const validId = Number.isInteger(fileId) && fileId > 0

  const [file, setFile] = useState<DataFile | null>(null)
  const [rules, setRules] = useState<Rules | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [reload, setReload] = useState(0)

  // --- Cargar archivo + reglas (las reglas cambian por archivo: no se hardcodean)
  useEffect(() => {
    if (!validId) return
    const controller = new AbortController()
    const opts = { signal: controller.signal }
    setLoadError(null)
    Promise.all([
      withRetry(() => apiFetch<DataFile>(`/files/${fileId}`, opts), opts),
      withRetry(() => apiFetch<Rules>(`/files/${fileId}/rules`, opts), opts),
    ])
      .then(([f, r]) => {
        setFile(f)
        setRules(r)
      })
      .catch((err: unknown) => {
        if (isAbortError(err)) return
        setLoadError(
          err instanceof ApiError && err.status === 404 ? 'Ese archivo no existe.' : errorMessage(err),
        )
      })
    return () => controller.abort()
  }, [fileId, validId, reload])

  if (!validId) return <Centered>Ese archivo no existe.</Centered>
  if (loadError) {
    return (
      <Centered>
        <p role="alert">{loadError}</p>
        <div className="mt-3 flex gap-3">
          <button type="button" className="rounded border border-slate-700 px-3 py-1" onClick={() => setReload((n) => n + 1)}>
            Reintentar
          </button>
          <Link to="/files" className="underline">Volver a archivos</Link>
        </div>
      </Centered>
    )
  }
  if (!file || !rules) return <Centered>Cargando archivo…</Centered>

  return <RefineView key={file.id} initialFile={file} rules={rules} />
}

function Centered({ children }: { children: ReactNode }) {
  return (
    <main className="flex min-h-screen flex-col items-center justify-center bg-slate-950 p-4 text-slate-100" aria-live="polite">
      {children}
    </main>
  )
}

function RefineView({ initialFile, rules }: { initialFile: DataFile; rules: Rules }) {
  const { hasPermission } = useAuth()
  const canRefine = hasPermission('files:refine')
  const [file, setFile] = useState(initialFile)
  const [searchParams, setSearchParams] = useSearchParams()

  // Un TileStore por archivo; se libera (cancela todo) al salir.
  const [store] = useState(() => new TileStore(initialFile.id, initialFile.rows, initialFile.cols, initialFile.tileSize))
  useEffect(() => () => store.dispose(), [store])
  const revision = useSyncExternalStore(store.subscribe, store.getRevision)

  // Posicion inicial desde ?r=&c= (saneada).
  const [initial] = useState<Cell>(() => ({
    r: clampInt(searchParams.get('r'), initialFile.rows),
    c: clampInt(searchParams.get('c'), initialFile.cols),
  }))
  const [focus, setFocus] = useState<Cell>(initial)

  // El scroll actualiza la URL con replace: no llena el historial.
  const onScrollPosition = useCallback(
    ({ r, c }: Cell) => {
      setSearchParams(
        (prev) => {
          if (prev.get('r') === String(r) && prev.get('c') === String(c)) return prev
          const next = new URLSearchParams(prev)
          next.set('r', String(r))
          next.set('c', String(c))
          return next
        },
        { replace: true },
      )
    },
    [setSearchParams],
  )

  // --- Seleccion de grupo ------------------------------------------------------
  const [group, setGroup] = useState<Group | null>(null)
  const [searching, setSearching] = useState(false)
  const [message, setMessage] = useState<Message | null>(null)
  const selectAbort = useRef<AbortController | null>(null)

  const selected = useMemo(() => {
    const s = new Set<number>()
    if (group) for (const { r, c } of group.cells) s.add(r * file.cols + c)
    return s
  }, [group, file.cols])

  const clearSelection = useCallback(() => {
    selectAbort.current?.abort()
    setGroup(null)
    setSearching(false)
  }, [])

  const onActivate = useCallback(
    async (cell: Cell) => {
      const data = store.getCell(cell.r, cell.c)
      if (!data) {
        setMessage({ kind: 'info', text: 'Ese bloque todavía se está cargando.' })
        return
      }
      if (data.bin !== '.') {
        setMessage({ kind: 'info', text: 'Esa celda ya fue refinada.' })
        return
      }
      if (!isScary(data.tremor, rules)) {
        clearSelection()
        return
      }
      selectAbort.current?.abort()
      const ctrl = new AbortController()
      selectAbort.current = ctrl
      setSearching(true)
      setMessage(null)
      try {
        const g = await findGroup(store, rules, cell, ctrl.signal)
        if (ctrl.signal.aborted) return
        setGroup(g)
      } catch (err) {
        if (!isAbortError(err)) setMessage({ kind: 'error', text: `No se pudo cargar el grupo: ${errorMessage(err)}` })
      } finally {
        if (selectAbort.current === ctrl) setSearching(false)
      }
    },
    [store, rules, clearSelection],
  )

  // --- Refinar (Regla de Kier) ---------------------------------------------------
  // intentRef bloquea el doble clic / doble Enter: mientras haya una intención
  // en curso no se crea otra. Los reintentos usan la MISMA Idempotency-Key, asi
  // si la respuesta se perdio (503 con caos) el backend devuelve la guardada.
  const intentRef = useRef<Intent | null>(null)
  const [sending, setSending] = useState(false)
  const [stuckIntent, setStuckIntent] = useState<Intent | null>(null)
  const [dragHover, setDragHover] = useState<Bin | null>(null)
  const [showComplete, setShowComplete] = useState(initialFile.status === 'COMPLETE')

  // CP5: la grilla refleja los eventos sin recargar.
  useEffect(
    () =>
      onLumonEvent((evt) => {
        const d = (evt.data ?? {}) as { fileId?: number; cells?: Cell[]; bin?: Bin; progress?: Progress }
        if (evt.event === 'refinement.created' && d.fileId === initialFile.id && d.cells && d.bin) {
          store.markRefined(d.cells, BIN_CHAR[d.bin])
          const progress = d.progress
          if (progress) setFile((f) => ({ ...f, progress }))
        } else if (evt.event === 'file.completed' && d.fileId === initialFile.id) {
          setFile((f) => ({ ...f, status: 'COMPLETE' }))
          setShowComplete(true)
        } else if (evt.event === 'stream.reset') {
          store.invalidateAll()
        }
      }),
    [store, initialFile.id],
  )

  const send = useCallback(
    async (intent: Intent) => {
      setSending(true)
      setStuckIntent(null)
      try {
        for (let attempt = 0; ; attempt++) {
          try {
            const res = await apiFetch<RefineResult>(`/files/${file.id}/refinements`, {
              method: 'POST',
              body: { bin: intent.bin, cells: intent.cells },
              extraHeaders: { 'Idempotency-Key': intent.key },
            })
            // Exito: marcar celdas sin volver a pedir la grilla y actualizar progreso.
            store.markRefined(intent.cells, BIN_CHAR[intent.bin])
            setFile((f) => ({ ...f, ...res.file }))
            setGroup(null)
            setMessage({ kind: 'ok', text: `Grupo de ${res.size} celdas llevado a ${res.bin}.` })
            if (res.file.status === 'COMPLETE') setShowComplete(true)
            intentRef.current = null
            return
          } catch (err) {
            if (isTransient(err) && attempt < 5) {
              setMessage({ kind: 'info', text: 'Lumon no respondió. Reintentando con la misma solicitud…' })
              await sleep(backoffDelay(attempt, err))
              continue
            }
            if (isTransient(err)) {
              // Agotamos reintentos: se conserva la intención (misma key) para reintentar a mano.
              setStuckIntent(intent)
              setMessage({ kind: 'error', text: 'No se pudo confirmar el refinamiento. Reintenta: no se refinará dos veces.' })
              return
            }
            intentRef.current = null
            handleRefineError(err, intent)
            return
          }
        }
      } finally {
        setSending(false)
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [file.id, store],
  )

  const handleRefineError = (err: unknown, intent: Intent) => {
    if (!(err instanceof ApiError)) {
      setMessage({ kind: 'error', text: errorMessage(err) })
      return
    }
    const details = (err.body.details ?? {}) as Record<string, unknown>
    switch (err.body.error) {
      case 'WRONG_BIN': {
        const mistakes = typeof details.mistakes === 'number' ? details.mistakes : undefined
        if (mistakes !== undefined) setFile((f) => ({ ...f, mistakes }))
        setMessage({ kind: 'error', text: `${intent.bin} no es la caja correcta para este grupo. Lumon lo anotó. Prueba con otra caja.` })
        return
      }
      case 'GROUP_INVALID': {
        const reason = typeof details.reason === 'string' ? details.reason : ''
        setMessage({ kind: 'error', text: GROUP_REASON[reason] ?? err.body.message })
        // Nuestros datos del grupo podian estar viejos: refrescar sus bloques.
        if (reason === 'INCOMPLETE') {
          setGroup(null)
          store.invalidate(tilesOf(intent.cells))
        }
        return
      }
      case 'ALREADY_REFINED': {
        const tiles = Array.isArray(details.tiles) ? (details.tiles as [number, number][]) : tilesOf(intent.cells)
        store.invalidate(tiles)
        setGroup(null)
        setMessage({ kind: 'error', text: 'Alguien ya refinó parte de ese grupo. Actualizamos los bloques afectados.' })
        return
      }
      case 'GROUP_CLAIMED': {
        const holder = details.holder as { displayName?: string } | undefined
        setMessage({
          kind: 'error',
          text: `${holder?.displayName ?? 'Otro refinador'} tiene reservado ese grupo. Espera a que lo libere o elige otro.`,
        })
        return
      }
      case 'FORBIDDEN':
        setMessage({ kind: 'error', text: 'No tienes permiso para refinar.' })
        return
      default:
        setMessage({ kind: 'error', text: err.body.message || `Error ${err.status}` })
    }
  }

  const tilesOf = (cells: Cell[]): [number, number][] => {
    const m = new Map<string, [number, number]>()
    for (const { r, c } of cells) {
      const t = store.tileOf(r, c)
      m.set(t.join(':'), t)
    }
    return [...m.values()]
  }

  const onRefine = useCallback(
    (bin: Bin) => {
      if (!canRefine || !group || group.noise || intentRef.current) return
      const intent: Intent = { key: crypto.randomUUID(), bin, cells: group.cells }
      intentRef.current = intent
      void send(intent)
    },
    [canRefine, group, send],
  )

  const discardStuck = () => {
    // Por si la intención sí se guardó: refrescar los bloques del grupo.
    if (stuckIntent) store.invalidate(tilesOf(stuckIntent.cells))
    intentRef.current = null
    setStuckIntent(null)
    setGroup(null)
    setMessage(null)
  }

  const rateLimited = store.rateLimitedUntil > Date.now()
  const canDrop = canRefine && !!group && !group.noise && !sending && !stuckIntent

  return (
    <main className="min-h-screen bg-slate-950 px-4 py-4 text-slate-100">
      <div className="mx-auto max-w-6xl space-y-3">
        <header className="flex flex-wrap items-end justify-between gap-2">
          <div>
            <Link to="/files" className="text-sm text-slate-400 underline">← Archivos</Link>
            <h1 className="text-xl font-semibold">{file.name}</h1>
            <p className="text-sm text-slate-400">
              {file.rows} × {file.cols} · {file.refinedGroups}/{file.totalGroups} grupos · {file.mistakes} errores ·
              {' '}umbral {rules.tremorThreshold}, conectividad {rules.connectivity}, tamaño {rules.minGroupSize}–{rules.maxGroupSize}
            </p>
          </div>
          <p className="text-sm text-slate-400" aria-live="polite">
            {rateLimited ? 'Demasiados pedidos: esperando a Lumon…' : `Total ${Math.round(file.progress.overall * 100)}%`}
          </p>
        </header>

        <div className="grid gap-3 lg:grid-cols-[1fr_260px]">
          <Grid
            store={store}
            rules={rules}
            revision={revision}
            focus={focus}
            onFocusChange={setFocus}
            selected={selected}
            onActivate={(c) => void onActivate(c)}
            onRefine={onRefine}
            onClearSelection={clearSelection}
            onDragHover={setDragHover}
            initial={initial}
            onScrollPosition={onScrollPosition}
          />

          <aside className="space-y-3">
            <section className="rounded border border-slate-800 bg-slate-900 p-3 text-sm" aria-live="polite">
              <h2 className="mb-1 font-semibold">Grupo seleccionado</h2>
              {searching && <p>Buscando el grupo completo…</p>}
              {!searching && !group && (
                <p className="text-slate-400">Elige una celda que dé miedo (clic o Enter).</p>
              )}
              {!searching && group && (
                <>
                  <p>
                    {group.truncated ? `Más de ${rules.maxGroupSize}` : group.cells.length} celdas
                  </p>
                  {group.noise ? (
                    <p className="text-amber-300">Es ruido: no se puede refinar.</p>
                  ) : (
                    <p>
                      Caja según las reglas: <strong>{group.bin}</strong>
                    </p>
                  )}
                  {!group.noise && canRefine && (
                    <p className="mt-1 text-xs text-slate-400">
                      Arrástralo a una caja o presiona 1-4. Esc cancela.
                    </p>
                  )}
                </>
              )}
              {!canRefine && <p className="mt-1 text-xs text-amber-300">Tu rol no tiene permiso para refinar.</p>}
            </section>

            <section aria-label="Cajas" className="grid grid-cols-2 gap-2">
              {BINS.map((bin, i) => {
                const pct = Math.round(file.progress[bin] * 100)
                return (
                  <button
                    key={bin}
                    type="button"
                    data-bin={bin}
                    disabled={!canDrop}
                    onClick={() => onRefine(bin)}
                    aria-label={`Llevar el grupo a ${bin} (tecla ${i + 1}). Progreso ${pct}%`}
                    className={`rounded border p-2 text-left text-sm transition-colors disabled:opacity-50 ${
                      dragHover === bin ? 'border-yellow-300 bg-slate-700' : 'border-slate-700 bg-slate-900'
                    } ${group?.bin === bin && canDrop ? 'ring-1 ring-slate-400' : ''}`}
                  >
                    <span className="flex justify-between font-semibold">
                      <span>{BIN_LABEL[bin]}</span>
                      <span className="text-xs text-slate-400">{i + 1}</span>
                    </span>
                    <span className="mt-1 block h-2 overflow-hidden rounded bg-slate-800" aria-hidden="true">
                      <span className={`block h-full ${BIN_COLOR[bin]}`} style={{ width: `${pct}%` }} />
                    </span>
                    <span className="text-xs text-slate-400">{pct}%</span>
                  </button>
                )
              })}
            </section>

            {sending && <p className="text-sm text-slate-300" aria-live="polite">Refinando…</p>}
            {message && (
              <p
                role={message.kind === 'error' ? 'alert' : 'status'}
                className={`rounded p-2 text-sm ${
                  message.kind === 'error' ? 'bg-red-950 text-red-200' : message.kind === 'ok' ? 'bg-emerald-950 text-emerald-200' : 'bg-slate-800'
                }`}
              >
                {message.text}
              </p>
            )}
            {stuckIntent && !sending && (
              <div className="flex gap-2">
                <button type="button" className="rounded border border-slate-600 px-3 py-1 text-sm" onClick={() => void send(stuckIntent)}>
                  Reintentar
                </button>
                <button type="button" className="rounded px-3 py-1 text-sm underline" onClick={discardStuck}>
                  Descartar
                </button>
              </div>
            )}
          </aside>
        </div>
      </div>

      {showComplete && (
        <div className="fixed inset-0 z-40 flex items-center justify-center bg-black/70 p-4">
          <div role="dialog" aria-modal="true" aria-labelledby="done-title" className="max-w-sm rounded border border-emerald-700 bg-slate-900 p-6 text-center">
            <h2 id="done-title" className="text-xl font-semibold text-emerald-300">Archivo completado</h2>
            <p className="mt-2 text-sm text-slate-300">
              {file.name}: {file.totalGroups} grupos refinados con {file.mistakes} errores.
            </p>
            <div className="mt-4 flex justify-center gap-3">
              <Link to="/files" className="rounded bg-emerald-600 px-3 py-1 text-sm" autoFocus>
                Volver a archivos
              </Link>
              <button type="button" className="rounded border border-slate-600 px-3 py-1 text-sm" onClick={() => setShowComplete(false)}>
                Ver la grilla
              </button>
            </div>
          </div>
        </div>
      )}
    </main>
  )
}
