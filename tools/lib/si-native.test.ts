import assert from 'node:assert/strict';
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import type { BoardDocument } from './board-types.ts';
import { runChecker, TOOL_ERROR } from './si-native.ts';

function folder(t: TestContext): string {
  const dir = mkdtempSync(join(tmpdir(), 'si-native-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

/** A checker that writes its arguments and a copy of the board JSON it was given, then exits `code`. */
function fakeChecker(dir: string, code: number): string {
  const path = join(dir, 'iotroute');
  writeFileSync(path, `#!/bin/sh\necho "$@" > "${dir}/args"\nwhile [ $# -gt 1 ]; do [ "$1" = --board-json ] && cp "$2" "${dir}/seen.json"; shift; done\nexit ${code}\n`);
  chmodSync(path, 0o755);
  return path;
}

const document = { schema: 'iot-lab.board.v1', board: {} } as unknown as BoardDocument;

test('the checker gets the refilled board and its exit code comes back', t => {
  const dir = folder(t);
  const board = join(dir, 'x.kicad_pcb');
  writeFileSync(board, '(kicad_pcb)\n');
  const reads: unknown[] = [];
  const code = runChecker('si-planes', board, 'spec.json', ['--tools', 'tools'], {
    readBoard: (pcb, options) => { reads.push([pcb, options]); return document; },
    binary: () => fakeChecker(dir, 1),
  });
  assert.equal(code, 1);
  assert.deepEqual(reads, [[board, { refill: true }]]);
  assert.match(readFileSync(join(dir, 'args'), 'utf8'), new RegExp(`^si-planes ${board} spec.json --tools tools --board-json `));
  assert.deepEqual(JSON.parse(readFileSync(join(dir, 'seen.json'), 'utf8')), document);
});

test('a missing board goes to the checker, which reports it, with no board JSON', t => {
  const dir = folder(t);
  const code = runChecker('si-pairs', join(dir, 'none.kicad_pcb'), 'spec.json', [], {
    readBoard: () => { throw new Error('must not read'); },
    binary: () => fakeChecker(dir, TOOL_ERROR),
  });
  assert.equal(code, TOOL_ERROR);
  assert.doesNotMatch(readFileSync(join(dir, 'args'), 'utf8'), /--board-json/);
});

test('no board JSON, or no binary, is exit 2 and never a pass', t => {
  const dir = folder(t);
  const board = join(dir, 'x.kicad_pcb');
  writeFileSync(board, '(kicad_pcb)\n');
  const printed: string[] = [];
  t.mock.method(console, 'log', (line: string) => printed.push(line));
  assert.equal(runChecker('si-planes', board, 's', [], { readBoard: () => { throw new Error('daemon down'); }, binary: () => fakeChecker(dir, 0) }), TOOL_ERROR);
  assert.equal(runChecker('si-planes', board, 's', [], { readBoard: () => document, binary: () => join(dir, 'no-such-binary') }), TOOL_ERROR);
  assert.equal(printed[0], 'ERROR daemon down');
  assert.match(printed[1] ?? '', /^ERROR .*ENOENT/);
});
