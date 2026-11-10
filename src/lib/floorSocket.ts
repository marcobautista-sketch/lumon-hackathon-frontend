// Piso compartido (CP5): WebSocket NATIVO a /floor/ws con ticket de un solo uso.
// Protocolo completo en Swagger, POST /floor/tickets.
//
// Diseno:
// - Toda la logica vive en esta clase, fuera de React. El hook useFloorSocket
//   solo se suscribe al estado "estructural" (miembros, reservas, estado de la
//   conexion), que cambia poco.
// - Los cursores de los demas cambian muchas veces por segundo: van por un
//   canal aparte (subscribeCursors) para NO re-renderizar la grilla.
// - Nunca se pone el access token en la URL: siempre ticket nuevo por conexion.
import { apiFetch } from './apiClient'
import { ApiError } from './types'

const WS_BASE = import.meta.env.VITE_WS_BASE_URL as string

const PING_INTERVAL_MS = 15_000 // el servidor corta con 4408 si pasan 30 s sin ping
const MAX_MISSED_PONGS = 2
const RENEW_INTERVAL_MS = 10_000 // la reserva vence a los 15 s
const CURSOR_MIN_INTERVAL_MS = 100 // maximo 10 mensajes de cursor por segundo
const CLAIM_TIMEOUT_MS = 10_000 // con caos el servidor puede demorar la respuesta
const BACKOFF_BASE_MS = 1_000
const BACKOFF_MAX_MS = 30_000
const TOO_MANY_MESSAGES_WAIT_MS = 10_000

export interface Cell {
  r: number
  c: number
}

export interface FloorMember {
  userId: number
  displayName: string
}

export interface FloorCursor extends Cell {
  userId: number
  displayName: string
}

export interface FloorClaim {
  claimId: string
  userId: number
  displayName: string
  cells: Cell[]
  expiresAt: string
}

export interface FloorHolder {
  userId: number
  displayName: string
}

export type FloorStatus =
  | 'idle'
  | 'connecting'
  | 'open'
  | 'reconnecting'
  /** Cierre definitivo (4400/4403/4404/4423, o 4401 repetido): no se reconecta. */
  | 'closed'
  /** El navegador no tiene WebSocket. Se puede seguir refinando igual. */
  | 'unavailable'

export interface FloorState {
  status: FloorStatus
  /** Mensaje legible para el indicador de conexion / error definitivo. */
  statusMessage: string | null
  members: FloorMember[]
  claims: FloorClaim[]
  /** La reserva de ESTA conexion (cada conexion tiene como maximo una). */
  myClaim: FloorClaim | null
  /** Ultimo problema con una reserva (para un mensaje accionable). */
  claimNotice: string | null
}

export type ClaimResult =
  | { ok: true; claim: FloorClaim }
  | { ok: false; reason: 'HELD'; holder: FloorHolder | null }
  | { ok: false; reason: 'NOT_A_GROUP' | 'TIMEOUT' | 'DISCONNECTED' }

type CursorListener = (cursors: ReadonlyMap<number, FloorCursor>) => void

// --- Mensajes del servidor ----------------------------------------------------
interface SnapshotMsg {
  type: 'snapshot'
  seq: number
  members: Array<FloorMember & { r: number | null; c: number | null }>
  claims: FloorClaim[]
}
interface MemberMsg {
  type: 'member.joined' | 'member.left'
  seq: number
  userId: number
  displayName: string
}
interface CursorMsg {
  type: 'cursor'
  userId: number
  r: number
  c: number
}
interface ClaimGrantedMsg extends FloorClaim {
  type: 'claim.granted'
  seq: number
  requestId: string | number
}
interface ClaimUpdatedMsg extends FloorClaim {
  type: 'claim.updated'
  seq: number
}
interface ClaimReleasedMsg {
  type: 'claim.released'
  /** Sin seq cuando es la respuesta privada a un renew/release de una reserva ajena. */
  seq?: number
  claimId: string
  userId?: number
}
interface ClaimDeniedMsg {
  type: 'claim.denied'
  requestId: string | number
  reason: 'HELD' | 'NOT_A_GROUP'
  holder: FloorHolder | null
}
interface PongMsg {
  type: 'pong'
  t: number | string
}
type ServerMsg =
  | SnapshotMsg
  | MemberMsg
  | CursorMsg
  | ClaimGrantedMsg
  | ClaimUpdatedMsg
  | ClaimReleasedMsg
  | ClaimDeniedMsg
  | PongMsg

const TERMINAL_CLOSE_MESSAGES: Record<number, string> = {
  4400: 'La app envió un mensaje inválido al piso. Recarguen la página.',
  4403: 'El origen no está verificado o no tienen permiso para el piso.',
  4404: 'El archivo no existe.',
  4423: 'El Piso de Pruebas aún no está abierto para su equipo.',
}

interface PendingClaim {
  resolve: (result: ClaimResult) => void
  timer: ReturnType<typeof setTimeout>
  anchor: Cell
}

export interface FloorConnectionOptions {
  fileId: number
  selfUserId: number
}

export class FloorConnection {
  private readonly fileId: number
  private readonly selfUserId: number

  private ws: WebSocket | null = null
  private disposed = false
  private attempt = 0
  private ticketRetryUsed = false

  private lastSeq: number | null = null
  private awaitingResync = false

  private members = new Map<number, FloorMember>()
  private claims = new Map<string, FloorClaim>()
  private cursors = new Map<number, FloorCursor>()
  private myClaim: FloorClaim | null = null
  /** Celda del grupo que teniamos reservado antes de un corte: se vuelve a pedir. */
  private reclaimAnchor: Cell | null = null

  private pendingClaims = new Map<string, PendingClaim>()
  private nextRequestId = 1

  private pingTimer: ReturnType<typeof setInterval> | null = null
  private missedPongs = 0
  private renewTimer: ReturnType<typeof setInterval> | null = null
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null
  private cursorTimer: ReturnType<typeof setTimeout> | null = null
  private lastCursorSentAt = 0
  private pendingCursor: Cell | null = null

  private state: FloorState = {
    status: 'idle',
    statusMessage: null,
    members: [],
    claims: [],
    myClaim: null,
    claimNotice: null,
  }
  private stateListeners = new Set<() => void>()
  private cursorListeners = new Set<CursorListener>()

  constructor(options: FloorConnectionOptions) {
    this.fileId = options.fileId
    this.selfUserId = options.selfUserId
  }

  // --- API publica -------------------------------------------------------------

  start(): void {
    this.disposed = false
    this.attempt = 0
    this.ticketRetryUsed = false
    if (typeof WebSocket === 'undefined') {
      this.patchState({ status: 'unavailable', statusMessage: 'Este navegador no soporta WebSocket. Pueden seguir refinando.' })
      return
    }
    document.addEventListener('visibilitychange', this.onVisibilityChange)
    void this.connect()
  }

  /** Cierra todo al salir de la grilla: libera la reserva y no reconecta. */
  stop(): void {
    this.disposed = true
    document.removeEventListener('visibilitychange', this.onVisibilityChange)
    if (this.myClaim) this.send({ type: 'release', claimId: this.myClaim.claimId })
    this.clearTimers()
    this.rejectPendingClaims()
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer)
    this.reconnectTimer = null
    this.reclaimAnchor = null
    const ws = this.ws
    this.ws = null
    if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) {
      ws.close(1000, 'leaving')
    }
    // Estado limpio (sin fantasmas). Los suscriptores se mantienen: React los
    // quita solo al desmontar, y StrictMode puede volver a llamar a start().
    this.members.clear()
    this.claims.clear()
    this.cursors.clear()
    this.setMyClaim(null)
    this.lastSeq = null
    this.state = { ...this.state, status: 'idle', statusMessage: null, claimNotice: null }
    this.publish()
    this.emitCursors()
  }

  /** Para useSyncExternalStore: referencias estables. */
  subscribe = (listener: () => void): (() => void) => {
    this.stateListeners.add(listener)
    return () => this.stateListeners.delete(listener)
  }

  getState = (): FloorState => this.state

  subscribeCursors = (listener: CursorListener): (() => void) => {
    this.cursorListeners.add(listener)
    listener(this.cursors)
    return () => this.cursorListeners.delete(listener)
  }

  getCursors = (): ReadonlyMap<number, FloorCursor> => this.cursors

  /** Mueve el cursor propio. Throttle a 10/s; una pestana oculta no envia nada. */
  sendCursor = (r: number, c: number): void => {
    this.pendingCursor = { r, c }
    this.flushCursorSoon()
  }

  /**
   * Reserva el grupo de la celda (r, c) antes de llevarlo a una caja.
   * Si el piso no esta conectado resuelve DISCONNECTED: el llamador puede
   * seguir refinando por HTTP con normalidad (requisito del enunciado).
   */
  claim = (r: number, c: number): Promise<ClaimResult> => {
    if (!this.isOpen()) return Promise.resolve({ ok: false, reason: 'DISCONNECTED' })
    const requestId = `c-${this.nextRequestId++}`
    return new Promise<ClaimResult>((resolve) => {
      const timer = setTimeout(() => {
        this.pendingClaims.delete(requestId)
        resolve({ ok: false, reason: 'TIMEOUT' })
      }, CLAIM_TIMEOUT_MS)
      this.pendingClaims.set(requestId, { resolve, timer, anchor: { r, c } })
      this.send({ type: 'claim', requestId, r, c })
    })
  }

  /** Libera la reserva propia (al cancelar o tras refinar). */
  release = (): void => {
    this.reclaimAnchor = null
    if (!this.myClaim) return
    const { claimId } = this.myClaim
    this.send({ type: 'release', claimId })
    this.claims.delete(claimId)
    this.setMyClaim(null)
    this.publish()
  }

  resync = (): void => {
    if (this.send({ type: 'resync' })) this.awaitingResync = true
  }

  // --- Conexion ------------------------------------------------------------------

  private async connect(): Promise<void> {
    if (this.disposed) return
    this.patchState({
      status: this.attempt === 0 ? 'connecting' : 'reconnecting',
      statusMessage: this.attempt === 0 ? 'Conectando al piso…' : 'Reconectando al piso…',
    })

    let ticket: string
    try {
      const res = await apiFetch<{ ticket: string; expiresIn: number }>('/floor/tickets', {
        method: 'POST',
        body: { fileId: this.fileId },
      })
      ticket = res.ticket
    } catch (err) {
      if (this.disposed) return
      if (err instanceof ApiError && (err.status === 403 || err.status === 404 || err.status === 423 || err.status === 401)) {
        const message = err.is('CLEARANCE_REQUIRED')
          ? TERMINAL_CLOSE_MESSAGES[4423]
          : err.status === 404
            ? TERMINAL_CLOSE_MESSAGES[4404]
            : err.status === 401
              ? 'La sesión ya no es válida.'
              : 'Su rol no tiene permiso para el piso compartido.'
        this.closeForGood(message)
        return
      }
      // 503 / 429 / red: reintentar con espera creciente.
      this.scheduleReconnect(err instanceof ApiError && err.retryAfter !== null ? err.retryAfter * 1000 : undefined)
      return
    }
    if (this.disposed) return

    const ws = new WebSocket(`${WS_BASE}/floor/ws?ticket=${encodeURIComponent(ticket)}`)
    this.ws = ws
    ws.onopen = () => {
      if (this.ws !== ws) return
      this.startPing()
    }
    ws.onmessage = (event: MessageEvent) => {
      if (this.ws !== ws || typeof event.data !== 'string') return
      this.handleMessage(event.data)
    }
    // onerror siempre va seguido de onclose: ahi se decide que hacer.
    ws.onerror = () => {}
    ws.onclose = (event: CloseEvent) => {
      if (this.ws !== ws) return
      this.ws = null
      this.handleClose(event)
    }
  }

  private handleClose(event: CloseEvent): void {
    this.clearTimers()
    this.rejectPendingClaims()
    // Sus reservas se liberan al cortarse: si teniamos una, la pediremos de nuevo.
    if (this.myClaim) this.reclaimAnchor = this.myClaim.cells[0] ?? null
    this.setMyClaim(null)
    // Nada de cursores ni reservas fantasma mientras estamos desconectados.
    this.members.clear()
    this.claims.clear()
    this.cursors.clear()
    this.lastSeq = null
    this.awaitingResync = false
    this.publish()
    this.emitCursors()

    if (this.disposed) return

    const terminal = TERMINAL_CLOSE_MESSAGES[event.code]
    if (terminal) {
      this.closeForGood(event.reason ? `${terminal} (${event.reason})` : terminal)
      return
    }
    if (event.code === 4401) {
      // Ticket invalido/vencido/usado: uno nuevo, una sola vez.
      if (this.ticketRetryUsed) {
        this.closeForGood('No se pudo autenticar la conexión con el piso.')
        return
      }
      this.ticketRetryUsed = true
      this.scheduleReconnect(0)
      return
    }
    if (event.code === 4429) {
      this.scheduleReconnect(Math.max(TOO_MANY_MESSAGES_WAIT_MS, this.backoffDelay()))
      return
    }
    // 4408 (sin ping), 1006, 1011, 1012, pongs perdidos y otros: reconectar con espera creciente.
    this.scheduleReconnect()
  }

  private scheduleReconnect(delayMs?: number): void {
    if (this.disposed) return
    const delay = delayMs ?? this.backoffDelay()
    this.attempt++
    this.patchState({
      status: 'reconnecting',
      statusMessage: `Sin conexión con el piso. Reintentando en ${Math.ceil(delay / 1000)} s…`,
    })
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer)
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null
      void this.connect()
    }, delay)
  }

  private backoffDelay(): number {
    const exp = Math.min(BACKOFF_MAX_MS, BACKOFF_BASE_MS * 2 ** this.attempt)
    return exp * (0.5 + Math.random() / 2) // jitter: que no reconecten todas las pestanas a la vez
  }

  private closeForGood(message: string): void {
    this.clearTimers()
    this.patchState({ status: 'closed', statusMessage: message })
  }

  // --- Mensajes ------------------------------------------------------------------

  private handleMessage(raw: string): void {
    let msg: ServerMsg
    try {
      msg = JSON.parse(raw) as ServerMsg
    } catch {
      return
    }

    switch (msg.type) {
      case 'snapshot':
        this.applySnapshot(msg)
        return
      case 'member.joined':
        if (!this.acceptSeq(msg.seq)) return
        this.members.set(msg.userId, { userId: msg.userId, displayName: msg.displayName })
        this.publish()
        return
      case 'member.left':
        if (!this.acceptSeq(msg.seq)) return
        this.members.delete(msg.userId)
        if (this.cursors.delete(msg.userId)) this.emitCursors()
        this.publish()
        return
      case 'cursor': {
        if (msg.userId === this.selfUserId) return
        const displayName = this.members.get(msg.userId)?.displayName ?? `Usuario ${msg.userId}`
        this.cursors.set(msg.userId, { userId: msg.userId, displayName, r: msg.r, c: msg.c })
        this.emitCursors()
        return
      }
      case 'claim.granted': {
        if (!this.acceptSeq(msg.seq)) return
        const claim = toClaim(msg)
        this.claims.set(claim.claimId, claim)
        this.setMyClaim(claim)
        this.reclaimAnchor = null
        const pending = this.pendingClaims.get(String(msg.requestId))
        if (pending) {
          clearTimeout(pending.timer)
          this.pendingClaims.delete(String(msg.requestId))
          pending.resolve({ ok: true, claim })
        }
        this.patchState({ claimNotice: null })
        this.publish()
        return
      }
      case 'claim.updated': {
        if (!this.acceptSeq(msg.seq)) return
        const claim = toClaim(msg)
        this.claims.set(claim.claimId, claim)
        if (this.myClaim?.claimId === claim.claimId) this.setMyClaim(claim)
        this.publish()
        return
      }
      case 'claim.released': {
        if (msg.seq !== undefined && !this.acceptSeq(msg.seq)) return
        this.claims.delete(msg.claimId)
        if (this.myClaim?.claimId === msg.claimId) {
          this.setMyClaim(null)
          this.patchState({ claimNotice: 'Su reserva se liberó (venció o se refinó el grupo).' })
        }
        this.publish()
        return
      }
      case 'claim.denied': {
        const pending = this.pendingClaims.get(String(msg.requestId))
        if (!pending) return
        clearTimeout(pending.timer)
        this.pendingClaims.delete(String(msg.requestId))
        if (msg.reason === 'HELD') {
          this.patchState({ claimNotice: `Ese grupo lo tiene reservado ${msg.holder?.displayName ?? 'otro refinador'}.` })
          pending.resolve({ ok: false, reason: 'HELD', holder: msg.holder })
        } else {
          this.patchState({ claimNotice: 'Esa celda no pertenece a un grupo refinable (ruido o ya refinada).' })
          pending.resolve({ ok: false, reason: 'NOT_A_GROUP' })
        }
        return
      }
      case 'pong':
        this.missedPongs = 0
        return
    }
  }

  private applySnapshot(msg: SnapshotMsg): void {
    this.lastSeq = msg.seq
    this.awaitingResync = false
    this.attempt = 0
    this.ticketRetryUsed = false

    // Un usuario con varias pestanas figura una sola vez: Map por userId.
    this.members = new Map(msg.members.map((m) => [m.userId, { userId: m.userId, displayName: m.displayName }]))
    this.cursors = new Map(
      msg.members
        .filter((m): m is FloorMember & Cell => m.userId !== this.selfUserId && m.r !== null && m.c !== null)
        .map((m) => [m.userId, { userId: m.userId, displayName: m.displayName, r: m.r, c: m.c }]),
    )
    this.claims = new Map(msg.claims.map((cl) => [cl.claimId, toClaim(cl)]))
    if (this.myClaim && !this.claims.has(this.myClaim.claimId)) this.setMyClaim(null)

    this.patchState({ status: 'open', statusMessage: 'Conectado al piso' })
    this.publish()
    this.emitCursors()

    // Tras reconectar, volver a pedir la reserva que se perdio en el corte.
    const anchor = this.reclaimAnchor
    if (anchor && !this.myClaim) {
      this.reclaimAnchor = null
      void this.claim(anchor.r, anchor.c).then((result) => {
        if (!result.ok) {
          this.patchState({
            claimNotice:
              result.reason === 'HELD'
                ? `Se perdió su reserva al reconectar y ahora la tiene ${result.holder?.displayName ?? 'otro refinador'}.`
                : 'Se perdió su reserva al reconectar. Vuelvan a seleccionar el grupo.',
          })
        }
      })
    }
  }

  /**
   * seq crece de uno en uno por archivo. Devuelve false si el mensaje es
   * viejo/duplicado (no aplicarlo). Ante un salto, se aplica y se pide resync:
   * el snapshot reconstruye todo.
   */
  private acceptSeq(seq: number): boolean {
    if (this.lastSeq === null) return true
    if (seq <= this.lastSeq) return false
    if (seq !== this.lastSeq + 1 && !this.awaitingResync) this.resync()
    this.lastSeq = seq
    return true
  }

  // --- Latido, renovacion y cursor -----------------------------------------------

  private startPing(): void {
    this.missedPongs = 0
    if (this.pingTimer) clearInterval(this.pingTimer)
    this.pingTimer = setInterval(() => {
      if (this.missedPongs >= MAX_MISSED_PONGS) {
        // Dos pong sin llegar: conexion muerta. Se cierra y onclose reconecta.
        this.ws?.close(4000, 'PONG_TIMEOUT')
        return
      }
      this.missedPongs++
      this.send({ type: 'ping', t: Date.now() })
    }, PING_INTERVAL_MS)
  }

  private setMyClaim(claim: FloorClaim | null): void {
    this.myClaim = claim
    if (this.renewTimer) {
      clearInterval(this.renewTimer)
      this.renewTimer = null
    }
    if (claim) {
      this.renewTimer = setInterval(() => {
        if (this.myClaim) this.send({ type: 'renew', claimId: this.myClaim.claimId })
      }, RENEW_INTERVAL_MS)
    }
  }

  private flushCursorSoon(): void {
    if (document.hidden || !this.pendingCursor || this.cursorTimer) return
    const wait = CURSOR_MIN_INTERVAL_MS - (Date.now() - this.lastCursorSentAt)
    if (wait <= 0) {
      this.flushCursor()
      return
    }
    this.cursorTimer = setTimeout(() => {
      this.cursorTimer = null
      this.flushCursor()
    }, wait)
  }

  private flushCursor(): void {
    if (document.hidden || !this.pendingCursor) return
    const { r, c } = this.pendingCursor
    if (this.send({ type: 'cursor', r, c })) {
      this.pendingCursor = null
      this.lastCursorSentAt = Date.now()
    }
  }

  private onVisibilityChange = (): void => {
    if (document.hidden) {
      if (this.cursorTimer) {
        clearTimeout(this.cursorTimer)
        this.cursorTimer = null
      }
    } else {
      this.flushCursorSoon()
    }
  }

  // --- Utilidades ----------------------------------------------------------------

  private isOpen(): boolean {
    return this.ws !== null && this.ws.readyState === WebSocket.OPEN && this.state.status === 'open'
  }

  private send(payload: Record<string, unknown>): boolean {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return false
    this.ws.send(JSON.stringify(payload))
    return true
  }

  private clearTimers(): void {
    if (this.pingTimer) clearInterval(this.pingTimer)
    if (this.renewTimer) clearInterval(this.renewTimer)
    if (this.cursorTimer) clearTimeout(this.cursorTimer)
    this.pingTimer = null
    this.renewTimer = null
    this.cursorTimer = null
  }

  private rejectPendingClaims(): void {
    for (const pending of this.pendingClaims.values()) {
      clearTimeout(pending.timer)
      pending.resolve({ ok: false, reason: 'DISCONNECTED' })
    }
    this.pendingClaims.clear()
  }

  private patchState(patch: Partial<FloorState>): void {
    this.state = { ...this.state, ...patch }
    this.notify()
  }

  /** Vuelca miembros y reservas al estado publico (una sola notificacion). */
  private publish(): void {
    this.state = {
      ...this.state,
      members: [...this.members.values()],
      claims: [...this.claims.values()],
      myClaim: this.myClaim,
    }
    this.notify()
  }

  private notify(): void {
    for (const listener of this.stateListeners) listener()
  }

  private emitCursors(): void {
    for (const listener of this.cursorListeners) listener(this.cursors)
  }
}

function toClaim(msg: FloorClaim): FloorClaim {
  return {
    claimId: msg.claimId,
    userId: msg.userId,
    displayName: msg.displayName,
    cells: msg.cells.map((cell) => ({ r: cell.r, c: cell.c })),
    expiresAt: msg.expiresAt,
  }
}

export const cellKey = (r: number, c: number): string => `${r}:${c}`
