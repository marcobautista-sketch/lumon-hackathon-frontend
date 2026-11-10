import type { FloorApi } from '../../hooks/useFloorSocket'
import { useFloorCursors } from '../../hooks/useFloorSocket'
import { userColor } from './userColor'

export interface VisibleRange {
  rowStart: number
  /** Exclusivo. */
  rowEnd: number
  colStart: number
  /** Exclusivo. */
  colEnd: number
}

interface FloorCursorLayerProps {
  floor: Pick<FloorApi, 'subscribeCursors'>
  cellWidth: number
  cellHeight: number
  /** Solo se pintan los cursores sobre celdas visibles. */
  visible: VisibleRange
}

/**
 * Capa de cursores de los demas refinadores. Se coloca DENTRO del contenedor
 * de contenido de la grilla (el que mide rows*cellHeight x cols*cellWidth),
 * con position: relative en ese contenedor. Se re-renderiza sola (max. una vez
 * por frame) sin tocar la grilla, y no captura eventos del puntero.
 */
export function FloorCursorLayer({ floor, cellWidth, cellHeight, visible }: FloorCursorLayerProps) {
  const cursors = useFloorCursors(floor)

  return (
    <div aria-hidden="true" className="pointer-events-none absolute inset-0 z-10">
      {cursors
        .filter((cur) => cur.r >= visible.rowStart && cur.r < visible.rowEnd && cur.c >= visible.colStart && cur.c < visible.colEnd)
        .map((cur) => (
          <div
            key={cur.userId}
            className="absolute left-0 top-0 motion-safe:transition-transform motion-safe:duration-100"
            style={{
              width: cellWidth,
              height: cellHeight,
              transform: `translate(${cur.c * cellWidth}px, ${cur.r * cellHeight}px)`,
              outline: `2px solid ${userColor(cur.userId)}`,
              outlineOffset: -1,
            }}
          >
            <span
              className="absolute left-full top-0 ml-0.5 whitespace-nowrap rounded px-1 text-[10px] font-medium text-slate-950"
              style={{ backgroundColor: userColor(cur.userId) }}
            >
              {cur.displayName}
            </span>
          </div>
        ))}
    </div>
  )
}
