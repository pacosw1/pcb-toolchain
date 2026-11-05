// Canvas 2D board viewer: zones, tracks, pads, vias, silk, courtyard and outline from engine geometry. Pan (drag), zoom (wheel,
// about the cursor), layer toggles (1..4), fit (F), click a pad or track to highlight its net, hover for pad
// info, Shift+drag to measure, search a reference. Geometry is cached as Path2D per layer (boardCache.ts), so
// pan and zoom only replay paths. WebGL comes when boards outgrow Canvas 2D. With `live`, the toolbar shows the live
// state; a new `geo` with `liveRefresh` set is the same board after a save and keeps the view and the selection.
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { Finding, Geometry, Pad, Footprint, Pt } from './types'
import {
  buildCache,
  buildNetCache,
  footprintBox,
  hitPad,
  hitTrack,
  padPath,
  rebasePick,
  type Pick,
  type TrackGroups
} from './boardCache'

const LAYER_COLOR: Record<string, string> = {
  'F.Cu': '#d14b4b',
  'In1.Cu': '#3aa774',
  'In2.Cu': '#d9902b',
  'B.Cu': '#4d7fe0'
}
const LAYER_HI: Record<string, string> = {
  'F.Cu': '#ff8a8a',
  'In1.Cu': '#7ff0b4',
  'In2.Cu': '#ffc56b',
  'B.Cu': '#93b8ff'
}
const DRAW_ORDER = ['In1.Cu', 'In2.Cu', 'B.Cu', 'F.Cu']
const KEY_LAYERS = ['F.Cu', 'In1.Cu', 'In2.Cu', 'B.Cu'] // keys 1..4
const ZONE_ALPHA: Record<string, number> = {
  'In1.Cu': 0.1,
  'In2.Cu': 0.14,
  'B.Cu': 0.22,
  'F.Cu': 0.22
}
const DIM = 0.22 // alpha factor of everything outside the highlighted net
type GfxKind = 'silk' | 'courtyard'
// silk and courtyard layers: toggle, colour; a B-side layer shows only while B.Cu is visible
const GFX: { kind: GfxKind; label: string; color: string; layers: [string, string, string][] }[] = [
  {
    kind: 'silk',
    label: 'Silk',
    color: '#e8e8e8',
    layers: [
      ['B.SilkS', '#8f9bc4', 'B.Cu'],
      ['F.SilkS', '#e8e8e8', 'F.Cu']
    ]
  },
  {
    kind: 'courtyard',
    label: 'Courtyard',
    color: '#d36cff',
    layers: [
      ['B.CrtYd', '#9a6cd3', 'B.Cu'],
      ['F.CrtYd', '#d36cff', 'F.Cu']
    ]
  }
]

export interface Selection {
  ref: string
  pad: Pad
}

/** Live view state, owned by the app. */
export interface LiveState {
  on: boolean
  updatedAt: number | null // ms since the epoch: when the shown board was loaded
  error: string | null // the file on disk is not usable; the shown board is the last good one
  onToggle: () => void
}

interface View {
  scale: number // px per mm
  ox: number // screen px of board x=0
  oy: number
}

function pickNet(p: Pick | null): string | null {
  if (!p) return null
  if (p.kind === 'pad') return p.pad.net || null
  if (p.kind === 'track') return p.track.net || null
  return null
}

function strokeGroups(g: CanvasRenderingContext2D, groups: TrackGroups | undefined): void {
  if (!groups) return
  for (const [w, path] of groups) {
    g.lineWidth = w
    g.stroke(path)
  }
}

export function BoardView({
  geo,
  onSelect,
  focusRef,
  findings = [],
  focusPoint,
  live,
  liveRefresh = false, linkedNet, onNetSelect
}: {
  geo: Geometry
  linkedNet?: string | null
  onNetSelect?: (net: string | null) => void
  onSelect?: (s: Selection | null) => void
  /** Zoom to this footprint and select its first pad (a new object each time = focus again). */
  focusRef?: { ref: string } | null
  /** Gate findings drawn as markers (DRC layer). */
  findings?: Finding[]
  /** Zoom to this board point (a new object each time = focus again). */
  focusPoint?: { x: number; y: number; span?: number } | null
  /** Shows the live indicator and off switch. */
  live?: LiveState
  /** `geo` is a newer version of the board on screen: keep zoom, pan and selection. */
  liveRefresh?: boolean
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
  const [pick, setPick] = useState<Pick | null>(null)
  const [showDrc, setShowDrc] = useState(true)
  const [showGfx, setShowGfx] = useState<Record<GfxKind, boolean>>({ silk: true, courtyard: false })
  const [hilite, setHilite] = useState<{ x: number; y: number } | null>(null)
  const [hover, setHover] = useState<{ x: number; y: number; text: string; net: string } | null>(
    null
  )
  const [measure, setMeasure] = useState<{ a: Pt; b: Pt } | null>(null)
  const [query, setQuery] = useState('')
  const [notFound, setNotFound] = useState(false)
  const drag = useRef<{
    x: number
    y: number
    ox: number
    oy: number
    moved: boolean
    measure: boolean
  } | null>(null)
  const hoverReq = useRef<{ raf: number; x: number; y: number } | null>(null)

  const copperLayers = useMemo(() => DRAW_ORDER.filter((l) => geo.layers.includes(l)), [geo])
  const cache = useMemo(() => buildCache(geo), [geo])
  const net = linkedNet ?? pickNet(pick)
  const netCache = useMemo(() => (net ? buildNetCache(geo, net) : null), [geo, net])

  const select = useCallback(
    (p: Pick | null) => {
      setPick(p)
      onNetSelect?.(pickNet(p))
      onSelect?.(p?.kind === 'pad' ? { ref: p.fp.ref, pad: p.pad } : null)
    },
    [onSelect, onNetSelect]
  )

  const fit = useCallback((): void => {
    const [x0, y0, x1, y1] = geo.bbox
    const pad = 24
    const scale = Math.min((size.w - 2 * pad) / (x1 - x0), (size.h - 2 * pad) / (y1 - y0))
    setView({
      scale,
      ox: (size.w - (x1 - x0) * scale) / 2 - x0 * scale,
      oy: (size.h - (y1 - y0) * scale) / 2 - y0 * scale
    })
  }, [geo, size])

  const previousSize = useRef(size)
  useEffect(() => {
    const before = previousSize.current
    previousSize.current = size
    if (before.w === size.w && before.h === size.h) return
    const ratio = Math.min(size.w / before.w, size.h / before.h)
    setView(current => current ? {
      scale: current.scale * ratio,
      ox: size.w / 2 + (current.ox - before.w / 2) * ratio,
      oy: size.h / 2 + (current.oy - before.h / 2) * ratio
    } : current)
  }, [size])

  // Fit the board when the geometry changes; a live refresh of the shown board keeps the view.
  useEffect(() => {
    if (liveRefresh && view) {
      if (pick) select(rebasePick(pick, geo))
      setHover(null)
      return
    }
    fit()
    setPick(null)
    setMeasure(null)
    setHover(null)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [geo])

  useEffect(() => {
    if (!focusPoint) return
    const scale = Math.min(size.w, size.h) / Math.max(8, (focusPoint.span ?? 0) * 1.4) // at least 8 mm across
    setView({ scale, ox: size.w / 2 - focusPoint.x * scale, oy: size.h / 2 - focusPoint.y * scale })
    setHilite(focusPoint)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focusPoint])

  const zoomTo = useCallback(
    (fp: Footprint): void => {
      const xs = fp.pads.flatMap((p) => [p.x - p.w, p.x + p.w])
      const ys = fp.pads.flatMap((p) => [p.y - p.h, p.y + p.h])
      const span =
        Math.max(Math.max(...xs) - Math.min(...xs), Math.max(...ys) - Math.min(...ys), 2) * 4
      const scale = Math.min(size.w, size.h) / span
      const cx = (Math.max(...xs) + Math.min(...xs)) / 2
      const cy = (Math.max(...ys) + Math.min(...ys)) / 2
      setView({ scale, ox: size.w / 2 - cx * scale, oy: size.h / 2 - cy * scale })
    },
    [size]
  )

  useEffect(() => {
    if (!focusRef) return
    const fp = geo.footprints.find((f) => f.ref === focusRef.ref)
    if (!fp || !fp.pads.length) return
    zoomTo(fp)
    select({ kind: 'pad', fp, pad: fp.pads[0] })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focusRef])

  useEffect(() => {
    const el = wrapRef.current
    if (!el) return
    const ro = new ResizeObserver(([e]) =>
      setSize({ w: Math.max(200, e.contentRect.width), h: Math.max(200, e.contentRect.height) })
    )
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  const draw = useCallback(() => {
    const c = canvasRef.current
    if (!c || !view) return
    const dpr = window.devicePixelRatio || 1
    if (c.width !== Math.round(size.w * dpr)) c.width = Math.round(size.w * dpr)
    if (c.height !== Math.round(size.h * dpr)) c.height = Math.round(size.h * dpr)
    const g = c.getContext('2d')!
    g.setTransform(dpr, 0, 0, dpr, 0, 0)
    g.globalAlpha = 1
    g.fillStyle = '#0a0d12'
    g.fillRect(0, 0, size.w, size.h)
    g.setTransform(dpr * view.scale, 0, 0, dpr * view.scale, dpr * view.ox, dpr * view.oy)
    const px = 1 / view.scale
    const k = netCache ? DIM : 1
    const partSel = pick?.kind === 'part' ? pick.fp : null
    const padSel = pick?.kind === 'pad' ? pick : null

    // board substrate
    g.fillStyle = '#0d2418'
    const [x0, y0, x1, y1] = geo.bbox
    g.fillRect(x0, y0, x1 - x0, y1 - y0)

    g.lineCap = 'round'
    g.lineJoin = 'round'
    for (const layer of copperLayers) {
      if (!visible[layer]) continue
      const col = LAYER_COLOR[layer]
      const zones = cache.zones.get(layer)
      if (zones) {
        g.globalAlpha = (ZONE_ALPHA[layer] ?? 0.2) * k
        g.fillStyle = col
        g.fill(zones)
      }
      g.globalAlpha = 0.9 * k
      g.strokeStyle = col
      strokeGroups(g, cache.tracks.get(layer))
    }

    // pads
    g.globalAlpha = k
    for (const pg of cache.pads) {
      if (!((pg.onF && visible['F.Cu']) || (pg.onB && visible['B.Cu']))) continue
      g.fillStyle = pg.hasNet ? '#c8a24a' : '#7d6a3a'
      g.fill(pg.path)
    }
    g.fillStyle = '#0a0d12'
    g.globalAlpha = 1
    g.fill(cache.drills)

    // vias
    g.globalAlpha = k
    g.fillStyle = '#c9ced8'
    g.fill(cache.vias)
    g.globalAlpha = 1
    g.fillStyle = '#0a0d12'
    g.fill(cache.viaHoles)

    // silk and courtyard
    for (const gx of GFX) {
      if (!showGfx[gx.kind]) continue
      for (const [layer, col, side] of gx.layers) {
        const gl = cache.graphics.get(layer)
        if (!gl || !visible[side]) continue
        g.globalAlpha = 0.85 * k
        g.fillStyle = col
        g.fill(gl.fill)
        g.strokeStyle = col
        for (const [w, path] of gl.strokes) {
          g.lineWidth = Math.max(w, px)
          g.stroke(path)
        }
      }
    }
    g.globalAlpha = 1

    // highlighted net: drawn bright over the dimmed board
    if (netCache) {
      for (const layer of copperLayers) {
        if (!visible[layer]) continue
        const zones = netCache.zones.get(layer)
        if (zones) {
          g.globalAlpha = 0.45
          g.fillStyle = LAYER_HI[layer]
          g.fill(zones)
        }
        g.globalAlpha = 1
        g.strokeStyle = LAYER_HI[layer]
        strokeGroups(g, netCache.tracks.get(layer))
      }
      g.globalAlpha = 1
      g.fillStyle = '#ffe58a'
      g.fill(netCache.pads)
      g.fillStyle = '#ffffff'
      g.fill(netCache.vias)
      g.fillStyle = '#0a0d12'
      g.fill(cache.viaHoles)
      g.fill(cache.drills)
    }
    if (padSel) {
      g.fillStyle = '#ffffff'
      g.fill(padPath(padSel.pad))
    }
    if (pick?.kind === 'track') {
      const t = pick.track
      g.strokeStyle = '#ffffff'
      g.lineWidth = t.w
      g.beginPath()
      g.moveTo(t.x1, t.y1)
      g.lineTo(t.x2, t.y2)
      g.stroke()
    }
    if (partSel) {
      const pads = new Path2D()
      for (const p of partSel.pads) padPath(p, pads)
      g.fillStyle = '#ffffff'
      g.fill(pads)
      const [bx0, by0, bx1, by1] = footprintBox(partSel)
      const m = 0.4 + 4 * px
      g.strokeStyle = '#6aa8ff'
      g.lineWidth = 2 * px
      g.setLineDash([5 * px, 3 * px])
      g.strokeRect(bx0 - m, by0 - m, bx1 - bx0 + 2 * m, by1 - by0 + 2 * m)
      g.setLineDash([])
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
        const col =
          f.kind === 'unconnected' ? '#f5f5a0' : f.severity === 'error' ? '#ff6b6b' : '#f5a524'
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

    // measurement
    if (measure) {
      const [ax, ay] = measure.a
      const [bx, by] = measure.b
      g.strokeStyle = '#7fe3ff'
      g.lineWidth = 1.5 * px
      g.setLineDash([6 * px, 4 * px])
      g.beginPath()
      g.moveTo(ax, ay)
      g.lineTo(bx, by)
      g.stroke()
      g.setLineDash([])
      g.fillStyle = '#7fe3ff'
      for (const [x, y] of [measure.a, measure.b]) {
        g.beginPath()
        g.arc(x, y, 3 * px, 0, 2 * Math.PI)
        g.fill()
      }
    }
  }, [
    geo,
    view,
    size,
    visible,
    pick,
    copperLayers,
    findings,
    showDrc,
    showGfx,
    hilite,
    cache,
    netCache,
    measure
  ])

  useEffect(() => {
    const id = requestAnimationFrame(draw)
    return () => cancelAnimationFrame(id)
  }, [draw])

  useEffect(() => () => cancelAnimationFrame(hoverReq.current?.raf ?? 0), [])

  const local = (e: { clientX: number; clientY: number }): Pt => {
    const r = canvasRef.current!.getBoundingClientRect()
    return [e.clientX - r.left, e.clientY - r.top]
  }
  const toBoard = (cx: number, cy: number): Pt => {
    const v = view!
    return [(cx - v.ox) / v.scale, (cy - v.oy) / v.scale]
  }

  const pickAt = (cx: number, cy: number): Pick | null => {
    const [bx, by] = toBoard(cx, cy)
    const margin = 2 / view!.scale // 2 px of slack for thin copper
    const hp = hitPad(geo, bx, by, visible, margin)
    if (hp) return { kind: 'pad', fp: hp.fp, pad: hp.pad }
    const t = hitTrack(geo, bx, by, visible, copperLayers, margin)
    return t ? { kind: 'track', track: t } : null
  }

  const onWheel = (e: React.WheelEvent): void => {
    if (!view) return
    const [cx, cy] = local(e)
    const kz = Math.exp(-e.deltaY * 0.0015)
    const scale = Math.min(400, Math.max(1, view.scale * kz))
    const [bx, by] = toBoard(cx, cy)
    setView({ scale, ox: cx - bx * scale, oy: cy - by * scale })
  }

  const onDown = (e: React.PointerEvent): void => {
    if (!view) return
    wrapRef.current?.focus({ preventScroll: true })
    const isMeasure = e.shiftKey
    drag.current = {
      x: e.clientX,
      y: e.clientY,
      ox: view.ox,
      oy: view.oy,
      moved: false,
      measure: isMeasure
    }
    if (isMeasure) {
      const p = toBoard(...local(e))
      setMeasure({ a: p, b: p })
    }
    setHover(null)
    ;(e.currentTarget as HTMLElement).setPointerCapture(e.pointerId)
  }

  const scheduleHover = (cx: number, cy: number): void => {
    if (hoverReq.current) {
      hoverReq.current.x = cx
      hoverReq.current.y = cy
      return
    }
    const req = { raf: 0, x: cx, y: cy }
    hoverReq.current = req
    req.raf = requestAnimationFrame(() => {
      hoverReq.current = null
      if (!view) return
      const [bx, by] = toBoard(req.x, req.y)
      const hp = hitPad(geo, bx, by, visible, 2 / view.scale)
      setHover(
        hp
          ? { x: req.x, y: req.y, text: `${hp.fp.ref}.${hp.pad.num}`, net: hp.pad.net || 'no net' }
          : null
      )
    })
  }

  const onMove = (e: React.PointerEvent): void => {
    if (!view) return
    const d = drag.current
    if (!d) {
      const [cx, cy] = local(e)
      scheduleHover(cx, cy)
      return
    }
    const dx = e.clientX - d.x
    const dy = e.clientY - d.y
    if (Math.abs(dx) + Math.abs(dy) > 3) d.moved = true
    if (d.measure) {
      const b = toBoard(...local(e))
      setMeasure((m) => (m ? { a: m.a, b } : m))
    } else if (d.moved) setView({ ...view, ox: d.ox + dx, oy: d.oy + dy })
  }
  const onUp = (e: React.PointerEvent): void => {
    const d = drag.current
    drag.current = null
    if (!d || !view) return
    if (d.measure) {
      if (!d.moved) setMeasure(null) // a Shift+click without a drag clears it
      return
    }
    if (d.moved) return
    select(pickAt(...local(e)))
  }

  const clearAll = (): void => {
    select(null)
    setMeasure(null)
    setHilite(null)
    setNotFound(false)
  }

  const onKey = (e: React.KeyboardEvent): void => {
    if (e.target !== wrapRef.current) return // keys typed in the search box stay there
    if (e.metaKey || e.ctrlKey || e.altKey) return
    if (e.key === 'Escape') {
      clearAll()
    } else if (e.key === 'f' || e.key === 'F') {
      fit()
    } else if (e.key >= '1' && e.key <= '4') {
      const l = KEY_LAYERS[Number(e.key) - 1]
      if (!geo.layers.includes(l)) return
      setVisible((v) => ({ ...v, [l]: !v[l] }))
    } else return
    e.preventDefault()
  }

  const search = (): void => {
    const q = query.trim().toUpperCase()
    if (!q) return
    const fp = geo.footprints.find((f) => f.ref.toUpperCase() === q)
    if (!fp || !fp.pads.length) {
      setNotFound(true)
      return
    }
    setNotFound(false)
    zoomTo(fp)
    select({ kind: 'part', fp })
  }

  const netPadCount = net ? (cache.netPads.get(net) ?? 0) : 0
  const mdx = measure ? measure.b[0] - measure.a[0] : 0
  const mdy = measure ? measure.b[1] - measure.a[1] : 0

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
            title={`${l} (key ${KEY_LAYERS.indexOf(l) + 1})`}
            onClick={() => setVisible((v) => ({ ...v, [l]: !v[l] }))}
          >
            <span className="swatch" style={{ background: LAYER_COLOR[l] }} />
            {l}
          </button>
        ))}
        {GFX.filter((gx) => gx.layers.some(([l]) => cache.graphics.has(l))).map((gx) => (
          <button
            key={gx.kind}
            type="button"
            aria-pressed={showGfx[gx.kind]}
            className={showGfx[gx.kind] ? 'toggle on' : 'toggle'}
            title={`${gx.label} (F/B side follows the copper layer toggles)`}
            onClick={() => setShowGfx((v) => ({ ...v, [gx.kind]: !v[gx.kind] }))}
          >
            <span className="swatch" style={{ background: gx.color }} />
            {gx.label}
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
        <button type="button" className="toggle" title="Fit board (F)" onClick={fit}>
          Fit
        </button>
        {live ? (
          <>
            <button
              type="button"
              aria-pressed={live.on}
              className={live.on ? 'toggle on' : 'toggle'}
              title="Redraw when the board file changes on disk"
              onClick={live.onToggle}
            >
              <span className={`bv-livedot${live.on ? (live.error ? ' err' : ' on') : ''}`} />
              Live
            </button>
            <span className="bv-live" role="status" aria-label="Live view">
              {!live.on
                ? 'off'
                : live.updatedAt
                  ? `updated ${new Date(live.updatedAt).toLocaleTimeString()}`
                  : 'waiting'}
            </span>
          </>
        ) : null}
        <span style={{ flex: '1 1 auto' }} />
        <form
          className="bv-search"
          role="search"
          onSubmit={(e) => {
            e.preventDefault()
            search()
          }}
        >
          <input
            type="search"
            aria-label="Find part"
            placeholder="Find ref (U1)"
            value={query}
            spellCheck={false}
            onChange={(e) => {
              setQuery(e.target.value)
              setNotFound(false)
            }}
            onKeyDown={(e) => {
              if (e.key === 'Escape') {
                setQuery('')
                setNotFound(false)
                wrapRef.current?.focus()
              }
            }}
          />
          {notFound ? (
            <span className="bv-notfound" role="alert">
              not found
            </span>
          ) : null}
        </form>
        <span style={{ color: 'var(--dim)', fontSize: 12 }}>
          {geo.footprints.length} parts · {geo.tracks.length} tracks · {geo.vias.length} vias
        </span>
      </div>
      <div
        ref={wrapRef}
        className="boardview-canvas"
        tabIndex={0}
        aria-label="Board canvas"
        onWheel={onWheel}
        onKeyDown={onKey}
      >
        <canvas
          ref={canvasRef}
          role="img"
          aria-label={`Board ${geo.pcb}`}
          data-view={view ? JSON.stringify(view) : undefined}
          style={{ width: size.w, height: size.h, display: 'block', cursor: 'crosshair' }}
          onPointerDown={onDown}
          onPointerMove={onMove}
          onPointerUp={onUp}
          onPointerLeave={() => setHover(null)}
        />
        {live?.on && live.error ? (
          <div className="bv-liveerr" role="alert" aria-label="Live view error">
            {live.error}
          </div>
        ) : null}
        {hover ? (
          <div className="bv-tip" style={{ left: hover.x + 14, top: hover.y + 14 }} aria-hidden>
            <strong>{hover.text}</strong> {hover.net}
          </div>
        ) : null}
        {measure ? (
          <div className="bv-measure" role="status" aria-label="Measurement">
            <span>dx {mdx.toFixed(3)}</span>
            <span>dy {mdy.toFixed(3)}</span>
            <strong>{Math.hypot(mdx, mdy).toFixed(3)} mm</strong>
          </div>
        ) : null}
        {pick ? (
          <div className="selbox" role="status" aria-label="Selection">
            {pick.kind === 'pad' ? (
              <>
                <strong>
                  {pick.fp.ref}.{pick.pad.num}
                </strong>
                <span>{pick.pad.net || 'no net'}</span>
                {net ? <span className="bv-dim">{netPadCount} pads on net</span> : null}
                <span className="bv-dim">
                  {pick.pad.x.toFixed(2)}, {pick.pad.y.toFixed(2)} mm
                </span>
              </>
            ) : pick.kind === 'track' ? (
              <>
                <strong>
                  Track {pick.track.layer} · {pick.track.w.toFixed(3)} mm
                </strong>
                <span>{pick.track.net || 'no net'}</span>
                {net ? <span className="bv-dim">{netPadCount} pads on net</span> : null}
              </>
            ) : (
              <>
                <strong>{pick.fp.ref}</strong>
                <span className="bv-dim">{pick.fp.lib}</span>
                <span className="bv-dim">
                  {pick.fp.pads.length} pads · {pick.fp.layer}
                </span>
              </>
            )}
          </div>
        ) : null}
        <div className="bv-hint" aria-hidden>
          Shift+drag measure · F fit · 1-4 layers · Esc clear
        </div>
      </div>
    </div>
  )
}
