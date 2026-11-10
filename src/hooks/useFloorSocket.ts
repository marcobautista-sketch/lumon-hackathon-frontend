import { useCallback, useEffect, useMemo, useState, useSyncExternalStore } from 'react'
import { useAuth } from '../auth/AuthContext'
import {
  FloorConnection,
  cellKey,
  type ClaimResult,
  type FloorClaim,
  type FloorCursor,
  type FloorState,
} from '../lib/floorSocket'

const IDLE_STATE: FloorState = {
  status: 'idle',
  statusMessage: null,
  members: [],
  claims: [],
  myClaim: null,
  claimNotice: null,
}
const noopSubscribe = () => () => {}
const getIdleState = () => IDLE_STATE
const EMPTY_CURSORS: ReadonlyMap<number, FloorCursor> = new Map()

export interface FloorApi extends FloorState {
  selfUserId: number | null
  /** Celdas reservadas por OTROS usuarios: clave `${r}:${c}` (usar cellKey). */
  claimedByOthers: ReadonlyMap<string, FloorClaim>
  /** Celdas de la reserva propia. */
  myClaimCells: ReadonlySet<string>
  sendCursor: (r: number, c: number) => void
  claim: (r: number, c: number) => Promise<ClaimResult>
  release: () => void
  resync: () => void
  /** Cursores de los demas, por fuera del render de React (no re-renderiza la grilla). */
  subscribeCursors: (listener: (cursors: ReadonlyMap<number, FloorCursor>) => void) => () => void
}

/**
 * Piso compartido de un archivo (CP5). Uso en /files/:id/refine:
 *
 *   const floor = useFloorSocket(fileId)
 *   // al mover el foco/hover sobre una celda:
 *   floor.sendCursor(r, c)
 *   // antes de llevar un grupo a una caja:
 *   const res = await floor.claim(r, c)
 *   if (!res.ok && res.reason === 'HELD') -> mostrar quien lo tiene, no permitir soltar
 *   if (!res.ok && res.reason === 'DISCONNECTED') -> sin WebSocket: refinar igual
 *   // tras refinar o al cancelar:
 *   floor.release()
 *   // pintar celdas: floor.claimedByOthers.get(cellKey(r, c))
 *
 * Una conexion por pestana mientras la grilla esta montada; se cierra al salir.
 * Pasar fileId = null para no conectar (p. ej. mientras carga el archivo).
 */
export function useFloorSocket(fileId: number | null): FloorApi {
  const { user } = useAuth()
  const selfUserId = user?.id ?? null
  // Crear el objeto no tiene efectos; conectar/desconectar va en el efecto.
  // start() es re-ejecutable tras stop() (StrictMode monta, desmonta y monta).
  const connection = useMemo(
    () => (fileId !== null && selfUserId !== null ? new FloorConnection({ fileId, selfUserId }) : null),
    [fileId, selfUserId],
  )

  useEffect(() => {
    if (!connection) return
    connection.start()
    return () => connection.stop()
  }, [connection])

  const state = useSyncExternalStore(
    connection ? connection.subscribe : noopSubscribe,
    connection ? connection.getState : getIdleState,
  )

  const claimedByOthers = useMemo(() => {
    const map = new Map<string, FloorClaim>()
    for (const claim of state.claims) {
      if (claim.userId === selfUserId) continue
      for (const cell of claim.cells) map.set(cellKey(cell.r, cell.c), claim)
    }
    return map
  }, [state.claims, selfUserId])

  const myClaimCells = useMemo(
    () => new Set(state.myClaim?.cells.map((cell) => cellKey(cell.r, cell.c)) ?? []),
    [state.myClaim],
  )

  const sendCursor = useCallback((r: number, c: number) => connection?.sendCursor(r, c), [connection])
  const claim = useCallback(
    (r: number, c: number): Promise<ClaimResult> =>
      connection ? connection.claim(r, c) : Promise.resolve({ ok: false, reason: 'DISCONNECTED' }),
    [connection],
  )
  const release = useCallback(() => connection?.release(), [connection])
  const resync = useCallback(() => connection?.resync(), [connection])
  const subscribeCursors = useCallback(
    (listener: (cursors: ReadonlyMap<number, FloorCursor>) => void) => {
      if (!connection) {
        listener(EMPTY_CURSORS)
        return () => {}
      }
      return connection.subscribeCursors(listener)
    },
    [connection],
  )

  return {
    ...state,
    selfUserId,
    claimedByOthers,
    myClaimCells,
    sendCursor,
    claim,
    release,
    resync,
    subscribeCursors,
  }
}

/**
 * Suscripcion a cursores con un render por frame como maximo. Usar SOLO en
 * componentes chicos (capa de cursores, lista de presentes), nunca en la grilla.
 */
export function useFloorCursors(floor: Pick<FloorApi, 'subscribeCursors'>): FloorCursor[] {
  const [cursors, setCursors] = useState<FloorCursor[]>([])
  const { subscribeCursors } = floor
  useEffect(() => {
    let frame = 0
    let latest: ReadonlyMap<number, FloorCursor> = EMPTY_CURSORS
    const unsubscribe = subscribeCursors((map) => {
      latest = map
      if (frame) return
      frame = requestAnimationFrame(() => {
        frame = 0
        setCursors([...latest.values()])
      })
    })
    return () => {
      unsubscribe()
      if (frame) cancelAnimationFrame(frame)
    }
  }, [subscribeCursors])
  return cursors
}
