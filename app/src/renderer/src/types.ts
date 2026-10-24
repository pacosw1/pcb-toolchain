// Shapes returned by the engine (engine/src/pcbstudio/kicad/board.py, project.py).
export type Pt = [number, number]

export interface Pad {
  num: string
  type: string
  shape: string
  x: number
  y: number
  rot: number
  w: number
  h: number
  layers: string[]
  net: string
  drill: number | null
  rratio: number
}

export interface Footprint {
  ref: string
  lib: string
  x: number
  y: number
  rot: number
  layer: string
  pads: Pad[]
}

export interface Track {
  x1: number
  y1: number
  x2: number
  y2: number
  w: number
  layer: string
  net: string
}

export interface Via {
  x: number
  y: number
  d: number
  drill: number
  net: string
}

export interface Zone {
  net: string
  name: string
  layers: string[]
  rule_area: boolean
  outline: Pt[]
  filled: { layer: string; pts: Pt[] }[]
}

export interface Geometry {
  pcb: string
  layers: string[]
  outline: Pt[][]
  footprints: Footprint[]
  tracks: Track[]
  vias: Via[]
  zones: Zone[]
  bbox: [number, number, number, number]
}

export interface Revision {
  revision: string | null
  state: string | null
  pcb: string | null
  spec: string | null
}

export interface Board {
  id: string
  directory: string
  lifecycle: string
  revisions: Revision[]
}

export interface BomLine {
  refs: string[]
  qty: number
  value: string
  lcsc: string | null
  mpn: string | null
  manufacturer: string | null
  footprint: string
  description: string | null
  dnp: boolean
  assembly: string
  datasheet: string | null
  datasheet_url: string | null
  cad_asset: boolean
  stock_status: string | null
  assembly_status: string | null
}

export interface Bom {
  pcb: string
  lines: BomLine[]
  summary: {
    refs: number
    lines: number
    dnp_refs: number
    missing_lcsc: number
    missing_datasheet: number
    missing_cad_asset: number
  }
}

export interface ProjectInfo {
  root: string
  boards: Board[]
}
