// The thermal spokes of pads in a pour of their own net. A track through a spoke starves the thermal (DRC starved_thermal), so pcbtool
// suggest routes around them. Millimetres, y down.
import { formsByUuid } from './board-edit.ts';
import { fromMm, polygonsContain } from './board-hit.ts';
import { clearanceTo, mmPoint, type ProjectFile } from './board-obstacles.ts';
import { toMm, type Board, type Pad, type Zone } from './board-types.ts';
import { segmentShape, type Obstacles } from './copper-gap.ts';
import type { Xy } from './route-spec.ts';

const RADIANS = Math.PI / 180;

/** The 4 spoke centre lines of a pad at c, half sizes hx, hy (a round pad: radius hx): from the pad edge out by reach, at spokeDeg + k x 90 in the pad frame. */
export function spokeSegments(c: Xy, hx: number, hy: number, orientDeg: number, spokeDeg: number, reach: number, roundPad = false): [Xy, Xy][] {
  const turn = orientDeg * RADIANS;
  return [0, 1, 2, 3].map((k): [Xy, Xy] => {
    const angle = (spokeDeg + 90 * k) * RADIANS;
    const [ca, sa] = [Math.cos(angle), Math.sin(angle)];
    const edge = roundPad ? hx : Math.min(Math.abs(ca) > 1e-9 ? hx / Math.abs(ca) : Infinity, Math.abs(sa) > 1e-9 ? hy / Math.abs(sa) : Infinity);
    const d: Xy = [ca * Math.cos(turn) + sa * Math.sin(turn), -ca * Math.sin(turn) + sa * Math.cos(turn)];
    return [[c[0] + d[0] * edge, c[1] + d[1] * edge], [c[0] + d[0] * (edge + reach), c[1] + d[1] * (edge + reach)]];
  });
}

/** A pad's own spoke width and gap in nanometres, where it sets them. The document does not hold these. */
export interface PadThermal { width?: number; gap?: number }
export type PadThermals = (pad: Pad) => PadThermal;

/** The overrides of each pad, from the board text. A pad that shares its uuid with another reads as that one. */
export function padThermals(boardText: string): PadThermals {
  const forms = formsByUuid(boardText);
  const value = (text: string, word: string): number | undefined => {
    const found = text.match(new RegExp(`\\(${word} ([0-9.]+)\\)`))?.[1];
    return found === undefined ? undefined : fromMm(Number(found));
  };
  return pad => {
    const form = forms.get(pad.id);
    if (!form || form.kind !== 'pad') return {};
    const text = boardText.slice(form.start, form.end);
    const [width, gap] = [value(text, 'thermal_bridge_width'), value(text, 'thermal_gap')];
    return { ...(width ? { width } : {}), ...(gap ? { gap } : {}) };
  };
}

function thermalJoin(pad: Pad, zone: Zone): boolean {
  const connection = pad.zone_connection ?? zone.fill?.pad_connection;
  return connection === 'Thermal' || (connection === 'ThtThermal' && pad.kind === 'ThroughHole');
}

/**
 * Per layer, the spokes of the pads in a pour of their own net that is not `net`. A filled zone keeps only the spokes its fill holds,
 * at half the gap from the pad edge, as KiCad drops a spoke the fill does not reach; an unfilled zone keeps all 4 (conservative).
 */
export function thermalSpokes(board: Board, project: ProjectFile, net: string, clearance: number, cache: Map<string, number>, thermals: PadThermals): Obstacles {
  const out: Obstacles = {};
  for (const zone of board.zones) {
    if (zone.rule_area || !zone.net || zone.net === net) continue;
    const keep = clearanceTo(project, clearance, cache, zone.net);
    const filled = zone.filled.some(layer => layer.polygons.length);
    for (const footprint of board.footprints) {
      for (const pad of footprint.pads) {
        if (pad.net !== zone.net || !polygonsContain(zone.outline, pad.position) || !thermalJoin(pad, zone)) continue;
        const own = thermals(pad);
        const width = toMm(own.width ?? zone.fill?.spoke_width ?? 0);
        const gap = toMm(own.gap ?? zone.fill?.thermal_gap ?? 0);
        for (const layer of zone.layers.filter(name => pad.layers.includes(name))) {
          const fill = zone.filled.find(item => item.layer === layer)?.polygons ?? [];
          const at = mmPoint(pad.position);
          const spokes = spokeSegments(at, toMm(pad.size.x) / 2, toMm(pad.size.y) / 2, pad.orientation, pad.thermal_spoke_angle, gap + width, pad.shape === 'Circle');
          const held = ([u, v]: [Xy, Xy]): boolean => polygonsContain(fill, {
            x: fromMm(u[0] + (v[0] - u[0]) * (gap / 2) / (gap + width)), y: fromMm(u[1] + (v[1] - u[1]) * (gap / 2) / (gap + width)),
          });
          (out[layer] ??= []).push(...(filled ? spokes.filter(held) : spokes).map(([u, v]) => ({
            shape: segmentShape(u, v, width / 2), clearance: keep, label: `thermal spoke ${footprint.reference}.${pad.number}`,
          })));
        }
      }
    }
  }
  return out;
}
