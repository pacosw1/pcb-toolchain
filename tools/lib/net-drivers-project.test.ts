// The real driver-edges.json, its datasheets and the vendor IBIS files. Runs where the tools sit in a project: the table
// checks evidence next to tools/. Listed in .cip/project-only-tests.txt.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test, type TestContext } from 'node:test';
import { fileURLToPath } from 'node:url';
import { loadTable, TableError, TABLE_FILE, timingEvidence } from './driver-table.ts';
import { load, viEdges } from './ibis.ts';
import { ibisEdges, ibisModel, netEdge, pinEdge } from './net-drivers.ts';
import type { Netlist } from './netlist.ts';
import { fileRoot } from './project-root.mjs';
import { jsonDumps, jsonLoad } from './py-compat.mjs';
import { deepCopy, type Dict } from './py-dict.ts';

const CLI = fileURLToPath(new URL('../ibis_ramp.ts', import.meta.url));
const VENDOR = join(fileRoot, 'hardware-design/registry/ibis/SN74LVC1G08/lvc1g08.ibs');
const table = loadTable();
const classes = (jsonLoad(join(fileRoot, 'tools/edge-rates.json')) as Dict).get('classes') as Dict;
const netlist = (mpn: string, pin: string): Netlist => ({ comps: new Map([['U1', mpn]]), nets: new Map([['/SIG', [['U1', '1', pin]]]]) });
const run = (...args: string[]) => spawnSync(process.execPath, ['--experimental-strip-types', '--no-warnings', CLI, ...args], { encoding: 'utf8', timeout: 20000 });
const evidenceOf = (edge: any) => edge.timing_evidence.contributors[0].evidence;

test('the CLI screens an actual vendor model and reports its errors', () => {
  const ok = run(VENDOR, 'LVC1G08_OUT_33');
  assert.equal(ok.status, 0, ok.stderr);
  const result = JSON.parse(ok.stdout);
  assert.equal(result.source_sha256, createHash('sha256').update(readFileSync(VENDOR)).digest('hex'));
  assert.ok(result.edge_screen.tr_ns > 0);
  assert.equal(result.qualified_fastest_bound, false);
  for (const [args, code] of [[[VENDOR, 'NOT_A_MODEL'], 1], [[], 2]] as const) {
    const failed = run(...args);
    assert.equal(failed.status, code);
    assert.ok(failed.stderr);
    assert.equal(failed.stdout, '');
  }
});

test('nine original files and 92 models parse, and each output screens', () => {
  let files = 0;
  let models = 0;
  for (const part of table.values()) {
    const ibis = part.get('ibis') as Dict | undefined;
    if (!ibis) continue;
    const data = load(join(fileRoot, ibis.get('file') as string), ibis.get('sha256') as string);
    files += 1;
    models += data.models.size;
    assert.ok(data.pins.has(ibis.get('component') as string));
    for (const rule of part.get('pins') as Dict[]) {
      if (!rule.get('ibis_model') || rule.get('role') === 'input') continue;
      for (const [volts, suffix] of ibis.get('variants') as Dict) {
        const name = `${String(rule.get('ibis_model'))}${String(suffix)}`;
        const edges = ibisEdges(part, name);
        assert.ok(edges.tr_ns > 0 && edges.tf_ns > 0);
        const vi = viEdges(ibisModel(part, name), 1e-12, { swing_v: Number(volts), open_drain: rule.get('role') === 'open_drain' });
        assert.ok(vi.tf_ns > 0);
        assert.equal(vi.qualified_fastest_bound, false);
      }
    }
  }
  assert.equal(files, 9);
  assert.equal(models, 92);
});

test('the table has no default, and real unknowns stay unknown', () => {
  assert.ok(table.has('LTV-217'));
  assert.ok(!table.has('default'));
  assert.equal(pinEdge('SP3485EN-L/TR', 'RO', table).role, 'bound');
  assert.equal(pinEdge('TPS2116DRLR', 'ST', table).role, 'unknown');
});

test('a screening value never certifies the fastest edge', () => {
  const part = netEdge('/SIG', netlist('STM32H743VIT6', 'PE10'), table) as any;
  assert.equal(part.timing_evidence.qualified_fastest_bound, false);
  const rs485 = netEdge('/SIG', netlist('THVD1410DR', 'A'), table, { classes, interface: 'rs485' }) as any;
  assert.equal(rs485.edge_ns, 460);
  assert.equal(rs485.timing_evidence.qualified_fastest_bound, false);
  const line = netEdge('/SIG', netlist('UNKNOWN', 'OUT'), table, { classes, interface: '100base_tx' }) as any;
  assert.equal(line.edge_ns, 3);
  assert.equal(line.timing_evidence.qualified_fastest_bound, false);
  assert.ok('unknown' in netEdge('/SIG', netlist('SP3485EN-L/TR', 'A'), table, { classes, interface: 'rs485' }));
});

test('the LAN8742A minimum keeps its load scope and proves no chip-pad bound', () => {
  const edge = netEdge('/SIG', netlist('LAN8742A-CZ-TR', 'TXP'), table) as any;
  assert.equal(edge.edge_ns, 3);
  const evidence = evidenceOf(edge);
  assert.equal(evidence.stat, 'min');
  assert.match(evidence.load, /Note 1/);
  assert.equal(evidence.source_MIN_verified, true);
  assert.equal(evidence.applicable_driver_bound, false);
  assert.equal(evidence.measurement_boundary, 'line side of transformer');
  assert.match(evidence.source_conditions, /100 ohm/);
});

test('a changed label, MPN, pin or value breaks the reviewed record', () => {
  const change: Record<string, (part: Dict, rule: Dict) => void> = {
    stat: (_, rule) => rule.set('stat', 'typ'), mpn: part => part.set('mpn', ['DIFFERENT*']),
    pin: (_, rule) => rule.set('match', 'OUT'), value: (_, rule) => rule.set('tr_ns', 4n),
  };
  for (const mutate of Object.values(change)) {
    const part = deepCopy(table.get('LAN8742A') as Dict);
    const rule = (part.get('pins') as Dict[])[0] as Dict;
    mutate(part, rule);
    const quality = timingEvidence(rule, 'LAN8742A', part.get('mpn'));
    assert.equal(quality.source_MIN_verified, false);
    assert.equal(quality.qualified_fastest_bound, false);
  }
});

test('a typ-to-min edit and a dropped primary source are caught at load', (t: TestContext) => {
  const folder = mkdtempSync(join(tmpdir(), 'driver-table-'));
  t.after(() => rmSync(folder, { recursive: true, force: true }));
  const path = join(folder, 'table.json');
  // Through jsonLoad and jsonDumps: JSON.parse would turn 3.0 into 3, and the record would stop being the reviewed one.
  const raw = jsonLoad(TABLE_FILE) as Dict;
  ((((raw.get('parts') as Dict).get('74HC08') as Dict).get('pins') as Dict[])[0] as Dict).set('stat', 'min');
  writeFileSync(path, jsonDumps(raw));
  const edge = netEdge('/SIG', netlist('74HC08D', '1Y'), loadTable(path)) as any;
  assert.equal(edge.timing_evidence.qualified_fastest_bound, false);
  assert.equal(evidenceOf(edge).source_MIN_verified, false);
  const clean = jsonLoad(TABLE_FILE) as Dict;
  clean.set('evidence_files', (clean.get('evidence_files') as Dict[]).filter(row => !String(row.get('path')).includes('LAN8742A')));
  writeFileSync(path, jsonDumps(clean));
  assert.throws(() => loadTable(path), TableError);
});
