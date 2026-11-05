// A small board for the tests of the silk tools: a document and its text, 60 x 40 mm at (100, 100), with one two-pin connector.
import { crc32, deflateSync } from 'node:zlib';
import type { Board, Footprint, Graphic, Pad, Polygon, Pt } from './board-types.ts';

function pngChunk(kind: string, data: Buffer): Buffer {
  const body = Buffer.concat([Buffer.from(kind, 'latin1'), data]);
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([length, body, crc]);
}

/** A PNG of rows of palette indices; palette entries are RGB, alpha optional. */
export function palettePng(rows: number[][], palette: number[][], alpha?: number[]): Buffer {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(rows[0]!.length, 0);
  header.writeUInt32BE(rows.length, 4);
  header.set([8, 3, 0, 0, 0], 8);
  const raw = Buffer.concat(rows.map(row => Buffer.from([0, ...row])));
  return Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), pngChunk('IHDR', header), pngChunk('PLTE', Buffer.from(palette.flat())),
    ...(alpha ? [pngChunk('tRNS', Buffer.from(alpha))] : []), pngChunk('IDAT', deflateSync(raw)), pngChunk('IEND', Buffer.alloc(0))]);
}

const nm = (mm: number): number => Math.round(mm * 1e6);
export const pt = (x: number, y: number): Pt => ({ x: nm(x), y: nm(y) });
export const rectRing = (x0: number, y0: number, x1: number, y1: number): Pt[] => [pt(x0, y0), pt(x1, y0), pt(x1, y1), pt(x0, y1)];
export const polygon = (x0: number, y0: number, x1: number, y1: number): Polygon => ({ outline: rectRing(x0, y0, x1, y1), holes: [] });

export function pad(number: string, net: string, x: number, y: number, half = 0.5, drill = 0): Pad {
  return {
    id: `pad-${number}-${x}`, number, kind: drill ? 'ThroughHole' : 'Smd', shape: 'Rect', net, position: pt(x, y), orientation: 0,
    size: pt(2 * half, 2 * half), drill: pt(drill, drill), layers: drill ? ['F.Cu', 'B.Cu'] : ['F.Cu'],
    bbox: { left: nm(x - half), top: nm(y - half), right: nm(x + half), bottom: nm(y + half) }, zone_connection: null,
    thermal_spoke_angle: 0, spoke_templates: 0, copper: [], polygons: {}, solder_mask_expansion: 0, clearance_override: null,
  };
}

/** `width` in nanometres, as the document holds it. */
export const silkLine = (x0: number, y0: number, x1: number, y1: number, layer = 'F.SilkS', width = 100_000): Graphic =>
  ({ id: `g-${x0}-${y0}`, geometry: { Segment: { start: pt(x0, y0), end: pt(x1, y1) } }, layer, width, filled: false });

export function footprint(reference: string, x: number, y: number, pads: Pad[], courtyard?: Polygon): Footprint {
  return {
    id: `fp-${reference}`, reference, value: `${reference}-VALUE`, lib_id: 'x:y', layer: 'F.Cu', position: pt(x, y), orientation: 0, locked: false,
    clearance_override: null, fields: [], pads, graphics: [], zones: [], courtyard_front: courtyard ? [courtyard] : [], courtyard_back: [],
  };
}

export function fixtureBoard(footprints: Footprint[], nets: Record<string, string> = { '/A': 'Default', GND: 'Default' }): Board {
  return {
    path: 'fixture.kicad_pcb', copper_layers: ['F.Cu', 'B.Cu'], stackup: [], nets, footprints, copper: [], zones: [], graphics: [], texts: [], groups: [],
    constraints: { min_clearance: 0, min_track_width: 0, min_via_size: 0, copper_edge_clearance: 0 },
    edges_bbox: { left: nm(100), top: nm(100), right: nm(160), bottom: nm(140) }, outlines: [polygon(100, 100, 160, 140)],
  };
}

/** A two-pin connector at (130, 120): pads 2.5 mm apart, a 1 x 1 mm pad each, a courtyard round them. */
export const connector = (): Footprint =>
  footprint('J1', 130, 120, [pad('1', '/A', 128.75, 120), pad('2', 'GND', 131.25, 120)], polygon(127.5, 118.5, 132.5, 121.5));

export const footprintForm = (reference: string, x: number, y: number, uuid: string, angle = 0): string => `\t(footprint "x:y"
\t\t(layer "F.Cu")
\t\t(uuid "${uuid}")
\t\t(at ${x} ${y} ${angle})
\t\t(property "Reference" "${reference}"
\t\t\t(at 0 -3 0)
\t\t\t(layer "F.SilkS")
\t\t\t(uuid "${uuid}-ref")
\t\t\t(effects
\t\t\t\t(font
\t\t\t\t\t(size 1 1)
\t\t\t\t\t(thickness 0.15)
\t\t\t\t)
\t\t\t)
\t\t)
\t\t(property "Value" "${reference}-VALUE"
\t\t\t(at 0 3 0)
\t\t\t(layer "F.Fab")
\t\t\t(hide yes)
\t\t\t(uuid "${uuid}-val")
\t\t\t(effects
\t\t\t\t(font
\t\t\t\t\t(size 1 1)
\t\t\t\t\t(thickness 0.15)
\t\t\t\t)
\t\t\t)
\t\t)
\t)
`;

export const fixtureText = (...forms: string[]): string => `(kicad_pcb\n\t(version 20260206)\n${forms.join('')})\n`;
