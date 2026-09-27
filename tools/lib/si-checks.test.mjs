// Tests for the pure parser behind the SI gates (tools/lib/si-checks.mjs).
// Run: node --test tools/lib/si-checks.test.mjs

import {test} from 'node:test';
import assert from 'node:assert/strict';
import {parseGateOutput} from './si-checks.mjs';

test('planes: all pass, no FAIL lines', () => {
  const out = 'OK plane under CLK\n0 reference-plane failures\n';
  const r = parseGateOutput(out, 0, /reference-plane failures/, 'FAIL');
  assert.equal(r.ran, true);
  assert.equal(r.ok, true);
  assert.equal(r.detail, '0 reference-plane failures');
});

test('planes: FAIL lines make it fail and show up in the detail', () => {
  const out = 'FAIL SLOT_SCK: no plane\nFAIL SLOT_SDA: no plane\n2 reference-plane failures\n';
  const r = parseGateOutput(out, 1, /reference-plane failures/, 'FAIL');
  assert.equal(r.ok, false);
  assert.match(r.detail, /FAIL SLOT_SCK/);
  assert.match(r.detail, /FAIL SLOT_SDA/);
});

test('planes: caps the shown FAIL lines at 8', () => {
  const fails = Array.from({length: 12}, (_, i) => `FAIL net${i}`).join('\n');
  const out = `${fails}\n12 reference-plane failures\n`;
  const r = parseGateOutput(out, 1, /reference-plane failures/, 'FAIL');
  assert.equal(r.detail.split(' | ').length, 8);
});

test('pairs: summary line parses and PASS-only output is ok', () => {
  const out = 'si_pairs: 5 PASS, 0 FAIL\n';
  const r = parseGateOutput(out, 0, /^si_pairs: \d+ PASS, \d+ FAIL/, 'FAIL');
  assert.equal(r.ok, true);
  assert.equal(r.detail, 'si_pairs: 5 PASS, 0 FAIL');
});

test('pairs: a FAIL row fails the gate', () => {
  const out = 'FAIL SLOT_SCK: 110 ohm, want 90\nsi_pairs: 4 PASS, 1 FAIL\n';
  const r = parseGateOutput(out, 1, /^si_pairs: \d+ PASS, \d+ FAIL/, 'FAIL');
  assert.equal(r.ok, false);
  assert.match(r.detail, /SLOT_SCK/);
});

test('viapads: no vias in pads is ok', () => {
  const out = '0 vias in SMD pads\n';
  const r = parseGateOutput(out, 0, /vias in SMD pads/, 'FAIL via in pad');
  assert.equal(r.ok, true);
});

test('viapads: a via in a pad fails, and non-matching FAIL lines are not counted', () => {
  const out = 'FAIL via in pad R12.1\nFAIL other unrelated line\n1 vias in SMD pads\n';
  const r = parseGateOutput(out, 1, /vias in SMD pads/, 'FAIL via in pad');
  assert.equal(r.ok, false);
  assert.equal(r.detail, 'FAIL via in pad R12.1');
});

test('no summary line at all: fails closed and reports the exit code', () => {
  const r = parseGateOutput('Traceback: boom', 2, /vias in SMD pads/, 'FAIL via in pad');
  assert.equal(r.ran, false);
  assert.equal(r.ok, false);
  assert.match(r.detail, /did not run \(exit 2\)/);
});

test('summary line present but exit code non-zero: fails closed', () => {
  const out = '0 vias in SMD pads\n';
  const r = parseGateOutput(out, 1, /vias in SMD pads/, 'FAIL via in pad');
  assert.equal(r.ok, false);
});

test('kicad-happy: summary parses and FAIL rule lines fail the gate', async () => {
  const {KICAD_HAPPY_SUMMARY} = await import('./si-checks.mjs');
  const ok = parseGateOutput('0 kicad-happy findings (rules GP-001,RP-001)\n', 0, KICAD_HAPPY_SUMMARY, 'FAIL');
  assert.equal(ok.ok, true);
  const bad = parseGateOutput('FAIL RP-001 /OW_DATA no return via\n1 kicad-happy findings (rules RP-001)\n', 1, KICAD_HAPPY_SUMMARY, 'FAIL');
  assert.equal(bad.ok, false);
  assert.match(bad.detail, /OW_DATA/);
});

test('viapads: allow list goes to the tool, empty list adds nothing', async () => {
  const {viaPadsArgs} = await import('./si-checks.mjs');
  assert.deepEqual(viaPadsArgs('b.kicad_pcb', []), ['viapads', 'b.kicad_pcb']);
  assert.deepEqual(viaPadsArgs('b.kicad_pcb', ['U1.9']), ['viapads', 'b.kicad_pcb', '--allow', 'U1.9']);
});

test('kicad-happy: exempt file goes to the tool, no file adds nothing', async () => {
  const {kicadHappyArgs} = await import('./si-checks.mjs');
  assert.deepEqual(kicadHappyArgs('b.kicad_pcb'), ['b.kicad_pcb']);
  assert.deepEqual(kicadHappyArgs('b.kicad_pcb', 'ex.json'), ['b.kicad_pcb', '--exempt-file', 'ex.json']);
});

test('kicad-happy: each ground net goes to the tool as --ground', async () => {
  const {kicadHappyArgs} = await import('./si-checks.mjs');
  assert.deepEqual(kicadHappyArgs('b.kicad_pcb', undefined, ['FIELD_0V']), ['b.kicad_pcb', '--ground', 'FIELD_0V']);
});

test('kicad-happy: a STALE exempt line fails the gate and shows in the detail', async () => {
  const {KICAD_HAPPY_SUMMARY, KICAD_HAPPY_FAIL} = await import('./si-checks.mjs');
  const out = 'STALE exempt GP-001 /PS1_24V: no finding matched (24 V power)\n0 kicad-happy findings (rules GP-001)\n';
  const r = parseGateOutput(out, 2, KICAD_HAPPY_SUMMARY, KICAD_HAPPY_FAIL);
  assert.equal(r.ok, false);
  assert.match(r.detail, /STALE exempt GP-001 \/PS1_24V/);
});

test('port labels: summary and FAIL/STALE lines are parsed', async () => {
  const {PORT_LABELS_SUMMARY, PORT_LABELS_FAIL} = await import('./si-checks.mjs');
  const ok = parseGateOutput('port_labels: 3 connectors, 31 pads, 0 failures\n', 0, PORT_LABELS_SUMMARY, PORT_LABELS_FAIL);
  assert.equal(ok.ok, true);
  const out = 'FAIL J2 pad 1 (24V): no F.SilkS label within 4.0 mm\nSTALE exempt J3 pad 2: the pad has a label\n' +
    'port_labels: 3 connectors, 31 pads, 2 failures\n';
  const bad = parseGateOutput(out, 1, PORT_LABELS_SUMMARY, PORT_LABELS_FAIL);
  assert.equal(bad.ok, false);
  assert.match(bad.detail, /J2 pad 1.*\| STALE exempt J3/);
});
