// Read a supervised run without launching a Python process or changing the run.
import { resolve } from 'node:path';
import { realpathSync } from 'node:fs';
import { parseArgs, type ParseArgsOptionsConfig } from 'node:util';
import { projectRoot } from './lib/project-root.mjs';
import { compactTerminal, eventLine, events, runDir, stageStatus, status, TERMINAL, type Dict } from './lib/pcb-runs.ts';
import { jsonDumps, pyStr } from './lib/py-compat.mjs';

const usage = 'usage: pcb [--project DIR] {status,events} RUN_ID [options]';

export async function main(argv: string[]): Promise<number> {
  let explicit: string | undefined;
  if (argv[0] === '--project') { explicit = argv[1]; if (!explicit) throw new Error(usage); argv = argv.slice(2); }
  else if (argv[0]?.startsWith('--project=')) { explicit = argv[0].slice(10); argv = argv.slice(1); }
  const command = argv.shift();
  if (command !== 'status' && command !== 'events') throw new Error(usage);
  const options: ParseArgsOptionsConfig = {
    'runs-dir': { type: 'string' }, json: { type: 'boolean', default: false },
    ...(command === 'events' ? { after: { type: 'string', default: '0' }, limit: { type: 'string', default: '100' }, wait: { type: 'string', default: '0' } } : {}),
  };
  const { values, positionals } = parseArgs({ args: argv, options, allowPositionals: true });
  if (positionals.length !== 1) throw new Error(usage);
  const requestedBase = resolve((values['runs-dir'] as string | undefined) ?? process.env.PCB_RUNS_DIR ?? resolve(projectRoot(explicit), '.gate/cli'));
  let base = requestedBase;
  try { base = realpathSync(requestedBase); } catch { /* runDir reports missing runs consistently */ }
  const folder = runDir(base, positionals[0]!);
  if (command === 'status') {
    let state = status(folder);
    if (TERMINAL.has(state.get('status') as string)) state = compactTerminal(state, folder);
    if (values.json) console.log(jsonDumps(state));
    else {
      const active = state.get('active_stage_timing') as Dict[] | undefined;
      const suffix = active?.length ? `active=${stageStatus(active)}; ` : '';
      console.log(`${pyStr(state.get('status')).toUpperCase()}: ${positionals[0]} ${pyStr(state.get('cause') ?? '')}; elapsed=${pyStr(state.get('elapsed_s') ?? 'unavailable')}s; ${suffix}evidence=${folder}`);
    }
    return 0;
  }
  const after = Number(values.after), limit = Number(values.limit), wait = Number(values.wait);
  if (!/^[+-]?\d+$/.test(String(values.after)) || !/^[+-]?\d+$/.test(String(values.limit)) || !Number.isSafeInteger(after) || !Number.isSafeInteger(limit) || limit < 1 || limit > 1000) throw new Error('--limit must be between 1 and 1000 and --after must be an integer');
  if (!Number.isFinite(wait) || wait < 0 || wait > 60) throw new Error('--wait must be between 0 and 60 seconds');
  const until = performance.now() + wait * 1000;
  for (;;) {
    const rows = events(folder, after, limit);
    if (rows.length || TERMINAL.has(status(folder).get('status') as string) || performance.now() >= until) {
      for (const row of rows) console.log(eventLine(row, Boolean(values.json)));
      return 0;
    }
    await new Promise(done => setTimeout(done, Math.min(100, Math.max(0, until - performance.now()))));
  }
}

main(process.argv.slice(2)).then(code => { process.exitCode = code; }, (error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  if (process.argv.includes('--json')) console.log(jsonDumps({ status: 'error', exit_code: 2, cause: message }));
  else console.error(`FAIL: ${message}`);
  process.exitCode = 2;
});
