import { useCallback, useEffect, useRef, useState, type KeyboardEvent, type PointerEvent } from 'react'
import { Link, useParams } from 'react-router-dom'
import { apiFetch } from '../lib/apiClient'
import { errorMessage, isAbortError, withRetry } from '../lib/retry'
import { ApiError } from '../lib/types'
import { safeHttpUrl, type Refiner } from '../lib/refiners'
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

// CP4 · /refiners/:id/badge — editor de fotocheck.
// Salida exigida: exactamente 512 x 512, image/webp, <= 120 KB, sin metadatos.

const OUT = 512
const MAX_BYTES = 122_880
const VIEW = 288 // lado del recuadro de recorte en pantalla (px)
const MAX_ZOOM = 4

type Stage = 'idle' | 'preparing' | 'ticket' | 'uploading' | 'confirming' | 'saving' | 'done' | 'error' | 'conflict'

const STAGE_LABEL: Record<Stage, string> = {
  idle: '',
  preparing: 'Preparando la imagen…',
  ticket: 'Pidiendo permiso para subir…',
  uploading: 'Subiendo…',
  confirming: 'Lumon está verificando la imagen…',
  saving: 'Guardando el expediente…',
  done: 'Fotocheck actualizado.',
  error: '',
  conflict: '',
}

/** Progreso que se conserva entre reintentos: se retoma desde el paso que falló. */
interface Pipeline {
  image: PreparedImage
  ticket?: MediaTicket
  url?: string
  media?: Media
}

const etagOf = (r: Refiner) => `"${r.version}"`

export default function BadgeEditorPage() {
  const { id } = useParams()
  const refinerId = Number(id)

  // --- Expediente -----------------------------------------------------------------
  const [refiner, setRefiner] = useState<Refiner | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  useEffect(() => {
    const controller = new AbortController()
    withRetry(() => apiFetch<Refiner>(`/refiners/${refinerId}`, { signal: controller.signal }), { signal: controller.signal })
      .then(setRefiner)
      .catch((err: unknown) => {
        if (!isAbortError(err)) setLoadError(err instanceof ApiError && err.status === 404 ? 'Ese expediente no existe.' : errorMessage(err))
      })
    return () => controller.abort()
  }, [refinerId])

  // --- Imagen de origen: selector, arrastrar o pegar ------------------------------
  const [img, setImg] = useState<HTMLImageElement | null>(null)
  const [pickError, setPickError] = useState<string | null>(null)
  const [dragOver, setDragOver] = useState(false)
  const objectUrl = useRef<string | null>(null)

  const loadFile = useCallback((file: File | null | undefined) => {
    setPickError(null)
    if (!file) return
    if (!file.type.startsWith('image/')) {
      setPickError('Ese archivo no es una imagen.')
      return
    }
    if (objectUrl.current) URL.revokeObjectURL(objectUrl.current)
    const url = URL.createObjectURL(file)
    objectUrl.current = url
    const image = new Image()
    image.onload = () => {
      setImg(image)
      setZoom(1)
      setOffset(null)
    }
    image.onerror = () => setPickError('No se pudo leer la imagen.')
    image.src = url
  }, [])

  useEffect(() => () => {
    if (objectUrl.current) URL.revokeObjectURL(objectUrl.current)
  }, [])

  // Pegar desde el portapapeles (Ctrl+V en cualquier parte de la página).
  useEffect(() => {
    const onPaste = (e: ClipboardEvent) => {
      const item = [...(e.clipboardData?.items ?? [])].find((i) => i.type.startsWith('image/'))
      if (item) loadFile(item.getAsFile())
    }
    window.addEventListener('paste', onPaste)
    return () => window.removeEventListener('paste', onPaste)
  }, [loadFile])

  // --- Recorte: escala base "cover" * zoom, y desplazamiento acotado -------------
  const [zoom, setZoom] = useState(1)
  const [offset, setOffset] = useState<{ x: number; y: number } | null>(null)
  const baseScale = img ? VIEW / Math.min(img.naturalWidth, img.naturalHeight) : 1
  const scale = baseScale * zoom
  const dispW = img ? img.naturalWidth * scale : 0
  const dispH = img ? img.naturalHeight * scale : 0

  /** La imagen siempre cubre el recuadro: no quedan bordes vacíos. */
  const clamp = useCallback(
    (x: number, y: number) => ({
      x: Math.min(0, Math.max(VIEW - dispW, x)),
      y: Math.min(0, Math.max(VIEW - dispH, y)),
    }),
    [dispW, dispH],
  )
  const pos = offset ? clamp(offset.x, offset.y) : clamp((VIEW - dispW) / 2, (VIEW - dispH) / 2)

  const applyZoom = (next: number) => {
    const z = Math.min(MAX_ZOOM, Math.max(1, next))
    // Zoom centrado en el medio del recuadro.
    const cx = (VIEW / 2 - pos.x) / scale
    const cy = (VIEW / 2 - pos.y) / scale
    const s2 = baseScale * z
    setZoom(z)
    setOffset({ x: VIEW / 2 - cx * s2, y: VIEW / 2 - cy * s2 })
  }

  const drag = useRef<{ id: number; x: number; y: number; ox: number; oy: number } | null>(null)
  const onPointerDown = (e: PointerEvent<HTMLDivElement>) => {
    if (!img) return
    e.currentTarget.setPointerCapture(e.pointerId)
    drag.current = { id: e.pointerId, x: e.clientX, y: e.clientY, ox: pos.x, oy: pos.y }
  }
  const onPointerMove = (e: PointerEvent<HTMLDivElement>) => {
    const d = drag.current
    if (!d || d.id !== e.pointerId) return
    setOffset(clamp(d.ox + e.clientX - d.x, d.oy + e.clientY - d.y))
  }
  const onPointerUp = () => {
    drag.current = null
  }
  const onCropKey = (e: KeyboardEvent<HTMLDivElement>) => {
    const step = e.shiftKey ? 40 : 10
    const moves: Record<string, [number, number]> = {
      ArrowLeft: [step, 0],
      ArrowRight: [-step, 0],
      ArrowUp: [0, step],
      ArrowDown: [0, -step],
    }
    if (moves[e.key]) {
      const [dx, dy] = moves[e.key]
      setOffset(clamp(pos.x + dx, pos.y + dy))
    } else if (e.key === '+' || e.key === '=') applyZoom(zoom + 0.1)
    else if (e.key === '-') applyZoom(zoom - 0.1)
    else return
    e.preventDefault()
  }

  // --- Subida -------------------------------------------------------------------------
  const [stage, setStage] = useState<Stage>('idle')
  const [progress, setProgress] = useState(0)
  const [error, setError] = useState<string | null>(null)
  const pipeline = useRef<Pipeline | null>(null)
  const abortRef = useRef<AbortController | null>(null)
  const [conflict, setConflict] = useState<Refiner | null>(null)

  const busy = stage !== 'idle' && stage !== 'done' && stage !== 'error' && stage !== 'conflict'

  async function prepare(): Promise<PreparedImage> {
    if (!img) throw new Error('Elige una imagen primero.')
    const canvas = document.createElement('canvas')
    canvas.width = OUT
    canvas.height = OUT
    const ctx = canvas.getContext('2d')
    if (!ctx) throw new Error('El navegador no permite dibujar en canvas.')
    // Rectangulo de la imagen original que se ve en el recuadro.
    const sx = -pos.x / scale
    const sy = -pos.y / scale
    const side = VIEW / scale
    ctx.imageSmoothingQuality = 'high'
    ctx.drawImage(img, sx, sy, side, side, 0, 0, OUT, OUT)
    const blob = await canvasToWebp(canvas, MAX_BYTES)
    return { blob, width: OUT, height: OUT, sha256: await sha256Hex(blob) }
  }

  /** Ejecuta (o retoma) el flujo desde el primer paso que falte. */
  async function run(fresh: boolean) {
    if (!refiner) return
    const controller = new AbortController()
    abortRef.current = controller
    setError(null)
    setConflict(null)
    try {
      if (fresh || !pipeline.current) {
        setStage('preparing')
        pipeline.current = { image: await prepare() }
      }
      const p = pipeline.current
      // Un ticket dura 10 minutos: si vencio, se pide otro.
      if (p.ticket && !p.url && new Date(p.ticket.expiresAt).getTime() < Date.now() + 5000) p.ticket = undefined
      if (!p.ticket) {
        setStage('ticket')
        p.ticket = await withRetry(() => requestTicket('BADGE', p.image), { signal: controller.signal })
      }
      if (!p.url) {
        setStage('uploading')
        setProgress(0)
        p.url = await uploadToCloudinary(p.image.blob, p.ticket, setProgress, controller.signal)
      }
      if (!p.media) {
        setStage('confirming')
        // Confirmar es idempotente: reintentar no duplica.
        p.media = await withRetry(() => confirmTicket(p.ticket!.ticketId, p.url!), { signal: controller.signal })
      }
      await saveBadge(p.media, refiner, controller.signal)
    } catch (err) {
      if (isAbortError(err)) {
        setStage('error')
        setError('Subida cancelada. Puedes reintentar.')
        return
      }
      if (err instanceof ApiError && err.is('MEDIA_VERIFICATION_FAILED')) {
        // La imagen subida no paso la verificacion: hay que empezar de cero.
        pipeline.current = null
      }
      setStage('error')
      setError(errorMessage(err))
    } finally {
      abortRef.current = null
    }
  }

  /** PATCH con If-Match = ETag exacto. Ante 412 se muestra el conflicto: nunca se pisa en silencio. */
  async function saveBadge(media: Media, against: Refiner, signal: AbortSignal) {
    setStage('saving')
    try {
      const updated = await withRetry(
        () =>
          apiFetch<Refiner>(`/refiners/${refinerId}`, {
            method: 'PATCH',
            body: { badgeMediaId: media.mediaId },
            extraHeaders: { 'If-Match': etagOf(against) },
            signal,
          }),
        { signal },
      )
      setRefiner(updated)
      setStage('done')
      pipeline.current = null
    } catch (err) {
      if (err instanceof ApiError && err.status === 412) {
        let current = (err.body.details as { current?: Refiner } | null)?.current ?? null
        if (!current) current = await apiFetch<Refiner>(`/refiners/${refinerId}`).catch(() => null)
        setConflict(current)
        setStage('conflict')
        return
      }
      throw err
    }
  }

  async function applyOverConflict() {
    const p = pipeline.current
    if (!p?.media || !conflict) return
    const controller = new AbortController()
    abortRef.current = controller
    setError(null)
    try {
      setConflict(null)
      await saveBadge(p.media, conflict, controller.signal)
    } catch (err) {
      setStage('error')
      setError(errorMessage(err))
    }
  }

  if (loadError) {
    return (
      <main className="flex min-h-screen flex-col items-center justify-center gap-3 bg-slate-950 p-4 text-slate-100">
        <p role="alert">{loadError}</p>
        <Link to="/refiners" className="underline">Volver al directorio</Link>
      </main>
    )
  }
  if (!refiner) {
    return (
      <main className="flex min-h-screen items-center justify-center bg-slate-950 text-slate-300">
        <p aria-live="polite">Cargando expediente…</p>
      </main>
    )
  }

  const badgeUrl = safeHttpUrl(refiner.badge?.url)

  return (
    <main className="min-h-screen bg-slate-950 px-4 py-6 text-slate-100">
      <div className="mx-auto max-w-3xl space-y-4">
        <header>
          <Link to="/refiners" className="text-sm text-slate-400 underline">← Directorio</Link>
          <h1 className="text-2xl font-semibold">Fotocheck de {refiner.fullName}</h1>
          <p className="text-sm text-slate-400">{refiner.department.name} · {refiner.title}</p>
        </header>

        <div className="grid gap-6 md:grid-cols-[auto_1fr]">
          <section aria-label="Fotocheck actual" className="space-y-2">
            <h2 className="text-sm font-medium">Actual</h2>
            <div className="h-32 w-32 overflow-hidden rounded border border-slate-700 bg-slate-800">
              {badgeUrl ? (
                <img src={badgeUrl} alt={`Fotocheck de ${refiner.fullName}`} width={128} height={128} className="h-full w-full object-cover" />
              ) : (
                <div className="flex h-full items-center justify-center text-xs text-slate-500">Sin fotocheck</div>
              )}
            </div>
          </section>

          <section aria-label="Nuevo fotocheck" className="space-y-3">
            <h2 className="text-sm font-medium">Nuevo</h2>

            <label
              onDragOver={(e) => {
                e.preventDefault()
                setDragOver(true)
              }}
              onDragLeave={() => setDragOver(false)}
              onDrop={(e) => {
                e.preventDefault()
                setDragOver(false)
                loadFile(e.dataTransfer.files[0])
              }}
              className={`block cursor-pointer rounded border-2 border-dashed p-4 text-center text-sm ${
                dragOver ? 'border-sky-400 bg-sky-950' : 'border-slate-700'
              }`}
            >
              Arrastra una imagen aquí, pégala con Ctrl+V o{' '}
              <span className="underline">elige un archivo</span>
              <input
                type="file"
                accept="image/*"
                className="sr-only"
                disabled={busy}
                onChange={(e) => loadFile(e.target.files?.[0])}
              />
            </label>
            {pickError && <p role="alert" className="text-sm text-red-300">{pickError}</p>}

            {img && (
              <>
                <div
                  tabIndex={0}
                  role="group"
                  aria-label="Recorte del fotocheck. Flechas para mover, + y - para zoom."
                  onPointerDown={onPointerDown}
                  onPointerMove={onPointerMove}
                  onPointerUp={onPointerUp}
                  onPointerCancel={onPointerUp}
                  onKeyDown={onCropKey}
                  onWheel={(e) => applyZoom(zoom - Math.sign(e.deltaY) * 0.1)}
                  className="relative cursor-move touch-none overflow-hidden rounded border border-slate-600 bg-slate-900 focus:outline-2 focus:outline-yellow-300"
                  style={{ width: VIEW, height: VIEW }}
                >
                  <img
                    src={img.src}
                    alt=""
                    draggable={false}
                    className="pointer-events-none absolute left-0 top-0 max-w-none select-none"
                    style={{ width: dispW, height: dispH, transform: `translate(${pos.x}px, ${pos.y}px)` }}
                  />
                </div>
                <label className="flex items-center gap-2 text-sm">
                  Zoom
                  <input
                    type="range"
                    min={1}
                    max={MAX_ZOOM}
                    step={0.05}
                    value={zoom}
                    onChange={(e) => applyZoom(Number(e.target.value))}
                    className="w-48"
                  />
                </label>
              </>
            )}

            <div className="flex flex-wrap gap-2">
              <button
                type="button"
                disabled={!img || busy}
                onClick={() => void run(true)}
                className="rounded bg-slate-200 px-4 py-2 text-sm font-medium text-slate-900 disabled:opacity-50"
              >
                Subir fotocheck
              </button>
              {busy && (
                <button type="button" onClick={() => abortRef.current?.abort()} className="rounded border border-slate-600 px-3 py-2 text-sm">
                  Cancelar
                </button>
              )}
              {stage === 'error' && pipeline.current && (
                <button type="button" onClick={() => void run(false)} className="rounded border border-slate-600 px-3 py-2 text-sm">
                  Reintentar
                </button>
              )}
            </div>

            <div aria-live="polite" className="space-y-2 text-sm">
              {busy && <p>{STAGE_LABEL[stage]}</p>}
              {stage === 'uploading' && (
                <div
                  role="progressbar"
                  aria-label="Progreso de la subida"
                  aria-valuemin={0}
                  aria-valuemax={100}
                  aria-valuenow={Math.round(progress * 100)}
                  className="h-2 w-64 overflow-hidden rounded bg-slate-800"
                >
                  <div className="h-full bg-sky-500" style={{ width: `${Math.round(progress * 100)}%` }} />
                </div>
              )}
              {stage === 'done' && <p className="text-emerald-300">{STAGE_LABEL.done}</p>}
              {error && <p role="alert" className="text-red-300">{error}</p>}
            </div>

            {stage === 'conflict' && (
              <div role="alert" className="space-y-2 rounded border border-amber-700 bg-amber-950 p-3 text-sm">
                <p>
                  Alguien modificó este expediente mientras subías la imagen
                  {conflict ? ` (ahora va por la versión ${conflict.version})` : ''}. Tu fotocheck ya está subido;
                  ¿quieres aplicarlo sobre la versión actual? Solo cambia el fotocheck, el resto queda como está.
                </p>
                <div className="flex gap-2">
                  <button type="button" disabled={!conflict} onClick={() => void applyOverConflict()} className="rounded bg-amber-600 px-3 py-1">
                    Aplicar fotocheck
                  </button>
                  <Link to="/refiners" className="rounded px-3 py-1 underline">Descartar</Link>
                </div>
              </div>
            )}
          </section>
        </div>
      </div>
    </main>
  )
}
