// One status line of a routing job from OUTDIR/progress.jsonl.
//
//   tools/route_status.ts OUTDIR                     "<stage> <elapsed>s open=<n> best=<n> vias=<n> eta=<s or ->"
//   tools/route_status.ts OUTDIR --follow            print each new line as it arrives (Ctrl-C to stop)
//   tools/route_status.ts OUTDIR --mark gate [--end] append a stage start or end event with the job's elapsed clock
//   tools/route_status.ts OUTDIR --log               the action log (OUTDIR/run.jsonl) in order, one line per action with its why
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { parseArgs } from 'node:util';
import { runMain, UsageError } from './lib/cli.ts';
import { lastEvent, markStage, statusLine } from './lib/route-progress.ts';
import { logLines, readJsonl } from './lib/run-record.ts';

const USAGE = 'usage: tools/route_status.ts OUTDIR [--follow] [--mark STAGE [--end]] [--log]';
const POLL_MS = 1000;

function options(argv: string[]) {
  let parsed;
  try {
    parsed = parseArgs({
      args: argv,
      allowPositionals: true,
      options: { follow: { type: 'boolean' }, mark: { type: 'string' }, end: { type: 'boolean' }, log: { type: 'boolean' } },
    });
  } catch {
    throw new UsageError(USAGE);
  }
  const [outdir, ...rest] = parsed.positionals;
  if (outdir === undefined || rest.length > 0) throw new UsageError(USAGE);
  return { outdir, ...parsed.values };
}

async function follow(path: string): Promise<never> {
  process.on('SIGINT', () => process.exit(0));
  let seen = readJsonl(path).length;
  for (;;) {
    await sleep(POLL_MS);
    const rows = readJsonl(path);
    for (const row of rows.slice(seen)) console.log(statusLine(row));
    seen = Math.max(seen, rows.length);
  }
}

async function main(argv: string[]): Promise<number> {
  const { outdir, mark, end, log, follow: following } = options(argv);
  if (log) {
    for (const line of logLines(outdir)) console.log(line);
    return 0;
  }
  const path = join(outdir, 'progress.jsonl');
  if (mark) {
    console.log(statusLine(markStage(path, `${mark} ${end ? 'end' : 'start'}`)));
    return 0;
  }
  console.log(statusLine(lastEvent(path)));
  if (following) await follow(path);
  return 0;
}

runMain(import.meta.url, main);
