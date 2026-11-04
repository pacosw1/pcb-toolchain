// Duplicate item UUIDs in a native KiCad board: report them, or repair them with --repair (tools/lib/board-uuids.ts).
//
//   tools/board_uuids.ts BOARD... [--repair]   (reports; --repair rewrites the file in place, atomically)
// Exit 1 when a board keeps a duplicate.
import { basename } from 'node:path';
import { runMain, UsageError } from './lib/cli.ts';
import { jsonDumps } from './lib/py-compat.mjs';
import { repairFile, type RepairReport } from './lib/board-uuids.ts';

const USAGE = 'usage: tools/board_uuids.ts BOARD... [--repair]';

function summary(path: string, report: RepairReport): string {
  const kinds: Record<string, number> = {};
  for (const { kind } of report.rows) kinds[kind] = (kinds[kind] ?? 0) + 1;
  const plural = report.duplicates === 1 ? '' : 's';
  const counts = report.rows.length > 0 ? ` ${jsonDumps(kinds)}` : '';
  return `UUIDS ${basename(path)}: ${report.duplicates} duplicate item UUID${plural}${counts}${report.written ? ' repaired' : ''}`;
}

function main(argv: string[]): number {
  const fix = argv.includes('--repair');
  const boards = argv.filter(arg => arg !== '--repair');
  if (boards.length === 0) throw new UsageError(USAGE, 1);
  let kept = 0;
  for (const path of boards) {
    const report = repairFile(path, fix);
    console.log(summary(path, report));
    if (report.duplicates > 0 && !report.written) kept += 1;
  }
  return kept > 0 ? 1 : 0;
}

runMain(import.meta.url, main);
