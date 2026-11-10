// CP5 · Eventos en tiempo real (SSE).
//
// Reglas del contrato (Swagger: GET /events/stream):
//  - Se abre con un TICKET de un solo uso (POST /events/tickets), nunca con el token.
//  - Una sola conexion por sesion: si se abre otra, la anterior recibe stream.superseded.
//    -> Web Locks: solo la pestaña que tiene el lock "lumon.sse" se conecta. Si esa
//       pestaña se cierra, el navegador libera el lock y otra pestaña lo toma sola.
//    -> BroadcastChannel: la pestaña conectada reparte cada evento a todas las demas.
//  - Reconexion con ticket nuevo, espera creciente y lastEventId.
//  - Heartbeat ": hb" cada 15 s; sin datos ni heartbeat por 45 s = conexion muerta.
//    EventSource no expone los comentarios, por eso se lee el stream con fetch
//    (sin librerias) y se parsea el formato SSE a mano.
//  - Eventos duplicados (mismo id): se descartan.
import { apiFetch } from '../lib/apiClient'
import { backoffDelay, sleep } from '../lib/retry'
import { ApiError } from '../lib/types'

export interface LumonEvent {
  id: number | null
  event: string
  data: unknown
}

export type StreamStatus = 'off' | 'connecting' | 'open' | 'reconnecting' | 'waiting' | 'superseded' | 'error'

type Msg = { kind: 'event'; evt: LumonEvent } | { kind: 'status'; status: StreamStatus }

const API_BASE = import.meta.env.VITE_API_BASE_URL as string
const DEAD_MS = 45_000

const listeners = new Set<(e: LumonEvent) => void>()
const statusListeners = new Set<(s: StreamStatus) => void>()
const seen = new Set<number>()
const seenOrder: number[] = []
let lastEventId: number | null = null
let status: StreamStatus = 'off'

const channel = typeof BroadcastChannel !== 'undefined' ? new BroadcastChannel('lumon.events') : null
channel?.addEventListener('message', (e: MessageEvent<Msg>) => {
  if (e.data.kind === 'event') deliver(e.data.evt)
  else setStatus(e.data.status, false)
})

function setStatus(s: StreamStatus, broadcast: boolean) {
  status = s
  for (const fn of statusListeners) fn(s)
  if (broadcast) channel?.postMessage({ kind: 'status', status: s } satisfies Msg)
}

/** Entrega local, descartando ids repetidos (el backend puede mandar duplicados). */
function deliver(evt: LumonEvent) {
  if (evt.id !== null) {
    if (seen.has(evt.id)) return
    seen.add(evt.id)
    seenOrder.push(evt.id)
    if (seenOrder.length > 2000) seen.delete(seenOrder.shift()!)
    if (lastEventId === null || evt.id > lastEventId) lastEventId = evt.id
  }
  for (const fn of listeners) fn(evt)
}

export function onLumonEvent(fn: (e: LumonEvent) => void): () => void {
  listeners.add(fn)
  return () => {
    listeners.delete(fn)
  }
}

export function onStreamStatus(fn: (s: StreamStatus) => void): () => void {
  statusListeners.add(fn)
  fn(status)
  return () => {
    statusListeners.delete(fn)
  }
}

let stopController: AbortController | null = null

/** Arranca la coordinacion. Idempotente. Devuelve la funcion para detenerla. */
export function startEventStream(): () => void {
  if (stopController) return stopEventStream
  const stop = new AbortController()
  stopController = stop
  setStatus('waiting', false)
  const run = () => leaderLoop(stop.signal)
  if (navigator.locks) {
    // Espera en la cola del lock: si otra pestaña ya esta conectada, esta queda
    // "waiting" y recibe los eventos por BroadcastChannel.
    navigator.locks.request('lumon.sse', { signal: stop.signal }, run).catch(() => {})
  } else {
    void run()
  }
  return stopEventStream
}

export function stopEventStream() {
  stopController?.abort()
  stopController = null
  setStatus('off', false)
}

async function leaderLoop(stop: AbortSignal): Promise<void> {
  let attempt = 0
  while (!stop.aborted) {
    setStatus(attempt === 0 ? 'connecting' : 'reconnecting', true)
    try {
      const outcome = await connectOnce(stop, () => {
        attempt = 0
        setStatus('open', true)
      })
      if (outcome === 'superseded') {
        setStatus('superseded', true)
        return
      }
    } catch (err) {
      if (stop.aborted) return
      if (err instanceof ApiError) {
        // Definitivos: no insistir.
        if (err.is('SESSION_REVOKED') || err.status === 423 || err.status === 403) {
          if (err.is('SESSION_REVOKED')) emitBoth({ id: null, event: 'session.revoked', data: { reason: 'SESSION_REVOKED' } })
          setStatus('error', true)
          return
        }
      }
    }
    if (stop.aborted) return
    // Reconexion con espera creciente (Retry-After si vino).
    await sleep(backoffDelay(attempt++, null), stop).catch(() => {})
  }
}

function emitBoth(evt: LumonEvent) {
  deliver(evt)
  channel?.postMessage({ kind: 'event', evt } satisfies Msg)
}

/**
 * Una conexion: ticket nuevo -> fetch del stream -> parseo SSE hasta que se
 * cierre, se aborte o se detecte conexion muerta.
 */
async function connectOnce(stop: AbortSignal, onOpen: () => void): Promise<'closed' | 'superseded'> {
  const { ticket } = await apiFetch<{ ticket: string; expiresIn: number }>('/events/tickets', { method: 'POST' })
  const conn = new AbortController()
  const abortConn = () => conn.abort()
  stop.addEventListener('abort', abortConn, { once: true })

  let lastActivity = Date.now()
  const watchdog = setInterval(() => {
    if (Date.now() - lastActivity > DEAD_MS) conn.abort() // conexion muerta
  }, 5000)

  try {
    const qs = new URLSearchParams({ ticket })
    if (lastEventId !== null) qs.set('lastEventId', String(lastEventId))
    // Sin Authorization ni X-Lumon-Build: el stream es una de las excepciones.
    const res = await fetch(`${API_BASE}/events/stream?${qs.toString()}`, {
      signal: conn.signal,
      headers: { Accept: 'text/event-stream' },
    })
    if (!res.ok || !res.body) {
      let body = { error: 'STREAM_ERROR', message: `HTTP ${res.status}`, details: null, timestamp: '', path: '', requestId: '' }
      try {
        body = (await res.json()) as typeof body
      } catch {
        // no JSON
      }
      throw new ApiError(res.status, body)
    }
    onOpen()

    const reader = res.body.pipeThrough(new TextDecoderStream()).getReader()
    let buffer = ''
    let id: string | null = null
    let event = 'message'
    let data: string[] = []
    for (;;) {
      const { value, done } = await reader.read()
      if (done) return 'closed'
      lastActivity = Date.now()
      buffer += value
      let nl: number
      while ((nl = buffer.search(/\r?\n/)) >= 0) {
        const line = buffer.slice(0, nl)
        buffer = buffer.slice(nl + (buffer[nl] === '\r' ? 2 : 1))
        if (line === '') {
          // Fin de un evento.
          if (data.length > 0 || id !== null) {
            let parsed: unknown = null
            try {
              parsed = JSON.parse(data.join('\n'))
            } catch {
              parsed = data.join('\n')
            }
            const numericId = id !== null && /^\d+$/.test(id) ? Number(id) : null
            emitBoth({ id: numericId, event, data: parsed })
            if (event === 'stream.superseded') return 'superseded'
          }
          id = null
          event = 'message'
          data = []
        } else if (line.startsWith(':')) {
          // comentario / heartbeat: solo cuenta como actividad
        } else {
          const colon = line.indexOf(':')
          const field = colon === -1 ? line : line.slice(0, colon)
          const val = colon === -1 ? '' : line.slice(colon + 1).replace(/^ /, '')
          if (field === 'id') id = val
          else if (field === 'event') event = val
          else if (field === 'data') data.push(val)
        }
      }
    }
  } catch (err) {
    if (conn.signal.aborted && !stop.aborted) return 'closed' // muerta -> reconectar
    throw err
  } finally {
    clearInterval(watchdog)
    stop.removeEventListener('abort', abortConn)
  }
}
