// The DRC reads of pcbtool: drc and netcheck. A DRC of the board on disk, and one on a temporary copy for one net.
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { DrcFile, DrcItem } from './board-edit.ts';
import { boardDrc, inProjectCopy } from './drc-run.ts';
import { drcLines, summarizeDrc } from './drc-summary.ts';
import { kicadCli } from './env.mjs';
import { readJson } from './json-file.ts';
import { CommandFailure, type Print } from './pcbtool-cli.ts';
import { fixed } from './py-compat.mjs';

const DRC_LINES = 60;
const VIOLATION_CHARS = 170;
const OPEN_CHARS = 160;

const cut = (line: string, chars: number): string => Array.from(line).slice(0, chars).join('');
const described = (items: DrcItem[] = []): string => items.map(item => item.description).join(' | ');
const located = (item: DrcItem): string => item.description + (item.pos ? ` (${fixed(item.pos.x, 3)}, ${fixed(item.pos.y, 3)})` : '');

export function drc(pcb: string, print: Print): number {
  for (const line of drcLines(boardDrc(pcb), DRC_LINES)) print(line);
  return 0;
}

/** One DRC total line, then up to `limit` short lines of the net, null for all. `ok`: the net has no violation and nothing open. */
export function netCheck(report: DrcFile, net: string, limit: number | null = 3): { lines: string[]; ok: boolean } {
  const tag = `[${net}]`;
  const summary = summarizeDrc(report);
  const names = (items: DrcItem[] = []): boolean => items.some(item => item.description.includes(tag));
  const violations = (report.violations ?? []).filter(item => names(item.items));
  const open = (report.unconnected_items ?? []).filter(item => names(item.items));
  const most = limit ?? (report.violations?.length ?? 0) + (report.unconnected_items?.length ?? 0);
  return {
    lines: [
      `DRC total: ${summary.errors} errors, ${summary.unconnected} unconnected, ${summary.parity} parity | ${net}: ${violations.length} violations, ${open.length} unconnected`,
      ...violations.slice(0, most).map(item => cut(`  ${(item.severity ?? '?')[0]!.toUpperCase()} ${item.type}: ${described(item.items)}`, VIOLATION_CHARS)),
      ...open.slice(0, Math.max(0, most - violations.length)).map(item => `  U ${cut(item.items.map(located).join(' | '), OPEN_CHARS)}`),
    ],
    ok: !violations.length && !open.length,
  };
}

/** DRC with parity and refilled zones on a copy of the project: one line, then the net's items. With a budget it lists them all. */
export async function netcheck(pcb: string, net: string, budget: number | null, print: Print): Promise<number> {
  if (!readFileSync(pcb, 'utf8').includes(`"${net}"`)) throw new CommandFailure(`no net ${net} on the board`);
  const { lines, ok } = await inProjectCopy(pcb, (board, folder) => {
    const report = join(folder, 'drc.json');
    spawnSync(kicadCli, ['pcb', 'drc', '--schematic-parity', '--refill-zones', '--format', 'json', '-o', report, board], { stdio: 'ignore' });
    if (!existsSync(report)) throw new CommandFailure('kicad-cli pcb drc wrote no report');
    return netCheck(readJson<DrcFile>(report), net, budget ? null : 3);
  });
  for (const line of lines) print(line);
  return ok ? 0 : 1;
}
