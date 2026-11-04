// GENERATED from engine/src/pcbstudio/model by `npm run types:gen` (python -m pcbstudio.model.tsgen).
// Do not edit. `npm run types:check` fails when this file is stale.

export type Pt = [number, number]

/** A custom-pad primitive in board coordinates. */
export interface PadPrim {
  pts: Pt[]
  w: number
  fill: boolean
  closed: boolean
}

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
  /** Second drill dimension (= drill for a round hole). */
  drill_h: number | null
  drill_shape: 'circle' | 'oval' | null
  rratio: number
  /** Custom pads only: anchor shape. */
  anchor?: string | null
  /** Custom pads only: primitives (board coordinates). */
  prims?: PadPrim[] | null
}

export interface Footprint {
  ref: string
  lib: string
  x: number
  y: number
  rot: number
  layer: string
  locked: boolean
  props: Record<string, string>
  attrs: string[]
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
  layers: string[]
  net: string
}

export interface ZoneFill {
  layer: string
  pts: Pt[]
}

/** Rule area: what may go inside. */
export interface ZoneAllow {
  tracks: boolean
  vias: boolean
  pads: boolean
  copperpour: boolean
  footprints: boolean
}

export interface Zone {
  net: string
  name: string
  layers: string[]
  rule_area: boolean
  /** Rule area that forbids at least one item. */
  keepout: boolean
  /** Rule areas only: what may go inside. */
  allow: ZoneAllow | null
  /** First outline polygon (= polygons[0]). */
  outline: Pt[]
  polygons: Pt[][]
  filled: ZoneFill[]
}

/** A silk or courtyard line/shape in board coordinates (ref '' = board graphic). */
export interface Graphic {
  layer: string
  ref: string
  pts: Pt[]
  closed: boolean
  w: number
  fill: boolean
}

export interface Geometry {
  pcb: string
  layers: string[]
  /** Edge.Cuts chains; a closed loop has last point = first. */
  outline: Pt[][]
  /** Chains that do not close (0 on a good board). */
  outline_open: number
  footprints: Footprint[]
  tracks: Track[]
  vias: Via[]
  zones: Zone[]
  /** F/B silk and courtyard. */
  graphics: Graphic[]
  bbox: [number, number, number, number]
}

export interface GlbResult {
  path: string
  cached: boolean
  size: number
  warnings: string[]
}

/**
 * One gate config that checks a revision: `<boards_dir>/<name>/<config>`; run with `tools/pcb check NAME`
 * (config gate.json) or `node tools/gate.mjs NAME --config CONFIG` (a variant).
 */
export interface GateRef {
  name: string
  config: string
  variant: string | null
}

/** A board revision. Every path is project-relative and exists, or is None. */
export interface Revision {
  revision: string | null
  state: string | null
  pcb: string | null
  sch: string | null
  spec: string | null
  bom: string | null
  gate: string | null
  gates: GateRef[]
  pipeline: string | null
}

export interface Board {
  id: string
  directory: string
  lifecycle: string
  kind: string | null
  variant_of: string | null
  identity: 'board.yaml' | 'legacy'
  revisions: Revision[]
}

/** A disagreement between identity sources (registry, gate.json, folders, board.yaml) and how it was resolved. */
export interface IdentityConflict {
  board: string | null
  kind: string
  message: string
}

export interface ProjectInfo {
  root: string
  boards: Board[]
  conflicts: IdentityConflict[]
}

/** Where a hardware project keeps its files, project-relative. The default is the iot-lab layout. */
export interface ProjectLayout {
  boards_dir: string
  registry: string
  datasheets_dir: string
  cad_assets_dir: string
  components: string
  board_file: string
  gate_file: string
  gate_variant_glob: string
  gate_reserved: string[]
  pipeline: string
  pipeline_aliases: string
}

/** A datasheet PDF in the project (project-relative, exists) with its measured sha256. */
export interface DatasheetRef {
  path: string
  sha256: string
  recorded_sha256: string | null
  sources: ('filename' | 'source_json' | 'cad_manifest' | 'components_json' | 'bom_csv')[]
}

export interface PartRecord {
  c_number: string
  mpn: string | null
  manufacturer: string | null
  datasheet: DatasheetRef | null
  datasheets: DatasheetRef[]
  cad_asset: string | null
  evidence: string[]
}

export interface PartsIndexStats {
  path: string
  fingerprint: string
  rebuilt: boolean
  pdfs: number
  pdfs_c_in_name: number
  pdfs_mapped: number
  c_numbers: number
  by_source: Record<string, number>
  missing_paths: number
  hash_mismatches: number
}

/** The evidence CSV joined to a BOM (the revision's `bom`), after column normalisation. */
export interface BomSource {
  path: string
  rows: number
  columns: string[]
  unknown_columns: string[]
  header_only: boolean
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
  assembly: 'smd' | 'tht' | 'other'
  datasheet: string | null
  datasheet_sha256: string | null
  datasheet_url: string | null
  cad_asset: boolean
  stock_status: string | null
  assembly_status: string | null
  csv_lcsc: string | null
  lcsc_mismatch_refs: string[]
  csv_missing_refs: string[]
}

export interface BomSummary {
  refs: number
  lines: number
  dnp_refs: number
  missing_lcsc: number
  missing_datasheet: number
  missing_cad_asset: number
  lcsc_mismatches: number
  lines_with_mismatch: number
  csv_missing_refs: number
  csv_only_refs: number
}

export interface Bom {
  pcb: string
  revision: string | null
  source: BomSource | null
  csv_only_refs: string[]
  lines: BomLine[]
  summary: BomSummary
}

export interface PartPlacement {
  ref: string
  value: string | null
  lcsc: string | null
  mpn: string | null
  x: number
  y: number
  rot: number
  layer: string
  pads: number
  dnp: boolean
}

export interface BoardParts {
  pcb: string
  bbox: [number, number, number, number]
  tracks: number
  vias: number
  footprints: PartPlacement[]
}

/** A candidate board of a build/route run. */
export interface Candidate {
  pcb: string
  target: string | null
  exists: boolean
  sha256: string | null
  verified: boolean
  identity_preserved: boolean | null
  metrics: Record<string, number> | null
}

export interface RunSummary {
  id: string
  op: 'check' | 'build' | 'route'
  board: string
  mode: string
  state: 'running' | 'passed' | 'failed' | 'error' | 'cancelled' | 'interrupted'
  started: number
  exit_code: number | null
  run_id: string | null
  cause: string | null
  metrics: Record<string, number> | null
  findings: number
  events: number
  elapsed_s: number | null
  candidate: Candidate | null
  policy: Record<string, unknown> | null
  adoption: Record<string, unknown> | null
  adoptable: boolean
}

export interface FindingItem {
  description: string
  x: number
  y: number
}

export interface Finding {
  kind: 'violation' | 'unconnected'
  type: string
  severity: string
  description: string
  x: number
  y: number
  items: FindingItem[]
}

export interface Findings {
  id: string
  items: Finding[]
  source: string | null
}
