// Board geometry from a .kicad_pcb file, for the viewer (and later the checks). Read only; plain objects.
// Port of engine/src/pcbstudio/kicad/board.py.
//
// Coordinates are KiCad board mm (y down). A footprint item's `(at x y)` / `(start x y)` is in the footprint frame:
// rotate it by the footprint angle, then add the footprint position. A pad's angle in the file is its absolute
// orientation; a pad with no angle has orientation 0 (not the footprint angle). Custom pad primitives are in the pad
// frame (rotate by the pad orientation, add the pad position).
import fs from 'node:fs'
import type { Footprint, Geometry, Graphic, Pad, PadPrim, Pt, Track, Via, Zone, ZoneAllow } from '../../shared/generated'
import { SList, Sym, child, children, fixed6, parse, value } from './sexpr.ts'
import type { Node } from './sexpr.ts'

export type BoardData = Omit<Geometry, 'pcb' | 'bbox'>
type Transform = (p: Pt) => Pt
type Shape = [Pt[], boolean]

const SILK_COURTYARD = ['F.SilkS', 'B.SilkS', 'F.CrtYd', 'B.CrtYd']
const OUTLINE_EPS = 0.01          // mm: two Edge.Cuts ends closer than this are joined
const KEEPOUT_ITEMS = ['tracks', 'vias', 'pads', 'copperpour', 'footprints'] as const
const SHAPES = ['line', 'arc', 'rect', 'circle', 'poly']
const TAU = 2 * Math.PI

const isList = (x: Node | undefined): x is Node[] => Array.isArray(x)
const round6 = (v: number): number => Number(fixed6(v))

/** Text of an atom; a missing value reads 'None' as it does in the Python engine. */
const str = (x: Node | undefined): string => x === undefined ? 'None' : String(x)
const orBlank = (x: Node | undefined): string => (x instanceof Sym ? x.text : x) ? str(x) : ''

function num(x: Node | undefined): number {
  const v = x === undefined || isList(x) ? NaN : Number(String(x))
  if (Number.isNaN(v) || String(x).trim() === '') throw new Error(`not a number: ${String(x)}`)
  return v
}

const xy = (node: Node[] | undefined): Pt => [num(node![1]), num(node![2])]

/** KiCad rotation (positive = counter-clockwise on screen, y down). */
function rot(x: number, y: number, deg: number): Pt {
  if (!deg) return [x, y]
  const a = deg * (Math.PI / 180), c = Math.cos(a), s = Math.sin(a)
  return [x * c + y * s, -x * s + y * c]
}

function layersOf(node: Node[]): string[] {
  const ls = child(node, 'layers')
  if (ls) return ls.slice(1).map(str)
  const layer = value(node, 'layer')
  return (layer instanceof Sym || layer) ? [str(layer)] : []
}

/** Python's float %: the result takes the sign of the divisor. */
function sweep(a: number, b: number): number {
  const r = (b - a) % TAU
  return r < 0 ? r + TAU : r
}

function arcPoints(start: Pt, mid: Pt, end: Pt, segs = 16): Pt[] {
  const [x1, y1] = start, [x2, y2] = mid, [x3, y3] = end
  const d = 2 * (x1 * (y2 - y3) + x2 * (y3 - y1) + x3 * (y1 - y2))
  if (Math.abs(d) < 1e-12) return [start, end]
  const ux = ((x1 * x1 + y1 * y1) * (y2 - y3) + (x2 * x2 + y2 * y2) * (y3 - y1) + (x3 * x3 + y3 * y3) * (y1 - y2)) / d
  const uy = ((x1 * x1 + y1 * y1) * (x3 - x2) + (x2 * x2 + y2 * y2) * (x1 - x3) + (x3 * x3 + y3 * y3) * (x2 - x1)) / d
  const r = Math.hypot(x1 - ux, y1 - uy)
  const a1 = Math.atan2(start[1] - uy, start[0] - ux)
  const a2 = Math.atan2(mid[1] - uy, mid[0] - ux)
  const a3 = Math.atan2(end[1] - uy, end[0] - ux)
  let total = sweep(a1, a3)
  if (sweep(a1, a2) > total) total -= TAU          // mid not on the ccw path: go the other way
  const pts: Pt[] = []
  for (let k = 0; k <= segs; k++) {
    const a = a1 + total * k / segs
    pts.push([ux + r * Math.cos(a), uy + r * Math.sin(a)])
  }
  pts[0] = start                                    // exact ends, so chains join
  pts[pts.length - 1] = end
  return pts
}

function circle(cx: number, cy: number, r: number, n = 48): Pt[] {
  const pts: Pt[] = []
  for (let k = 0; k <= n; k++) pts.push([cx + r * Math.cos(TAU * k / n), cy + r * Math.sin(TAU * k / n)])
  return pts
}

/** A gr_* / fp_* graphic as (points, closed) in board coordinates; tf maps a local point to the board. */
function shape(g: Node[], tf: Transform): Shape | null {
  const kind = str(g[0]).slice(3)
  if (kind === 'line') return [[tf(xy(child(g, 'start'))), tf(xy(child(g, 'end')))], false]
  if (kind === 'arc') return [arcPoints(xy(child(g, 'start')), xy(child(g, 'mid')), xy(child(g, 'end'))).map(tf), false]
  if (kind === 'rect') {
    const [x0, y0] = xy(child(g, 'start')), [x1, y1] = xy(child(g, 'end'))
    const pts = ([[x0, y0], [x1, y0], [x1, y1], [x0, y1]] as Pt[]).map(tf)
    return [[...pts, pts[0]], true]
  }
  if (kind === 'circle') {
    const [cx, cy] = xy(child(g, 'center')), [ex, ey] = xy(child(g, 'end'))
    return [circle(cx, cy, Math.hypot(ex - cx, ey - cy)).map(tf), true]
  }
  if (kind === 'poly') {
    const pts = children(child(g, 'pts') ?? [], 'xy').map(p => tf(xy(p)))
    return pts.length ? [[...pts, pts[0]], true] : null
  }
  return null                                       // text, curves, dimensions: not drawn
}

function strokeWidth(g: Node[]): number {
  const st = child(g, 'stroke')
  const w = st ? value(st, 'width') : value(g, 'width')
  return w === undefined ? 0 : num(w)
}

const filled = (g: Node[]): boolean => ['yes', 'solid'].includes(str(value(g, 'fill', 'no')))

function graphicItems(node: Node[]): Node[][] {
  return node.filter((g): g is Node[] => {
    if (!isList(g) || !g.length || isList(g[0])) return false
    const name = str(g[0])
    return ['gr_', 'fp_'].includes(name.slice(0, 3)) && SHAPES.includes(name.slice(3))
  })
}

const near = (a: Pt, b: Pt): boolean => Math.abs(a[0] - b[0]) <= OUTLINE_EPS && Math.abs(a[1] - b[1]) <= OUTLINE_EPS

/** Chain open polylines whose ends meet into longer chains; a chain whose ends meet is closed (last = first). */
function join(pieces: Pt[][]): Pt[][] {
  const rest = pieces.filter(p => p.length >= 2).map(p => [...p])
  const out: Pt[][] = []
  while (rest.length) {
    let chain = rest.shift()!
    let grown = true
    while (grown && !near(chain[0], chain[chain.length - 1])) {
      grown = false
      for (let i = 0; i < rest.length; i++) {
        const p = rest[i], last = chain[chain.length - 1]
        if (near(last, p[0])) chain = [...chain, ...p.slice(1)]
        else if (near(last, p[p.length - 1])) chain = [...chain, ...p.slice(0, -1).reverse()]
        else if (near(chain[0], p[p.length - 1])) chain = [...p.slice(0, -1), ...chain]
        else if (near(chain[0], p[0])) chain = [...p.slice(1).reverse(), ...chain]
        else continue
        rest.splice(i, 1)
        grown = true
        break
      }
    }
    if (chain.length > 2 && near(chain[0], chain[chain.length - 1])) chain[chain.length - 1] = chain[0]
    out.push(chain)
  }
  return out
}

function isClosed(chain: Pt[]): boolean {
  const a = chain[0], b = chain[chain.length - 1]
  return chain.length > 2 && a[0] === b[0] && a[1] === b[1]
}

function fpTransform(fx: number, fy: number, fa: number): Transform {
  return p => {
    const [dx, dy] = rot(p[0], p[1], fa)
    return [fx + dx, fy + dy]
  }
}

function padOf(pad: Node[], fx: number, fy: number, fa: number): Pad {
  const at = child(pad, 'at')!
  const [px, py] = xy(at)
  const pa = at.length > 3 ? num(at[3]) : 0         // absolute orientation; none = 0
  const [dx, dy] = rot(px, py, fa)
  const x = fx + dx, y = fy + dy
  const size = child(pad, 'size')
  const w = size ? num(size[1]) : 0
  const h = size && size.length > 2 ? num(size[2]) : w
  const drill = child(pad, 'drill')
  let dW: number | null = null, dH: number | null = null, dShape: Pad['drill_shape'] = null
  if (drill) {
    const atoms = drill.slice(1).filter(v => !isList(v))
    const nums = atoms.filter(v => str(v) !== 'oval').map(num)
    dShape = atoms.some(v => str(v) === 'oval') ? 'oval' : 'circle'
    if (nums.length) {
      dW = nums[0]
      dH = nums.length > 1 && dShape === 'oval' ? nums[1] : dW
    }
  }
  const rratio = value(pad, 'roundrect_rratio')
  const out: Pad = {
    num: str(pad[1]), type: str(pad[2]), shape: str(pad[3]),
    x: round6(x), y: round6(y), rot: pa, w, h,
    layers: layersOf(pad), net: orBlank(value(pad, 'net')),
    drill: dW, drill_h: dH, drill_shape: dShape,
    rratio: rratio === undefined ? 0 : num(rratio)
  }
  if (out.shape === 'custom') {
    const opts = child(pad, 'options')
    out.anchor = opts ? str(value(opts, 'anchor', 'rect')) : 'rect'
    const tf: Transform = p => {
      const [ex, ey] = rot(p[0], p[1], pa)
      return [x + ex, y + ey]
    }
    const prims: PadPrim[] = []
    for (const g of graphicItems(child(pad, 'primitives') ?? [])) {
      const got = shape(g, tf)
      if (got) {
        const [pts, closed] = got
        prims.push({ pts: pts.map(([a, b]): Pt => [round6(a), round6(b)]), w: strokeWidth(g),
                     fill: closed && (filled(g) || str(g[0]) === 'gr_poly'), closed })
      }
    }
    out.prims = prims
  }
  return out
}

const equalsText = (x: Node | undefined, text: string): boolean => !isList(x) && x !== undefined && String(x) === text

function footprintsOf(root: Node[], graphics: Graphic[], edges: Shape[]): Footprint[] {
  const fps: Footprint[] = []
  for (const fp of children(root, 'footprint')) {
    const at = child(fp, 'at')!
    const [fx, fy] = xy(at)
    const fa = at.length > 3 ? num(at[3]) : 0
    let ref = ''
    const props: Record<string, string> = {}
    for (const prop of children(fp, 'property')) {
      if (prop.length > 2 && !isList(prop[1])) props[str(prop[1])] = str(prop[2])
      if (prop.length > 2 && equalsText(prop[1], 'Reference')) ref = str(prop[2])
    }
    const attr = child(fp, 'attr')
    const attrs = attr ? attr.slice(1).map(str) : []
    if (!ref) {                                     // older files: (fp_text reference "R1")
      for (const t of children(fp, 'fp_text')) {
        if (t.length > 2 && equalsText(t[1], 'reference')) ref = str(t[2])
      }
    }
    const tf = fpTransform(fx, fy, fa)
    for (const g of graphicItems(fp)) {
      const layer = str(value(g, 'layer', ''))
      if (SILK_COURTYARD.includes(layer)) {
        const got = shape(g, tf)
        if (got) graphics.push({ layer, ref, pts: got[0], closed: got[1], w: strokeWidth(g), fill: got[1] && filled(g) })
      } else if (layer === 'Edge.Cuts') {
        const got = shape(g, tf)
        if (got) edges.push(got)
      }
    }
    fps.push({
      ref, lib: fp.length > 1 ? str(fp[1]) : '', x: fx, y: fy, rot: fa, layer: str(value(fp, 'layer', '')),
      locked: fp.slice(1, 3).some(c => equalsText(c, 'locked')) || equalsText(value(fp, 'locked'), 'yes'),
      props, attrs, pads: children(fp, 'pad').map(pad => padOf(pad, fx, fy, fa))
    })
  }
  return fps
}

function zoneOf(z: Node[]): Zone {
  const ko = child(z, 'keepout')
  let allow: ZoneAllow | null = null
  if (ko) {                                         // KiCad: a (keepout ...) block makes the zone a rule area
    allow = Object.fromEntries(KEEPOUT_ITEMS.map(k => [k, str(value(ko, k, 'allowed')) !== 'not_allowed'])) as unknown as ZoneAllow
  }
  const polygons = children(z, 'polygon').map(poly => children(child(poly, 'pts') ?? [], 'xy').map(xy))
  return {
    net: orBlank(value(z, 'net_name')) || orBlank(value(z, 'net')), name: orBlank(value(z, 'name')),
    layers: layersOf(z), rule_area: ko !== undefined,
    keepout: allow !== null && !Object.values(allow).every(Boolean), allow,
    outline: polygons[0] ?? [], polygons,
    filled: children(z, 'filled_polygon').map(fp => ({
      layer: str(value(fp, 'layer')), pts: children(child(fp, 'pts') ?? [], 'xy').map(xy)
    }))
  }
}

export function load(path: string): BoardData {
  return fromTree(parse(new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(fs.readFileSync(path))))
}

export function fromTree(root: SList): BoardData {
  const tracks: Track[] = [], vias: Via[] = []
  for (const seg of children(root, 'segment')) {
    const [x1, y1] = xy(child(seg, 'start')), [x2, y2] = xy(child(seg, 'end'))
    tracks.push({ x1, y1, x2, y2, w: num(value(seg, 'width')), layer: str(value(seg, 'layer')), net: orBlank(value(seg, 'net')) })
  }
  for (const arc of children(root, 'arc')) {
    const pts = arcPoints(xy(child(arc, 'start')), xy(child(arc, 'mid')), xy(child(arc, 'end')), 8)
    for (let i = 0; i + 1 < pts.length; i++) {
      const [x1, y1] = pts[i], [x2, y2] = pts[i + 1]
      tracks.push({ x1, y1, x2, y2, w: num(value(arc, 'width')), layer: str(value(arc, 'layer')), net: orBlank(value(arc, 'net')) })
    }
  }
  for (const v of children(root, 'via')) {
    const [x, y] = xy(child(v, 'at'))
    vias.push({ x, y, d: num(value(v, 'size')), drill: num(value(v, 'drill')), layers: layersOf(v), net: orBlank(value(v, 'net')) })
  }
  const zones = children(root, 'zone').map(zoneOf)
  const graphics: Graphic[] = [], edges: Shape[] = []
  const ident = fpTransform(0, 0, 0)
  for (const g of graphicItems(root)) {
    const layer = str(value(g, 'layer', ''))
    if (layer !== 'Edge.Cuts' && !SILK_COURTYARD.includes(layer)) continue
    const got = shape(g, ident)
    if (!got) continue
    if (layer === 'Edge.Cuts') edges.push(got)
    else graphics.push({ layer, ref: '', pts: got[0], closed: got[1], w: strokeWidth(g), fill: got[1] && filled(g) })
  }
  const footprints = footprintsOf(root, graphics, edges)
  const outline = [...edges.filter(e => e[1]).map(e => e[0]), ...join(edges.filter(e => !e[1]).map(e => e[0]))]
  const layers = (child(root, 'layers') ?? []).slice(1).flatMap(l => isList(l) && l.length > 1 ? [str(l[1])] : [])
  return { layers, outline, outline_open: outline.filter(c => !isClosed(c)).length, footprints, tracks, vias, zones, graphics }
}

/** Board extent: the outline, else every pad, track, via and zone; [0, 0, 0, 0] for an empty board. */
export function bbox(geo: BoardData): [number, number, number, number] {
  let pts: Pt[] = geo.outline.flat()
  if (!pts.length) {
    pts = [
      ...geo.footprints.flatMap(f => f.pads.map((p): Pt => [p.x, p.y])),
      ...geo.tracks.flatMap((t): Pt[] => [[t.x1, t.y1], [t.x2, t.y2]]),
      ...geo.vias.map((v): Pt => [v.x, v.y]),
      ...geo.zones.flatMap(z => z.polygons.flat())
    ]
  }
  if (!pts.length) return [0, 0, 0, 0]
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity
  for (const [x, y] of pts) {
    if (x < x0) x0 = x
    if (y < y0) y0 = y
    if (x > x1) x1 = x
    if (y > y1) y1 = y
  }
  return [x0, y0, x1, y1]
}
