// Canal entre pestanas del mismo origen. Sirve para:
//  - Avisar a las demas pestanas que la sesion se cerro (logout o
//    session.revoked), para que naveguen al login en < 2 segundos.
//  - Mas adelante, compartir eventos SSE (una sola conexion por navegador).
//
// Usamos BroadcastChannel (soportado desde hace anos, mencionado como
// referencia permitida por el enunciado). Si el navegador no lo soporta,
// degradamos silenciosamente a no-op (una pestana unica sigue funcionando).

export type TabMessage =
  | { type: 'session.cleared'; reason: string }
  | { type: 'session.saved' }

const CHANNEL_NAME = 'lumon.tab'

type Listener = (msg: TabMessage) => void

const listeners = new Set<Listener>()
let channel: BroadcastChannel | null = null

function ensureChannel(): BroadcastChannel | null {
  if (channel) return channel
  if (typeof BroadcastChannel === 'undefined') return null
  channel = new BroadcastChannel(CHANNEL_NAME)
  channel.addEventListener('message', (event) => {
    for (const fn of listeners) fn(event.data as TabMessage)
  })
  return channel
}

export function broadcastTab(msg: TabMessage): void {
  const ch = ensureChannel()
  ch?.postMessage(msg)
}

export function onTabMessage(fn: Listener): () => void {
  ensureChannel()
  listeners.add(fn)
  return () => {
    listeners.delete(fn)
  }
}
