import { useEffect, useRef, useState } from 'react'
import { Link, useSearchParams } from 'react-router-dom'
import { apiFetch } from '../lib/apiClient'
import { ApiError } from '../lib/types'
import type { FilesPage } from '../files/fileTypes'

// CP2 - Listado /files con paginacion, filtros y busqueda, TODO EN LA URL.
// La URL es la unica fuente de verdad: recargar/compartir/atras-adelante
// muestra exactamente lo mismo.

export function FilesListPage() {
  const [params, setParams] = useSearchParams()

  const page = Number(params.get('page') ?? 0)
  const size = Number(params.get('size') ?? 10)
  const status = params.get('status') ?? ''
  const q = params.get('q') ?? ''
  const sort = params.get('sort') ?? 'updatedAt,desc'

  const [data, setData] = useState<FilesPage | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // Draft local para debouncing de la busqueda (evita 1 request por tecla).
  const [qDraft, setQDraft] = useState(q)
  useEffect(() => setQDraft(q), [q])
  useEffect(() => {
    if (qDraft === q) return
    const t = setTimeout(() => patch({ q: qDraft, page: '0' }), 350)
    return () => clearTimeout(t)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [qDraft])

  function patch(next: Record<string, string | null>) {
    const n = new URLSearchParams(params)
    for (const [k, v] of Object.entries(next)) {
      if (v === null || v === '') n.delete(k)
      else n.set(k, v)
    }
    if (!('page' in next)) n.set('page', '0') // cambiar filtros vuelve a la pagina 0
    setParams(n)
  }

  // Cancela respuestas viejas: Regla del Tablero.
  const runId = useRef(0)

  useEffect(() => {
    const controller = new AbortController()
    const myRun = ++runId.current
    setLoading(true)
    setError(null)

    const qs = new URLSearchParams()
    qs.set('page', String(page))
    qs.set('size', String(size))
    if (status) qs.set('status', status)
    if (q) qs.set('q', q)
    if (sort) qs.set('sort', sort)

    apiFetch<FilesPage>(`/files?${qs.toString()}`, { signal: controller.signal })
      .then((res) => {
        if (myRun === runId.current) setData(res)
      })
      .catch((err: unknown) => {
        if ((err as { name?: string }).name === 'AbortError') return
        if (myRun === runId.current) {
          setError(err instanceof ApiError ? err.body.message : 'Error al cargar los archivos.')
        }
      })
      .finally(() => {
        if (myRun === runId.current) setLoading(false)
      })

    return () => controller.abort()
  }, [page, size, status, q, sort])

  return (
    <main className="min-h-screen bg-slate-950 px-4 py-8 text-slate-100">
      <div className="mx-auto max-w-5xl space-y-4">
        <header className="flex items-center justify-between">
          <h1 className="text-2xl font-semibold">Archivos de datos</h1>
          <Link to="/" className="text-sm underline text-slate-400">Volver</Link>
        </header>

        <div className="flex flex-wrap items-center gap-2">
          <input
            type="search"
            placeholder="Buscar..."
            value={qDraft}
            onChange={(e) => setQDraft(e.target.value)}
            aria-label="Buscar archivo"
            className="rounded border border-slate-700 bg-slate-900 px-2 py-1"
          />
          <select
            value={status}
            onChange={(e) => patch({ status: e.target.value })}
            aria-label="Filtrar por estado"
            className="rounded border border-slate-700 bg-slate-900 px-2 py-1"
          >
            <option value="">Todos</option>
            <option value="ACTIVE">Activos</option>
            <option value="COMPLETE">Completos</option>
          </select>
          <select
            value={sort}
            onChange={(e) => patch({ sort: e.target.value })}
            aria-label="Ordenar por"
            className="rounded border border-slate-700 bg-slate-900 px-2 py-1"
          >
            <option value="updatedAt,desc">Actualizados</option>
            <option value="progress,desc">Progreso</option>
            <option value="name,asc">Nombre</option>
          </select>
          <select
            value={String(size)}
            onChange={(e) => patch({ size: e.target.value })}
            aria-label="Tamano de pagina"
            className="rounded border border-slate-700 bg-slate-900 px-2 py-1"
          >
            <option value="10">10</option>
            <option value="20">20</option>
            <option value="50">50</option>
          </select>
          {loading && <span className="text-sm text-slate-400" aria-live="polite">Cargando…</span>}
        </div>

        {error && (
          <p role="alert" className="rounded bg-red-900/40 p-2 text-sm text-red-200">{error}</p>
        )}

        <ul className="space-y-2">
          {data?.content.map((f) => (
            <li key={f.id} className="rounded border border-slate-800 bg-slate-900 p-3">
              <Link to={`/files/${f.id}/refine`} className="block space-y-1">
                <div className="flex items-baseline justify-between">
                  <h2 className="font-medium">{f.name}</h2>
                  <span className="text-xs text-slate-400">
                    {f.rows}×{f.cols} · tile {f.tileSize}
                  </span>
                </div>
                <p className="text-xs text-slate-400">
                  {f.status} · {f.refinedGroups}/{f.totalGroups} grupos ·{' '}
                  {Math.round(f.progress.overall * 100)}% refinado · {f.mistakes} errores
                </p>
                <div className="flex gap-1 text-xs">
                  <span className="rounded bg-sky-800/40 px-2">WO {Math.round(f.progress.WO * 100)}%</span>
                  <span className="rounded bg-emerald-800/40 px-2">FC {Math.round(f.progress.FC * 100)}%</span>
                  <span className="rounded bg-amber-800/40 px-2">DR {Math.round(f.progress.DR * 100)}%</span>
                  <span className="rounded bg-rose-800/40 px-2">MA {Math.round(f.progress.MA * 100)}%</span>
                </div>
              </Link>
            </li>
          ))}
          {!loading && data && data.content.length === 0 && (
            <li className="text-sm text-slate-400">No hay archivos con esos filtros.</li>
          )}
        </ul>

        {data && data.totalPages > 1 && (
          <nav className="flex items-center gap-2 text-sm">
            <button
              type="button"
              disabled={page <= 0}
              onClick={() => patch({ page: String(page - 1) })}
              className="rounded border border-slate-700 px-2 py-1 disabled:opacity-40"
            >
              ← Anterior
            </button>
            <span className="text-slate-400">
              Pagina {page + 1} de {data.totalPages} · {data.totalElements} total
            </span>
            <button
              type="button"
              disabled={page + 1 >= data.totalPages}
              onClick={() => patch({ page: String(page + 1) })}
              className="rounded border border-slate-700 px-2 py-1 disabled:opacity-40"
            >
              Siguiente →
            </button>
          </nav>
        )}
      </div>
    </main>
  )
}
