// fp_keepouts: datasheet keep-out areas of a footprint as board rule areas (spec: registry/cad-assets/<C>/DATASHEET-KEEPOUTS.json).
//
//   tools/fp_keepouts.ts apply BOARD.kicad_pcb REF SPEC   replace the rule areas "<REF> KO <name>" with the spec areas
//   tools/fp_keepouts.ts rip   BOARD.kicad_pcb REF        remove tracks / vias that touch those areas, then the dangling track
//                                                         chains of the same nets (router input)
//
// The areas follow the footprint pose (position, orientation; top side only) when `apply` runs: run it again after the part moves.
// They are board rule areas, not footprint zones, so the shared library footprint stays the JLC/EasyEDA bridge footprint. Run on
// the board in its project folder: the save refills every zone with the .kicad_dru next to it. One summary line: DONE <counts>.
//
// check and gerber stay in tools/fp_keepouts.py. They print the overlap area of fills and pads with an area, and only a polygon
// boolean gives that (SHAPE_POLY_SET.BooleanIntersection, Area): the document holds no such result.
import { readFileSync } from 'node:fs';
import { relative, resolve } from 'node:path';
import { BoardEdit, itemIds, saveBoardInPlace } from './lib/board-edit.ts';
import { boardJson } from './lib/board-json.ts';
import { padHit, polygonNear, polygonNearTrack, trackHit } from './lib/board-hit.ts';
import { ruleAreaText } from './lib/board-items.ts';
import { toMm, type Board, type Pt, type RoutedCopper, type Track, type Via, type Zone } from './lib/board-types.ts';
import { runMain, UsageError } from './lib/cli.ts';
import { footprintAngle } from './lib/footprint-move.ts';
import { readJson } from './lib/json-file.ts';
import { fixed, floatRepr } from './lib/py-compat.mjs';
import { round } from './lib/py-numbers.ts';
import { fileRoot } from './lib/project-root.mjs';

const USAGE = 'usage: tools/fp_keepouts.ts {apply BOARD REF SPEC | rip BOARD REF}; check and gerber: tools/fp_keepouts.py';

export interface KeepoutSpec { areas_fp_mm: { name: string; rect: [number, number, number, number] }[]; layers: string[]; not_allowed: string[] }
export interface Area { name: string; points: [number, number][] }

const stop = (message: string): UsageError => new UsageError(message, 1);
const prefix = (ref: string): string => `${ref} KO `;

/** Spec rectangles (footprint frame, mm) as board polygons: KiCad's rotation, y down, positive turns counter-clockwise on screen. */
export function areasOnBoard(position: [number, number], degrees: number, spec: KeepoutSpec): Area[] {
  const radians = degrees * Math.PI / 180;
  const [cos, sin] = [Math.cos(radians), Math.sin(radians)];
  return spec.areas_fp_mm.map(({ name, rect: [x0, y0, x1, y1] }) => ({
    name,
    points: ([[x0, y0], [x1, y0], [x1, y1], [x0, y1]] as const).map(([x, y]): [number, number] =>
      [round(position[0] + x * cos + y * sin, 6), round(position[1] - x * sin + y * cos, 6)]),
  }));
}

const keepoutZones = (board: Board, ref: string): Zone[] => board.zones.filter(zone => zone.rule_area && zone.name.startsWith(prefix(ref)));

function apply(pcb: string, ref: string, specFile: string): number {
  const spec = readJson<KeepoutSpec>(specFile);
  const { board } = boardJson(pcb);
  const footprint = board.footprints.find(item => item.reference === ref);
  if (!footprint || footprint.layer === 'B.Cu') throw stop(`ERROR ${ref}: missing or on the bottom side (spec areas are top-side)`);
  const text = readFileSync(pcb, 'utf8');
  const edit = new BoardEdit(text);
  const old = keepoutZones(board, ref);
  for (const zone of old) edit.remove(zone.id);
  const next = itemIds(text, 'fp_keepouts');
  const notAllowed = new Set(spec.not_allowed);
  for (const { name, points } of areasOnBoard([toMm(footprint.position.x), toMm(footprint.position.y)], footprintAngle(footprint.orientation), spec)) {
    edit.add(ruleAreaText({ name: prefix(ref) + name, layers: spec.layers, notAllowed, points, uuid: next() }));
    console.log(`  ${prefix(ref)}${name}: ${points.map(([x, y]) => `(${fixed(x, 3)},${fixed(y, 3)})`).join(' ')}`);
  }
  saveBoardInPlace(pcb, edit.text());
  const rel = relative(fileRoot, resolve(specFile));
  console.log(`DONE apply ${ref}: ${spec.areas_fp_mm.length} areas (${old.length} replaced), layers ${spec.layers.join(',')}, not allowed ${spec.not_allowed.join(',')}; spec ${rel}`);
  return 0;
}

type Copper = Track | Via;
const unwrap = (item: RoutedCopper): Copper => ('Track' in item ? item.Track : item.Via);
const isVia = (item: Copper): item is Via => 'at' in item;
const isArc = (item: Copper): boolean => !isVia(item) && item.mid !== null;
const isPlainTrack = (item: Copper): item is Track => !isVia(item) && item.mid === null;

/** Copper of a track or via that overlaps the area, on a layer of the area. A rule's area only reaches what it forbids; an arc always counts. */
function touches(zone: Zone, item: Copper): boolean {
  const rule = zone.rule_area!;
  if (isVia(item)) return rule.vias && zone.outline.some(polygon => polygonNear(polygon, item.at, Math.trunc(item.size / 2)));
  if (!zone.layers.includes(item.layer) || (!isArc(item) && !rule.tracks)) return false;
  return zone.outline.some(polygon => polygonNearTrack(polygon, item));
}

/** Each track or via in each area of the footprint. */
export function touching(board: Board, ref: string): { item: Copper; area: string }[] {
  const copper = board.copper.map(unwrap);
  return keepoutZones(board, ref).flatMap(zone => copper.filter(item => touches(zone, item)).map(item => ({ item, area: zone.name })));
}

const mm3 = (value: number): string => floatRepr(round(toMm(value), 3));
const point3 = ({ x, y }: Pt): string => `(${mm3(x)},${mm3(y)})`;
const describe = (item: Copper): string => (isVia(item) ? `via ${item.net} ${point3(item.at)}`
  : `track ${item.net} ${item.layer} ${point3(item.start)}->${point3(item.end)}`);

/** VECTOR2I::EuclideanNorm: whole nanometres. */
const norm = (a: Pt, b: Pt): number => Math.round(Math.hypot(a.x - b.x, a.y - b.y));
const samePoint = (a: Pt, b: Pt): boolean => a.x === b.x && a.y === b.y;

function anchored(board: Board, live: Copper[], track: Track, end: Pt): boolean {
  const joined = live.some(other => {
    if (other.id === track.id || other.net !== track.net) return false;
    if (isVia(other)) return norm(other.at, end) <= Math.trunc(other.size / 2);
    return other.layer === track.layer && (samePoint(other.start, end) || samePoint(other.end, end) || trackHit(other, end));
  });
  return joined || board.footprints.some(footprint => footprint.pads.some(pad => pad.net === track.net && pad.layers.includes(track.layer) && padHit(pad, end)));
}

/** Copper layers on which a track end or a pad of the via's net touches it. A pad counts as 2. */
function viaLayers(board: Board, live: Copper[], via: Via): number {
  if (board.footprints.some(footprint => footprint.pads.some(pad => pad.net === via.net && padHit(pad, via.at)))) return 2;
  const reach = Math.trunc(via.size / 2);
  const ends = live.filter(isPlainTrack).filter(track => track.net === via.net && (norm(track.start, via.at) <= reach || norm(track.end, via.at) <= reach));
  return new Set(ends.map(track => track.layer)).size;
}

/** What goes, in order, with the line each prints: the copper in the areas, then the dangling chains of the same nets, pass by pass. */
export function ripPlan(board: Board, ref: string): { lines: string[]; ids: Set<string>; hits: number; pruned: number; nets: string[] } {
  const hits = touching(board, ref);
  const nets = [...new Set(hits.map(hit => hit.item.net))].sort();
  const pourNets = new Set(board.zones.filter(zone => !zone.rule_area).map(zone => zone.net));
  const prunable = new Set(nets.filter(net => !pourNets.has(net)));
  const ids = new Set<string>();
  const lines: string[] = [];
  const drop = (item: Copper, why: string): boolean => {
    if (ids.has(item.id)) return false;
    lines.push(`  ${why} ${describe(item)}`);
    ids.add(item.id);
    return true;
  };
  for (const { item, area } of hits) drop(item, `rip [${area}]`);
  const all = board.copper.map(unwrap);
  let pruned = 0;
  for (;;) {
    const live = all.filter(item => !ids.has(item.id));
    const dangling = [
      ...live.filter(isPlainTrack).filter(track => prunable.has(track.net) && ![track.start, track.end].every(end => anchored(board, live, track, end))),
      ...live.filter(isVia).filter(via => prunable.has(via.net) && viaLayers(board, live, via) < 2),
    ];
    if (!dangling.length) return { lines, ids, hits: hits.length, pruned, nets };
    for (const item of dangling) if (drop(item, 'prune')) pruned += 1;
  }
}

function rip(pcb: string, ref: string): number {
  const { board } = boardJson(pcb);
  const { lines, ids, hits, pruned, nets } = ripPlan(board, ref);
  if (lines.length) console.log(lines.join('\n'));
  const edit = new BoardEdit(readFileSync(pcb, 'utf8'));
  for (const id of ids) edit.remove(id);
  saveBoardInPlace(pcb, edit.text());
  console.log(`DONE rip ${ref}: ${hits} items in the areas, ${pruned} dangling tracks, nets ${nets.join(',') || '-'}`);
  return 0;
}

function main([command, pcb, ref, spec, ...rest]: string[]): number {
  if (command === 'apply' && pcb && ref && spec && !rest.length) return apply(pcb, ref, spec);
  if (command === 'rip' && pcb && ref && !spec) return rip(pcb, ref);
  throw new UsageError(USAGE, 1);
}

runMain(import.meta.url, main);
