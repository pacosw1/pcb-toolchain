// Pixel-art silkscreen probe. It only measures: tools/lib/pixel-art-checks.mjs makes the pass and fail decisions.
//
//   tools/check_pixel_art.ts BOARD.kicad_pcb NAME [NAME ...]
//
// Prints one JSON line. For each group "pixel-art <name>" (made by tools/pixel-art.ts) it reports:
// - the silk layers of the shapes,
// - the shapes that are less than EDGE_MM inside the board outline, cut-outs included,
// - the obstacles that a shape, grown by CLEAR_MM, touches on the same board side: a pad with its solder mask opening, a mask
//   opening, a hole, a via that is not tented, a hole keepout (H<n>_KEEPOUT) or barrier rule area, a courtyard, and any other
//   silkscreen item (reference texts, the JLC order-number text, logos, other pixel-art groups).
// A shape counts by its box. Geometry comes from the board document, and what the document does not hold (groups, text sizes, via
// tenting) from the board text.
import { existsSync, readFileSync } from 'node:fs';
import { boardJson } from './lib/board-json.ts';
import { polygonNearSegment, polygonsContain, polygonsOverlap } from './lib/board-hit.ts';
import { graphicBoxes, grow, readSilk, rectBox, touch, unionBox, type Box, type Silk } from './lib/board-silk.ts';
import { NM_PER_MM, type Board, type Polygon } from './lib/board-types.ts';
import { runMain, UsageError } from './lib/cli.ts';
import { round } from './lib/py-numbers.ts';
import { atom, kids, layerOf, one, parse, pose, type SList } from './lib/sexpr.ts';

const USAGE = 'usage: tools/check_pixel_art.ts BOARD.kicad_pcb NAME [NAME ...]';
const EDGE_MM = 0.5;
const CLEAR_MM = 0.2;
const PREFIX = 'pixel-art ';
const HOLE_KEEPOUT = /^H\d+_KEEPOUT$/;
/** Board drawings that readSilk does not measure: on a side under test they stop the probe, so nothing passes unmeasured. */
const UNREAD_DRAWINGS = ['gr_text_box', 'dimension', 'image', 'table', 'barcode'];

type Side = 'F' | 'B';
type Obstacle = { label: string; box: Box } | { label: string; polygons: Polygon[] };

export type ArtReport = { exists: false } | { exists: true; shapes: number; layers: string[]; bbox: Box; outside: [number, number][]; hits: string[] };
export interface ArtMeasure { edge_mm: number; clear_mm: number; art: Record<string, ArtReport> }

const nm = (mm: number): number => Math.round(mm * NM_PER_MM);

function rectPolygon([x0, y0, x1, y1]: Box): Polygon {
  const [left, top, right, bottom] = [nm(x0), nm(y0), nm(x1), nm(y1)];
  return { outline: [{ x: left, y: top }, { x: right, y: top }, { x: right, y: bottom }, { x: left, y: bottom }], holes: [] };
}

/** Is any part of the box outside the outline, or nearer than EDGE_MM to it or to a cut-out? */
function nearEdge({ outlines }: Board, box: Box): boolean {
  const rect = rectPolygon(box);
  if (!rect.outline.every(corner => polygonsContain(outlines, corner))) return true;
  return outlines.flatMap(({ outline, holes }) => [outline, ...holes]).some(ring =>
    ring.some((a, i) => polygonNearSegment(rect, a, ring[(i + 1) % ring.length]!, nm(EDGE_MM))));
}

/** The (tenting ...) of a via or the board setup for one side: (tenting (front yes) (back no)), or the bare (tenting front back). */
function tenting(form: SList | undefined, side: 'front' | 'back'): boolean | undefined {
  const tented = form && one(form, 'tenting');
  if (!tented) return undefined;
  const flag = one(tented, side);
  if (flag) return atom(flag, 1) === 'yes';
  return tented.slice(1).every(item => typeof item === 'string') ? tented.includes(side) : undefined;
}

/** PCB_VIA::IsTented: the via's own setting, else the board's, which is tented unless the file says otherwise. */
function untentedVias(root: SList, side: Side): Box[] {
  const name = side === 'F' ? 'front' : 'back';
  const byDefault = tenting(one(root, 'setup'), name) ?? true;
  return kids(root, 'via').filter(via => !(tenting(via, name) ?? byDefault)).map(via => {
    const { x, y } = pose(via);
    const radius = Number(atom(one(via, 'size') ?? [], 1)) / 2;
    return [x - radius, y - radius, x + radius, y + radius];
  });
}

function refuseUnread(root: SList, layers: string[]): void {
  for (const form of UNREAD_DRAWINGS.flatMap(kind => kids(root, kind))) {
    const layer = layerOf(form);
    if (layer !== undefined && layers.includes(layer)) throw new Error(`check_pixel_art: cannot measure the ${String(form[0])} on ${layer}`);
  }
}

function footprintObstacles(board: Board, silk: Silk, side: Side): Obstacle[] {
  const [cu, mask, silkLayer, courtyard] = [`${side}.Cu`, `${side}.Mask`, `${side}.SilkS`, `${side}.CrtYd`];
  const out: Obstacle[] = [];
  for (const { reference, pads, graphics } of board.footprints) {
    for (const pad of pads) {
      const onMask = pad.layers.includes(mask);
      if (pad.drill.x > 0 || pad.layers.includes(cu) || onMask) {
        out.push({ label: `pad ${reference}.${pad.number}`, box: grow(rectBox(pad.bbox), onMask ? Math.max(0, pad.solder_mask_expansion / NM_PER_MM) : 0) });
      }
    }
    out.push(...graphicBoxes(graphics, courtyard).map(box => ({ label: `courtyard ${reference}`, box })));
    out.push(...graphicBoxes(graphics, mask).map(box => ({ label: `mask opening ${reference}`, box })));
    out.push(...graphicBoxes(graphics, silkLayer).map(box => ({ label: `silk ${reference} PCB_SHAPE`, box })));
  }
  for (const { layer, reference, name, box, visible } of silk.footprintTexts) {
    if (layer === courtyard) out.push({ label: `courtyard ${reference}`, box });
    else if (layer === mask) out.push({ label: `mask opening ${reference}`, box });
    else if (layer === silkLayer && visible) out.push({ label: `silk ${reference} ${name === 'user' ? 'PCB_TEXT' : 'PCB_FIELD'}`, box });
  }
  return out;
}

/** What art on one side keeps clear of; `own` is the art's group, whose shapes are not obstacles to it. */
function obstacles(board: Board, root: SList, silk: Silk, side: Side, own: string): Obstacle[] {
  const [mask, silkLayer] = [`${side}.Mask`, `${side}.SilkS`];
  refuseUnread(root, [mask, silkLayer]);
  const inGroup = (group?: string): string => (group === undefined ? '' : ` (group "${group}")`);
  const out = footprintObstacles(board, silk, side);
  out.push(...untentedVias(root, side).map(box => ({ label: 'untented via', box })));
  for (const { name, rule_area: rule, outline } of board.zones) {
    if (rule && (HOLE_KEEPOUT.test(name) || name.toUpperCase().includes('BARRIER'))) out.push({ label: `rule area ${name}`, polygons: outline });
  }
  for (const { layer, group, box } of silk.shapes) {
    if (group === own) continue;
    if (layer === mask) out.push({ label: 'board mask opening', box });
    else if (layer === silkLayer) out.push({ label: `board silk${inGroup(group)}`, box });
  }
  for (const { layer, group, box, text } of silk.texts) {
    if (layer === mask) out.push({ label: 'board mask opening', box });
    else if (layer === silkLayer) out.push({ label: `text "${text}"${inGroup(group)}`, box });
  }
  return out;
}

function touches(box: Box, obstacle: Obstacle): boolean {
  if ('box' in obstacle) return touch(box, obstacle.box);
  const rect = rectPolygon(box);
  return obstacle.polygons.some(polygon => polygonsOverlap(polygon, rect));
}

const mm3 = (value: number): number => round(value, 3);

function measureGroup(board: Board, root: SList, silk: Silk, group: string): ArtReport {
  const shapes = silk.shapes.filter(shape => shape.group === group);
  const layers = [...new Set(shapes.map(shape => shape.layer))].sort();
  const side: Side = layers.length === 1 && layers[0] === 'B.SilkS' ? 'B' : 'F';
  const around = obstacles(board, root, silk, side, group);
  const hits = new Set(shapes.flatMap(({ box }) => around.filter(obstacle => touches(grow(box, CLEAR_MM), obstacle)).map(obstacle => obstacle.label)));
  const outside = shapes.filter(({ box }) => nearEdge(board, box)).map(({ box }): [number, number] => [mm3(box[0]), mm3(box[1])]);
  const bbox = shapes.length ? shapes.map(shape => shape.box).reduce(unionBox).map(mm3) as unknown as Box : [0, 0, 0, 0] as const;
  return { exists: true, shapes: shapes.length, layers, bbox, outside, hits: [...hits].sort() };
}

/** The report of each named art. */
export function measureArt(board: Board, text: string, names: string[]): ArtMeasure {
  const root = parse(text);
  const silk = readSilk(text);
  const groups = new Set(kids(root, 'group').map(group => atom(group, 1)));
  const art = Object.fromEntries(names.map(name => [name, groups.has(PREFIX + name) ? measureGroup(board, root, silk, PREFIX + name) : { exists: false } as const]));
  return { edge_mm: EDGE_MM, clear_mm: CLEAR_MM, art };
}

function main(argv: string[]): number {
  const [pcb, ...names] = argv;
  if (pcb === undefined || !names.length) throw new UsageError(USAGE);
  if (!existsSync(pcb)) throw new Error(`no board ${pcb}`);
  console.log(JSON.stringify(measureArt(boardJson(pcb).board, readFileSync(pcb, 'utf8'), names)));
  return 0;
}

runMain(import.meta.url, main);
