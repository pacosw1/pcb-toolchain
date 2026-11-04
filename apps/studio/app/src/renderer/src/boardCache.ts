// Cached Path2D geometry and hit tests for the 2D board viewer. Paths are in board mm; the caller sets the
// view transform. Build once per geometry (buildCache) so pan and zoom only replay the paths.
import type { Footprint, Geometry, Pad, Track } from './types'

/** What the viewer has picked: a pad, a track (net highlight) or a whole part (search). */
export type Pick =
  | { kind: 'pad'; fp: Footprint; pad: Pad }
  | { kind: 'track'; track: Track }
  | { kind: 'part'; fp: Footprint }

/** The same pick in a newer geometry of the board, or null when the item is gone. A part is found by reference, a pad
 *  by reference and number (the nearest one when several share the number), a track by its exact ends and layer. */
export function rebasePick(p: Pick, geo: Geometry): Pick | null {
  if (p.kind === 'track') {
    const t = p.track
    const track = geo.tracks.find(
      (n) => n.layer === t.layer && n.x1 === t.x1 && n.y1 === t.y1 && n.x2 === t.x2 && n.y2 === t.y2
    )
    return track ? { kind: 'track', track } : null
  }
  const fp = geo.footprints.find((f) => f.ref === p.fp.ref)
  if (!fp) return null
  if (p.kind === 'part') return { kind: 'part', fp }
  const old = p.pad
  const dist = (n: Pad): number => Math.hypot(n.x - old.x, n.y - old.y)
  const pad = fp.pads
    .filter((n) => n.num === old.num)
    .reduce<Pad | null>((best, n) => (!best || dist(n) < dist(best) ? n : best), null)
  return pad ? { kind: 'pad', fp, pad } : null
}

export function padOnLayer(p: Pad, layer: string): boolean {
  return (
    p.layers.includes(layer) ||
    p.layers.includes('*.Cu') ||
    (layer.endsWith('.Cu') && p.type === 'thru_hole')
  )
}

/** One pad outline in board coordinates (rotation applied). */
export function padPath(p: Pad, into?: Path2D): Path2D {
  const local = new Path2D()
  if (p.shape === 'custom') {
    // anchor in the pad frame; primitives are already in board coordinates
    if (p.anchor === 'circle') local.arc(0, 0, p.w / 2, 0, 2 * Math.PI)
    else local.rect(-p.w / 2, -p.h / 2, p.w, p.h)
    const out = into ?? new Path2D()
    out.addPath(local, new DOMMatrix().translate(p.x, p.y).rotate(-p.rot))
    for (const prim of p.prims ?? []) if (prim.closed && prim.pts.length > 2) polygon(out, prim.pts)
    return out
  }
  if (p.shape === 'circle') {
    local.arc(0, 0, p.w / 2, 0, 2 * Math.PI)
  } else {
    const r =
      p.shape === 'oval'
        ? Math.min(p.w, p.h) / 2
        : p.shape === 'roundrect'
          ? Math.min(p.w, p.h) * (p.rratio || 0.25)
          : 0
    local.roundRect(-p.w / 2, -p.h / 2, p.w, p.h, r)
  }
  const out = into ?? new Path2D()
  out.addPath(local, new DOMMatrix().translate(p.x, p.y).rotate(-p.rot))
  return out
}

/** Tracks of one layer grouped by width (one stroke per width). */
export type TrackGroups = Map<number, Path2D>

function addTracks(groups: TrackGroups, t: Track): void {
  let p = groups.get(t.w)
  if (!p) groups.set(t.w, (p = new Path2D()))
  p.moveTo(t.x1, t.y1)
  p.lineTo(t.x2, t.y2)
}

export interface PadGroup {
  onF: boolean
  onB: boolean
  hasNet: boolean
  path: Path2D
}

export interface BoardCache {
  tracks: Map<string, TrackGroups> // layer -> width -> path
  zones: Map<string, Path2D> // layer -> filled polygons
  pads: PadGroup[]
  drills: Path2D
  vias: Path2D
  viaHoles: Path2D
  netPads: Map<string, number>
  graphics: Map<string, GraphicLayer> // F/B.SilkS, F/B.CrtYd
}

/** Silk or courtyard of one layer: strokes grouped by width, plus filled shapes. */
export interface GraphicLayer {
  strokes: TrackGroups
  fill: Path2D
}

export function buildCache(geo: Geometry): BoardCache {
  const tracks = new Map<string, TrackGroups>()
  for (const t of geo.tracks) {
    let g = tracks.get(t.layer)
    if (!g) tracks.set(t.layer, (g = new Map()))
    addTracks(g, t)
  }
  const zones = new Map<string, Path2D>()
  for (const z of geo.zones) {
    if (z.rule_area) continue
    for (const f of z.filled) {
      if (f.pts.length < 3) continue
      let p = zones.get(f.layer)
      if (!p) zones.set(f.layer, (p = new Path2D()))
      polygon(p, f.pts)
    }
  }
  const padGroups = new Map<string, PadGroup>()
  const drills = new Path2D()
  const netPads = new Map<string, number>()
  for (const fp of geo.footprints) {
    for (const p of fp.pads) {
      const onF = padOnLayer(p, 'F.Cu')
      const onB = padOnLayer(p, 'B.Cu')
      if (p.net) netPads.set(p.net, (netPads.get(p.net) ?? 0) + 1)
      if (!onF && !onB) continue
      const key = `${onF}${onB}${!!p.net}`
      let g = padGroups.get(key)
      if (!g) padGroups.set(key, (g = { onF, onB, hasNet: !!p.net, path: new Path2D() }))
      padPath(p, g.path)
      if (p.drill) drillPath(p, drills)
    }
  }
  const vias = new Path2D()
  const viaHoles = new Path2D()
  for (const v of geo.vias) {
    vias.moveTo(v.x + v.d / 2, v.y)
    vias.arc(v.x, v.y, v.d / 2, 0, 2 * Math.PI)
    viaHoles.moveTo(v.x + v.drill / 2, v.y)
    viaHoles.arc(v.x, v.y, v.drill / 2, 0, 2 * Math.PI)
  }
  const graphics = new Map<string, GraphicLayer>()
  for (const gr of geo.graphics ?? []) {
    if (gr.pts.length < 2) continue
    let gl = graphics.get(gr.layer)
    if (!gl) graphics.set(gr.layer, (gl = { strokes: new Map(), fill: new Path2D() }))
    if (gr.fill && gr.closed && gr.pts.length > 2) polygon(gl.fill, gr.pts)
    const w = gr.w || 0.05
    let s = gl.strokes.get(w)
    if (!s) gl.strokes.set(w, (s = new Path2D()))
    s.moveTo(gr.pts[0][0], gr.pts[0][1])
    for (let i = 1; i < gr.pts.length; i++) s.lineTo(gr.pts[i][0], gr.pts[i][1])
  }
  return { tracks, zones, pads: [...padGroups.values()], drills, vias, viaHoles, netPads, graphics }
}

/** A pad's hole: a circle, or a slot (drill x drill_h) turned with the pad. */
function drillPath(p: Pad, into: Path2D): void {
  const w = p.drill ?? 0
  const h = p.drill_h ?? w
  if (p.drill_shape !== 'oval' || Math.abs(w - h) < 1e-6) {
    into.moveTo(p.x + w / 2, p.y)
    into.arc(p.x, p.y, w / 2, 0, 2 * Math.PI)
    return
  }
  const local = new Path2D()
  local.roundRect(-w / 2, -h / 2, w, h, Math.min(w, h) / 2)
  into.addPath(local, new DOMMatrix().translate(p.x, p.y).rotate(-p.rot))
}

function polygon(p: Path2D, pts: [number, number][]): void {
  p.moveTo(pts[0][0], pts[0][1])
  for (let i = 1; i < pts.length; i++) p.lineTo(pts[i][0], pts[i][1])
  p.closePath()
}

/** The copper of one net (for the highlight pass). */
export interface NetCache {
  net: string
  tracks: Map<string, TrackGroups>
  zones: Map<string, Path2D>
  pads: Path2D
  vias: Path2D
}

export function buildNetCache(geo: Geometry, net: string): NetCache {
  const tracks = new Map<string, TrackGroups>()
  for (const t of geo.tracks) {
    if (t.net !== net) continue
    let g = tracks.get(t.layer)
    if (!g) tracks.set(t.layer, (g = new Map()))
    addTracks(g, t)
  }
  const zones = new Map<string, Path2D>()
  for (const z of geo.zones) {
    if (z.rule_area || z.net !== net) continue
    for (const f of z.filled) {
      if (f.pts.length < 3) continue
      let p = zones.get(f.layer)
      if (!p) zones.set(f.layer, (p = new Path2D()))
      polygon(p, f.pts)
    }
  }
  const pads = new Path2D()
  for (const fp of geo.footprints) for (const p of fp.pads) if (p.net === net) padPath(p, pads)
  const vias = new Path2D()
  for (const v of geo.vias) {
    if (v.net !== net) continue
    vias.moveTo(v.x + v.d / 2, v.y)
    vias.arc(v.x, v.y, v.d / 2, 0, 2 * Math.PI)
  }
  return { net, tracks, zones, pads, vias }
}

/** Is board point (bx, by) inside pad p (with a margin in mm)? Returns the distance to its centre or -1. */
export function padHit(p: Pad, bx: number, by: number, margin = 0): number {
  const dx = bx - p.x
  const dy = by - p.y
  const r = (p.rot * Math.PI) / 180
  const lx = dx * Math.cos(r) - dy * Math.sin(r)
  const ly = dx * Math.sin(r) + dy * Math.cos(r)
  const d = Math.hypot(dx, dy)
  if (p.shape === 'circle') return d <= p.w / 2 + margin ? d : -1
  return Math.abs(lx) <= p.w / 2 + margin && Math.abs(ly) <= p.h / 2 + margin ? d : -1
}

export function hitPad(
  geo: Geometry,
  bx: number,
  by: number,
  visible: Record<string, boolean>,
  margin = 0
): { fp: Footprint; pad: Pad } | null {
  let best: { d: number; fp: Footprint; pad: Pad } | null = null
  for (const fp of geo.footprints) {
    for (const p of fp.pads) {
      if (!(
        (padOnLayer(p, 'F.Cu') && visible['F.Cu']) ||
        (padOnLayer(p, 'B.Cu') && visible['B.Cu'])
      ))
        continue
      const d = padHit(p, bx, by, margin)
      if (d >= 0 && (!best || d < best.d)) best = { d, fp, pad: p }
    }
  }
  return best ? { fp: best.fp, pad: best.pad } : null
}

export function segDist(
  px: number,
  py: number,
  x1: number,
  y1: number,
  x2: number,
  y2: number
): number {
  const vx = x2 - x1
  const vy = y2 - y1
  const l2 = vx * vx + vy * vy
  const t = l2 ? Math.max(0, Math.min(1, ((px - x1) * vx + (py - y1) * vy) / l2)) : 0
  return Math.hypot(px - (x1 + t * vx), py - (y1 + t * vy))
}

/** Topmost visible track under the point: distance to its centre line <= width/2 (+ margin). */
export function hitTrack(
  geo: Geometry,
  bx: number,
  by: number,
  visible: Record<string, boolean>,
  order: string[],
  margin = 0
): Track | null {
  // order is the draw order (last drawn = on top), so search it backwards
  for (let li = order.length - 1; li >= 0; li--) {
    const layer = order[li]
    if (!visible[layer]) continue
    let best: { d: number; t: Track } | null = null
    for (const t of geo.tracks) {
      if (t.layer !== layer) continue
      const d = segDist(bx, by, t.x1, t.y1, t.x2, t.y2)
      if (d <= t.w / 2 + margin && (!best || d < best.d)) best = { d, t }
    }
    if (best) return best.t
  }
  return null
}

export function footprintBox(fp: Footprint): [number, number, number, number] {
  if (!fp.pads.length) return [fp.x - 1, fp.y - 1, fp.x + 1, fp.y + 1]
  let x0 = Infinity
  let y0 = Infinity
  let x1 = -Infinity
  let y1 = -Infinity
  for (const p of fp.pads) {
    const r = Math.max(p.w, p.h) / 2
    x0 = Math.min(x0, p.x - r)
    y0 = Math.min(y0, p.y - r)
    x1 = Math.max(x1, p.x + r)
    y1 = Math.max(y1, p.y + r)
  }
  return [x0, y0, x1, y1]
}
