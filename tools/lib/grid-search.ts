// The A* of pcbtool suggest on a node grid, and how its node path becomes the waypoints of a connect line. Nothing here reads a
// board. A node is row * cols + col; a layer is its index in the search.
import { MinHeap } from './min-heap.ts';
import { fixed } from './py-compat.mjs';
import { dist } from './py-math.ts';
import { OTHER_SIDE, type Xy } from './route-spec.ts';

const MOVES: readonly (readonly [number, number])[] = [[1, 0], [1, 1], [0, 1], [-1, 1], [-1, 0], [-1, -1], [0, -1], [1, -1]];
/** Mm-equivalent cost of a 45 and a 90 degree turn; sharper turns are not allowed. */
const BEND_COST = [0, 0.05, 0.2];
/** No direction yet: a start, or the node after a via. */
const NO_DIRECTION = 8;
const DIRECTIONS = 9;

export interface SearchGrid {
  cols: number; rows: number; cell: number;
  /** Per layer, 1 where a track centre may be. */
  free: Uint8Array[];
  /** 1 where a via may be. */
  viaOk: Uint8Array;
  /** Per layer, extra cost per mm. */
  extra: Float64Array[];
  /** Mm of track that one via costs. */
  viaCost: number;
}

/** A node on a layer. */
export type PathNode = [node: number, layer: number];
/** Start or goal states with their added cost, in order: the exact leg to the pad centre. */
export type EndCosts = Map<number, number>;

export const stateOf = (node: number, layer: number, layers: number): number => node * layers + layer;

export type Search = { path: PathNode[]; cost: number } | { path: null; reached: Set<number>; masks: Map<number, number> };

interface Entry { f: number; g: number; order: number; state: number }
const before = (a: Entry, b: Entry): boolean => a.f < b.f || (a.f === b.f && (a.g < b.g || (a.g === b.g && a.order < b.order)));

/**
 * The cheapest node path, 8 moves per layer and vias between layers. Cost: length x (1 + extra), a bend cost per turn, viaCost per
 * via. No via on a start node or right after a via. No path: the nodes reached, and the layers each was reached on, as a bit mask.
 */
export function astar(grid: SearchGrid, starts: EndCosts, goals: EndCosts, goal: number): Search {
  const { cols, rows, cell, free, viaOk, extra, viaCost } = grid;
  const layers = free.length;
  const [goalCol, goalRow] = [goal % cols, Math.floor(goal / cols)];
  const diagonal = Math.sqrt(2);
  const octile = (i: number): number => {
    const dx = Math.abs(i % cols - goalCol);
    const dy = Math.abs(Math.floor(i / cols) - goalRow);
    return cell * (Math.max(dx, dy) + (diagonal - 1) * Math.min(dx, dy));
  };
  const slack = Math.max(...[...goals.keys()].map(state => octile(Math.floor(state / layers))));
  const heuristic = (i: number): number => Math.max(0, octile(i) - slack);
  // A state is (node, layer, direction) as one number; an end state is below zero.
  const stateId = (node: number, layer: number, direction: number): number => (node * layers + layer) * DIRECTIONS + direction;
  const best = new Map<number, number>();
  const previous = new Map<number, number>();
  const heap = new MinHeap<Entry>(before);
  let order = 0;
  const push = (state: number, f: number, g: number): void => { heap.push({ f, g, order, state }); order += 1; };
  for (const [start, cost] of starts) {
    const state = stateId(Math.floor(start / layers), start % layers, NO_DIRECTION);
    best.set(state, cost);
    push(state, cost + heuristic(Math.floor(start / layers)), cost);
  }
  const reached = new Set<number>();
  while (heap.size) {
    const { g, state } = heap.pop()!;
    if (g > (best.get(state) ?? Infinity)) continue;
    if (state < 0) return { path: walkBack(previous, previous.get(state)!, layers), cost: g };
    const direction = state % DIRECTIONS;
    const place = (state - direction) / DIRECTIONS;
    const [layer, node] = [place % layers, Math.floor(place / layers)];
    reached.add(node);
    const finish = goals.get(place);
    if (finish !== undefined) {
      const end = -1 - place;
      if (g + finish < (best.get(end) ?? Infinity) - 1e-12) {
        best.set(end, g + finish);
        previous.set(end, state);
        push(end, g + finish, g + finish);
      }
    }
    const relax = (next: number, cost: number, estimate: number): void => {
      if (cost < (best.get(next) ?? Infinity) - 1e-12) {
        best.set(next, cost);
        previous.set(next, state);
        push(next, cost + estimate, cost);
      }
    };
    const [col, row] = [node % cols, Math.floor(node / cols)];
    const [here, open] = [extra[layer]!, free[layer]!];
    for (let move = 0; move < MOVES.length; move++) {
      const [dc, dr] = MOVES[move]!;
      const turn = direction === NO_DIRECTION ? 0 : Math.min(Math.abs(move - direction), 8 - Math.abs(move - direction));
      if (turn > 2 || col + dc < 0 || col + dc >= cols || row + dr < 0 || row + dr >= rows) continue;
      const to = node + dr * cols + dc;
      if (!open[to]) continue;
      const step = cell * (dc && dr ? diagonal : 1);
      relax(stateId(to, layer, move), g + step * (1 + (here[node]! + here[to]!) / 2) + BEND_COST[turn]!, heuristic(to));
    }
    if (direction !== NO_DIRECTION && viaOk[node]) {
      for (let other = 0; other < layers; other++) {
        if (other !== layer && free[other]![node]) relax(stateId(node, other, NO_DIRECTION), g + viaCost, heuristic(node));
      }
    }
  }
  return { path: null, reached, masks: reachedLayers(best, reached, layers) };
}

function walkBack(previous: ReadonlyMap<number, number>, last: number, layers: number): PathNode[] {
  const node = (state: number): PathNode => {
    const place = Math.floor(state / DIRECTIONS);
    return [Math.floor(place / layers), place % layers];
  };
  const path = [node(last)];
  for (let state = last; previous.has(state);) {
    state = previous.get(state)!;
    const [at, layer] = node(state);
    const end = path.at(-1)!;
    if (at !== end[0] || layer !== end[1]) path.push([at, layer]);
  }
  return path.reverse();
}

/** The layers each reached node was reached on: a point under an SMD pad has not reached the pad. */
function reachedLayers(best: ReadonlyMap<number, number>, reached: ReadonlySet<number>, layers: number): Map<number, number> {
  const masks = new Map<number, number>();
  for (const state of best.keys()) {
    if (state < 0) continue;
    const place = Math.floor(state / DIRECTIONS);
    const node = Math.floor(place / layers);
    if (reached.has(node)) masks.set(node, (masks.get(node) ?? 0) | (1 << (place % layers)));
  }
  return masks;
}

export interface Reach { node: number; point: Xy; distanceMm: number; layers: string[]; viaAllowed: boolean }

/** How near a failed search came to the target: anywhere, and on a layer of the target. */
export function closestReach(masks: ReadonlyMap<number, number>, xy: (node: number) => Xy, target: Xy, targetLayers: ReadonlySet<number>, layers: string[], viaOk: Uint8Array): { closest: Reach | null; onTargetLayer: Reach | null } {
  const distance = (node: number): number => dist(xy(node), target);
  const nearest = (nodes: number[]): number | null => (nodes.length ? nodes.reduce((a, b) => (distance(b) < distance(a) || (distance(b) === distance(a) && b < a) ? b : a)) : null);
  const row = (node: number | null): Reach | null => (node === null ? null : {
    node, point: xy(node), distanceMm: distance(node), layers: layers.filter((_, i) => masks.get(node)! & (1 << i)), viaAllowed: Boolean(viaOk[node]),
  });
  const onLayer = [...masks].filter(([, mask]) => [...targetLayers].some(layer => mask & (1 << layer))).map(([node]) => node);
  return { closest: row(nearest([...masks.keys()])), onTargetLayer: row(nearest(onLayer)) };
}

export interface Corner { kind: 'through' | 'via'; node: number }

/** The waypoints of a node path: a through at each turn, a via at each layer change. The two ends are not included. */
export function nodeCorners(path: PathNode[], cols: number): Corner[] {
  const out: Corner[] = [];
  for (let k = 1; k + 1 < path.length; k++) {
    const [[i0, l0], [i1, l1], [i2]] = [path[k - 1]!, path[k]!, path[k + 1]!];
    const delta = (from: number, to: number): [number, number] => [to % cols - from % cols, Math.floor(to / cols) - Math.floor(from / cols)];
    const [a, b] = [delta(i0, i1), delta(i1, i2)];
    if (i1 === i2) out.push({ kind: 'via', node: i1 });
    else if (l0 === l1 && (a[0] !== b[0] || a[1] !== b[1])) out.push({ kind: 'through', node: i1 });
  }
  return out;
}

/** The layer after each via of a node path, in path order. */
export const viaLayers = (path: PathNode[]): number[] => path.slice(1).flatMap(([node, layer], k) => (path[k]![0] === node ? [layer] : []));

export interface LinePoint { kind: 'end' | 'through' | 'via'; at: Xy; to?: string }

/** From pad centre to pad centre: the end nodes of the path as through when they are off the centre and not the corner next to them. */
export function pathPoints(start: Xy, end: Xy, first: Xy, corners: LinePoint[], last: Xy): LinePoint[] {
  const points: LinePoint[] = [{ kind: 'end', at: start }, ...(dist(first, start) > 1e-6 ? [{ kind: 'through' as const, at: first }] : []), ...corners];
  if (dist(last, end) > 1e-6 && dist(last, points.at(-1)!.at) > 1e-6) points.push({ kind: 'through', at: last });
  return [...points, { kind: 'end', at: end }];
}

/** Removes through points while `ok` says the direct leg a -> c may replace a -> b -> c. A direct 0/45/90 leg is never longer. */
export function dropJogs(given: LinePoint[], layer: string, ok: (a: Xy, b: Xy, c: Xy, layer: string) => boolean): LinePoint[] {
  const points = [...given];
  for (let k = 1; k < points.length - 1;) {
    const on = points.slice(1, k).reduce((current, point) => (point.kind === 'via' ? point.to ?? OTHER_SIDE[current]! : current), layer);
    if (points[k]!.kind === 'through' && ok(points[k - 1]!.at, points[k]!.at, points[k + 1]!.at, on)) {
      points.splice(k, 1);
      k = Math.max(1, k - 1);
    } else {
      k += 1;
    }
  }
  return points;
}

/** Millimetres as a connect line writes them: six places, no trailing zeros. */
export const mmWord = (mm: number): string => fixed(mm, 6).replace(/0+$/, '').replace(/\.$/, '');

/** The connect words of a via from layer `from` to `to`: @to only when it is not F.Cu <-> B.Cu. */
export const viaWords = ([x, y]: Xy, from: string, to: string): string => ` via ${mmWord(x)},${mmWord(y)}${OTHER_SIDE[from] === to ? '' : `@${to}`}`;
