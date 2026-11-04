import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, test } from 'node:test';
import { boardConfig, catalog, context, operationCommand, pipeline, pythonNative, registryRevision, sha } from './pcb-workflow.ts';
import { jsonDumps, PyError } from './py-compat.mjs';
import { caught, joinPath, relativeTo, resolvePath, textOf, withSuffix } from './py-path.ts';

let root: string;
const put = (name: string, text: string) => {
  const path = join(root, name);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text);
  return path;
};
const gate = (extra: object = {}) => put('hardware-design/boards/X/gate.json', JSON.stringify({ project: 'cad/X', stage: 'G3', checks: { erc: true }, ...extra }));
const pyType = (type: string) => (error: unknown) => error instanceof PyError && (error as PyError & { type: string }).type === type;
const asJson = (value: unknown) => JSON.parse(jsonDumps(value)) as Record<string, any>;

beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'pcb-workflow-')));
  gate();
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

test('joinPath keeps .. and an absolute part replaces the path, as pathlib does', () => {
  assert.equal(joinPath('/a/b', '../c', 'd/./e'), '/a/b/../c/d/e');
  assert.equal(joinPath('/a', '/b', 'c'), '/b/c');
  assert.throws(() => joinPath('/a', 5n), pyType('TypeError'));
});

test('resolvePath is non-strict and treats .. after a symlink physically', () => {
  mkdirSync(join(root, 'real/deep'), { recursive: true });
  symlinkSync(join(root, 'real/deep'), join(root, 'link'));
  assert.equal(resolvePath(join(root, 'link') + '/../sibling'), join(root, 'real/sibling'));
  assert.equal(resolvePath(join(root, 'missing/child')), join(root, 'missing/child'));
  symlinkSync(join(root, 'nowhere'), join(root, 'dangling'));
  assert.equal(resolvePath(join(root, 'dangling/x')), join(root, 'nowhere/x'));
});

test('withSuffix replaces only a real suffix', () => {
  assert.equal(withSuffix('/a/X', '.kicad_pcb'), '/a/X.kicad_pcb');
  assert.equal(withSuffix('/a/X.v2', '.kicad_pcb'), '/a/X.kicad_pcb');
  assert.equal(withSuffix('/a/.hidden', '.x'), '/a/.hidden.x');
});

test('relativeTo needs a whole-segment prefix', () => {
  assert.equal(relativeTo('/a/b/c', '/a/b'), 'c');
  assert.throws(() => relativeTo('/a/bc', '/a/b'), pyType('ValueError'));
});

test('textOf translates newlines like Path.read_text', () => {
  assert.equal(textOf(put('t.txt', 'a\r\nb\rc\n')), 'a\nb\nc\n');
});

test('caught maps Python exception families', () => {
  assert.ok(caught(new PyError('FileNotFoundError', ''), 'OSError'));
  assert.ok(caught(new PyError('json.decoder.JSONDecodeError', ''), 'ValueError'));
  assert.ok(!caught(new PyError('AttributeError', ''), 'OSError', 'ValueError', 'KeyError', 'TypeError'));
  assert.ok(caught(Object.assign(new Error('x'), { code: 'ENOENT' }), 'OSError'));
});

test('boardConfig rejects a bad ID, a missing project and a project outside the registry', () => {
  assert.throws(() => boardConfig(root, 'x'), /invalid board ID/);
  gate({ project: '' });
  assert.throws(() => boardConfig(root, 'X'), /requires a project/);
  gate({ project: '../../../outside/X' });
  assert.throws(() => boardConfig(root, 'X'), /escapes the board registry/);
  gate({ project: '..' });
  assert.throws(() => boardConfig(root, 'X'), /requires a project|escapes/);
});

test('the registry root itself is not a project', () => {
  gate({ project: '../' });
  assert.throws(() => boardConfig(root, 'X'), /escapes the board registry/);
});

test('registryRevision merges the revision and refuses a repeated keyword', () => {
  put('hardware-design/registry/boards.json', JSON.stringify({ boards: [{ id: 'OWNER', directory: 'D', revisions: [{ gate: 'X', spec: 'S.md' }] }] }));
  assert.deepEqual([...registryRevision(root, 'X').keys()], ['owner', 'directory', 'lifecycle', 'gate', 'spec']);
  put('hardware-design/registry/boards.json', JSON.stringify({ boards: [{ id: 'OWNER', directory: 'D', revisions: [{ gate: 'X', owner: 'other' }] }] }));
  assert.throws(() => registryRevision(root, 'X'), (error: Error) => pyType('TypeError')(error) && /multiple values for keyword argument 'owner'/.test(error.message));
  put('hardware-design/registry/boards.json', JSON.stringify({ boards: [{ id: 'X', revisions: [] }] }));
  assert.throws(() => registryRevision(root, 'X'), pyType('KeyError'));
});

test('context reports missing native inputs and keeps number types', () => {
  put('hardware-design/boards/X/gate.json', '{"project":"cad/X","checks":{"limit":1.0,"big":12345678901234567890}}');
  const info = asJson(context(root, 'X'));
  assert.equal(info.stage, 'G4');
  assert.equal(info.next_action, 'restore missing native inputs');
  assert.deepEqual(info.blockers.slice(0, 1), [{ rule: 'missing_native_input', path: 'hardware-design/boards/X/cad/X.kicad_pcb' }]);
  assert.match(jsonDumps(context(root, 'X')), /"limit": 1\.0, "big": 12345678901234567890/);
});

test('frozen reads only the Frozen section, whole board names and translated newlines', () => {
  put('FOCUS.md', '# F\r\n## Frozen\r\n- X because\r\n## Done\r\n- Y\r\n');
  assert.equal(asJson(context(root, 'X')).frozen, true);
  put('FOCUS.md', '# F\n## Frozen\n- X-B\n## Done\n- X\n');
  assert.equal(asJson(context(root, 'X')).frozen, false);
  put('FOCUS.md', '- X\n');
  assert.equal(asJson(context(root, 'X')).frozen, true);
});

test('a previous gate exit is Python-truthy: 1 and 1.5 block, 0, 0.0 and null do not', () => {
  put('hardware-design/boards/X/.gate/latest.json', '{"run":"r"}');
  const blocked = (text: string) => {
    put('hardware-design/boards/X/.gate/r/result.json', text);
    return asJson(context(root, 'X')).blockers.some((row: { rule: string }) => row.rule === 'previous_gate_failed');
  };
  assert.equal(blocked('{"exit":1}'), true);
  assert.equal(blocked('{"exit":1.5}'), true);
  assert.equal(blocked('{"exit":0}'), false);
  assert.equal(blocked('{"exit":0.0}'), false);
  assert.equal(blocked('{"exit":null}'), false);
});

test('a bad latest gate is a blocker, but a non-object report stays an uncaught AttributeError', () => {
  const latest = put('hardware-design/boards/X/.gate/latest.json', '{"run":"../../escape"}');
  assert.deepEqual(asJson(context(root, 'X')).blockers.find((row: { rule: string }) => row.rule === 'invalid_latest_gate'), { rule: 'invalid_latest_gate', evidence: latest });
  put('hardware-design/boards/X/.gate/latest.json', '{"run":5}');
  assert.equal(asJson(context(root, 'X')).previous_gate, null);
  put('hardware-design/boards/X/.gate/latest.json', '{"run":"r"}');
  put('hardware-design/boards/X/.gate/r/result.json', '[]');
  assert.throws(() => context(root, 'X'), pyType('AttributeError'));
});

test('context binds a reviewed manifest and the packet of the registry directory', () => {
  const manifest = put('hardware-design/registry/part-reviews/X.json', '{}');
  put('hardware-design/registry/boards.json', JSON.stringify({ boards: [{ id: 'O', directory: 'O', revisions: [{ gate: 'X', spec: 'SPEC-X.md' }] }] }));
  const info = asJson(context(root, 'X'));
  assert.equal(info.engineering.sha256, sha(manifest));
  assert.equal(info.commands.part_review, 'tools/pcb parts --json verify X --manifest hardware-design/registry/part-reviews/X.json');
  assert.ok(info.source_files.some((row: { path: string }) => row.path === 'hardware-design/boards/O/SPEC-X.md'));
  assert.ok(info.source_files.some((row: { path: string }) => row.path === 'hardware-design/boards/O/BOM-VERIFIED.csv'));
});

test('catalog lists boards with a gate.json, hidden folders included, sorted', () => {
  put('hardware-design/boards/A/gate.json', '{}');
  put('hardware-design/boards/.h/gate.json', '{}');
  put('hardware-design/boards/none/README', '');
  assert.deepEqual(asJson(catalog(root)).boards.map((row: { board: string }) => row.board), ['.h', 'A', 'X']);
});

test('pipeline needs a real script; operationCommand plans build, edit and route', () => {
  assert.equal(pipeline(root, 'X'), null);
  assert.throws(() => operationCommand(root, 'X', 'build'), /no integrated build pipeline for X/);
  gate({ pipeline: 'tools/build-x.sh' });
  put('tools/build-x.sh', '');
  assert.equal(pipeline(root, 'X'), 'tools/build-x.sh');
  assert.deepEqual(operationCommand(root, 'X', 'build'), ['sh', 'tools/build-x.sh']);
  const pcb = 'hardware-design/boards/X/cad/X.kicad_pcb';
  assert.deepEqual(operationCommand(root, 'X', 'edit', 's.json', 'place').slice(1), ['tools/pcbtool.py', 'place', pcb, 's.json']);
  assert.deepEqual(operationCommand(root, 'X', 'route', 's.json').slice(1), ['tools/pcbtool.py', 'route', pcb, 's.json']);
  assert.throws(() => operationCommand(root, 'X', 'edit', 's.json', 'other'), /edit kind/);
  assert.throws(() => operationCommand(root, 'X', 'edit'), /explicit JSON spec/);
  assert.throws(() => operationCommand(root, 'X', 'other'), /unknown candidate operation: other/);
});

test('pythonNative prefers KICAD_PYTHON, then KICAD_PY', () => {
  assert.equal(pythonNative({ KICAD_PYTHON: 'a', KICAD_PY: 'b' }), 'a');
  assert.equal(pythonNative({ KICAD_PY: 'b' }), 'b');
});
