// What new copper must keep clear of, read from a board document and the project's net rules: pcbtool connect and stitch.
// Millimetres, as copper-gap.ts measures. An arc track counts as the straight line between its ends, as it did through pcbnew.
import { dotShape, polyShape, segmentShape, type Obstacle, type Shape } from './copper-gap.ts';
import { toMm, vias, type Board, type Pad, type Polygon, type Pt } from './board-types.ts';
import { fnmatchCase } from './fnmatch.ts';
import type { Xy } from './route-spec.ts';

export interface NetClass { name: string; track_width: number; clearance: number; via_diameter: number; via_drill: number }
export interface ProjectFile {
  net_settings: { classes: NetClass[]; netclass_patterns?: { netclass: string; pattern: string }[] | null };
  board: { design_settings: { rules: { min_copper_edge_clearance: number } } };
}
export interface NetRule { className: string; trackWidth: number; clearance: number }

export function netClass(project: ProjectFile, name: string): NetClass {
  const found = project.net_settings.classes.find(item => item.name === name);
  if (!found) throw new Error(`no net class ${name} in the project`);
  return found;
}

/** The class of a net: the first matching pattern, else Default. */
export function netRules(project: ProjectFile, net: string): NetRule {
  const pattern = (project.net_settings.netclass_patterns ?? []).find(item => fnmatchCase(net, item.pattern));
  const found = netClass(project, pattern?.netclass ?? 'Default');
  return { className: found.name, trackWidth: found.track_width, clearance: found.clearance };
}

export const mmPoint = (p: Pt): Xy => [toMm(p.x), toMm(p.y)];
const ringPoints = (ring: Pt[]): Xy[] => ring.map(mmPoint);

/** A pad's copper on one layer: the first polygon of GetEffectivePolygon. A pad that shares its uuid has only copper primitives. */
export function padShape(pad: Pad, layer: string): Shape {
  const polygon = pad.polygons[layer];
  if (polygon) return polyShape(ringPoints(polygon.outline));
  const copper = pad.copper[0];
  if (!copper) throw new Error(`pad ${pad.number} has no copper in the document`);
  if ('Circle' in copper) return dotShape(mmPoint(copper.Circle.center), toMm(copper.Circle.radius));
  if ('Segment' in copper) return segmentShape(mmPoint(copper.Segment.a), mmPoint(copper.Segment.b), toMm(copper.Segment.width) / 2);
  return polyShape(ringPoints(copper.Polygon));
}

/** Clearance of `net`'s new copper to a net: the larger of its own and that net's class. Caches by net. */
export function clearanceTo(project: ProjectFile, own: number, cache: Map<string, number>, net: string): number {
  let known = cache.get(net);
  if (known === undefined) {
    known = Math.max(own, net ? netRules(project, net).clearance : 0);
    cache.set(net, known);
  }
  return known;
}

/** Other-net copper on one layer: tracks, vias, pads, NPTH holes and track keepouts. A through via is on every layer. */
export function copperObstacles(board: Board, project: ProjectFile, net: string, own: number, layer: string, cache: Map<string, number>): Obstacle[] {
  const keep = (other: string): number => clearanceTo(project, own, cache, other);
  const out: Obstacle[] = [];
  for (const item of board.copper) {
    if ('Via' in item) {
      const { Via: via } = item;
      if (via.net !== net) out.push({ shape: dotShape(mmPoint(via.at), toMm(via.size) / 2), clearance: keep(via.net), label: `via ${via.net}` });
    } else if (item.Track.layer === layer && item.Track.net !== net) {
      const { Track: track } = item;
      out.push({ shape: segmentShape(mmPoint(track.start), mmPoint(track.end), toMm(track.width) / 2), clearance: keep(track.net), label: `track ${track.net}` });
    }
  }
  for (const footprint of board.footprints) {
    for (const pad of footprint.pads) {
      const name = `${footprint.reference}.${pad.number}`;
      if (pad.kind === 'NpThroughHole') {
        out.push({ shape: dotShape(mmPoint(pad.position), toMm(pad.drill.x) / 2), clearance: keep(''), label: `NPTH hole ${name}` });
      } else if (pad.layers.includes(layer) && pad.net !== net) {
        out.push({ shape: padShape(pad, layer), clearance: keep(pad.net), label: `pad ${name} ${pad.net}` });
      }
    }
  }
  for (const zone of board.zones) {
    if (zone.rule_area?.tracks && zone.layers.includes(layer) && zone.outline[0]) {
      out.push({ shape: polyShape(ringPoints(zone.outline[0].outline)), clearance: 0, label: 'track keepout' });
    }
  }
  return out;
}

/** Every edge of the board outline, holes and cut-outs included, at the copper-to-edge clearance. */
export function edgeObstacles(board: Board, project: ProjectFile): Obstacle[] {
  const clearance = project.board.design_settings.rules.min_copper_edge_clearance;
  const rings = board.outlines.flatMap((polygon: Polygon) => [polygon.outline, ...polygon.holes]);
  return rings.flatMap(ring => {
    const points = ringPoints(ring);
    return points.map((a, i) => ({ shape: segmentShape(a, points[(i + 1) % points.length]!, 0), clearance, label: 'board edge' }));
  });
}

export const viaCentres = (board: Board): { net: string; at: Xy }[] => vias(board).map(via => ({ net: via.net, at: mmPoint(via.at) }));
