// Recorded gate fixtures exercise proof contracts; they are not PCB qualification evidence.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, test } from 'node:test';
import { bindInstance } from './block-bindings.ts';
import { Evidence, inventory, native, nativeMetrics, qualify, reuseQualified, status, verifyBench, type NativeTools } from './block-qualification.ts';
import { readBlock, reuse } from './block-reuse.ts';
import { fingerprint } from './fingerprint.ts';
import { sha256File } from './json-file.ts';
import { jsonDumps } from './py-compat.mjs';

type Row = Record<string, any>;
const fp = (ref: string, uid: string, net: string, xy: string) => `(footprint "Lib:Exact" (layer "F.Cu") (at ${xy} 0)
  (path "${uid}") (property "Reference" "${ref}") (property "Value" "1k")
  (property "MPN" "ABC") (property "LCSC" "C123")
  (attr smd) (pad "1" smd rect (at 0 0 0) (size 1 2)
    (layers "F.Cu" "F.Paste" "F.Mask") (net "${net}") (uuid "${ref}-pad")))`;
const write = (path: string, value: unknown) => writeFileSync(path, jsonDumps(value, 2));
const read = (path: string): Row => JSON.parse(readFileSync(path, 'utf8'));
const artifact = (path: string, extra: Row = {}) => ({ path, sha256: sha256File(path), ...extra });
const ERC = ['sch', 'erc', '--format', 'json', '--severity-all', '--units', 'mm'];
const DRC = ['pcb', 'drc', '--schematic-parity', '--refill-zones', '--format', 'json', '--severity-all', '--units', 'mm'];

let root: string, library: string, block: string, source: string, target: string, config: Row, configFile: string;
let binding: Row, bindingFile: string, binary: string, nativeDir: string, run: string, reviewFile: string, proof: Row, proofFile: string;

function nativeFixture(output: string): void {
  const checks: Row = {};
  for (const name of ['erc', 'drc']) {
    write(join(output, `${name}.json`), name === 'erc' ? { sheets: [{ violations: [] }] } : { violations: [], schematic_parity: [], unconnected_items: [] });
    writeFileSync(join(output, `${name}.log`), 'fixture invocation completed\n');
    const command = [binary, ...(name === 'erc' ? ERC : DRC), '-o', join(output, `${name}.json`), name === 'erc' ? source.replace(/pcb$/, 'sch') : source];
    checks[name] = {
      command, exit_code: 0, cleanup: { complete: true },
      report_sha256: sha256File(join(output, `${name}.json`)), log_sha256: sha256File(join(output, `${name}.log`)),
    };
  }
  write(join(output, 'result.json'), {
    schema: 'iot-lab.block-native.v1', block_id: 'MODULE', status: 'passed', source_directory: block,
    source_sha256: readBlock(block).source_sha256, executable: binary, executable_sha256: sha256File(binary), tool_version: '10.0.6',
    started_at: '2026-10-15T12:00:00Z', finished_at: '2026-10-15T12:01:00Z', checks, metrics: nativeMetrics(output),
  });
}

const provenanceHash = (provenance: Row) => createHash('sha256')
  .update(JSON.stringify({ inputs: provenance.inputs, tools: provenance.tools })).digest('hex');

function gateFixture(): void {
  const gate = join(run, 'gate');
  mkdirSync(gate, { recursive: true });
  const files = [configFile, ...['.kicad_pcb', '.kicad_sch', '.kicad_pro', '.kicad_dru'].map(extension => target.replace(/\.kicad_pcb$/, extension))];
  const provenance: Row = {
    inputs: files.map(path => ({ path: path.slice(root.length + 1), sha256: sha256File(path) })),
    tools: { kicad: '10.0.6', node: 'fixture' },
  };
  provenance.input_sha256 = provenanceHash(provenance);
  const stages: Row = {
    erc: { erc_errors: 0, erc_warnings: 0 }, drc: { drc_errors: 0, drc_parity: 0, drc_unconnected: 0, drc_warnings: 0 },
    paths: { paths_low: 0 }, viapads: { viapads: 0 }, kicad_happy: { kicad_happy_findings: 0 }, port_labels: { port_label_failures: 0 },
  };
  const metrics = Object.assign({}, ...Object.values(stages));
  write(join(run, 'run.json'), { board: 'X', root, command: ['node', join(root, 'tools/gate.mjs'), 'X', '--evidence-dir', gate] });
  write(join(run, 'result.json'), { status: 'passed', exit_code: 0, scope: 'configured_board_gate', cleanup: { complete: true }, input_sha256: provenance.input_sha256, metrics });
  write(join(gate, 'result.json'), { exit: 0, changedDuringRun: false, metrics, provenance });
  write(join(gate, 'erc.json'), { sheets: [{ violations: [] }] });
  write(join(gate, 'drc.json'), { violations: [], schematic_parity: [], unconnected_items: [] });
  const lines = Object.entries(stages).map(([stage, values]) => JSON.stringify({ type: 'check.end', stage, status: 'passed', metrics: values }));
  writeFileSync(join(gate, 'events.jsonl'), `${[...lines, JSON.stringify({ type: 'gate.end', exit: 0 })].join('\n')}\n`);
}

beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'block-proof-')));
  library = join(root, 'blocks');
  block = join(library, 'MODULE.kicad_block');
  mkdirSync(block, { recursive: true });
  source = join(block, 'MODULE.kicad_pcb');
  writeFileSync(source, `(kicad_pcb ${fp('U1', '/one', 'VIN', '2 3')})`);
  write(join(block, 'facts.json'), {
    level: 0, ports: [{ name: 'VIN', net: 'VIN', limits: '2.5..5.5 V; datasheet p.1' }],
    layout_rules: [{ rule: 'Input bypass on same layer beside VIN', source: 'datasheet p.2' }],
  });
  const board = join(root, 'hardware-design/boards/X');
  target = join(board, 'cad/X.kicad_pcb');
  mkdirSync(join(board, 'cad'), { recursive: true });
  writeFileSync(target, `(kicad_pcb ${fp('U8', '/instance/one', '+3V3', '12 13')})`);
  for (const pcb of [source, target]) {
    for (const extension of ['.kicad_sch', '.kicad_pro', '.kicad_dru']) {
      writeFileSync(pcb.replace(/\.kicad_pcb$/, extension), extension === '.kicad_sch' ? '(kicad_sch)' : '{}');
    }
  }
  config = { project: 'cad/X', checks: { erc: true, drc: true, paths: 'current-paths.json', viapads: {}, kicad_happy: {}, port_labels: true } };
  configFile = join(board, 'gate.json');
  write(configFile, config);
  binding = JSON.parse(jsonDumps(bindInstance(block, target, '/instance')));
  bindingFile = join(root, 'binding.json');
  write(bindingFile, binding);
  binary = join(root, 'fake-kicad');
  writeFileSync(binary, `#!/bin/sh
[ "$1" = --version ] && { echo 10.0.6; exit 0; }
while [ $# -gt 0 ]; do [ "$1" = -o ] && out=$2; shift; done
case "$out" in
  *erc.json) echo '{"sheets":[{"violations":[]}]}' > "$out" ;;
  *) echo '{"violations":[],"schematic_parity":[],"unconnected_items":[]}' > "$out" ;;
esac
`);
  chmodSync(binary, 0o755);
  nativeDir = join(root, 'source-native');
  mkdirSync(nativeDir);
  nativeFixture(nativeDir);
  run = join(root, 'target-run');
  gateFixture();
  reviewFile = join(root, 'review.md');
  writeFileSync(reviewFile, 'Fixture attributed engineering review: VIN 3.3 V; bypass and returns inspected.\n');
  const datasheet = join(root, 'manufacturer.pdf');
  writeFileSync(datasheet, '%PDF-fixture original manufacturer evidence');
  write(`${datasheet}.source.json`, { sha256: sha256File(datasheet), source_url: 'https://manufacturer.example/datasheet.pdf', fetched_at_utc: '2026-10-15T12:00:00Z' });
  const stock = join(root, 'jlc.json');
  write(stock, { source_url: 'https://jlcpcb.com/api/catalog', fetched_at_utc: '2026-10-15T12:00:00Z', record: { componentCode: 'C123', componentModelEn: 'ABC', stockCount: 12 } });
  const review = { verdict: 'pass', reviewer: 'Fixture engineer', reviewed_at: '2026-10-15T12:00:00Z', evidence: artifact(reviewFile, { locator: 'VIN review' }) };
  proof = {
    schema: 'iot-lab.block-evidence.v1', binding_sha256: fingerprint(binding), source_native: join(nativeDir, 'result.json'), target_run: run,
    reviews: {
      operating_limits: { VIN: { ...review, target_conditions: '3.3 V, ambient 25 C' } }, layout_rules: { 0: review },
      stackup_and_rules: review, boundary_and_returns: review, ground_and_isolation: review,
    },
    parts: { U1: { mpn: 'ABC', lcsc: 'C123', datasheet: artifact(datasheet), jlc_assembly: artifact(stock), pinout_and_land_pattern: review } },
  };
  proofFile = join(root, 'evidence.json');
  write(proofFile, proof);
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

const prove = (bench?: string) => qualify(library, 'MODULE', bindingFile, proofFile, root, bench);
const saved = (receipt = prove()) => {
  const path = join(root, 'receipt.json');
  write(path, receipt);
  return path;
};

test('a complete proof derives the gate level without changing facts', () => {
  const receipt = prove();
  assert.deepEqual([receipt.level, receipt.qualification], [1, 'gate_verified']);
  assert.equal(read(join(block, 'facts.json')).level, 0);
  assert.equal(status(saved(receipt)).status, 'current');
});

test('a source change invalidates the receipt and the binding', () => {
  const path = saved();
  writeFileSync(join(block, 'MODULE.kicad_dru'), 'changed rule');
  assert.equal(status(path).qualification, 'draft');
  assert.throws(prove, /stale/);
});

test('a modified receipt is refused by its digest', () => {
  const path = saved();
  write(path, { ...read(path), scope: 'edited' });
  assert.match(status(path).cause as string, /modified qualification receipt/);
});

test('retrieval uses a receipt only for the exact recorded target', () => {
  const path = saved();
  assert.equal(reuse(library, 'MODULE').qualification, 'unverified_for_target');
  const row = reuseQualified(library, 'MODULE', null, path);
  assert.equal(row.qualification, 'gate_verified');
  assert.equal((row.qualification_target as Row).instance_path, '/instance');
  writeFileSync(reviewFile, 'changed review');
  assert.throws(() => reuseQualified(library, 'MODULE', null, path), /stale/);
});

test('a changed review or native artifact invalidates the receipt', () => {
  const path = saved();
  writeFileSync(reviewFile, 'changed target conditions');
  assert.equal(status(path).level, 0);
  writeFileSync(join(nativeDir, 'drc.json'), '{}');
  assert.throws(prove, /artifact changed/);
});

test('missing operating conditions or unsupported requirements cannot promote', () => {
  const changes: [(given: Row) => void, RegExp][] = [
    [given => { delete given.reviews.operating_limits.VIN.target_conditions; }, /operating conditions/],
    [given => { delete given.reviews.operating_limits; }, /every exact block port/],
    [given => { given.unsupported = ['unverified isolation']; }, /unsupported/],
  ];
  for (const [change, reason] of changes) {
    const given = JSON.parse(JSON.stringify(proof));
    change(given);
    write(proofFile, given);
    assert.throws(prove, reason);
  }
});

test('native MPN, pad and instance changes are refused', () => {
  const original = readFileSync(target, 'utf8');
  for (const [from, to] of [['"ABC"', '"OTHER"'], ['(size 1 2)', '(size 1 1)'], ['/instance/one', '/other/one']]) {
    writeFileSync(target, original.replaceAll(from as string, to as string));
    assert.throws(prove);
  }
});

test('missing source native or an incomplete target gate cannot promote', () => {
  unlinkSync(join(nativeDir, 'erc.log'));
  assert.throws(prove, /No such file|ENOENT/);
  writeFileSync(join(nativeDir, 'erc.log'), 'fixture invocation completed\n');
  const events = join(run, 'gate/events.jsonl');
  writeFileSync(events, `${readFileSync(events, 'utf8').split('\n').filter(line => line && !line.includes('paths')).join('\n')}\n`);
  assert.throws(prove, /complete successful configured check/);
});

test('the gate accepts --fresh in any order and refuses incremental modes and cache', () => {
  const path = join(run, 'run.json');
  const manifest = read(path);
  manifest.command = ['node', join(root, 'tools/gate.mjs'), '--fresh', '--evidence-dir', join(run, 'gate'), 'X'];
  write(path, manifest);
  assert.equal(prove().level, 1);
  for (const flag of ['--changed', '--ratchet', '--write', '--config']) {
    write(path, { ...manifest, command: [...manifest.command, flag] });
    assert.throws(prove, /unsupported gate mode/);
  }
  write(path, manifest);
  const rawPath = join(run, 'gate/result.json');
  write(rawPath, { ...read(rawPath), cache: { enabled: true, hits: 1 } });
  assert.throws(prove, /cached checks cannot promote/);
});

test('a previously absent gate dependency appearing invalidates the receipt', () => {
  const path = join(run, 'gate/result.json');
  const raw = read(path);
  raw.provenance.inputs.push({ path: 'previously-missing.json', sha256: null });
  raw.provenance.input_sha256 = provenanceHash(raw.provenance);
  write(path, raw);
  const resultPath = join(run, 'result.json');
  write(resultPath, { ...read(resultPath), input_sha256: raw.provenance.input_sha256 });
  const receipt = saved();
  writeFileSync(join(root, 'previously-missing.json'), 'new dependency');
  assert.equal(status(receipt).qualification, 'draft');
});

test('an input recorded as absent that then appears is a change, not a new input', () => {
  const evidence = new Evidence();
  const path = join(root, 'late.json');
  evidence.absent(path);
  writeFileSync(path, '{}');
  assert.throws(() => evidence.file(path), /evidence changed/);
  assert.throws(() => evidence.absent(path), /previously absent/);
});

test('a different target or a disabled electrical gate cannot promote', () => {
  const path = join(run, 'run.json');
  const manifest = read(path);
  write(path, { ...manifest, board: 'OTHER' });
  assert.throws(prove, /No such file|ENOENT/);
  write(path, manifest);
  config.checks.paths = false;
  write(configFile, config);
  assert.throws(prove, /omits required/);
});

test('inventory requires symbol identity and reports a flat board', () => {
  const row = inventory(root, library, 'X');
  assert.equal(row.instances[0]?.block_id, 'MODULE');
  assert.equal(row.instances[0]?.status, 'bound_draft');
  const text = readFileSync(target, 'utf8');
  writeFileSync(target, text.replace('/instance/one', '/different/new'));
  assert.equal(inventory(root, library, 'X').authoritative_instances, 0);
  writeFileSync(target, text.replace('/instance/one', '/flat'));
  assert.match(inventory(root, library, 'X').cause, /paths are flat/);
});

const tools = (): NativeTools => ({
  binary, remaining: () => 10,
  version: path => spawnSync(path, ['--version'], { encoding: 'utf8' }).stdout,
  runOwned: async (command, { cwd, log }) => {
    const run = spawnSync(command[0] as string, command.slice(1), { cwd, encoding: 'utf8' });
    writeFileSync(log, run.stdout + run.stderr);
    return { returncode: run.status, cleanup: { complete: true }, settled: true };
  },
});

test('the source native runner records its invocations, which then verify', async () => {
  const output = join(root, 'executed-native');
  const report = await native(block, output, tools());
  assert.equal(report.status, 'passed', String(report.cause));
  assert.equal((report.checks as Row).drc.cleanup.complete, true);
  write(proofFile, { ...proof, source_native: join(output, 'result.json') });
  assert.equal(prove().level, 1);
});

test('the source native runner refuses in-source or existing evidence', async () => {
  await assert.rejects(native(block, join(block, 'results'), tools()), /outside/);
  await assert.rejects(native(block, nativeDir, tools()), /EEXIST|File exists/);
});

test('a missing KiCad CLI stops before any evidence folder exists', async () => {
  await assert.rejects(native(block, join(root, 'none'), { ...tools(), binary: null }), /KiCad CLI unavailable/);
});

function benchFixture(value = '3.3'): string {
  const plan = join(root, 'bench-plan.json');
  const review = artifact(reviewFile, { locator: 'VIN acceptance criterion' });
  write(plan, {
    schema: 'iot-lab.block-bench-plan.v1', binding_sha256: fingerprint(binding), approved_by: 'Fixture engineer', approved_at: '2026-10-15T12:00:00Z',
    tests: [{ id: 'vin', requirement: 'VIN operating voltage', unit: 'V', min: 2.5, max: 5.5, source: review }],
  });
  proof.bench_plan = artifact(plan);
  write(proofFile, proof);
  const raw = join(root, 'raw.csv');
  writeFileSync(raw, `test_id,value,unit,instrument_id\r\nvin,${value},V,meter-1\r\n`);
  const measured = join(root, 'measured.json');
  write(measured, {
    schema: 'iot-lab.block-bench.v1', binding_sha256: fingerprint(binding), operator: 'Fixture operator', measured_at: '2026-10-15T12:00:00Z',
    board_serial: 'FIXTURE-ONLY', instruments: [{ id: 'meter-1', calibration_evidence: review }], raw_data: artifact(raw),
  });
  return measured;
}

test('the bench level needs attributed raw measurements against a sourced plan', () => {
  const measured = benchFixture();
  const receipt = prove(measured);
  assert.deepEqual([receipt.level, receipt.qualification], [2, 'bench_validated']);
  assert.equal((receipt.bench as Row).board_serial, 'FIXTURE-ONLY');
  benchFixture('9');
  assert.throws(() => prove(measured), /outside sourced limits/);
});

test('unattributed or missing bench evidence does not promote', () => {
  const measured = benchFixture();
  const report = read(measured);
  delete report.operator;
  write(measured, report);
  assert.throws(() => prove(measured), /attributable measured/);
  unlinkSync(join(root, 'raw.csv'));
  assert.throws(() => prove(measured));
});

test('verifyBench is usable alone by the design contract', () => {
  const measured = benchFixture();
  const result = verifyBench(measured, proof, fingerprint(binding), new Evidence(), root);
  assert.deepEqual(result.tests, ['vin']);
});
