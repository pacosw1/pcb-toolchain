// Read a supervised run without launching a Python process or changing the run.
import { resolve } from 'node:path';
import { realpathSync } from 'node:fs';
import { parseArgs, type ParseArgsOptionsConfig } from 'node:util';
import { projectRoot } from './lib/project-root.mjs';
import { compactTerminal, eventLine, events, explain, requestCancel, runDir, stageStatus, status, TERMINAL, RUN_ID, type Dict } from './lib/pcb-runs.ts';
import { catalog, context } from './lib/pcb-workflow.ts';
import { nextAction } from './lib/pcb-next.ts';
import { nextReaders } from './lib/pcb-next-readers.ts';
import { note, NOTE_KINDS, type NoteKind } from './lib/pcb-note.ts';
import { summarize } from './lib/pcb-benchmark.ts';
import { adopt } from './lib/pcb-candidate.ts';
import { cycleCommand, CYCLE_OPTIONS } from './lib/pcb-cycle-cli.ts';
import { get, item, jsonDumps, pyStr } from './lib/py-compat.mjs';

const usage = 'usage: pcb [--project DIR] {list,context,next,status,events,explain,cancel,note,benchmark,cycle,adopt} [BOARD_OR_RUN_ID] [options]';

export async function main(argv: string[]): Promise<number> {
  let explicit: string | undefined;
  if (argv[0] === '--project') { explicit = argv[1]; if (!explicit) throw new Error(usage); argv = argv.slice(2); }
  else if (argv[0]?.startsWith('--project=')) { explicit = argv[0].slice(10); argv = argv.slice(1); }
  const command = argv.shift();
  if (!['list', 'context', 'next', 'status', 'events', 'explain', 'cancel', 'note', 'benchmark', 'cycle', 'adopt'].includes(command ?? '')) throw new Error(usage);
  const options: ParseArgsOptionsConfig = {
    'runs-dir': { type: 'string' }, json: { type: 'boolean', default: false },
    ...(command === 'events' ? { after: { type: 'string', default: '0' }, limit: { type: 'string', default: '100' }, wait: { type: 'string', default: '0' } } : {}),
    ...(command === 'explain' ? { limit: { type: 'string', default: '20' } } : {}),
    ...(command === 'next' ? { 'design-contract': { type: 'string' }, through: { type: 'string' } } : {}),
    ...(command === 'note' ? { kind: { type: 'string' } } : {}),
    ...(command === 'adopt' ? { baseline: { type: 'string' }, defect: { type: 'string' } } : {}),
    ...(command === 'cycle' ? CYCLE_OPTIONS : {}),
  };
  const { values, positionals } = parseArgs({ args: argv, options, allowPositionals: true });
  if (command === 'benchmark' ? positionals.length < 1 : positionals.length !== (command === 'list' ? 0 : command === 'note' || command === 'cycle' ? 2 : 1)) throw new Error(usage);
  const noteKind = command === 'note' ? values.kind as string | undefined : undefined;
  if (command === 'note' && (!noteKind || !NOTE_KINDS.includes(noteKind as NoteKind))) throw new Error('--kind must be intervention, decision or rework');
  if (command === 'list') {
    const data = catalog(projectRoot(explicit)) as { boards: { board: string }[] };
    console.log(values.json ? jsonDumps(data) : data.boards.map(row => row.board).join('\n'));
    return 0;
  }
  if (command === 'context' || (command === 'status' && !RUN_ID.test(positionals[0]!))) {
    console.log(jsonDumps(context(projectRoot(explicit), positionals[0]!), values.json ? null : 2));
    return 0;
  }
  const requestedBase = resolve((values['runs-dir'] as string | undefined) ?? process.env.PCB_RUNS_DIR ?? resolve(projectRoot(explicit), '.gate/cli'));
  let base = requestedBase;
  try { base = realpathSync(requestedBase); } catch { /* runDir reports missing runs consistently */ }
  if (command === 'cycle') {
    const data = await cycleCommand(projectRoot(explicit), requestedBase, positionals[0]!, positionals[1]!, values);
    console.log(jsonDumps(data, values.json ? null : 2));
    return 0;
  }
  if (command === 'benchmark') {
    const data = summarize(positionals.map(id => runDir(base, id)));
    console.log(jsonDumps(data, values.json ? null : 2));
    return 0;
  }
  if (command === 'next') {
    const decision = await nextAction(projectRoot(explicit), positionals[0]!, {
      base, readers: nextReaders,
      designContract: values['design-contract'] as string | undefined,
      through: values.through as string | undefined,
    });
    if (values.json) console.log(jsonDumps(decision));
    else console.log(`${pyStr(decision.blocker?.message)}\nNext: ${decision.next_action?.command}`);
    return 0;
  }
  const folder = runDir(base, positionals[0]!);
  if (command === 'adopt') {
    const data = await adopt(projectRoot(explicit), folder, values.defect as string | undefined, values.baseline ? runDir(base, values.baseline as string) : null);
    console.log(values.json ? jsonDumps(data) : `PASS: adopted verified candidate; backup=${folder}/backup`);
    return 0;
  }
  if (command === 'note') {
    await note(folder, noteKind as NoteKind, positionals[1]!);
    console.log(values.json ? jsonDumps({ recorded: true }) : 'PASS: run note recorded');
    return 0;
  }
  if (command === 'cancel') {
    let state = requestCancel(folder);
    if (TERMINAL.has(state.get('status') as string)) state = compactTerminal(state, folder);
    if (values.json) console.log(jsonDumps(state));
    else console.log(`${pyStr(state.get('status')).toUpperCase()}: ${positionals[0]}; cancellation_requested=${pyStr(state.has('cancellation_requested') ? state.get('cancellation_requested') : false)}`);
    return 0;
  }
  if (command === 'explain') {
    const limit = Number(values.limit);
    if (!/^[+-]?\d+$/.test(String(values.limit)) || !Number.isSafeInteger(limit) || limit < 1 || limit > 1000) throw new Error('--limit must be between 1 and 1000');
    const report = explain(folder, limit);
    if (TERMINAL.has(report.run.get('status') as string)) report.run = compactTerminal(report.run, folder);
    if (values.json) console.log(jsonDumps(report));
    else {
      console.log(`${pyStr(item(report.run, 'status')).toUpperCase()}: ${pyStr(get(report.run, 'cause', 'run active'))}`);
      for (const finding of get(report.run, 'findings', []) as Dict[])
        console.log(`  ${pyStr(item(finding, 'stage'))}: ${pyStr(item(finding, 'cause'))} (${pyStr(item(finding, 'log'))})`);
      for (const detail of report.details) console.log('  ' + jsonDumps(detail));
      console.log(`Evidence: ${folder}`);
    }
    return 0;
  }
  if (command === 'status') {
    let state = status(folder);
    if (TERMINAL.has(state.get('status') as string)) state = compactTerminal(state, folder);
    if (values.json) console.log(jsonDumps(state));
    else {
      const active = state.get('active_stage_timing') as Dict[] | undefined;
      const suffix = active?.length ? `active=${stageStatus(active)}; ` : '';
      const cause = state.has('cause') ? state.get('cause') : '';
      const elapsed = state.has('elapsed_s') ? state.get('elapsed_s') : 'unavailable';
      console.log(`${pyStr(state.get('status')).toUpperCase()}: ${positionals[0]} ${pyStr(cause)}; elapsed=${pyStr(elapsed)}s; ${suffix}evidence=${folder}`);
    }
    return 0;
  }
  const after = Number(values.after), limit = Number(values.limit), wait = Number(values.wait);
  if (!/^[+-]?\d+$/.test(String(values.after)) || !Number.isSafeInteger(after)) throw new Error('--after must be an integer');
  if (!/^[+-]?\d+$/.test(String(values.limit)) || !Number.isSafeInteger(limit) || limit < 1 || limit > 1000) throw new Error('--limit must be between 1 and 1000');
  if (!String(values.wait).trim() || !Number.isFinite(wait) || wait < 0 || wait > 60) throw new Error('--wait must be between 0 and 60 seconds');
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
