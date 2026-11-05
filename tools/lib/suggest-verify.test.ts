import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test, type TestContext } from 'node:test';
import type { DrcFile } from './board-edit.ts';
import { checkDrcReport } from './drc-run.ts';
import { CommandFailure } from './pcbtool-cli.ts';
import { verifyCandidates, verifyVerdict, type Verdict } from './suggest-verify.ts';

const drc = (errors: [type: string, net: string][] = [], open: string[] = []): DrcFile => ({
  violations: errors.map(([type, net]) => ({ type, severity: 'error', items: [{ description: `Track [${net}]` }] })),
  unconnected_items: open.map(net => ({ items: [{ description: `Pad 1 [${net}]` }, { description: `Pad 2 [${net}]` }] })),
});

test('a candidate passes when the net connects and nothing else changes', () => {
  assert.deepEqual(verifyVerdict(drc([['clearance', 'X']], ['SIG', 'GND']), drc([['clearance', 'X']], ['GND']), 'SIG'), { ok: true, reason: '' });
});

test('a new error is rejected', () => {
  const { ok, reason } = verifyVerdict(drc([], ['SIG']), drc([['clearance', 'SIG']]), 'SIG');
  assert.equal(ok, false);
  assert.match(reason, /\+1 clearance/);
});

test('more unconnected on any ground is rejected', () => {
  assert.match(verifyVerdict(drc([], ['SIG', 'GND']), drc([], ['GND', 'GND']), 'SIG').reason, /GND unconnected 1 -> 2/);
  assert.match(verifyVerdict(drc([], ['SIG', 'ISO_0V']), drc([], ['ISO_0V', 'ISO_0V']), 'SIG').reason, /ISO_0V unconnected 1 -> 2/);
});

test('a net still open is rejected', () => {
  const { ok, reason } = verifyVerdict(drc([], ['SIG']), drc([], ['SIG']), 'SIG');
  assert.equal(ok, false);
  assert.match(reason, /SIG unconnected 1 -> 1/);
});

/** Verification with steps that write the line into the board copy and read it back. */
async function verified(t: TestContext, judge: (text: string) => DrcFile): Promise<Verdict[]> {
  const dir = mkdtempSync(join(tmpdir(), 'verify-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  mkdirSync(join(dir, 'P'));
  const board = join(dir, 'P', 'T.kicad_pcb');
  writeFileSync(board, 'BASE');
  const verdicts = await verifyCandidates(board, 'SIG', ['OK', 'CRASH'], {
    apply: (copy, line) => writeFileSync(copy, line),
    drc: copy => judge(readFileSync(copy, 'utf8')),
  });
  assert.equal(readFileSync(board, 'utf8'), 'BASE');   // the board is not changed
  return verdicts;
}

test('a failed baseline DRC stops with an error', async (t: TestContext) => {
  await assert.rejects(verified(t, text => {
    if (text === 'BASE') throw new Error('kicad-cli pcb drc killed by signal 9');
    return drc();
  }), error => error instanceof CommandFailure && /baseline DRC failed/.test(error.message));
});

test('a candidate DRC crash rejects that candidate only', async (t: TestContext) => {
  const [first, second] = await verified(t, text => {
    if (text === 'CRASH') throw new Error('kicad-cli pcb drc killed by signal 9');
    return drc([], text === 'BASE' ? ['SIG'] : []);
  });
  assert.equal(first!.ok, true);
  assert.equal(second!.ok, false);
  assert.match(second!.reason, /signal 9/);
});

test('a failed or broken DRC run is never read as clean', (t: TestContext) => {
  const dir = mkdtempSync(join(tmpdir(), 'report-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const report = join(dir, 'drc.json');
  const cases: [number, string | null, RegExp][] = [
    [-9, '{"violations": [], "unconnected_items": []}', /exit -9/], [0, '{"violations": [', /not valid JSON/], [0, '{}', /no violations/], [0, null, /no report/],
  ];
  for (const [code, text, message] of cases) {
    rmSync(report, { force: true });
    if (text !== null) writeFileSync(report, text);
    assert.throws(() => checkDrcReport(code, report), message);
  }
  writeFileSync(report, '{"violations": [], "unconnected_items": []}');
  assert.deepEqual(checkDrcReport(0, report), { violations: [], unconnected_items: [] });
});
