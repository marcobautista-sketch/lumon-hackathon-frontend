import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type KeyboardEvent,
  type MouseEvent,
  type PointerEvent,
  type ReactElement,
} from 'react'
import { BINS, CHAR_BIN, type Bin, type Cell, type Rules } from './types'
import { isScary } from './groups'
import type { TileStore } from './tileStore'

/** Lado de cada celda en px. */
export const CELL = 26
/** Tope duro de celdas en el DOM (el enunciado exige <= 2500). */
const MAX_CELLS = 2400
const OVERSCAN = 1

interface GridProps {
  store: TileStore
  rules: Rules
  /** Cambia cada vez que llega un bloque o se refina: fuerza re-render. */
  revision: number
  focus: Cell
  onFocusChange: (cell: Cell) => void
  selected: Set<number>
  /** Enter / clic sobre una celda: seleccionar su grupo. */
  onActivate: (cell: Cell) => void
  /** Teclas 1-4 o soltar el arrastre sobre una caja. */
  onRefine: (bin: Bin) => void
  onClearSelection: () => void
  onDragHover: (bin: Bin | null) => void
  /** Posicion inicial (de ?r=&c=). */
  initial: Cell
  /** Celda arriba-izquierda visible, para escribir ?r=&c= en la URL. */
  onScrollPosition: (cell: Cell) => void
}

const BIN_BG: Record<Bin, string> = {
  WO: 'bg-emerald-900/70 text-emerald-200',
  FC: 'bg-sky-900/70 text-sky-200',
  DR: 'bg-violet-900/70 text-violet-200',
  MA: 'bg-rose-900/70 text-rose-200',
}

/** Nivel de temblor 1-3 segun cuanto supera el umbral. */
function trembleLevel(tremor: number, threshold: number): 1 | 2 | 3 {
  const span = Math.max(1, 100 - threshold)
  const x = (tremor - threshold) / span
  return x > 0.66 ? 3 : x > 0.33 ? 2 : 1
}

export function Grid(props: GridProps) {
  const { store, rules, focus, selected, initial } = props
  const scrollerRef = useRef<HTMLDivElement>(null)
  const ghostRef = useRef<HTMLDivElement>(null)
  const [view, setView] = useState({ top: initial.r * CELL, left: initial.c * CELL, w: 800, h: 600 })
  const keyboardMoved = useRef(false)

  // --- Posicion inicial desde la URL -----------------------------------------
  useLayoutEffect(() => {
    const el = scrollerRef.current
    if (!el) return
    el.scrollTop = initial.r * CELL
    el.scrollLeft = initial.c * CELL
    setView({ top: el.scrollTop, left: el.scrollLeft, w: el.clientWidth, h: el.clientHeight })
    // Solo al montar: luego el scroll lo maneja el usuario.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // --- Scroll y resize (con requestAnimationFrame para no renderizar de mas) -
  useEffect(() => {
    const el = scrollerRef.current
    if (!el) return
    let raf = 0
    const read = () => {
      raf = 0
      setView({ top: el.scrollTop, left: el.scrollLeft, w: el.clientWidth, h: el.clientHeight })
    }
    const onScroll = () => {
      if (!raf) raf = requestAnimationFrame(read)
    }
    el.addEventListener('scroll', onScroll, { passive: true })
    const ro = new ResizeObserver(onScroll)
    ro.observe(el)
    return () => {
      el.removeEventListener('scroll', onScroll)
      ro.disconnect()
      if (raf) cancelAnimationFrame(raf)
    }
  }, [])

  // --- Ventana visible (virtualizacion) -------------------------------------
  let r0 = Math.max(0, Math.floor(view.top / CELL) - OVERSCAN)
  let r1 = Math.min(store.rows - 1, Math.floor((view.top + view.h) / CELL) + OVERSCAN)
  let c0 = Math.max(0, Math.floor(view.left / CELL) - OVERSCAN)
  let c1 = Math.min(store.cols - 1, Math.floor((view.left + view.w) / CELL) + OVERSCAN)
  // Tope duro: aunque la pantalla sea enorme, nunca mas de MAX_CELLS.
  while ((r1 - r0 + 1) * (c1 - c0 + 1) > MAX_CELLS) {
    if (r1 - r0 >= c1 - c0) r1--
    else c1--
  }

  // --- Pedir los bloques visibles (y cancelar los que salieron) -------------
  const tr0 = Math.floor(r0 / store.tileSize)
  const tr1 = Math.floor(r1 / store.tileSize)
  const tc0 = Math.floor(c0 / store.tileSize)
  const tc1 = Math.floor(c1 / store.tileSize)
  useEffect(() => {
    const tiles: [number, number][] = []
    for (let tr = tr0; tr <= tr1; tr++) for (let tc = tc0; tc <= tc1; tc++) tiles.push([tr, tc])
    store.setWanted(tiles)
  }, [store, tr0, tr1, tc0, tc1])

  // --- ?r=&c= en la URL (con debounce; el padre usa replace) -----------------
  const topRow = Math.floor(view.top / CELL)
  const leftCol = Math.floor(view.left / CELL)
  const { onScrollPosition } = props
  useEffect(() => {
    const t = setTimeout(() => onScrollPosition({ r: topRow, c: leftCol }), 250)
    return () => clearTimeout(t)
  }, [topRow, leftCol, onScrollPosition])

  // --- Foco: mover el foco real del DOM cuando se navega con teclado ---------
  useEffect(() => {
    if (!keyboardMoved.current) return
    keyboardMoved.current = false
    const el = scrollerRef.current?.querySelector<HTMLElement>(
      `[data-r="${focus.r}"][data-c="${focus.c}"]`,
    )
    el?.focus({ preventScroll: true })
  }, [focus])

  const ensureVisible = (r: number, c: number) => {
    const el = scrollerRef.current
    if (!el) return
    if (r * CELL < el.scrollTop) el.scrollTop = r * CELL
    else if ((r + 1) * CELL > el.scrollTop + el.clientHeight) el.scrollTop = (r + 1) * CELL - el.clientHeight
    if (c * CELL < el.scrollLeft) el.scrollLeft = c * CELL
    else if ((c + 1) * CELL > el.scrollLeft + el.clientWidth) el.scrollLeft = (c + 1) * CELL - el.clientWidth
  }

  const moveFocus = (r: number, c: number) => {
    const nr = Math.min(store.rows - 1, Math.max(0, r))
    const nc = Math.min(store.cols - 1, Math.max(0, c))
    keyboardMoved.current = true
    ensureVisible(nr, nc)
    props.onFocusChange({ r: nr, c: nc })
  }

  const onKeyDown = (e: KeyboardEvent) => {
    const page = Math.max(1, Math.floor(view.h / CELL) - 1)
    const { r, c } = focus
    switch (e.key) {
      case 'ArrowUp': moveFocus(r - 1, c); break
      case 'ArrowDown': moveFocus(r + 1, c); break
      case 'ArrowLeft': moveFocus(r, c - 1); break
      case 'ArrowRight': moveFocus(r, c + 1); break
      case 'PageUp': moveFocus(r - page, c); break
      case 'PageDown': moveFocus(r + page, c); break
      case 'Home': moveFocus(e.ctrlKey ? 0 : r, 0); break
      case 'End': moveFocus(e.ctrlKey ? store.rows - 1 : r, store.cols - 1); break
      case 'Enter':
      case ' ':
        props.onActivate(focus)
        break
      case 'Escape':
        props.onClearSelection()
        break
      case '1':
      case '2':
      case '3':
      case '4':
        props.onRefine(BINS[Number(e.key) - 1])
        break
      default:
        return
    }
    e.preventDefault()
  }

  // --- Arrastre con Pointer Events (sin libreria) ----------------------------
  const drag = useRef<{ id: number; x: number; y: number; active: boolean; hover: Bin | null } | null>(null)
  const suppressClick = useRef(false)

  const cellFromEvent = (target: EventTarget): Cell | null => {
    const el = (target as HTMLElement).closest<HTMLElement>('[data-r]')
    if (!el) return null
    return { r: Number(el.dataset.r), c: Number(el.dataset.c) }
  }

  const onPointerDown = (e: PointerEvent) => {
    if (e.button !== 0) return
    const cell = cellFromEvent(e.target)
    if (!cell || !selected.has(cell.r * store.cols + cell.c)) return
    // Solo se arrastra desde una celda del grupo seleccionado.
    drag.current = { id: e.pointerId, x: e.clientX, y: e.clientY, active: false, hover: null }
    scrollerRef.current?.setPointerCapture(e.pointerId)
  }

  const onPointerMove = (e: PointerEvent) => {
    const d = drag.current
    if (!d || d.id !== e.pointerId) return
    if (!d.active && Math.hypot(e.clientX - d.x, e.clientY - d.y) > 6) d.active = true
    if (!d.active) return
    const ghost = ghostRef.current
    if (ghost) {
      ghost.style.display = 'block'
      ghost.style.transform = `translate(${e.clientX + 12}px, ${e.clientY + 12}px)`
    }
    const over = document.elementFromPoint(e.clientX, e.clientY)?.closest<HTMLElement>('[data-bin]')
    const bin = (over?.dataset.bin as Bin | undefined) ?? null
    if (bin !== d.hover) {
      d.hover = bin
      props.onDragHover(bin)
    }
  }

  const endDrag = (e: PointerEvent, drop: boolean) => {
    const d = drag.current
    if (!d || d.id !== e.pointerId) return
    drag.current = null
    if (ghostRef.current) ghostRef.current.style.display = 'none'
    props.onDragHover(null)
    if (d.active) {
      suppressClick.current = true
      if (drop && d.hover) props.onRefine(d.hover)
    }
  }

  const onClick = (e: MouseEvent) => {
    if (suppressClick.current) {
      suppressClick.current = false
      return
    }
    const cell = cellFromEvent(e.target)
    if (!cell) return
    props.onFocusChange(cell)
    props.onActivate(cell)
  }

  // --- Render de la ventana --------------------------------------------------
  const renderCell = (r: number, c: number): ReactElement => {
    const data = store.getCell(r, c)
    const isFocus = r === focus.r && c === focus.c
    const isSel = selected.has(r * store.cols + c)
    let cls = 'absolute flex items-center justify-center select-none text-[13px] font-mono '
    let content: ReactElement | string = ''
    if (!data) {
      cls += 'bg-slate-900/60 text-slate-700' // placeholder del mismo tamaño
    } else if (data.bin !== '.') {
      cls += BIN_BG[CHAR_BIN[data.bin]]
      content = String(data.value)
    } else if (isScary(data.tremor, rules)) {
      cls += 'text-amber-300 font-bold '
      content = (
        <span className={`scary t${trembleLevel(data.tremor, rules.tremorThreshold)}`}>{data.value}</span>
      )
    } else {
      cls += 'text-slate-400'
      content = String(data.value)
    }
    if (isSel) cls += ' !bg-sky-600 !text-white'
    if (isFocus) cls += ' outline outline-2 -outline-offset-2 outline-yellow-300 z-10'
    return (
      <div
        key={c}
        role="gridcell"
        aria-colindex={c + 1}
        aria-selected={isSel}
        tabIndex={isFocus ? 0 : -1}
        data-r={r}
        data-c={c}
        className={cls}
        style={{ left: c * CELL, top: 0, width: CELL, height: CELL }}
      >
        {content}
      </div>
    )
  }

  const rows: ReactElement[] = []
  for (let r = r0; r <= r1; r++) {
    const cells: ReactElement[] = []
    for (let c = c0; c <= c1; c++) cells.push(renderCell(r, c))
    // La celda con foco siempre esta en el DOM, aunque haya salido de la vista.
    if (r === focus.r && (focus.c < c0 || focus.c > c1)) cells.push(renderCell(r, focus.c))
    rows.push(
      <div key={r} role="row" aria-rowindex={r + 1} className="absolute left-0" style={{ top: r * CELL, height: CELL }}>
        {cells}
      </div>,
    )
  }
  if (focus.r < r0 || focus.r > r1) {
    rows.push(
      <div key={`f${focus.r}`} role="row" aria-rowindex={focus.r + 1} className="absolute left-0" style={{ top: focus.r * CELL, height: CELL }}>
        {renderCell(focus.r, focus.c)}
      </div>,
    )
  }

  return (
    <>
      <div
        ref={scrollerRef}
        role="grid"
        aria-label="Grilla del archivo"
        aria-rowcount={store.rows}
        aria-colcount={store.cols}
        aria-multiselectable="true"
        onKeyDown={onKeyDown}
        onClick={onClick}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={(e) => endDrag(e, true)}
        onPointerCancel={(e) => endDrag(e, false)}
        className="relative h-[min(70vh,720px)] w-full overflow-auto rounded border border-slate-800 bg-slate-950"
      >
        {/* Espaciador con el tamaño total: el scroll es real en ambos ejes. */}
        <div style={{ width: store.cols * CELL, height: store.rows * CELL }} className="relative">
          {rows}
        </div>
      </div>
      <div
        ref={ghostRef}
        aria-hidden="true"
        className="pointer-events-none fixed left-0 top-0 z-50 hidden rounded bg-sky-600 px-2 py-1 text-xs text-white shadow-lg"
      >
        {selected.size} celdas
      </div>
    </>
  )
}
