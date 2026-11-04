// Check each assembled part of a board against JLC's own EasyEDA data for its LCSC part (no network).
//
//   tools/easyeda_audit.ts <BOARD> [--json OUT]
//
// JLC places a part from the CPL with its own library footprint, which is the EasyEDA footprint of the C-number
// (hardware-design/registry/cad-assets/<C>/easyeda-bridge-source.json: the symbol and the footprint, as LCSC serves them).
// For each line of <board>/cad/fab/<BOARD>-BOM-JLC.csv and each designator on it:
//
// 1. Footprint frame. The pads of the board footprint (footprint frame, rotation 0) must be the EasyEDA pads: the same
//    pad numbers at the same places (tolerance 0.05 mm) about the same origin. Then the CPL point and rotation from
//    KiCad are the JLC point and rotation. Result FRAME_OK, or ROTATED <deg> (the KiCad footprint is the EasyEDA one
//    turned: the CPL needs that correction), OFFSET <dx,dy> (origin moved: the part lands off its pads), NUMBERING
//    (the pad numbers are at other places: pin 1 of the part is not on pad 1 of the board), or NO_SOURCE.
// 2. Pin names. The schematic symbol pin names per pin number (kicad-cli netlist) against the EasyEDA symbol pin names
//    per pin number. A diode or LED with K and A swapped is a NAME_SWAP. Two-pin parts with no pin names (R, C, L,
//    ferrite, fuse) are skipped. Names that only differ in spelling are listed as NAME_DIFF for a person to read.
//
// Exit 1 when any part is NUMBERING, OFFSET, ROTATED, NAME_SWAP or NO_SOURCE. NAME_DIFF does not fail; read each one.
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { normalize180 } from './lib/board-hit.ts';
import { boardJson } from './lib/board-json.ts';
import type { Footprint } from './lib/board-types.ts';
import { parseFlags, runMain, UsageError } from './lib/cli.ts';
import { easyedaPads, easyedaPins, footprintPads, frameVerdict, pinVerdict, schematicParts, type EasyedaPart, type SchematicPart } from './lib/easyeda-audit.ts';
import { kiCadPaths } from './lib/env-paths.mjs';
import { dictRows, Float, jsonDumps, readText, strip } from './lib/py-compat.mjs';
import { projectRoot } from './lib/project-root.mjs';

const USAGE = 'usage: tools/easyeda_audit.ts BOARD [--json OUT]';
const VALUE_WIDTH = 22;

interface Row {
  ref: string; code: string; value?: string; footprint?: string; symbol?: string; rotation?: Float;
  frame: string; frame_note: string; pins?: string; pins_note?: string;
}

function easyedaSource(assets: string, code: string): EasyedaPart | null {
  const file = join(assets, code, 'easyeda-bridge-source.json');
  return existsSync(file) ? (JSON.parse(readFileSync(file, 'utf8')) as { result: EasyedaPart }).result : null;
}

/** The schematic's parts. The kicadsexpr netlist holds what kicadxml does, and tools/lib/sexpr.ts reads it. */
function schematicNetlist(sch: string): Map<string, SchematicPart> {
  const { kicadCli } = kiCadPaths(process.platform, homedir(), process.env);
  const folder = mkdtempSync(join(tmpdir(), 'easyeda-audit-'));
  try {
    const out = join(folder, 'netlist.net');
    const run = spawnSync(kicadCli, ['sch', 'export', 'netlist', '--format', 'kicadsexpr', '-o', out, sch], { stdio: 'ignore' });
    if (run.status !== 0) throw new Error(`kicad-cli sch export netlist of ${sch} ended with ${run.status}`);
    return schematicParts(readFileSync(out, 'utf8'));
  } finally {
    rmSync(folder, { recursive: true, force: true });
  }
}

function auditPart(ref: string, code: string, value: string, footprint: Footprint | undefined, source: EasyedaPart | null, part: SchematicPart | undefined): Row {
  if (!footprint) return { ref, code, frame: 'MISSING', frame_note: 'not on the board' };
  const frame = frameVerdict(source && easyedaPads(source), footprintPads(footprint));
  const pins = pinVerdict(part?.pins ?? new Map(), source ? easyedaPins(source) : new Map());
  return {
    ref, code, value, footprint: footprint.lib_id, symbol: part?.symbol ?? '', rotation: new Float(normalize180(footprint.orientation)),
    frame: frame.status, frame_note: frame.note, pins: pins.status, pins_note: pins.note,
  };
}

function summary(board: string, rows: Row[]): string {
  const counts = new Map<string, number>();
  for (const key of rows.flatMap(row => [row.frame, row.pins ?? '-'])) counts.set(key, (counts.get(key) ?? 0) + 1);
  const shown = [...counts].sort(([a], [b]) => (a < b ? -1 : 1)).map(([key, count]) => `${key} ${count}`);
  return `easyeda_audit ${board}: ${rows.length} parts; ${shown.join(', ')}`;
}

function detail(row: Row): string {
  const value = [...(row.value ?? '')].slice(0, VALUE_WIDTH).join('');
  return `  ${row.ref.padEnd(6)} ${row.code.padEnd(10)} ${value.padEnd(VALUE_WIDTH)} ${row.frame} ${row.frame_note} | ${row.pins ?? 'None'} ${row.pins_note ?? ''}`;
}

function main(argv: string[]): number {
  const { values, positionals } = parseFlags(argv, { json: { type: 'string' } }, USAGE);
  const [board] = positionals;
  if (board === undefined || positionals.length !== 1) throw new UsageError(USAGE);
  const root = projectRoot();
  const folder = join(root, 'hardware-design/boards', board);
  const gate = JSON.parse(readFileSync(join(folder, 'gate.json'), 'utf8')) as { project: string };
  const stem = join(folder, gate.project);
  const footprints = new Map(boardJson(`${stem}.kicad_pcb`).board.footprints.map(f => [f.reference, f]));
  const parts = schematicNetlist(`${stem}.kicad_sch`);
  const assets = join(root, 'hardware-design/registry/cad-assets');
  const rows: Row[] = [];
  for (const line of dictRows(readText(join(folder, 'cad/fab', `${basename(stem)}-BOM-JLC.csv`)))) {
    const code = strip(line.get('LCSC Part #') ?? '');
    const source = easyedaSource(assets, code);
    for (const ref of (line.get('Designator') ?? '').split(',').map(strip).filter(Boolean)) {
      rows.push(auditPart(ref, code, line.get('Comment') ?? '', footprints.get(ref), source, parts.get(ref)));
    }
  }
  console.log(summary(board, rows));
  for (const row of rows.filter(r => r.frame !== 'FRAME_OK' || r.pins === 'NAME_SWAP' || r.pins === 'NAME_DIFF')) console.log(detail(row));
  if (values.json !== undefined) writeFileSync(values.json, jsonDumps(rows, 1));
  return rows.some(row => row.frame !== 'FRAME_OK' || row.pins === 'NAME_SWAP') ? 1 : 0;
}

runMain(import.meta.url, main);
