// The pcbtool commands that change a board: place, route, unroute, widen, connect, stitch, art, setcolors. Each reads the board
// document, edits the board as text and leaves the one KiCad 10 save to put the new items in their place. The read commands
// are not here. Coordinates are millimetres, y down. Items of a net a spec names are matched in the document by uuid.
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { BoardEdit, itemIds, mmText, saveBoardInPlace, type DrcFile } from './board-edit.ts';
import { boardJson } from './board-json.ts';
import { clearanceTo, copperObstacles, edgeObstacles, mmPoint, netClass, netRules, padShape, viaCentres, type ProjectFile } from './board-obstacles.ts';
import { arcText, circleText, lineText, textText, trackText, viaText, type Xy } from './board-items.ts';
import { fromMm, padHit, polygonNear, polygonsContain, trackHit, viaHit } from './board-hit.ts';
import type { Board, BoardDocument, Pad, Pt, Track, Via, Zone } from './board-types.ts';
import { toMm, tracks, vias } from './board-types.ts';
import { clearMargin, dotShape, firstConflict, polyShape, segmentShape, type Obstacle, type Obstacles } from './copper-gap.ts';
import { UsageError } from './cli.ts';
import { drcLines, summarizeDrc } from './drc-summary.ts';
import { fnmatchCase } from './fnmatch.ts';
import { movedFootprint } from './footprint-move.ts';
import { readJson } from './json-file.ts';
import { fixed, floatRepr, pyRepr } from './py-compat.mjs';
import { dist } from './py-math.ts';
import { formatG, pyFloat, round } from './py-numbers.ts';
import { expandRoute, floatPoint, intentRoute, OTHER_SIDE, parseIntent, placements, specPoint, type ExpandedRoute, type Intent, type PlaceSpec, type RouteSegment, type RouteSpec } from './route-spec.ts';
import { seigaiha } from './seigaiha.ts';
import { applyColors } from './stackup-colors.ts';

const TOOL = 'pcbtool';
const USAGE = 'usage: tools/pcbtool.ts {place,route,unroute,widen,connect,stitch,art,setcolors} ...';
const DEFAULT_VIA = { size: 0.6, drill: 0.3 };
const STITCH_RINGS = [0.97, 0.9, 0.8, 0.7];
/** With --via (small ground vias): a finer search. */
const FINE_RINGS = [0.99, 0.95, 0.9, 0.85, 0.8, 0.75, 0.7];

const stop = (message: string): UsageError => new UsageError(message, 1);
const printDrc = (drc: DrcFile): void => console.log(drcLines(summarizeDrc(drc)).join('\n'));
const boardText = (pcb: string): string => readFileSync(pcb, 'utf8');
const listOf = (tuple: string): string => `[${tuple.slice(1, -1)}]`;

const saved = (pcb: string, edit: BoardEdit): DrcFile => saveBoardInPlace(pcb, edit.text()).drc;

export function place(pcb: string, specFile: string): number {
  const wanted = placements(readJson<PlaceSpec>(specFile));
  const { board } = boardJson(pcb);
  const byRef = new Map([...board.footprints].reverse().map(footprint => [footprint.reference, footprint]));
  const missing = [...wanted.keys()].filter(ref => !byRef.has(ref));
  if (missing.length) throw stop(`not on the board: ${pyRepr(missing)}`);
  const edit = new BoardEdit(boardText(pcb));
  for (const [ref, [x, y, rot]] of wanted) {
    const footprint = byRef.get(ref)!;
    const [fromX, fromY] = mmPoint(footprint.position);
    edit.replace(footprint.id, movedFootprint(edit.textOf(footprint.id), { x: fromX, y: fromY, rot: footprint.orientation }, { x, y, rot }));
  }
  const drc = saved(pcb, edit);
  console.log(`placed ${wanted.size} parts`);
  printDrc(drc);
  return 0;
}

const copperId = (item: Board['copper'][number]): string => ('Track' in item ? item.Track.id : item.Via.id);
const copperNet = (item: Board['copper'][number]): string => ('Track' in item ? item.Track.net : item.Via.net);

/** Removes all tracks and vias of the nets and gives their ids. */
function removeNets(board: Board, edit: BoardEdit, nets: ReadonlySet<string>): Set<string> {
  const gone = new Set(board.copper.filter(item => nets.has(copperNet(item))).map(copperId));
  for (const id of gone) edit.remove(id);
  return gone;
}

export function unroute(pcb: string, nets: string[], noDrc: boolean): number {
  const { board } = boardJson(pcb);
  const edit = new BoardEdit(boardText(pcb));
  const removed = removeNets(board, edit, new Set(nets)).size;
  const drc = saved(pcb, edit);
  console.log(`removed ${removed} track items`);
  if (!noDrc) printDrc(drc);
  return 0;
}

export interface WidenOptions { layer?: string; box?: [number, number, number, number] }

/** The net's tracks narrower than `width`, on the layer if given, with both ends in the box if given. Arcs count. */
export function tracksToWiden(board: Board, net: string, width: number, { layer, box }: WidenOptions): Track[] {
  const inside = (p: Pt): boolean => !box || (box[0] <= toMm(p.x) && toMm(p.x) <= box[2] && box[1] <= toMm(p.y) && toMm(p.y) <= box[3]);
  return tracks(board).filter(track => track.net === net && round(toMm(track.width), 4) < width - 1e-6
    && (layer === undefined || track.layer === layer) && inside(track.start) && inside(track.end));
}

export function widen(pcb: string, net: string, width: number, options: WidenOptions): number {
  const { board } = boardJson(pcb);
  const picked = tracksToWiden(board, net, width, options);
  const shown = floatRepr(width);
  if (!picked.length) throw stop(`no ${net} track narrower than ${shown} mm matches`);
  const edit = new BoardEdit(boardText(pcb));
  for (const { id } of picked) edit.replace(id, edit.textOf(id).replace(/\(width [^)]*\)/, `(width ${mmText(width)})`));
  const drc = saved(pcb, edit);
  console.log(`widened ${picked.length} ${net} segments to ${shown} mm`);
  printDrc(drc);
  return 0;
}

interface MoveVia { net: string; from: Xy; to: Xy }
interface RouteFile { clear?: string[]; routes: RouteSpec[]; move_vias?: MoveVia[]; via?: { size: number; drill: number } }

/** The index of the one point within tol mm of q. None or several is an error. */
function findPoint(points: Xy[], q: Xy, show: (point: [number, number]) => string, tol = 0.01): number {
  const hits = points.flatMap((point, i) => (dist(point, q) <= tol ? [i] : []));
  if (hits.length !== 1) throw new Error(`${hits.length} points within ${tol} mm of ${show(q as [number, number])}`);
  return hits[0]!;
}

const asPt = ([x, y]: Xy): Pt => ({ x: fromMm(x), y: fromMm(y) });

function newTrack({ a, b, layer, width }: RouteSegment, net: string): Track {
  return { id: '', start: asPt(a), end: asPt(b), mid: null, width: fromMm(width), layer, net, locked: false };
}

/** Warnings for route ends that land on no pad of the net and on less than two pieces of its copper. */
function loseEnds(board: Board, routes: RouteSpec[], copper: (Track | Via)[], show: (point: [number, number]) => string): string[] {
  const pads = board.footprints.flatMap(footprint => footprint.pads).filter(pad => pad.number);
  const hitBy = (item: Track | Via, p: Pt): boolean => ('at' in item ? viaHit(item, p) : trackHit(item, p));
  return routes.flatMap(route => [route.path[0]!, route.path.at(-1)!].flatMap(end => {
    if (!Array.isArray(end)) return [];
    const p = asPt(end);
    if (pads.some(pad => pad.net === route.net && padHit(pad, p))) return [];
    const others = copper.filter(item => item.net === route.net && hitBy(item, p));
    return others.length < 2 ? [`  W ${route.net}: end ${listOf(show(end))} is not on a pad of the net`] : [];
  }));
}

/** The via's net in the saved board, by rounded position: KiCad gives a moved via the net of the copper it touches. */
function viaNetsAt(board: Board): Map<string, string> {
  return new Map(viaCentres(board).map(({ net, at }) => [`${round(at[0], 3)},${round(at[1], 3)}`, net]));
}

function applyRoutes(pcb: string, spec: RouteFile, show: (point: [number, number]) => string, parseError: (error: Error) => never = error => { throw error; }): number {
  let plan: (ExpandedRoute & { route: RouteSpec })[];
  try {
    plan = spec.routes.map(route => ({ route, ...expandRoute(route, show) }));
  } catch (error) {
    parseError(error as Error);
  }
  const { board } = boardJson(pcb);
  const original = boardText(pcb);
  const moves = (spec.move_vias ?? []).map(move => {
    const candidates = vias(board).filter(via => via.net === move.net);
    try {
      return { move, via: candidates[findPoint(candidates.map(via => mmPoint(via.at)), move.from, show)]! };
    } catch (error) {
      throw stop(`move_vias ${move.net} ${listOf(show(move.from as [number, number]))}: ${(error as Error).message}`);
    }
  });
  const edit = new BoardEdit(original);
  const gone = removeNets(board, edit, new Set(spec.clear ?? []));
  const moved = new Map<string, Xy>();
  for (const { move, via } of moves) {
    edit.replace(via.id, edit.textOf(via.id).replace(/\(at [^)]*\)/, `(at ${mmText(move.to[0])} ${mmText(move.to[1])})`));
    moved.set(via.id, move.to);
  }
  const defaults = spec.via ?? DEFAULT_VIA;
  const next = itemIds(original, TOOL);
  const added: (Track | Via)[] = [];
  let segments = 0;
  let newVias = 0;
  for (const { route, segments: pieces, vias: holes } of plan!) {
    if (!(route.net in board.nets)) throw stop(`no net ${route.net} on the board`);
    for (const piece of pieces) {
      edit.add(trackText({ start: piece.a, end: piece.b, width: piece.width, layer: piece.layer, net: route.net, uuid: next() }));
      added.push(newTrack(piece, route.net));
      segments += 1;
    }
    for (const at of holes) {
      const size = route.via_size ?? defaults.size;
      edit.add(viaText({ at, size, drill: route.via_drill ?? defaults.drill, net: route.net, uuid: next() }));
      added.push({ id: '', at: asPt(at), size: fromMm(size), drill: 0, net: route.net, locked: false, layers: ['F.Cu', 'B.Cu'] });
      newVias += 1;
    }
  }
  const kept = board.copper.filter(item => !gone.has(copperId(item))).map(item => {
    if ('Track' in item) return item.Track;
    const to = moved.get(item.Via.id);
    return to ? { ...item.Via, at: asPt(to) } : item.Via;
  });
  for (const line of loseEnds(board, plan!.map(item => item.route), [...kept, ...added], show)) console.log(line);
  const drc = saved(pcb, edit);
  if (moves.length) {
    const nets = viaNetsAt(boardJson(pcb).board);
    const renet = moves.map(({ move }) => ({ move, net: nets.get(`${round(move.to[0], 3)},${round(move.to[1], 3)}`) })).filter(({ move, net }) => net !== move.net);
    if (renet.length) {
      writeFileSync(pcb, original);
      const text = renet.map(({ move, net }) => `${move.net} ${listOf(show(move.to as [number, number]))} -> ${net ?? 'None'}`);
      throw stop(`moved via touches copper of another net, board not changed: ${text.join('; ')}`);
    }
  }
  console.log(`removed ${gone.size}, moved ${moves.length} vias, added ${segments} segments and ${newVias} vias`);
  printDrc(drc);
  return 0;
}

export const route = (pcb: string, specFile: string): number => applyRoutes(pcb, readJson<RouteFile>(specFile), specPoint);

const projectOf = (pcb: string): ProjectFile => readJson<ProjectFile>(`${pcb.replace(/\.[^./]*$/, '')}.kicad_pro`);
const planesPath = (pcb: string, planes: string | undefined): string => planes ?? join(dirname(resolve(pcb)), '..', '..', 'reference-planes.json');

interface PlanesFile { grounds: string[]; domains?: Record<string, string[]>; mixed_layers?: Record<string, unknown> }

/**
 * Why `net` may not use these layers, or null. F.Cu and B.Cu are always allowed. A mixed layer of reference-planes.json is for
 * slow nets only; which nets are slow is tools/si_planes.py's rule, not in TypeScript yet, so such a spec stops here.
 */
function layersError(net: string, layers: string[], planes: string): string | null {
  const inner = layers.filter(layer => !(layer in OTHER_SIDE));
  if (!inner.length) return null;
  if (existsSync(planes) && Object.keys(readJson<PlanesFile>(planes).mixed_layers ?? {}).length) {
    throw new Error(`${planes}: mixed_layers need tools/si_planes.py, which has no TypeScript port yet`);
  }
  return `${inner[0]} is not a routing layer (F.Cu, B.Cu, or a mixed layer of reference-planes.json)`;
}

function endPad(board: Board, ref: string, number: string, net: string): Pad {
  const pad = board.footprints.find(footprint => footprint.reference === ref)?.pads.find(item => item.number === number);
  if (!pad) throw stop(`no pad ${ref}.${number}`);
  if (pad.net !== net) throw stop(`pad ${ref}.${number} is on net ${pad.net}, not ${net}`);
  return pad;
}

interface Planned { net: string; route: RouteSpec; expanded: ExpandedRoute; viaSize: number }

function plannedRoute(board: Board, project: ProjectFile, planes: string, intent: Intent): Planned {
  const { net } = intent;
  if (!(net in board.nets)) throw stop(`no net ${net} on the board`);
  const a = endPad(board, intent.a.ref, intent.a.number, net);
  const b = endPad(board, intent.b.ref, intent.b.number, net);
  const rule = netRules(project, net);
  const cls = netClass(project, rule.className);
  const layer = intent.layer ?? (a.kind === 'Smd' && a.layers.includes('B.Cu') ? 'B.Cu' : 'F.Cu');
  const via = intent.via ?? [cls.via_diameter, cls.via_drill];
  const route = intentRoute(intent, mmPoint(a.position) as [number, number], mmPoint(b.position) as [number, number], layer, intent.width || rule.trackWidth, via);
  let expanded: ExpandedRoute;
  try {
    expanded = expandRoute(route, floatPoint);
  } catch (error) {
    throw stop((error as Error).message);
  }
  const used = [...new Set(expanded.segments.map(segment => segment.layer))].sort();
  const refused = layersError(net, used, planes);
  if (refused) throw stop(refused);
  const ends: [Pad, string, string][] = [[a, expanded.segments[0]!.layer, 'start'], [b, expanded.segments.at(-1)!.layer, 'end']];
  for (const [pad, onLayer, what] of ends) {
    if (!pad.layers.includes(onLayer)) throw stop(`${net}: the ${what} pad is not on ${onLayer}; add or remove a via`);
  }
  return { net, route, expanded, viaSize: via[0]! };
}

/** New copper of the other nets of this spec, as obstacles of one layer. */
function earlierRoutes(done: Planned[], net: string, layer: string, clearance: number): Obstacle[] {
  return done.filter(item => item.net !== net).flatMap(item => [
    ...item.expanded.segments.filter(segment => segment.layer === layer)
      .map(({ a, b, width }) => ({ shape: segmentShape(a, b, width / 2), clearance, label: `new track ${item.net}` })),
    ...item.expanded.vias.map(at => ({ shape: dotShape(at, item.viaSize / 2), clearance, label: `new via ${item.net}` })),
  ]);
}

/** Intent lines to tracks and vias. On a conflict with other-net copper nothing is written. Pours are not checked: they refill. */
export function connect(pcb: string, spec: string, planesFile: string | undefined): number {
  const text = existsSync(spec) ? readFileSync(spec, 'utf8') : spec;
  const lines = text.split(/\r\n|\r|\n/).map(line => line.split('#', 1)[0]!.trim()).filter(Boolean);
  let intents: Intent[];
  try {
    intents = lines.map(parseIntent);
  } catch (error) {
    throw stop((error as Error).message);
  }
  if (!intents.length) throw stop('no intent lines');
  const { board } = boardJson(pcb);
  const project = projectOf(pcb);
  const planes = planesPath(pcb, planesFile);
  const edges = edgeObstacles(board, project);
  const done: Planned[] = [];
  for (const intent of intents) {
    const planned = plannedRoute(board, project, planes, intent);
    const { clearance } = netRules(project, planned.net);
    const cache = new Map<string, number>();
    const obstacles: Obstacles = Object.fromEntries(board.copper_layers.map(layer => [layer,
      [...copperObstacles(board, project, planned.net, clearance, layer, cache), ...edges, ...earlierRoutes(done, planned.net, layer, clearance)]]));
    const hit = firstConflict(planned.expanded.segments, planned.expanded.vias, planned.viaSize, obstacles);
    if (hit) {
      console.log(`conflict: ${planned.net} ${hit}; nothing written`);
      return 1;
    }
    done.push(planned);
  }
  return applyRoutes(pcb, { routes: done.map(item => item.route) }, floatPoint);
}

/** A net's ground domain, as si_planes.py finds it: a ground, a spec pattern, then the ground holding most of its pads. */
export function netDomain(net: string, padGrounds: (string | null)[], grounds: string[], patterns: Record<string, string[]>): string | null {
  if (grounds.includes(net)) return net;
  for (const [ground, globs] of Object.entries(patterns)) {
    if (globs.some(glob => fnmatchCase(net, glob))) return ground;
  }
  const counts = new Map<string, number>();
  for (const ground of padGrounds) if (ground) counts.set(ground, (counts.get(ground) ?? 0) + 1);
  const top = [...counts].sort((a, b) => b[1] - a[1]);
  if (top.length && (top.length === 1 || top[0]![1] > top[1]![1])) return top[0]![0];
  return grounds.length === 1 ? grounds[0]! : null;
}

function padGrounds(board: Board, net: string, grounds: string[]): (string | null)[] {
  const zones = board.zones.filter(zone => !zone.rule_area && grounds.includes(zone.net));
  return board.footprints.flatMap(footprint => footprint.pads).filter(pad => pad.net === net)
    .map(pad => zones.find(zone => polygonsContain(zone.outline, pad.position))?.net ?? null);
}

/** Candidate ground via centres round a signal via: rings at r x ring, n points each, outer ring first. */
export function* stitchSpots(q: Xy, r: number, rings = STITCH_RINGS, n = 36): Generator<[number, number]> {
  for (const ring of rings) {
    for (let k = 0; k < n; k++) {
      const a = 2 * Math.PI * k / n;
      yield [round(q[0] + ring * r * Math.cos(a), 4), round(q[1] + ring * r * Math.sin(a), 4)];
    }
  }
}

export interface StitchOptions { r: number; bestEffort: boolean; planes?: string; throughPours: string; via: string; clearance: number }

const zonePriority = (edit: BoardEdit, zone: Zone): number => Number(edit.textOf(zone.id).match(/\(priority (\d+)\)/)?.[1] ?? 0);

/** --clearance: a scoped .kicad_dru rule that reaches own-domain tracks, vias and SMD pads only. */
function scopedClearance(board: Board, project: ProjectFile, groundClass: string, limit: number, obstacles: Obstacles): Obstacles {
  const host = new Set(['HOST', 'HOST_PWR']);
  const smd = new Set(board.footprints.flatMap(footprint => footprint.pads.filter(pad => pad.kind === 'Smd').map(pad => `pad ${footprint.reference}.${pad.number} ${pad.net}`)));
  const scoped = (label: string): boolean => {
    const [kind, ...words] = label.split(' ');
    if (kind === 'pad' ? !smd.has(label) : kind !== 'track' && kind !== 'via') return false;
    const net = (kind === 'pad' ? words.slice(1) : words).join(' ');
    const cls = net ? netRules(project, net).className : 'Default';
    return cls !== 'FIELD_HI' && cls !== 'Default' && host.has(cls) === host.has(groundClass);
  };
  return Object.fromEntries(Object.entries(obstacles).map(([layer, list]) => [layer,
    list.map(item => (scoped(item.label) ? { ...item, clearance: Math.min(item.clearance, limit) } : item))]));
}

/** A ground via within r of each via of the net that has none (kicad-happy RP-001). Without room nothing is written, exit 1. */
export function stitch(pcb: string, net: string, options: StitchOptions): number {
  const document: BoardDocument = boardJson(pcb);
  const { board } = document;
  if (!(net in board.nets)) throw stop(`cannot load ${pcb} or no net ${net}`);
  const project = projectOf(pcb);
  const planes = planesPath(pcb, options.planes);
  const spec: PlanesFile = existsSync(planes) ? readJson<PlanesFile>(planes) : { grounds: ['GND'] };
  const ground = netDomain(net, padGrounds(board, net, spec.grounds), spec.grounds, spec.domains ?? {});
  if (ground === null || ground === net) throw stop(`${net}: no single ground domain; set "domains" in the planes spec`);
  const rule = netRules(project, ground);
  const cls = netClass(project, rule.className);
  const [viaSize, viaDrill] = options.via ? options.via.split(',').map(pyFloat) as [number, number] : [cls.via_diameter, cls.via_drill];
  const cache = new Map<string, number>();
  const edges = edgeObstacles(board, project);
  let obstacles: Obstacles = Object.fromEntries(board.copper_layers.map(layer => [layer, [...copperObstacles(board, project, ground, rule.clearance, layer, cache), ...edges]]));
  if (options.clearance) obstacles = scopedClearance(board, project, rule.className, options.clearance, obstacles);
  // A ground SMD pad is own copper, but a via in it is a via in pad: it keeps the class clearance.
  for (const footprint of board.footprints) {
    for (const pad of footprint.pads.filter(item => item.net === ground && item.kind === 'Smd')) {
      for (const layer of board.copper_layers.filter(name => pad.layers.includes(name))) {
        obstacles[layer]!.push({ shape: padShape(pad, layer), clearance: rule.clearance, label: `pad ${footprint.reference}.${pad.number} ${ground}` });
      }
    }
  }
  const edit = new BoardEdit(boardText(pcb));
  const keepouts = board.zones.filter(zone => zone.rule_area?.vias).flatMap(zone => zone.outline);
  const through = new Set(options.throughPours.split(',').filter(Boolean));
  const innerOnly = (zone: Zone): boolean => zone.layers.every(layer => layer !== 'F.Cu' && layer !== 'B.Cu');
  const pours = board.zones.filter(zone => !zone.rule_area && zone.net !== ground && !(through.has(zone.net) && innerOnly(zone)));
  const groundPours = board.zones.filter(zone => !zone.rule_area && zone.net === ground);
  const covered = (zone: Zone, p: Pt): boolean => zone.layers.some(layer => groundPours.some(pour =>
    pour.layers.includes(layer) && zonePriority(edit, pour) > zonePriority(edit, zone) && polygonsContain(pour.outline, p)));
  const all = viaCentres(board);
  const groundVias = all.filter(via => via.net === ground).map(via => via.at);
  const room = (q: Xy): boolean => {
    const p = asPt(q);
    if (keepouts.some(polygon => polygonNear(polygon, p, fromMm(viaSize / 2)))) return false;
    if (pours.some(zone => polygonsContain(zone.outline, p) && !covered(zone, p))) return false;
    if (groundVias.some(via => dist(q, via) < viaSize + rule.clearance)) return false;
    return clearMargin([], [q as [number, number]], viaSize, obstacles) >= -1e-6;
  };
  const added: Xy[] = [];
  const missed: Xy[] = [];
  for (const { net: name, at } of all) {
    if (name !== net || groundVias.some(via => dist(at, via) <= options.r)) continue;
    const spots = options.via ? stitchSpots(at, options.r, FINE_RINGS, 72) : stitchSpots(at, options.r);
    const spot = [...spots].find(room);
    if (!spot) {
      missed.push(at);
      continue;
    }
    added.push(spot);
    groundVias.push(spot);
  }
  const place3 = ([x, y]: Xy): string => `(${fixed(x, 3)}, ${fixed(y, 3)})`;
  if (missed.length) {
    console.log(`${net}: no room for a ${ground} via within ${formatG(options.r)} mm of ${missed.map(place3).join(', ')}`
      + (options.bestEffort ? '; best effort: the others are placed' : '; nothing written'));
    if (!options.bestEffort) return 1;
  }
  if (added.length) {
    const next = itemIds(boardText(pcb), TOOL);
    for (const at of added) edit.add(viaText({ at, size: viaSize, drill: viaDrill, net: ground, uuid: next() }));
    saved(pcb, edit);
  }
  console.log(`${net}: added ${added.length} ${ground} vias ${formatG(viaSize)}/${formatG(viaDrill)}${added.map(at => ` ${place3(at)}`).join('')}`);
  return 0;
}

interface ArtSpec {
  group?: string; layer?: string; remove_groups?: string[];
  waves?: { box: [number, number, number, number]; r: number; rings?: number; width?: number }[];
  circles?: { c: Xy; r: number; width?: number; fill?: boolean }[];
  lines?: { a: Xy; b: Xy; width?: number }[];
  texts?: { text: string; at: Xy; size: number; vertical?: boolean; line?: number; thickness?: number; bold?: boolean; angle?: number; font?: string }[];
}

/** KiCad's stroke for bold text: SetBold replaces the thickness set before it. */
const boldThickness = (size: number): number => size / 5;

/** The art of a spec as items, each with the uuid it takes from `next`. */
export function artItems(spec: ArtSpec, layer: string, next: () => string): { uuid: string; text: string }[] {
  const mirrored = layer.startsWith('B.');
  const out: { uuid: string; text: string }[] = [];
  const add = (make: (uuid: string) => string): void => {
    const uuid = next();
    out.push({ uuid, text: make(uuid) });
  };
  const onCircle = (c: readonly [number, number], radius: number, degrees: number): Xy => [c[0] + radius * Math.cos(degrees * Math.PI / 180), c[1] + radius * Math.sin(degrees * Math.PI / 180)];
  for (const wave of spec.waves ?? []) {
    for (const { centre, radius, from, to } of seigaiha(wave.box, wave.r, wave.rings ?? 3)) {
      add(uuid => arcText({ start: onCircle(centre, radius, from), mid: onCircle(centre, radius, (from + to) / 2), end: onCircle(centre, radius, to), width: wave.width ?? 0.18, layer, uuid }));
    }
  }
  for (const circle of spec.circles ?? []) {
    add(uuid => circleText({ center: circle.c, end: [circle.c[0] + circle.r, circle.c[1]], width: circle.width ?? 0.2, filled: Boolean(circle.fill), layer, uuid }));
  }
  for (const line of spec.lines ?? []) add(uuid => lineText({ start: line.a, end: line.b, width: line.width ?? 0.2, layer, uuid }));
  for (const text of spec.texts ?? []) {
    const pieces = text.vertical ? Array.from(text.text) : [text.text];
    pieces.forEach((piece, i) => {
      const [x, y] = text.at;
      const thickness = text.bold ? boldThickness(text.size) : text.thickness ?? text.size * 0.15;
      const at: Xy = [x, y + i * text.size * (text.line ?? 1.1)];
      add(uuid => textText({ text: piece, at, size: text.size, thickness, angle: text.angle ?? 0, bold: Boolean(text.bold), mirrored, layer, uuid,
        ...(text.font ? { face: text.font } : {}) }));
    });
  }
  return out;
}

/** Silkscreen art from a spec, in one group. A rerun replaces the group. */
export function art(pcb: string, specFile: string): number {
  const spec = readJson<ArtSpec>(specFile);
  const name = spec.group ?? 'art';
  const layer = spec.layer ?? 'B.SilkS';
  const original = boardText(pcb);
  const edit = new BoardEdit(original);
  const replaced = new Set([name, ...(spec.remove_groups ?? [])]);
  for (const group of edit.groups().filter(item => replaced.has(item.name))) edit.removeGroup(group);
  const next = itemIds(original, TOOL);
  const items = artItems(spec, layer, next);
  for (const item of items) edit.add(item.text);
  edit.addGroup(name, items.map(item => item.uuid), next());
  const drc = saved(pcb, edit);
  console.log(`${name}: ${items.length} items on ${layer}`);
  printDrc(drc);
  return 0;
}

/** The stackup colours: a plain edit of the file, no KiCad save, as it always was. */
export function setColors(pcb: string, mask: string, silk: string, finish: string): number {
  writeFileSync(pcb, applyColors(boardText(pcb), mask, silk, finish));
  console.log(`stackup: mask ${mask}, silk ${silk}, finish ${finish}`);
  return 0;
}

/** Takes `--name` and the `count` values after it out of argv. Negative numbers are values, so parseArgs cannot do this. */
function takeValues(argv: string[], name: string, count: number): string[] | undefined {
  const at = argv.indexOf(name);
  if (at < 0) return undefined;
  const values = argv.splice(at, count + 1).slice(1);
  if (values.length !== count) throw new UsageError(USAGE);
  return values;
}

function number(text: string): number {
  try {
    return pyFloat(text);
  } catch {
    throw new UsageError(USAGE);
  }
}

function positional(argv: string[], flags: string[], count: number): string[] {
  const words = argv.filter(arg => !flags.includes(arg));
  if (words.length < count || words.some(word => word.startsWith('--'))) throw new UsageError(USAGE);
  return words;
}

function widenCommand(argv: string[]): number {
  const rest = [...argv];
  const layer = takeValues(rest, '--layer', 1)?.[0];
  const box = takeValues(rest, '--box', 4)?.map(number) as WidenOptions['box'];
  const [pcb, net, width] = positional(rest, [], 3) as [string, string, string];
  return widen(pcb, net, number(width), { ...(layer === undefined ? {} : { layer }), ...(box ? { box } : {}) });
}

function stitchCommand(argv: string[]): number {
  const rest = [...argv];
  const value = (name: string): string | undefined => takeValues(rest, name, 1)?.[0];
  const r = value('--r');
  const planes = value('--planes');
  const throughPours = value('--through-pours') ?? '';
  const via = value('--via') ?? '';
  const clearance = value('--clearance');
  const [pcb, net] = positional(rest, ['--best-effort'], 2) as [string, string];
  return stitch(pcb, net, { r: r === undefined ? 1 : number(r), bestEffort: rest.includes('--best-effort'), throughPours, via,
    clearance: clearance === undefined ? 0 : number(clearance), ...(planes === undefined ? {} : { planes }) });
}

function connectCommand(argv: string[]): number {
  const rest = [...argv];
  const planes = takeValues(rest, '--planes', 1)?.[0];
  const [pcb, spec] = positional(rest, [], 2) as [string, string];
  return connect(pcb, spec, planes);
}

function unrouteCommand(argv: string[]): number {
  const [pcb, ...nets] = positional(argv, ['--no-drc'], 2) as [string, ...string[]];
  return unroute(pcb, nets, argv.includes('--no-drc'));
}

const twoWords = (command: (pcb: string, spec: string) => number) => (argv: string[]): number => {
  const [pcb, spec] = positional(argv, [], 2) as [string, string];
  return command(pcb, spec);
};

function setColorsCommand(argv: string[]): number {
  const [pcb, mask, silk, finish] = positional(argv, [], 4) as [string, string, string, string];
  return setColors(pcb, mask, silk, finish);
}

/** Command name to its entry point, for tools/pcbtool.ts. */
export const writeCommands: Record<string, (argv: string[]) => number> = {
  place: twoWords(place), route: twoWords(route), art: twoWords(art), unroute: unrouteCommand, widen: widenCommand,
  connect: connectCommand, stitch: stitchCommand, setcolors: setColorsCommand,
};
