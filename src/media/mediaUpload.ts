// Subida de imagenes (CP4). Flujo del contrato (Swagger: POST /media/tickets):
//   1. preparar la imagen en el navegador (recorte, tamaño, WebP SIN metadatos)
//   2. POST /media/tickets  -> ticket con el public_id exacto
//   3. subir DIRECTO a Cloudinary (unsigned, con progreso real via XHR)
//   4. POST /media/tickets/{id}/confirm -> mediaId
// Lumon no guarda archivos y POST /media/upload NO existe.
import { apiFetch } from '../lib/apiClient'

export type Purpose = 'BADGE' | 'INCIDENT'

export interface MediaTicket {
  ticketId: string
  expiresAt: string
  provider: 'SUPABASE' | 'CLOUDINARY'
  uploadPublicId?: string
  expectedPublicId?: string
  constraints: { maxBytes: number }
}

export interface Media {
  mediaId: number
  url: string
  width: number
  height: number
  purpose: Purpose
}

export interface PreparedImage {
  blob: Blob
  width: number
  height: number
  sha256: string
}

export class UnsupportedWebpError extends Error {
  constructor() {
    super('Tu navegador no puede generar imágenes WebP. Usa Chrome, Edge o Firefox actualizados.')
  }
}

/**
 * Canvas -> WebP. Re-dibujar en un canvas descarta TODOS los metadatos de la
 * imagen original (EXIF, XMP, GPS): el canvas solo tiene pixeles.
 * Baja la calidad hasta entrar en maxBytes.
 */
export async function canvasToWebp(canvas: HTMLCanvasElement, maxBytes: number): Promise<Blob> {
  for (const quality of [0.92, 0.85, 0.75, 0.65, 0.55, 0.45, 0.35, 0.25]) {
    const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/webp', quality))
    // Si el navegador no soporta WebP, toBlob devuelve PNG (o null).
    if (!blob || blob.type !== 'image/webp') throw new UnsupportedWebpError()
    if (blob.size <= maxBytes) return blob
  }
  throw new Error('No se pudo comprimir la imagen por debajo del peso máximo.')
}

export async function sha256Hex(blob: Blob): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', await blob.arrayBuffer())
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('')
}

export function requestTicket(purpose: Purpose, img: PreparedImage): Promise<MediaTicket> {
  return apiFetch<MediaTicket>('/media/tickets', {
    method: 'POST',
    body: {
      purpose,
      contentType: 'image/webp',
      bytes: img.blob.size,
      sha256: img.sha256,
      width: img.width,
      height: img.height,
    },
  })
}

export function confirmTicket(ticketId: string, url: string): Promise<Media> {
  return apiFetch<Media>(`/media/tickets/${encodeURIComponent(ticketId)}/confirm`, {
    method: 'POST',
    body: { url },
  })
}

// Config publica del storage: SOLO cloud name y preset (nunca el API secret).
// Primero las variables VITE_*; si el despliegue no las tiene, se usa la
// configuracion que el equipo registro en Lumon (GET /integrations/status ->
// storage.config), que es la misma y ya esta verificada por el backend.
interface CloudinaryConfig {
  cloudName: string
  uploadPreset: string
}
let configPromise: Promise<CloudinaryConfig> | null = null

function getCloudinaryConfig(): Promise<CloudinaryConfig> {
  const cloudName = import.meta.env.VITE_CLOUDINARY_CLOUD_NAME as string | undefined
  const uploadPreset = import.meta.env.VITE_CLOUDINARY_UPLOAD_PRESET as string | undefined
  if (cloudName && uploadPreset) return Promise.resolve({ cloudName, uploadPreset })
  configPromise ??= apiFetch<{ storage: { config: { cloudName?: string; uploadPreset?: string } | null } }>(
    '/integrations/status',
  )
    .then((s) => {
      const c = s.storage.config
      if (!c?.cloudName || !c.uploadPreset) throw new Error('El storage del equipo no está configurado.')
      return { cloudName: c.cloudName, uploadPreset: c.uploadPreset }
    })
    .catch((err: unknown) => {
      configPromise = null // permitir reintentar
      throw err
    })
  return configPromise
}

/**
 * Sube el blob a Cloudinary con XMLHttpRequest: fetch no informa progreso de
 * subida, XHR si (xhr.upload.onprogress). Devuelve la secure_url SIN
 * transformaciones, que es la que hay que confirmar.
 */
export async function uploadToCloudinary(
  blob: Blob,
  ticket: MediaTicket,
  onProgress: (fraction: number) => void,
  signal: AbortSignal,
): Promise<string> {
  const { cloudName: CLOUD_NAME, uploadPreset: UPLOAD_PRESET } = await getCloudinaryConfig()
  return new Promise((resolve, reject) => {
    if (!CLOUD_NAME || !UPLOAD_PRESET) {
      reject(new Error('Falta configurar VITE_CLOUDINARY_CLOUD_NAME / VITE_CLOUDINARY_UPLOAD_PRESET.'))
      return
    }
    if (!ticket.uploadPublicId) {
      reject(new Error('El ticket no trae uploadPublicId (¿el storage registrado no es Cloudinary?).'))
      return
    }
    const form = new FormData()
    form.append('file', blob, 'badge.webp')
    form.append('upload_preset', UPLOAD_PRESET)
    // public_id exacto del ticket; el preset le antepone lumon/<TEAM_CODE>/.
    form.append('public_id', ticket.uploadPublicId)

    const xhr = new XMLHttpRequest()
    xhr.open('POST', `https://api.cloudinary.com/v1_1/${encodeURIComponent(CLOUD_NAME)}/image/upload`)
    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable) onProgress(e.loaded / e.total)
    }
    xhr.onload = () => {
      let body: { secure_url?: string; public_id?: string; error?: { message?: string } } = {}
      try {
        body = JSON.parse(xhr.responseText) as typeof body
      } catch {
        // respuesta no JSON
      }
      if (xhr.status >= 200 && xhr.status < 300 && body.secure_url) {
        if (ticket.expectedPublicId && body.public_id !== ticket.expectedPublicId) {
          reject(new Error(`El storage guardó la imagen como "${body.public_id}" y no como "${ticket.expectedPublicId}".`))
          return
        }
        onProgress(1)
        resolve(body.secure_url)
      } else {
        reject(new Error(body.error?.message ?? `El storage respondió ${xhr.status}.`))
      }
    }
    xhr.onerror = () => reject(new TypeError('Se cortó la conexión durante la subida.'))
    xhr.onabort = () => reject(new DOMException('Subida cancelada', 'AbortError'))
    if (signal.aborted) {
      reject(new DOMException('Subida cancelada', 'AbortError'))
      return
    }
    signal.addEventListener('abort', () => xhr.abort(), { once: true })
    xhr.send(form)
  })
}
