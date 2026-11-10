import type { FloorApi } from '../../hooks/useFloorSocket'
import { useFloorCursors } from '../../hooks/useFloorSocket'
import type { FloorStatus } from '../../lib/floorSocket'
import { userColor } from './userColor'

const STATUS_LABEL: Record<FloorStatus, string> = {
  idle: 'Piso: sin conectar',
  connecting: 'Piso: conectando…',
  open: 'Piso: conectado',
  reconnecting: 'Piso: reconectando…',
  closed: 'Piso: desconectado',
  unavailable: 'Piso: no disponible',
}

const STATUS_DOT: Record<FloorStatus, string> = {
  idle: 'bg-slate-500',
  connecting: 'bg-amber-400',
  open: 'bg-emerald-400',
  reconnecting: 'bg-amber-400',
  closed: 'bg-red-500',
  unavailable: 'bg-slate-500',
}

interface FloorPresenceProps {
  floor: FloorApi
  /** ¿La celda esta dentro de la ventana visible de la grilla? */
  isCellVisible?: (r: number, c: number) => boolean
  /** Lleva la grilla a la posicion de otro refinador. */
  onGoTo?: (r: number, c: number) => void
}

/**
 * Indicador de conexion + lista de presentes (sin duplicados: el backend
 * manda un miembro por usuario y el hook los guarda por userId). Quien
 * este fuera de la vista se marca y se puede ir a su posicion.
 */
export function FloorPresence({ floor, isCellVisible, onGoTo }: FloorPresenceProps) {
  const cursors = useFloorCursors(floor)
  const cursorByUser = new Map(cursors.map((cur) => [cur.userId, cur]))

  return (
    <aside aria-label="Piso compartido" className="space-y-2 rounded border border-slate-800 bg-slate-900 p-3 text-sm text-slate-200">
      <p role="status" aria-live="polite" className="flex items-center gap-2">
        <span aria-hidden="true" className={`inline-block h-2.5 w-2.5 rounded-full ${STATUS_DOT[floor.status]}`} />
        <span>{STATUS_LABEL[floor.status]}</span>
      </p>
      {floor.statusMessage && floor.status !== 'open' && <p className="text-xs text-slate-400">{floor.statusMessage}</p>}
      {floor.claimNotice && (
        <p role="alert" className="text-xs text-amber-300">
          {floor.claimNotice}
        </p>
      )}

      {floor.members.length > 0 && (
        <ul className="space-y-1" aria-label="Refinadores presentes">
          {floor.members.map((member) => {
            const isSelf = member.userId === floor.selfUserId
            const cursor = cursorByUser.get(member.userId)
            const outOfView = !isSelf && cursor && isCellVisible ? !isCellVisible(cursor.r, cursor.c) : false
            return (
              <li key={member.userId} className="flex items-center justify-between gap-2">
                <span className="flex min-w-0 items-center gap-2">
                  <span aria-hidden="true" className="inline-block h-2.5 w-2.5 shrink-0 rounded-full" style={{ backgroundColor: userColor(member.userId) }} />
                  <span className="truncate">
                    {member.displayName}
                    {isSelf && ' (ustedes)'}
                  </span>
                  {cursor && !isSelf && (
                    <span className="shrink-0 text-xs text-slate-400">
                      f{cursor.r} c{cursor.c}
                      {outOfView && ' · fuera de vista'}
                    </span>
                  )}
                </span>
                {cursor && !isSelf && onGoTo && outOfView && (
                  <button
                    type="button"
                    onClick={() => onGoTo(cursor.r, cursor.c)}
                    className="shrink-0 rounded border border-slate-700 px-2 py-0.5 text-xs hover:bg-slate-800"
                  >
                    Ir
                  </button>
                )}
              </li>
            )
          })}
        </ul>
      )}
    </aside>
  )
}
