// Checks of one assembled part against JLC's EasyEDA data for its LCSC part. The program is tools/easyeda_audit.ts.
import { rotated } from './board-hit.ts';
import { toMm, type Footprint } from './board-types.ts';
import { fixed, pyRepr, pyStr, sorted } from './py-compat.mjs';
import { hypot } from './py-math.ts';
import { round } from './py-numbers.ts';
import { atom, kids, one, parse, type SList } from './sexpr.ts';

const EASYEDA_UNIT_MM = 0.254;   // 10 mil
const FRAME_TOLERANCE_MM = 0.05;
const QUARTER_TURNS = [0, 90, 180, 270];
/** The score of a rotation that does not fit at all, in the report of the best one. */
const NO_FIT_MM = 99;
const SHOWN_DIFFS = 8;

export type Xy = readonly [x: number, y: number];
/** Pad number to the places of its pads, in mm about the footprint origin. */
export type PadPlaces = Map<string, Xy[]>;
/** Pin number to pin name. */
export type PinNames = Map<string, string>;
export interface Verdict { status: string; note: string }

/** The `result` of an easyeda-bridge-source.json, as far as this audit reads it. */
export interface EasyedaPart {
  dataStr: { shape?: string[] };
  packageDetail: { dataStr: { head: { x: string | number; y: string | number }; shape: string[] } };
  subparts?: { dataStr?: { shape?: string[] } }[] | null;
}

/** The pads of the EasyEDA footprint. EasyEDA's y is down, as KiCad's. */
export function easyedaPads(part: EasyedaPart): PadPlaces {
  const { head, shape } = part.packageDetail.dataStr;
  const [originX, originY] = [Number(head.x), Number(head.y)];
  const pads: PadPlaces = new Map();
  for (const item of shape.filter(s => s.startsWith('PAD~'))) {
    const fields = item.split('~');
    const place: Xy = [(Number(fields[2]) - originX) * EASYEDA_UNIT_MM, (Number(fields[3]) - originY) * EASYEDA_UNIT_MM];
    pads.set(fields[8]!, [...(pads.get(fields[8]!) ?? []), place]);
  }
  return pads;
}

/**
 * The pins of the EasyEDA symbol, all sub-parts. A pin is P~show~electric~spice_no~x~y~rot~id^^dot^^path^^name segment^^number
 * segment^^...: the number is the text of the number segment, because the spice number can differ (43 for pin 4).
 */
export function easyedaPins(part: EasyedaPart): PinNames {
  const pins: PinNames = new Map();
  const documents = [part.dataStr, ...(part.subparts ?? []).map(sub => sub.dataStr ?? {})];
  for (const shape of documents.flatMap(document => document.shape ?? []).filter(s => s.startsWith('P~'))) {
    const segments = shape.split('^^');
    const name = segments[3]?.split('~') ?? [];
    const number = segments[4]?.split('~') ?? [];
    pins.set(number[4] || segments[0]!.split('~')[3]!, name[4] ?? '');
  }
  return pins;
}

/** BOARD_ITEM::GetFPRelativePosition of the numbered pads: the frame at rotation 0. */
export function footprintPads(footprint: Footprint): PadPlaces {
  const pads: PadPlaces = new Map();
  for (const pad of footprint.pads.filter(p => p.number)) {
    const offset = { x: pad.position.x - footprint.position.x, y: pad.position.y - footprint.position.y };
    const { x, y } = rotated(offset, -footprint.orientation);
    pads.set(pad.number, [...(pads.get(pad.number) ?? []), [toMm(x), toMm(y)]]);
  }
  return pads;
}

/** KiCad: positive rotation is counter-clockwise on screen with y down. */
function turned([x, y]: Xy, degrees: number): Xy {
  const a = degrees * Math.PI / 180;
  return [x * Math.cos(a) + y * Math.sin(a), -x * Math.sin(a) + y * Math.cos(a)];
}

const sameNumbers = (a: PadPlaces, b: PadPlaces): boolean => a.size === b.size && [...a.keys()].every(number => b.has(number));
const byPlace = (a: Xy, b: Xy): number => a[0] - b[0] || a[1] - b[1];
const rounded = ([x, y]: Xy): Xy => [round(x, 3), round(y, 3)];

/**
 * The largest distance between same-number pads after turning the EasyEDA pads and moving them. The board may have more pads of
 * one number (thermal vias in an exposed pad): each EasyEDA pad must still land on a board pad of its number.
 */
function worstFit(easyeda: PadPlaces, board: PadPlaces, degrees: number, shift: Xy = [0, 0]): number | null {
  if (!sameNumbers(easyeda, board) || [...easyeda].some(([number, places]) => places.length > board.get(number)!.length)) return null;
  let worst = 0;
  for (const [number, places] of easyeda) {
    const wanted = places.map(place => turned(place, degrees)).map(([x, y]) => rounded([x + shift[0], y + shift[1]])).sort(byPlace);
    const left = board.get(number)!.map(rounded).sort(byPlace);
    for (const place of wanted) {
      const distances = left.map(other => hypot(place[0] - other[0], place[1] - other[1]));
      const nearest = Math.min(...distances);
      worst = Math.max(worst, nearest);
      left.splice(distances.indexOf(nearest), 1);
    }
  }
  return worst;
}

const fits = (worst: number | null): worst is number => worst !== null && worst <= FRAME_TOLERANCE_MM;

function extraPads(easyeda: PadPlaces, board: PadPlaces): Map<string, number> {
  const extra = new Map<string, number>();
  for (const [number, places] of easyeda) {
    const more = board.get(number)!.length - places.length;
    if (more > 0) extra.set(number, more);
  }
  return extra;
}

/** Same shape about another origin? */
function movedOrigin(easyeda: PadPlaces, board: PadPlaces): Verdict | null {
  const first = (sorted(easyeda.keys()) as string[])[0]!;
  for (const degrees of QUARTER_TURNS) {
    const from = turned(easyeda.get(first)![0]!, degrees);
    const to = board.get(first)![0]!;
    const shift: Xy = [to[0] - from[0], to[1] - from[1]];
    if (fits(worstFit(easyeda, board, degrees, shift))) {
      return { status: 'OFFSET', note: `rot ${degrees}, origin moved by (${fixed(shift[0], 3)}, ${fixed(shift[1], 3)}) mm` };
    }
  }
  return null;
}

/** Does the board footprint stand in the EasyEDA frame? `easyeda` is null with no source. */
export function frameVerdict(easyeda: PadPlaces | null, board: PadPlaces): Verdict {
  if (!easyeda || easyeda.size === 0) return { status: 'NO_SOURCE', note: '' };
  if (!sameNumbers(easyeda, board)) {
    return { status: 'NUMBERING', note: `pad numbers board ${pyRepr(sorted(board.keys()))} EasyEDA ${pyRepr(sorted(easyeda.keys()))}` };
  }
  for (const degrees of QUARTER_TURNS) {
    const worst = worstFit(easyeda, board, degrees);
    if (!fits(worst)) continue;
    const extra = extraPads(easyeda, board);
    const note = `max ${fixed(worst, 3)} mm${extra.size ? `; extra board pads (thermal vias) ${pyRepr(extra)}` : ''}`;
    return degrees === 0 ? { status: 'FRAME_OK', note } : { status: 'ROTATED', note: `${degrees} deg (${note})` };
  }
  const moved = movedOrigin(easyeda, board);
  if (moved) return moved;
  const scores = QUARTER_TURNS.map(degrees => ({ degrees, worst: worstFit(easyeda, board, degrees) || NO_FIT_MM }));
  const best = scores.reduce((a, b) => (b.worst < a.worst ? b : a));
  return { status: 'NUMBERING', note: `pads do not line up: best rot ${best.degrees} max ${fixed(best.worst, 3)} mm` };
}

const normal = (name: string | undefined): string => (name ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '');
const hasRealName = (pins: PinNames): boolean => [...pins].some(([number, name]) => normal(name) && normal(name) !== normal(number));
const byNormalName = (pins: PinNames): Map<string, string> => new Map([...pins].map(([number, name]) => [normal(name), number]));
const byLengthThenText = (a: string, b: string): number => [...a].length - [...b].length || (a < b ? -1 : a > b ? 1 : 0);

function swappedPair(ours: PinNames, theirs: PinNames): Verdict | null {
  const [on, tn] = [byNormalName(ours), byNormalName(theirs)];
  for (const [a, b] of [['K', 'A'], ['CATHODE', 'ANODE'], ['C', 'A']] as const) {
    if (on.has(a) && on.has(b) && tn.has(a) && tn.has(b) && on.get(a) === tn.get(b) && on.get(b) === tn.get(a)) {
      return { status: 'NAME_SWAP', note: `${a}/${b} swapped: board ${a}=pin ${on.get(a)}, EasyEDA ${a}=pin ${tn.get(a)}` };
    }
  }
  return null;
}

/** The pin names of the schematic symbol against the EasyEDA symbol. */
export function pinVerdict(ours: PinNames, theirs: PinNames): Verdict {
  if (ours.size === 0 || theirs.size === 0) return { status: 'PINS_SKIP', note: 'no pin list' };
  if (ours.size <= 2 && (!hasRealName(ours) || !hasRealName(theirs))) return { status: 'PINS_SKIP', note: 'two-pin part without pin names' };
  const numbers = [...new Set([...ours.keys(), ...theirs.keys()])].sort(byLengthThenText);
  const different = numbers.filter(number => normal(ours.get(number)) !== normal(theirs.get(number)));
  if (different.length === 0) return { status: 'PINS_OK', note: '' };
  const swap = swappedPair(ours, theirs);
  if (swap) return swap;
  const shown = different.slice(0, SHOWN_DIFFS).map(number => `pin ${number}: board "${pyStr(ours.get(number))}" EasyEDA "${pyStr(theirs.get(number))}"`);
  return { status: 'NAME_DIFF', note: shown.join('; ') + (different.length > SHOWN_DIFFS ? ` (+${different.length - SHOWN_DIFFS})` : '') };
}

export interface SchematicPart { pins: PinNames; symbol: string }

/** The symbol and pin names of each reference, from a kicad-cli kicadsexpr netlist. */
export function schematicParts(netlist: string): Map<string, SchematicPart> {
  const root = parse(netlist);
  const section = (name: string): SList => one(root, name) ?? [];
  const key = (node: SList): string => `${atom(one(node, 'lib') ?? [], 1)}\0${atom(one(node, 'part') ?? [], 1)}`;
  const libraries = new Map(kids(section('libparts'), 'libpart').map(part => [key(part),
    new Map(kids(one(part, 'pins') ?? [], 'pin').map(pin => [atom(one(pin, 'num') ?? [], 1), atom(one(pin, 'name') ?? [], 1)]))]));
  return new Map(kids(section('components'), 'comp').map(comp => {
    const source = one(comp, 'libsource') ?? [];
    const symbol = `${atom(one(source, 'lib') ?? [], 1)}:${atom(one(source, 'part') ?? [], 1)}`;
    return [atom(one(comp, 'ref') ?? [], 1), { pins: libraries.get(key(source)) ?? new Map(), symbol }];
  }));
}
