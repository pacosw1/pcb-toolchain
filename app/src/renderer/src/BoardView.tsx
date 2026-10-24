// Canvas 2D board viewer: zones, tracks, pads, vias and outline from engine geometry. Pan (drag), zoom (wheel,
// about the cursor), layer toggles, click a pad to select it. WebGL comes when boards outgrow Canvas 2D.
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { Finding, Geometry, Pad, Footprint } from './types'

const LAYER_COLOR: Record<string, string> = {
  'F.Cu': '#d14b4b',
  'In1.Cu': '#3aa774',
  'In2.Cu': '#d9902b',
  'B.Cu': '#4d7fe0'
}
const DRAW_ORDER = ['In1.Cu', 'In2.Cu', 'B.Cu', 'F.Cu']
const ZONE_ALPHA: Record<string, number> = { 'In1.Cu': 0.1, 'In2.Cu': 0.14, 'B.Cu': 0.22, 'F.Cu': 0.22 }

export interface Selection {
  ref: string
  pad: Pad
}

interface View {
  scale: number // px per mm
  ox: number // screen px of board x=0
  oy: number
}

function padOnLayer(p: Pad, layer: string): boolean {
  return p.layers.includes(layer) || p.layers.includes('*.Cu') || (layer.endsWith('.Cu') && p.type === 'thru_hole')
}

export function BoardView({
  geo,
  onSelect,
  focusRef,
  findings = [],
  focusPoint
}: {
  geo: Geometry
  onSelect?: (s: Selection | null) => void
  /** Zoom to this footprint and select its first pad (a new object each time = focus again). */
  focusRef?: { ref: string } | null
  /** Gate findings drawn as markers (DRC layer). */
  findings?: Finding[]
  /** Zoom to this board point (a new object each time = focus again). */
  focusPoint?: { x: number; y: number; span?: number } | null
}): React.JSX.Element {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const wrapRef = useRef<HTMLDivElement>(null)
  const [view, setView] = useState<View | null>(null)
  const [size, setSize] = useState({ w: 800, h: 500 })
  const [visible, setVisible] = useState<Record<string, boolean>>({
    'F.Cu': true,
    'In1.Cu': false,
    'In2.Cu': true,
    'B.Cu': true
  })
  const [sel, setSel] = useState<Selection | null>(null)
  const [showDrc, setShowDrc] = useState(true)
  const [hilite, setHilite] = useState<{ x: number; y: number } | null>(null)
  const drag = useRef<{ x: number; y: number; ox: number; oy: number; moved: boolean } | null>(null)

  const copperLayers = useMemo(() => DRAW_ORDER.filter((l) => geo.layers.includes(l)), [geo])

  // Fit the board when the geometry changes.
  useEffect(() => {
    const [x0, y0, x1, y1] = geo.bbox
    const pad = 24
    const scale = Math.min((size.w - 2 * pad) / (x1 - x0), (size.h - 2 * pad) / (y1 - y0))
    setView({ scale, ox: (size.w - (x1 - x0) * scale) / 2 - x0 * scale, oy: (size.h - (y1 - y0) * scale) / 2 - y0 * scale })
    setSel(null)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [geo])

  useEffect(() => {
    if (!focusPoint) return
    const scale = Math.min(size.w, size.h) / Math.max(8, (focusPoint.span ?? 0) * 1.4) // at least 8 mm across
    setView({ scale, ox: size.w / 2 - focusPoint.x * scale, oy: size.h / 2 - focusPoint.y * scale })
    setHilite(focusPoint)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focusPoint])

  useEffect(() => {
    if (!focusRef) return
    const fp = geo.footprints.find((f) => f.ref === focusRef.ref)
    if (!fp || !fp.pads.length) return
    const xs = fp.pads.flatMap((p) => [p.x - p.w, p.x + p.w])
    const ys = fp.pads.flatMap((p) => [p.y - p.h, p.y + p.h])
    const span = Math.max(Math.max(...xs) - Math.min(...xs), Math.max(...ys) - Math.min(...ys), 2) * 4
    const scale = Math.min(size.w, size.h) / span
    const cx = (Math.max(...xs) + Math.min(...xs)) / 2
    const cy = (Math.max(...ys) + Math.min(...ys)) / 2
    setView({ scale, ox: size.w / 2 - cx * scale, oy: size.h / 2 - cy * scale })
    const s = { ref: fp.ref, pad: fp.pads[0] }
    setSel(s)
    onSelect?.(s)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focusRef])

  useEffect(() => {
    const el = wrapRef.current
    if (!el) return
    const ro = new ResizeObserver(([e]) => setSize({ w: Math.max(200, e.contentRect.width), h: Math.max(200, e.contentRect.height) }))
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  const draw = useCallback(() => {
    const c = canvasRef.current
    if (!c || !view) return
    const dpr = window.devicePixelRatio || 1
    c.width = size.w * dpr
    c.height = size.h * dpr
    const g = c.getContext('2d')!
    g.setTransform(dpr, 0, 0, dpr, 0, 0)
    g.fillStyle = '#0a0d12'
    g.fillRect(0, 0, size.w, size.h)
    g.setTransform(dpr * view.scale, 0, 0, dpr * view.scale, dpr * view.ox, dpr * view.oy)
    const px = 1 / view.scale

    // board substrate
    g.fillStyle = '#0d2418'
    const [x0, y0, x1, y1] = geo.bbox
    g.fillRect(x0, y0, x1 - x0, y1 - y0)

    for (const layer of copperLayers) {
      if (!visible[layer]) continue
      const col = LAYER_COLOR[layer]
      // zone fills
      g.globalAlpha = ZONE_ALPHA[layer] ?? 0.2
      g.fillStyle = col
      for (const z of geo.zones) {
        if (z.rule_area) continue
        for (const f of z.filled) {
          if (f.layer !== layer || f.pts.length < 3) continue
          g.beginPath()
          g.moveTo(f.pts[0][0], f.pts[0][1])
          for (let i = 1; i < f.pts.length; i++) g.lineTo(f.pts[i][0], f.pts[i][1])
          g.closePath()
          g.fill()
        }
      }
      // tracks
      g.globalAlpha = 0.9
      g.strokeStyle = col
      g.lineCap = 'round'
      for (const t of geo.tracks) {
        if (t.layer !== layer) continue
        g.lineWidth = t.w
        g.beginPath()
        g.moveTo(t.x1, t.y1)
        g.lineTo(t.x2, t.y2)
        g.stroke()
      }
    }
    g.globalAlpha = 1

    // pads (top first so selection reads well)
    for (const fp of geo.footprints) {
      for (const p of fp.pads) {
        const onF = padOnLayer(p, 'F.Cu') && visible['F.Cu']
        const onB = padOnLayer(p, 'B.Cu') && visible['B.Cu']
        if (!onF && !onB) continue
        const isSel = sel && sel.ref === fp.ref && sel.pad.num === p.num
        g.fillStyle = isSel ? '#ffffff' : p.net ? '#c8a24a' : '#7d6a3a'
        g.save()
        g.translate(p.x, p.y)
        g.rotate((-p.rot * Math.PI) / 180)
        if (p.shape === 'circle') {
          g.beginPath()
          g.arc(0, 0, p.w / 2, 0, 2 * Math.PI)
          g.fill()
        } else if (p.shape === 'oval') {
          const r = Math.min(p.w, p.h) / 2
          g.beginPath()
          g.roundRect(-p.w / 2, -p.h / 2, p.w, p.h, r)
          g.fill()
        } else {
          const r = p.shape === 'roundrect' ? Math.min(p.w, p.h) * (p.rratio || 0.25) : 0
          g.beginPath()
          g.roundRect(-p.w / 2, -p.h / 2, p.w, p.h, r)
          g.fill()
        }
        if (p.drill) {
          g.fillStyle = '#0a0d12'
          g.beginPath()
          g.arc(0, 0, p.drill / 2, 0, 2 * Math.PI)
          g.fill()
        }
        g.restore()
      }
    }

    // vias
    for (const v of geo.vias) {
      g.fillStyle = '#c9ced8'
      g.beginPath()
      g.arc(v.x, v.y, v.d / 2, 0, 2 * Math.PI)
      g.fill()
      g.fillStyle = '#0a0d12'
      g.beginPath()
      g.arc(v.x, v.y, v.drill / 2, 0, 2 * Math.PI)
      g.fill()
    }

    // outline
    g.strokeStyle = '#d6c25a'
    g.lineWidth = Math.max(0.1, 1.5 * px)
    for (const line of geo.outline) {
      g.beginPath()
      line.forEach(([x, y], i) => (i ? g.lineTo(x, y) : g.moveTo(x, y)))
      g.stroke()
    }

    // gate findings: unconnected = dashed line between its items; violation = ring at each item
    if (showDrc) {
      for (const f of findings) {
        const col = f.kind === 'unconnected' ? '#f5f5a0' : f.severity === 'error' ? '#ff6b6b' : '#f5a524'
        g.strokeStyle = col
        g.lineWidth = Math.max(0.05, 1.5 * px)
        if (f.kind === 'unconnected' && f.items.length > 1) {
          g.setLineDash([4 * px, 3 * px])
          g.beginPath()
          f.items.forEach((it, i) => (i ? g.lineTo(it.x, it.y) : g.moveTo(it.x, it.y)))
          g.stroke()
          g.setLineDash([])
        }
        const r = Math.max(0.4, 7 * px)
        for (const it of f.items.length ? f.items : [f]) {
          g.beginPath()
          g.arc(it.x, it.y, r, 0, 2 * Math.PI)
          g.stroke()
        }
      }
    }
    if (hilite) {
      g.strokeStyle = '#ffffff'
      g.lineWidth = 2 * px
      g.beginPath()
      g.arc(hilite.x, hilite.y, 14 * px, 0, 2 * Math.PI)
      g.stroke()
    }

    // reference labels when zoomed in
    if (view.scale > 6) {
      g.fillStyle = '#e8e8e8'
      g.font = `${11 * px}px JetBrains Mono, monospace`
      g.textAlign = 'center'
      for (const fp of geo.footprints) g.fillText(fp.ref, fp.x, fp.y)
    }
  }, [geo, view, size, visible, sel, copperLayers, findings, showDrc, hilite])

  useEffect(() => {
    const id = requestAnimationFrame(draw)
    return () => cancelAnimationFrame(id)
  }, [draw])

  const toBoard = (cx: number, cy: number): [number, number] => {
    const v = view!
    return [(cx - v.ox) / v.scale, (cy - v.oy) / v.scale]
  }

  const hitPad = (bx: number, by: number): Selection | null => {
    let best: { d: number; fp: Footprint; p: Pad } | null = null
    for (const fp of geo.footprints) {
      for (const p of fp.pads) {
        const d = Math.hypot(p.x - bx, p.y - by)
        if (d <= Math.max(p.w, p.h) / 2 && (!best || d < best.d)) best = { d, fp, p }
      }
    }
    return best ? { ref: best.fp.ref, pad: best.p } : null
  }

  const onWheel = (e: React.WheelEvent): void => {
    if (!view) return
    const r = (e.currentTarget as HTMLElement).getBoundingClientRect()
    const cx = e.clientX - r.left
    const cy = e.clientY - r.top
    const k = Math.exp(-e.deltaY * 0.0015)
    const scale = Math.min(400, Math.max(1, view.scale * k))
    const [bx, by] = toBoard(cx, cy)
    setView({ scale, ox: cx - bx * scale, oy: cy - by * scale })
  }

  const onDown = (e: React.PointerEvent): void => {
    if (!view) return
    drag.current = { x: e.clientX, y: e.clientY, ox: view.ox, oy: view.oy, moved: false }
    ;(e.currentTarget as HTMLElement).setPointerCapture(e.pointerId)
  }
  const onMove = (e: React.PointerEvent): void => {
    const d = drag.current
    if (!d || !view) return
    const dx = e.clientX - d.x
    const dy = e.clientY - d.y
    if (Math.abs(dx) + Math.abs(dy) > 3) d.moved = true
    if (d.moved) setView({ ...view, ox: d.ox + dx, oy: d.oy + dy })
  }
  const onUp = (e: React.PointerEvent): void => {
    const d = drag.current
    drag.current = null
    if (!d || d.moved || !view) return
    const r = (e.currentTarget as HTMLElement).getBoundingClientRect()
    const s = hitPad(...toBoard(e.clientX - r.left, e.clientY - r.top))
    setSel(s)
    onSelect?.(s)
  }

  return (
    <div className="boardview">
      <div className="boardview-bar">
        <span style={{ color: 'var(--dim)', fontSize: 12 }}>Layers</span>
        {copperLayers.map((l) => (
          <button
            key={l}
            type="button"
            aria-pressed={visible[l]}
            className={visible[l] ? 'toggle on' : 'toggle'}
            onClick={() => setVisible((v) => ({ ...v, [l]: !v[l] }))}
          >
            <span className="swatch" style={{ background: LAYER_COLOR[l] }} />
            {l}
          </button>
        ))}
        <button
          type="button"
          aria-pressed={showDrc}
          className={showDrc ? 'toggle on' : 'toggle'}
          onClick={() => setShowDrc((v) => !v)}
          disabled={!findings.length}
        >
          <span className="swatch" style={{ background: '#ff6b6b' }} />
          DRC {findings.length}
        </button>
        <span style={{ flex: '1 1 auto' }} />
        <span style={{ color: 'var(--dim)', fontSize: 12 }}>
          {geo.footprints.length} parts · {geo.tracks.length} tracks · {geo.vias.length} vias
        </span>
      </div>
      <div ref={wrapRef} className="boardview-canvas" onWheel={onWheel}>
        <canvas
          ref={canvasRef}
          role="img"
          aria-label={`Board ${geo.pcb}`}
          style={{ width: size.w, height: size.h, display: 'block', cursor: 'crosshair' }}
          onPointerDown={onDown}
          onPointerMove={onMove}
          onPointerUp={onUp}
        />
        {sel ? (
          <div className="selbox" role="status" aria-label="Selection">
            <strong>
              {sel.ref}.{sel.pad.num}
            </strong>
            <span>{sel.pad.net || 'no net'}</span>
            <span>
              {sel.pad.x.toFixed(2)}, {sel.pad.y.toFixed(2)} mm
            </span>
          </div>
        ) : null}
      </div>
    </div>
  )
}
