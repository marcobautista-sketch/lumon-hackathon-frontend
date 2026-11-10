import { useEffect, useRef, useState } from 'react'
import { Link, useSearchParams } from 'react-router-dom'
import { apiFetch } from '../lib/apiClient'
import { errorMessage, isAbortError, withRetry } from '../lib/retry'
import type { FilePage, FileStatus } from '../refine/types'

// ---------------------------------------------------------------------------
// Estado de la vista = la URL. Nada de useState para page/size/status/q/sort:
// asi recargar, compartir el link o usar atras/adelante muestra lo mismo.
// ---------------------------------------------------------------------------

const SIZES = [10, 25, 50] as const
const SORTS = [
  { value: 'updatedAt,desc', label: 'Más recientes' },
  { value: 'progress,desc', label: 'Mayor progreso' },
  { value: 'name,asc', label: 'Nombre (A-Z)' },
] as const
const STATUSES: { value: '' | FileStatus; label: string }[] = [
  { value: '', label: 'Todos' },
  { value: 'ACTIVE', label: 'Activos' },
  { value: 'COMPLETE', label: 'Completos' },
]

interface Query {
  page: number
  size: number
  status: '' | FileStatus
  q: string
  sort: string
}

/**
 * Lee la URL y la "sanea": cualquier valor invalido cae al default. Asi una
 * URL rota (?page=-3&size=999) nunca rompe la vista ni provoca un 400.
 */
function parseQuery(sp: URLSearchParams): Query {
  const pageN = Number(sp.get('page'))
  const sizeN = Number(sp.get('size'))
  const status = sp.get('status')
  const sort = sp.get('sort')
  return {
    page: Number.isInteger(pageN) && pageN >= 0 ? pageN : 0,
    size: (SIZES as readonly number[]).includes(sizeN) ? sizeN : 10,
    status: status === 'ACTIVE' || status === 'COMPLETE' ? status : '',
    q: (sp.get('q') ?? '').slice(0, 60),
    sort: SORTS.some((s) => s.value === sort) ? (sort as string) : 'updatedAt,desc',
  }
}

/** Query -> URLSearchParams, omitiendo los defaults para URLs limpias. */
function toParams(q: Query): URLSearchParams {
  const sp = new URLSearchParams()
  if (q.page !== 0) sp.set('page', String(q.page))
  if (q.size !== 10) sp.set('size', String(q.size))
  if (q.status) sp.set('status', q.status)
  if (q.q) sp.set('q', q.q)
  if (q.sort !== 'updatedAt,desc') sp.set('sort', q.sort)
  return sp
}

export default function FilesPage() {
  const [searchParams, setSearchParams] = useSearchParams()
  const query = parseQuery(searchParams)
  const canonical = toParams(query).toString()

  // Si la URL traia basura, la reemplazamos por la version saneada (replace:
  // no ensucia el historial).
  useEffect(() => {
    if (searchParams.toString() !== canonical) {
      setSearchParams(new URLSearchParams(canonical), { replace: true })
    }
  }, [searchParams, canonical, setSearchParams])

  const update = (patch: Partial<Query>, opts?: { replace?: boolean }) => {
    // Cambiar un filtro vuelve a la pagina 0 (salvo que el patch traiga page).
    const next = { ...query, page: 0, ...patch }
    setSearchParams(toParams(next), opts)
  }

  // --- Busqueda con debounce ------------------------------------------------
  // El input tiene su propio estado (lo que el usuario teclea) y recien a los
  // 350 ms sin teclear se escribe en la URL -> una sola request, no una por tecla.
  const [searchText, setSearchText] = useState(query.q)
  const lastPushedQ = useRef(query.q)

  // Si la URL cambia desde afuera (atras/adelante), sincronizar el input.
  useEffect(() => {
    if (query.q !== lastPushedQ.current) {
      lastPushedQ.current = query.q
      setSearchText(query.q)
    }
  }, [query.q])

  useEffect(() => {
    const text = searchText.trim().slice(0, 60)
    if (text === query.q) return
    const t = setTimeout(() => {
      lastPushedQ.current = text
      // replace: escribir no llena el historial con cada palabra.
      update({ q: text }, { replace: true })
    }, 350)
    return () => clearTimeout(t)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [searchText])

  // --- Carga de datos ---------------------------------------------------------
  const [data, setData] = useState<FilePage | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [reloadTick, setReloadTick] = useState(0)

  useEffect(() => {
    // Regla del Tablero: una respuesta vieja nunca pisa a una nueva.
    // Cada cambio de query aborta la request anterior; ademas el cleanup
    // marca `stale` por si la respuesta ya estaba llegando.
    const controller = new AbortController()
    let stale = false
    setLoading(true)
    setError(null)

    const path = `/files${canonical ? `?${canonical}` : ''}`
    withRetry(() => apiFetch<FilePage>(path, { signal: controller.signal }), {
      signal: controller.signal,
    })
      .then((res) => {
        if (stale) return
        setData(res)
        setLoading(false)
        // Pagina fuera de rango (ej. ?page=99): ir a la ultima que existe.
        if (res.totalPages > 0 && query.page >= res.totalPages) {
          update({ page: res.totalPages - 1 }, { replace: true })
        }
      })
      .catch((err: unknown) => {
        if (stale || isAbortError(err)) return
        setError(errorMessage(err))
        setLoading(false)
      })

    return () => {
      stale = true
      controller.abort()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [canonical, reloadTick])

  const totalPages = data?.totalPages ?? 0

  return (
    <main className="min-h-screen bg-slate-950 px-4 py-6 text-slate-100">
      <div className="mx-auto max-w-5xl space-y-4">
        <header className="flex flex-wrap items-center justify-between gap-2">
          <div>
            <Link to="/" className="text-sm text-slate-400 underline">
              ← Inicio
            </Link>
            <h1 className="text-2xl font-semibold">Archivos de datos</h1>
          </div>
        </header>

        <form
          role="search"
          className="grid gap-3 rounded border border-slate-800 bg-slate-900 p-3 sm:grid-cols-4"
          onSubmit={(e) => e.preventDefault()}
        >
          <label className="flex flex-col gap-1 text-sm sm:col-span-2">
            Buscar
            <input
              type="search"
              value={searchText}
              maxLength={60}
              onChange={(e) => setSearchText(e.target.value)}
              placeholder="Nombre del archivo"
              className="rounded border border-slate-700 bg-slate-950 px-2 py-1"
            />
          </label>
          <label className="flex flex-col gap-1 text-sm">
            Estado
            <select
              value={query.status}
              onChange={(e) => update({ status: e.target.value as Query['status'] })}
              className="rounded border border-slate-700 bg-slate-950 px-2 py-1"
            >
              {STATUSES.map((s) => (
                <option key={s.value} value={s.value}>
                  {s.label}
                </option>
              ))}
            </select>
          </label>
          <label className="flex flex-col gap-1 text-sm">
            Orden
            <select
              value={query.sort}
              onChange={(e) => update({ sort: e.target.value })}
              className="rounded border border-slate-700 bg-slate-950 px-2 py-1"
            >
              {SORTS.map((s) => (
                <option key={s.value} value={s.value}>
                  {s.label}
                </option>
              ))}
            </select>
          </label>
        </form>

        <section aria-busy={loading} aria-live="polite" className="space-y-2">
          {error && (
            <div role="alert" className="flex items-center justify-between rounded border border-red-800 bg-red-950 p-3 text-sm">
              <span>{error}</span>
              <button
                type="button"
                onClick={() => setReloadTick((n) => n + 1)}
                className="rounded border border-red-700 px-2 py-1"
              >
                Reintentar
              </button>
            </div>
          )}

          {loading && !data && <p className="text-slate-400">Cargando archivos…</p>}

          {data && data.content.length === 0 && !loading && (
            <p className="text-slate-400">No hay archivos que coincidan.</p>
          )}

          {data && data.content.length > 0 && (
            <div className={`overflow-x-auto ${loading ? 'opacity-60' : ''}`}>
              <table className="w-full min-w-[640px] text-left text-sm">
                <caption className="sr-only">Archivos de datos</caption>
                <thead className="text-slate-400">
                  <tr>
                    <th scope="col" className="p-2">Nombre</th>
                    <th scope="col" className="p-2">Estado</th>
                    <th scope="col" className="p-2">Progreso</th>
                    <th scope="col" className="p-2">Grupos</th>
                    <th scope="col" className="p-2">Errores</th>
                    <th scope="col" className="p-2">Actualizado</th>
                  </tr>
                </thead>
                <tbody>
                  {data.content.map((f) => {
                    const pct = Math.round(f.progress.overall * 100)
                    return (
                      <tr key={f.id} className="border-t border-slate-800">
                        <td className="p-2">
                          {/* React escapa el texto: un nombre con HTML se ve como texto. */}
                          <Link to={`/files/${f.id}/refine`} className="text-sky-300 underline">
                            {f.name}
                          </Link>
                          <div className="text-xs text-slate-500">
                            {f.rows} × {f.cols}
                          </div>
                        </td>
                        <td className="p-2">{f.status === 'COMPLETE' ? 'Completo' : 'Activo'}</td>
                        <td className="p-2">
                          <div className="flex items-center gap-2">
                            <div
                              className="h-2 w-24 overflow-hidden rounded bg-slate-800"
                              role="progressbar"
                              aria-valuenow={pct}
                              aria-valuemin={0}
                              aria-valuemax={100}
                              aria-label={`Progreso de ${f.name}`}
                            >
                              <div className="h-full bg-emerald-500" style={{ width: `${pct}%` }} />
                            </div>
                            <span>{pct}%</span>
                          </div>
                        </td>
                        <td className="p-2">
                          {f.refinedGroups}/{f.totalGroups}
                        </td>
                        <td className="p-2">{f.mistakes}</td>
                        <td className="p-2 text-slate-400">
                          {new Date(f.updatedAt).toLocaleString()}
                        </td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </div>
          )}
        </section>

        <nav aria-label="Paginación" className="flex flex-wrap items-center justify-between gap-3 text-sm">
          <div className="flex items-center gap-2">
            <button
              type="button"
              disabled={query.page <= 0 || loading}
              onClick={() => update({ page: query.page - 1 })}
              className="rounded border border-slate-700 px-3 py-1 disabled:opacity-40"
            >
              Anterior
            </button>
            <span>
              Página {totalPages === 0 ? 0 : query.page + 1} de {totalPages}
              {data && ` · ${data.totalElements} archivos`}
            </span>
            <button
              type="button"
              disabled={query.page + 1 >= totalPages || loading}
              onClick={() => update({ page: query.page + 1 })}
              className="rounded border border-slate-700 px-3 py-1 disabled:opacity-40"
            >
              Siguiente
            </button>
          </div>
          <label className="flex items-center gap-2">
            Por página
            <select
              value={query.size}
              onChange={(e) => update({ size: Number(e.target.value) })}
              className="rounded border border-slate-700 bg-slate-950 px-2 py-1"
            >
              {SIZES.map((s) => (
                <option key={s} value={s}>
                  {s}
                </option>
              ))}
            </select>
          </label>
        </nav>
      </div>
    </main>
  )
}
