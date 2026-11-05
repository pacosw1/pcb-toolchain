// The problem model of compaction: halos as hard spacing, the area each unit needs and the virtual board scale.
//
// halo(unit) = s * pitch * sqrt(fan-out), fan-out = nets that connect the unit to other units (power and ground nets are
// not in the problem: they go to planes). Same form as KiCadRoutingTools placement/quench.py (base + coef * sqrt(pins)),
// with the track + clearance pitch as coefficient.
//
// A problem read with readTyped keeps Python's number types: an int is a number, a float a Float. A hash of a problem, a
// pose or a prob.json then has the bytes Python wrote. So a value of a problem is a Num, and a computed float goes back
// in as a Float.
import { Float, number, PyError, truthy } from '../lib/py-compat.mjs';
import { pyMod } from '../lib/py-math.ts';

export type Num = number | Float;
/** x0, y0, x1, y1, spacing. */
export type Rect = Num[];
/** One x, y, turn per unit. */
export type Pose = Num[][];

export interface Unit {
  name: string; fixed: boolean; x: Num; y: Num; rects: Rect[];
  refs?: string[]; box?: Num[] | null; in_box?: Num[] | null;
  [key: string]: unknown;
}
export interface Net { name: string; pins: Num[][]; cohesion?: unknown; [key: string]: unknown }
export interface Board { outline: Num[][]; [key: string]: unknown }
export interface Problem { units: Unit[]; nets: Net[]; board: Board; move_box?: Num[] | null; [key: string]: unknown }

export const HALO = {
  pitch: 0.4,   // mm per escaping track: 0.2 mm track + 0.2 mm clearance (JLC 4-layer standard class)
  fill: 0.5,    // usable fraction of the board area for the grown units (the rest is channels and edge)
};

/** copy.deepcopy of JSON values. structuredClone would turn a Float into a plain object. */
export function deepCopy<T>(value: T): T {
  if (Array.isArray(value)) return value.map(item => deepCopy(item) as unknown) as T;
  if (value === null || typeof value !== 'object' || value instanceof Float) return value;
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, deepCopy(item)])) as T;
}

const total = (values: number[]): number => values.reduce((sum, value) => sum + value, 0);

export const halo = (fanoutCount: number, s: number, pitch = HALO.pitch): number => s * pitch * Math.sqrt(Math.max(fanoutCount, 0));

/** Per unit: the nets that leave it. A virtual group net is not an escaping track. */
export function fanout(pr: Problem): number[] {
  const counts = pr.units.map(() => 0);
  for (const net of pr.nets) {
    if (truthy(net.cohesion)) continue;
    const units = new Set(net.pins.map(pin => number(pin[0])));
    if (units.size > 1) for (const unit of units) counts[unit] += 1;
  }
  return counts;
}

/** Copy of the problem with each rect spacing = max(D-040 spacing, halo of its unit). */
export function withHalos(pr: Problem, s: number, pitch?: number): Problem {
  const q = deepCopy(pr);
  const counts = fanout(pr);
  q.units.forEach((unit, index) => {
    const grown = halo(counts[index], s, pitch);
    for (const rect of unit.rects) if (grown > number(rect[4])) rect[4] = new Float(grown);
  });
  return q;
}

function area(poly: number[][]): number {
  const twice = poly.map((a, index) => {
    const b = poly[(index + 1) % poly.length];
    return a[0] * b[1] - b[0] * a[1];
  });
  return Math.abs(total(twice)) / 2;
}

/** Area a unit takes with its spacing: a block counts its border box once (its parts are inside) plus the part of any
 *  rect beyond the border (a rule area); a single part counts each rect. */
function unitNeed(unit: Unit): number {
  const rects = unit.rects.map(rect => rect.map(number));
  if (!truthy(unit.box)) return total(rects.map(r => (r[2] - r[0] + r[4]) * (r[3] - r[1] + r[4])));
  const [x, y] = [number(unit.x), number(unit.y)];
  const [left, bottom, right, top] = (unit.box as Num[]).map(number);
  const b = [left - x, bottom - y, right - x, top - y];
  const spacing = Math.max(...rects.map(r => r[4]), 0);
  const overlap = (r: number[]) => Math.max(0, Math.min(r[2], b[2]) - Math.max(r[0], b[0])) * Math.max(0, Math.min(r[3], b[3]) - Math.max(r[1], b[1]));
  const beyond = rects.reduce((sum, r) => sum + ((r[2] - r[0]) * (r[3] - r[1]) - overlap(r)), 0);
  return (b[2] - b[0] + spacing) * (b[3] - b[1] + spacing) + beyond;
}

export function rawScale(pr: Problem): number {
  const outline = area(pr.board.outline.map(point => point.map(number)));
  if (!outline) throw new PyError('ZeroDivisionError', 'float division by zero');
  return Math.sqrt(total(pr.units.map(unitNeed)) / HALO.fill / outline);
}

/** Linear scale of the virtual board: 1 when the grown units fit in `fill` of the board area. */
export const boardScale = (pr: Problem): number => Math.max(1, rawScale(pr));

/** Copy of the problem with the outline, move box and unit region boxes (in_box) scaled by k about the outline centre.
 *  A region box at the edge stays at the scaled edge: its size grows by k too. At k 1 the problem itself. */
export function virtual(pr: Problem, k: number): Problem {
  if (k === 1) return pr;
  const q = deepCopy(pr);
  const xs = pr.board.outline.map(point => number(point[0]));
  const ys = pr.board.outline.map(point => number(point[1]));
  const [cx, cy] = [(Math.min(...xs) + Math.max(...xs)) / 2, (Math.min(...ys) + Math.max(...ys)) / 2];
  const scaled = (x: Num, y: Num): Float[] => [new Float(cx + (number(x) - cx) * k), new Float(cy + (number(y) - cy) * k)];
  const scaledBox = (b: Num[]): Float[] => [...scaled(b[0], b[1]), ...scaled(b[2], b[3])];
  q.board.outline = pr.board.outline.map(point => scaled(point[0], point[1]));
  if (truthy(pr.move_box)) q.move_box = scaledBox(pr.move_box as Num[]);
  for (const unit of q.units) if (truthy(unit.in_box)) unit.in_box = scaledBox(unit.in_box as Num[]);
  return q;
}

/** Largest halo scale s <= sHigh whose grown units fit a board of scale k (boardScale <= k); 0 if none. */
export function sFit(pr: Problem, k: number, sHigh: number, iterations = 40): number {
  const fits = (s: number) => rawScale(withHalos(pr, s)) <= k + 1e-9;
  if (fits(sHigh)) return sHigh;
  let [low, high] = [0, sHigh];
  for (let i = 0; i < iterations; i++) {
    const middle = (low + high) / 2;
    if (fits(middle)) low = middle;
    else high = middle;
  }
  return low;
}

/** Board scale below which the parts with no halo cannot fit, even at 100 % fill. */
export const bareScale = (pr: Problem): number => rawScale(withHalos(pr, 0)) * Math.sqrt(HALO.fill);

/** Halo scale for an outline step at board scale k: the largest that fits k (sFit); when no halo fits, s goes down
 *  linearly from the best pass (at best.k) to 0 at the bare-parts floor kFloor. */
export function outlineS(pr: Problem, k: number, best: { s: number; k: number }, kFloor: number): number {
  const s = sFit(pr, k, best.s);
  if (s > 0 || kFloor < 1) return s;
  return best.s * (k - kFloor) / (best.k - kFloor);
}

function rotated(rect: number[], turn: number): number[] {
  const [x0, y0, x1, y1] = rect;
  switch (pyMod(turn, 4)) {
    case 0: return [x0, y0, x1, y1];
    case 1: return [y0, -x1, y1, -x0];
    case 2: return [-x1, -y1, -x0, -y0];
    default: return [-y1, x0, -y0, x1];
  }
}

/** Bounding box of the pins of a net in a pose. */
export function netBox(net: Net, pose: Pose): number[] {
  if (!net.pins.length) throw new PyError('ValueError', 'min() arg is an empty sequence');
  const boxes = net.pins.map(pin => {
    const [x, y, turn] = pose[number(pin[0])].map(number);
    const [x0, y0, x1, y1] = rotated(pin.slice(1, 5).map(number), turn);
    return [x0 + x, y0 + y, x1 + x, y1 + y];
  });
  return [Math.min(...boxes.map(b => b[0])), Math.min(...boxes.map(b => b[1])), Math.max(...boxes.map(b => b[2])), Math.max(...boxes.map(b => b[3]))];
}

/** Sum of the block box areas (mm2) of a pose, problem model: a rigid block unit counts its border box; a soft block
 *  counts the box of its '~block:' cohesion net (the courtyard boxes of its part units). */
export function blockBoxSum(pr: Problem, pose: Pose): number {
  let sum = 0;
  for (const unit of pr.units) {
    if (!truthy(unit.box)) continue;
    const b = (unit.box as Num[]).map(number);
    sum += (b[2] - b[0]) * (b[3] - b[1]);
  }
  for (const net of pr.nets) {
    if (!truthy(net.cohesion) || !net.name.startsWith('~block:')) continue;
    const b = netBox(net, pose);
    sum += (b[2] - b[0]) * (b[3] - b[1]);
  }
  return sum;
}
