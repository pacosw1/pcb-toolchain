#!/usr/bin/env -S node --experimental-strip-types --no-warnings
// tools/trial-unlock.ts IN.kicad_pcb OUT.kicad_pcb [KEEP_REFS]
// Trial start only: the placer does not move a locked part, and unroute keeps locked copper, so a finished board has no moves.
// User.1 drawings go too: they are the layout blocks of the stored answer. KEEP_REFS is a comma list of the parts that stay locked
// (the `fixed` rule parts). OUT is a new file: the input stays as it is.
import { readFileSync, writeFileSync } from 'node:fs';
import { formEnd } from './lib/board-edit.ts';
import { runMain, UsageError } from './lib/cli.ts';
import { unlockedFootprint } from './placer/repair.ts';

export function unlockBoard(board: string, keep: Set<string>): string {
  const seen = new Set<string>(), found = /^\s*\((footprint|segment|via|arc|gr_\w+)\s/gm;
  let text = '', from = 0;
  for (let match = found.exec(board); match; match = found.exec(board)) {
    const open = board.indexOf('(', match.index), end = formEnd(board, open), form = board.slice(open, end);
    if (match[1]!.startsWith('gr_')) {
      if (form.includes('(layer "User.1")')) { text += board.slice(from, open).trimEnd(); from = end; }   // A block drawing: the placer reads it as a layout block.
      found.lastIndex = end;
      continue;
    }
    const ref = match[1] === 'footprint' ? /\(property\s+"Reference"\s+"([^"]+)"/.exec(form)?.[1] ?? '' : '';
    seen.add(ref);
    text += board.slice(from, open) + (keep.has(ref) ? form : unlockedFootprint(form));
    from = found.lastIndex = end;
  }
  const absent = [...keep].filter(ref => !seen.has(ref));
  if (absent.length) throw new Error(`trial-unlock: the board has no part ${absent.join(', ')}`);
  return text + board.slice(from);
}

function main(argv: string[]): number {
  const [input, output, keep = ''] = argv;
  if (!input || !output || argv.length > 3) throw new UsageError('usage: trial-unlock.ts IN.kicad_pcb OUT.kicad_pcb [KEEP_REFS]');
  writeFileSync(output, unlockBoard(readFileSync(input, 'utf8'), new Set(keep.split(',').filter(Boolean))));
  return 0;
}

runMain(import.meta.url, main);
