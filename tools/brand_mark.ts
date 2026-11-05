// Put the brand block on the bottom silkscreen of a board: the PITSA logo and "<NAME> rev <REV>".
//
//   tools/brand_mark.ts BOARD.kicad_pcb --name BASE-PWR --rev A [--logo-mm 16] [--text-mm 1.2] [--near X Y] [--dry-run]
//
// User request 2026-10-04: each board shows its name, its revision and the PITSA logo. All parts are on the top side, so the
// block goes on B.SilkS (mirrored, so it reads correctly from the bottom).
// - Logo: hardware-design/boards/_art/pitsa-logo.png (see its .source.json). The dark pixels become filled silk rectangles: the
//   image is resampled to a 0.1 mm pixel grid and each run of a row is one rectangle; equal runs of adjacent rows are joined.
//   The smallest logo feature at 16 mm wide is about 0.3 mm (JLC silk minimum 0.153 mm).
// - Text: "<NAME> rev <REV>", 1.2 mm high (--text-mm), 0.18 mm stroke (0.15 mm per mm above 1.2 mm), under the logo.
// - Place: the block box (+ 0.5 mm) must be 1 mm inside the board outline (holes and cut-outs included), clear of each hole
//   (vias, through-hole pads, NPTH) by 0.3 mm, of B.Cu pads, of rule areas on B.Cu, and of all B.SilkS items (board and
//   footprint). The free place nearest to --near (default: the board centre) on a 0.5 mm grid.
// - The shapes go in one group "brand <NAME>". A rerun removes the old group first.
// Prints the place. Exit 1 when no place fits (then try a smaller --logo-mm).
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { BoardEdit, itemIds, saveBoardInPlace } from './lib/board-edit.ts';
import { rectText, textText } from './lib/board-items.ts';
import { boxCentre, graphicBoxes, grow, insideBoard, polygonsBox, readSilk, rectBox, touch, type Box, type Xy } from './lib/board-silk.ts';
import { boardJson } from './lib/board-json.ts';
import { toMm, vias, type Board } from './lib/board-types.ts';
import { parseFlags, runMain, UsageError } from './lib/cli.ts';
import { fixed } from './lib/py-compat.mjs';
import { logoRects, type Logo } from './lib/logo-raster.ts';
import { projectRoot } from './lib/project-root.mjs';
import { round } from './lib/py-numbers.ts';
import { textBox } from './lib/stroke-text.ts';

const USAGE = 'usage: tools/brand_mark.ts BOARD.kicad_pcb --name NAME --rev REV [--logo-mm MM] [--text-mm MM] [--near X Y] [--dry-run]';
const LAYER = 'B.SilkS';
const PIXEL_MM = 0.1;
const SILK_W = 0.16; // JLC silkscreen minimum line 0.153 mm
const TEXT_GAP = 0.6; // between the logo and the text
const BLOCK_MARGIN = 0.5;
const EDGE_GAP = 1.0;
const HOLE_GAP = 0.3;
const EDGE_STEPS = 20;

export interface BrandOptions { name: string; rev: string; logoMm: number; textMm: number; near?: Xy }
export interface BrandPlace { centre: Xy; width: number; height: number; rects: number; label: string }

const labelOf = ({ name, rev }: BrandOptions): string => `${name} rev ${rev}`;
const penOf = (textMm: number): number => Math.max(0.18, round(0.15 * textMm, 3));

interface Keepouts { holes: { at: Xy; radius: number }[]; boxes: Box[] }

function keepouts(board: Board, text: string, group: string): Keepouts {
  const holes = vias(board).map(via => ({ at: [toMm(via.at.x), toMm(via.at.y)] as Xy, radius: toMm(via.drill) / 2 }));
  const boxes: Box[] = [];
  for (const footprint of board.footprints) {
    for (const pad of footprint.pads) {
      if (pad.drill.x) holes.push({ at: [toMm(pad.position.x), toMm(pad.position.y)], radius: toMm(Math.max(pad.drill.x, pad.drill.y)) / 2 });
      if (pad.layers.includes('B.Cu') || pad.layers.includes('B.Mask')) boxes.push(rectBox(pad.bbox));
    }
    boxes.push(...graphicBoxes(footprint.graphics, LAYER));
  }
  boxes.push(...board.zones.filter(zone => zone.rule_area && zone.layers.includes('B.Cu')).map(zone => polygonsBox(zone.outline)).filter(box => box !== null));
  const silk = readSilk(text);
  const onSide = <T extends { layer: string; group?: string }>(item: T): boolean => item.layer === LAYER && item.group !== group;
  boxes.push(...silk.texts.filter(onSide).map(item => item.box), ...silk.shapes.filter(onSide).map(item => item.box));
  boxes.push(...silk.footprintTexts.filter(item => item.layer === LAYER && item.visible).map(item => item.box));
  return { holes, boxes };
}

function blockFree(board: Board, { holes, boxes }: Keepouts, [cx, cy]: Xy, width: number, height: number): boolean {
  const box: Box = grow([cx - width / 2, cy - height / 2, cx + width / 2, cy + height / 2], BLOCK_MARGIN);
  const [x0, y0, x1, y1] = box;
  for (let k = 0; k <= EDGE_STEPS; k++) {
    const [along, down] = [x0 + (x1 - x0) * k / EDGE_STEPS, y0 + (y1 - y0) * k / EDGE_STEPS];
    const ring: Xy[] = [[along, y0 - EDGE_GAP], [along, y1 + EDGE_GAP], [x0 - EDGE_GAP, down], [x1 + EDGE_GAP, down]];
    if (!ring.every(point => insideBoard(board, point))) return false;
  }
  if (holes.some(({ at, radius }) => {
    const reach = radius + HOLE_GAP;
    return x0 - reach < at[0] && at[0] < x1 + reach && y0 - reach < at[1] && at[1] < y1 + reach;
  })) return false;
  return !boxes.some(other => touch(box, other));
}

/** The free grid point nearest to `near`, or null. */
function freePlace(board: Board, kept: Keepouts, near: Xy, width: number, height: number): Xy | null {
  const edges = rectBox(board.edges_bbox);
  let best: { distance: number; at: Xy } | null = null;
  for (let gx = Math.trunc(edges[0]); gx <= Math.trunc(edges[2]); gx++) {
    for (let half = Math.trunc(edges[1]) * 2; half <= Math.trunc(edges[3]) * 2; half++) {
      for (const cx of [gx, gx + 0.5]) {
        const at: Xy = [cx, half / 2];
        const distance = Math.hypot(at[0] - near[0], at[1] - near[1]);
        if ((best === null || distance < best.distance) && blockFree(board, kept, at, width, height)) best = { distance, at };
      }
    }
  }
  return best?.at ?? null;
}

function drawBlock(edit: BoardEdit, next: () => string, group: string, logo: Logo, options: BrandOptions, [cx, cy]: Xy, height: number): void {
  const left = cx - logo.width / 2;
  const top = cy - height / 2;
  const members: string[] = [];
  for (const [x0, y0, x1, y1] of logo.rects) {
    // Mirrored in x about the block centre, so the logo reads from the bottom. A SILK_W stroke inset by SILK_W / 2, as
    // tools/pixel-art.ts: the outer edge is the pixel edge. A run thinner than SILK_W becomes a SILK_W line.
    const [xa, xb] = [cx + (cx - (left + x1)), cx + (cx - (left + x0))];
    const [ya, yb] = [top + y0, top + y1];
    const [insetX, insetY] = [Math.min(SILK_W / 2, (xb - xa) / 2), Math.min(SILK_W / 2, (yb - ya) / 2)];
    const uuid = next();
    edit.add(rectText({ start: [xa + insetX, ya + insetY], end: [xb - insetX, yb - insetY], layer: LAYER, width: SILK_W, filled: true, uuid }));
    members.push(uuid);
  }
  const uuid = next();
  edit.add(textText({ text: labelOf(options), at: [cx, cy + height / 2 - options.textMm / 2], layer: LAYER, size: options.textMm, thickness: penOf(options.textMm), mirrored: true, uuid }));
  edit.addGroup(`brand ${options.name}`, [...members, uuid], next());
}

/** The board text with the block in its free place, or null when none fits. */
export function brandBlock(board: Board, text: string, options: BrandOptions, logoFile: Buffer): { text: string; place: BrandPlace } | null {
  const group = `brand ${options.name}`;
  const edit = new BoardEdit(text);
  for (const old of edit.groups().filter(item => item.name === group)) edit.removeGroup(old);
  const logo = logoRects(logoFile, options.logoMm, PIXEL_MM);
  const label = textBox(labelOf(options), { height: options.textMm, width: options.textMm, thickness: penOf(options.textMm), mirrored: true });
  const width = Math.max(logo.width, label[2] - label[0]);
  const height = logo.height + TEXT_GAP + options.textMm;
  const near = options.near ?? boxCentre(rectBox(board.edges_bbox));
  const centre = freePlace(board, keepouts(board, text, group), near, width, height);
  if (!centre) return null;
  drawBlock(edit, itemIds(text, 'brand-mark'), group, logo, options, centre, height);
  return { text: edit.text(), place: { centre, width, height, rects: logo.rects.length, label: labelOf(options) } };
}

export const logoFile = (root = projectRoot()): Buffer => readFileSync(join(root, 'hardware-design/boards/_art/pitsa-logo.png'));

export const placeLine = ({ name }: BrandOptions, { centre, width, height, rects, label }: BrandPlace): string =>
  `brand_mark: ${name}: block ${fixed(width, 1)} x ${fixed(height, 1)} mm at (${fixed(centre[0], 1)}, ${fixed(centre[1], 1)}) on ${LAYER}, ${rects} logo rectangles, text "${label}"`;

/** Takes `flag X Y` out of the arguments: a coordinate may start with a minus sign. */
function takePair(argv: string[], flag: string): { rest: string[]; pair?: Xy } {
  const at = argv.indexOf(flag);
  if (at < 0) return { rest: argv };
  const pair: Xy = [Number(argv[at + 1]), Number(argv[at + 2])];
  if (pair.some(Number.isNaN)) throw new UsageError(USAGE);
  return { rest: argv.toSpliced(at, 3), pair };
}

function main(argv: string[]): number {
  const { rest, pair: near } = takePair(argv, '--near');
  const { values, positionals } = parseFlags(rest, {
    name: { type: 'string' }, rev: { type: 'string' }, 'logo-mm': { type: 'string' }, 'text-mm': { type: 'string' }, 'dry-run': { type: 'boolean' },
  }, USAGE);
  const [pcb] = positionals;
  if (positionals.length !== 1 || pcb === undefined || values.name === undefined || values.rev === undefined) throw new UsageError(USAGE);
  if (!existsSync(pcb)) throw new Error(`no board ${pcb}`);
  const options: BrandOptions = { name: values.name, rev: values.rev, logoMm: Number(values['logo-mm'] ?? 16), textMm: Number(values['text-mm'] ?? 1.2), ...(near ? { near } : {}) };
  const placed = brandBlock(boardJson(pcb).board, readFileSync(pcb, 'utf8'), options, logoFile());
  if (!placed) throw new UsageError(`brand_mark: no free place on ${LAYER} for the block (try --logo-mm smaller)`, 1);
  console.log(placeLine(options, placed.place));
  if (!values['dry-run']) saveBoardInPlace(pcb, placed.text);
  return 0;
}

runMain(import.meta.url, main);
