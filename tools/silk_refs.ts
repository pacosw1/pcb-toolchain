// Move footprint reference designators off the silkscreen (user 2026-09-27).
//
// Each footprint "Reference" property on F.SilkS / B.SilkS moves to F.Fab / B.Fab. The references stay in the assembly (Fab)
// drawings. Free silk texts (port names, pin labels) and footprint silk graphics do not change. This edits the file as text
// and saves nothing through KiCad: a layer name is the one change, so there is nothing for KiCad to put in place.
import { readFileSync, writeFileSync } from 'node:fs';
import { processWriter, sealedWrite } from './lib/cad-seal.ts';
import { runMain, UsageError } from './lib/cli.ts';

const USAGE = `Move footprint reference designators off the silkscreen (user 2026-09-27).

Each footprint "Reference" property on F.SilkS / B.SilkS moves to F.Fab / B.Fab.
The references stay in the assembly (Fab) drawings. Free silk texts (port names,
pin labels) and footprint silk graphics do not change.

  tools/silk_refs.ts BOARD.kicad_pcb [BOARD2 ...] [--dry-run]
`;
const REFERENCE = /(\(property "Reference" "[^"]*"\n(?:\t+\(at [^\n]*\)\n)?\t+\(layer ")([FB])\.SilkS"/g;

export function refsOffSilk(board: string): { text: string; moved: number } {
  let moved = 0;
  const text = board.replace(REFERENCE, (_, head: string, side: string) => {
    moved += 1;
    return `${head}${side}.Fab"`;
  });
  return { text, moved };
}

function main(argv: string[]): number {
  const dryRun = argv.includes('--dry-run');
  const files = argv.filter(arg => arg !== '--dry-run');
  if (!files.length) throw new UsageError(USAGE, 1);
  for (const file of files) {
    const { text, moved } = refsOffSilk(readFileSync(file, 'utf8'));
    if (!dryRun && moved) sealedWrite(file, processWriter(), () => writeFileSync(file, text));
    console.log(`${file}: ${moved} references moved to Fab${dryRun ? ' (dry run)' : ''}`);
  }
  return 0;
}

runMain(import.meta.url, main);
