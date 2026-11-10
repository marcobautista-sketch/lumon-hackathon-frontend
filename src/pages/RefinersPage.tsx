import { useEffect, useMemo, useRef, useState, type FormEvent } from 'react'
import { Link, useSearchParams } from 'react-router-dom'
import { useAuth } from '../auth/AuthContext'
import {
  MAX_QUERY_LENGTH,
  PAGE_SIZES,
  listDepartments,
  listRefiners,
  safeHttpUrl,
  type Department,
  type PageResponse,
  type PageSize,
  type Refiner,
  type RefinersQuery,
} from '../lib/refiners'
import { isAbortError, withRetry } from '../lib/retry'
import { ApiError } from '../lib/types'

const SEARCH_DEBOUNCE_MS = 350
const BADGE_PX = 64

// --- Estado en la URL --------------------------------------------------------
// ?page=<1..N>&size=<10|25|50>&dept=<id>&q=<texto>
// La pagina en la URL es 1-based (legible); la API es 0-based.
// Cualquier valor invalido se normaliza (replace) en vez de romper la vista.

function parseQuery(params: URLSearchParams): RefinersQuery {
  const rawPage = Number(params.get('page'))
  const page = Number.isInteger(rawPage) && rawPage >= 1 ? rawPage - 1 : 0

  const rawSize = Number(params.get('size'))
  const size: PageSize = PAGE_SIZES.find((s) => s === rawSize) ?? PAGE_SIZES[0]

  const rawDept = Number(params.get('dept'))
  const departmentId = params.get('dept') !== null && Number.isInteger(rawDept) && rawDept >= 1 ? rawDept : null

  const q = (params.get('q') ?? '').trim().slice(0, MAX_QUERY_LENGTH)

  return { page, size, departmentId, q }
}

function toSearchParams(query: RefinersQuery): URLSearchParams {
  const params = new URLSearchParams()
  if (query.page > 0) params.set('page', String(query.page + 1))
  if (query.size !== PAGE_SIZES[0]) params.set('size', String(query.size))
  if (query.departmentId !== null) params.set('dept', String(query.departmentId))
  if (query.q) params.set('q', query.q)
  return params
}

type LoadState =
  | { status: 'loading'; data: PageResponse<Refiner> | null }
  | { status: 'ready'; data: PageResponse<Refiner> }
  | { status: 'error'; data: PageResponse<Refiner> | null; message: string }

interface LoadResult {
  key: string
  data: PageResponse<Refiner> | null
  error: string | null
}

function describeError(err: unknown): string {
  if (err instanceof ApiError) {
    if (err.is('CLEARANCE_REQUIRED')) return 'El Piso de Pruebas aún no está abierto para su equipo. Corran la revisión automática en /estado.'
    if (err.status === 403) return 'Su rol no tiene permiso para ver el directorio.'
    if (err.status === 503 || err.status === 429) return 'Lumon está saturado. Intenten de nuevo en unos segundos.'
    if (err.is('VALIDATION_ERROR')) return 'Los filtros no son válidos. Se restablecieron.'
    return `Error ${err.status}: ${err.body.message}`
  }
  return 'No se pudo conectar con Lumon. Revisen su conexión.'
}

export function RefinersPage() {
  const { hasPermission } = useAuth()
  const [searchParams, setSearchParams] = useSearchParams()
  const query = useMemo(() => parseQuery(searchParams), [searchParams])
  const canonical = toSearchParams(query).toString()

  // Normalizar URLs invalidas (?page=abc, ?size=7...) sin agregar historial.
  useEffect(() => {
    if (canonical !== searchParams.toString()) {
      setSearchParams(new URLSearchParams(canonical), { replace: true })
    }
  }, [canonical, searchParams, setSearchParams])

  const updateQuery = (patch: Partial<RefinersQuery>, replace = false) => {
    setSearchParams(toSearchParams({ ...query, ...patch }), { replace })
  }

  // --- Busqueda con debounce (sin una request por tecla) ----------------------
  const [qInput, setQInput] = useState(query.q)
  const [lastUrlQ, setLastUrlQ] = useState(query.q)
  if (query.q !== lastUrlQ) {
    // La URL cambio por atras/adelante o un link: el input la refleja.
    setLastUrlQ(query.q)
    setQInput(query.q)
  }

  const queryRef = useRef(query)
  useEffect(() => {
    queryRef.current = query
  }, [query])
  useEffect(() => {
    const trimmed = qInput.trim().slice(0, MAX_QUERY_LENGTH)
    if (trimmed === queryRef.current.q) return
    const timer = setTimeout(() => {
      setSearchParams(toSearchParams({ ...queryRef.current, q: trimmed, page: 0 }))
    }, SEARCH_DEBOUNCE_MS)
    return () => clearTimeout(timer)
  }, [qInput, setSearchParams])

  const onSubmitSearch = (e: FormEvent) => {
    e.preventDefault()
    updateQuery({ q: qInput.trim().slice(0, MAX_QUERY_LENGTH), page: 0 })
  }

  // --- Departamentos ------------------------------------------------------------
  const [departments, setDepartments] = useState<Department[] | null>(null)
  const [departmentsError, setDepartmentsError] = useState(false)
  useEffect(() => {
    const controller = new AbortController()
    withRetry(() => listDepartments(controller.signal), { signal: controller.signal })
      .then((list) => setDepartments(list))
      .catch((err: unknown) => {
        if (!isAbortError(err)) setDepartmentsError(true)
      })
    return () => controller.abort()
  }, [])

  // --- Expedientes (Regla del Tablero: una respuesta vieja nunca pisa a una nueva)
  // `result.key` dice a que request corresponde lo que hay en pantalla. Si no
  // coincide con la request actual, estamos cargando (se mantiene la data
  // anterior para que el layout no salte).
  const [reloadToken, setReloadToken] = useState(0)
  const requestKey = `${canonical}#${reloadToken}`
  const [result, setResult] = useState<LoadResult>({ key: '', data: null, error: null })
  const requestSeq = useRef(0)

  useEffect(() => {
    const seq = ++requestSeq.current
    const controller = new AbortController()
    const key = `${canonical}#${reloadToken}`
    // `canonical` es un string estable derivado de la URL: el efecto no se
    // dispara por identidad de objeto.
    const current = parseQuery(new URLSearchParams(canonical))

    withRetry(() => listRefiners(current, controller.signal), { signal: controller.signal })
      .then((data) => {
        if (seq !== requestSeq.current) return
        setResult({ key, data, error: null })
      })
      .catch((err: unknown) => {
        if (isAbortError(err) || seq !== requestSeq.current) return
        setResult((prev) => ({ key, data: prev.data, error: describeError(err) }))
      })

    return () => controller.abort()
  }, [canonical, reloadToken])

  const state: LoadState =
    result.key !== requestKey
      ? { status: 'loading', data: result.data }
      : result.error !== null
        ? { status: 'error', data: result.data, message: result.error }
        : result.data
          ? { status: 'ready', data: result.data }
          : { status: 'loading', data: null }

  // Si la pagina pedida quedo fuera de rango (p. ej. tras filtrar), ir a la ultima.
  const data = state.data
  useEffect(() => {
    if (state.status === 'ready' && data && data.totalPages > 0 && query.page >= data.totalPages) {
      setSearchParams(toSearchParams({ ...query, page: data.totalPages - 1 }), { replace: true })
    }
  }, [state.status, data, query, setSearchParams])

  const totalPages = data?.totalPages ?? 0
  const loading = state.status === 'loading'

  return (
    <main className="min-h-screen bg-slate-950 px-4 py-8 text-slate-100">
      <div className="mx-auto max-w-4xl space-y-6">
        <header className="flex flex-wrap items-center justify-between gap-2">
          <div>
            <h1 className="text-2xl font-semibold">Expedientes del personal</h1>
            <p className="text-sm text-slate-400">Directorio de Lumon Industries</p>
          </div>
          <Link to="/" className="rounded border border-slate-700 px-3 py-1 text-sm hover:bg-slate-900">
            Volver al inicio
          </Link>
        </header>

        <section aria-label="Filtros" className="grid gap-3 rounded border border-slate-800 bg-slate-900 p-4 sm:grid-cols-[1fr_auto_auto]">
          <form role="search" onSubmit={onSubmitSearch} className="flex flex-col gap-1">
            <label htmlFor="refiners-q" className="text-sm text-slate-300">
              Buscar por nombre, título o anexo
            </label>
            <input
              id="refiners-q"
              type="search"
              value={qInput}
              maxLength={MAX_QUERY_LENGTH}
              onChange={(e) => setQInput(e.target.value)}
              className="rounded border border-slate-700 bg-slate-950 px-3 py-2 text-slate-100"
              placeholder="Ej. Irving"
            />
          </form>

          <div className="flex flex-col gap-1">
            <label htmlFor="refiners-dept" className="text-sm text-slate-300">
              Departamento
            </label>
            <select
              id="refiners-dept"
              value={query.departmentId === null ? '' : String(query.departmentId)}
              onChange={(e) => updateQuery({ departmentId: e.target.value ? Number(e.target.value) : null, page: 0 })}
              disabled={departments === null && !departmentsError}
              className="rounded border border-slate-700 bg-slate-950 px-3 py-2 text-slate-100"
            >
              <option value="">Todos</option>
              {departments?.map((d) => (
                <option key={d.id} value={String(d.id)}>
                  {d.name}
                </option>
              ))}
              {/* Si la URL trae un departamento que no esta en la lista, igual se muestra. */}
              {query.departmentId !== null && departments && !departments.some((d) => d.id === query.departmentId) && (
                <option value={String(query.departmentId)}>Departamento #{query.departmentId}</option>
              )}
            </select>
            {departmentsError && <p className="text-xs text-amber-300">No se pudieron cargar los departamentos.</p>}
          </div>

          <div className="flex flex-col gap-1">
            <label htmlFor="refiners-size" className="text-sm text-slate-300">
              Por página
            </label>
            <select
              id="refiners-size"
              value={String(query.size)}
              onChange={(e) => updateQuery({ size: Number(e.target.value) as PageSize, page: 0 })}
              className="rounded border border-slate-700 bg-slate-950 px-3 py-2 text-slate-100"
            >
              {PAGE_SIZES.map((s) => (
                <option key={s} value={String(s)}>
                  {s}
                </option>
              ))}
            </select>
          </div>
        </section>

        <div aria-live="polite" className="min-h-6 text-sm text-slate-400">
          {loading && 'Cargando expedientes…'}
          {state.status === 'ready' && `${state.data.totalElements} expediente(s) encontrados.`}
        </div>

        {state.status === 'error' && (
          <div role="alert" className="flex flex-wrap items-center justify-between gap-2 rounded border border-red-800 bg-red-950 p-3 text-red-200">
            <span>{state.message}</span>
            <button
              type="button"
              onClick={() => setReloadToken((n) => n + 1)}
              className="rounded border border-red-700 px-3 py-1 text-sm hover:bg-red-900"
            >
              Reintentar
            </button>
          </div>
        )}

        <ul aria-busy={loading} className={`space-y-3 transition-opacity ${loading ? 'opacity-60' : ''}`}>
          {data?.content.map((refiner) => (
            <RefinerCard key={refiner.id} refiner={refiner} canEdit={hasPermission('refiners:write')} />
          ))}
        </ul>

        {state.status === 'ready' && state.data.content.length === 0 && (
          <p className="rounded border border-slate-800 bg-slate-900 p-4 text-slate-300">No hay expedientes con esos filtros.</p>
        )}

        {totalPages > 1 && (
          <nav aria-label="Paginación" className="flex items-center justify-between gap-2">
            <button
              type="button"
              onClick={() => updateQuery({ page: query.page - 1 })}
              disabled={query.page === 0}
              className="rounded border border-slate-700 px-3 py-1 hover:bg-slate-900 disabled:opacity-40"
            >
              Anterior
            </button>
            <span className="text-sm text-slate-300">
              Página {Math.min(query.page + 1, totalPages)} de {totalPages}
            </span>
            <button
              type="button"
              onClick={() => updateQuery({ page: query.page + 1 })}
              disabled={query.page + 1 >= totalPages}
              className="rounded border border-slate-700 px-3 py-1 hover:bg-slate-900 disabled:opacity-40"
            >
              Siguiente
            </button>
          </nav>
        )}
      </div>
    </main>
  )
}

interface RefinerCardProps {
  refiner: Refiner
  canEdit: boolean
}

function RefinerCard({ refiner, canEdit }: RefinerCardProps) {
  const profileUrl = safeHttpUrl(refiner.profileUrl)
  const badgeUrl = safeHttpUrl(refiner.badge?.url)

  return (
    <li className="flex gap-4 rounded border border-slate-800 bg-slate-900 p-4">
      {/* Tamano fijo: la imagen (o el placeholder) nunca mueve el layout al cargar. */}
      <div className="h-16 w-16 shrink-0 overflow-hidden rounded bg-slate-800" style={{ width: BADGE_PX, height: BADGE_PX }}>
        {badgeUrl ? (
          <img
            src={badgeUrl}
            alt={`Fotocheck de ${refiner.fullName}`}
            width={BADGE_PX}
            height={BADGE_PX}
            loading="lazy"
            decoding="async"
            referrerPolicy="no-referrer"
            className="h-full w-full object-cover"
          />
        ) : (
          <div aria-label="Sin fotocheck" role="img" className="flex h-full w-full items-center justify-center text-xs text-slate-400">
            Sin foto
          </div>
        )}
      </div>

      {/* Todo texto externo va como hijo JSX: React lo escapa (nunca se interpreta HTML). */}
      <div className="min-w-0 flex-1 space-y-1">
        <h2 className="break-words text-lg font-medium">{refiner.fullName}</h2>
        <p className="break-words text-sm text-slate-300">
          {refiner.title} · {refiner.department.name} · Anexo {refiner.extension}
        </p>
        <p className="whitespace-pre-line break-words text-sm text-slate-400">{refiner.bio}</p>
        <div className="flex flex-wrap gap-3 pt-1 text-sm">
          {profileUrl && (
            <a href={profileUrl} target="_blank" rel="noopener noreferrer" className="text-sky-300 underline">
              Perfil externo
            </a>
          )}
          {canEdit && (
            <Link to={`/refiners/${refiner.id}/edit`} className="text-sky-300 underline">
              Editar expediente
            </Link>
          )}
          {canEdit && (
            <Link to={`/refiners/${refiner.id}/badge`} className="text-sky-300 underline">
              Cambiar fotocheck
            </Link>
          )}
        </div>
      </div>
    </li>
  )
}
