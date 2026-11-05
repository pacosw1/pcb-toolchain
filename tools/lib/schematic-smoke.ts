// Bounded actual KiCad export proof on isolated synthetic reviewed fixtures. A wrong native value must be seen, through the
// real export and the production parser; it proves that path and nothing about shipping CAD.
import { closeSync, cpSync, mkdirSync, openSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, extname, join, relative } from 'node:path';
import { atomicJson } from './json-file.ts';
import { runStage } from './lean-stage.ts';
import { deadlineAfter, remaining } from './lean-workflow.ts';
import { kicadCli } from './netlist.ts';
import { sha } from './pcb-workflow.ts';
import { dump, items, parse } from './pq-cadlib.ts';
import { jsonDumps, PyError, strip } from './py-compat.mjs';
import { round } from './py-numbers.ts';
import { caught, resolvePath, textOf, which } from './py-path.ts';
import { canonicalValue, checkContract, exportNative, number, pinKey, type Exporter } from './schematic-contract.ts';
import { makeFunctionalFixture, placed } from './schematic-fixture.ts';

const PINNED_KICAD = '10.0.6';
const ARTIFACT_SUFFIXES = new Set(['.xml', '.log', '.jsonl', '.json']);
const ERRORS = ['OSError', 'ValueError', 'KeyError', 'TypeError', 'RuntimeError', 'subprocess.TimeoutExpired', 'subprocess.CalledProcessError'];
const EXPORT_CASES = ['actual_native_export_is_parsed', 'actual_wrong_native_value_is_detected'];
const FULL_CASES = ['actual_native_export_passes_declared_assertions', 'actual_wrong_native_value_is_rejected'];
const EXPORT_SCOPE = 'synthetic native export/parser/canonicalization only; no PDF, part-review or complete functional-contract verdict';
const FULL_SCOPE = 'synthetic native schematic export/functional assertions; no shipping CAD, ERC/DRC, routing or production selection';

type Json = Record<string, any>;
export interface SmokeResult {
  schema: string;
  status: string;
  qualified: boolean;
  scope: string;
  export_only: boolean;
  cases: Json[];
  cause?: string;
  elapsed_s?: number;
  runtime?: Json;
  [field: string]: unknown;
}

const valueError = (message: string) => new PyError('ValueError', message);

/** Files below `folder`, in name order. */
function filesBelow(folder: string): string[] {
  return readdirSync(folder, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1)).flatMap(entry => {
    const path = join(folder, entry.name);
    return entry.isDirectory() ? filesBelow(path) : entry.isFile() ? [path] : [];
  });
}

/** Native CI adapter coverage; deliberately does not evaluate part reviews. */
export async function exportObservation(schematic: string, artifacts: string, exporter: Exporter = exportNative): Promise<Json> {
  mkdirSync(artifacts, { recursive: true });
  const { parsed, evidence, tools } = await exporter(schematic, artifacts);
  const adapted = parsed.pins.get(pinKey('J1', '1'))?.net === '/A' && parsed.pins.get(pinKey('J3', '1'))?.net === '/B'
    && parsed.fields.get('J1')?.get('Operating_Mode') === 'low';
  if (!adapted) throw valueError('actual native XML pins/operating-field parsing differs from source fixture');
  const [value, unit] = canonicalValue(parsed.values.get('J1'), 'F');
  return {
    schema: 'iot-lab.schematic-native-export-observation.v1', status: 'observed', qualified: false,
    scope: 'actual native export and production parser/canonicalization only; no reviewed-part or functional-contract verdict',
    actual_nominal: { value: String(value), unit }, inputs: evidence, tool_inputs: tools, evidence_directory: artifacts,
  };
}

/** ElementTree's escaping: `&`, `<` and `>` in text; also quotes and line breaks in an attribute. */
const xmlText = (text: string) => text.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
const xmlAttribute = (text: string) => xmlText(text).replaceAll('"', '&quot;').replaceAll('\n', '&#10;').replaceAll('\r', '&#13;').replaceAll('\t', '&#09;');
const attributes = (values: Record<string, string>) => Object.entries(values).map(([name, value]) => ` ${name}="${xmlAttribute(value)}"`).join('');
const sortedDump = (value: object) => jsonDumps(new Map(Object.entries(value).sort(([a], [b]) => (a < b ? -1 : 1))));

export function writeJunit(output: string, result: SmokeResult): void {
  const cases = result.export_only ? EXPORT_CASES : FULL_CASES;
  const rows = new Map(result.cases.map(row => [row.case, row]));
  let failed = cases.filter(name => rows.get(name)?.status !== 'passed');
  if (result.status !== 'passed' && !failed.length) failed = [cases.at(-1) as string];
  const out = sortedDump({ scope: result.scope, export_only: result.export_only, qualified: false, runtime: result.runtime ?? null, summary: join(output, 'summary.json') });
  const testcases = cases.map(name => {
    const failure = failed.includes(name) ? `<failure${attributes({ message: result.cause ?? '' })}>Required native observation failed or did not execute</failure>` : '';
    const row = sortedDump(rows.get(name) ?? { case: name, status: 'not_executed' });
    return `<testcase${attributes({ classname: 'iot_lab.schematic_native_export', name })}>${failure}<system-out>${xmlText(row)}</system-out></testcase>`;
  });
  const suite = attributes({ name: 'iot-lab.schematic-native-export', tests: '2', failures: String(failed.length), errors: '0', skipped: '0', time: String(result.elapsed_s) });
  writeFileSync(join(output, 'junit.xml'), `<?xml version='1.0' encoding='utf-8'?>\n<testsuite${suite}><system-out>${xmlText(out)}</system-out>${testcases.join('')}</testsuite>`);
}

async function kicadVersion(output: string, deadline: number): Promise<Json> {
  const found = which(kicadCli());
  if (!found) throw valueError('native KiCad executable unavailable');
  const logPath = join(output, 'version.log');
  const log = openSync(logPath, 'w');
  let code: number;
  try {
    ({ returncode: code } = await runStage([found, '--version'], { stage: 'schematic-proof-version', eventFile: join(output, 'events.jsonl'), deadline, stdout: log, stderr: log }));
  } finally {
    closeSync(log);
  }
  const actual = strip(textOf(logPath));
  if (code || actual !== PINNED_KICAD) throw valueError(`proof requires actual KiCad10.0.6; observed ${actual}`);
  const cli = resolvePath(found);
  return { kicad_version: actual, cli, cli_sha256: sha(cli) };
}

/** The same fixture with J1 at 10uF, in both native files. */
function wrongValueCopy(source: string, target: string): void {
  cpSync(source, target, { recursive: true });
  for (const [name, kind] of [['fixture.kicad_sch', 'symbol'], ['fixture.kicad_pcb', 'footprint']] as const) {
    const path = join(target, 'hardware-design/boards/PART-FIXTURE', name);
    const tree = parse(textOf(path));
    const value = items(placed(tree, kind, 'J1'), 'property').find(property => property[1] === 'Value');
    if (!value) throw valueError('fixture has no Value');
    value[2] = '10uF';
    writeFileSync(path, dump(tree));
  }
}

async function prove(output: string, result: SmokeResult, deadline: number): Promise<void> {
  const exportOnly = result.export_only;
  result.runtime = await kicadVersion(output, deadline);
  const source = join(output, 'source');
  const fixture = makeFunctionalFixture(mkdirReturning(source));
  const original = Object.fromEntries(filesBelow(source).map(path => [relative(source, path), sha(path)]));
  const baseline: Json = exportOnly ? await exportObservation(fixture.schematic, join(output, 'baseline-native'))
    : await checkContract(source, fixture.board, fixture.contract, join(output, 'baseline.json'));
  atomicJson(join(output, 'baseline.json'), baseline);
  if (exportOnly) {
    if (!number(baseline.actual_nominal.value).equals(number('0.000001'))) throw valueError('actual native baseline nominal is not the authored1uF fixture');
  } else if (baseline.status !== 'passed') throw valueError(`native baseline blocked: ${jsonDumps(baseline.blockers)}`);
  result.cases.push({
    case: exportOnly ? EXPORT_CASES[0] : FULL_CASES[0], status: 'passed', report: 'baseline.json', assertions: exportOnly ? 3 : baseline.assertions.length,
    xml: join(baseline.evidence_directory, 'native-netlist.xml'),
  });
  if ((remaining(deadline) ?? 1) <= 0) throw valueError('proof budget exhausted after native baseline');
  const negative = join(output, 'wrong-value-source');
  wrongValueCopy(source, negative);
  const moved = (path: string) => join(negative, relative(source, path));
  const wrong: Json = exportOnly ? await exportObservation(moved(fixture.schematic), join(output, 'wrong-value-native'))
    : await checkContract(negative, fixture.board, moved(fixture.contract), join(output, 'wrong-value.json'));
  atomicJson(join(output, 'wrong-value.json'), wrong);
  let cause: string;
  if (exportOnly) {
    const same = wrong.actual_nominal.value === baseline.actual_nominal.value && wrong.actual_nominal.unit === baseline.actual_nominal.unit;
    if (!number(wrong.actual_nominal.value).equals(number('0.00001')) || same) throw valueError('production canonicalizer did not distinguish the actual changed native nominal');
    cause = 'production native parser/canonicalizer detects1uF→10uF; part review not evaluated';
  } else {
    const failure = (wrong.assertions as Json[]).find(row => row.id === 'NOMINAL') ?? {};
    if (wrong.status !== 'blocked' || failure.status !== 'blocked' || !String(failure.cause ?? '').includes('outside sourced interval')) {
      throw valueError('wrong native nominal value did not fail the independent functional assertion');
    }
    cause = failure.cause;
  }
  const xml = join(wrong.evidence_directory, 'native-netlist.xml');
  if (!textOf(xml).includes('<value>10uF</value>')) throw valueError('negative assertion did not use actual mutated native export');
  result.cases.push({ case: exportOnly ? EXPORT_CASES[1] : FULL_CASES[1], status: 'passed', report: 'wrong-value.json', xml, assertion: 'NOMINAL', cause });
  if (Object.entries(original).some(([name, digest]) => sha(join(source, name)) !== digest)) throw valueError('original synthetic native source changed during the proof');
  Object.assign(result, {
    status: 'passed', source_inputs: original,
    cause: exportOnly ? 'actual native export/parser/canonicalization detects an isolated changed value; part review not evaluated'
      : 'actual native export feeds passing assertions and rejects an isolated wrong value',
  });
}

function mkdirReturning(path: string): string {
  mkdirSync(path);
  return path;
}

export async function runProof(outputPath: string, timeout = 45, exportOnly = false): Promise<SmokeResult> {
  const output = resolvePath(outputPath);
  mkdirSync(dirname(output), { recursive: true });
  mkdirSync(output);
  const started = performance.now();
  const deadline = deadlineAfter(timeout);
  const result: SmokeResult = {
    schema: 'iot-lab.schematic-contract-smoke.v1', status: 'failed', qualified: false, scope: exportOnly ? EXPORT_SCOPE : FULL_SCOPE, export_only: exportOnly, cases: [],
  };
  try {
    await prove(output, result, deadline);
  } catch (error) {
    if (!caught(error, ...ERRORS) && !(error instanceof Error && error.constructor === Error)) throw error;
    result.cause = (error as Error).message;
  }
  result.elapsed_s = round((performance.now() - started) / 1000, 3);
  writeJunit(output, result);
  result.artifacts = Object.fromEntries(filesBelow(output).filter(path => ARTIFACT_SUFFIXES.has(extname(path))).map(path => [relative(output, path), sha(path)]));
  atomicJson(join(output, 'summary.json'), result);
  return result;
}
