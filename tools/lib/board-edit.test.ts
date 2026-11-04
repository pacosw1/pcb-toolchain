import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { test, type TestContext } from 'node:test';
import { BoardEdit, formsByUuid, itemUuid, mmText, quoted } from './board-edit.ts';

const BOARD = `(kicad_pcb
\t(version 20260206)
\t(gr_text "a ) b \\" (x"
\t\t(at 1 2)
\t\t(uuid "aaaa")
\t)
\t(footprint "lib:X"
\t\t(uuid "bbbb")
\t\t(fp_text user "T"
\t\t\t(uuid "cccc")
\t\t)
\t)
\t(segment
\t\t(start 0 0)
\t\t(uuid "dddd")
\t)
)
`;

test('millimetres are cut to whole nanometres like pcbnew, as write.rs does', () => {
  const cases: [number, string][] = [[178.705, '178.705'], [0.4, '0.4'], [2, '2'], [-1.5, '-1.5'], [222.0289881, '222.028988'],
    [1.2345679, '1.234567'], [-0.0000004, '0'], [122.52499999999999, '122.524999']];
  for (const [mm, text] of cases) assert.equal(mmText(mm), text);
});

test('a KiCad string escapes backslash and quote', () => {
  assert.equal(quoted('N"Q\\'), '"N\\"Q\\\\"');
});

test('ids are stable for an input and differ between inputs', () => {
  assert.equal(itemUuid('seed', 3), itemUuid('seed', 3));
  assert.notEqual(itemUuid('seed', 3), itemUuid('seed', 4));
  assert.match(itemUuid('seed', 3), /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-a[0-9a-f]{3}-[0-9a-f]{12}$/);
});

test('items are found by uuid at any depth, past parentheses and quotes in strings', () => {
  const forms = formsByUuid(BOARD);
  assert.deepEqual([...forms.keys()].sort(), ['aaaa', 'bbbb', 'cccc', 'dddd']);
  assert.equal(forms.get('aaaa')!.kind, 'gr_text');
  assert.equal(forms.get('cccc')!.kind, 'fp_text');
  const footprint = forms.get('bbbb')!;
  assert.ok(BOARD.slice(footprint.start, footprint.end).endsWith('(uuid "cccc")\n\t\t)\n\t)'));
});

test('unbalanced text is refused', () => {
  assert.throws(() => formsByUuid('(kicad_pcb (a'), /does not close/);
  assert.throws(() => formsByUuid('(a))'), /unmatched/);
  assert.throws(() => formsByUuid('(a "b'), /unterminated/);
});

test('add, remove and replace leave the rest of the text alone', () => {
  const edit = new BoardEdit(BOARD);
  edit.remove('dddd');
  edit.replace('aaaa', edit.textOf('aaaa').replace('(at 1 2)', '(at 3 4)'));
  edit.add('\t(gr_line)\n');
  const text = edit.text();
  assert.ok(text.includes('(at 3 4)\n\t\t(uuid "aaaa")'));
  assert.ok(!text.includes('dddd'));
  assert.ok(text.includes('(fp_text user "T"'));
  assert.ok(text.endsWith('\t(gr_line)\n)\n'));
  assert.deepEqual([...formsByUuid(text).keys()].sort(), ['aaaa', 'bbbb', 'cccc']);
});

test('a nested item can change on its own, and overlapping changes are refused', () => {
  const edit = new BoardEdit(BOARD);
  edit.replace('cccc', '(fp_text user "U"\n\t\t\t(uuid "cccc")\n\t\t)');
  assert.ok(edit.text().includes('"U"'));
  assert.throws(() => edit.remove('bbbb'), /overlaps/);
  assert.throws(() => edit.remove('zzzz'), /no item with uuid zzzz/);
});

function project(t: TestContext): string {
  const root = mkdtempSync(join(tmpdir(), 'board-edit-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, 'src'));
  writeFileSync(join(root, 'src/X.kicad_pcb'), BOARD);
  writeFileSync(join(root, 'src/X.kicad_pro'), '{"original":true}');
  writeFileSync(join(root, 'src/X.kicad_sch'), '(kicad_sch)');
  return root;
}

// A stand-in kicad-cli: writes a report and overwrites .kicad_pro, as a real save can.
const FAKE_CLI = `#!/bin/sh
out=; for a in "$@"; do [ "$prev" = --output ] && out=$a; prev=$a; last=$a; done
echo "$@" > "$(dirname "$last")/args"
echo '{"defaults":true}' > "$(dirname "$last")/X.kicad_pro"
echo '{"violations":[{"type":"clearance"},{"type":"clearance"},{"type":"via_dangling"}],"unconnected_items":[1],"schematic_parity":[]}' > "$out"
`;

test('saveBoard runs one kicad-cli save on a copy and restores .kicad_pro', t => {
  const root = project(t);
  const cli = join(root, 'kicad-cli');
  writeFileSync(cli, FAKE_CLI);
  chmodSync(cli, 0o755);
  const program = `import {editBoard} from ${JSON.stringify(new URL('./board-edit.ts', import.meta.url).pathname)};
    console.log(JSON.stringify(editBoard(process.argv[1], process.argv[2], b => b.remove('dddd'))));`;
  const run = spawnSync(process.execPath, ['--experimental-strip-types', '--no-warnings', '--input-type=module', '-e', program,
    join(root, 'src/X.kicad_pcb'), join(root, 'out')], { encoding: 'utf8', env: { ...process.env, KICAD_CLI: cli } });
  assert.equal(run.status, 0, run.stderr);
  const report = JSON.parse(run.stdout);
  assert.deepEqual(report.violations, { clearance: 2, via_dangling: 1 });
  assert.deepEqual([report.errors, report.unconnected, report.parity, report.passed], [3, 1, 0, false]);
  assert.equal(readFileSync(join(root, 'out/X.kicad_pro'), 'utf8'), '{"original":true}');
  assert.ok(!readFileSync(join(root, 'out/X.kicad_pcb'), 'utf8').includes('dddd'));
  assert.ok(readFileSync(join(root, 'src/X.kicad_pcb'), 'utf8').includes('dddd'));
  assert.match(readFileSync(join(root, 'out/args'), 'utf8'), /^pcb drc --schematic-parity --refill-zones --save-board /);
});
