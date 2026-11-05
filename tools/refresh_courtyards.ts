// Refresh the courtyards of a board or block from the iot-lab footprint library (D-051).
//
//   tools/refresh_courtyards.ts [--lib hardware-design/blocks/iot-lab.pretty] [--dry-run] BOARD.kicad_pcb
//
// For each footprint "iot-lab:<C>" the F.CrtYd items are replaced by the courtyard box of <lib>/<C>.kicad_mod.
// Nothing else changes: other footprints, pads, silk, fab, models and placement stay. Footprint graphics in a
// .kicad_pcb are in footprint coordinates, so the library box applies as is. A bottom-side iot-lab footprint or a
// missing library footprint stops the tool (exit 1) and the board is not written.
import { createHash } from 'node:crypto';
import { readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseFlags, runMain, UsageError } from './lib/cli.ts';
import { courtyardBox, setCourtyard, type Box } from './lib/courtyard.ts';
import { floatRepr } from './lib/py-compat.mjs';
import { projectRoot } from './lib/project-root.mjs';
import { listEnd } from './lib/sexpr.ts';

const USAGE = 'usage: tools/refresh_courtyards.ts [--lib DIR] [--dry-run] BOARD.kicad_pcb';
const URL_NAMESPACE = Buffer.from('6ba7b8119dad11d180b400c04fd430c8', 'hex');

export interface Refreshed { ref: string; code: string; old: Box | null; box: Box }

/** uuid.uuid5(uuid.NAMESPACE_URL, name): the same footprint gets the same courtyard uuid on every run. */
export function urlUuid5(name: string): string {
  const bytes = createHash('sha1').update(URL_NAMESPACE).update(name).digest().subarray(0, 16);
  bytes[6] = (bytes[6]! & 0x0f) | 0x50;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = bytes.toString('hex');
  return [hex.slice(0, 8), hex.slice(8, 12), hex.slice(12, 16), hex.slice(16, 20), hex.slice(20)].join('-');
}

function libraryBox(lib: string, ref: string, code: string): Box {
  const file = join(lib, `${code}.kicad_mod`);
  if (!statSync(file, { throwIfNoEntry: false })?.isFile()) throw new Error(`${ref} (${code}): no library footprint ${file}`);
  const box = courtyardBox(readFileSync(file, 'utf8'));
  if (!box) throw new Error(`${ref} (${code}): ${file} has no courtyard`);
  return box;
}

export function refresh(text: string, lib: string): { text: string; rows: Refreshed[] } {
  const rows: Refreshed[] = [];
  const parts: string[] = [];
  let position = 0;
  for (const match of text.matchAll(/\(footprint "iot-lab:([^"]+)"/g)) {
    if (match.index < position) continue;
    const end = listEnd(text, match.index);
    const footprint = text.slice(match.index, end);
    const code = match[1]!;
    const ref = /\(property "Reference" "([^"]*)"/.exec(footprint)?.[1] ?? '?';
    if (!/^\(footprint "[^"]+"\s+\(layer "F\.Cu"\)/.test(footprint)) {
      throw new Error(`${ref} (${code}): not on F.Cu; only top-side footprints are supported`);
    }
    const box = libraryBox(lib, ref, code);
    const id = /\(uuid "([^"]+)"\)/.exec(footprint)?.[1] ?? ref;
    rows.push({ ref, code, old: courtyardBox(footprint), box });
    parts.push(text.slice(position, match.index), setCourtyard(footprint, box, urlUuid5(`crtyd:${id}`)));
    position = end;
  }
  return { text: parts.join('') + text.slice(position), rows };
}

const showBox = (box: Box | null) => (box ? `(${box.map(floatRepr).join(', ')})` : 'None');

function main(argv: string[]): number {
  const { values, positionals } = parseFlags(argv, { lib: { type: 'string' }, 'dry-run': { type: 'boolean' } }, USAGE);
  const [board] = positionals;
  if (positionals.length !== 1 || board === undefined) throw new UsageError(USAGE);
  const dryRun = values['dry-run'] ?? false;
  const lib = values.lib ?? join(projectRoot(), 'hardware-design/blocks/iot-lab.pretty');
  const before = readFileSync(board, 'utf8');
  let result: ReturnType<typeof refresh>;
  try {
    result = refresh(before, lib);
  } catch (error) {
    throw new UsageError(`${board}: ${(error as Error).message}`, 1);
  }
  for (const row of result.rows) console.log(`${row.ref}\t${row.code}\t${showBox(row.old)} -> ${showBox(row.box)}`);
  const changed = result.text !== before;
  console.log(`${result.rows.length} footprints, ${changed ? 'changed' : 'no change'}${dryRun ? ' (dry run)' : ''}`);
  if (changed && !dryRun) writeFileSync(board, result.text);
  return 0;
}

runMain(import.meta.url, main);
