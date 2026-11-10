import { useEffect, useState, type FormEvent, type ReactNode } from 'react'
import { Link, useParams } from 'react-router-dom'
import { apiFetch } from '../lib/apiClient'
import { listDepartments, type Department, type Refiner } from '../lib/refiners'
import { isAbortError, withRetry } from '../lib/retry'
import { ApiError } from '../lib/types'

// Regla de Milchick: nunca se sobrescribe lo que no se ha leido.
// PATCH /refiners/{id} con If-Match = ETag exacto ("<version>"). Nunca "*".
// Ante 412 VERSION_CONFLICT: pantalla de conflicto campo por campo.

interface Draft {
  title: string
  extension: string
  bio: string
  departmentId: number
}

const FIELDS: Array<{ key: keyof Draft; label: string }> = [
  { key: 'title', label: 'Título' },
  { key: 'extension', label: 'Anexo' },
  { key: 'bio', label: 'Biografía' },
  { key: 'departmentId', label: 'Departamento' },
]

const toDraft = (r: Refiner): Draft => ({ title: r.title, extension: r.extension, bio: r.bio, departmentId: r.department.id })
const etagOf = (r: Refiner) => `"${r.version}"`

function isConflict(err: unknown): err is ApiError & { body: { details: { current: Refiner } } } {
  if (!(err instanceof ApiError) || !err.is('VERSION_CONFLICT')) return false
  const d = err.body.details
  return typeof d === 'object' && d !== null && 'current' in d
}

export function RefinerEditPage() {
  const { id } = useParams()
  const refinerId = Number(id)
  const [base, setBase] = useState<Refiner | null>(null)
  const [draft, setDraft] = useState<Draft | null>(null)
  const [departments, setDepartments] = useState<Department[]>([])
  const [loadError, setLoadError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const [message, setMessage] = useState<{ kind: 'ok' | 'error'; text: string } | null>(null)
  const [conflict, setConflict] = useState<Refiner | null>(null)

  useEffect(() => {
    if (!Number.isInteger(refinerId) || refinerId < 1) return
    const controller = new AbortController()
    const opts = { signal: controller.signal }
    Promise.all([
      withRetry(() => apiFetch<Refiner>(`/refiners/${refinerId}`, opts), opts),
      withRetry(() => listDepartments(controller.signal), opts),
    ])
      .then(([refiner, depts]) => {
        setBase(refiner)
        setDraft(toDraft(refiner))
        setDepartments(depts)
      })
      .catch((err: unknown) => {
        if (isAbortError(err)) return
        setLoadError(err instanceof ApiError ? `Error ${err.status}: ${err.body.message}` : 'No se pudo conectar con Lumon.')
      })
    return () => controller.abort()
  }, [refinerId])

  if (!Number.isInteger(refinerId) || refinerId < 1) return <Shell><p role="alert">Expediente inválido.</p></Shell>
  if (loadError) return <Shell><p role="alert" className="text-red-300">{loadError}</p></Shell>
  if (!base || !draft) return <Shell><p aria-live="polite">Cargando expediente…</p></Shell>

  const save = async (values: Draft, against: Refiner) => {
    setSaving(true)
    setMessage(null)
    const initial = toDraft(against)
    const patch: Partial<Draft> = {}
    for (const { key } of FIELDS) if (values[key] !== initial[key]) Object.assign(patch, { [key]: values[key] })
    if (Object.keys(patch).length === 0) {
      setSaving(false)
      setMessage({ kind: 'ok', text: 'No hay cambios que guardar.' })
      return
    }
    try {
      const updated = await withRetry(() =>
        apiFetch<Refiner>(`/refiners/${refinerId}`, { method: 'PATCH', body: patch, extraHeaders: { 'If-Match': etagOf(against) } }),
      )
      setBase(updated)
      setDraft(toDraft(updated))
      setConflict(null)
      setMessage({ kind: 'ok', text: `Guardado (versión ${updated.version}).` })
    } catch (err) {
      if (isConflict(err)) {
        // Nunca sobrescribir en silencio: mostrar el conflicto y dejar elegir.
        setConflict(err.body.details.current)
      } else if (err instanceof ApiError && err.is('VALIDATION_ERROR')) {
        setMessage({ kind: 'error', text: 'Datos inválidos: revisen el anexo (3 a 6 dígitos) y el título.' })
      } else {
        setMessage({ kind: 'error', text: err instanceof ApiError ? `Error ${err.status}: ${err.body.message}` : 'No se pudo conectar con Lumon.' })
      }
    } finally {
      setSaving(false)
    }
  }

  const onSubmit = (e: FormEvent) => {
    e.preventDefault()
    void save(draft, base)
  }

  const deptName = (deptId: number) => departments.find((d) => d.id === deptId)?.name ?? `#${deptId}`
  const show = (key: keyof Draft, values: Draft) => (key === 'departmentId' ? deptName(values.departmentId) : String(values[key]))

  if (conflict) {
    const server = toDraft(conflict)
    return (
      <Shell>
        <h1 className="text-2xl font-semibold">Conflicto de versión</h1>
        <p role="alert" className="text-amber-300">
          Alguien modificó este expediente (ahora versión {conflict.version}) mientras lo editaban. Elijan qué valor conservar en cada campo.
        </p>
        <table className="w-full text-left text-sm">
          <thead>
            <tr><th className="p-2">Campo</th><th className="p-2">Lo que escribieron</th><th className="p-2">En el servidor</th></tr>
          </thead>
          <tbody>
            {FIELDS.map(({ key, label }) => (
              <tr key={key} className={draft[key] !== server[key] ? 'bg-amber-950' : ''}>
                <th scope="row" className="p-2">{label}</th>
                <td className="whitespace-pre-line break-words p-2">{show(key, draft)}</td>
                <td className="whitespace-pre-line break-words p-2">{show(key, server)}</td>
              </tr>
            ))}
          </tbody>
        </table>
        <div className="flex flex-wrap gap-2">
          <button type="button" disabled={saving} onClick={() => void save(draft, conflict)} className="rounded bg-sky-700 px-3 py-2 disabled:opacity-50">
            Guardar mis cambios sobre la versión {conflict.version}
          </button>
          <button
            type="button"
            onClick={() => {
              setBase(conflict)
              setDraft(server)
              setConflict(null)
            }}
            className="rounded border border-slate-600 px-3 py-2"
          >
            Descartar mis cambios y usar la del servidor
          </button>
        </div>
      </Shell>
    )
  }

  return (
    <Shell>
      <h1 className="text-2xl font-semibold">Editar expediente: {base.fullName}</h1>
      <p className="text-sm text-slate-400">Versión {base.version}</p>
      <form onSubmit={onSubmit} className="space-y-3">
        <label className="block">
          <span className="text-sm text-slate-300">Título</span>
          <input value={draft.title} maxLength={200} onChange={(e) => setDraft({ ...draft, title: e.target.value })} className="mt-1 w-full rounded border border-slate-700 bg-slate-950 px-3 py-2" />
        </label>
        <label className="block">
          <span className="text-sm text-slate-300">Anexo (3 a 6 dígitos)</span>
          <input value={draft.extension} inputMode="numeric" onChange={(e) => setDraft({ ...draft, extension: e.target.value })} className="mt-1 w-full rounded border border-slate-700 bg-slate-950 px-3 py-2" />
        </label>
        <label className="block">
          <span className="text-sm text-slate-300">Departamento</span>
          <select value={String(draft.departmentId)} onChange={(e) => setDraft({ ...draft, departmentId: Number(e.target.value) })} className="mt-1 w-full rounded border border-slate-700 bg-slate-950 px-3 py-2">
            {departments.map((d) => <option key={d.id} value={String(d.id)}>{d.name}</option>)}
          </select>
        </label>
        <label className="block">
          <span className="text-sm text-slate-300">Biografía</span>
          <textarea value={draft.bio} maxLength={2000} rows={4} onChange={(e) => setDraft({ ...draft, bio: e.target.value })} className="mt-1 w-full rounded border border-slate-700 bg-slate-950 px-3 py-2" />
        </label>
        <button type="submit" disabled={saving} className="rounded bg-sky-700 px-4 py-2 disabled:opacity-50">
          {saving ? 'Guardando…' : 'Guardar'}
        </button>
      </form>
      {message && <p role={message.kind === 'error' ? 'alert' : 'status'} className={message.kind === 'error' ? 'text-red-300' : 'text-emerald-300'}>{message.text}</p>}
    </Shell>
  )
}

function Shell({ children }: { children: ReactNode }) {
  return (
    <main className="min-h-screen bg-slate-950 px-4 py-8 text-slate-100">
      <div className="mx-auto max-w-2xl space-y-4">
        <Link to="/refiners" className="text-sm text-sky-300 underline">← Volver al directorio</Link>
        {children}
      </div>
    </main>
  )
}
