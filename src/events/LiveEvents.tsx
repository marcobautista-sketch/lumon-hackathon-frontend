import { useEffect, useRef, useState, type KeyboardEvent } from 'react'
import { useNavigate } from 'react-router-dom'
import { useAuth } from '../auth/AuthContext'
import { apiFetch } from '../lib/apiClient'
import { errorMessage, withRetry } from '../lib/retry'
import { onLumonEvent, onStreamStatus, startEventStream, type StreamStatus } from './eventStream'

// CP5 · Pieza global (montada una vez dentro del AuthProvider):
//  - arranca el stream SSE cuando hay sesion y el Piso de Pruebas esta abierto
//  - indicador visible del estado de la conexion
//  - modal de contingencia en TODAS las pestañas (el evento llega a todas por
//    BroadcastChannel), con foco atrapado, que solo se cierra al confirmar
//  - session.revoked -> todas las pestañas vuelven al login

interface Contingency {
  id: number | string
  userId: number
  message: string
}

const STATUS_TEXT: Record<StreamStatus, string> = {
  off: '',
  waiting: 'Eventos: vía otra pestaña',
  connecting: 'Eventos: conectando…',
  open: 'Eventos: en vivo',
  reconnecting: 'Eventos: reconectando…',
  superseded: 'Eventos: otra sesión tomó la conexión',
  error: 'Eventos: sin conexión',
}
const STATUS_DOT: Record<StreamStatus, string> = {
  off: 'bg-slate-500',
  waiting: 'bg-sky-400',
  connecting: 'bg-amber-400',
  open: 'bg-emerald-400',
  reconnecting: 'bg-amber-400',
  superseded: 'bg-slate-400',
  error: 'bg-red-500',
}

export function LiveEvents() {
  const { user, clearance, logout } = useAuth()
  const navigate = useNavigate()
  const [status, setStatus] = useState<StreamStatus>('off')
  const [contingency, setContingency] = useState<Contingency | null>(null)

  const active = !!user && clearance.granted
  useEffect(() => {
    if (!active) return
    return startEventStream()
  }, [active])

  useEffect(() => onStreamStatus(setStatus), [])

  useEffect(
    () =>
      onLumonEvent((evt) => {
        const data = (evt.data ?? {}) as Record<string, unknown>
        if (evt.event === 'contingency.activated' && user && data.userId === user.id) {
          setContingency({
            id: data.id as number | string,
            userId: data.userId,
            message: typeof data.message === 'string' ? data.message : 'Contingencia de horas extra.',
          })
        } else if (evt.event === 'contingency.resolved') {
          setContingency((c) => (c && c.id === data.id ? null : c))
        } else if (evt.event === 'session.revoked') {
          void logout().then(() => navigate('/login?motivo=sesion-revocada', { replace: true }))
        }
      }),
    [user, logout, navigate],
  )

  return (
    <>
      {status !== 'off' && (
        <p
          role="status"
          aria-live="polite"
          className="fixed bottom-2 right-2 z-30 flex items-center gap-2 rounded bg-slate-900/90 px-2 py-1 text-xs text-slate-200 shadow"
        >
          <span aria-hidden="true" className={`h-2 w-2 rounded-full ${STATUS_DOT[status]}`} />
          {STATUS_TEXT[status]}
        </p>
      )}
      {contingency && <ContingencyModal contingency={contingency} onResolved={() => setContingency(null)} />}
    </>
  )
}

function ContingencyModal({ contingency, onResolved }: { contingency: Contingency; onResolved: () => void }) {
  const [sending, setSending] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const dialogRef = useRef<HTMLDivElement>(null)
  const buttonRef = useRef<HTMLButtonElement>(null)

  // Foco al abrir (y se anuncia por ser alertdialog).
  useEffect(() => {
    buttonRef.current?.focus()
  }, [])

  // Foco atrapado: Tab / Shift+Tab no salen del modal. Escape NO lo cierra.
  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key === 'Escape') {
      e.preventDefault()
      return
    }
    if (e.key !== 'Tab') return
    const focusables = dialogRef.current?.querySelectorAll<HTMLElement>('button:not([disabled])')
    if (!focusables || focusables.length === 0) {
      e.preventDefault()
      return
    }
    const first = focusables[0]
    const last = focusables[focusables.length - 1]
    if (e.shiftKey && document.activeElement === first) {
      e.preventDefault()
      last.focus()
    } else if (!e.shiftKey && document.activeElement === last) {
      e.preventDefault()
      first.focus()
    }
  }

  async function ack() {
    setSending(true)
    setError(null)
    try {
      // 503 con caos = no se confirmo nada: reintentar es seguro (y ack es idempotente).
      await withRetry(() => apiFetch<void>(`/contingency/${encodeURIComponent(String(contingency.id))}/ack`, { method: 'POST' }))
      onResolved()
    } catch (err) {
      setError(errorMessage(err)) // el modal sigue abierto
    } finally {
      setSending(false)
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 p-4">
      <div
        ref={dialogRef}
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="contingency-title"
        aria-describedby="contingency-msg"
        onKeyDown={onKeyDown}
        className="max-w-md space-y-4 rounded border border-red-700 bg-slate-900 p-6 text-slate-100"
      >
        <h2 id="contingency-title" className="text-xl font-semibold text-red-300">
          Contingencia de horas extra
        </h2>
        {/* Texto del exterior: se muestra como texto, nunca como HTML. */}
        <p id="contingency-msg">{contingency.message}</p>
        {error && (
          <p role="alert" className="rounded bg-red-950 p-2 text-sm text-red-200">
            No se pudo confirmar: {error}
          </p>
        )}
        <button
          ref={buttonRef}
          type="button"
          disabled={sending}
          onClick={() => void ack()}
          className="rounded bg-red-600 px-4 py-2 font-medium disabled:opacity-50"
        >
          {sending ? 'Confirmando…' : 'Confirmar contingencia'}
        </button>
      </div>
    </div>
  )
}
