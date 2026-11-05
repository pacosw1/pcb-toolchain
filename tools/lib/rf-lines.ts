// RF trace rule gate (grounded coplanar waveguide), first used on CELLULAR (2026-10-09, D-120). The checks are in tools/rf_lines.ts.
import { fromMm, padHit, polygonsContain, trackHit, viaHit } from './board-hit.ts';
import { toMm, tracks, vias, type Board, type Pad, type Polygon, type Pt, type Track, type Via } from './board-types.ts';
import { fixed, floatRepr, get, item, number, pyRepr, pyStr, sorted, truthy } from './py-compat.mjs';
import { hypot } from './py-math.ts';
import { round } from './py-numbers.ts';

/** Samples on a part of the line (series R, shunt C, ESD, connector, module) are not line samples. */
const PAD_MARGIN_MM = 0.8;
const SAMPLE_STEP_MM = 0.25;
/** Beyond the gap, where the coplanar ground must be. */
const GROUND_MARGIN_MM = 0.05;
const SHOWN_MISSES = 6;

/** A spec number and the text Python's str gives it: 1.0 stays 1.0 in the messages. */
export interface Measure { value: number; text: string }
export interface RfLine { name: string; nets: string[] }
export interface RfSpec {
  nets: Set<string>; layer: string; refLayer: string; ground: string; lines: RfLine[];
  width: Measure; gap: Measure; h: Measure; er: Measure; zTarget: Measure; zTol: Measure; widthTol: Measure; gapTol: Measure;
  maxLength: Measure; fencePitch: Measure; fenceOffset: Measure;
}
export interface RfCheck { ok: boolean; message: string }

function measure(spec: unknown, key: string): Measure {
  const raw = item(spec, key);
  return { value: number(raw), text: pyStr(raw) };
}

/** Without "lines" the nets are one line. CELLULAR rev B has two: LTE main and GNSS. */
function specLines(spec: unknown, nets: Set<string>): RfLine[] {
  const lines = get(spec, 'lines');
  if (!truthy(lines)) return [{ name: 'RF', nets: sorted(nets) as string[] }];
  return (lines as unknown[]).map(line => ({ name: pyStr(item(line, 'name')), nets: item(line, 'nets') as string[] }));
}

/** The spec from py-compat's jsonLoad. */
export function readRfSpec(spec: unknown): RfSpec {
  const nets = new Set(item(spec, 'nets') as string[]);
  return {
    nets, layer: item(spec, 'layer') as string, refLayer: item(spec, 'ref_layer') as string, ground: item(spec, 'ground') as string,
    lines: specLines(spec, nets), width: measure(spec, 'width_mm'), gap: measure(spec, 'gap_mm'), h: measure(spec, 'h_mm'),
    er: measure(spec, 'er'), zTarget: measure(spec, 'z_target'), zTol: measure(spec, 'z_tol'), widthTol: measure(spec, 'width_tol_mm'),
    gapTol: measure(spec, 'gap_tol_mm'), maxLength: measure(spec, 'max_length_mm'), fencePitch: measure(spec, 'fence_pitch_max_mm'),
    fenceOffset: measure(spec, 'fence_offset_max_mm'),
  };
}

/** The complete elliptic integral K(k), by the arithmetic-geometric mean. */
function ellipticK(k: number): number {
  let a = 1;
  let b = Math.sqrt(1 - k * k);
  for (let i = 0; i < 40; i += 1) [a, b] = [(a + b) / 2, Math.sqrt(a * b)];
  return Math.PI / (2 * a);
}

/** Conductor-backed CPW, quasi-static (Wadell, Ghione-Naldi). */
export function gcpwImpedance(width: number, gap: number, h: number, er: number): { z: number; eeff: number } {
  const a = width / 2;
  const b = width / 2 + gap;
  const k = a / b;
  const k3 = Math.tanh(Math.PI * a / (2 * h)) / Math.tanh(Math.PI * b / (2 * h));
  const q = ellipticK(k) / ellipticK(Math.sqrt(1 - k * k));
  const q3 = ellipticK(k3) / ellipticK(Math.sqrt(1 - k3 * k3));
  const eeff = (1 + er * q3 / q) / (1 + q3 / q);
  return { z: 60 * Math.PI / Math.sqrt(eeff) / (q + q3), eeff };
}

function impedanceCheck(spec: RfSpec): RfCheck {
  const { z, eeff } = gcpwImpedance(spec.width.value, spec.gap.value, spec.h.value, spec.er.value);
  return {
    ok: Math.abs(z - spec.zTarget.value) <= spec.zTol.value,
    message: `Z(W ${spec.width.text}, gap ${spec.gap.text}, h ${spec.h.text}, Er ${spec.er.text}) = ${fixed(z, 1)} ohm (eeff ${fixed(eeff, 2)}); `
      + `target ${spec.zTarget.text} +- ${spec.zTol.text}`,
  };
}

function widthCheck(line: Track[], spec: RfSpec): RfCheck {
  const wrong = line.filter(t => t.layer !== spec.layer || Math.abs(toMm(t.width) - spec.width.value) > spec.widthTol.value);
  const shown = wrong.map(t => `(${pyRepr(t.net)}, ${floatRepr(round(toMm(t.width), 3))}, ${pyRepr(t.layer)})`).join(', ');
  return {
    ok: line.length > 0 && wrong.length === 0,
    message: `${line.length} RF tracks on ${spec.layer}, width ${spec.width.text} +- ${spec.widthTol.text} mm; wrong [${shown}]`,
  };
}

const trackLength = (t: Track): number => toMm(hypot(t.end.x - t.start.x, t.end.y - t.start.y));

/** A track drawn twice on the same ends counts once. */
function distinctTracks(line: Track[]): Track[] {
  const key = (t: Track): string => {
    const ends = [t.start, t.end].sort((a, b) => a.x - b.x || a.y - b.y);
    return `${t.layer} ${ends.map(e => `${e.x},${e.y}`).join(' ')}`;
  };
  return [...new Map(line.map(t => [key(t), t])).values()];
}

/** No net of the spec escapes its length check. */
function linesCheck(spec: RfSpec): RfCheck {
  const named = sorted(spec.lines.flatMap(line => line.nets));
  const nets = sorted(spec.nets);
  return { ok: pyRepr(named) === pyRepr(nets), message: `lines must name each net once: ${pyRepr(named)} against nets ${pyRepr(nets)}` };
}

function lengthCheck(line: RfLine, distinct: Track[], spec: RfSpec): RfCheck {
  const nets = new Set(line.nets);
  const length = distinct.filter(t => nets.has(t.net)).reduce((sum, t) => sum + trackLength(t), 0);
  return { ok: length <= spec.maxLength.value, message: `${line.name} track length ${fixed(length, 2)} mm (max ${spec.maxLength.text})` };
}

/** The copper around the line that the samples test. */
interface Surroundings {
  /** Every pad of a part with a pad on the line. */
  linePads: Pad[]; otherPads: Pad[]; groundPads: Pad[]; otherTracks: Track[]; otherVias: Via[];
  otherFill: Polygon[]; groundFill: Polygon[]; referenceFill: Polygon[]; groundVias: Via[];
}

function zoneFill(board: Board, layer: string, netMatches: (net: string) => boolean): Polygon[] {
  return board.zones.filter(z => z.rule_area === null && z.layers.includes(layer) && netMatches(z.net))
    .flatMap(z => z.filled.find(f => f.layer === layer)?.polygons ?? []);
}

function surroundings(board: Board, spec: RfSpec): Surroundings {
  const { nets, layer, ground } = spec;
  const offLine = board.footprints.flatMap(f => f.pads).filter(p => !nets.has(p.net) && p.layers.includes(layer));
  return {
    linePads: board.footprints.filter(f => f.pads.some(p => nets.has(p.net))).flatMap(f => f.pads),
    otherPads: offLine.filter(p => p.net !== ground), groundPads: offLine.filter(p => p.net === ground),
    otherTracks: tracks(board).filter(t => !nets.has(t.net) && t.net !== ground && t.layer === layer),
    otherVias: vias(board).filter(v => !nets.has(v.net) && v.net !== ground),
    otherFill: zoneFill(board, layer, net => net !== ground), groundFill: zoneFill(board, layer, net => net === ground),
    referenceFill: zoneFill(board, spec.refLayer, net => net === ground), groundVias: vias(board).filter(v => v.net === ground),
  };
}

const at = (x: number, y: number): Pt => ({ x: fromMm(x), y: fromMm(y) });

function otherCopper(around: Surroundings, p: Pt): boolean {
  return around.otherPads.some(pad => padHit(pad, p)) || around.otherTracks.some(t => trackHit(t, p))
    || around.otherVias.some(v => viaHit(v, p)) || polygonsContain(around.otherFill, p);
}

function groundCopper(around: Surroundings, p: Pt): boolean {
  return polygonsContain(around.groundFill, p) || around.groundPads.some(pad => padHit(pad, p));
}

interface Sample { x: number; y: number; ux: number; uy: number; label: string }

function* trackSamples(t: Track): Generator<Sample> {
  const [sx, sy, ex, ey] = [toMm(t.start.x), toMm(t.start.y), toMm(t.end.x), toMm(t.end.y)];
  const length = hypot(ex - sx, ey - sy);
  if (length < 1e-6) return;
  const ux = (ex - sx) / length;
  const uy = (ey - sy) / length;
  const steps = Math.max(1, Math.trunc(length / SAMPLE_STEP_MM));
  for (let k = 0; k <= steps; k += 1) {
    const x = sx + ux * length * k / steps;
    const y = sy + uy * length * k / steps;
    yield { x, y, ux, uy, label: `${t.net} (${fixed(x, 2)}, ${fixed(y, 2)})` };
  }
}

/** Is there a ground via on this side, within the offset of the track edge and half the pitch along it? */
function fenced(sample: Sample, nx: number, ny: number, around: Surroundings, spec: RfSpec): boolean {
  return around.groundVias.some(via => {
    const vx = toMm(via.at.x) - sample.x;
    const vy = toMm(via.at.y) - sample.y;
    const along = vx * sample.ux + vy * sample.uy;
    const across = vx * nx + vy * ny;
    const edge = across - spec.width.value / 2;
    return Math.abs(along) <= spec.fencePitch.value / 2 && edge > 0 && edge <= spec.fenceOffset.value;
  });
}

interface Misses { samples: number; gap: string[]; ground: string[]; reference: string[]; fence: string[] }

function measureLine(line: Track[], around: Surroundings, spec: RfSpec): Misses {
  const misses: Misses = { samples: 0, gap: [], ground: [], reference: [], fence: [] };
  const inner = spec.width.value / 2 + spec.gap.value - spec.gapTol.value;
  const outer = spec.width.value / 2 + spec.gap.value + spec.gapTol.value + GROUND_MARGIN_MM;
  const margin = fromMm(PAD_MARGIN_MM);
  for (const sample of line.flatMap(t => [...trackSamples(t)])) {
    const { x, y, ux, uy, label } = sample;
    if (around.linePads.some(pad => padHit(pad, at(x, y), margin))) continue;
    misses.samples += 1;
    if (!polygonsContain(around.referenceFill, at(x, y))) misses.reference.push(label);
    for (const side of [1, -1]) {
      const nx = -uy * side;
      const ny = ux * side;
      const near = at(x + nx * inner, y + ny * inner);
      if (otherCopper(around, near) || groundCopper(around, near)) misses.gap.push(label);
      if (!groundCopper(around, at(x + nx * outer, y + ny * outer))) misses.ground.push(label);
      if (!fenced(sample, nx, ny, around, spec)) misses.fence.push(label);
    }
  }
  return misses;
}

function* sampleChecks(misses: Misses, spec: RfSpec, verbose: boolean): Generator<RfCheck> {
  const show = (list: string[]): string => pyRepr(verbose ? list : list.slice(0, SHOWN_MISSES));
  const { gap, ground, reference, fence, samples } = misses;
  const [g, tol] = [spec.gap.text, spec.gapTol.text];
  yield { ok: samples > 0 && gap.length === 0, message: `gap >= ${g} - ${tol} mm to all other copper: ${samples} samples, ${gap.length} fail ${show(gap)}` };
  yield { ok: ground.length === 0, message: `coplanar ${spec.ground} within ${g} + ${tol} mm on both sides: ${ground.length} misses ${show(ground)}` };
  yield { ok: reference.length === 0, message: `solid ${spec.ground} on ${spec.refLayer} under the line: ${reference.length} misses ${show(reference)}` };
  yield {
    ok: fence.length === 0,
    message: `ground via fence (pitch <= ${spec.fencePitch.text}, offset <= ${spec.fenceOffset.text} mm): ${fence.length} misses ${show(fence)}`,
  };
}

/** Every check of the spec on a board with filled zones, in order. */
export function* rfChecks(board: Board, spec: RfSpec, verbose = false): Generator<RfCheck> {
  yield impedanceCheck(spec);
  const line = tracks(board).filter(t => spec.nets.has(t.net) && t.mid === null);
  yield widthCheck(line, spec);
  const lineVias = vias(board).filter(v => spec.nets.has(v.net));
  yield { ok: lineVias.length === 0, message: `RF vias: ${lineVias.length}` };
  yield linesCheck(spec);
  const distinct = distinctTracks(line);
  for (const named of spec.lines) yield lengthCheck(named, distinct, spec);
  yield* sampleChecks(measureLine(line, surroundings(board, spec), spec), spec, verbose);
}
