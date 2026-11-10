import { useRef, useState, type FormEvent } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { apiFetch } from '../lib/apiClient'
import { errorMessage, isAbortError, withRetry } from '../lib/retry'
import { ApiError, isValidationError } from '../lib/types'
import {
  canvasToWebp,
  confirmTicket,
  requestTicket,
  sha256Hex,
  uploadToCloudinary,
  type Media,
  type MediaTicket,
  type PreparedImage,
} from './mediaUpload'

// CP4 · /incidents/new — reporte con 1 a 3 fotos.
//  - Las fotos se suben EN PARALELO, cada una con su progreso, cancelar y reintentar.
//  - No se puede enviar hasta que todas esten confirmadas.
//  - Un error al enviar no borra el formulario ni las fotos ya confirmadas.
// Foto INCIDENT: lado mayor entre 800 y 1600, image/webp, <= 300 KB, sin metadatos.

const MAX_PHOTOS = 3
const MAX_BYTES = 307_200
const MIN_LONG = 800
const MAX_LONG = 1600
const SEVERITIES = ['LOW', 'MEDIUM', 'HIGH', 'CRITICAL'] as const
type Severity = (typeof SEVERITIES)[number]
const SEVERITY_LABEL: Record<Severity, string> = { LOW: 'Baja', MEDIUM: 'Media', HIGH: 'Alta', CRITICAL: 'Crítica' }

type PhotoStatus = 'preparing' | 'uploading' | 'confirming' | 'done' | 'error'

interface Photo {
  key: number
  name: string
  previewUrl: string
  status: PhotoStatus
  progress: number
  error: string | null
  file: File
  image?: PreparedImage
  ticket?: MediaTicket
  url?: string
  media?: Media
}

/** Redimensiona (lado mayor entre 800 y 1600) y re-codifica a WebP: sin metadatos. */
async function prepareIncidentImage(file: File): Promise<PreparedImage> {
  const bitmap = await createImageBitmap(file)
  const long = Math.max(bitmap.width, bitmap.height)
  const target = Math.min(MAX_LONG, Math.max(MIN_LONG, long))
  const k = target / long
  const w = Math.max(1, Math.round(bitmap.width * k))
  const h = Math.max(1, Math.round(bitmap.height * k))
  const canvas = document.createElement('canvas')
  canvas.width = w
  canvas.height = h
  const ctx = canvas.getContext('2d')
  if (!ctx) throw new Error('El navegador no permite dibujar en canvas.')
  ctx.imageSmoothingQuality = 'high'
  ctx.drawImage(bitmap, 0, 0, w, h)
  bitmap.close()
  const blob = await canvasToWebp(canvas, MAX_BYTES)
  return { blob, width: w, height: h, sha256: await sha256Hex(blob) }
}

export default function NewIncidentPage() {
  const navigate = useNavigate()
  const [title, setTitle] = useState('')
  const [description, setDescription] = useState('')
  const [severity, setSeverity] = useState<Severity>('MEDIUM')
  const [photos, setPhotos] = useState<Photo[]>([])
  const [submitting, setSubmitting] = useState(false)
  const [submitError, setSubmitError] = useState<string | null>(null)
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({})
  const nextKey = useRef(1)
  const controllers = useRef(new Map<number, AbortController>())
  // Copia mutable para que las subidas en paralelo lean el estado al dia.
  const photosRef = useRef<Photo[]>([])

  const update = (key: number, patch: Partial<Photo>) => {
    photosRef.current = photosRef.current.map((p) => (p.key === key ? { ...p, ...patch } : p))
    setPhotos(photosRef.current)
  }

  /** Sube (o retoma) una foto desde el paso que le falte. */
  async function process(key: number) {
    const controller = new AbortController()
    controllers.current.set(key, controller)
    const get = () => photosRef.current.find((p) => p.key === key)
    try {
      let p = get()
      if (!p) return
      if (!p.image) {
        update(key, { status: 'preparing', error: null })
        update(key, { image: await prepareIncidentImage(p.file) })
        p = get()!
      }
      if (p.ticket && !p.url && new Date(p.ticket.expiresAt).getTime() < Date.now() + 5000) {
        update(key, { ticket: undefined })
        p = get()!
      }
      if (!p.ticket) {
        update(key, { status: 'uploading', progress: 0, error: null })
        const image = p.image!
        update(key, { ticket: await withRetry(() => requestTicket('INCIDENT', image), { signal: controller.signal }) })
        p = get()!
      }
      if (!p.url) {
        update(key, { status: 'uploading', error: null })
        const url = await uploadToCloudinary(p.image!.blob, p.ticket!, (f) => update(key, { progress: f }), controller.signal)
        update(key, { url })
        p = get()!
      }
      if (!p.media) {
        update(key, { status: 'confirming', error: null })
        const ticketId = p.ticket!.ticketId
        const url = p.url!
        update(key, { media: await withRetry(() => confirmTicket(ticketId, url), { signal: controller.signal }) })
      }
      update(key, { status: 'done', progress: 1, error: null })
    } catch (err) {
      if (!get()) return // la foto se quito
      if (err instanceof ApiError && err.is('MEDIA_VERIFICATION_FAILED')) {
        update(key, { image: undefined, ticket: undefined, url: undefined })
      }
      update(key, { status: 'error', error: isAbortError(err) ? 'Subida cancelada.' : errorMessage(err) })
    } finally {
      controllers.current.delete(key)
    }
  }

  function addFiles(files: FileList | File[] | null) {
    if (!files) return
    const room = MAX_PHOTOS - photosRef.current.length
    const images = [...files].filter((f) => f.type.startsWith('image/')).slice(0, Math.max(0, room))
    const added: Photo[] = images.map((file) => ({
      key: nextKey.current++,
      name: file.name,
      previewUrl: URL.createObjectURL(file),
      status: 'preparing',
      progress: 0,
      error: null,
      file,
    }))
    photosRef.current = [...photosRef.current, ...added]
    setPhotos(photosRef.current)
    // En paralelo: cada foto sigue su propio flujo.
    for (const p of added) void process(p.key)
  }

  function removePhoto(key: number) {
    controllers.current.get(key)?.abort()
    const p = photosRef.current.find((x) => x.key === key)
    if (p) URL.revokeObjectURL(p.previewUrl)
    photosRef.current = photosRef.current.filter((x) => x.key !== key)
    setPhotos(photosRef.current)
  }

  const allConfirmed = photos.length >= 1 && photos.every((p) => p.status === 'done' && p.media)
  const canSubmit = allConfirmed && title.trim().length >= 3 && description.trim().length >= 1 && !submitting

  async function onSubmit(e: FormEvent) {
    e.preventDefault()
    if (!canSubmit) return
    setSubmitting(true)
    setSubmitError(null)
    setFieldErrors({})
    try {
      // Con caos, 503 = NO se guardo nada: reintentar es seguro.
      await withRetry(() =>
        apiFetch('/incidents', {
          method: 'POST',
          body: {
            title: title.trim(),
            description: description.trim(),
            severity,
            mediaIds: photos.map((p) => p.media!.mediaId),
          },
        }),
      )
      navigate('/incidents')
    } catch (err) {
      // El formulario y las fotos confirmadas se conservan.
      if (isValidationError(err)) setFieldErrors(err.body.details.fields)
      setSubmitError(errorMessage(err))
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <main className="min-h-screen bg-slate-950 px-4 py-6 text-slate-100">
      <form onSubmit={onSubmit} className="mx-auto max-w-2xl space-y-4" noValidate>
        <header>
          <Link to="/incidents" className="text-sm text-slate-400 underline">← Reportes</Link>
          <h1 className="text-2xl font-semibold">Nuevo reporte de incidencia</h1>
        </header>

        <label className="block text-sm">
          Título
          <input
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            maxLength={120}
            required
            aria-invalid={!!fieldErrors.title}
            className="mt-1 w-full rounded border border-slate-700 bg-slate-900 px-2 py-1"
          />
          {fieldErrors.title && <span className="text-red-300">{fieldErrors.title}</span>}
        </label>

        <label className="block text-sm">
          Descripción
          <textarea
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            maxLength={4000}
            rows={4}
            required
            aria-invalid={!!fieldErrors.description}
            className="mt-1 w-full rounded border border-slate-700 bg-slate-900 px-2 py-1"
          />
          {fieldErrors.description && <span className="text-red-300">{fieldErrors.description}</span>}
        </label>

        <label className="block text-sm">
          Severidad
          <select
            value={severity}
            onChange={(e) => setSeverity(e.target.value as Severity)}
            className="mt-1 block rounded border border-slate-700 bg-slate-900 px-2 py-1"
          >
            {SEVERITIES.map((s) => (
              <option key={s} value={s}>{SEVERITY_LABEL[s]}</option>
            ))}
          </select>
        </label>

        <fieldset className="space-y-2">
          <legend className="text-sm">Fotos (1 a 3)</legend>
          {photos.length < MAX_PHOTOS && (
            <label
              onDragOver={(e) => e.preventDefault()}
              onDrop={(e) => {
                e.preventDefault()
                addFiles(e.dataTransfer.files)
              }}
              className="block cursor-pointer rounded border-2 border-dashed border-slate-700 p-4 text-center text-sm"
            >
              Arrastra fotos aquí o <span className="underline">elígelas</span>
              <input type="file" accept="image/*" multiple className="sr-only" onChange={(e) => addFiles(e.target.files)} />
            </label>
          )}
          <ul className="space-y-2">
            {photos.map((p) => (
              <li key={p.key} className="flex items-center gap-3 rounded border border-slate-800 bg-slate-900 p-2 text-sm">
                <img src={p.previewUrl} alt={`Foto ${p.name}`} width={56} height={56} className="h-14 w-14 rounded object-cover" />
                <div className="min-w-0 flex-1 space-y-1">
                  <p className="truncate">{p.name}</p>
                  <div
                    role="progressbar"
                    aria-label={`Progreso de ${p.name}`}
                    aria-valuemin={0}
                    aria-valuemax={100}
                    aria-valuenow={Math.round(p.progress * 100)}
                    className="h-2 overflow-hidden rounded bg-slate-800"
                  >
                    <div
                      className={`h-full ${p.status === 'error' ? 'bg-red-500' : p.status === 'done' ? 'bg-emerald-500' : 'bg-sky-500'}`}
                      style={{ width: `${Math.round(p.progress * 100)}%` }}
                    />
                  </div>
                  <p aria-live="polite" className={p.error ? 'text-red-300' : 'text-slate-400'}>
                    {p.error ??
                      { preparing: 'Preparando…', uploading: `Subiendo ${Math.round(p.progress * 100)}%`, confirming: 'Verificando…', done: 'Confirmada ✓', error: '' }[p.status]}
                  </p>
                </div>
                <div className="flex flex-col gap-1">
                  {p.status === 'uploading' && (
                    <button type="button" onClick={() => controllers.current.get(p.key)?.abort()} className="rounded border border-slate-600 px-2 py-0.5">
                      Cancelar
                    </button>
                  )}
                  {p.status === 'error' && (
                    <button type="button" onClick={() => void process(p.key)} className="rounded border border-slate-600 px-2 py-0.5">
                      Reintentar
                    </button>
                  )}
                  <button type="button" onClick={() => removePhoto(p.key)} className="px-2 py-0.5 text-slate-400 underline">
                    Quitar
                  </button>
                </div>
              </li>
            ))}
          </ul>
        </fieldset>

        {submitError && <p role="alert" className="rounded bg-red-950 p-2 text-sm text-red-200">{submitError}</p>}
        {!allConfirmed && photos.length > 0 && (
          <p className="text-sm text-slate-400">El reporte se puede enviar cuando todas las fotos estén confirmadas.</p>
        )}
        <button
          type="submit"
          disabled={!canSubmit}
          className="rounded bg-slate-200 px-4 py-2 font-medium text-slate-900 disabled:opacity-50"
        >
          {submitting ? 'Enviando…' : 'Enviar reporte'}
        </button>
      </form>
    </main>
  )
}
