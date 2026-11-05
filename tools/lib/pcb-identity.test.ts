// What a candidate may and may not change, and the snapshot it works on.
import assert from 'node:assert/strict';
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { declaredPours, pcbIdentity, type PourSet } from './pcb-identity.ts';
import { ProducerEvents } from './pcb-operation-log.ts';
import { snapshot } from './pcb-sources.ts';

const BOARD = `(kicad_pcb (version 20260101) (generator pcbnew)
 (net 1 "SIG") (gr_rect (start 0 0) (end 30 30) (layer "Edge.Cuts"))
 (footprint "Fixture:Pad" (layer "F.Cu") (at 10 10)
  (property "Reference" "J1" (at 0 0) (layer "F.SilkS"))
  (property "Value" "Pad" (at 0 2) (layer "F.Fab"))
  (property "MPN" "EXACT")
  (pad "1" smd rect (at 0 0) (size 1 1) (layers "F.Cu") (net 1 "SIG"))))`;
const opened = BOARD.slice(0, -1);

function scratch(t: { after(fn: () => void): void }) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'pcb-identity-')));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  let count = 0;
  const identity = (text: string, pours?: PourSet) => {
    const path = join(root, `board-${count++}.kicad_pcb`);
    writeFileSync(path, text);
    return JSON.stringify(pcbIdentity(path, pours));
  };
  return { root, identity };
}

test('identity allows pose and copper but preserves part, pad net and outline', t => {
  const { identity } = scratch(t), source = identity(BOARD);
  assert.equal(identity(BOARD.replace('(at 10 10)', '(at 11 10)')), source);
  assert.equal(identity(opened + '(segment (start 1 1) (end 2 2) (width 0.2) (layer "F.Cu") (net 1)))'), source);
  for (const [from, to] of [['"EXACT"', '"WRONG"'], ['(net 1 "SIG"))))', '(net 2 "GND"))))'], ['(end 30 30)', '(end 29 30)']]) {
    assert.notEqual(identity(BOARD.replace(from!, to!)), source, from);
  }
});

test('a locked footprint keeps its pose', t => {
  const { identity } = scratch(t), locked = BOARD.replace('(layer "F.Cu") (at 10 10)', '(layer "F.Cu") (locked yes) (at 10 10)');
  assert.notEqual(identity(locked.replace('(at 10 10)', '(at 11 10)')), identity(locked));
});

test('only the order of whole keepout areas is immaterial', t => {
  const { identity } = scratch(t);
  const area = (name: string, x: number) => `(zone (uuid same) (name "${name}") (keepout (tracks not_allowed)) (polygon (pts (xy ${x} 1) (xy 2 2) (xy 3 1))))`;
  const a = area('H3', 1), b = area('H5', 4), source = identity(`${opened}${a}${b})`);
  assert.equal(identity(`${opened}${b}${a})`), source);
  for (const mutation of [a + a, a + b.replace('(xy 4 1)', '(xy 5 1)'), a, a + b.replace('not_allowed', 'allowed'), a + b.replace('(uuid same)', '(uuid changed)')])
    assert.notEqual(identity(`${opened}${mutation})`), source, mutation);
  assert.notEqual(identity(`${opened}${a}${b.replace('(xy 4 1) (xy 2 2)', '(xy 2 2) (xy 4 1)')})`), source);
  const ca = a.replace('(keepout (tracks not_allowed))', '(priority 1)'), cb = b.replace('(keepout (tracks not_allowed))', '(priority 1)');
  assert.notEqual(identity(`${opened}${cb}${ca})`), identity(`${opened}${ca}${cb})`));
});

test('declared route.json pours are exempt and other zones stay protected', t => {
  const { identity } = scratch(t);
  const pour = (name: string, net = '"/A"', layer = '"F.Cu"', x = 1) => `(zone (net ${net}) (layer ${layer}) (uuid u${name}) (name "${name}") (polygon (pts (xy ${x} 1) (xy 2 2) (xy 3 1))))`;
  const manifest = { operation: 'route', router: 'route-json', spec: { schema: 'iot-lab.route.v1', pours: [{ name: 'P', net: '/A', layer: 'F.Cu' }] } };
  const pours = declaredPours(manifest), source = identity(`${opened}${pour('P')})`, pours);
  for (const candidate of [BOARD, `${opened}${pour('P', undefined, undefined, 5)})`]) assert.equal(identity(candidate, pours), source);
  for (const undeclared of [pour('Q'), pour('P', '"/B"'), pour('P', undefined, '"B.Cu"')]) assert.notEqual(identity(`${opened}${pour('P')}${undeclared})`, pours), source);
  assert.notEqual(identity(BOARD), identity(`${opened}${pour('P')})`));
  for (const router of ['iotroute', 'explicit']) assert.equal(declaredPours({ ...manifest, router }).size, 0);
  assert.equal(declaredPours({ ...manifest, operation: 'edit' }).size, 0);
});

test('a snapshot leaves out unrelated history and never shares CAD with the checkout', t => {
  const { root } = scratch(t);
  const put = (name: string, text: string) => { mkdirSync(dirname(join(root, name)), { recursive: true }); writeFileSync(join(root, name), text); };
  put('hardware-design/boards/X/gate.json', '{"project":"cad/X"}');
  put('hardware-design/boards/X/cad/X.kicad_pcb', BOARD);
  put('hardware-design/boards/Y/reports/old.kicad_pcb', 'old run');
  put('hardware-design/registry/evidence/old.html', 'old stock page');
  put('tools/pcb_snapshot_inputs.mjs', 'console.log("[]");');
  const clone = join(root, '.gate/snapshot');
  mkdirSync(dirname(clone));
  const state = snapshot(root, clone, 'X');
  assert.equal(state.files['hardware-design/registry/evidence/old.html'], undefined);
  assert.equal(state.files['hardware-design/boards/Y/reports/old.kicad_pcb'], undefined);
  writeFileSync(join(clone, 'hardware-design/boards/X/cad/X.kicad_pcb'), 'changed copy');
  assert.equal(readFileSync(join(root, 'hardware-design/boards/X/cad/X.kicad_pcb'), 'utf8'), BOARD);
  assert.throws(() => snapshot(root, clone, 'X'), /workspace must be new/);
});

test('a partial event write is not consumed and a moved release folder is not replayed', t => {
  const { root } = scratch(t), events = new ProducerEvents(root);
  mkdirSync(join(root, 'operation'));
  mkdirSync(join(root, 'release-work/gate'), { recursive: true });
  const line = (type: string, time = '2026-11-04T00:00:00.000Z') => `${JSON.stringify({ schema_version: 1, time, type })}\n`;
  appendFileSync(join(root, 'operation/events.jsonl'), line('tool.start') + line('tool.output').slice(0, 20));
  assert.deepEqual(events.read().map(row => row.type), ['tool.start']);
  assert.deepEqual(events.read(), []);
  appendFileSync(join(root, 'operation/events.jsonl'), line('tool.output').slice(20));
  assert.deepEqual(events.read().map(row => row.type), ['tool.output']);
  appendFileSync(join(root, 'release-work/gate/events.jsonl'), line('gate.start'));
  assert.deepEqual(events.read().map(row => row.type), ['gate.start']);
  mkdirSync(join(root, 'candidate/gate'), { recursive: true });
  writeFileSync(join(root, 'candidate/gate/events.jsonl'), readFileSync(join(root, 'release-work/gate/events.jsonl')));
  rmSync(join(root, 'release-work'), { recursive: true });
  appendFileSync(join(root, 'candidate/gate/events.jsonl'), line('gate.end'));
  assert.deepEqual(events.read().map(row => row.type), ['gate.end']);
  appendFileSync(join(root, 'operation/events.jsonl'), '{"schema_version":2,"type":"odd"}\n');
  assert.throws(() => events.read(), /invalid producer event/);
});
