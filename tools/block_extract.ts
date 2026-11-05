// Cut a KiCad design block out of a flat board: schematic by box, PCB by reference list.
//
//   tools/block_extract.ts SRC_DIR/BOARD BLOCK_DIR ID --sch-box X0 Y0 X1 Y1 --refs J2 F1 ... [--margin 2] [--swap D4=Diode_SMD:D_SMA]
//
// 1. Schematic: keep every item that lies fully inside --sch-box, the lib_symbols it uses and the root uuid, so footprint
//    paths /<symbol uuid> keep parity. The project name becomes ID.
// 2. PCB: keep the --refs footprints, the tracks and vias of their nets inside the part box (+ --margin), copper zones of
//    those nets clipped to that box, and non-edge drawings inside it. A new Edge.Cuts rectangle is the box.
// 3. --swap REF=LIB:NAME replaces a footprint from the KiCad library (position, fields, path and pad nets kept) and sets the
//    same Footprint field in the schematic. KICAD_FP names the footprint folder.
// 4. BOARD.kicad_pro and .kicad_dru are copied as ID.*. The output is a proposal; DRC with --schematic-parity decides.
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { cropSchematic, cutBoard, referenceOf, setSchematicFootprint, swapFootprint, topForms, type Rect } from './lib/block-extract.ts';
import { runMain, UsageError } from './lib/cli.ts';

const USAGE = 'usage: block_extract BOARD OUT_DIR ID --sch-box X0 Y0 X1 Y1 --refs REF... [--margin MM] [--swap REF=LIB:NAME...]';
const DEFAULT_LIBRARIES = '/Applications/KiCad/KiCad.app/Contents/SharedSupport/footprints';
const DEFAULT_MARGIN_MM = 2;

interface Arguments { board: string; out: string; id: string; schematicBox: Rect; refs: string[]; margin: number; swaps: Map<string, string> }

function parse(argv: string[]): Arguments {
  const positional: string[] = [];
  const flags = new Map<string, string[]>();
  let current: string[] = positional;
  for (const word of argv) {
    if (/^--[a-z]/.test(word)) flags.set(word, current = []);
    else current.push(word);
  }
  const [board, out, id, ...rest] = positional;
  const box = (flags.get('--sch-box') ?? []).map(Number);
  const refs = flags.get('--refs') ?? [];
  const known = new Set(['--sch-box', '--refs', '--margin', '--swap']);
  const margin = Number(flags.get('--margin')?.[0] ?? DEFAULT_MARGIN_MM);
  const swaps = (flags.get('--swap') ?? []).map(row => row.split('='));
  if (!board || !out || !id || rest.length || box.length !== 4 || box.some(Number.isNaN) || !refs.length || Number.isNaN(margin)
      || [...flags.keys()].some(flag => !known.has(flag)) || swaps.some(row => row.length !== 2 || !row[1]?.includes(':'))) throw new UsageError(USAGE);
  return { board, out, id, schematicBox: box as unknown as Rect, refs, margin, swaps: new Map(swaps as [string, string][]) };
}

function swappedFootprints(text: string, swaps: Map<string, string>): Map<string, string> {
  const libraries = process.env.KICAD_FP ?? DEFAULT_LIBRARIES;
  const rows = topForms(text).filter(row => row.form[0] === 'footprint');
  return new Map([...swaps].map(([reference, footprint]) => {
    const row = rows.find(item => referenceOf(item.form) === reference);
    if (!row) throw new Error(`block_extract: refs not on the board: ["${reference}"]`);
    const [library, name] = footprint.split(':') as [string, string];
    const moduleText = readFileSync(join(libraries, `${library}.pretty`, `${name}.kicad_mod`), 'utf8');
    return [reference, swapFootprint(text.slice(row.span[0], row.span[1]), row.form, library, name, moduleText)];
  }));
}

function main(argv: string[]): number {
  const args = parse(argv);
  try {
    return cut(args);
  } catch (error) {
    throw new UsageError((error as Error).message, 1);
  }
}

function cut({ board, out, id, schematicBox, refs, margin, swaps }: Arguments): number {
  mkdirSync(out, { recursive: true });
  const target = join(out, id);
  let schematic = cropSchematic(readFileSync(`${board}.kicad_sch`, 'utf8'), schematicBox, id);
  for (const [reference, footprint] of swaps) schematic = setSchematicFootprint(schematic, reference, footprint);
  writeFileSync(`${target}.kicad_sch`, schematic);
  for (const extension of ['.kicad_pro', '.kicad_dru']) if (existsSync(board + extension)) copyFileSync(board + extension, target + extension);
  const text = readFileSync(`${board}.kicad_pcb`, 'utf8');
  const result = cutBoard(text, refs, margin, swappedFootprints(text, swaps));
  writeFileSync(`${target}.kicad_pcb`, result.text);
  const size = (axis: 0 | 1) => (result.box[axis + 2] as number - (result.box[axis] as number)).toFixed(1);
  console.log(`block_extract: ${id}: ${result.parts} parts, box ${size(0)} x ${size(1)} mm, ${result.tracks} tracks/vias, ${result.zones} zones -> ${out}`);
  return 0;
}

runMain(import.meta.url, main);
