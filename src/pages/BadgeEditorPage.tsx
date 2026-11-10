import { useEffect, useRef, useState, type ClipboardEvent, type DragEvent, type KeyboardEvent, type PointerEvent } from 'react'
import { Link, useParams } from 'react-router-dom'
import { apiFetch } from '../lib/apiClient'
import type { Refiner } from '../lib/refiners'
import { ApiError } from '../lib/types'

// Editor de fotocheck (CP4). Flujo: recorte -> canvas 512x512 -> WebP (canvas no
// copia metadatos EXIF/XMP) -> SHA-256 -> POST /media/tickets -> subida directa a
// Cloudinary con XHR (progreso real) -> POST /media/tickets/{id}/confirm ->
// PATCH /refiners/{id} con If-Match (Regla de Milchick).
const CLOUD_NAME = import.meta.env.VITE_CLOUDINARY_CLOUD_NAME as string
const UPLOAD_PRESET = import.meta.env.VITE_CLOUDINARY_UPLOAD_PRESET as string
const SIZE = 512
const MAX_BYTES = 122_880
const VIEW = 320

interface Ticket {
  ticketId: string
  uploadPublicId?: string
}

type Phase = 'idle' | 'uploading' | 'confirming' | 'saving' | 'done' | 'error'

async function sha256Hex(blob: Blob): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', await blob.arrayBuffer())
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('')
}

function toWebp(canvas: HTMLCanvasElement, quality: number): Promise<Blob | null> {
  return new Promise((resolve) => canvas.toBlob(resolve, 'image/webp', quality))
}

export function BadgeEditorPage() {
  const { id } = useParams()
  const refinerId = Number(id)
  const [image, setImage] = useState<HTMLImageElement | null>(null)
  const [zoom, setZoom] = useState(1)
  const [offset, setOffset] = useState({ x: 0, y: 0 })
  const [phase, setPhase] = useState<Phase>('idle')
  const [progress, setProgress] = useState(0)
  const [message, setMessage] = useState<string | null>(null)
  const [preview, setPreview] = useState<string | null>(null)
  const xhrRef = useRef<XMLHttpRequest | null>(null)
  const dragRef = useRef<{ x: number; y: number } | null>(null)

  useEffect(() => () => xhrRef.current?.abort(), [])

  const loadFile = (file: File | null | undefined) => {
    if (!file || !file.type.startsWith('image/')) {
      setMessage('Elijan un archivo de imagen.')
      return
    }
    const url = URL.createObjectURL(file)
    const img = new Image()
    img.onload = () => {
      setImage(img)
      setZoom(1)
      setOffset({ x: 0, y: 0 })
      setMessage(null)
      setPhase('idle')
    }
    img.onerror = () => setMessage('No se pudo leer la imagen.')
    img.src = url
  }

  // Escala base: la imagen cubre el cuadrado. zoom multiplica; offset en px de la vista.
  const base = image ? Math.max(VIEW / image.naturalWidth, VIEW / image.naturalHeight) : 1
  const scale = base * zoom
  const clampOffset = (o: { x: number; y: number }) => {
    if (!image) return o
    const maxX = Math.max(0, (image.naturalWidth * scale - VIEW) / 2)
    const maxY = Math.max(0, (image.naturalHeight * scale - VIEW) / 2)
    return { x: Math.min(maxX, Math.max(-maxX, o.x)), y: Math.min(maxY, Math.max(-maxY, o.y)) }
  }

  const onPointerDown = (e: PointerEvent<HTMLDivElement>) => {
    e.currentTarget.setPointerCapture(e.pointerId)
    dragRef.current = { x: e.clientX - offset.x, y: e.clientY - offset.y }
  }
  const onPointerMove = (e: PointerEvent<HTMLDivElement>) => {
    if (dragRef.current) setOffset(clampOffset({ x: e.clientX - dragRef.current.x, y: e.clientY - dragRef.current.y }))
  }
  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    const step = e.shiftKey ? 20 : 5
    const moves: Record<string, [number, number]> = { ArrowLeft: [step, 0], ArrowRight: [-step, 0], ArrowUp: [0, step], ArrowDown: [0, -step] }
    if (moves[e.key]) {
      e.preventDefault()
      const [dx, dy] = moves[e.key]
      setOffset((o) => clampOffset({ x: o.x + dx, y: o.y + dy }))
    } else if (e.key === '+' || e.key === '=') setZoom((z) => Math.min(4, z + 0.1))
    else if (e.key === '-') setZoom((z) => Math.max(1, z - 0.1))
  }

  const render = async (): Promise<Blob> => {
    if (!image) throw new Error('Sin imagen')
    const canvas = document.createElement('canvas')
    canvas.width = SIZE
    canvas.height = SIZE
    const ctx = canvas.getContext('2d')
    if (!ctx) throw new Error('Canvas no disponible')
    const k = SIZE / VIEW
    const w = image.naturalWidth * scale * k
    const h = image.naturalHeight * scale * k
    ctx.drawImage(image, (SIZE - w) / 2 + offset.x * k, (SIZE - h) / 2 + offset.y * k, w, h)
    for (const q of [0.9, 0.8, 0.7, 0.6, 0.5, 0.4, 0.3]) {
      const blob = await toWebp(canvas, q)
      if (!blob || blob.type !== 'image/webp') throw new Error('Este navegador no puede generar imágenes WebP. Usen Chrome, Edge o Firefox.')
      if (blob.size <= MAX_BYTES) return blob
    }
    throw new Error('No se pudo bajar la imagen a 120 KB.')
  }

  const upload = (blob: Blob, ticket: Ticket): Promise<string> =>
    new Promise((resolve, reject) => {
      const form = new FormData()
      form.append('file', blob)
      form.append('upload_preset', UPLOAD_PRESET)
      if (ticket.uploadPublicId) form.append('public_id', ticket.uploadPublicId)
      const xhr = new XMLHttpRequest()
      xhrRef.current = xhr
      xhr.open('POST', `https://api.cloudinary.com/v1_1/${CLOUD_NAME}/image/upload`)
      xhr.upload.onprogress = (e) => {
        if (e.lengthComputable) setProgress(Math.round((e.loaded / e.total) * 100))
      }
      xhr.onload = () => {
        try {
          const body = JSON.parse(xhr.responseText) as { secure_url?: string; error?: { message: string } }
          if (xhr.status >= 200 && xhr.status < 300 && body.secure_url) resolve(body.secure_url)
          else reject(new Error(body.error?.message ?? `Error de subida ${xhr.status}`))
        } catch {
          reject(new Error(`Error de subida ${xhr.status}`))
        }
      }
      xhr.onerror = () => reject(new Error('Falló la red durante la subida.'))
      xhr.onabort = () => reject(new DOMException('Cancelado', 'AbortError'))
      xhr.send(blob ? form : null)
    })

  const start = async () => {
    setMessage(null)
    setProgress(0)
    try {
      const blob = await render()
      setPreview(URL.createObjectURL(blob))
      const sha256 = await sha256Hex(blob)
      setPhase('uploading')
      const ticket = await apiFetch<Ticket>('/media/tickets', {
        method: 'POST',
        body: { purpose: 'BADGE', contentType: 'image/webp', bytes: blob.size, sha256, width: SIZE, height: SIZE },
      })
      const url = await upload(blob, ticket)
      setPhase('confirming')
      const media = await apiFetch<{ mediaId: number }>(`/media/tickets/${ticket.ticketId}/confirm`, { method: 'POST', body: { url } })
      setPhase('saving')
      // Regla de Milchick: leer la version actual y enviar su ETag exacto.
      const current = await apiFetch<Refiner>(`/refiners/${refinerId}`)
      await apiFetch<Refiner>(`/refiners/${refinerId}`, {
        method: 'PATCH',
        body: { badgeMediaId: media.mediaId },
        extraHeaders: { 'If-Match': `"${current.version}"` },
      })
      setPhase('done')
    } catch (err) {
      if (err instanceof DOMException && err.name === 'AbortError') {
        setPhase('idle')
        setMessage('Subida cancelada. Pueden reintentar.')
        return
      }
      setPhase('error')
      if (err instanceof ApiError && err.is('VERSION_CONFLICT')) setMessage('El expediente cambió mientras subían la foto. Reintenten: se usará la versión nueva.')
      else if (err instanceof ApiError) setMessage(`Error ${err.status} (${err.body.error}): ${err.body.message}`)
      else setMessage(err instanceof Error ? err.message : 'Error inesperado.')
    }
  }

  const busy = phase === 'uploading' || phase === 'confirming' || phase === 'saving'

  return (
    <main className="min-h-screen bg-slate-950 px-4 py-8 text-slate-100">
      <div className="mx-auto max-w-xl space-y-4">
        <Link to="/refiners" className="text-sm text-sky-300 underline">← Volver al directorio</Link>
        <h1 className="text-2xl font-semibold">Fotocheck del expediente #{refinerId}</h1>

        <div
          onDragOver={(e: DragEvent) => e.preventDefault()}
          onDrop={(e: DragEvent) => {
            e.preventDefault()
            loadFile(e.dataTransfer.files[0])
          }}
          onPaste={(e: ClipboardEvent) => loadFile(e.clipboardData.files[0])}
          tabIndex={0}
          className="rounded border border-dashed border-slate-600 p-4 text-sm text-slate-300"
        >
          <label className="block">
            Elijan una imagen, arrástrenla aquí o péguenla (Ctrl+V).
            <input type="file" accept="image/*" onChange={(e) => loadFile(e.target.files?.[0])} className="mt-2 block" />
          </label>
        </div>

        {image && (
          <>
            <div
              role="img"
              aria-label="Recorte cuadrado. Flechas para mover, + y - para zoom."
              tabIndex={0}
              onKeyDown={onKeyDown}
              onPointerDown={onPointerDown}
              onPointerMove={onPointerMove}
              onPointerUp={() => (dragRef.current = null)}
              className="relative cursor-move touch-none overflow-hidden rounded bg-slate-800 outline-sky-400 focus:outline-2"
              style={{ width: VIEW, height: VIEW }}
            >
              <img
                src={image.src}
                alt=""
                draggable={false}
                className="pointer-events-none absolute left-1/2 top-1/2 max-w-none select-none"
                style={{ width: image.naturalWidth * scale, height: image.naturalHeight * scale, transform: `translate(calc(-50% + ${offset.x}px), calc(-50% + ${offset.y}px))` }}
              />
            </div>
            <label className="block text-sm">
              Zoom
              <input type="range" min={1} max={4} step={0.05} value={zoom} onChange={(e) => { setZoom(Number(e.target.value)); setOffset((o) => clampOffset(o)) }} className="ml-2 align-middle" />
            </label>
          </>
        )}

        {busy && (
          <div className="space-y-1">
            <progress value={phase === 'uploading' ? progress : 100} max={100} className="w-full" aria-label="Progreso de la subida" />
            <p aria-live="polite" className="text-sm text-slate-300">
              {phase === 'uploading' ? `Subiendo… ${progress}%` : phase === 'confirming' ? 'Confirmando con Lumon…' : 'Actualizando el expediente…'}
            </p>
          </div>
        )}

        <div className="flex gap-2">
          <button type="button" disabled={!image || busy} onClick={() => void start()} className="rounded bg-sky-700 px-4 py-2 disabled:opacity-50">
            {phase === 'error' ? 'Reintentar' : 'Subir fotocheck'}
          </button>
          {phase === 'uploading' && (
            <button type="button" onClick={() => xhrRef.current?.abort()} className="rounded border border-slate-600 px-4 py-2">
              Cancelar
            </button>
          )}
        </div>

        {message && <p role="alert" className="text-amber-300">{message}</p>}
        {phase === 'done' && preview && (
          <div role="status" className="space-y-2 text-emerald-300">
            <p>Fotocheck actualizado.</p>
            <img src={preview} alt="Nuevo fotocheck" width={128} height={128} className="rounded" />
          </div>
        )}
      </div>
    </main>
  )
}
