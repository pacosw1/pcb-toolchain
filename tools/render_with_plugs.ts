// Render a board with the mating plugs on its pluggable headers (render only).
//
//   tools/render_with_plugs.ts BOARD [OUT.png]
//
// The tool never writes a board file. It copies BOARD.kicad_pcb and BOARD.kicad_pro to a temporary folder, adds the
// plug STEP as a second 3D model to each header footprint in the copy, and runs kicad-cli pcb render on the copy.
//
// Header -> plug map, parsed live from the board sources (no stored map):
//   - hardware-design/boards/BOARD/CANDIDATE-BOM.csv: rows "Mating plug(s) for J1[/J2]".
//   - hardware-design/boards/BOARD/SPEC.md: a table cell "<header> C<n> ... plug ... C<m>".
// A header footprint is "iot-lab:C<n>". The plug model and its mated height come from
// hardware-design/registry/cad-assets/C<m>/MANIFEST.json (model_3d.file, mate.z_bottom).
// A header with a plug in the map but no plug model stops the tool (fail closed).
import { spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { runMain, UsageError } from './lib/cli.ts';
import { kiCadPaths } from './lib/env-paths.mjs';
import { readJson } from './lib/json-file.ts';
import { projectRoot } from './lib/project-root.mjs';
import { dictRows, Float, jsonDumps } from './lib/py-compat.mjs';
import { formatG, round } from './lib/py-numbers.ts';
import { listEnd } from './lib/sexpr.ts';

const USAGE = 'usage: tools/render_with_plugs.ts BOARD [OUT.png]';
const RENDER = ['--side', 'top', '--quality', 'high', '--perspective', '--rotate', '-30,0,20',
  '--zoom', '0.9', '-w', '1600', '-h', '1100'];
const COURTYARD_MARGIN_MM = 0.25; // D-051: courtyard = body + 0.25 mm

/** Header C-number to plug C-number. */
export type PlugMap = Map<string, string>;
type Box = readonly [number, number, number, number];
type Xyz = readonly [number, number, number];

export interface HeaderFootprint {
  code: string;
  start: number;
  /** Index of the closing paren. */
  end: number;
  padX: number[];
  courtyard: Box | null;
}
export interface PlugPose { offset: Xyz; rotation: number }
interface Placed extends PlugPose { header: string; plug: string }
interface PlugManifest { model_3d: { file: string }; mate?: { z_bottom: number } }

export function mergeMaps(...maps: PlugMap[]): PlugMap {
  const merged: PlugMap = new Map();
  for (const [header, plug] of maps.flatMap(map => [...map])) {
    const known = merged.get(header);
    if (known !== undefined && known !== plug) throw new Error(`header ${header}: two plugs ${known} and ${plug}`);
    merged.set(header, plug);
  }
  return merged;
}

/** The "Mating plug(s) for J.." rows of a CANDIDATE-BOM. */
export function plugsFromBom(text: string): PlugMap {
  const rows = dictRows(text);
  const lcsc = (row: Map<string, string | null>) => row.get('LCSC') ?? '';
  const byRef = new Map(rows.flatMap(row =>
    (row.get('Designator') ?? '').split(/[,\s]+/).filter(Boolean).map(ref => [ref, row] as const)));
  const plugs: PlugMap[] = [];
  for (const row of rows) {
    const match = /\bplugs?\b.*?\bfor (J\d+(?:\s*\/\s*J\d+)*)/i.exec(row.get('Function') ?? '');
    for (const ref of match?.[1]!.split(/\s*\/\s*/) ?? []) {
      const header = byRef.get(ref);
      if (!header) throw new Error(`no BOM row for ${ref}`);
      plugs.push(new Map([[lcsc(header), lcsc(row)]]));
    }
  }
  return mergeMaps(...plugs);
}

/** SPEC.md table cells "<header> C<n> ... plug ... C<m>". */
export function plugsFromSpec(text: string): PlugMap {
  const cells = text.split('\n').filter(line => line.trimStart().startsWith('|')).flatMap(line => line.split('|'));
  const matches = cells.map(cell => /\b(C\d{3,})\b.*?\bplugs?\b.*?\b(C\d{3,})\b/.exec(cell));
  return mergeMaps(...matches.filter(match => match !== null).map(match => new Map([[match[1]!, match[2]!]])));
}

function courtyardOf(footprint: string): Box | null {
  const points: [number, number][] = [];
  for (const graphic of footprint.matchAll(/\((?:fp_rect|fp_line|fp_poly)\b/g)) {
    const item = footprint.slice(graphic.index, listEnd(footprint, graphic.index));
    if (!item.includes('(layer "F.CrtYd")')) continue;
    for (const [, x, y] of item.matchAll(/\((?:start|end|xy) (-?[\d.]+) (-?[\d.]+)\)/g)) points.push([Number(x), Number(y)]);
  }
  if (!points.length) return null;
  const xs = points.map(point => point[0]);
  const ys = points.map(point => point[1]);
  return [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)];
}

/** The iot-lab:C<n> footprints of a board, geometry in the footprint frame. */
export function footprints(text: string): HeaderFootprint[] {
  return [...text.matchAll(/\(footprint "iot-lab:(C\d+)"/g)].map(match => {
    const end = listEnd(text, match.index) - 1;
    const body = text.slice(match.index, end);
    const padX = [...body.matchAll(/\(pad "[^"]*"[^(]*\(at (-?[\d.]+) -?[\d.]+/g)].map(pad => Number(pad[1]));
    return { code: match[1]!, start: match.index, end, padX: padX.sort((a, b) => a - b), courtyard: courtyardOf(body) };
  });
}

/**
 * KiCad model offset (mm, model frame, Y up) and Z rotation of the plug model. Pins are on footprint y 0. The mating
 * opening is the courtyard side farther from the pins; the header front face is that edge minus the courtyard margin.
 * The plug model has its shoulder at y 0 and its wires to model +y, so an opening on footprint +y (model -y) turns the
 * plug 180 degrees.
 */
export function plugTransform([, y0, , y1]: Box, padX: number[], zBottom: number): PlugPose {
  const openingPlusY = Math.abs(y1) >= Math.abs(y0);
  const front = openingPlusY ? y1 - COURTYARD_MARGIN_MM : y0 + COURTYARD_MARGIN_MM;
  const centre = (Math.min(...padX) + Math.max(...padX)) / 2;
  return { offset: [round(centre, 4) + 0, round(-front, 4) + 0, zBottom], rotation: openingPlusY ? 180 : 0 };
}

/** The text with one more (model ...) at the end of the footprint. */
export function addModel(text: string, footprint: HeaderFootprint, path: string, { offset, rotation }: PlugPose): string {
  const model = `\t(model "${path}" (offset (xyz ${offset.map(formatG).join(' ')})) `
    + `(scale (xyz 1 1 1)) (rotate (xyz 0 0 ${formatG(rotation)})))\n\t`;
  return `${text.slice(0, footprint.end).trimEnd()}\n\t${model}${text.slice(footprint.end)}`;
}

function boardPlugMap(root: string, board: string): PlugMap {
  const folder = join(root, 'hardware-design/boards', board);
  const sources: [string, (text: string) => PlugMap][] = [['CANDIDATE-BOM.csv', plugsFromBom], ['SPEC.md', plugsFromSpec]];
  const maps = sources.filter(([name]) => existsSync(join(folder, name)))
    .map(([name, parse]) => parse(readFileSync(join(folder, name), 'utf8')));
  return mergeMaps(...maps);
}

function plugModel(root: string, code: string): { model: string; zBottom: number } {
  const folder = join(root, 'hardware-design/registry/cad-assets', code);
  const manifest = readJson<PlugManifest>(join(folder, 'MANIFEST.json'));
  const model = join(folder, manifest.model_3d.file);
  if (!existsSync(model) || !manifest.mate) throw new Error(`${code}: no plug model or mate data`);
  return { model, zBottom: manifest.mate.z_bottom };
}

/** Adds the plugs from the last footprint to the first, so the earlier spans stay valid. Placed is in that order. */
function withPlugs(root: string, text: string, plugs: PlugMap): { text: string; placed: Placed[] } {
  const placed: Placed[] = [];
  let result = text;
  for (const footprint of footprints(text).reverse()) {
    const plug = plugs.get(footprint.code);
    if (!plug) continue;
    if (!footprint.courtyard || !footprint.padX.length) throw new Error(`${footprint.code}: footprint has no courtyard or pads`);
    const { model, zBottom } = plugModel(root, plug);
    const pose = plugTransform(footprint.courtyard, footprint.padX, zBottom);
    result = addModel(result, footprint, model, pose);
    placed.push({ ...pose, header: footprint.code, plug });
  }
  return { text: result, placed };
}

function render(root: string, board: string, out: string): Placed[] {
  const cad = join(root, 'hardware-design/boards', board, 'cad', board);
  const plugs = boardPlugMap(root, board);
  const folder = mkdtempSync(join(tmpdir(), 'render-plugs-'));
  try {
    for (const extension of ['.kicad_pcb', '.kicad_pro']) copyFileSync(join(cad, board + extension), join(folder, board + extension));
    const pcb = join(folder, `${board}.kicad_pcb`);
    const { text, placed } = withPlugs(root, readFileSync(pcb, 'utf8'), plugs);
    writeFileSync(pcb, text);
    const { kicadCli } = kiCadPaths(process.platform, homedir(), process.env);
    const run = spawnSync(kicadCli, ['pcb', 'render', ...RENDER, '-o', resolve(out), pcb],
      { env: { ...process.env, IOT_LAB: root }, encoding: 'utf8' });
    if (run.status !== 0 || !existsSync(out)) throw new Error(run.stderr.slice(-800) || run.stdout.slice(-800));
    return placed;
  } finally {
    rmSync(folder, { recursive: true, force: true });
  }
}

function main(argv: string[]): number {
  const [board, out = `${board}-plugs.png`] = argv;
  if (board === undefined) throw new UsageError(USAGE, 1);
  for (const { header, plug, offset, rotation } of render(projectRoot(), board, out).reverse()) {
    console.log(jsonDumps({ header, plug, offset: offset.map(value => new Float(value)), rotate_z: rotation }));
  }
  console.log(out);
  return 0;
}

runMain(import.meta.url, main);
