// Copy the new copper of some nets from a routed candidate onto a base board.
//
//   tools/import_nets.ts BASE.kicad_pcb CANDIDATE.kicad_pcb OUT.kicad_pcb --nets A,B,C
//
// New copper is a track or via of CANDIDATE whose uuid is not in BASE (the router keeps the uuids of the old copper). Only
// items of the listed nets are copied, unlocked; a net BASE does not have is left out. One KiCad 10 kicad-cli run refills the
// zones and saves. OUT may be BASE. A failed DRC is no error here: the caller runs the gate on the result.
// Prints "import_nets: <n> items of <m> nets". Used by tools/route_batch.mjs (accept and bisect without a new router run).
import { copyFileSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { BoardEdit, saveBoard } from './lib/board-edit.ts';
import { boardJson } from './lib/board-json.ts';
import { runMain, UsageError } from './lib/cli.ts';

const USAGE = 'usage: tools/import_nets.ts BASE.kicad_pcb CANDIDATE.kicad_pcb OUT.kicad_pcb --nets A,B,C';

interface CopperItem { id: string; net: string }
type RoutedCopper = { Track: CopperItem } | { Via: CopperItem };
/** The part of `iotroute board-json` this tool reads. */
export interface CopperDocument { board: { nets: Record<string, string>; copper: RoutedCopper[] } }

const item = (copper: RoutedCopper): CopperItem => ('Track' in copper ? copper.Track : copper.Via);

/** The items of `candidate` to copy, in the candidate's order. */
export function newCopper(base: CopperDocument, candidate: CopperDocument, nets: ReadonlySet<string>): CopperItem[] {
  const old = new Set(base.board.copper.map(copper => item(copper).id));
  return candidate.board.copper.map(item).filter(({ id, net }) => !old.has(id) && nets.has(net) && net in base.board.nets);
}

/** `base` with `items` added from `candidate`, as board text. */
export function withCopper(base: string, candidate: string, items: CopperItem[]): string {
  const from = new BoardEdit(candidate);
  const to = new BoardEdit(base);
  for (const { id } of items) to.add(`\t${from.textOf(id).replace(/\s*\(locked yes\)/, '')}\n`);
  return to.text();
}

function options(argv: string[]) {
  let parsed;
  try {
    parsed = parseArgs({ args: argv, allowPositionals: true, options: { nets: { type: 'string' } } });
  } catch {
    throw new UsageError(USAGE);
  }
  const [base, candidate, out, ...rest] = parsed.positionals;
  const { nets } = parsed.values;
  if (out === undefined || rest.length > 0 || nets === undefined) throw new UsageError(USAGE);
  return { base, candidate: candidate!, out, nets: new Set(nets.split(',').filter(Boolean)) };
}

function main(argv: string[]): number {
  const { base, candidate, out, nets } = options(argv);
  const items = newCopper(boardJson(base) as unknown as CopperDocument, boardJson(candidate) as unknown as CopperDocument, nets);
  const text = withCopper(readFileSync(base, 'utf8'), readFileSync(candidate, 'utf8'), items);
  const folder = mkdtempSync(join(tmpdir(), 'import-nets-'));
  try {
    copyFileSync(saveBoard(base, text, folder).board, out);
  } finally {
    rmSync(folder, { recursive: true, force: true });
  }
  console.log(`import_nets: ${items.length} items of ${new Set(items.map(({ net }) => net)).size} nets`);
  return 0;
}

runMain(import.meta.url, main);
