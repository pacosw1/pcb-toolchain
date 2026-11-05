// pcbtool suggest: A* path proposals for one unconnected pad pair, as connect lines. It reads the board and writes nothing.
// Blocked for a track centre: other-net copper + clearance + width / 2, the board edge, track keepouts, pours of other nets, and the
// thermal spokes of pads in their own pour (starved_thermal). A pour of the net's own ground domain is not blocked but costs
// POUR_EXTRA per mm, so a path goes round it when it can; a ground pour of another domain blocks: the isolation barrier.
// Blocked for a via: other-net copper on every copper layer, via keepouts, and SMD pads of any net (via-in-pad).
import { existsSync } from 'node:fs';
import { boardRings, copperObstacles, edgeObstacles, mmPoint, netClass, netRules, padShape, type ProjectFile } from './board-obstacles.ts';
import { tracks, toMm, vias, type Board, type Pad, type Zone } from './board-types.ts';
import { dotShape, nearestCopper, polyShape, segmentShape, shapeBox, type Box, type Obstacle, type Obstacles, type Shape } from './copper-gap.ts';
import { astar, closestReach, dropJogs, mmWord, nodeCorners, pathPoints, stateOf, viaLayers, viaWords, type EndCosts, type LinePoint, type PathNode, type SearchGrid } from './grid-search.ts';
import { netPadPairs, type NetPad, type PadPair } from './net-islands.ts';
import { CommandFailure, type Print } from './pcbtool-cli.ts';
import { fixed } from './py-compat.mjs';
import { dist } from './py-math.ts';
import { formatG, round, roundWhole } from './py-numbers.ts';
import { groundSpec, kindsOf, layersError, netDomain, padGrounds, pourRule, readPlanes, referenceObstacles, type MixedKinds, type NetShape, type PlanesSpec } from './reference-planes.ts';
import { markNear, polyNodes, type Grid } from './route-grid.ts';
import { expandRoute, floatPoint, intentRoute, leg, parseIntent, type RouteSegment, type Xy } from './route-spec.ts';
import type { Verdict } from './suggest-verify.ts';
import { thermalSpokes, type PadThermals } from './thermal-spokes.ts';

/** Pad escape: grid nodes this near a pad may end the path with an exact leg. */
const ESCAPE_MM = 2.5;
/** Extra cost per mm in the own-domain ground pour: x3 length. Other pours are blocked. */
const POUR_EXTRA = 2;
/** A step between two free nodes then keeps the full clearance. */
const STEP_MARGIN = 0.71;
/** Copper farther than this from the box cannot reach it. */
const FAR_MM = 5;
const CELL_STEP_MM = 0.05;
const MAX_NODES_LIMIT = 10_000_000;

export interface SuggestOptions {
  net: string; layers: string; planes: string; width: number | null; pads: string[] | null; returnViaR: number | null; probeThermals: boolean;
  maxNodes: number; pair: number | null; box: number[] | null; viaCost: number; k: number; margin: number; cell: number; verify: boolean;
}

export interface SuggestInput {
  board: Board; project: ProjectFile; thermals: PadThermals;
  /** Judges connect lines by DRC, one verdict each. */
  verdicts: (lines: string[]) => Promise<Verdict[]>;
}

/** What a run knows of the net, before any grid. */
interface Rules {
  layers: string[]; spec: PlanesSpec | null; mixed: MixedKinds; grounds: string[]; domain: string | null;
  className: string; width: number; clearance: number; viaSize: number; viaDrill: number;
}

function netRulesOf({ board, project }: SuggestInput, options: SuggestOptions): Rules {
  const { net, planes } = options;
  const layers = options.layers.split(',');
  const spec = existsSync(planes) ? readPlanes(planes) : null;
  const mixed = spec ? kindsOf(net, spec, project) : {};
  const refused = layersError(net, layers, mixed);
  if (refused || new Set(layers).size !== layers.length) throw new CommandFailure(`--layers: ${refused ?? 'no layer or a layer twice'}`);
  const { grounds, domains } = groundSpec(planes);
  const domain = netDomain(net, padGrounds(board, net, grounds), grounds, domains);
  const { className, trackWidth, clearance } = netRules(project, net);
  if (options.width !== null && !(Number.isFinite(options.width) && options.width > 0)) throw new CommandFailure('--width must be a finite positive number');
  const cls = netClass(project, className);
  return { layers, spec, mixed, grounds, domain, className, width: options.width ?? trackWidth, clearance, viaSize: cls.via_diameter, viaDrill: cls.via_drill };
}

/** The pad pairs to choose from: the ratsnest, or the two pads named by --pads. */
function padPairs(board: Board, { net, pads, pair }: SuggestOptions): PadPair[] {
  if (!pads) return netPadPairs(board, net);
  if (pair) throw new CommandFailure('--pads and --pair are alternatives');
  const chosen = pads.map((name): NetPad => {
    const dot = name.lastIndexOf('.');
    const [ref, number] = [name.slice(0, dot), name.slice(dot + 1)];
    const pad = board.footprints.find(footprint => footprint.reference === ref)?.pads.find(item => item.number === number);
    if (!pad || pad.net !== net) throw new CommandFailure(`${name} is not a pad of ${net}`);
    return { key: pad.id, name, at: mmPoint(pad.position), pad };
  });
  return [[chosen[0]!, chosen[1]!]];
}

/** Indexes of `layers` a pad can be reached on: a through pad on all of them. */
function padLayers(pad: Pad, layers: string[]): Set<number> {
  const through = pad.kind === 'ThroughHole' || pad.kind === 'NpThroughHole';
  return new Set(layers.flatMap((layer, i) => (through || pad.layers.includes(layer) ? [i] : [])));
}

function searchBox(a: NetPad, b: NetPad, { box, margin }: SuggestOptions): Box {
  const [p, q] = [a.at, b.at];
  if (!box) return [Math.min(p[0], q[0]) - margin, Math.min(p[1], q[1]) - margin, Math.max(p[0], q[0]) + margin, Math.max(p[1], q[1]) + margin];
  const window: Box = [Math.min(box[0]!, box[2]!), Math.min(box[1]!, box[3]!), Math.max(box[0]!, box[2]!), Math.max(box[1]!, box[3]!)];
  if (![p, q].every(([x, y]) => window[0] <= x && x <= window[2] && window[1] <= y && y <= window[3])) {
    throw new CommandFailure(`--box must hold both pads ${a.name} ${floatPoint(p)} and ${b.name} ${floatPoint(q)}`);
  }
  return window;
}

/** A grid over the box with the start pad centre on a node. The cell grows to stay inside the node budget. */
function nodeGrid(box: Box, start: Xy, cellMm: number, maxNodes: number): Grid {
  if (maxNodes <= 0 || maxNodes > MAX_NODES_LIMIT) throw new CommandFailure(`--max-nodes must be between 1 and ${MAX_NODES_LIMIT}`);
  const need = Math.max(cellMm, Math.sqrt((box[2] - box[0]) * (box[3] - box[1]) / maxNodes));
  const cell = need > cellMm ? round(Math.ceil(need / CELL_STEP_MM - 1e-9) * CELL_STEP_MM, 3) : need;
  const x0 = start[0] - Math.floor((start[0] - box[0]) / cell) * cell;
  const y0 = start[1] - Math.floor((start[1] - box[1]) / cell) * cell;
  return { x0, y0, cell, cols: Math.floor((box[2] - x0) / cell) + 1, rows: Math.floor((box[3] - y0) / cell) + 1 };
}

const zoneRings = (zone: Zone): Xy[][] => [...zone.outline.map(polygon => polygon.outline.map(mmPoint)), ...zone.outline.flatMap(polygon => polygon.holes.map(hole => hole.map(mmPoint)))];

/** All obstacles per copper layer and what keeps a via from the fast tracks on the outer layers. */
function allObstacles(input: SuggestInput, rules: Rules, { net, probeThermals }: SuggestOptions): { obstacles: Obstacles; referenceVias: Obstacle[] } {
  const { board, project, thermals } = input;
  const { clearance, spec, mixed, layers, grounds } = rules;
  const edges = edgeObstacles(board, project);
  const cache = new Map<string, number>();
  const obstacles: Obstacles = Object.fromEntries(board.copper_layers.map(layer => [layer, [...copperObstacles(board, project, net, clearance, layer, cache), ...edges]]));
  if (!probeThermals) {
    for (const [layer, spokes] of Object.entries(thermalSpokes(board, project, net, clearance, cache, thermals))) obstacles[layer]!.push(...spokes);
  }
  const referenceVias: Obstacle[] = [];
  if (!spec) return { obstacles, referenceVias };
  const kinds = new Map<string, MixedKinds>();
  const kindOf = (name: string): MixedKinds => {
    if (!kinds.has(name)) kinds.set(name, kindsOf(name, spec, project));
    return kinds.get(name)!;
  };
  for (const [mixedLayer, kind] of Object.entries(mixed)) {
    const under = Object.keys(spec.adjacent).find(outer => spec.adjacent[outer] === mixedLayer);
    const zones = board.zones.filter(zone => !zone.rule_area && zone.layers.includes(mixedLayer) && grounds.includes(zone.net));
    if (under === undefined || !zones.length) continue;
    const fill = Math.max(clearance, ...zones.map(zone => toMm(zone.fill?.clearance ?? 0)));
    const fast: NetShape[] = [];
    const onMixed: NetShape[] = [];
    for (const track of tracks(board).filter(item => item.net)) {
      const shape = segmentShape(mmPoint(track.start), mmPoint(track.end), toMm(track.width) / 2);
      if (track.layer === under && kindOf(track.net)[mixedLayer] === 'fast') fast.push({ net: track.net, shape });
      else if (track.layer === mixedLayer) onMixed.push({ net: track.net, shape });
    }
    for (const [layer, found] of Object.entries(referenceObstacles(net, kind, layers, mixedLayer, under, fast, onMixed, fill))) obstacles[layer]!.push(...found);
    referenceVias.push(...fast.filter(item => item.net !== net).map(item => ({ shape: item.shape, clearance: fill, label: `fast ref ${under} ${item.net}` })));
  }
  return { obstacles, referenceVias };
}

/** The node maps of one search, and the labels that say what blocks a node. */
class NodeMaps {
  readonly grid: Grid;
  readonly count: number;
  readonly inside: Uint8Array;
  readonly free: Uint8Array[] = [];
  readonly blockedBy: Int32Array[] = [];
  readonly extra: Float64Array[] = [];
  readonly viaOk: Uint8Array;
  readonly viaBlockedBy: Int32Array;
  readonly labels: string[] = [];

  constructor(grid: Grid, board: Board) {
    this.grid = grid;
    this.count = grid.cols * grid.rows;
    this.inside = new Uint8Array(this.count);
    for (const node of polyNodes(grid, boardRings(board))) this.inside[node] = 1;
    this.viaOk = this.inside.slice();
    this.viaBlockedBy = new Int32Array(this.count).fill(-1);
  }

  label(text: string): number {
    this.labels.push(text);
    return this.labels.length - 1;
  }

  /** The label of a node, or null. */
  labelAt(blocked: Int32Array, node: number): string | null {
    const at = blocked[node]!;
    return at >= 0 ? this.labels[at]! : null;
  }
}

function layerMaps(maps: NodeMaps, board: Board, rules: Rules, net: string, obstacles: Obstacles, near: (shape: Shape) => boolean, margin: number): void {
  for (const layer of rules.layers) {
    const free = maps.inside.slice();
    const blocked = new Int32Array(maps.count).fill(-1);
    const extra = new Float64Array(maps.count);
    for (const { shape, clearance, label } of obstacles[layer]!) {
      if (near(shape)) markNear(maps.grid, shape, clearance + rules.width / 2 + margin, free, blocked, maps.label(label));
    }
    for (const zone of board.zones) {
      if (zone.rule_area || !zone.layers.includes(layer) || zone.net === net) continue;
      const cost = pourRule(zone.net, rules.domain) === 'cost';
      const label = maps.label(`pour ${zone.net || '(no net)'}`);
      for (const node of polyNodes(maps.grid, zoneRings(zone))) {
        if (cost) extra[node] = POUR_EXTRA;
        else if (free[node]) { free[node] = 0; blocked[node] = label; }
      }
    }
    maps.free.push(free);
    maps.blockedBy.push(blocked);
    maps.extra.push(extra);
  }
}

function viaMaps(maps: NodeMaps, board: Board, rules: Rules, options: SuggestOptions, obstacles: Obstacles, referenceVias: Obstacle[], near: (shape: Shape) => boolean, margin: number): void {
  const { grid, viaOk, viaBlockedBy } = maps;
  const block = (shape: Shape, keep: number, label: string): void => markNear(grid, shape, keep, viaOk, viaBlockedBy, maps.label(label));
  // A via sits on a node: no inflation.
  for (const { shape, clearance, label } of [...Object.values(obstacles).flat(), ...referenceVias]) {
    if (near(shape)) block(shape, clearance + rules.viaSize / 2, label);
  }
  for (const zone of board.zones.filter(item => item.rule_area?.vias && item.outline[0])) {
    block(polyShape(zone.outline[0]!.outline.map(mmPoint)), margin, 'via keepout');
  }
  for (const footprint of board.footprints) {
    for (const pad of footprint.pads.filter(item => item.kind === 'Smd')) {
      const shape = padShape(pad, pad.layers.includes('F.Cu') ? 'F.Cu' : 'B.Cu');
      if (near(shape)) block(shape, rules.viaDrill / 2, `via-in-pad ${footprint.reference}.${pad.number}`);
    }
  }
  const radius = options.returnViaR;
  if (radius === null) return;
  if (!(Number.isFinite(radius) && radius > 0)) throw new CommandFailure('--return-via-r must be a finite positive number');
  const far = new Uint8Array(maps.count).fill(1);
  const unused = new Int32Array(maps.count);
  for (const via of vias(board).filter(item => item.net === rules.domain)) markNear(grid, dotShape(mmPoint(via.at), 0), radius, far, unused, 0);
  const label = maps.label(`no ${rules.domain ?? 'None'} return via within ${formatG(radius)} mm`);
  for (let node = 0; node < maps.count; node++) {
    if (viaOk[node] && far[node]) { viaOk[node] = 0; viaBlockedBy[node] = label; }
  }
}

/** Geometry of candidate legs on the grid. */
class Legs {
  readonly #grid: Grid;
  readonly #maps: NodeMaps;
  readonly #rules: Rules;
  readonly #obstacles: Obstacles;
  readonly #pours: Float64Array[];

  constructor(maps: NodeMaps, rules: Rules, obstacles: Obstacles) {
    this.#grid = maps.grid;
    this.#maps = maps;
    this.#rules = rules;
    this.#obstacles = obstacles;
    this.#pours = maps.extra.map(extra => extra.slice());
  }

  xy = (node: number): Xy => {
    const { x0, y0, cell, cols } = this.#grid;
    return [x0 + (node % cols) * cell, y0 + Math.floor(node / cols) * cell];
  };

  node = ([x, y]: Xy): number | null => {
    const { x0, y0, cell, cols, rows } = this.#grid;
    const [c, r] = [roundWhole((x - x0) / cell), roundWhole((y - y0) / cell)];
    return c >= 0 && c < cols && r >= 0 && r < rows ? r * cols + c : null;
  };

  /** Points along a piece, half a cell apart. */
  samples = (u: Xy, v: Xy): Xy[] => {
    const n = Math.max(1, Math.ceil(dist(u, v) / (this.#grid.cell / 2)));
    return Array.from({ length: n + 1 }, (_, j): Xy => [u[0] + (v[0] - u[0]) * j / n, u[1] + (v[1] - u[1]) * j / n]);
  };

  /** Mm of the segments in the own-domain ground pour. */
  pourLength = (segments: RouteSegment[]): number => {
    let total = 0;
    for (const { a, b, layer } of segments) {
      const pour = this.#pours[this.#rules.layers.indexOf(layer)]!;
      const points = this.samples(a, b);
      points.slice(1).forEach((point, i) => {
        const node = this.node(points[i]!);
        if (node !== null && pour[node]) total += dist(points[i]!, point);
      });
    }
    return total;
  };

  /** A connect leg as segments. */
  segments = (u: Xy, v: Xy, layer: string): RouteSegment[] => {
    const points = [u, ...leg(u, v)];
    return points.slice(1).map((point, i) => ({ a: points[i]!, b: point, layer, width: this.#rules.width }));
  };

  /** The direct leg u -> v may replace u -> w -> v: free on the grid (pours), clear of copper, no more ground pour. */
  directOk = (u: Xy, w: Xy, v: Xy, layer: string): boolean => {
    const direct = this.segments(u, v, layer);
    const free = this.#maps.free[this.#rules.layers.indexOf(layer)]!;
    const open = direct.every(({ a, b }) => this.samples(a, b).every(point => {
      const node = this.node(point);
      return node !== null && free[node];
    }));
    if (!open) return false;
    if (nearestCopper(direct, [], this.#rules.viaSize, { [layer]: this.#obstacles[layer]! }).margin < -1e-6) return false;
    return this.pourLength(direct) <= this.pourLength([...this.segments(u, w, layer), ...this.segments(w, v, layer)]) + 1e-6;
  };

  /**
   * Free nodes near a pad centre whose exact leg to it is clear of copper at the real clearance and crosses no blocked pour, with the
   * length of that leg. The inflated grid can close the last gap at a pad.
   */
  endNodes = (pad: Xy, layerIndexes: ReadonlySet<number>, atStart: boolean): EndCosts => {
    const { cell, cols, rows } = this.#grid;
    const out: EndCosts = new Map();
    const reach = Math.ceil(ESCAPE_MM / cell);
    const centre = this.#nearestNode(pad);
    const layerCount = this.#rules.layers.length;
    for (const index of layerIndexes) {
      const layer = this.#rules.layers[index]!;
      const close = this.#obstacles[layer]!.filter(item => {
        const [left, top, right, bottom] = shapeBox(item.shape);
        const range = ESCAPE_MM + 2;
        return left < pad[0] + range && right > pad[0] - range && top < pad[1] + range && bottom > pad[1] - range;
      });
      const free = this.#maps.free[index]!;
      const blocked = this.#maps.blockedBy[index]!;
      for (let r = Math.max(0, centre.row - reach); r < Math.min(rows, centre.row + reach + 1); r++) {
        for (let c = Math.max(0, centre.col - reach); c < Math.min(cols, centre.col + reach + 1); c++) {
          const node = r * cols + c;
          const at = this.xy(node);
          if (!free[node] || dist(at, pad) > ESCAPE_MM) continue;
          const segments = atStart ? this.segments(pad, at, layer) : this.segments(at, pad, layer);
          const inPour = segments.some(({ a, b }) => this.samples(a, b).some(point => {
            const on = this.node(point);
            return on !== null && this.#maps.labelAt(blocked, on)?.startsWith('pour ');
          }));
          if (inPour) continue;
          if (nearestCopper(segments, [], this.#rules.viaSize, { [layer]: close }).margin >= -1e-6) {
            out.set(stateOf(node, index, layerCount), segments.reduce((sum, { a, b }) => sum + dist(a, b), 0));
          }
        }
      }
    }
    return out;
  };

  #nearestNode([x, y]: Xy): { col: number; row: number } {
    const { x0, y0, cell } = this.#grid;
    return { col: roundWhole((x - x0) / cell), row: roundWhole((y - y0) / cell) };
  }
}

interface Proposal { length: number; vias: number; bends: number; margin: number; nearest: string; pour: number; line: string }

/** The connect line of a node path, and the points it goes through. */
function connectWords(prefix: string, points: LinePoint[], layer: string): string {
  let line = prefix;
  let current = layer;
  for (const { kind, at, to } of points.slice(1, -1)) {
    if (kind === 'via') {
      line += viaWords(at, current, to!);
      current = to!;
    } else {
      line += ` ${kind} ${mmWord(at[0])},${mmWord(at[1])}`;
    }
  }
  return line;
}

function pushAway(maps: NodeMaps, path: PathNode[], band: number): void {
  const { cols, rows } = maps.grid;
  for (const [node, layer] of path) {
    const [col, row] = [node % cols, Math.floor(node / cols)];
    for (let dr = -band; dr <= band; dr++) {
      for (let dc = -band; dc <= band; dc++) {
        if (col + dc >= 0 && col + dc < cols && row + dr >= 0 && row + dr < rows) maps.extra[layer]![(row + dr) * cols + col + dc]! += 1;
      }
    }
  }
}

/** The labels nearest a node, most frequent first. */
function nearbyBlockers(maps: NodeMaps, node: number, band: number): string {
  const { cols, rows } = maps.grid;
  const [col, row] = [node % cols, Math.floor(node / cols)];
  const counts = new Map<string, number>();
  for (const blocked of [...maps.blockedBy, maps.viaBlockedBy]) {
    for (let dr = -band * 2; dr <= band * 2; dr++) {
      for (let dc = -band * 2; dc <= band * 2; dc++) {
        const [c, r] = [col + dc, row + dr];
        if (c < 0 || c >= cols || r < 0 || r >= rows) continue;
        const label = maps.labelAt(blocked, r * cols + c);
        if (label !== null) counts.set(label, (counts.get(label) ?? 0) + 1);
      }
    }
  }
  return [...counts].sort((a, b) => b[1] - a[1]).slice(0, 3).map(([label]) => label).join(', ') || 'box edge';
}

const countBends = (segments: RouteSegment[]): number => segments.slice(1).filter((next, i) => {
  const { a, b, layer } = segments[i]!;
  return layer === next.layer && Math.abs((b[0] - a[0]) * (next.b[1] - next.a[1]) - (b[1] - a[1]) * (next.b[0] - next.a[0])) > 1e-9;
}).length;

const signed = (value: number, places: number): string => {
  const text = fixed(value, places);
  return text.startsWith('-') ? text : `+${text}`;
};

/** Proposals for the pair, or the exit code of a stuck search: a report line says what stopped it. */
export async function suggest(input: SuggestInput, options: SuggestOptions, print: Print): Promise<number> {
  const { board } = input;
  const { net } = options;
  if (!(net in board.nets)) throw new CommandFailure(`no net ${net} on the board`);
  const rules = netRulesOf(input, options);
  const pairs = padPairs(board, options);
  if (!pairs.length) {
    print(`${net}: unconnected: none`);
    return 0;
  }
  const n = options.pair || 1;
  if (!(n >= 1 && n <= pairs.length)) throw new CommandFailure(`--pair ${n}: the net has ${pairs.length} pairs`);
  const [a, b] = pairs[n - 1]!;
  const [startLayers, goalLayers] = [padLayers(a.pad, rules.layers), padLayers(b.pad, rules.layers)];
  if (!startLayers.size || !goalLayers.size) throw new CommandFailure(`${!startLayers.size ? a.name : b.name} is not on --layers ${options.layers}`);
  const box = searchBox(a, b, options);
  const grid = nodeGrid(box, a.at, options.cell, options.maxNodes);
  const { obstacles, referenceVias } = allObstacles(input, rules, options);
  const near = (shape: Shape): boolean => {
    const [left, top, right, bottom] = shapeBox(shape);
    return left < box[2] + FAR_MM && right > box[0] - FAR_MM && top < box[3] + FAR_MM && bottom > box[1] - FAR_MM;
  };
  const margin = STEP_MARGIN * grid.cell;
  const maps = new NodeMaps(grid, board);
  layerMaps(maps, board, rules, net, obstacles, near, margin);
  viaMaps(maps, board, rules, options, obstacles, referenceVias, near, margin);
  const { cols, rows, cell, x0, y0 } = grid;
  const start = Math.floor((a.at[1] - box[1]) / cell) * cols + Math.floor((a.at[0] - box[0]) / cell);
  const clamp = (value: number, limit: number): number => Math.min(Math.max(0, value), limit - 1);
  const goal = clamp(roundWhole((b.at[1] - y0) / cell), rows) * cols + clamp(roundWhole((b.at[0] - x0) / cell), cols);
  for (const free of maps.free) { free[start] = 1; free[goal] = 1; }
  const legs = new Legs(maps, rules, obstacles);
  const { className, width, clearance, viaSize, viaDrill, layers } = rules;
  print(`pair ${n} of ${pairs.length}: ${a.name} -> ${b.name}; class ${className} w ${formatG(width)} clr ${formatG(clearance)} via ${formatG(viaSize)}/${formatG(viaDrill)}; `
    + `cell ${formatG(cell)} box ${fixed(box[0], 1)},${fixed(box[1], 1)}..${fixed(box[2], 1)},${fixed(box[3], 1)}; ${rules.domain ?? 'None'} pour x3 cost, other pours blocked; .kicad_dru not used`);
  const count = layers.length;
  const starts: EndCosts = legs.endNodes(a.at, startLayers, true);
  for (const layer of startLayers) starts.set(stateOf(start, layer, count), 0);
  const goals: EndCosts = legs.endNodes(b.at, goalLayers, false);
  for (const layer of goalLayers) goals.set(stateOf(goal, layer, count), dist(legs.xy(goal), b.at));
  const band = Math.max(3, roundWhole(0.5 / cell));
  const search: SearchGrid = { cols, rows, cell, free: maps.free, viaOk: maps.viaOk, extra: maps.extra, viaCost: options.viaCost };
  const found: Proposal[] = [];
  const seen = new Set<string>();
  for (let attempt = 0; attempt < options.k * 2 && found.length < options.k; attempt++) {
    const result = astar(search, starts, goals, goal);
    if (result.path === null) {
      if (found.length) break;
      const { closest, onTargetLayer } = closestReach(result.masks, legs.xy, b.at, goalLayers, layers, maps.viaOk);
      const access = onTargetLayer ? `nearest reach on target layer ${fixed(onTargetLayer.distanceMm, 2)} mm` : 'target layer not reached';
      print(`STUCK: no path in this model; closest reach (${fixed(closest!.point[0], 3)}, ${fixed(closest!.point[1], 3)}) on ${closest!.layers.join(',')} is ${fixed(closest!.distanceMm, 2)} mm from ${b.name}; `
        + `pad requires ${[...goalLayers].sort((x, y) => x - y).map(layer => layers[layer]).join(',')}; ${access}; via at closest point ${closest!.viaAllowed ? 'allowed' : 'blocked'}; `
        + `nearby blockers: ${nearbyBlockers(maps, closest!.node, band)}`);
      return 1;
    }
    const { path } = result;
    const first = layers[path[0]![1]]!;
    const after = viaLayers(path).map(layer => layers[layer]!);
    const corners = nodeCorners(path, cols).map((corner): LinePoint => (corner.kind === 'via' ? { kind: 'via', at: legs.xy(corner.node), to: after.shift()! } : { kind: 'through', at: legs.xy(corner.node) }));
    const points = dropJogs(pathPoints(a.at, b.at, legs.xy(path[0]![0]), corners, legs.xy(path.at(-1)![0])), first, legs.directOk);
    const prefix = `${net} ${a.name} -> ${b.name} layer=${first}${options.width !== null ? ` width=${mmWord(width)}` : ''}`;
    const line = connectWords(prefix, points, first);
    pushAway(maps, path, band);
    if (seen.has(line)) continue;
    seen.add(line);
    const { segments, vias: holes } = expandRoute(intentRoute(parseIntent(line), a.at, b.at, first, width, [viaSize, viaDrill]));
    const { margin: gap, label } = nearestCopper(segments, holes, viaSize, obstacles);
    found.push({ length: segments.reduce((sum, item) => sum + dist(item.a, item.b), 0), vias: holes.length, bends: countBends(segments), margin: gap, nearest: label, pour: legs.pourLength(segments), line });
  }
  const verified = options.verify || options.probeThermals;
  const verdicts = verified ? await input.verdicts(found.map(item => item.line)) : found.map((): Verdict => ({ ok: true, reason: '' }));
  let shown = 0;
  found.forEach((item, i) => {
    if (!verdicts[i]!.ok) return;
    shown += 1;
    const conflict = item.margin < -1e-6 ? ` CONFLICT to ${item.nearest}` : '';
    print(`${shown}) ${verified ? 'verified ' : ''}len ${fixed(item.length, 2)} vias ${item.vias} bends ${item.bends} margin ${signed(item.margin, 3)} pour ${fixed(item.pour, 1)}${conflict}`);
    print(item.line);
  });
  if (verified && shown < found.length) {
    print(`rejected by DRC: ${found.flatMap((item, i) => (verdicts[i]!.ok ? [] : [`len ${fixed(item.length, 2)} vias ${item.vias}: ${verdicts[i]!.reason}`])).join('; ')}`);
  }
  return shown ? 0 : 1;
}
