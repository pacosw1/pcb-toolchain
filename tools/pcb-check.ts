// CLI admission for the Node check supervisor.
import { basename } from 'node:path';
import { parseArgs } from 'node:util';
import { setTimeout as delay } from 'node:timers/promises';
import { projectRoot } from './lib/project-root.mjs';
import { startCheck } from './lib/pcb-check-start.ts';
import { compactTerminal, eventLine, events, requestCancel, status, TERMINAL } from './lib/pcb-runs.ts';
import { CANDIDATE, OPERATIONS, ROUTERS } from './lib/pcb-candidate-admission.ts';
import { jsonDumps } from './lib/py-compat.mjs';

const PASSTHROUGH = new Set(['readiness', 'blocks', 'outcomes', 'schematic', 'design', 'parts', 'routing', 'placement', 'ml']);
const OPERATIONS_LIST = ['check', 'doctor', ...PASSTHROUGH, ...OPERATIONS];
const ML_ACTIONS = ['dataset', 'features', 'train', 'evaluate', 'predict', 'engine-dataset', 'engine-train', 'engine-evaluate', 'engine-export', 'engine-public-corpus'];

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

/** Each option only where its operation reads it, so a mistyped command stops here and not after a snapshot. */
function admitCandidate(operation: string, values: Record<string, unknown>): void {
  const allowed: Record<string, string[]> = { spec: ['edit', 'route'], kind: ['edit'], router: ['route'], plan: ['repair'], 'engineering-manifest': [...CANDIDATE], 'design-contract': [...OPERATIONS] };
  for (const [name, operations] of Object.entries(allowed)) if (values[name] !== undefined && !operations.includes(operation)) throw new Error(`--${name} is not supported for ${operation}`);
  if (operation === 'edit' && !values.spec) throw new Error('edit requires --spec');
  if (operation === 'edit' && values.kind !== 'place' && values.kind !== 'route') throw new Error('edit requires --kind place or route');
  if (operation === 'repair' && !values.plan) throw new Error('repair requires --plan');
  if (values.router !== undefined && !ROUTERS.includes(values.router as string)) throw new Error(`--router must be one of ${ROUTERS.join(', ')}`);
}

async function main(argv: string[]): Promise<number> {
  let explicit: string | undefined;
  if (argv[0] === '--project') { explicit = argv[1]; if (!explicit) throw new Error('missing project'); argv = argv.slice(2); }
  else if (argv[0]?.startsWith('--project=')) { explicit = argv[0].slice(10); argv = argv.slice(1); }
  const operation = argv.shift();
  if (!operation || !OPERATIONS_LIST.includes(operation)) throw new Error(`usage: pcb [--project DIR] {${OPERATIONS_LIST.join(',')}} ...`);
  // Backend arguments begin at the first positional, as with argparse.REMAINDER.
  let backend: string[] = [];
  if (PASSTHROUGH.has(operation)) {
    const withValue = new Set(['--runs-dir', '--timeout', '--heartbeat', '--cycle', '--from-run']);
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
    changed: { type: 'boolean' }, fresh: { type: 'boolean' }, baseline: { type: 'string' }, cycle: { type: 'string' }, 'from-run': { type: 'string' },
    spec: { type: 'string' }, kind: { type: 'string' }, router: { type: 'string' }, plan: { type: 'string' }, 'engineering-manifest': { type: 'string' }, 'design-contract': { type: 'string' },
  } });
  const onBoard = operation === 'check' || OPERATIONS.has(operation);
  if (positionals.length !== (onBoard ? 1 : 0)) throw new Error(onBoard ? `${operation} requires one board ID` : 'doctor takes no board ID');
  admitCandidate(operation, values);
  if (operation === 'placement' && (backend.length < 2 || backend[0] !== 'check')) throw new Error('placement requires check and a board ID');
  if (operation === 'placement' && backend.some(arg => /^--(root|output)(=|$)/.test(arg))) throw new Error('placement root and output are owned by the run supervisor');
  if (operation === 'routing' && (backend.length < 2 || !['diagnose', 'move'].includes(backend[0]!))) throw new Error('routing requires diagnose or move and a board ID');
  if (operation === 'routing' && backend.some(arg => /^--(root|output)(=|$)/.test(arg))) throw new Error('routing root and output are owned by the run supervisor');
  if (operation === 'parts' && (backend.length < 2 || !['status', 'inspect', 'selection', 'verify', 'stock'].includes(backend[0]!))) throw new Error('parts requires an action and subject');
  if (operation === 'parts' && backend.some(arg => /^--(root|output|cache)(=|$)/.test(arg))) throw new Error('parts root, output and cache are owned by the run supervisor');
  if (operation !== 'parts' && operation !== 'routing' && operation !== 'placement' && !CANDIDATE.has(operation) && values['from-run']) throw new Error('--from-run is not supported for this operation');
  if (operation === 'design' && (backend.length < 2 || backend[0] !== 'check')) throw new Error('design requires check and a design ID');
  if (operation === 'design' && backend.some(arg => /^--(root|output)(=|$)/.test(arg))) throw new Error('design root and output are owned by the run supervisor');
  if (operation === 'schematic' && (backend.length < 2 || backend[0] !== 'check')) throw new Error('schematic requires check and a board ID');
  if (operation === 'schematic' && backend.some(arg => /^--(root|output)(=|$)/.test(arg))) throw new Error('schematic root and output are owned by the run supervisor');
  if (operation === 'outcomes' && (backend.length < 2 || backend[0] !== 'evaluate')) throw new Error('outcomes requires evaluate and a study ID');
  if (operation === 'outcomes' && backend.some(arg => /^--(root|output)(=|$)/.test(arg))) throw new Error('outcomes root and output are owned by the run supervisor');
  if (operation === 'ml' && (backend.length < 2 || !ML_ACTIONS.includes(backend[0]!))) throw new Error('unknown ML action; use dataset/features/train/evaluate/predict or engine-dataset/train/evaluate/export');
  if (operation === 'ml' && backend.some(arg => /^--(root|output)(=|$)/.test(arg))) throw new Error('ml root and output are owned by the run supervisor');
  if (operation === 'readiness' && backend.length < 2) throw new Error('readiness requires a board and candidate');
  if (operation !== 'check' && (values.changed || values.fresh || values.baseline)) throw new Error('check options cannot be used with doctor');
  if (values.detach && values.follow) throw new Error('--detach and --follow cannot be used together');
  if (values.changed && values.fresh) throw new Error('--changed and --fresh cannot be used together');
  const root = projectRoot(explicit), base = values['runs-dir'] ?? process.env.PCB_RUNS_DIR ?? `${root}/.gate/cli`;
  const folder = await startCheck({ root, base, spec: values.spec, kind: values.kind, router: values.router, plan: values.plan, engineeringManifest: values['engineering-manifest'], designContract: values['design-contract'],
    board: operation === 'ml' ? backend[1]! : operation === 'placement' ? backend[1]! : operation === 'routing' ? backend[1]! : operation === 'parts' ? (backend[0] === 'inspect' ? 'PARTS' : backend[1]!) : operation === 'outcomes' || operation === 'schematic' || operation === 'design' ? backend[1]! : operation === 'readiness' ? backend[0]! : positionals[0] ?? (operation === 'blocks' ? 'BLOCKS' : 'ENVIRONMENT'), operation, arguments: backend, timeout: Number(values.timeout), heartbeat: Number(values.heartbeat),
    changed: values.changed, fresh: values.fresh, baseline: values.baseline, cycle: values.cycle, fromRun: values['from-run'] });
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
