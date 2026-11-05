#!/usr/bin/env -S node --experimental-strip-types
// Source-bound routing diagnosis and one guarded local candidate operation. Native/configured gates own acceptance.
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseFlags, runMain, UsageError } from './lib/cli.ts';
import { projectRoot } from './lib/project-root.mjs';
import { atomicJson } from './lib/json-file.ts';
import { resolvePath } from './lib/py-path.ts';
import { applyPlan, diagnoseEvidence, generateEscape, SCHEMA } from './lib/route-decision.ts';
import { checkMove } from './lib/route-moves.ts';
import { repairSnapshot } from './lib/route-decision-cli.ts';
import { deadlineAfter, remaining } from './lib/lean-workflow.ts';
export * from './lib/route-decision.ts';
const USAGE = 'usage: tools/route_decision.ts diagnose|repair|escape|move BOARD [--root DIR] [--json] [--evidence FILE|--plan FILE] [--move JSON] [--output PATH] [--timeout S]';
export function main(argv: string[]): number {
  const { values: options, positionals } = parseFlags(argv, { root: { type: 'string' }, json: { type: 'boolean' }, output: { type: 'string' },
    evidence: { type: 'string' }, plan: { type: 'string' }, move: { type: 'string' }, timeout: { type: 'string' } }, USAGE);
  const [mode, board, ...extra] = positionals;
  if (!board || extra.length || !['diagnose', 'repair', 'escape', 'move'].includes(mode ?? '') || mode === 'diagnose' && !options.evidence || mode === 'repair' && !options.plan || mode === 'move' && !(options.evidence && options.move && options.output)) throw new UsageError(USAGE);
  const root = projectRoot(options.root), output = options.output ? resolvePath(options.output) : undefined;
  try {
    let result: object, code = 0;
    if (mode === 'diagnose') {
      const decision = diagnoseEvidence(root, board, options.evidence!, output); result = decision;
      if (output) { if (existsSync(output)) throw new Error('decision output already exists'); atomicJson(output, decision); }
    } else if (mode === 'move') {
      const checked = checkMove(root, board, options.evidence!, options.move!, output!); result = checked; code = checked.status === 'rejected' ? 1 : 0;
      atomicJson(output!, checked);
    } else {
      if (!output) throw new Error('--output evidence path required');
      const timeout = Number(options.timeout ?? (mode === 'repair' ? 120 : 30));
      if (!Number.isFinite(timeout) || timeout <= 0) throw new Error('finite positive timeout required');
      if (mode === 'escape') { const escape = generateEscape(root, board, output, timeout); result = escape; code = escape.status === 'screened' ? 0 : 3; }
      else {
        if (existsSync(output)) throw new Error('new --output directory required');
        mkdirSync(output, { recursive: true }); const workspace = join(output, 'workspace');
        repairSnapshot(root, workspace, board);
        const guard = applyPlan(workspace, board, options.plan!, join(output, 'repair')), deadline = deadlineAfter(timeout), budget = remaining(deadline);
        if (budget === null || budget <= 0) throw new Error('configured repair gate deadline expired');
        const run = spawnSync(process.execPath, [join(workspace, 'tools/gate.mjs'), board, '--fresh', '--evidence-dir', join(output, 'gate')],
          { cwd: workspace, env: { ...process.env, IOT_LAB: workspace }, encoding: 'utf8', timeout: budget * 1000, maxBuffer: 4 * 1024 * 1024 });
        writeFileSync(join(output, 'gate.log'), `${run.stdout ?? ''}${run.stderr ?? ''}`);
        const exit = run.error ? 124 : run.status ?? 1; code = exit === 0 ? 0 : 3;
        result = { status: exit === 0 ? 'candidate' : 'rejected', qualified: false, guard, configured_gate_exit: exit, board_specific_and_adoption_checks_required: true };
        atomicJson(join(output, 'result.json'), result);
      }
    }
    const display = result as { action?: string; status?: string }; console.log(options.json ? JSON.stringify(result) : `${code === 0 ? 'PASS' : 'STUCK'}: ${display.action ?? display.status}`); return code;
  } catch (error) {
    const cause = (error as Error).message, result = { schema: SCHEMA, status: 'blocked', qualified: false, cause };
    if (output && !existsSync(output)) atomicJson(output, result);
    console.log(options.json ? JSON.stringify(result) : 'STUCK: ' + cause); return 3;
  }
}
runMain(import.meta.url, main);
