// Add rating labels, cable mating labels and an isolation-barrier line to the top silkscreen of a board.
//
//   tools/silk_marks.ts <BOARD> [--dry-run] [--pcb PATH]   (--pcb: a scratch copy)
//
// Reads hardware-design/boards/<BOARD>/silk-marks.json:
//   {"texts": [{"text": "18-32V DC IN", "near": "J1", "size": 1.0}, ...],
//    "barrier": {"classes": ["HOST", "HOST_PWR"], "gap": 4.0, "label": "ISOLATED",
//                "label_near": [x, y], "label_angle": 90},          (label_near/label_angle optional: a dense barrier)
//    "no_silk": [[x0, y0, x1, y1], ...],
//    "refs": {"keep": ["J*", "TP*", ...], "skip_values": ["*CA"], "size": 0.8, "max_mm": 2.5,
//             "inside_span": false (true: a reference stays inside the x / y span of its own courtyard)}}
//                                                    (references kept on F.SilkS; skip_values: no polarity, e.g. bidirectional TVS)
// - texts: F.SilkS, stroke 0.15 mm (JLC minimum 0.153 mm is for lines; text 0.15 with 0.8 mm height prints, the repo standard),
//   placed at the free spot nearest to the anchor footprint: the text box (+0.2 mm) is inside the board (1.0 mm from the edge),
//   clear of every pad and hole (+0.25 mm), of all other silkscreen (+0.15 mm), of every footprint courtyard, and of the
//   no_silk boxes. A text with no free spot within 8 mm stops the tool.
// - barrier: the copper of the nets of these net classes (all copper layers: pads, tracks, vias, zone fills) grown by gap / 2 is
//   the domain; its outline (the middle of the gap) is drawn as a dashed 0.15 mm F.SilkS line inside the board, broken where it
//   would come within 0.3 mm of a pad or a hole, and the label is placed next to it.
// - Everything goes in group "silk-marks"; a rerun replaces it.
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { offsetOutlines, type BarrierShape } from './lib/barrier-line.ts';
import { BoardEdit, itemIds, mmText, quoted, saveBoardInPlace } from './lib/board-edit.ts';
import { lineText, textText } from './lib/board-items.ts';
import { boardJson } from './lib/board-json.ts';
import { boxCentre, boxOfPoints, boxProbes, courtyardOf, footprintBox, graphicBoxes, grow, hit, insideBoard, offset, readSilk, rectBox, toFootprint, touch, type Box, type FootprintText, type Silk, type Xy } from './lib/board-silk.ts';
import { toMm, tracks, vias, type Board, type Footprint, type Polygon, type Pt } from './lib/board-types.ts';
import { parseFlags, runMain, UsageError } from './lib/cli.ts';
import { fnmatchCase } from './lib/fnmatch.ts';
import { readJson } from './lib/json-file.ts';
import { fixed } from './lib/py-compat.mjs';
import { projectRoot } from './lib/project-root.mjs';
import { textBox } from './lib/stroke-text.ts';

const USAGE = 'usage: tools/silk_marks.ts BOARD [--dry-run] [--pcb PATH]';
export const GROUP = 'silk-marks';
const LAYER = 'F.SilkS';
const EDGE_GAP = 1.0;
const TEXT_MARGIN = 0.2;
const PAD_GAP = 0.25;
const HOLE_GAP = 0.1; // vias too: text over vias reads badly
const SILK_GAP = 0.15;
const COURTYARD_MARGIN = 0.25; // D-051: the part body is the courtyard less this
const SEARCH_STEP = 0.25;
const SEARCH_MM = 8;
const LINE_MM = 0.15;
const PIECE_MM = 0.5; // short pieces, so a break near a pad removes little
const LINE_KEEP_GAP = 0.3;
const REF_MARGIN = 0.1;
const CROWD_REACH = 3;

export interface MarkText { text: string | string[]; near: string | Xy; size?: number; angle?: number }
export interface Barrier { classes: string[]; gap: number; label?: string; label_near?: Xy; label_angle?: number }
export interface RefRules { keep: string[]; skip_values?: string[]; size?: number; max_mm?: number; inside_span?: boolean }
export interface MarksSpec { texts?: MarkText[]; barrier?: Barrier; no_silk?: Box[]; refs?: RefRules }

const ptMm = (point: Pt): Xy => [toMm(point.x), toMm(point.y)];
const penOf = (size: number): number => (size <= 1 ? 0.15 : 0.18);

/** The board side of a place search: what stays and what is added as the tool goes. */
class Marks {
  readonly pads: Box[];
  readonly holes: Box[];
  readonly drilled: Box[];
  readonly courtyards: Map<string, Box>;
  readonly bodies: Box[];
  readonly noSilk: Box[];
  readonly silk: Box[];
  readonly lines: string[] = [];
  readonly board: Board;

  constructor(board: Board, silk: Silk, noSilk: Box[]) {
    this.board = board;
    const pads = board.footprints.flatMap(footprint => footprint.pads);
    this.pads = pads.map(pad => rectBox(pad.bbox));
    this.drilled = pads.filter(pad => pad.drill.x > 0).map(pad => rectBox(pad.bbox));
    this.holes = [...this.drilled, ...vias(board).map(via => viaBox(via.at, via.size))];
    this.courtyards = new Map(board.footprints.map(footprint => [footprint.reference, courtyardOf(footprint) ?? footprintBox(footprint)]));
    this.bodies = [...this.courtyards.values()].map(box => grow(box, -COURTYARD_MARGIN));
    this.noSilk = noSilk;
    this.silk = [
      ...silk.texts.filter(item => item.layer === LAYER && item.group !== GROUP).map(item => item.box),
      ...silk.shapes.filter(item => item.layer === LAYER && item.group !== GROUP).map(item => item.box),
      ...graphicBoxes(board.footprints.flatMap(footprint => footprint.graphics), LAYER),
      ...silk.footprintTexts.filter(item => item.layer === LAYER && item.visible).map(item => item.box),
    ];
  }

  free(box: Box): boolean {
    return boxProbes(box).every(point => insideBoard(this.board, point, EDGE_GAP))
      && !this.pads.some(pad => touch(box, grow(pad, PAD_GAP)))
      && !this.holes.some(hole => touch(box, grow(hole, HOLE_GAP)))
      && !this.silk.some(item => touch(box, grow(item, SILK_GAP)))
      && ![...this.courtyards.values()].some(courtyard => touch(box, courtyard))
      && !this.noSilk.some(zone => touch(box, zone));
  }
}

const viaBox = (at: Pt, size: number): Box => { const [x, y] = ptMm(at); const r = toMm(size) / 2; return [x - r, y - r, x + r, y + r]; };

/** A free spot on the rings round the anchor: the nearest of the first ring that has one. */
function freeSpot(marks: Marks, text: string, near: string | Xy, size: number, angle: number): Xy | null {
  const anchor = typeof near === 'string' ? marks.courtyards.get(near) : ([...near, ...near] as unknown as Box);
  if (!anchor) throw new Error(`silk_marks: no footprint ${String(near)}`);
  const [cx, cy] = boxCentre(anchor);
  const [rx, ry] = [(anchor[2] - anchor[0]) / 2, (anchor[3] - anchor[1]) / 2];
  const ink = textBox(text, { height: size, width: size, thickness: penOf(size), angle });
  for (let ring = 0; ring < SEARCH_MM / SEARCH_STEP; ring++) {
    const reach = ring * SEARCH_STEP;
    const count = Math.max(16, ring * 4);
    let best: { distance: number; at: Xy } | null = null;
    for (let i = 0; i < count; i++) {
      const turn = 2 * Math.PI * i / count;
      const at: Xy = [cx + Math.cos(turn) * (rx + reach + size), cy + Math.sin(turn) * (ry + reach + size / 2)];
      const distance = Math.hypot(at[0] - cx, at[1] - cy);
      if ((best === null || distance < best.distance) && marks.free(grow(offset(ink, at), TEXT_MARGIN))) best = { distance, at };
    }
    if (best) return best.at;
  }
  return null;
}

interface AddText { text: string; at: Xy; size: number; angle: number }

function placeText(marks: Marks, added: AddText[], text: string, near: string | Xy, size: number, angle: number): boolean {
  const at = freeSpot(marks, text, near, size, angle);
  if (!at) return false;
  marks.silk.push(offset(textBox(text, { height: size, width: size, thickness: penOf(size), angle }), at));
  added.push({ text, at, size, angle });
  marks.lines.push(`  text "${text}" at (${fixed(at[0], 2)}, ${fixed(at[1], 2)}) angle ${angle} near ${String(near)}`);
  return true;
}

/** A string or a list of fallbacks, longest first; each is tried at its angle, then at 90. */
function placeMark(marks: Marks, added: AddText[], board: string, mark: MarkText): void {
  const options = Array.isArray(mark.text) ? mark.text : [mark.text];
  for (const text of options) {
    for (const angle of [mark.angle ?? 0, 90]) if (placeText(marks, added, text, mark.near, mark.size ?? 0.8, angle)) return;
  }
  throw new Error(`silk_marks ${board}: no free place for "${options.at(-1)}" near ${String(mark.near)}`);
}

const ring = (points: Pt[]): Xy[] => points.map(ptMm);
const polygonShape = ({ outline, holes }: Polygon): BarrierShape => ({ kind: 'polygon', rings: [ring(outline), ...holes.map(ring)] });

/** The copper of the barrier's nets on every copper layer. */
export function domainShapes(board: Board, classes: string[]): BarrierShape[] {
  const nets = new Set(Object.entries(board.nets).filter(([, name]) => classes.includes(name)).map(([net]) => net));
  const copper = new Set(board.copper_layers);
  return [
    ...tracks(board).filter(track => nets.has(track.net)).map(track => ({ kind: 'capsule', a: ptMm(track.start), b: ptMm(track.end), radius: toMm(track.width) / 2 }) as const),
    ...vias(board).filter(via => nets.has(via.net)).map(via => ({ kind: 'capsule', a: ptMm(via.at), b: ptMm(via.at), radius: toMm(via.size) / 2 }) as const),
    ...board.footprints.flatMap(footprint => footprint.pads).filter(pad => nets.has(pad.net)).flatMap(pad => {
      const polygons = Object.entries(pad.polygons).filter(([layer]) => copper.has(layer)).map(([, polygon]) => polygon);
      return polygons.length ? polygons.slice(0, 1).map(polygonShape) : [padBoxShape(rectBox(pad.bbox))];
    }),
    ...board.zones.filter(zone => !zone.rule_area && nets.has(zone.net)).flatMap(zone => zone.filled).filter(fill => copper.has(fill.layer)).flatMap(fill => fill.polygons.map(polygonShape)),
  ];
}

const padBoxShape = ([x0, y0, x1, y1]: Box): BarrierShape => ({ kind: 'polygon', rings: [[[x0, y0], [x1, y0], [x1, y1], [x0, y1]]] });

interface Piece { start: Xy; end: Xy }

/** The line round the domain in short pieces, without those that would touch something. */
function barrierPieces(marks: Marks, outlines: Xy[][]): Piece[] {
  const keep = [...marks.pads, ...marks.holes];
  const pieces: Piece[] = [];
  for (const outline of outlines) {
    outline.forEach((a, index) => {
      const c = outline[(index + 1) % outline.length]!;
      const parts = Math.max(1, Math.floor(Math.hypot(c[0] - a[0], c[1] - a[1]) / PIECE_MM));
      for (let part = 0; part < parts; part++) {
        const along = (t: number): Xy => [a[0] + (c[0] - a[0]) * t / parts, a[1] + (c[1] - a[1]) * t / parts];
        const [start, end] = [along(part), along(part + 1)];
        if (!insideBoard(marks.board, start, EDGE_GAP) || !insideBoard(marks.board, end, EDGE_GAP)) continue;
        const box = boxOfPoints([start, end]);
        const lineKeep = grow(box, LINE_KEEP_GAP);
        const lineSilk = grow(box, SILK_GAP);
        if (keep.some(item => touch(lineKeep, item)) || marks.noSilk.some(zone => touch(box, zone)) || marks.silk.some(item => touch(lineSilk, item))) continue;
        pieces.push({ start, end });
      }
    });
  }
  return pieces;
}

/** The point of the line nearest to its centre of mass: where the label goes unless the spec says. */
function labelPoint(pieces: Piece[]): Xy {
  const mids = pieces.map(({ start, end }): Xy => [(start[0] + end[0]) / 2, (start[1] + end[1]) / 2]);
  const [mx, my] = [mids.reduce((sum, mid) => sum + mid[0], 0) / mids.length, mids.reduce((sum, mid) => sum + mid[1], 0) / mids.length];
  return mids.reduce((best, mid) => (Math.hypot(mid[0] - mx, mid[1] - my) < Math.hypot(best[0] - mx, best[1] - my) ? mid : best));
}

function placeBarrier(marks: Marks, added: AddText[], barrier: Barrier, board: string): Piece[] {
  const pieces = barrierPieces(marks, offsetOutlines(domainShapes(marks.board, barrier.classes), barrier.gap / 2));
  marks.lines.push(`  barrier: ${pieces.length} silk pieces along the ${barrier.gap} mm gap of classes ${barrier.classes.join(' ')}`);
  marks.silk.push(...pieces.map(({ start, end }) => boxOfPoints([start, end]))); // the label must not sit on the line
  if (barrier.label && pieces.length && !placeText(marks, added, barrier.label, barrier.label_near ?? labelPoint(pieces), 0.8, barrier.label_angle ?? 0)) {
    throw new Error(`silk_marks ${board}: no free place for "${barrier.label}"`);
  }
  return pieces;
}

function crowding(obstacles: Box[], courtyard: Box): number {
  const near = grow(courtyard, CROWD_REACH);
  return obstacles.filter(item => hit(item, near)).length;
}

export interface RefMove { field: FootprintText; at: Xy | null; angle: number; size: number }

const stepsAround = (half: number): number[] => {
  const steps: number[] = [];
  for (let value = -half; value <= half; value += SEARCH_STEP) steps.push(value);
  return steps;
};

/** The free place nearest to the courtyard for one reference: angle 0 first, then 90, nearer rings before further ones. */
function refPlace(text: string, courtyard: Box, rules: RefRules, local: Box[], limits: Box, size: number): { at: Xy; angle: number } | null {
  const [cx, cy] = boxCentre(courtyard);
  const [cw, ch] = [courtyard[2] - courtyard[0], courtyard[3] - courtyard[1]];
  const maxMm = rules.max_mm ?? 2.5;
  for (const angle of [0, 90]) {
    const box = grow(textBox(text, { height: size, width: size, thickness: LINE_MM, angle }), REF_MARGIN);
    const [tw, th] = [box[2] - box[0], box[3] - box[1]];
    for (let k = 0; k <= Math.floor(maxMm / SEARCH_STEP); k++) {
      const gap = REF_MARGIN + SEARCH_STEP * k;
      const xs = [courtyard[0] - gap - tw / 2, courtyard[2] + gap + tw / 2];
      const ys = [courtyard[1] - gap - th / 2, courtyard[3] + gap + th / 2];
      const halfX = rules.inside_span ? Math.max(cw / 2 - tw / 2, 0) : cw / 2 + tw / 2;
      const halfY = rules.inside_span ? Math.max(ch / 2 - th / 2, 0) : ch / 2 + th / 2;
      const places = [...stepsAround(halfX).flatMap(dx => ys.map((y): Xy => [cx + dx, y])), ...stepsAround(halfY).flatMap(dy => xs.map((x): Xy => [x, cy + dy]))];
      places.sort((p, q) => Math.hypot(p[0] - cx, p[1] - cy) - Math.hypot(q[0] - cx, q[1] - cy));
      for (const at of places) {
        const placed = offset(box, at);
        if (placed[0] < limits[0] || placed[1] < limits[1] || placed[2] > limits[2] || placed[3] > limits[3]) continue;
        if (!local.some(item => hit(placed, item))) return { at, angle };
      }
    }
  }
  return null;
}

function placeRefs(marks: Marks, rules: RefRules, fields: FootprintText[]): RefMove[] {
  const size = rules.size ?? 0.8;
  const fixedObstacles = [...marks.pads.map(pad => grow(pad, PAD_GAP)), ...marks.drilled.map(hole => grow(hole, HOLE_GAP)), ...marks.bodies, ...marks.noSilk];
  const silk = marks.silk.map(item => grow(item, SILK_GAP));
  const limits = grow(rectBox(marks.board.edges_bbox), -EDGE_GAP);
  const matches = (value: string, patterns: string[]): boolean => patterns.some(pattern => fnmatchCase(value, pattern));
  const targets = marks.board.footprints.filter(footprint => matches(footprint.reference, rules.keep) && !matches(footprint.value, rules.skip_values ?? []));
  const crowd = (footprint: Footprint): number => crowding(fixedObstacles, marks.courtyards.get(footprint.reference)!);
  const ordered = targets.map(footprint => ({ footprint, crowd: crowd(footprint) }))
    .sort((a, b) => b.crowd - a.crowd || (a.footprint.reference < b.footprint.reference ? -1 : 1)); // crowded parts have the fewest places
  const moves: RefMove[] = [];
  const missing: string[] = [];
  for (const { footprint } of ordered) {
    const reference = footprint.reference;
    const field = fields.find(item => item.reference === reference && item.name === 'Reference');
    if (!field) throw new Error(`silk_marks: ${reference} has no Reference field`);
    const courtyard = marks.courtyards.get(reference)!;
    const window = grow(courtyard, (rules.max_mm ?? 2.5) + 4);
    const local = [...fixedObstacles, ...silk].filter(item => hit(item, window));
    const place = refPlace(reference, courtyard, rules, local, limits, size);
    if (!place) {
      missing.push(reference);
      moves.push({ field, at: null, angle: 0, size });
      continue;
    }
    moves.push({ field, at: place.at, angle: place.angle, size });
    const ink = offset(textBox(reference, { height: size, width: size, thickness: LINE_MM, angle: place.angle }), place.at);
    marks.silk.push(ink);
    silk.push(grow(ink, SILK_GAP));
  }
  marks.lines.push(`  references on ${LAYER}: ${moves.length - missing.length}${missing.length ? `; no free place (left on F.Fab): ${missing.join(', ')}` : ''}`);
  return moves;
}

/** A reference field at its new place, or back on F.Fab with no place. */
export function refFieldText({ field, at, angle, size }: RefMove): string {
  const local = toFootprint(at ?? field.at, field.footprint);
  const layer = at ? LAYER : 'F.Fab';
  return `(property "Reference" ${quoted(field.text)}\n\t\t\t(at ${mmText(local[0])} ${mmText(local[1])} ${at ? angle : field.style.angle ?? 0})\n\t\t\t(layer ${quoted(layer)})\n`
    + `\t\t\t(uuid ${quoted(field.uuid)})\n\t\t\t(effects\n\t\t\t\t(font\n\t\t\t\t\t(size ${mmText(size)} ${mmText(size)})\n\t\t\t\t\t(thickness ${mmText(LINE_MM)})\n\t\t\t\t)\n\t\t\t)\n\t\t)`;
}

export interface MarksResult { text: string; items: number; lines: string[] }

/** The board text with the marks of the spec in group "silk-marks". */
export function silkMarks(board: Board, text: string, spec: MarksSpec, name: string): MarksResult {
  const edit = new BoardEdit(text);
  for (const old of edit.groups().filter(group => group.name === GROUP)) edit.removeGroup(old);
  const silk = readSilk(text);
  const marks = new Marks(board, silk, spec.no_silk ?? []);
  const texts: AddText[] = [];
  for (const mark of spec.texts ?? []) placeMark(marks, texts, name, mark);
  const pieces = spec.barrier ? placeBarrier(marks, texts, spec.barrier, name) : [];
  const moves = spec.refs ? placeRefs(marks, spec.refs, silk.footprintTexts) : [];
  for (const move of moves) edit.replace(move.field.uuid, refFieldText(move));
  const next = itemIds(text, 'silk-marks');
  const members: string[] = [];
  for (const { start, end } of pieces) {
    const uuid = next();
    edit.add(lineText({ start, end, layer: LAYER, width: LINE_MM, dashed: true, uuid }));
    members.push(uuid);
  }
  for (const { text: label, at, size, angle } of texts) {
    const uuid = next();
    edit.add(textText({ text: label, at, layer: LAYER, size, thickness: penOf(size), angle, uuid }));
    members.push(uuid);
  }
  if (members.length) edit.addGroup(GROUP, members, next());
  return { text: edit.text(), items: members.length, lines: marks.lines };
}

/** The folder of a board in the project, and its board file from gate.json. */
export function boardFiles(name: string, root = projectRoot()): { folder: string; pcb: string } {
  const folder = join(root, 'hardware-design', 'boards', name);
  return { folder, pcb: join(folder, `${readJson<{ project: string }>(join(folder, 'gate.json')).project}.kicad_pcb`) };
}

function main(argv: string[]): number {
  const { values, positionals } = parseFlags(argv, { 'dry-run': { type: 'boolean' }, pcb: { type: 'string' } }, USAGE);
  const [name] = positionals;
  if (positionals.length !== 1 || name === undefined) throw new UsageError(USAGE);
  const files = boardFiles(name);
  const pcb = values.pcb ?? files.pcb;
  if (!existsSync(pcb)) throw new Error(`no board ${pcb}`);
  const done = silkMarks(boardJson(pcb).board, readFileSync(pcb, 'utf8'), readJson<MarksSpec>(join(files.folder, 'silk-marks.json')), name);
  for (const line of done.lines) console.log(line);
  if (values['dry-run']) {
    console.log(`silk_marks ${name}: dry run, ${done.items} items`);
    return 0;
  }
  saveBoardInPlace(pcb, done.text);
  console.log(`silk_marks ${name}: ${done.items} items in group "${GROUP}"`);
  return 0;
}

runMain(import.meta.url, main);
