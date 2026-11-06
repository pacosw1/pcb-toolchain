// Add bring-up test points to a board: schematic symbols and placed footprints, linked for schematic parity.
//
//   tools/add_testpoints.ts hardware-design/boards/<BOARD> [--dry-run]
//
// Reads <board>/testpoints.json:
//   {"about": "...", "project": "cad/X/X", "sheet_area": [x0, y0, x1, y1],
//    "points": [{"ref": "TP12", "net": "VBUS", "kind": "smd" | "tht", "power": "power:VBUS" | null,
//                "near": "J1.A4" | [x, y], "max_mm": 8, "label": "VBUS", "track_only": false}, ...]}
// - track_only true: the pad must sit on a F.Cu track of its net (no route); use it where the router cannot reach a pad.
// - label: a 0.8 mm F.Silkscreen text beside the pad, or a list: the first that fits (a short form last). The reference stays on
//   F.Fab, hidden (D-040: no reference on silk).
// - kind smd: TestPoint:TestPoint_Pad_D1.5mm. kind tht: TestPoint:TestPoint_THTPad_D2.5mm_Drill1.2mm (a probe clip or a ground
//   hook fits; on a plane net it connects through the inner plane, so it needs no route).
// - power: a global net gets the power symbol of that name, its Value set to the net (as TP1-TP4 of BASE-PWR).
//   null: a root-sheet net ("/NAME" on the board) gets a short wire and a local label (as TP10).
// - The symbols go in a column grid inside sheet_area (an empty area of the root sheet; give it, the tool does not search). in_bom
//   no, the Description is the one of the existing test points: a bare copper pad, not assembled.
// - smd: first choice is a point on a F.Cu track of its own net (no route needed; not over a via or a pad).
// - Else each footprint goes to the free grid point (0.25 mm) nearest to "near": courtyard box at least 0.5 mm from other
//   courtyards (1.0 mm from U and J parts, D-040), clear of silk art and text (both sides for tht), its pad at least the class
//   clearance + 0.1 mm from copper of other nets on its layers (all copper layers for tht), not in a rule area, 1.0 mm inside the
//   board outline and away from each cut-out (the real outline polygon, not its bounding box).
//   A point with no free place within max_mm stops the tool (nothing is written).
// The routes come after this tool (existing copper kept). Then the gate.
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { BoardEdit, itemIds, saveBoardInPlace } from './lib/board-edit.ts';
import { textText } from './lib/board-items.ts';
import { boardJson } from './lib/board-json.ts';
import { netClass, projectOf, type ProjectFile } from './lib/board-obstacles.ts';
import { readSilk } from './lib/board-silk.ts';
import type { Board } from './lib/board-types.ts';
import { parseFlags, runMain, UsageError } from './lib/cli.ts';
import { kicadShared } from './lib/env.mjs';
import { readJson } from './lib/json-file.ts';
import { projectRoot } from './lib/project-root.mjs';
import { processWriter, sealedWrite } from './lib/cad-seal.ts';
import { fixed, pyRepr } from './lib/py-compat.mjs';
import { LABEL_PEN, LABEL_SIZE, TestPointBoard, type Kind, type PointSpec } from './lib/testpoint-place.ts';
import { embedLibSymbols, FOOTPRINTS, footprintText, LIBRARY, padShape, sheetSpot, symbolSources, symbolText, usedLibIds } from './lib/testpoint-text.ts';

const USAGE = 'usage: tools/add_testpoints.ts BOARD_DIR [--dry-run]';
const STEP_MM = 0.25;
const DEFAULT_MAX_MM = 8;
const SHEET_END = '\n\t(sheet_instances';

export interface TestPointsFile { about?: string; project: string; sheet_area: [number, number, number, number]; points: PointSpec[] }
export type Libraries = Record<Kind, string>;
export interface Inputs { board: Board; project: ProjectFile; pcbText: string; schematic: string; libraries: Libraries }
export interface Plan { pcbText: string; symbols: string[]; lines: string[] }

const stop = (message: string): UsageError => new UsageError(`add_testpoints: ${message}`, 1);
const netName = (net: string): string => net.replace(/^\/+/, '');
const nearText = ({ near }: PointSpec): string => (typeof near === 'string' ? near : `[${near.join(', ')}]`);

function checkSpec({ points }: TestPointsFile, { board, schematic }: Inputs): void {
  const references = new Set(board.footprints.map(footprint => footprint.reference));
  for (const { ref, net, power } of points) {
    if (references.has(ref) || schematic.includes(`"Reference" "${ref}"`)) throw stop(`${ref} is already on the board or in the schematic`);
    if (!(net in board.nets)) throw stop(`no net ${net} on the board`);
    if (power && !schematic.includes(`(symbol "${power}"`)) throw stop(`the schematic has no embedded symbol ${power}`);
  }
}

const labelsOf = ({ label }: PointSpec): string[] => (typeof label === 'string' ? [label] : label ?? []);

/** Every place, symbol and label, or an error: nothing is written until all points have a place. */
export function planTestPoints(spec: TestPointsFile, inputs: Inputs): Plan {
  checkSpec(spec, inputs);
  const { board, project, pcbText, libraries } = inputs;
  const clearanceOf = (net: string): number => netClass(project, board.nets[net]!).clearance;
  const site = new TestPointBoard(board, readSilk(pcbText), clearanceOf);
  const edit = new BoardEdit(pcbText);
  const next = itemIds(pcbText, 'add-testpoints');
  const symbols: string[] = [];
  const lines: string[] = [];
  spec.points.forEach((point, k) => {
    const { ref, net, kind, power } = point;
    const pad = padShape(libraries[kind]);
    const maxMm = point.max_mm ?? DEFAULT_MAX_MM;
    const spot = site.place(point, pad);
    if (!spot && point.track_only) throw stop(`${ref} (${net}) is track_only and has no place on a F.Cu track of its net within ${maxMm} mm of ${nearText(point)}`);
    if (!spot) throw stop(`no free place for ${ref} (${net}) within ${maxMm} mm of ${nearText(point)}`);
    const sheet = sheetSpot(spec.sheet_area, k);
    if (!sheet) throw stop('sheet_area is too small');
    const name = FOOTPRINTS[kind];
    const value = netName(net);
    const symbol = symbolText({ ref, value, footprint: name, net, power, ...sheet, next });
    symbols.push(symbol.text);
    edit.add(footprintText(libraries[kind], { name, ref, value, net, kind, at: spot.at, symbol: symbol.uuid, next }));
    const texts = labelsOf(point);
    const label = site.label(texts, spot.at, pad.radius);
    if (label) edit.add(textText({ text: label.text, at: label.at, layer: 'F.SilkS', size: LABEL_SIZE, thickness: LABEL_PEN, uuid: next() }));
    else if (texts.length) lines.push(`${ref}: no clear place for a silk label ${pyRepr(texts)}`);
    site.add(point, spot.at, pad);
    lines.push(`${ref} ${net}: (${fixed(spot.at.x / 1e6, 2)}, ${fixed(spot.at.y / 1e6, 2)}), ${fixed(spot.distance * STEP_MM, 2)} mm from ${nearText(point)}`
      + `, ${spot.onTrack ? 'on a F.Cu track of its net' : 'needs a route'}${label ? `, label ${label.text}` : ''}`);
  });
  return { pcbText: edit.text(), symbols, lines };
}

/** The schematic with the symbols before its sheet_instances and their definitions embedded. */
export function schematicWith(schematic: string, symbols: string[], sources: string[]): { text: string; embedded: string[] } {
  const end = schematic.indexOf(SHEET_END);
  if (end < 0) throw stop('the schematic has no sheet_instances');
  try {
    return embedLibSymbols(`${schematic.slice(0, end)}\n${symbols.join('\n')}${schematic.slice(end)}`, usedLibIds(symbols), sources);
  } catch (error) {
    throw stop(`${(error as Error).message} to embed`);
  }
}

const library = (kind: Kind): string => readFileSync(join(kicadShared, 'footprints', `${LIBRARY}.pretty`, `${FOOTPRINTS[kind]}.kicad_mod`), 'utf8');

function main(argv: string[]): number {
  const { values, positionals } = parseFlags(argv, { 'dry-run': { type: 'boolean' } }, USAGE);
  const [folder] = positionals;
  if (positionals.length !== 1 || folder === undefined) throw new UsageError(USAGE);
  const specFile = join(folder, 'testpoints.json');
  if (!existsSync(specFile)) throw new Error(`no ${specFile}`);
  const spec = readJson<TestPointsFile>(specFile);
  const [sheet, pcb] = [`${join(folder, spec.project)}.kicad_sch`, `${join(folder, spec.project)}.kicad_pcb`];
  const schematic = readFileSync(sheet, 'utf8');
  const plan = planTestPoints(spec, {
    board: boardJson(pcb).board, project: projectOf(pcb), pcbText: readFileSync(pcb, 'utf8'), schematic, libraries: { smd: library('smd'), tht: library('tht') },
  });
  for (const line of plan.lines) console.log(line);
  if (values['dry-run']) {
    console.log('dry run: nothing written');
    return 0;
  }
  const { text, embedded } = schematicWith(schematic, plan.symbols, symbolSources(sheet, projectRoot()));
  for (const id of embedded) console.log(`add_testpoints: embedded the ${id} symbol definition`);
  sealedWrite(sheet, processWriter(), () => writeFileSync(sheet, text));
  try {
    saveBoardInPlace(pcb, plan.pcbText);
  } catch (error) {
    sealedWrite(sheet, processWriter(), () => writeFileSync(sheet, schematic));
    throw error;
  }
  console.log(`add_testpoints: ${spec.points.length} test points added to ${sheet} and ${pcb}`);
  return 0;
}

runMain(import.meta.url, main);
