// The board JSON of `iotroute board-json`, schema iot-lab.board.v1. Types follow tools/router/core/src/kicad (board.rs, pad.rs,
// shape.rs, geom). Lengths are whole nanometres, y down.
export interface Pt { x: number; y: number }
export interface Rect { left: number; top: number; right: number; bottom: number }
export interface Polygon { outline: Pt[]; holes: Pt[][] }

export type Geometry =
  | { Segment: { start: Pt; end: Pt } }
  | { Rect: { top_left: Pt; bottom_right: Pt } }
  | { Circle: { center: Pt; radius_point: Pt } }
  | { Arc: { start: Pt; end: Pt; center: Pt } }
  | { Poly: { rings: Pt[][] } }
  | 'Other';

export interface Graphic { geometry: Geometry; layer: string; width: number; filled: boolean }

export type PadCopper =
  | { Circle: { center: Pt; radius: number } }
  | { Segment: { a: Pt; b: Pt; width: number } }
  | { Polygon: Pt[] };

export type ZoneConnection = 'None' | 'Thermal' | 'Full' | 'ThtThermal';

export interface Pad {
  id: string; number: string;
  kind: 'ThroughHole' | 'Smd' | 'EdgeConnector' | 'NpThroughHole';
  shape: 'Circle' | 'Rect' | 'Oval' | 'RoundRect' | 'Custom' | 'Other';
  net: string; position: Pt; orientation: number; size: Pt; drill: Pt; layers: string[]; bbox: Rect;
  zone_connection: ZoneConnection | null; thermal_spoke_angle: number; spoke_templates: number;
  copper: PadCopper[]; polygons: Record<string, Polygon>; solder_mask_expansion: number;
}

export interface FilledLayer { layer: string; polygons: Polygon[] }
export interface RuleArea { tracks: boolean; vias: boolean; pour: boolean }
export interface ZoneFill {
  clearance: number; min_thickness: number; thermal_gap: number; spoke_width: number;
  pad_connection: ZoneConnection | null; island_removal_mode: number; min_island_area: number;
}
export interface Zone {
  id: string; name: string; net: string; layers: string[]; outline: Polygon[]; filled: FilledLayer[];
  rule_area: RuleArea | null; fill: ZoneFill | null;
}

export interface Footprint {
  id: string; reference: string; value: string; lib_id: string; layer: string; position: Pt; orientation: number; locked: boolean;
  fields: [string, string][]; pads: Pad[]; graphics: Graphic[]; zones: Zone[];
  courtyard_front: Polygon[]; courtyard_back: Polygon[];
}

export interface Track { id: string; start: Pt; end: Pt; mid: Pt | null; width: number; layer: string; net: string; locked: boolean }
export interface Via { id: string; at: Pt; size: number; drill: number; net: string; locked: boolean }
export type RoutedCopper = { Track: Track } | { Via: Via };

export interface StackupLayer { layer: string; kind: 'Copper' | 'Core' | 'Prepreg' | 'Other'; thickness: number }

export interface Board {
  path: string; copper_layers: string[]; stackup: StackupLayer[];
  /** Net name to net class. */
  nets: Record<string, string>;
  footprints: Footprint[]; copper: RoutedCopper[]; zones: Zone[]; graphics: Graphic[]; edges_bbox: Rect; outlines: Polygon[];
}

export interface BoardDocument {
  schema: string; kicad_commit: string; kicad: string;
  board_sha256: string; project_sha256: string; rules_sha256: string;
  board: Board;
}

export const NM_PER_MM = 1_000_000;
export const toMm = (nanometres: number): number => nanometres / NM_PER_MM;
export const tracks = (board: Board): Track[] => board.copper.flatMap(item => ('Track' in item ? [item.Track] : []));
export const vias = (board: Board): Via[] => board.copper.flatMap(item => ('Via' in item ? [item.Via] : []));
