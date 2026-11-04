// Write the physical stackup into a board file (KiCad Board Setup > Physical Stackup), as text.
//
//   tools/set_stackup.ts BOARD.kicad_pcb [--outer-prepreg 0.2104] [--thickness 1.6]
//   tools/set_stackup.ts BOARD.kicad_pcb --dielectrics 0.2104,0.4,0.2028,0.4,0.2104
//         explicit dielectric thicknesses from the top (one per gap): prepreg / core alternate from the outside (outer
//         ones JLC 7628 prepreg Er 4.4, cores FR4 Er 4.6, inner prepregs 7628 Er 4.4), e.g. JLC06161H-7628 (D-142).
//
// The copper layer count comes from the (layers ...) list of the board. Dielectrics alternate prepreg / core from the
// outside: the two outer ones are JLC 7628 prepreg (--outer-prepreg, Er 4.4, as JLC04161H-7628 and the 7628 6-layer
// build); the inner ones share the rest of --thickness. Copper 0.035 mm outer, 0.0152 mm inner; mask 0.01 mm.
// kicad-happy (GP-001, RP-001) reads the reference layer of each signal layer from this list. With no list, or with a
// 4-layer list on a 6-layer board, it takes the wrong layer as the reference and reports false plane gaps.
// CONFIRM the dielectric thicknesses with the stackup that JLCPCB shows for the order before an impedance claim.
import { readFileSync, writeFileSync } from 'node:fs';
import { parseFlags, runMain, UsageError } from './lib/cli.ts';
import { floatRepr } from './lib/py-compat.mjs';
import { round } from './lib/py-numbers.ts';

const USAGE = 'usage: tools/set_stackup.ts BOARD.kicad_pcb [--outer-prepreg MM] [--thickness MM] [--dielectrics A,B,...]';
const OUTER_COPPER_MM = 0.035;
const INNER_COPPER_MM = 0.0152;
const MASKS_MM = 0.02;
const COPPER_LAYER = /"((?:F|B|In\d+)\.Cu)"\s+(?:signal|power|mixed|jumper)/g;

export interface Dielectric { thickness: number; kind: 'core' | 'prepreg'; material: string; epsilon: number }

const prepreg = (thickness: number): Dielectric => ({ thickness, kind: 'prepreg', material: '7628', epsilon: 4.4 });
const core = (thickness: number): Dielectric => ({ thickness, kind: 'core', material: 'FR4', epsilon: 4.6 });

const copperThicknesses = (count: number) =>
  Array.from({ length: count }, (_, i) => (i === 0 || i === count - 1 ? OUTER_COPPER_MM : INNER_COPPER_MM));

/** From the outside: prepreg, core, prepreg, ... */
export function explicitDielectrics(thicknesses: number[], copperLayers: number): Dielectric[] {
  if (thicknesses.length !== copperLayers - 1) {
    throw new Error(`${thicknesses.length} dielectrics for ${copperLayers} copper layers (need ${copperLayers - 1})`);
  }
  return thicknesses.map((thickness, i) => (i % 2 ? core(thickness) : prepreg(thickness)));
}

/** The two outer prepregs are fixed; the inner layers share what is left of the board thickness, all as FR4. */
export function derivedDielectrics(copperLayers: number, outerPrepreg: number, boardThickness: number): Dielectric[] {
  const copper = copperThicknesses(copperLayers).reduce((sum, thickness) => sum + thickness, 0);
  if (copperLayers === 2) return [core(round(boardThickness - copper - MASKS_MM, 4))];
  const rest = boardThickness - copper - MASKS_MM - 2 * outerPrepreg;
  const inner = copperLayers > 3 ? round(rest / (copperLayers - 3), 4) : 0;
  return Array.from({ length: copperLayers - 1 }, (_, i) => {
    if (i === 0 || i === copperLayers - 2) return prepreg(outerPrepreg);
    return i % 2 ? core(inner) : { ...core(inner), kind: 'prepreg' };
  });
}

const typedLayer = (name: string, type: string) => `\t\t\t(layer "${name}"\n\t\t\t\t(type "${type}")\n\t\t\t)`;
const maskLayer = (name: string, type: string) =>
  `\t\t\t(layer "${name}"\n\t\t\t\t(type "${type}")\n\t\t\t\t(thickness 0.01)\n\t\t\t\t(material "LPI")\n`
  + '\t\t\t\t(epsilon_r 3.8)\n\t\t\t\t(loss_tangent 0)\n\t\t\t)';
const copperLayer = (name: string, thickness: number) =>
  `\t\t\t(layer "${name}"\n\t\t\t\t(type "copper")\n\t\t\t\t(thickness ${floatRepr(thickness)})\n\t\t\t)`;
const dielectricLayer = (index: number, { thickness, kind, material, epsilon }: Dielectric) =>
  `\t\t\t(layer "dielectric ${index}"\n\t\t\t\t(type "${kind}")\n\t\t\t\t(thickness ${floatRepr(thickness)})\n`
  + `\t\t\t\t(material "${material}")\n\t\t\t\t(epsilon_r ${floatRepr(epsilon)})\n\t\t\t\t(loss_tangent 0.02)\n\t\t\t)`;

export function stackupText(names: string[], dielectrics: Dielectric[]): string {
  const copper = copperThicknesses(names.length);
  const stack = names.flatMap((name, i) => {
    const gap = dielectrics[i];
    return gap ? [copperLayer(name, copper[i]!), dielectricLayer(i + 1, gap)] : [copperLayer(name, copper[i]!)];
  });
  return [
    '\t\t(stackup',
    typedLayer('F.SilkS', 'Top Silk Screen'),
    typedLayer('F.Paste', 'Top Solder Paste'),
    maskLayer('F.Mask', 'Top Solder Mask'),
    ...stack,
    maskLayer('B.Mask', 'Bottom Solder Mask'),
    typedLayer('B.Paste', 'Bottom Solder Paste'),
    typedLayer('B.SilkS', 'Bottom Silk Screen'),
    '\t\t\t(copper_finish "ENIG")\n\t\t\t(dielectric_constraints no)',
    '\t\t)',
  ].join('\n');
}

function required(text: string, needle: string, from = 0): number {
  const index = text.indexOf(needle, from);
  if (index < 0) throw new Error(`no ${JSON.stringify(needle)} in the board`);
  return index;
}

const layerRank = (name: string) => (name === 'F.Cu' ? -1 : name === 'B.Cu' ? 99 : Number(name.slice(2, -3)));

/** Copper layer names of the (layers ...) list, top to bottom. */
export function copperNames(board: string): string[] {
  const start = required(board, '\n\t(layers');
  const layers = board.slice(start, required(board, '\n\t)', start));
  return [...layers.matchAll(COPPER_LAYER)].map(match => match[1]!).sort((a, b) => layerRank(a) - layerRank(b));
}

/**
 * Adds the stackup as the first child of the setup. Known bug, kept so that this writes the bytes set_stackup.py writes:
 * an old stackup is not removed, the new one goes in front of it. KiCad keeps the last block, so on a board that already
 * has a stackup the new values are lost at the next KiCad save, although the tool reports them.
 */
export function withStackup(board: string, stackup: string): string {
  const old = board.indexOf('\n\t\t(stackup');
  if (old >= 0) return board.slice(0, old + 1) + stackup + board.slice(old + 2);
  const setup = required(board, '\n\t(setup') + '\n\t(setup'.length;
  return `${board.slice(0, setup)}\n${stackup}${board.slice(setup)}`;
}

function millimetres(value: string | undefined, fallback: number): number {
  if (value === undefined) return fallback;
  if (!value.trim() || Number.isNaN(Number(value))) throw new UsageError(USAGE);
  return Number(value);
}

function dielectricList(text: string): number[] {
  return text.split(',').map(item => {
    if (!item.trim() || Number.isNaN(Number(item))) throw new Error(`not a thickness: ${JSON.stringify(item)}`);
    return Number(item);
  });
}

function main(argv: string[]): number {
  const { values, positionals } = parseFlags(argv, {
    'outer-prepreg': { type: 'string' }, thickness: { type: 'string' }, dielectrics: { type: 'string' },
  }, USAGE);
  const [path] = positionals;
  if (positionals.length !== 1 || path === undefined) throw new UsageError(USAGE);
  const outerPrepreg = millimetres(values['outer-prepreg'], 0.2104);
  const thickness = millimetres(values.thickness, 1.6);
  const board = readFileSync(path, 'utf8');
  const names = copperNames(board);
  const dielectrics = values.dielectrics
    ? explicitDielectrics(dielectricList(values.dielectrics), names.length)
    : derivedDielectrics(names.length, outerPrepreg, thickness);
  writeFileSync(path, withStackup(board, stackupText(names, dielectrics)));
  const shown = dielectrics.map(gap => floatRepr(gap.thickness)).join(' ');
  console.log(`set_stackup: ${names.length} copper layers ${names.join(' ')}; dielectrics (mm): ${shown}`);
  return 0;
}

runMain(import.meta.url, main);
