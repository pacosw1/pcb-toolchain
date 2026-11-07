import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { acceptSeal, isCanonicalRoot, reseal, resealLocked, sealedWrite, sealStatus, verifySeal, withSealLock } from './cad-seal.ts';
import { sealFixtureBoard } from './cad-seal-fixture.ts';
import { gateInputs } from './gate-inputs.mjs';
import { iotrouteMissing } from './iotroute-bin.ts';

const needsBinary = { skip: iotrouteMissing() };
const writer = { tool: 'unit', run_id: null };
const PCB = 'hardware-design/boards/X/cad/X.kicad_pcb';

function project(t: { after(fn: () => void): void }, where = '') {
  const top = realpathSync(mkdtempSync(join(tmpdir(), 'cad-seal-')));
  t.after(() => rmSync(top, { recursive: true, force: true }));
  const root = where ? join(top, where) : top;
  const put = (relative: string, content: string) => { const path = join(root, relative); mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, content); return path; };
  put('hardware-design/boards/X/gate.json', JSON.stringify({ project: 'cad/X', checks: {} }));
  for (const ext of ['kicad_pcb', 'kicad_sch', 'kicad_pro', 'kicad_dru']) put(`hardware-design/boards/X/cad/X.${ext}`, `fixture ${ext}`);
  return { root, put, pcb: join(root, PCB), seal: join(root, 'hardware-design/boards/X/cad-seal.json'), log: join(root, '.gate/cad-seal/X.jsonl') };
}
const lines = (path: string) => readFileSync(path, 'utf8').trim().split('\n').map(line => JSON.parse(line) as Record<string, unknown>);

test('a clean seal passes and the record is deterministic', t => {
  const p = project(t);
  sealFixtureBoard(p.root, 'X');
  verifySeal(p.root, 'X');
  const first = readFileSync(p.seal, 'utf8');
  reseal(p.root, 'X', { tool: 'fixture', run_id: null }, 'fixture');
  assert.equal(readFileSync(p.seal, 'utf8'), first);
  const record = JSON.parse(first);
  assert.equal(record.schema, 'iot-lab.cad-seal.v1');
  assert.deepEqual(Object.keys(record.files), ['hardware-design/boards/X/cad/X.kicad_dru', PCB, 'hardware-design/boards/X/cad/X.kicad_pro', 'hardware-design/boards/X/cad/X.kicad_sch', 'hardware-design/boards/X/gate.json']);
  assert.deepEqual(record.writer, { tool: 'fixture', run_id: null });
  assert.doesNotMatch(first, /time|date|_at/);
});

test('a missing seal fails closed and names the command for the first seal', t => {
  const p = project(t);
  assert.equal(sealStatus(p.root, 'X').state, 'missing');
  assert.throws(() => verifySeal(p.root, 'X'), /no CAD seal.*tools\/pcb seal X --accept --reason/s);
});

test('a changed, added and removed file are each named with both commands', t => {
  const p = project(t);
  sealFixtureBoard(p.root, 'X');
  writeFileSync(p.pcb, 'edited in KiCad');
  rmSync(join(p.root, 'hardware-design/boards/X/cad/X.kicad_dru'));
  const status = sealStatus(p.root, 'X');
  assert.equal(status.state, 'changed');
  assert.deepEqual(status.changed, [PCB]);
  assert.deepEqual(status.removed, ['hardware-design/boards/X/cad/X.kicad_dru']);
  assert.throws(() => verifySeal(p.root, 'X'), (error: Error) => error.message.includes(`changed: ${PCB}`) && error.message.includes('removed: hardware-design/boards/X/cad/X.kicad_dru')
    && error.message.includes('git checkout') && error.message.includes('tools/pcb seal X --accept --reason TEXT'));
  p.put('hardware-design/boards/X/cad/X.kicad_dru', 'fixture kicad_dru');
  writeFileSync(p.pcb, 'fixture kicad_pcb');
  verifySeal(p.root, 'X');
});

test('a run workspace or candidate copy is not canonical and is never sealed', t => {
  const w = project(t, '.gate/cli/run-1/workspace');
  assert.equal(isCanonicalRoot(w.root), false);
  assert.equal(sealStatus(w.root, 'X').state, 'not_canonical');
  verifySeal(w.root, 'X');
  reseal(w.root, 'X', writer);
  let ran = 0;
  sealedWrite(w.pcb, writer, () => { ran++; writeFileSync(w.pcb, 'overwritten in the workspace'); });
  assert.equal(ran, 1);
  assert.equal(existsSync(w.seal), false);
  assert.equal(existsSync(w.log), false);
  assert.equal(isCanonicalRoot(project(t).root), true);
});

test('a copied seal does not make an overwritten workspace board fail', t => {
  const c = project(t);
  sealFixtureBoard(c.root, 'X');
  const w = project(t, '.gate/cli/run-2/workspace');
  writeFileSync(w.seal, readFileSync(c.seal));
  writeFileSync(w.pcb, 'candidate result');
  verifySeal(w.root, 'X');
});

test('sealedWrite checks first, writes, reseals and logs the tool', t => {
  const p = project(t);
  sealFixtureBoard(p.root, 'X');
  const before = JSON.parse(readFileSync(p.seal, 'utf8')).sha256;
  sealedWrite(p.pcb, { tool: 'set_stackup', run_id: 'run-9' }, () => writeFileSync(p.pcb, 'new stackup'));
  verifySeal(p.root, 'X');
  const record = JSON.parse(readFileSync(p.seal, 'utf8'));
  assert.deepEqual(record.writer, { tool: 'set_stackup', run_id: 'run-9' });
  const rows = lines(p.log);
  assert.equal(rows.length, 2);
  assert.deepEqual([rows[1]!.tool, rows[1]!.before, rows[1]!.after], ['set_stackup', before, record.sha256]);
});

test('sealedWrite refuses a tampered board without running the write', t => {
  const p = project(t);
  sealFixtureBoard(p.root, 'X');
  writeFileSync(p.pcb, 'tampered');
  let ran = false;
  assert.throws(() => sealedWrite(p.pcb, writer, () => { ran = true; }), /changed outside our tools/);
  assert.equal(ran, false);
  assert.throws(() => sealedWrite(p.pcb, writer, () => {}), /tools\/pcb seal X --accept/);
});

test('sealedWrite keeps the seal old when the write throws, so a partial write is caught', t => {
  const p = project(t);
  sealFixtureBoard(p.root, 'X');
  assert.throws(() => sealedWrite(p.pcb, writer, () => { writeFileSync(p.pcb, 'half'); throw new Error('boom'); }), /boom/);
  assert.throws(() => verifySeal(p.root, 'X'), /changed/);
});

test('sealedWrite fails closed when a canonical board has no seal, and skips non-CAD files and non-board folders', t => {
  const p = project(t);
  assert.throws(() => sealedWrite(p.pcb, writer, () => {}), /no CAD seal/);
  let ran = 0;
  sealedWrite(join(p.root, 'hardware-design/boards/X/gate-metrics.json'), writer, () => { ran++; });
  sealedWrite(p.put('hardware-design/boards/_art/a.kicad_sch', 'x'), writer, () => { ran++; });
  sealedWrite(join(p.root, 'elsewhere.kicad_pcb'), writer, () => { ran++; });
  assert.equal(ran, 3);
});

const GATE = 'hardware-design/boards/X/gate.json';
/** A board whose gate.json names check data files: a default name, a custom name in a folder, and a file that a rule file names. */
function dataBoard(t: { after(fn: () => void): void }) {
  const p = project(t);
  p.put('hardware-design/boards/X/gate.json', JSON.stringify({ project: 'cad/X', stage: 'G4', checks: { rf: 'rf-lines.json', pairs: 'rules/custom-pairs.json' } }));
  p.put('hardware-design/boards/X/rf-lines.json', '{"lines":[]}');
  p.put('hardware-design/boards/X/reference-planes.json', '{"grounds":[]}');
  p.put('hardware-design/boards/X/rules/custom-pairs.json', '{"more":"extra.json"}');
  p.put('hardware-design/boards/X/rules/extra.json', '{"pairs":[]}');
  return p;
}

test('the seal covers gate.json and every check data file, and each change stops the next command', t => {
  const p = dataBoard(t);
  sealFixtureBoard(p.root, 'X');
  const files = Object.keys(JSON.parse(readFileSync(p.seal, 'utf8')).files);
  for (const name of ['gate.json', 'rf-lines.json', 'reference-planes.json', 'rules/custom-pairs.json', 'rules/extra.json']) assert.ok(files.includes(`hardware-design/boards/X/${name}`), `${name} is sealed`);
  verifySeal(p.root, 'X');
  for (const name of ['gate.json', 'rf-lines.json', 'reference-planes.json', 'rules/custom-pairs.json', 'rules/extra.json']) {
    const path = join(p.root, 'hardware-design/boards/X', name), original = readFileSync(path, 'utf8');
    writeFileSync(path, original + ' ');
    assert.throws(() => verifySeal(p.root, 'X'), (error: Error) => error.message.includes(`changed: hardware-design/boards/X/${name}`), name);
    writeFileSync(path, original);
    verifySeal(p.root, 'X');
  }
});

test('a removed gate check key and a removed data file are caught', t => {
  const p = dataBoard(t);
  sealFixtureBoard(p.root, 'X');
  writeFileSync(join(p.root, GATE), JSON.stringify({ project: 'cad/X', stage: 'G3', checks: {} }));
  assert.throws(() => verifySeal(p.root, 'X'), new RegExp(`changed: ${GATE}`));
  writeFileSync(join(p.root, GATE), JSON.stringify({ project: 'cad/X', stage: 'G4', checks: { rf: 'rf-lines.json', pairs: 'rules/custom-pairs.json' } }));
  rmSync(join(p.root, 'hardware-design/boards/X/rf-lines.json'));
  assert.throws(() => verifySeal(p.root, 'X'), /removed: hardware-design\/boards\/X\/rf-lines\.json/);
});

test('a new check data file is caught as added', t => {
  const p = dataBoard(t);
  sealFixtureBoard(p.root, 'X');
  p.put('hardware-design/boards/X/diff-pairs.json', '{}');
  assert.throws(() => verifySeal(p.root, 'X'), /added: hardware-design\/boards\/X\/diff-pairs\.json/);
});

test('an old seal without data files fails closed with a message that names the cause and the one-time accept', t => {
  const p = dataBoard(t);
  sealFixtureBoard(p.root, 'X');
  const record = JSON.parse(readFileSync(p.seal, 'utf8'));
  record.files = Object.fromEntries(Object.entries(record.files).filter(([path]) => /\.kicad_/.test(path)));
  writeFileSync(p.seal, JSON.stringify(record));
  assert.equal(sealStatus(p.root, 'X').state, 'changed');
  assert.throws(() => verifySeal(p.root, 'X'), (error: Error) => error.message.includes(`added: ${GATE}`) && /older toolchain/.test(error.message)
    && error.message.includes('tools/pcb seal X --accept --reason TEXT'));
  reseal(p.root, 'X', writer, 'cover the data files');
  verifySeal(p.root, 'X');
});

test('a CAD-only change does not show the old-seal hint', t => {
  const p = dataBoard(t);
  sealFixtureBoard(p.root, 'X');
  writeFileSync(p.pcb, 'edited');
  assert.throws(() => verifySeal(p.root, 'X'), (error: Error) => !/older toolchain/.test(error.message));
});

test('sealedWrite of gate.json checks the seal first and reseals after', t => {
  const p = dataBoard(t);
  sealFixtureBoard(p.root, 'X');
  sealedWrite(join(p.root, GATE), writer, () => writeFileSync(join(p.root, GATE), JSON.stringify({ project: 'cad/X', stage: 'G5', checks: {} })));
  verifySeal(p.root, 'X');
  writeFileSync(p.pcb, 'tampered');
  let ran = false;
  assert.throws(() => sealedWrite(join(p.root, GATE), writer, () => { ran = true; }), /changed outside our tools/);
  assert.equal(ran, false);
});

/** Seal lock calls with a fake clock: sleeping moves the clock and nothing waits. */
function fakeLock(alive: number[], pid = 1000, waitMs = 100) {
  let clock = 0;
  const sleeps: number[] = [];
  return { pid, alive: (other: number) => alive.includes(other), now: () => clock, sleep: (ms: number) => { sleeps.push(ms); clock += ms; }, waitMs, sleeps };
}
const lockFolder = (p: { root: string }) => join(p.root, '.gate/cad-seal/X.write-lock');
const takeLock = (p: { root: string }, pid: number) => { mkdirSync(lockFolder(p), { recursive: true }); writeFileSync(join(lockFolder(p), 'owner.json'), JSON.stringify({ pid })); };

test('sealedWrite holds the seal lock while it verifies, writes and reseals, and frees it after', t => {
  const p = project(t);
  sealFixtureBoard(p.root, 'X');
  let heldDuring = false;
  sealedWrite(p.pcb, writer, () => { heldDuring = existsSync(lockFolder(p)); writeFileSync(p.pcb, 'new stackup'); });
  assert.equal(heldDuring, true);
  assert.equal(existsSync(lockFolder(p)), false);
  assert.throws(() => sealedWrite(p.pcb, writer, () => { throw new Error('boom'); }), /boom/);
  assert.equal(existsSync(lockFolder(p)), false, 'a failed write frees the lock too');
});

test('sealedWrite refuses to run while another live process holds the seal lock', t => {
  const p = project(t);
  sealFixtureBoard(p.root, 'X');
  takeLock(p, 4242);
  const locks = fakeLock([4242]);
  let ran = false;
  assert.throws(() => sealedWrite(p.pcb, writer, () => { ran = true; }, locks), /locked by pid 4242/);
  assert.equal(ran, false);
  assert.equal(locks.sleeps.reduce((sum, ms) => sum + ms, 0) >= 100, true, 'it waited the whole wait first');
  assert.equal(existsSync(lockFolder(p)), true, 'the other holder keeps its lock');
});

test('a seal lock whose owner died is taken over', t => {
  const p = project(t);
  sealFixtureBoard(p.root, 'X');
  takeLock(p, 4242);
  let ran = false;
  sealedWrite(p.pcb, writer, () => { ran = true; writeFileSync(p.pcb, 'after a crash'); }, fakeLock([]));
  assert.equal(ran, true);
  verifySeal(p.root, 'X');
  assert.equal(existsSync(lockFolder(p)), false);
});

test('a seal lock without an owner record is never taken over', t => {
  const p = project(t);
  sealFixtureBoard(p.root, 'X');
  mkdirSync(lockFolder(p), { recursive: true });
  writeFileSync(join(lockFolder(p), 'owner.json'), 'not json');
  assert.throws(() => sealedWrite(p.pcb, writer, () => {}, fakeLock([])), /locked by pid unknown/);
});

test('a write inside a write of the same board does not wait for its own lock', t => {
  const p = project(t);
  sealFixtureBoard(p.root, 'X');
  const locks = fakeLock([]);
  let inner = false;
  withSealLock(p.root, 'X', () => withSealLock(p.root, 'X', () => { inner = true; }, locks), locks);
  assert.equal(inner, true);
  assert.deepEqual(locks.sleeps, []);
  assert.equal(existsSync(lockFolder(p)), false);
});

test('resealLocked waits on the same lock that sealedWrite takes', async t => {
  const p = project(t);
  sealFixtureBoard(p.root, 'X');
  takeLock(p, 4242);
  const before = readFileSync(p.seal, 'utf8');
  await assert.rejects(resealLocked(p.root, 'X', writer, 'x', fakeLock([4242])), /locked by pid 4242/);
  assert.equal(readFileSync(p.seal, 'utf8'), before);
});

test('the seal file is not a gate input', t => {
  const p = project(t);
  const files = () => gateInputs(p.root, 'X').files.map(path => path.slice(p.root.length + 1));
  assert.ok(!files().includes('hardware-design/boards/X/cad-seal.json'));
  sealFixtureBoard(p.root, 'X');
  assert.ok(!files().includes('hardware-design/boards/X/cad-seal.json'));
  assert.ok(files().includes('hardware-design/boards/X/gate.json'));
});

test('accept records a person edit with its reason, and also makes the first seal', needsBinary, async t => {
  const p = project(t);
  await assert.rejects(acceptSeal(p.root, 'X', ' '), /--reason/);
  await acceptSeal(p.root, 'X', 'first seal');
  verifySeal(p.root, 'X');
  writeFileSync(p.pcb, 'a person edit in KiCad');
  await acceptSeal(p.root, 'X', 'moved a connector');
  verifySeal(p.root, 'X');
  const rows = lines(p.log);
  assert.deepEqual(rows.map(row => row.reason), ['first seal', 'moved a connector']);
  assert.equal(rows[0]!.before, null);
  assert.equal(rows[1]!.before, rows[0]!.after);
  const w = project(t, '.gate/cli/run-3/workspace');
  await assert.rejects(acceptSeal(w.root, 'X', 'x'), /not canonical/);
});
