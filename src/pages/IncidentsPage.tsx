import { useEffect, useState } from 'react'
import { Link, useSearchParams } from 'react-router-dom'
import { apiFetch } from '../lib/apiClient'
import { safeHttpUrl, type PageResponse } from '../lib/refiners'
import { isAbortError, withRetry } from '../lib/retry'
import { ApiError } from '../lib/types'

interface Incident {
  id: number
  title: string
  description: string
  severity: 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL'
  file: { id: number; name: string } | null
  photos: Array<{ mediaId: number; url: string; width: number; height: number }>
  createdBy: { id: number; displayName: string }
  createdAt: string
}

/** /incidents: reportes con sus fotos. Pagina en la URL (?page=1-based). */
export function IncidentsPage() {
  const [params, setParams] = useSearchParams()
  const raw = Number(params.get('page'))
  const page = Number.isInteger(raw) && raw >= 1 ? raw - 1 : 0
  const [result, setResult] = useState<{ page: number; data: PageResponse<Incident> | null; error: string | null }>({ page: -1, data: null, error: null })

  useEffect(() => {
    const controller = new AbortController()
    withRetry(() => apiFetch<PageResponse<Incident>>(`/incidents?page=${page}&size=10`, { signal: controller.signal }), { signal: controller.signal })
      .then((data) => setResult({ page, data, error: null }))
      .catch((err: unknown) => {
        if (isAbortError(err)) return
        setResult((prev) => ({ page, data: prev.data, error: err instanceof ApiError ? `Error ${err.status}: ${err.body.message}` : 'No se pudo conectar con Lumon.' }))
      })
    return () => controller.abort()
  }, [page])

  const loading = result.page !== page
  const data = result.data

  return (
    <main className="min-h-screen bg-slate-950 px-4 py-8 text-slate-100">
      <div className="mx-auto max-w-3xl space-y-4">
        <header className="flex items-center justify-between">
          <h1 className="text-2xl font-semibold">Reportes de incidencia</h1>
          <Link to="/" className="rounded border border-slate-700 px-3 py-1 text-sm">Volver al inicio</Link>
        </header>
        <p aria-live="polite" className="text-sm text-slate-400">{loading ? 'Cargando…' : data ? `${data.totalElements} reporte(s).` : ''}</p>
        {result.error && !loading && <p role="alert" className="text-red-300">{result.error}</p>}
        <ul aria-busy={loading} className="space-y-3">
          {data?.content.map((inc) => (
            <li key={inc.id} className="space-y-2 rounded border border-slate-800 bg-slate-900 p-4">
              <h2 className="break-words text-lg font-medium">{inc.title}</h2>
              <p className="text-xs text-slate-400">
                {inc.severity} · {inc.createdBy.displayName} · {new Date(inc.createdAt).toLocaleString()}
                {inc.file && ` · Archivo ${inc.file.name}`}
              </p>
              <p className="whitespace-pre-line break-words text-sm text-slate-300">{inc.description}</p>
              {inc.photos.length > 0 && (
                <div className="flex flex-wrap gap-2">
                  {inc.photos.map((ph) => {
                    const src = safeHttpUrl(ph.url)
                    return src ? (
                      <img key={ph.mediaId} src={src} alt={`Foto del reporte ${inc.title}`} width={160} height={Math.round((160 * ph.height) / ph.width)} loading="lazy" decoding="async" className="rounded bg-slate-800" />
                    ) : null
                  })}
                </div>
              )}
            </li>
          ))}
        </ul>
        {data && data.totalPages > 1 && (
          <nav aria-label="Paginación" className="flex items-center justify-between">
            <button type="button" disabled={page === 0} onClick={() => setParams({ page: String(page) })} className="rounded border border-slate-700 px-3 py-1 disabled:opacity-40">Anterior</button>
            <span className="text-sm">Página {page + 1} de {data.totalPages}</span>
            <button type="button" disabled={page + 1 >= data.totalPages} onClick={() => setParams({ page: String(page + 2) })} className="rounded border border-slate-700 px-3 py-1 disabled:opacity-40">Siguiente</button>
          </nav>
        )}
      </div>
    </main>
  )
}
