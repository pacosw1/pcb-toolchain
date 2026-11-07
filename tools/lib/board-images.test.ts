import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { renderImages, type Run } from './board-images.ts';

const TOOLS = { kicadCli: '/fake/kicad-cli', rsvg: '/fake/rsvg-convert' };
const out = (args: string[]): string => args[args.indexOf('-o') + 1]!;

function folder(t: TestContext): string {
  const dir = mkdtempSync(join(tmpdir(), 'board-images-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}
/** A runner that writes each -o file and records the calls. */
const recorder = (calls: string[][], fail?: (command: string) => boolean): Run => (command, args) => {
  calls.push([command, ...args]);
  if (fail?.(command)) return { status: 1, stderr: 'boom' };
  writeFileSync(out(args), 'x');
  return { status: 0, stderr: '' };
};

test('renders a top and a bottom png from kicad-cli svg export, with a white background', t => {
  const dir = folder(t), calls: string[][] = [];
  renderImages('/b/X.kicad_pcb', join(dir, 'images'), recorder(calls), TOOLS);
  assert.deepEqual(readdirSync(join(dir, 'images')).sort(), ['bottom.png', 'top.png']);
  const kicad = calls.filter(call => call[0] === TOOLS.kicadCli), rsvg = calls.filter(call => call[0] === TOOLS.rsvg);
  assert.equal(kicad.length, 2);
  for (const call of kicad) assert.deepEqual(call.slice(1, 4), ['pcb', 'export', 'svg']);
  assert.ok(kicad[0]!.includes('F.Cu,F.Mask,F.SilkS,Edge.Cuts'));
  assert.ok(kicad[1]!.includes('-m'), 'the bottom view is mirrored');
  assert.equal(rsvg.length, 2);
  for (const call of rsvg) assert.deepEqual(call.slice(1, 3), ['-b', 'white']);
});

test('a failed or missing renderer is an error that names the renderer', t => {
  const dir = folder(t);
  assert.throws(() => renderImages('/b/X.kicad_pcb', join(dir, 'a'), recorder([], command => command === TOOLS.kicadCli), TOOLS), /kicad-cli failed \(exit 1\): boom/);
  assert.throws(() => renderImages('/b/X.kicad_pcb', join(dir, 'b'), recorder([], command => command === TOOLS.rsvg), TOOLS), /rsvg-convert failed \(exit 1\): boom/);
  assert.throws(() => renderImages('/b/X.kicad_pcb', join(dir, 'c'), () => ({ status: null, stderr: '', error: new Error('spawn ENOENT') }), TOOLS), /kicad-cli could not start: spawn ENOENT/);
  assert.throws(() => renderImages('/b/X.kicad_pcb', join(dir, 'd'), () => ({ status: 0, stderr: '' }), TOOLS), /kicad-cli wrote no file/);
  assert.equal(existsSync(join(dir, 'a/top.png')), false);
});
