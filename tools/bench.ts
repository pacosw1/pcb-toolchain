// Placer and router benchmark: run a pinned suite of two arms, analyze it with paired statistics, compare sealed results.
//   tools/bench.ts plan SUITE.json
//   tools/bench.ts run SUITE.json --out DIR [--runs-dir DIR] [--root DIR] [--no-analyze] [--wait] [--no-lock] [--json]
// `run` holds a machine-wide lock (tools/lib/bench-lock.ts) so benchmarks on one Mac do not share CPU; --wait queues behind a holder.
//   tools/bench.ts analyze DIR [--root DIR] [--json]
//   tools/bench.ts compare RESULT_A.json RESULT_B.json [--arm-a ID] [--arm-b ID] [--json]
// Every trial runs through the ordinary pcb run path; this tool never edits canonical CAD and never qualifies a design.
import { copyFileSync, existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { projectRoot } from './lib/project-root.mjs';
import { errorText, parseFlags, runMain, UsageError } from './lib/cli.ts';
import { atomicJson, sha256File } from './lib/json-file.ts';
import { pcbIdentity } from './lib/pcb-identity.ts';
import { thermalServices } from './lib/outcome-thermal.ts';
import { evaluateStudy } from './lib/placement-outcomes.ts';
import { acquire, describeOwner } from './lib/bench-lock.ts';
import { buildResult, compare, formatAnalysis, type BenchResult, type Evaluation } from './lib/bench-analyze.ts';
import { buildStudy, readRecord, runSuite, spawnExecutor, type TrialRecord } from './lib/bench-run.ts';
import { expandTrials, validateSuite, verifyInputs, type Suite } from './lib/bench-suite.ts';

const USAGE = [
  'usage: bench.ts plan SUITE.json',
  '       bench.ts run SUITE.json --out DIR [--runs-dir DIR] [--root DIR] [--no-analyze] [--wait] [--no-lock] [--json]',
  '       bench.ts analyze DIR [--root DIR] [--json]',
  '       bench.ts compare RESULT_A.json RESULT_B.json [--arm-a ID] [--arm-b ID] [--json]',
].join('\n');

const FLAGS = {
  out: { type: 'string' }, 'runs-dir': { type: 'string' }, root: { type: 'string' }, 'no-analyze': { type: 'boolean' }, wait: { type: 'boolean' }, 'no-lock': { type: 'boolean' }, json: { type: 'boolean' },
  'arm-a': { type: 'string' }, 'arm-b': { type: 'string' }, project: { type: 'string' },
} as const;

const readJson = (path: string): unknown => JSON.parse(readFileSync(path, 'utf8'));
const loadSuite = (path: string): Suite => validateSuite(readJson(path));

function plan(path: string, json: boolean): number {
  const suite = loadSuite(path);
  const trials = expandTrials(suite);
  if (json) console.log(JSON.stringify({ suite_id: suite.suite_id, trials: trials.length, plan: trials }));
  else {
    console.log(`${suite.suite_id}: ${trials.length} trials (${suite.boards.length} boards x ${suite.seeds.length} seeds x 2 arms), budget ${JSON.stringify(suite.budget)}`);
    for (const trial of trials) console.log(`  ${trial.id}  ${trial.split}  ${trial.argv.join(' ')}`);
  }
  return 0;
}

function evaluation(root: string, out: string, suite: Suite): { value: Evaluation; sha: string | null } {
  const study = join(out, 'study.json');
  const report = join(out, 'evaluation.json');
  try {
    const result = evaluateStudy(root, study, suite.suite_id, { pcbIdentity, thermal: thermalServices() }) as unknown as Evaluation;
    atomicJson(report, result);
    return { value: result, sha: sha256File(report) };
  } catch (error) {
    return { value: { status: 'error', error: errorText(error) }, sha: null };
  }
}

function analyzeFolder(out: string, root: string, json: boolean): number {
  const suitePath = join(out, 'suite.json');
  const suite = loadSuite(suitePath);
  const records = expandTrials(suite).map(trial => readRecord(out, trial.id)).filter((item): item is TrialRecord => item !== null);
  atomicJson(join(out, 'study.json'), buildStudy(suite, records));
  const { value, sha } = evaluation(root, out, suite);
  const inputs: Record<string, string> = { suite: sha256File(suitePath), study: sha256File(join(out, 'study.json')) };
  for (const item of records) if (item.result_sha256) inputs[`trial:${item.id}`] = item.result_sha256;
  for (const arm of suite.arms) if (arm.toolchain_sha256) inputs[`toolchain:${arm.id}`] = arm.toolchain_sha256;
  const result: BenchResult = buildResult(suite, sha256File(suitePath), records, value, sha, inputs);
  atomicJson(join(out, 'result.json'), result);
  if (json) console.log(JSON.stringify(result));
  else {
    const labels = result.arms as [string, string];
    console.log(`${result.suite_id}: ${result.trials.length} trials, ${result.no_run_trials} with no sealed run, ${result.unknown_outcomes} unknown`);
    console.log(`verified means: ${result.metric === 'native' ? 'native DRC errors, unconnected and parity all 0' : 'the full configured gate passed'}`);
    console.log(formatAnalysis('overall', result.overall, labels));
    for (const [name, analysis] of Object.entries(result.by_split)) console.log(formatAnalysis(`split ${name}`, analysis, labels));
    for (const [name, analysis] of Object.entries(result.by_case)) console.log(formatAnalysis(`case ${name}`, analysis, labels));
    console.log(formatAnalysis(`secondary metric (${result.secondary.metric})`, result.secondary.overall, labels));
    if (!result.evidence_complete) console.log(`evidence incomplete: evaluation ${result.evaluation.status}${result.evaluation.error ? ` (${result.evaluation.error})` : ''}, ${result.evaluation.blockers} blockers; verdicts are provisional`);
    console.log(`sealed: ${join(out, 'result.json')} sha256 ${result.result_sha256}`);
  }
  return result.evidence_complete ? 0 : 1;
}

async function run(path: string, values: { out?: string; 'runs-dir'?: string; root?: string; 'no-analyze'?: boolean; wait?: boolean; 'no-lock'?: boolean; json?: boolean }): Promise<number> {
  if (!values.out) throw new UsageError(USAGE);
  const root = projectRoot(values.root);
  const out = resolve(values.out);
  const suite = loadSuite(path);
  verifyInputs(suite, root);
  const suiteCopy = join(out, 'suite.json');
  if (existsSync(suiteCopy) && sha256File(suiteCopy) !== sha256File(path)) throw new Error(`${out} already holds a different suite; use a new --out`);
  const release = values['no-lock'] ? () => {} : await acquire({ label: `bench ${suite.suite_id} -> ${out}`, wait: values.wait,
    onWait: owner => console.error(`bench lock held by ${describeOwner(owner)}; waiting`) });
  if (!values['no-lock'] && !values.json) console.error(`bench lock acquired (pid ${process.pid})`);
  for (const signal of ['SIGINT', 'SIGTERM'] as const) process.once(signal, () => { release(); process.exit(130); });
  try { return await runLocked(path, values, { root, out, suite }); } finally { release(); }
}

async function runLocked(path: string, values: { 'runs-dir'?: string; 'no-analyze'?: boolean; json?: boolean }, context: { root: string; out: string; suite: Suite }): Promise<number> {
  const { root, out, suite } = context;
  const suiteCopy = join(out, 'suite.json');
  const records = await runSuite(suite, {
    root, runsDir: resolve(values['runs-dir'] ?? join(root, '.gate/cli')), out, executor: spawnExecutor,
    onTrial: (trial, item, index, total) => { if (!values.json) console.error(`[${index + 1}/${total}] ${trial.id}: ${item.status}${item.cause ? ` (${item.cause})` : ''} ${item.wall_s.toFixed(0)}s`); },
  });
  if (!existsSync(suiteCopy)) copyFileSync(path, suiteCopy);
  if (values['no-analyze']) { console.log(`ran ${records.length} trials; analyze with: bench.ts analyze ${out}`); return 0; }
  return analyzeFolder(out, root, Boolean(values.json));
}

function compareResults(first: string, second: string, values: { 'arm-a'?: string; 'arm-b'?: string; json?: boolean }): number {
  const a = readJson(first) as BenchResult, b = readJson(second) as BenchResult;
  const comparison = compare(a, b, values['arm-a'], values['arm-b']);
  if (values.json) console.log(JSON.stringify(comparison));
  else {
    console.log(formatAnalysis(`${comparison.a.arm} (A) vs ${comparison.b.arm} (B), suite ${comparison.suite_id}`, comparison.analysis, ['A', 'B']));
    for (const caveat of comparison.caveats) console.log(`caveat: ${caveat}`);
  }
  return 0;
}

async function main(argv: string[]): Promise<number> {
  const parsed = parseFlags(argv, FLAGS, USAGE);
  const values = { ...parsed.values, root: parsed.values.root ?? parsed.values.project };
  const positionals = parsed.positionals[0] === 'bench' ? parsed.positionals.slice(1) : parsed.positionals;
  const [command, first, second] = positionals;
  if (command === 'plan' && first && positionals.length === 2) return plan(first, Boolean(values.json));
  if (command === 'run' && first && positionals.length === 2) return run(first, values);
  if (command === 'analyze' && first && positionals.length === 2) {
    if (!existsSync(join(first, 'suite.json'))) throw new Error(`${first} has no suite.json; it is not a bench output folder`);
    return analyzeFolder(resolve(first), projectRoot(values.root), Boolean(values.json));
  }
  if (command === 'compare' && first && second && positionals.length === 3) return compareResults(first, second, values);
  throw new UsageError(USAGE);
}

runMain(import.meta.url, main);
