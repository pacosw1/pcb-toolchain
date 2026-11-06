import { useEffect, useMemo, useRef } from 'react'
import type { Geometry, Pt } from './types'
import { padPath } from './boardCache'
import type { LiveState, LivePlacement } from '../../../../../job-daemon/src/live-protocol'
export interface InspectSelection {
  ref?: string
  net?: string
}
const color = (layer: string): string =>
  layer === 'B.Cu' ? '#6494ff' : layer.startsWith('In') ? '#55b9a0' : '#f17e75'
export function LiveCanvas({
  geo,
  state,
  compare,
  selection,
  onSelect,
  focus,
  best
}: {
  geo: Geometry
  state: LiveState
  compare: LiveState | null
  selection: InspectSelection | null
  onSelect: (s: InspectSelection | null) => void
  focus: [number, number, number, number] | null
  best: boolean
}): React.JSX.Element {
  const canvas = useRef<HTMLCanvasElement>(null),
    host = useRef<HTMLDivElement>(null)
  const view = useRef({ x: 0, y: 0, scale: 1, ready: false })
  const drag = useRef<{ x: number; y: number; vx: number; vy: number; moved: boolean } | null>(null)
  const latest = useRef({ state, compare, selection, best, at: performance.now() })
  const shown = useRef(new Map<string, LivePlacement>())
  const start = useRef(new Map<string, LivePlacement>())
  const pads = useMemo(
    () =>
      new Map(
        geo.footprints.map((f) => [f.ref, f.pads.map((p) => ({ pad: p, path: padPath(p) }))])
      ),
    [geo]
  )
  useEffect(() => {
    start.current = new Map(shown.current)
    latest.current = { state, compare, selection, best, at: performance.now() }
  }, [state, compare, selection, best])
  const fit = (region: [number, number, number, number]): void => {
    const el = host.current
    if (!el) return
    const [a, b, c, d] = region,
      scale = Math.min(
        el.clientWidth / Math.max(c - a + 4, 1),
        el.clientHeight / Math.max(d - b + 4, 1)
      )
    view.current = {
      scale,
      x: el.clientWidth / 2 - ((a + c) / 2) * scale,
      y: el.clientHeight / 2 - ((b + d) / 2) * scale,
      ready: true
    }
  }
  useEffect(() => {
    fit(geo.bbox)
  }, [geo])
  useEffect(() => {
    if (focus) fit(focus)
  }, [focus])
  useEffect(() => {
    const el = canvas.current!,
      wrapper = host.current!
    let frame = 0
    const line = (g: CanvasRenderingContext2D, pts: Pt[], stroke: string, width: number): void => {
      if (!pts.length) return
      g.beginPath()
      g.moveTo(...pts[0])
      for (const p of pts.slice(1)) g.lineTo(...p)
      g.strokeStyle = stroke
      g.lineWidth = width
      g.stroke()
    }
    const paint = (): void => {
      const w = wrapper.clientWidth,
        h = wrapper.clientHeight,
        dpr = devicePixelRatio
      if (el.width !== Math.round(w * dpr) || el.height !== Math.round(h * dpr)) {
        el.width = Math.round(w * dpr)
        el.height = Math.round(h * dpr)
        if (!view.current.ready) fit(geo.bbox)
      }
      const g = el.getContext('2d')!
      g.setTransform(dpr, 0, 0, dpr, 0, 0)
      g.fillStyle = '#111820'
      g.fillRect(0, 0, w, h)
      const v = view.current
      g.translate(v.x, v.y)
      g.scale(v.scale, v.scale)
      g.lineCap = 'round'
      g.lineJoin = 'round'
      const { state: s, compare: c, selection: pick, best: showBest, at } = latest.current
      for (const chain of geo.outline) line(g, chain, '#81a29e', 0.12)
      const dim = (net: string): number => (pick?.net && pick.net !== net ? 0.16 : 1)
      for (const t of s.board?.includesBaseCopper && s.board.phase !== 'placement'
        ? geo.tracks
        : []) {
        g.globalAlpha = dim(t.net) * 0.65
        line(
          g,
          [
            [t.x1, t.y1],
            [t.x2, t.y2]
          ],
          color(t.layer),
          t.w
        )
      }
      g.globalAlpha = 0.55
      g.setLineDash([0.4, 0.25])
      for (const t of s.removedTracks ?? []) line(g, [t.a, t.b], '#ffbb8c', t.width)
      g.setLineDash([])
      for (const t of s.tracks.values()) {
        g.globalAlpha = dim(t.net)
        line(g, [t.a, t.b], color(t.layer), t.width)
      }
      for (const via of [
        ...(s.board?.includesBaseCopper && s.board.phase !== 'placement' ? geo.vias : []).map(
          (v) => ({ at: [v.x, v.y] as Pt, diameter: v.d, drill: v.drill, net: v.net })
        ),
        ...s.vias.values()
      ]) {
        g.globalAlpha = dim(via.net)
        g.fillStyle = '#b5c2d1'
        g.beginPath()
        g.arc(...via.at, via.diameter / 2, 0, Math.PI * 2)
        g.fill()
        g.fillStyle = '#111820'
        g.beginPath()
        g.arc(...via.at, via.drill / 2, 0, Math.PI * 2)
        g.fill()
      }
      g.globalAlpha = 1
      const target = new Map(
        (showBest ? s.placement?.best : s.placement?.current)?.map((p) => [p.ref, p]) ?? []
      )
      const ghosts = new Map((c?.placement?.current ?? s.previousPlacement).map((p) => [p.ref, p]))
      const fraction = Math.min(1, (performance.now() - at) / 100)
      for (const fp of geo.footprints) {
        const dest = target.get(fp.ref) ?? {
          ref: fp.ref,
          x: fp.x,
          y: fp.y,
          rotation: fp.rot,
          locked: fp.locked
        }
        const previous = start.current.get(fp.ref) ?? dest
        const delta = ((dest.rotation - previous.rotation + 540) % 360) - 180
        const pose = {
          ...dest,
          x: previous.x + (dest.x - previous.x) * fraction,
          y: previous.y + (dest.y - previous.y) * fraction,
          rotation: previous.rotation + delta * fraction
        }
        shown.current.set(fp.ref, pose)
        const draw = (p: LivePlacement, ghost: boolean): void => {
          g.save()
          g.translate(p.x, p.y)
          g.rotate((-(p.rotation - fp.rot) * Math.PI) / 180)
          g.translate(-fp.x, -fp.y)
          for (const item of pads.get(fp.ref) ?? []) {
            g.globalAlpha = ghost ? 0.22 : dim(item.pad.net)
            g.fillStyle = ghost
              ? '#bbc9dd'
              : pick?.ref === fp.ref || pick?.net === item.pad.net
                ? '#ffe398'
                : '#c6ad78'
            g.fill(item.path)
            if (item.pad.drill) {
              g.fillStyle = '#111820'
              g.beginPath()
              g.ellipse(
                item.pad.x,
                item.pad.y,
                item.pad.drill / 2,
                (item.pad.drill_h ?? item.pad.drill) / 2,
                (-item.pad.rot * Math.PI) / 180,
                0,
                Math.PI * 2
              )
              g.fill()
            }
          }
          g.globalAlpha = ghost ? 0.15 : 0.7
          for (const shape of geo.graphics.filter(
            (item) => item.ref === fp.ref && item.layer.endsWith('SilkS')
          ))
            line(g, shape.pts, '#9fb5c8', Math.max(shape.w, 0.08))
          g.restore()
          if (!ghost) {
            g.globalAlpha = 1
            g.fillStyle = pick?.ref === fp.ref ? '#fff1ad' : '#a2b4c7'
            g.font = `${Math.max(0.7, 10 / v.scale)}px ui-monospace,monospace`
            g.fillText(`${p.locked ? '[L] ' : ''}${fp.ref}`, p.x + 0.6, p.y - 0.6)
          }
        }
        const ghost = ghosts.get(fp.ref)
        if (
          ghost &&
          (Math.hypot(ghost.x - pose.x, ghost.y - pose.y) > 0.01 ||
            ghost.rotation !== pose.rotation)
        )
          draw(ghost, true)
        draw(pose, false)
      }
      if (c) {
        g.globalAlpha = 0.25
        for (const t of c.tracks.values()) line(g, [t.a, t.b], '#c5d3ee', t.width)
        g.globalAlpha = 1
      }
      if (s.activity?.path.length) {
        g.setLineDash([0.5, 0.3])
        line(g, s.activity.path, s.activity.action === 'rejected' ? '#ff7695' : '#7ef9db', 0.12)
        g.setLineDash([])
      }
      if (focus) {
        g.strokeStyle = '#ffba72'
        g.lineWidth = 0.13
        g.strokeRect(focus[0], focus[1], focus[2] - focus[0], focus[3] - focus[1])
        const failure = s.failures.find((f) => f.region.every((n, i) => n === focus[i]))
        if (failure)
          for (const b of failure.blockers) {
            g.strokeStyle = '#fa7b87'
            g.strokeRect(
              b.region[0],
              b.region[1],
              b.region[2] - b.region[0],
              b.region[3] - b.region[1]
            )
          }
      }
      frame = requestAnimationFrame(paint)
    }
    frame = requestAnimationFrame(paint)
    const wheel = (e: WheelEvent): void => {
      e.preventDefault()
      const box = el.getBoundingClientRect(),
        x = e.clientX - box.left,
        y = e.clientY - box.top,
        v = view.current,
        scale = Math.max(0.2, Math.min(500, v.scale * Math.exp(-e.deltaY * 0.002)))
      v.x = x - ((x - v.x) * scale) / v.scale
      v.y = y - ((y - v.y) * scale) / v.scale
      v.scale = scale
    }
    el.addEventListener('wheel', wheel, { passive: false })
    return () => {
      cancelAnimationFrame(frame)
      el.removeEventListener('wheel', wheel)
    }
  }, [geo, pads, focus])
  return (
    <div ref={host} className="live-canvas">
      <canvas
        ref={canvas}
        role="img"
        aria-label="Live solver board. Drag to pan and scroll to zoom. Use the component list for keyboard selection."
        onPointerDown={(e) => {
          const v = view.current
          drag.current = { x: e.clientX, y: e.clientY, vx: v.x, vy: v.y, moved: false }
          e.currentTarget.setPointerCapture(e.pointerId)
        }}
        onPointerMove={(e) => {
          const d = drag.current
          if (!d) return
          d.moved ||= Math.hypot(e.clientX - d.x, e.clientY - d.y) > 3
          view.current.x = d.vx + e.clientX - d.x
          view.current.y = d.vy + e.clientY - d.y
        }}
        onPointerUp={(e) => {
          const d = drag.current
          drag.current = null
          if (d?.moved) return
          const r = e.currentTarget.getBoundingClientRect(),
            v = view.current,
            x = (e.clientX - r.left - v.x) / v.scale,
            y = (e.clientY - r.top - v.y) / v.scale
          let nearest: { ref: string; distance: number } | null = null
          for (const p of shown.current.values()) {
            const distance = Math.hypot(x - p.x, y - p.y)
            if (distance < 3 && (!nearest || distance < nearest.distance))
              nearest = { ref: p.ref, distance }
          }
          onSelect(nearest ? { ref: nearest.ref } : null)
        }}
      />
    </div>
  )
}
