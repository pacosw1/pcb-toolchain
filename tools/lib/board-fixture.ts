// Small boards for tests of pcbtool: a board document made by hand, in millimetres, with what a KiCad project gives by default.
import type { ProjectFile } from './board-obstacles.ts';
import type { Board, Footprint, Pad, Polygon, Pt, RoutedCopper, Zone } from './board-types.ts';

const MM = 1_000_000;

export const pt = (x: number, y: number): Pt => ({ x: Math.round(x * MM), y: Math.round(y * MM) });
export const box = (x0: number, y0: number, x1: number, y1: number): Polygon => ({ outline: [pt(x0, y0), pt(x1, y0), pt(x1, y1), pt(x0, y1)], holes: [] });

/** A rectangular SMD pad on F.Cu. */
export function pad(number: string, net: string, x: number, y: number, width = 1, height = 1, fields: Partial<Pad> = {}): Pad {
  const polygon = box(x - width / 2, y - height / 2, x + width / 2, y + height / 2);
  return {
    id: `${net}-${number}-${x}-${y}`, number, kind: 'Smd', shape: 'Rect', net, position: pt(x, y), orientation: 0, size: pt(width, height), drill: pt(0, 0), layers: ['F.Cu'],
    bbox: { left: 0, top: 0, right: 0, bottom: 0 }, zone_connection: null, thermal_spoke_angle: 90, spoke_templates: 0, copper: [{ Polygon: polygon.outline }],
    polygons: { 'F.Cu': polygon }, solder_mask_expansion: 0, clearance_override: null, ...fields,
  };
}

export const part = (reference: string, ...pads: Pad[]): Footprint => ({
  id: reference, reference, value: '', lib_id: '', layer: 'F.Cu', position: pt(0, 0), orientation: 0, locked: false, clearance_override: null, fields: [], pads, graphics: [], zones: [],
  courtyard_front: [], courtyard_back: [],
});

export const track = (net: string, x1: number, y1: number, x2: number, y2: number, layer = 'F.Cu', width = 0.25): RoutedCopper =>
  ({ Track: { id: `t${x1},${y1}`, start: pt(x1, y1), end: pt(x2, y2), mid: null, width: width * MM, layer, net, locked: false } });

export const via = (net: string, x: number, y: number, size = 0.6, drill = 0.3): RoutedCopper =>
  ({ Via: { id: `v${x},${y}`, at: pt(x, y), size: size * MM, drill: drill * MM, net, locked: false, layers: ['F.Cu', 'B.Cu'] } });

export interface ZoneFields { layer?: string; fill?: Polygon[]; gap?: number; spoke?: number }

/** A pour with thermal connections; `fill` is its filled copper, none for an unfilled zone. */
export function zone(net: string, x1: number, y1: number, x2: number, y2: number, { layer = 'F.Cu', fill = [], gap = 0.5, spoke = 0.5 }: ZoneFields = {}): Zone {
  return {
    id: `z${net}${layer}`, name: '', net, layers: [layer], outline: [box(x1, y1, x2, y2)], filled: fill.length ? [{ layer, polygons: fill }] : [], rule_area: null,
    fill: { clearance: 0, min_thickness: 0, thermal_gap: gap * MM, spoke_width: spoke * MM, pad_connection: 'Thermal', island_removal_mode: 0, min_island_area: 0 },
  };
}

export const board = (footprints: Footprint[], copper: RoutedCopper[] = [], zones: Zone[] = [], nets = ['SIG', 'GND', 'VCC', 'ISO_0V']): Board => ({
  path: 'T.kicad_pcb', copper_layers: ['F.Cu', 'B.Cu'], stackup: [], nets: Object.fromEntries(nets.map(net => [net, 'Default'])), footprints, copper, zones, graphics: [], texts: [], groups: [],
  constraints: { min_clearance: 0, min_track_width: 0, min_via_size: 0, copper_edge_clearance: 0 }, edges_bbox: { left: 0, top: 0, right: 0, bottom: 0 }, outlines: [box(0, 0, 30, 20)],
});

/** One net class; the 0.5 mm edge clearance is KiCad's default. */
export const project: ProjectFile = {
  net_settings: { classes: [{ name: 'Default', track_width: 0.2, clearance: 0.2, via_diameter: 0.6, via_drill: 0.3 }], netclass_patterns: [] },
  board: { design_settings: { rules: { min_copper_edge_clearance: 0.5 } } },
};
