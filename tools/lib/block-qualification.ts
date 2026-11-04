// Source-bound block qualification. CAD and declared facts are never promoted: native identities establish reuse, gate
// receipts establish checks, attributed reviews establish applicability. A bench receipt also needs raw measured data
// against an approved, sourced test plan. No level transfers to another target.
import { mkdirSync } from 'node:fs';
import { basename, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { bindInstance, verifyBinding } from './block-bindings.ts';
import { blockFolders, readBlock, reuse, type BlockRow } from './block-reuse.ts';
import { errorText } from './cli.ts';
import { fingerprint, sha256Text } from './fingerprint.ts';
import { parseIso } from './iso-time.ts';
import { atomicJson, readObject, sha256File } from './json-file.ts';
import { footprints, instanceOf, symbolOf } from './native-board.ts';
import { compare, dictRows, jsonCanonical, jsonLoad, readText, splitlines, utcNow } from './py-compat.mjs';
import { isDirectory, isFile, isRelativeTo, joinPath, pathExists, resolvePath, textOf, withSuffix } from './py-path.ts';
import { isDict, isNumber, need, pyFloat, sameValue, type Dict } from './py-values.ts';
import { field, forms, type SList } from './sexpr.ts';

export const SCHEMA = 'iot-lab.block-qualification.v1';
const NATIVE_SCHEMA = 'iot-lab.block-native.v1';
const ERC_ARGS = ['sch', 'erc', '--format', 'json', '--severity-all', '--units', 'mm'];
const DRC_ARGS = ['pcb', 'drc', '--schematic-parity', '--refill-zones', '--format', 'json', '--severity-all', '--units', 'mm'];
const SEVERITIES = new Set(['error', 'warning', 'info', 'exclusion']);
const REQUIRED_CHECKS = ['erc', 'drc', 'paths', 'viapads', 'kicad_happy', 'port_labels'];
const REQUIRED_METRICS = ['erc_errors', 'drc_errors', 'drc_parity', 'drc_unconnected'];
const PROJECT_FILES = ['.kicad_pcb', '.kicad_sch', '.kicad_pro', '.kicad_dru'];
// The code a receipt depends on, recorded as evidence so that a changed checker makes the receipt stale.
const IMPLEMENTATION = ['block-qualification.ts', 'block-reuse.ts', 'block-parts.ts', 'block-bindings.ts', 'native-board.ts', 'fingerprint.ts', 'decimal.ts', 'sexpr.ts'];

export const read = (path: string): Dict => readObject<Dict>(path, `${path}: expected a JSON object`);
const asList = <T = Dict>(value: unknown): T[] => (Array.isArray(value) ? value : []) as T[];
const asDict = (value: unknown): Dict => isDict(value) ? value : {};
const truthy = (value: unknown): boolean => Array.isArray(value) ? value.length > 0 : isDict(value) ? Object.keys(value).length > 0 : Boolean(value);

/** Gate configuration follows JavaScript truthiness: {} enables a checker. */
const enabled = (value: unknown): boolean => value !== null && value !== undefined && value !== false && value !== '' && value !== 0;

export function timestamp(value: unknown): number {
  if (typeof value !== 'string') throw new Error('evidence requires an attributable ISO timestamp with timezone');
  const instant = parseIso(value);
  if (!instant.zoned) throw new Error('evidence timestamp must include its timezone');
  return instant.seconds;
}

/** Match native hierarchical symbol UUID sets, never names or part values. */
function sheetRows(schematic: string): Map<string, Dict> {
  const roots = forms(textOf(schematic));
  const root = roots[0];
  if (roots.length !== 1 || !Array.isArray(root) || root[0] !== 'kicad_sch') throw new Error('expected native schematic');
  const sheets = new Map<string, Dict>();
  for (const form of root.slice(1)) {
    if (!Array.isArray(form) || form[0] !== 'sheet') continue;
    const uid = (field(form, 'uuid') ?? [''])[0] as string;
    const props = new Map(form.filter((item): item is SList => Array.isArray(item) && item[0] === 'property').map(item => [item[1] as string, item[2] as string]));
    const name = props.get('Sheetfile') ?? props.get('Sheet file');
    if (uid && name) {
      const sheet = resolvePath(joinPath(dirname(schematic), name));
      sheets.set(`/${uid}`, { sheet_file: name, sheet_name: props.get('Sheetname') ?? null, sheet_path: sheet, sheet_sha256: sha256File(sheet) });
    }
  }
  return sheets;
}

const blockIdOf = (directory: string): string => basename(directory).replace(/\.kicad_block$/, '');

function libraryCandidates(library: string): [string, Set<string>][] {
  const candidates: [string, Set<string>][] = [];
  for (const directory of blockFolders(library)) {
    const source = joinPath(directory, `${blockIdOf(directory)}.kicad_pcb`);
    if (!isFile(source)) continue;
    const ids = footprints(source).map(part => symbolOf(part.path));
    if (ids.length && ids.every(Boolean) && new Set(ids).size === ids.length) candidates.push([directory, new Set(ids)]);
  }
  return candidates;
}

const sameSet = (a: ReadonlySet<string>, b: ReadonlySet<string>): boolean => a.size === b.size && [...a].every(item => b.has(item));

function instanceRow(instance: string, ids: Set<string>, sheet: Dict, library: string, matched: string[], target: string): Dict {
  const row: Dict = { instance_path: instance, symbol_uuids: [...ids].sort(compare), status: 'unidentified', level: 0, ...sheet };
  if (row.sheet_file) {
    // An explicit native sheet reference, not a part or name similarity match. A matching filename grants no binding.
    const stem = basename(row.sheet_file as string).replace(/\.[^.]*$/, '');
    const named = joinPath(library, `${stem}.kicad_block`);
    if (isDirectory(named)) {
      row.referenced_block_id = blockIdOf(named);
      row.binding_failure = 'native symbol identities differ from the current library revision';
    }
  }
  if (matched.length === 1) {
    const directory = matched[0] as string;
    row.block_id = blockIdOf(directory);
    row.status = 'native_identity';
    try {
      row.binding = bindInstance(directory, target, instance);
      row.status = 'bound_draft';
      delete row.binding_failure;
    } catch (error) {
      row.binding_failure = errorText(error);
    }
  } else if (matched.length > 1) {
    row.status = 'ambiguous';
    row.candidates = matched.map(path => basename(path));
  }
  return row;
}

export function inventory(rootPath: string, libraryPath: string, board: string) {
  const root = resolvePath(rootPath), library = resolvePath(libraryPath);
  if (!/^[A-Z0-9-]+$/.test(board)) throw new Error('expected configured board ID');
  const config = joinPath(root, 'hardware-design/boards', board, 'gate.json');
  const cfg = read(config);
  const project = need<string>(cfg, 'project');
  const target = resolvePath(withSuffix(joinPath(dirname(config), project), '.kicad_pcb'));
  const parts = footprints(target);
  const sheets = sheetRows(withSuffix(target, '.kicad_sch'));
  const instances = new Map<string, Set<string>>();
  for (const part of parts) {
    const instance = instanceOf(part.path);
    if (instance) instances.set(instance, (instances.get(instance) ?? new Set()).add(symbolOf(part.path)));
  }
  const candidates = libraryCandidates(library);
  const rows = [...instances].sort(([a], [b]) => compare(a, b)).map(([instance, ids]) => {
    const matched = candidates.filter(([, sourceIds]) => sameSet(sourceIds, ids)).map(([directory]) => directory);
    return instanceRow(instance, ids, sheets.get(instance) ?? {}, library, matched, target);
  });
  return {
    schema: 'iot-lab.block-inventory.v1', board, project, target, target_sha256: sha256File(target), config_sha256: sha256File(config),
    instances: rows, authoritative_instances: rows.filter(row => 'block_id' in row).length,
    cause: rows.length ? 'native hierarchical symbol identities inspected' : 'no authoritative block instances: native board paths are flat',
    qualification: 'draft; inventory grants no qualification',
  };
}

/** Same error/parity/unconnected acceptance policy as gate-core.mjs. */
export function nativeMetrics(directory: string) {
  const erc = read(joinPath(directory, 'erc.json')), drc = read(joinPath(directory, 'drc.json'));
  const sheets = erc.sheets;
  if (!Array.isArray(sheets) || !sheets.length) throw new Error('native ERC report has no sheets');
  const sheetGroups = sheets.map(sheet => (sheet as Dict).violations);
  if ([...sheetGroups, drc.violations, drc.schematic_parity, drc.unconnected_items].some(group => !Array.isArray(group))) {
    throw new Error('incomplete native reports');
  }
  const violations = [...sheetGroups, drc.violations].flat() as unknown[];
  if (violations.some(item => !isDict(item) || !SEVERITIES.has(item.severity as string))) throw new Error('malformed native violation');
  const errors = (rows: unknown): number => (rows as Dict[]).filter(row => row.severity === 'error').length;
  return {
    erc_errors: sheetGroups.reduce<number>((total, group) => total + errors(group), 0), drc_errors: errors(drc.violations),
    drc_parity: (drc.schematic_parity as unknown[]).length, drc_unconnected: (drc.unconnected_items as unknown[]).length,
  };
}

/** One owned process family, run to its end. The lean owner supplies this. */
export type OwnedRunner = (command: string[], options: { cwd: string; log: string; label: string; timeoutSeconds: number }) =>
Promise<{ returncode: number | null; cleanup: { complete?: boolean }; settled: boolean }>;

export interface NativeTools {
  /** The resolved KiCad CLI, or null when it is unavailable. */
  binary: string | null;
  version: (binary: string, timeoutSeconds: number) => string;
  runOwned: OwnedRunner;
  /** Seconds left of the deadline this call started. */
  remaining: () => number;
}

/** Fresh standalone ERC/DRC evidence with an owned process family. */
export async function native(directoryPath: string, outputPath: string, tools: NativeTools) {
  const directory = resolvePath(directoryPath), output = resolvePath(outputPath);
  if (isRelativeTo(output, directory)) throw new Error('native evidence must live outside the block source');
  const row = readBlock(directory);
  if (row.missing_files.length || row.facts_errors.length) throw new Error('complete block CAD and valid facts required');
  if (!tools.binary) throw new Error('KiCad CLI unavailable; set KICAD_CLI');
  const binary = resolvePath(tools.binary);
  mkdirSync(dirname(output), { recursive: true });
  mkdirSync(output);
  const checks: Dict = {};
  const report: Dict = {
    schema: NATIVE_SCHEMA, block_id: row.id, source_sha256: row.source_sha256, source_directory: directory, started_at: utcNow(),
    executable: binary, executable_sha256: sha256File(binary), status: 'error', checks,
  };
  try {
    report.tool_version = tools.version(binary, Math.min(10, tools.remaining())).trim();
    if (!report.tool_version) throw new Error('native tool version unavailable');
    for (const [name, args, extension] of [['erc', ERC_ARGS, '.kicad_sch'], ['drc', DRC_ARGS, '.kicad_pcb']] as const) {
      const result = joinPath(output, `${name}.json`), log = joinPath(output, `${name}.log`);
      const command = [binary, ...args, '-o', result, joinPath(directory, row.id + extension)];
      const check: Dict = { command };
      checks[name] = check;
      process.stderr.write(`START: block ${name}; progress unknown\n`);
      const run = await tools.runOwned(command, { cwd: directory, log, label: `block ${name}`, timeoutSeconds: tools.remaining() });
      Object.assign(check, { exit_code: run.returncode, cleanup: run.cleanup });
      if (!run.settled || !run.cleanup.complete) throw new Error('native owned process cleanup unconfirmed');
      Object.assign(check, { report_sha256: sha256File(result), log_sha256: sha256File(log) });
      if (run.returncode !== 0) throw new Error(`native ${name} did not complete successfully`);
      process.stderr.write(`PASS: block ${name} invocation completed\n`);
    }
    const metrics = nativeMetrics(output);
    report.metrics = metrics;
    if (Object.values(metrics).some(Boolean)) throw new Error('source native ERC/DRC/parity targets not met');
    if (readBlock(directory).source_sha256 !== row.source_sha256) throw new Error('block source changed during native checks');
    report.status = 'passed';
    report.cause = 'standalone native ERC/DRC/parity targets met';
  } catch (error) {
    report.cause = errorText(error);
  }
  report.finished_at = utcNow();
  atomicJson(joinPath(output, 'result.json'), report);
  return report;
}

/** Every file a decision read, with its hash; null marks an input that must stay absent. */
export class Evidence {
  readonly files = new Map<string, string | null>();

  file(path: string): string {
    const resolved = resolvePath(path);
    const digest = sha256File(resolved);
    // A recorded null is an input that had to stay absent, so has() and not ??: its appearing is a change.
    if (!this.files.has(resolved)) this.files.set(resolved, digest);
    if (this.files.get(resolved) !== digest) throw new Error(`evidence changed during qualification: ${resolved}`);
    return resolved;
  }

  artifact(spec: unknown, base: string): string {
    if (!isDict(spec) || !spec.path || !spec.sha256) throw new Error('evidence artifact requires path and sha256');
    const path = this.file(joinPath(base, spec.path as string));
    if (sha256File(path) !== spec.sha256) throw new Error(`stale evidence artifact: ${path}`);
    return path;
  }

  absent(path: string): void {
    if (pathExists(path) || (this.files.get(path) ?? null) !== null) throw new Error(`previously absent evidence input appeared: ${path}`);
    this.files.set(path, null);
  }

  document(spec: unknown, base: string): string {
    if (!isDict(spec) || !spec.locator) throw new Error('sourced evidence requires a page/section/record locator');
    return this.artifact(spec, base);
  }
}

function requireReview(value: unknown, evidence: Evidence, base: string): void {
  if (!isDict(value) || value.verdict !== 'pass' || !value.reviewer || !value.reviewed_at) {
    throw new Error('applicability review needs pass verdict, reviewer and reviewed_at');
  }
  timestamp(value.reviewed_at);
  evidence.document(value.evidence, base);
}

function verifyNative(pathGiven: string, row: BlockRow, evidence: Evidence): void {
  const path = evidence.file(pathGiven);
  const result = read(path);
  if (result.schema !== NATIVE_SCHEMA || result.status !== 'passed' || result.block_id !== row.id
      || result.source_sha256 !== row.source_sha256 || resolvePath((result.source_directory as string) ?? '') !== row.source_directory) {
    throw new Error('stale or unsuccessful source native evidence');
  }
  const binary = evidence.file(need<string>(result, 'executable'));
  if (sha256File(binary) !== need(result, 'executable_sha256') || !result.tool_version) throw new Error('native executable changed or version unavailable');
  if (timestamp(result.finished_at) < timestamp(result.started_at)) throw new Error('source native timestamps disagree');
  const folder = dirname(path);
  for (const [name, args, extension] of [['erc', ERC_ARGS, '.kicad_sch'], ['drc', DRC_ARGS, '.kicad_pcb']] as const) {
    const check = asDict(asDict(result.checks)[name]);
    if (check.exit_code !== 0 || asDict(check.cleanup).complete !== true) throw new Error(`source native invocation incomplete: ${name}`);
    const expected = [binary, ...args, '-o', joinPath(folder, `${name}.json`), joinPath(row.source_directory, row.id + extension)];
    if (!sameValue(check.command ?? [], expected)) throw new Error(`unsupported source native invocation: ${name}`);
    for (const [suffix, key] of [['json', 'report_sha256'], ['log', 'log_sha256']] as const) {
      if (sha256File(evidence.file(joinPath(folder, `${name}.${suffix}`))) !== check[key]) throw new Error(`source native artifact changed: ${name}`);
    }
  }
  const metrics = nativeMetrics(folder);
  if (!sameValue(metrics, result.metrics) || Object.values(metrics).some(Boolean)) throw new Error('source native report targets not met');
}

/** The one gate command that counts: tools/gate.mjs BOARD, fresh, into this run's evidence folder. */
function checkGateCommand(manifest: Dict, board: string, root: string, run: string, evidence: Evidence): void {
  const command = asList<string>(manifest.command).slice(1);
  if (!command.length || command.shift() !== joinPath(root, 'tools/gate.mjs')) throw new Error('unsupported gate mode; fresh target checks required');
  const seen = new Set<string>();
  while (command.length) {
    const token = command.shift() as string;
    if (seen.has(token)) throw new Error('ambiguous duplicate gate command argument');
    seen.add(token);
    if (token === '--evidence-dir') {
      const folder = command.shift();
      if (folder === undefined || resolvePath(folder) !== joinPath(run, 'gate')) throw new Error('gate evidence destination does not match this run');
    } else if (token === '--findings-baseline') {
      const baseline = command.shift();
      if (baseline === undefined) throw new Error('gate findings baseline path missing');
      evidence.file(baseline);
    } else if (token !== board && token !== '--fresh') {
      throw new Error('unsupported gate mode; fresh target checks required');
    }
  }
  if (!seen.has(board) || !seen.has('--evidence-dir')) throw new Error('gate command does not name the exact board and evidence directory');
}

/** The gate hashed these two fields in file order, so the hash needs the exact parsed values. */
function provenanceDigest(gateResult: string): string {
  const provenance = (jsonLoad(gateResult) as Map<string, unknown>).get('provenance') as Map<string, unknown>;
  const fields = new Map([['inputs', provenance.get('inputs') ?? null], ['tools', provenance.get('tools') ?? null]]);
  return sha256Text(jsonCanonical(fields, { ascii: false, sort: false }));
}

/** Metrics must be ints: a float count is not what the gate writes. */
function metricsAreClean(gateResult: string): boolean {
  const metrics = (jsonLoad(gateResult) as Map<string, unknown>).get('metrics');
  if (!(metrics instanceof Map) || !metrics.size) return false;
  return [...metrics].every(([name, value]) => typeof value === 'bigint' && value >= 0n && (value === 0n || (name as string).endsWith('_warnings')));
}

function checkGateResult(raw: Dict, result: Dict, gateResult: string): void {
  const provenance = asDict(raw.provenance), metrics = asDict(raw.metrics), cache = asDict(raw.cache);
  if (cache.enabled || cache.hits || Object.values(asDict(raw.checks)).some(check => asDict(check).cached)) {
    throw new Error('fresh native target evidence required; cached checks cannot promote a block');
  }
  if (raw.exit !== 0 || raw.changedDuringRun !== false || result.input_sha256 !== provenance.input_sha256 || !sameValue(result.metrics, raw.metrics)
      || !metricsAreClean(gateResult) || REQUIRED_METRICS.some(name => !(name in metrics))
      || !truthy(provenance.tools) || Object.values(asDict(provenance.tools)).some(value => !value)) {
    throw new Error('target native/electrical result is incomplete or not at target');
  }
  if (provenanceDigest(gateResult) !== need(provenance, 'input_sha256')) throw new Error('target gate provenance fingerprint disagrees');
}

function checkGateEvents(eventPath: string, checks: Dict, metrics: Dict): void {
  const events = splitlines(textOf(eventPath)).map(line => JSON.parse(line) as Dict);
  const completed = events.filter(event => event.type === 'check.end');
  const wanted = Object.entries(checks).filter(([, value]) => enabled(value)).map(([name]) => name);
  const stages = new Set(completed.map(event => event.stage as string));
  const combined = Object.assign({}, ...completed.map(event => asDict(event.metrics))) as Dict;
  const last = events.at(-1);
  if (!sameSet(stages, new Set(wanted)) || completed.length !== wanted.length || completed.some(event => event.status !== 'passed')
      || !sameValue(combined, metrics) || !last || last.type !== 'gate.end' || last.exit !== 0) {
    throw new Error('target gate lacks complete successful configured check events');
  }
}

function checkGateInputs(provenance: Dict, root: string, externalRoots: Dict, evidence: Evidence): Set<string> {
  const recorded = new Set<string>();
  for (const entry of asList(provenance.inputs)) {
    const name = need<string>(entry, 'path');
    let base = resolvePath(root), relative = name;
    if (name.startsWith('external/')) {
      const [, key, ...rest] = name.split('/');
      if (!rest.length || !(key as string in externalRoots)) throw new Error(`external gate input root required: ${name}`);
      base = resolvePath(externalRoots[key as string] as string);
      relative = rest.join('/');
    }
    const path = resolvePath(joinPath(base, relative));
    if (!isRelativeTo(path, base)) throw new Error('gate provenance path escapes its root');
    recorded.add(path);
    if ((entry.sha256 ?? null) === null) evidence.absent(path);
    else if (sha256File(evidence.file(path)) !== entry.sha256) throw new Error(`stale gate input changed: ${name}`);
  }
  return recorded;
}

function verifyGate(runDirectory: string, binding: Dict, root: string, externalRoots: Dict, evidence: Evidence) {
  const run = resolvePath(runDirectory);
  const manifest = read(evidence.file(joinPath(run, 'run.json'))), result = read(evidence.file(joinPath(run, 'result.json')));
  if (result.status !== 'passed' || result.exit_code !== 0 || result.scope !== 'configured_board_gate' || asDict(result.cleanup).complete !== true) {
    throw new Error('target gate did not pass with confirmed cleanup');
  }
  const board = (manifest.board as string) ?? '';
  if (!board || board.includes('/') || board.includes('\\') || board === '.' || board === '..') throw new Error('invalid target gate board');
  const config = joinPath(root, 'hardware-design/boards', board, 'gate.json');
  const cfg = read(evidence.file(config));
  const project = need<string>(cfg, 'project');
  const target = resolvePath(withSuffix(joinPath(dirname(config), project), '.kicad_pcb'));
  const checks = asDict(cfg.checks);
  if (REQUIRED_CHECKS.some(name => !enabled(checks[name]))) throw new Error('target gate omits required native/electrical checks');
  if (target !== resolvePath(need<string>(binding, 'target')) || manifest.root !== resolvePath(root)) throw new Error('gate is for a different target board/repository');
  checkGateCommand(manifest, board, root, run, evidence);
  const gateResult = evidence.file(joinPath(run, 'gate/result.json'));
  const raw = read(gateResult);
  checkGateResult(raw, result, gateResult);
  checkGateEvents(evidence.file(joinPath(run, 'gate/events.jsonl')), need<Dict>(cfg, 'checks'), asDict(raw.metrics));
  const provenance = asDict(raw.provenance);
  const recorded = checkGateInputs(provenance, root, externalRoots, evidence);
  const mandatory = [resolvePath(config), ...PROJECT_FILES.map(extension => withSuffix(target, extension))];
  if (mandatory.some(path => !recorded.has(path))) throw new Error('gate provenance omits required exact target inputs');
  evidence.file(joinPath(run, 'gate/erc.json'));
  evidence.file(joinPath(run, 'gate/drc.json'));
  if (Object.values(nativeMetrics(joinPath(run, 'gate'))).some(Boolean)) throw new Error('target native artifacts are not at target');
  return { board, project, input_sha256: provenance.input_sha256 };
}

function checkBenchTest(test: Dict, row: Map<string, string | null> | undefined, instruments: Map<unknown, Dict>, evidence: Evidence, base: string): void {
  if (!test.requirement || !test.unit) throw new Error('bench tests require a named requirement and measurement unit');
  evidence.document(test.source, base);
  const low = test.min, high = test.max, measured = pyFloat(row?.get('value') ?? 'nan');
  if (!isNumber(low) || !isNumber(high) || ![low, high, measured].every(Number.isFinite) || low > high
      || !(low <= measured && measured <= high) || row?.get('unit') !== test.unit || !instruments.has(row?.get('instrument_id'))) {
    throw new Error(`bench measurement missing, unsupported or outside sourced limits: ${need<string>(test, 'id')}`);
  }
}

export function verifyBench(pathGiven: string, proof: Dict, bindingSha256: string, evidence: Evidence, base: string) {
  const plan = read(evidence.artifact(proof.bench_plan, base));
  const measured = read(evidence.file(pathGiven));
  if (plan.schema !== 'iot-lab.block-bench-plan.v1' || !plan.approved_by || !plan.approved_at || plan.binding_sha256 !== bindingSha256
      || measured.schema !== 'iot-lab.block-bench.v1' || measured.binding_sha256 !== bindingSha256
      || !['operator', 'measured_at', 'board_serial', 'instruments'].every(name => truthy(measured[name]))) {
    throw new Error('bench evidence requires approved exact-binding plan and attributable measured hardware');
  }
  if (timestamp(measured.measured_at) < timestamp(plan.approved_at)) throw new Error('bench plan approval must precede measurement');
  const listed = measured.instruments as Dict[];
  const instruments = new Map(listed.map(row => [need(row, 'id'), row]));
  if (instruments.size !== listed.length) throw new Error('bench instrument identities must be unique');
  const folder = dirname(pathGiven);
  for (const instrument of instruments.values()) evidence.document(instrument.calibration_evidence, folder);
  const rows = dictRows(readText(evidence.artifact(measured.raw_data, folder)));
  const tests = asList(plan.tests);
  if (!tests.length || new Set(tests.map(test => need(test, 'id'))).size !== tests.length) throw new Error('bench plan requires distinct sourced tests');
  if (rows.length !== tests.length || new Set(rows.map(row => row.get('test_id'))).size !== rows.length) {
    throw new Error('raw bench data must cover every approved test exactly once');
  }
  const values = new Map(rows.map(row => [row.get('test_id'), row]));
  for (const test of tests) checkBenchTest(test, values.get(test.id as string), instruments, evidence, base);
  return { board_serial: measured.board_serial, operator: measured.operator, measured_at: measured.measured_at, tests: tests.map(test => test.id) };
}

function checkReviews(row: BlockRow, binding: Dict, reviews: Dict, evidence: Evidence, base: string): void {
  const portReviews = asDict(reviews.operating_limits);
  const names = new Set(row.ports.map(port => need<string>(port, 'name')));
  if (!row.ports.length || !sameSet(new Set(Object.keys(portReviews)), names)) throw new Error('operating-limit review must cover every exact block port');
  const netMap = asDict(binding.net_map);
  for (const port of row.ports) {
    const review = portReviews[port.name as string];
    if (!port.limits || !port.net || !(port.net in netMap) || !asDict(review).target_conditions) {
      throw new Error('port needs native net mapping, limits and explicit target operating conditions');
    }
    requireReview(review, evidence, base);
  }
  const ruleReviews = asDict(reviews.layout_rules);
  const indexes = new Set(row.layout_rules.map((_, index) => String(index)));
  if (!row.layout_rules.length || !sameSet(new Set(Object.keys(ruleReviews)), indexes)) throw new Error('layout review must cover every source rule by zero-based index');
  for (const review of Object.values(ruleReviews)) requireReview(review, evidence, base);
  for (const context of ['stackup_and_rules', 'boundary_and_returns', 'ground_and_isolation']) requireReview(reviews[context], evidence, base);
  const unresolved = asDict(reviews.open_items);
  if (!sameSet(new Set(Object.keys(unresolved)), new Set(row.open_items))) throw new Error('all declared block open items require attributed resolution');
  for (const review of Object.values(unresolved)) requireReview(review, evidence, base);
}

function checkPart(ref: string, properties: ReadonlyMap<string, string>, part: Dict, evidence: Evidence, base: string): void {
  if ((part.mpn ?? null) !== (properties.get('MPN') ?? null) || (part.lcsc ?? null) !== (properties.get('LCSC') ?? null)) {
    throw new Error(`part evidence identity differs: ${ref}`);
  }
  const datasheet = evidence.artifact(part.datasheet, base);
  const source = read(evidence.file(`${datasheet}.source.json`));
  if (source.sha256 !== sha256File(datasheet) || !source.source_url || !source.fetched_at_utc) throw new Error(`manufacturer datasheet provenance missing or stale: ${ref}`);
  const availability = read(evidence.artifact(part.jlc_assembly, base));
  const record = asDict(availability.record ?? availability.purchase_record);
  const stock = record.stockCount ?? record.overseasStockCount;
  let host: string | null = null;
  try {
    host = new URL((availability.source_url as string) ?? '').hostname;
  } catch {
    host = null;
  }
  if (host !== 'jlcpcb.com' && host !== 'www.jlcpcb.com') throw new Error(`exact dated JLC assembly availability required: ${ref}`);
  if (!availability.fetched_at_utc || record.componentCode !== need(part, 'lcsc') || record.componentModelEn !== need(part, 'mpn')
      || !Number.isInteger(stock) || (stock as number) <= 0) {
    throw new Error(`exact dated JLC assembly availability required: ${ref}`);
  }
  requireReview(part.pinout_and_land_pattern, evidence, base);
}

function checkParts(row: BlockRow, id: string, binding: Dict, proof: Dict, evidence: Evidence, base: string): void {
  const parts = asDict(proof.parts);
  if (!sameSet(new Set(Object.keys(parts)), new Set(Object.keys(asDict(binding.refs))))) throw new Error('part evidence must cover every native bound source reference');
  for (const footprint of footprints(joinPath(row.source_directory, `${id}.kicad_pcb`))) {
    const ref = footprint.props.get('Reference') as string;
    if (!(ref in parts)) throw new Error(`'${ref}'`);
    checkPart(ref, footprint.props, parts[ref] as Dict, evidence, base);
  }
}

const here = dirname(fileURLToPath(import.meta.url));

function sealedInputs(evidence: Evidence): Map<string, string | null> {
  for (const name of IMPLEMENTATION) evidence.file(joinPath(here, name));
  for (const [path, digest] of evidence.files) {
    if (digest === null ? pathExists(path) : sha256File(path) !== digest) throw new Error(`evidence changed during qualification: ${path}`);
  }
  return evidence.files;
}

export function qualify(library: string, id: string, bindingFile: string, evidenceFile: string, root: string, bench?: string | null) {
  const evidence = new Evidence();
  const bindingPath = evidence.file(bindingFile);
  const binding = read(bindingPath);
  verifyBinding(binding as never);
  const row = reuse(library, id, need<string>(binding, 'source_sha256'));
  if (binding.block_id !== id || binding.source_directory !== row.source_directory) throw new Error('binding refers to a different block');
  if (row.missing_files.length || row.facts_errors.length) throw new Error('complete block files and valid facts required');
  const proofPath = evidence.file(evidenceFile);
  const proof = read(proofPath), base = dirname(proofPath);
  const bindingHash = fingerprint(jsonLoad(bindingPath));
  if (proof.schema !== 'iot-lab.block-evidence.v1' || proof.binding_sha256 !== bindingHash) throw new Error('evidence must name the exact native binding fingerprint');
  if (truthy(proof.unsupported)) throw new Error('unsupported applicability requirements remain unresolved');
  verifyNative(joinPath(base, need<string>(proof, 'source_native')), row, evidence);
  const gate = verifyGate(joinPath(base, need<string>(proof, 'target_run')), binding, root, asDict(proof.external_roots), evidence);
  checkReviews(row, binding, asDict(proof.reviews), evidence, base);
  checkParts(row, id, binding, proof, evidence, base);
  const receipt: Dict = {
    schema: SCHEMA, created_at: utcNow(), level: 1, qualification: 'gate_verified', block_id: id, binding, gate,
    operating_limits: row.ports, layout_rules: row.layout_rules,
    stock_note: 'dated catalog evidence; not reserved; recheck at review/layout/order gates',
    scope: 'exact block revision and native target instance; copper reuse not approved',
  };
  if (bench !== null && bench !== undefined) {
    receipt.bench = verifyBench(resolvePath(bench), proof, bindingHash, evidence, base);
    Object.assign(receipt, { level: 2, qualification: 'bench_validated' });
  }
  verifyBinding(binding as never);
  receipt.evidence_inputs = sealedInputs(evidence);
  receipt.receipt_sha256 = fingerprint(receipt);
  return receipt;
}

/** The hash covers the file as written, so it runs over the exact parsed values. */
function storedDigestMatches(path: string): boolean {
  const stored = new Map(jsonLoad(path) as Map<string, unknown>);
  const digest = stored.get('receipt_sha256') ?? null;
  stored.delete('receipt_sha256');
  return fingerprint(stored) === digest;
}

export function status(path: string): Dict {
  const receipt = read(path);
  try {
    if (receipt.schema !== SCHEMA || !storedDigestMatches(path)) throw new Error('unsupported or modified qualification receipt');
    const levels = [[1, 'gate_verified'], [2, 'bench_validated']];
    if (!levels.some(([level, name]) => receipt.level === level && receipt.qualification === name)) throw new Error('unsupported qualification level');
    verifyBinding(need(receipt, 'binding'));
    for (const [name, expected] of Object.entries(need<Dict>(receipt, 'evidence_inputs'))) {
      if (expected === null ? pathExists(name) : sha256File(name) !== expected) throw new Error(`qualification evidence changed: ${name}`);
    }
    return {
      status: 'current', level: receipt.level, qualification: receipt.qualification, block_id: need(receipt, 'block_id'),
      scope: need(receipt, 'scope'), receipt_sha256: receipt.receipt_sha256,
    };
  } catch (error) {
    return { status: 'stale', level: 0, qualification: 'draft', recorded_level: receipt.level ?? null, cause: errorText(error) };
  }
}

/** reuse() with a receipt: the row gains the verified level only for the exact recorded target instance. */
export function reuseQualified(library: string, id: string, expectedSha256: string | null | undefined, receipt: string): BlockRow {
  const row = reuse(library, id, expectedSha256);
  const checked = status(receipt);
  const original = read(receipt);
  const binding = asDict(original.binding);
  if (checked.status !== 'current' || binding.block_id !== id || binding.source_sha256 !== row.source_sha256 || binding.source_directory !== row.source_directory) {
    throw new Error('stale or different block qualification receipt');
  }
  return Object.assign(row, {
    qualification: checked.qualification, verified_level: checked.level, qualification_receipt: resolvePath(receipt),
    qualification_target: { board: need(binding, 'target'), instance_path: need(binding, 'instance_path') },
    qualification_scope: need(original, 'scope'),
  });
}
