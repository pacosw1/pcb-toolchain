import type { Geometry, Pt } from './types'

export type UnitPose = { refs: string[]; origin: Pt; position: Pt; turn: number }
export type Placement = { board_sha256: string; epoch: number; epochs: number; cost: number; units: UnitPose[] }

/** Interpolate observations without changing the saved board or claiming the placement is legal. */
export function interpolatePlacement(previous: Placement | null, next: Placement, t: number): Placement {
  const old = new Map((previous?.board_sha256 === next.board_sha256 ? previous.units : []).map(u => [u.refs.join('\0'), u]))
  return { ...next, units: next.units.map(u => {
    const before = old.get(u.refs.join('\0'))
    const start = before?.position ?? u.origin
    const turn = before?.turn ?? 0
    const delta = ((u.turn - turn + 6) % 4) - 2
    return { ...u, position: [start[0] + (u.position[0] - start[0]) * t, start[1] + (u.position[1] - start[1]) * t], turn: turn + delta * t }
  }) }
}

/** KiCad angles turn counterclockwise in a y-down frame. Original copper is hidden because it may no longer connect. */
export function placementGeometry(base: Geometry, frame: Placement): Geometry {
  const refs = new Map(frame.units.flatMap(u => u.refs.map(ref => [ref, u] as const)))
  const point = (p: Pt, u: UnitPose): Pt => {
    const angle = u.turn * Math.PI / 2, c = Math.cos(angle), s = Math.sin(angle)
    const dx = p[0] - u.origin[0], dy = p[1] - u.origin[1]
    return [u.position[0] + dx * c + dy * s, u.position[1] - dx * s + dy * c]
  }
  return { ...base, tracks: [], vias: [], zones: [], footprints: base.footprints.map(fp => {
    const u = refs.get(fp.ref)
    if (!u) return fp
    const [x, y] = point([fp.x, fp.y], u)
    return { ...fp, x, y, rot: fp.rot + u.turn * 90, pads: fp.pads.map(pad => {
      const [px, py] = point([pad.x, pad.y], u)
      return { ...pad, x: px, y: py, rot: pad.rot + u.turn * 90,
        prims: pad.prims?.map(prim => ({ ...prim, pts: prim.pts.map(p => point(p, u)) })) }
    }) }
  }), graphics: base.graphics.map(g => {
    const u = refs.get(g.ref)
    return u ? { ...g, pts: g.pts.map(p => point(p, u)) } : g
  }) }
}
