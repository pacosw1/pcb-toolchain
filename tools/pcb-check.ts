// CLI admission for the Node check supervisor.
import { basename } from 'node:path';
import { parseArgs } from 'node:util';
import { setTimeout as delay } from 'node:timers/promises';
import { projectRoot } from './lib/project-root.mjs';
import { startCheck } from './lib/pcb-check-start.ts';
import { compactTerminal, eventLine, events, requestCancel, status, TERMINAL, type Dict } from './lib/pcb-runs.ts';
import { jsonDumps } from './lib/py-compat.mjs';

async function follow(folder: string, machine: boolean): Promise<number> {
  let cursor = 0, interrupted = false, cancelSent = false;
  const onInterrupt = () => { interrupted = true; };
  process.on('SIGINT', onInterrupt);
  try {
    for (;;) {
      if (interrupted && !cancelSent) { requestCancel(folder); cancelSent = true; }
      const rows = events(folder, cursor, 100);
      for (const row of rows) {
        console.log(eventLine(row, machine));
        cursor = Number(row.get('cursor'));
        if (row.get('type') === 'run.end') return Number(row.get('exit_code'));
      }
      if (rows.length === 100) continue;
      const state = status(folder);
      if (TERMINAL.has(String(state.get('status'))) && state.get('controller_alive') !== true) {
        if (events(folder, cursor, 1).length) continue;
        if (machine) console.log(jsonDumps(compactTerminal(state, folder)));
        else console.log(`STUCK: ${String(state.get('cause') ?? 'supervisor ended without events')}`);
        return Number(state.get('exit_code') ?? 2);
      }
      await delay(100);
    }
  } finally { process.off('SIGINT', onInterrupt); }
}

async function main(argv: string[]): Promise<number> {
  let explicit: string | undefined;
  if (argv[0] === '--project') { explicit = argv[1]; if (!explicit) throw new Error('missing project'); argv = argv.slice(2); }
  else if (argv[0]?.startsWith('--project=')) { explicit = argv[0].slice(10); argv = argv.slice(1); }
  const operation = argv.shift();
  if (operation !== 'check' && operation !== 'doctor' && operation !== 'readiness' && operation !== 'blocks' && operation !== 'outcomes' && operation !== 'schematic') throw new Error('expected check, doctor, readiness, or blocks command');
  // Backend arguments begin at the first positional, as with argparse.REMAINDER.
  let backend: string[] = [];
  if (operation === 'readiness' || operation === 'blocks' || operation === 'outcomes' || operation === 'schematic') {
    const withValue = new Set(['--runs-dir', '--timeout', '--heartbeat', '--cycle']);
    let i = 0;
    while (i < argv.length && argv[i]!.startsWith('-')) {
      if (argv[i] === '--') { i++; break; }
      i += withValue.has(argv[i]!) ? 2 : 1;
    }
    backend = argv.slice(i); argv = argv.slice(0, i);
  }
  const { values, positionals } = parseArgs({ args: argv, allowPositionals: true, options: {
    'runs-dir': { type: 'string' }, json: { type: 'boolean' }, detach: { type: 'boolean' }, follow: { type: 'boolean' },
    timeout: { type: 'string', default: '600' }, heartbeat: { type: 'string', default: '5' },
    changed: { type: 'boolean' }, fresh: { type: 'boolean' }, baseline: { type: 'string' }, cycle: { type: 'string' },
  } });
  if (positionals.length !== (operation === 'check' ? 1 : 0)) throw new Error(operation === 'check' ? 'check requires one board ID' : 'doctor takes no board ID');
  if (operation === 'schematic' && (backend.length < 2 || backend[0] !== 'check')) throw new Error('schematic requires check and a board ID');
  if (operation === 'schematic' && backend.some(arg => /^--(root|output)(=|$)/.test(arg))) throw new Error('schematic root and output are owned by the run supervisor');
  if (operation === 'outcomes' && (backend.length < 2 || backend[0] !== 'evaluate')) throw new Error('outcomes requires evaluate and a study ID');
  if (operation === 'outcomes' && backend.some(arg => /^--(root|output)(=|$)/.test(arg))) throw new Error('outcomes root and output are owned by the run supervisor');
  if (operation === 'readiness' && backend.length < 2) throw new Error('readiness requires a board and candidate');
  if (operation !== 'check' && (values.changed || values.fresh || values.baseline)) throw new Error('check options cannot be used with doctor');
  if (values.detach && values.follow) throw new Error('--detach and --follow cannot be used together');
  if (values.changed && values.fresh) throw new Error('--changed and --fresh cannot be used together');
  const root = projectRoot(explicit), base = values['runs-dir'] ?? process.env.PCB_RUNS_DIR ?? `${root}/.gate/cli`;
  const folder = await startCheck({ root, base, board: operation === 'outcomes' || operation === 'schematic' ? backend[1]! : operation === 'readiness' ? backend[0]! : positionals[0] ?? (operation === 'blocks' ? 'BLOCKS' : 'ENVIRONMENT'), operation, arguments: backend, timeout: Number(values.timeout), heartbeat: Number(values.heartbeat),
    changed: values.changed, fresh: values.fresh, baseline: values.baseline, cycle: values.cycle });
  if (values.detach) {
    if (values.json) console.log(jsonDumps(status(folder)));
    else console.log(`START: ${basename(folder)}; tools/pcb events ${basename(folder)} --wait 20`);
    return 0;
  }
  return follow(folder, Boolean(values.json));
}

main(process.argv.slice(2)).then(code => { process.exitCode = code; }, (error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  if (process.argv.includes('--json')) console.log(jsonDumps({ status: 'error', exit_code: 2, cause: message }));
  else console.error(`FAIL: ${message}`);
  process.exitCode = 2;
});
