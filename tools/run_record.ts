// Print the action log of a routing job (OUTDIR/run.jsonl), with the why of each action, for a running or finished job.
//   tools/run_record.ts OUTDIR [--no-sync]
// --no-sync prints run.jsonl as it is, without the records derived from the other files.
import { runMain, UsageError } from './lib/cli.ts';
import { logLines } from './lib/run-record.ts';

const USAGE = 'usage: tools/run_record.ts OUTDIR [--no-sync]';

function main(argv: string[]): number {
  const sync = !argv.includes('--no-sync');
  const positional = argv.filter(arg => arg !== '--no-sync');
  if (positional.length !== 1 || positional[0]!.startsWith('-')) throw new UsageError(USAGE);
  for (const line of logLines(positional[0]!, sync)) console.log(line);
  return 0;
}

runMain(import.meta.url, main);
