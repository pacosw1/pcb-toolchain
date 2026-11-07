import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { renderImages, type Run } from './board-images.ts';

const TOOLS = { kicadCli: '/fake/kicad-cli' };
const SVG = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><path d="M0 0h10"/></svg>';
const out = (args: string[]): string => args[args.indexOf('-o') + 1]!;

function folder(t: TestContext): string {
  const dir = mkdtempSync(join(tmpdir(), 'board-images-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}
/** A runner that writes an SVG to each -o file and records the calls. */
const recorder = (calls: string[][], fail?: boolean, content = SVG): Run => (command, args) => {
  calls.push([command, ...args]);
  if (fail) return { status: 1, stderr: 'boom' };
  writeFileSync(out(args), content);
  return { status: 0, stderr: '' };
};

test('renders a top and a bottom svg with kicad-cli only, on a white background', t => {
  const dir = folder(t), calls: string[][] = [];
  renderImages('/b/X.kicad_pcb', join(dir, 'images'), recorder(calls), TOOLS);
  assert.deepEqual(readdirSync(join(dir, 'images')).sort(), ['bottom.svg', 'top.svg']);
  assert.equal(calls.length, 2);
  for (const call of calls) { assert.equal(call[0], TOOLS.kicadCli); assert.deepEqual(call.slice(1, 4), ['pcb', 'export', 'svg']); }
  assert.ok(calls[0]!.includes('F.Cu,F.Mask,F.SilkS,Edge.Cuts'));
  assert.ok(calls[1]!.includes('-m'), 'the bottom view is mirrored');
  for (const side of ['top', 'bottom']) {
    const text = readFileSync(join(dir, 'images', `${side}.svg`), 'utf8');
    assert.match(text, /^<svg [^>]*>\s*<rect width="100%" height="100%" fill="white"\/>/);
    assert.ok(text.includes('<path d="M0 0h10"/>'), 'the drawing is kept');
  }
});

test('a failed or missing renderer, or a file that is not an svg, is an error that names kicad-cli', t => {
  const dir = folder(t);
  assert.throws(() => renderImages('/b/X.kicad_pcb', join(dir, 'a'), recorder([], true), TOOLS), /kicad-cli failed \(exit 1\): boom/);
  assert.throws(() => renderImages('/b/X.kicad_pcb', join(dir, 'b'), () => ({ status: null, stderr: '', error: new Error('spawn ENOENT') }), TOOLS), /kicad-cli could not start: spawn ENOENT/);
  assert.throws(() => renderImages('/b/X.kicad_pcb', join(dir, 'c'), () => ({ status: 0, stderr: '' }), TOOLS), /kicad-cli wrote no file/);
  assert.throws(() => renderImages('/b/X.kicad_pcb', join(dir, 'd'), recorder([], false, 'plain text'), TOOLS), /kicad-cli wrote no svg/);
  assert.equal(existsSync(join(dir, 'a/top.svg')), false);
});
