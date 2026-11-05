// Current capacity of copper (D-124, hardware-design/reports/2026-10-09-design-rules-sources.md A3 and C5, C8).
//
// IPC-2221 chart fit I = k dT^0.44 A^0.725 (A in mil^2) with the EXTERNAL constant k = 0.048 on ALL layers.
// Source: IPC-2152 (2009) found internal and external conductors heat nearly the same; the IPC-2221 internal curve
// (k = 0.024) was made by halving the external current, not from test data. Cadence, "IPC-2152 vs IPC-2221",
// https://resources.system-analysis.cadence.com/blog/ipc-2152-vs-ipc-2221-which-to-use-for-pcb-thermal-analysis [S];
// PCD&F "Determining current carrying capacity" https://pcdandf.com/pcdesign/index.php/2009-archive-articles/5731-determining-current-carrying-capacity [S].
// Conservative: it ignores the solid In1 GND plane (the largest IPC-2152 correction, PCD&F).
//
// D-124c (user decision 2026-10-09, option C): neck credit only from evidence of the end temperatures.
// Derivation [D]. A neck of length L, cross-section A, current I is a 1-D conductor with uniform heat generation
// q''' = J^2 rho (J = I / A). Steady state, no heat loss through its sides (conduction into FR-4 and air is
// ignored, which makes the result higher, so conservative): k d2T/dx2 = -J^2 rho. With both ends held at the same
// temperature T_e the solution is a parabola with its peak in the middle: T_max - T_e = J^2 rho L^2 / (8 k).
// Source: the plane wall with uniform thermal energy generation and equal surface temperatures, Incropera, DeWitt,
// Bergman, Lavine, "Fundamentals of Heat and Mass Transfer", section 3.5 "Conduction with thermal energy
// generation" (T_max - T_s = q L_half^2 / (2 k) with L_half = L / 2) [S]. The two ends of a real neck can be at
// different temperatures; holding BOTH at the higher one gives a temperature at every point that is at least the
// true one (superposition: the linear profile between unequal ends never exceeds the higher end), so
//   peak rise = max(end rises) + I^2 rho L^2 / (8 k A^2)                                          (conservative)
// and the neck passes when the peak rise <= the allowed dT.
// End rise (an upper bound on the end's temperature rise, from evidence in the CAD data):
//   - plane: the end is in a zone of the same net on that layer, on a pad solidly joined to one, or on a via that
//     joins one (stitching vias): rise 0. IPC-2152 found that planes near a trace lower its temperature (PCD&F,
//     above [S]); a same-net plane is the heat sink itself.
//   - track: the end meets a wider track: that track's IPC rise at the current (ipcRise).
//   - anything else (a pad with no other evidence, a dead end, a narrower branch): rise = the full allowed dT, so
//     the neck has no budget left and is rated as a plain IPC track.
// An end with several kinds of evidence takes the lowest bound (each one is an upper bound on the same node).
import { dist } from './py-math.ts';

const IPC_K = 0.048;
const MIL_MM = 0.0254;
// rho_Cu = 1.72e-8 ohm m: the IEC 60028 international annealed copper standard, 1/58 ohm mm2/m = 1.724e-8 ohm m at 20 C
//   (standard value, paywalled, quoted widely) [S]; C11000 Cu-ETP data sheet 0.017 ohm mm2/m at 20 C, Aurubis,
//   https://aurubis.com/dam/jcr:ec116d17-1541-419a-a897-ad31b4fa6c93/c11000-cu-etp-us.pdf [S, search summary 2026-10-09].
const RHO_CU = 1.72e-8;
// k_Cu = 390 W/(m K): C11000 Cu-ETP 388-391 W/(m K), same Aurubis data sheet and MakeItFrom
//   https://www.makeitfrom.com/material-properties/UNS-C11000-CW004A-Electrolytic-Tough-Pitch-Copper [S, search summary 2026-10-09].
//   PCB foil is electrodeposited copper with about the same values; a lower k gives a shorter neck limit.
const K_CU = 390;
/** 1 oz foil, when the stackup does not name the layer. */
export const DEFAULT_COPPER_MM = 0.035;
/** JLC "Average Hole Plating Thickness: 18 um", https://jlcpcb.com/capabilities/pcb-capabilities [P]. */
export const VIA_PLATING_MM = 0.018;
/** The allowed rise of the paths check default (current-paths.json "dT"; a design choice, report A3). */
export const DEFAULT_RISE_K = 10;
/** Thermal relief: 2 spokes (the KiCad default minimum), each an IPC conductor of the spoke width (report A3). */
export const THERMAL_SPOKES = 2;

export type Xy = readonly [x: number, y: number];
export type Evidence = { kind: 'plane' } | { kind: 'pad' } | { kind: 'track'; width: number; thickness: number };

/** IPC current of a conductor with this copper cross-section (mm2). */
export const areaAmps = (areaMm2: number, rise = DEFAULT_RISE_K): number => IPC_K * rise ** 0.44 * (areaMm2 / MIL_MM ** 2) ** 0.725;

/** IPC current of a track width x thickness (mm). */
export const ipcAmps = (widthMm: number, thickMm = DEFAULT_COPPER_MM, rise = DEFAULT_RISE_K): number => areaAmps(widthMm * thickMm, rise);

/**
 * Vias in parallel between the same copper, rated as the trace with the same copper cross-section. IPC-2152 as quoted by Brooks &
 * Adam, "Vias are cooler than we think", Signal Integrity Journal, https://signalintegrityjournal.com/articles/1459-vias-are-cooler-than-we-think
 * [P]: "the cross-sectional area of a via should be at least the same as the conductor coming into it", or use several vias (their
 * barrel areas add). Barrel area = pi x drill x plating.
 */
export function viaGroupAmps(drillsMm: number[], platingMm = VIA_PLATING_MM, rise = DEFAULT_RISE_K): number {
  return areaAmps(drillsMm.reduce((sum, drill) => sum + Math.PI * drill * platingMm, 0), rise);
}

export const viaAmps = (drillMm: number, platingMm = VIA_PLATING_MM, rise = DEFAULT_RISE_K): number => viaGroupAmps([drillMm], platingMm, rise);

/** A/m: J L <= sqrt(8 k dT / rho). */
const neckConstant = (rise: number): number => Math.sqrt(8 * K_CU * rise / RHO_CU);

/**
 * The longest neck that stays within dT at this current, both ends at rise 0 (on a same-net plane): L <= (A / I) x sqrt(8 k dT / rho)
 * (report C5, [D]). With warmer ends the budget is smaller: neckCapacity. A pad or a chain stop alone does not prove a cool end.
 */
export function neckMaxMm(widthMm: number, thickMm: number, amps: number, rise = DEFAULT_RISE_K): number {
  return amps > 0 ? (widthMm * thickMm * 1e-6 / amps) * neckConstant(rise) * 1e3 : Infinity;
}

/** The current at which a neck of this length reaches dT with both ends at rise 0 (inverse of neckMaxMm). */
export function neckAmps(widthMm: number, thickMm: number, lengthMm: number, rise = DEFAULT_RISE_K): number {
  return lengthMm > 0 ? widthMm * thickMm * 1e-6 * neckConstant(rise) / (lengthMm * 1e-3) : Infinity;
}

/** Temperature rise of a track at this current (inverse of ipcAmps): dT = (I / (k A^0.725))^(1 / 0.44). */
export function ipcRise(amps: number, widthMm: number, thickMm = DEFAULT_COPPER_MM): number {
  return (amps / (IPC_K * (widthMm * thickMm / MIL_MM ** 2) ** 0.725)) ** (1 / 0.44);
}

/** Peak rise of a neck above its ends: I^2 rho L^2 / (8 k A^2). */
export function jouleRise(widthMm: number, thickMm: number, lengthMm: number, amps: number): number {
  const area = widthMm * thickMm * 1e-6;
  return amps ** 2 * RHO_CU * (lengthMm * 1e-3) ** 2 / (8 * K_CU * area ** 2);
}

/** Upper bound on the rise of one neck end: the lowest bound of its evidence, the full dT with none. */
export function endRise(end: readonly Evidence[], amps: number, rise: number): number {
  let best = rise;
  for (const item of end) {
    if (item.kind === 'plane') best = Math.min(best, 0);
    else if (item.kind === 'track') best = Math.min(best, ipcRise(amps, item.width, item.thickness));
  }
  return best;
}

/** max(end rises) + Joule rise of the neck. */
export function neckPeakRise(widthMm: number, thickMm: number, lengthMm: number, amps: number, ends: readonly (readonly Evidence[])[], rise: number): number {
  const hottest = ends.length ? Math.max(...ends.map(end => endRise(end, amps, rise))) : rise;
  return hottest + jouleRise(widthMm, thickMm, lengthMm, amps);
}

/** The largest current whose peak rise is <= dT, 0 when an end has no evidence. The rise grows with the current: a bisection finds it. */
export function neckCapacity(widthMm: number, thickMm: number, lengthMm: number, ends: readonly (readonly Evidence[])[], rise: number): number {
  if (ends.length === 0 || ends.some(end => endRise(end, 1e-9, rise) >= rise)) return 0;
  let low = 0;
  let high = neckAmps(widthMm, thickMm, lengthMm, rise);
  if (high === Infinity) return high;
  for (let i = 0; i < 80; i += 1) {
    const middle = (low + high) / 2;
    if (neckPeakRise(widthMm, thickMm, lengthMm, middle, ends, rise) <= rise) low = middle; else high = middle;
  }
  return low;
}

/** A track piece. `group` is the plane its nodes are on: pieces join only within a group. */
export interface Piece { group: string; u: Xy; v: Xy; width: number; thickness: number }
export interface Chain { length: number; minWidth: number; ends: string[] }

/** The identity of a node of a group: floats compare as Python tuples of them do. */
export const nodeId = (group: string, point: Xy): string => `n|${group}|${point[0]}|${point[1]}`;

function piecesAtNodes(pieces: readonly Piece[]): Map<string, number[]> {
  const at = new Map<string, number[]>();
  pieces.forEach((piece, i) => {
    for (const end of [piece.u, piece.v]) {
      const id = nodeId(piece.group, end);
      at.set(id, [...(at.get(id) ?? []), i]);
    }
  });
  return at;
}

const pieceNodes = (piece: Piece): [string, string] => [nodeId(piece.group, piece.u), nodeId(piece.group, piece.v)];

/**
 * The neck chain of each piece: the run of pieces joined end to end through nodes where exactly two pieces of that group meet and
 * that are not in stops (a pad, via or zone), using only pieces no wider than it. A piece next to wider copper therefore ends
 * there; the chain of the widest piece of a neck spans the whole neck at its narrowest width (conservative). The end nodes are where
 * the chain stops: D-124c rates it only from the evidence there, a geometric stop alone is no heat sink.
 */
export function neckChains(pieces: readonly Piece[], stops: ReadonlySet<string> = new Set()): Chain[] {
  const at = piecesAtNodes(pieces);
  return pieces.map((piece, i) => {
    const seen = new Set([i]);
    const todo = [i];
    while (todo.length) {
      for (const node of pieceNodes(pieces[todo.pop()!]!)) {
        if (stops.has(node) || at.get(node)!.length !== 2) continue;
        for (const k of at.get(node)!) {
          if (!seen.has(k) && pieces[k]!.width <= piece.width + 1e-9) { seen.add(k); todo.push(k); }
        }
      }
    }
    const members = [...seen].sort((a, b) => a - b);
    const ends = new Set<string>();
    for (const j of members) {
      for (const node of pieceNodes(pieces[j]!)) {
        const inner = !stops.has(node) && at.get(node)!.length === 2 && at.get(node)!.every(k => seen.has(k));
        if (!inner) ends.add(node);
      }
    }
    return {
      length: members.reduce((sum, j) => sum + dist(pieces[j]!.u, pieces[j]!.v), 0),
      minWidth: Math.min(...members.map(j => pieces[j]!.width)), ends: [...ends],
    };
  });
}

/** The evidence at each end of each chain. A wider track at a node adds its rating: at a branch the narrowest (its rise is highest). */
export function chainEndEvidence(pieces: readonly Piece[], chains: readonly Chain[], evidence: ReadonlyMap<string, readonly Evidence[]>): Evidence[][][] {
  const at = piecesAtNodes(pieces);
  return pieces.map((piece, i) => chains[i]!.ends.map(node => {
    const wider = at.get(node)!.map(k => pieces[k]!).filter(other => other.width > piece.width + 1e-9);
    const found = [...(evidence.get(node) ?? [])];
    if (wider.length) found.push({ kind: 'track', width: Math.min(...wider.map(other => other.width)), thickness: wider[0]!.thickness });
    return found;
  }));
}

/** The larger of a piece's IPC current and the neck capacity of its chain with the evidence at its ends. */
export function trackAmps(widthMm: number, thickMm: number, rise: number, chain: Pick<Chain, 'length' | 'minWidth'>, ends: readonly (readonly Evidence[])[] = []): number {
  return Math.max(ipcAmps(widthMm, thickMm, rise), neckCapacity(chain.minWidth, thickMm, chain.length, ends, rise));
}

/**
 * D-124c (b): a track piece that starts on a pad is part of the pad, and carries the pin rating, when it is no narrower than the
 * pad's narrow side, no longer than its long side, and the datasheet pin or switch current is at least the net current.
 */
export function pinEscape(lengthMm: number, widthMm: number, padMinorMm: number, padMajorMm: number, pinAmps: number | null | undefined, amps: number): boolean {
  return pinAmps !== null && pinAmps !== undefined && pinAmps >= amps - 1e-12 && widthMm >= padMinorMm - 1e-6 && lengthMm <= padMajorMm + 1e-6;
}
