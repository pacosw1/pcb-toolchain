// One real board through the real workflow, in a throwaway copy: native rejection of injected defects, detection, repair, adoption
// of real bytes, routing diagnosis and the engineering cycle. Every step is tools/pcb or kicad-cli; the source project stays as it is.
// Run it on Hetzner, on one small board. It proves the workflow, never the board.
//
//   tools/pcb_workflow_smoke.ts --project DIR --board BOARD --output NEW_DIR [--timeout S] [--json]
import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { boardJson } from './lib/board-json.ts';
import { parseFlags, runMain, UsageError } from './lib/cli.ts';
import { kicadCli } from './lib/env.mjs';
import { atomicJson, readObject, sha256File as sha } from './lib/json-file.ts';
import { pcbIdentity } from './lib/pcb-identity.ts';
import { layoutOf, moveFootprint, removeSegment, type Segment, withClearance, withShort, withWrongPadNet } from './lib/pcb-smoke-board.ts';
import { snapshot, sourceState } from './lib/pcb-sources.ts';
import { boardConfig } from './lib/pcb-workflow.ts';
import { withSuffix } from './lib/py-path.ts';
import { sameValue } from './lib/py-values.ts';
import { crossingGuard } from './lib/route-decision-board.ts';

type Row = Record<string, any>;
const USAGE = 'usage: tools/pcb_workflow_smoke.ts --project DIR --board BOARD --output NEW_DIR [--part REF] [--timeout S] [--json]';
const PCB = fileURLToPath(new URL('./pcb', import.meta.url));
const CASES = ['baseline_erc_drc_parity_refill', 'reject_short', 'reject_clearance', 'reject_pad_net_parity', 'parts_review_stays_blocked',
  'detect_injected_placement_defect', 'repair_with_fresh_gates', 'reject_candidate_tamper', 'adopt_real_bytes_on_frozen_board',
  'detect_injected_gap', 'routing_decision_is_source_bound', 'guarded_repair_adds_one_segment', 'adopt_repair', 'cycle_links_actual_runs', 'source_project_unchanged'];

class Smoke {
  readonly summary: Row;
  readonly output: string;
  readonly checkout: string;
  readonly runs: string;
  readonly deadline: number;
  #sequence = 0;
  constructor(output: string, board: string, timeout: number) {
    this.output = output; this.checkout = join(output, 'checkout'); this.runs = join(this.checkout, '.gate/cli');
    this.deadline = Date.now() + timeout * 1000;
    this.summary = { schema: 'iot-lab.pcb-workflow-smoke.v1', status: 'failed', board, qualified: false, expected_cases: CASES, cases: [], skipped: 0,
      scope: 'real-board workflow regression in an isolated copy; no release or qualification' };
  }
  remaining(): number {
    const left = (this.deadline - Date.now()) / 1000;
    if (left <= 0) throw new Error('smoke deadline reached');
    return left;
  }
  passed(name: string, evidence: Row = {}): void {
    this.summary.cases.push({ case: name, status: 'passed', ...evidence });
    console.error(`PASS: ${name}`);
  }
  /** One tools/pcb command with its exit checked. The last line of its --json output is its terminal record. */
  pcb(args: string[], expected = 0): Row {
    const label = `${String(++this.#sequence).padStart(2, '0')}-${args[0]}`, log = join(this.output, `${label}.log`);
    console.error(`START: ${args.slice(0, 3).join(' ')}`);
    const run = spawnSync(PCB, ['--project', this.checkout, ...args], { encoding: 'utf8', timeout: Math.ceil(this.remaining() * 1000), maxBuffer: 1 << 28,
      env: { ...process.env, IOT_LAB: this.checkout } });
    writeFileSync(log, `${run.stdout ?? ''}${run.stderr ?? ''}`);
    if (run.status !== expected) throw new Error(`${args[0]}: expected exit ${expected}, got ${run.status}; evidence=${log}: ${(run.stdout ?? '').trim().split('\n').at(-1)?.slice(0, 400)}`);
    return JSON.parse(run.stdout.trim().split('\n').at(-1)!) as Row;
  }
  read(run: string, file: string): Row { return readObject<Row>(join(this.runs, run, file)); }
}

/** A settled run with fresh native evidence of both checks: anything else proves nothing. */
function nativeContract(smoke: Smoke, run: string, expected: string): { gate: Row; findings: Row } {
  const result = smoke.read(run, 'result.json'), gate = smoke.read(run, 'gate/result.json'), findings = smoke.read(run, 'gate/findings.json');
  if (result.status !== expected || result.cleanup?.complete !== true) throw new Error(`${run} did not settle as ${expected}: ${result.cause}`);
  if (gate.changedDuringRun || gate.preflightErrors?.length || !findings.inputs_valid) throw new Error(`${run} has invalid or missing native inputs`);
  if (!['erc', 'drc'].every(name => findings.completed_checks?.includes(name))) throw new Error(`${run} did not execute both native checks`);
  if (gate.cache?.enabled !== false || gate.cache?.hits !== 0) throw new Error(`${run} is not fresh native evidence`);
  if (expected === 'passed') {
    if (gate.exit !== 0 || !findings.complete) throw new Error(`${run} lacks complete configured gate evidence`);
    if (['erc_errors', 'drc_errors', 'drc_parity', 'drc_unconnected'].some(key => gate.metrics?.[key] !== 0)) throw new Error(`${run} failed native targets: ${JSON.stringify(gate.metrics)}`);
  }
  return { gate, findings };
}

function drc(smoke: Smoke, board: string, name: string, save = false): Row {
  const report = join(smoke.output, `${name}.json`);
  const args = ['pcb', 'drc', '--schematic-parity', '--refill-zones', ...(save ? ['--save-board'] : []), '--severity-all', '--format', 'json', '--units', 'mm', '-o', report, board];
  const run = spawnSync(kicadCli, args, { encoding: 'utf8', timeout: Math.ceil(smoke.remaining() * 1000), maxBuffer: 1 << 26 });
  if (run.error || !existsSync(report)) throw new Error(`${name}: kicad-cli did not report: ${run.error?.message ?? run.stderr}`);
  const value = readObject<Row>(report);
  for (const key of ['violations', 'schematic_parity', 'unconnected_items']) if (!Array.isArray(value[key])) throw new Error(`${name}: incomplete native report: ${key}`);
  const errors = (value.violations as Row[]).filter(row => row.severity === 'error');
  return { errors: errors.length, error_types: [...new Set(errors.map(row => String(row.type)))].sort(), parity: value.schematic_parity.length, unconnected: value.unconnected_items.length, report };
}

/** kicad-cli on copies: the baseline is clean, refills and saves, and each injected defect is caught by its own native rule. */
function nativeCases(smoke: Smoke, folder: string, project: string, part: string): void {
  const stem = project.slice(folder.length + 1), copy = (name: string): string => {
    const target = join(smoke.output, name);
    cpSync(folder, target, { recursive: true });
    return join(target, `${stem}.kicad_pcb`);
  };
  const text = readFileSync(`${project}.kicad_pcb`, 'utf8');
  const erc = join(smoke.output, 'erc.json');
  const ran = spawnSync(kicadCli, ['sch', 'erc', '--format', 'json', '--severity-all', '-o', erc, `${project}.kicad_sch`], { encoding: 'utf8', timeout: Math.ceil(smoke.remaining() * 1000) });
  if (ran.error || !existsSync(erc)) throw new Error('kicad-cli ERC did not report');
  const ercErrors = (readObject<Row>(erc).sheets as Row[]).flatMap(sheet => sheet.violations as Row[]).filter(row => row.severity === 'error');
  if (ercErrors.length) throw new Error(`baseline ERC is not clean: ${ercErrors.length} errors; inspect ${erc}`);
  const baseline = copy('native-baseline'), counts = drc(smoke, baseline, 'baseline', true);
  if (counts.errors || counts.parity || counts.unconnected) throw new Error(`baseline DRC is not clean: ${JSON.stringify(counts)}`);
  if (text.includes('(zone') && !readFileSync(baseline, 'utf8').includes('filled_polygon')) throw new Error('native refill did not save filled zone polygons');
  smoke.passed(CASES[0]!, { counts });
  const rules = readObject<Row>(`${project}.kicad_pro`).net_settings?.classes?.[0], clearance = Number(rules?.clearance), width = Number(rules?.track_width);
  if (!(clearance > 0) || !(width > 0)) throw new Error('project has no default class clearance and track width');
  const cases: [string, (text: string) => string, (counts: Row) => boolean][] = [
    // KiCad 10 reports a same-layer intersection of two nets as tracks_crossing. Half the project's own clearance is a violation by its own rule.
    [CASES[1]!, withShort, row => row.error_types.some((type: string) => type.includes('short') || type === 'tracks_crossing')],
    [CASES[2]!, source => withClearance(source, clearance / 2, width), row => row.error_types.includes('clearance')],
    [CASES[3]!, source => withWrongPadNet(source, part), row => row.parity > 0],
  ];
  for (const [name, inject, caught] of cases) {
    const board = copy(name);
    writeFileSync(board, inject(text));
    const found = drc(smoke, board, name);
    if (!caught(found)) throw new Error(`${name}: native report does not prove the defect: ${JSON.stringify(found)}`);
    smoke.passed(name, { counts: found });
  }
}

/** Places a defect, repairs it through the CLI, then tries a tampered candidate before the real adoption. */
function placementCycle(smoke: Smoke, board: string, target: string, part: string, pristine: string): void {
  const original = readFileSync(target, 'utf8'), protectedIdentity = pcbIdentity(target), { text, pose } = moveFootprint(original, part, 3);
  writeFileSync(target, text);
  if (!sameValue(pcbIdentity(target), protectedIdentity)) throw new Error('injection changed protected board identity');
  const injected = readFileSync(target), repair = join(smoke.output, 'repair.json');
  atomicJson(repair, { place: { [part]: pose } });
  const baseline = smoke.pcb(['check', board, '--fresh', '--json', '--timeout', String(smoke.remaining())], 1);
  const { findings } = nativeContract(smoke, baseline.run_id, 'failed');
  const defect = (findings.findings as Row[]).find(row => row.stage === 'drc' && row.severity === 'error' && (row.refs?.includes(part) || JSON.stringify(row.items ?? []).includes(part)));
  if (!defect) throw new Error(`injected ${part} defect was not found in real native DRC`);
  smoke.passed(CASES[5]!, { run_id: baseline.run_id, defect: defect.id, rule: defect.rule });
  const repaired = smoke.pcb(['edit', board, '--kind', 'place', '--spec', repair, '--json', '--timeout', String(smoke.remaining())]);
  const { findings: after } = nativeContract(smoke, repaired.run_id, 'passed');
  const receipt = smoke.read(repaired.run_id, 'operation/result.json'), candidate = receipt.candidate as string;
  if (!receipt.candidate_verified || !receipt.identity_preserved || !receipt.source_unchanged) throw new Error('CLI did not verify a preserved isolated repair');
  if (!readFileSync(target).equals(injected) || !sameValue(pcbIdentity(candidate), protectedIdentity)) throw new Error('repair changed the canonical specimen or protected identity');
  if ((after.findings as Row[]).some(row => row.id === defect.id)) throw new Error('named native defect was not resolved');
  for (const hook of readObject<Row>(join(smoke.checkout, 'hardware-design/boards', board, 'gate.json')).post_verify ?? []) {
    if (!existsSync(join(smoke.runs, repaired.run_id, 'operation', `${hook.stage as string}.log`))) throw new Error(`board semantic check did not run: ${hook.stage as string}`);
  }
  const before = layoutOf(pristine), layout = layoutOf(candidate);
  if (!sameValue(before.poses, layout.poses)) throw new Error('repair did not restore every original footprint pose');
  if (!sameValue(before.copper, layout.copper)) throw new Error('repair changed retained copper');
  smoke.passed(CASES[6]!, { run_id: repaired.run_id, candidate_sha256: sha(candidate), poses: Object.keys(layout.poses).length, copper: layout.copper.length });
  const adopt = ['adopt', repaired.run_id, '--baseline', baseline.run_id, '--defect', defect.id, '--json'], bytes = readFileSync(candidate);
  writeFileSync(candidate, Buffer.concat([bytes, Buffer.from('\n; regression tamper\n')]));
  const rejected = smoke.pcb(adopt, 2);
  writeFileSync(candidate, bytes);
  if (!/changed|does not match/.test(String(rejected.cause)) || !readFileSync(target).equals(injected)) throw new Error(`tampered candidate was not refused for its bytes: ${rejected.cause}`);
  smoke.passed(CASES[7]!, { cause: rejected.cause });
  const adopted = smoke.pcb(adopt);
  const backup = join(smoke.runs, repaired.run_id, 'backup', target.split('/').at(-1)!);
  if (bytes.equals(injected)) throw new Error('candidate equals the injected board: adoption replaced nothing');
  if (!readFileSync(target).equals(bytes) || !readFileSync(backup).equals(injected)) throw new Error('adoption did not keep exact candidate and backup bytes');
  if (adopted.before_sha256 !== sha(backup) || adopted.after_sha256 !== sha(target)) throw new Error('adoption receipt does not bind before and after bytes');
  smoke.passed(CASES[8]!, { before_sha256: adopted.before_sha256, after_sha256: adopted.after_sha256 });
}

function gapCycle(smoke: Smoke, board: string, target: string, cycle: string): void {
  const text = readFileSync(target, 'utf8'), { board: native } = boardJson(target);
  const allowed = (row: Segment): boolean => {
    const nm = (end: [number, number]): [number, number] => [Math.round(end[0] * 1e6), Math.round(end[1] * 1e6)];
    try { crossingGuard(native as never, row.net, row.layer, nm(row.start), nm(row.end)); return true; } catch { return false; }
  };
  const { text: gapped, removed } = removeSegment(text, allowed);
  writeFileSync(target, gapped);
  const injected = readFileSync(target), budget = ['--timeout', String(smoke.remaining()), '--cycle', cycle];
  const failed = smoke.pcb(['check', board, '--fresh', '--json', ...budget], 1);
  const { gate, findings } = nativeContract(smoke, failed.run_id, 'failed');
  if (gate.metrics.drc_errors !== 0 || gate.metrics.drc_parity !== 0 || gate.metrics.drc_unconnected < 1) throw new Error(`the gap was not an isolated native connectivity defect: ${JSON.stringify(gate.metrics)}`);
  const defect = (findings.findings as Row[]).find(row => row.stage === 'drc' && String(row.evidence?.pointer ?? '').startsWith('/unconnected_items/'));
  if (!defect || defect.severity !== 'error') throw new Error('native connectivity finding lacks an adoptable defect identity');
  smoke.passed(CASES[9]!, { run_id: failed.run_id, defect: defect.id, opens: gate.metrics.drc_unconnected, net: removed.net });
  const diagnosis = smoke.pcb(['routing', '--json', ...budget, 'diagnose', board, '--evidence', join(smoke.runs, failed.run_id, 'gate/result.json')]);
  const plan = join(smoke.runs, diagnosis.run_id, 'operation/report.json'), decision = readObject<Row>(plan);
  if (decision.status !== 'repairable' || decision.choice?.strategy !== 'straight_gap_bridge' || decision.choice?.net !== removed.net) throw new Error(`diagnosis did not select the one-gap repair: ${JSON.stringify(decision.rejected_gap_patterns)}`);
  smoke.passed(CASES[10]!, { run_id: diagnosis.run_id, plan_sha256: sha(plan), strategy: decision.choice.strategy });
  const repaired = smoke.pcb(['repair', board, '--plan', plan, '--json', ...budget]);
  nativeContract(smoke, repaired.run_id, 'passed');
  const operation = smoke.read(repaired.run_id, 'operation/result.json'), guard = smoke.read(repaired.run_id, 'operation/repair-guard.json');
  if (!readFileSync(target).equals(injected) || !operation.candidate_verified || !operation.identity_preserved) throw new Error('repair escaped isolation or lacks candidate verification');
  if (guard.added_items?.length !== 1 || guard.allowed_original_edits?.length) throw new Error('gap repair exceeded its one additive segment');
  smoke.passed(CASES[11]!, { run_id: repaired.run_id, candidate_sha256: guard.candidate_sha256 });
  const adopted = smoke.pcb(['adopt', repaired.run_id, '--baseline', failed.run_id, '--defect', defect.id, '--json']);
  const backup = join(smoke.runs, repaired.run_id, 'backup', target.split('/').at(-1)!);
  if (sha(target) !== operation.candidate_sha256 || !readFileSync(backup).equals(injected)) throw new Error('adoption did not keep exact candidate and backup bytes');
  smoke.passed(CASES[12]!, { after_sha256: adopted.after_sha256 });
}

function workflow(smoke: Smoke, project: string, board: string, part: string): void {
  smoke.summary.source = sourceState(project, board);
  snapshot(project, smoke.checkout, board);
  const { project: stem } = boardConfig(smoke.checkout, board);
  writeFileSync(join(smoke.checkout, 'FOCUS.md'), `## Frozen\n- ${board}\n`);
  nativeCases(smoke, dirname(stem), stem, part);
  const target = withSuffix(stem, '.kicad_pcb'), pristine = join(smoke.output, 'pristine.kicad_pcb');
  writeFileSync(pristine, readFileSync(target));
  const cycle = smoke.pcb(['cycle', 'start', board, '--owner', 'pcb-workflow-smoke', '--json']).cycle_id as string;
  smoke.summary.cycle_id = cycle;
  const parts = smoke.pcb(['parts', '--json', '--cycle', cycle, 'status', board], 1), review = smoke.read(parts.run_id, 'operation/report.json');
  if (review.status !== 'blocked' || !review.blockers?.length || review.qualified !== false) throw new Error('actual part-review gaps were not retained as unqualified blockers');
  smoke.passed(CASES[4]!, { run_id: parts.run_id, blockers: (review.blockers as Row[]).length });
  placementCycle(smoke, board, target, part, pristine);
  gapCycle(smoke, board, target, cycle);
  const finished = smoke.pcb(['cycle', 'finish', cycle, '--json']);
  if (finished.status !== 'recorded' || finished.qualified !== false || finished.evidence_issues?.length || finished.runs?.length !== 4) throw new Error(`cycle did not bind its four runs: ${JSON.stringify(finished.evidence_issues)}`);
  if (!(finished.runs as Row[]).every(row => row.evidence_verified)) throw new Error('cycle holds an unverified run');
  smoke.passed(CASES[13]!, { runs: (finished.runs as Row[]).map(row => row.run_id), covered_elapsed_s: finished.covered_elapsed_s });
}

/** Stops any run a failed step left behind, through its own durable handle. */
function settle(smoke: Smoke): void {
  if (!existsSync(smoke.runs)) return;
  for (const name of readdirSync(smoke.runs).filter(entry => entry.startsWith('run-'))) {
    if (!existsSync(join(smoke.runs, name, 'result.json'))) spawnSync(PCB, ['--project', smoke.checkout, 'cancel', name], { encoding: 'utf8', timeout: 10_000 });
  }
}

function main(argv: string[]): number {
  const { values } = parseFlags(argv, { project: { type: 'string' }, board: { type: 'string' }, output: { type: 'string' }, part: { type: 'string' }, timeout: { type: 'string' }, json: { type: 'boolean' } }, USAGE);
  if (!values.project || !values.board || !values.output) throw new UsageError(USAGE);
  const project = resolve(values.project), output = resolve(values.output), timeout = Number(values.timeout ?? 600);
  if (!Number.isFinite(timeout) || timeout <= 0) throw new UsageError('--timeout must be finite and positive');
  if (output === project || output.startsWith(`${project}/tools`) || output.startsWith(`${project}/hardware-design`)) throw new Error('evidence directory overlaps the source project');
  mkdirSync(output);
  const smoke = new Smoke(output, values.board, timeout), started = Date.now(), summary = smoke.summary;
  try {
    workflow(smoke, project, values.board, values.part ?? 'C1');
    if (!sameValue(sourceState(project, values.board), summary.source)) throw new Error('source project changed during the smoke');
    smoke.passed(CASES[14]!, { source_sha256: summary.source.sha256 });
    Object.assign(summary, { status: 'passed', cause: 'all workflow cases passed on the isolated copy; source project unchanged' });
  } catch (error) {
    summary.cause = (error as Error).message;
  }
  settle(smoke);
  summary.elapsed_s = (Date.now() - started) / 1000;
  summary.not_executed = CASES.filter(name => !(summary.cases as Row[]).some(row => row.case === name));
  atomicJson(join(output, 'summary.json'), summary);
  const verdict = `${summary.status === 'passed' ? 'PASS' : 'FAIL'}: ${summary.cases.length}/${CASES.length} cases; ${summary.cause}; evidence=${join(output, 'summary.json')}`;
  console.log(values.json ? JSON.stringify({ status: summary.status, cases: summary.cases.length, expected: CASES.length, cause: summary.cause, not_executed: summary.not_executed, elapsed_s: summary.elapsed_s }) : verdict);
  return summary.status === 'passed' ? 0 : 1;
}

runMain(import.meta.url, main);
