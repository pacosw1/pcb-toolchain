// Via holes inside SMD pads (via-in-pad): solder flows into an open via. pcbtool viapads.
import { padCollidesCircle } from './board-hit.ts';
import { toMm, vias, type Board, type Pad, type Via } from './board-types.ts';
import { fixed } from './py-compat.mjs';
import { hypot } from './py-math.ts';

/** A round pad and the sides of an oval one are a rectangle with full corners. */
function cornerRadius(pad: Pad): number {
  const [width, height] = [toMm(pad.size.x), toMm(pad.size.y)];
  if (pad.shape === 'Rect') return 0;
  if (pad.shape !== 'RoundRect') return Math.min(width, height) / 2;
  // GetRoundRectCornerRadius is in the document as the copper of the pad: its rounded sides, or one circle when nearly round.
  for (const piece of pad.copper) {
    if ('Segment' in piece) return toMm(piece.Segment.width) / 2;
    if ('Circle' in piece) return toMm(piece.Circle.radius);
  }
  return 0;
}

export interface Hole { x: number; y: number; r: number }
export interface PadBox { cx: number; cy: number; width: number; height: number; degrees: number; corner: number }

/** Does a via hole touch a pad? All in mm. */
export function holeInPad(hole: Hole, pad: PadBox): boolean {
  const t = pad.degrees * Math.PI / 180;
  const [dx, dy] = [hole.x - pad.cx, hole.y - pad.cy];
  const u = dx * Math.cos(t) + dy * Math.sin(t);
  const v = -dx * Math.sin(t) + dy * Math.cos(t);
  const corner = Math.min(pad.corner, pad.width / 2, pad.height / 2);
  return hypot(Math.max(Math.abs(u) - (pad.width / 2 - corner), 0), Math.max(Math.abs(v) - (pad.height / 2 - corner), 0)) - corner < hole.r;
}

function viaInPad(via: Via, pad: Pad): boolean {
  if (pad.shape === 'Custom' || pad.shape === 'Other') {
    return padCollidesCircle(pad, pad.layers.includes('F.Cu') ? 'F.Cu' : 'B.Cu', via.at, Math.trunc(via.drill / 2));
  }
  return holeInPad({ x: toMm(via.at.x), y: toMm(via.at.y), r: toMm(via.drill) / 2 }, {
    cx: toMm(pad.position.x), cy: toMm(pad.position.y), width: toMm(pad.size.x), height: toMm(pad.size.y), degrees: -pad.orientation, corner: cornerRadius(pad),
  });
}

/** One line per via in a numbered SMD pad; a pad with no number is a paste or mask opening. */
export function viaPadHits(board: Board): string[] {
  const pads = board.footprints.flatMap(footprint => footprint.pads.filter(pad => pad.kind === 'Smd' && pad.number).map(pad => ({ reference: footprint.reference, pad })));
  return vias(board).flatMap(via => pads.filter(({ pad }) => viaInPad(via, pad)).map(({ reference, pad }) =>
    `${reference}.${pad.number} ${pad.net} via at (${fixed(toMm(via.at.x), 3)}, ${fixed(toMm(via.at.y), 3)})`));
}

const padOf = (hit: string): string => hit.split(/\s+/)[0]!;

/** Removes hits on allowed pads (REF.PAD). An allow entry that matches no hit is stale, and an error. */
export function dropAllowed(hits: string[], allow: string[]): string[] {
  const stale = allow.filter(entry => !hits.some(hit => padOf(hit) === entry));
  if (stale.length) throw new StaleAllowance(`allowed pad has no via in it: ${stale.join(', ')}`);
  return hits.filter(hit => !allow.includes(padOf(hit)));
}

export class StaleAllowance extends Error {}

const textOrder = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/** The report of pcbtool viapads, and its exit code. `filled`: filled + capped via-in-pad (JLC POFV, free on 6+ layers; user 2026-10-29). */
export function viaPadReport(board: Board, allow: string[], filled: boolean, print: (line: string) => void): number {
  let hits: string[];
  try {
    hits = dropAllowed(viaPadHits(board), allow);
  } catch (error) {
    if (!(error instanceof StaleAllowance)) throw error;
    print(`FAIL ${error.message}`);
    return 2;
  }
  if (filled) {
    const layers = board.copper_layers.length;
    if (layers < 6) {
      print(`FAIL --filled needs a 6+ layer board (JLC POFV), board has ${layers} layers`);
      return 2;
    }
    for (const hit of [...hits].sort(textOrder)) print(`INFO filled via in pad ${hit}`);
    print(`0 vias in SMD pads (${hits.length} filled + capped via-in-pad, fab note POFV)`);
    return 0;
  }
  for (const hit of [...hits].sort(textOrder)) print(`FAIL via in pad ${hit}`);
  print(`${hits.length} vias in SMD pads`);
  return hits.length ? 1 : 0;
}
