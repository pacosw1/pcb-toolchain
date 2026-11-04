// tools/fetch-e2k-assets.mjs against a stand-in easyeda2kicad. Run: node --test tools/lib/fetch-e2k-assets.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';

const tool = new URL('../fetch-e2k-assets.mjs', import.meta.url).pathname;
const SCRIPT = `#!/bin/sh
for a in "$@"; do case "$a" in --lcsc_id=*) c=\${a#--lcsc_id=};; esac; done
while [ $# -gt 0 ]; do [ "$1" = --output ] && { base=$2; shift; }; shift; done
[ "$c" != C9 ] || { printf 'out\\r\\n'; printf 'bad\\n' >&2; exit 3; }
printf '(symbol "S" (property "Value" "MPN"))' > "$base.kicad_sym"
mkdir -p "$base.pretty" "$base.3dshapes"; printf x > "$base.pretty/F.kicad_mod"; printf y > "$base.3dshapes/b.step"; printf z > "$base.3dshapes/a.wrl"
[ "$c" != C2 ] || printf x > "$base.pretty/G.kicad_mod"
`;
function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'e2k-'));
  t.after(() => rmSync(root, {recursive: true, force: true}));
  mkdirSync(join(root, 'hardware-design/blocks/iot-lab.pretty'), {recursive: true});
  writeFileSync(join(root, 'e2k'), SCRIPT, {mode: 0o755});
  const run = (...args) => spawnSync(process.execPath, [tool, ...args], {encoding: 'utf8', env: {...process.env, IOT_LAB: root, EASYEDA2KICAD: join(root, 'e2k')}});
  return {root, run, asset: code => join(root, 'hardware-design/registry/cad-assets', code)};
}
const sha = path => createHash('sha256').update(readFileSync(path)).digest('hex');

test('a capture writes the manifest and the footprint link', t => {
  const f = fixture(t), r = f.run('C1');
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout, 'C1: MPN symbol "S" footprint F.kicad_mod\n');
  const text = readFileSync(join(f.asset('C1'), 'PQ-BRIDGE-MANIFEST.json'), 'utf8'), manifest = JSON.parse(text);
  assert.ok(text.endsWith('\n}\n'));
  assert.match(manifest.captured_at_utc, /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{6}\+00:00$/);
  assert.deepEqual(manifest.models, ['C1.3dshapes/a.wrl', 'C1.3dshapes/b.step']);
  assert.deepEqual(Object.keys(manifest), ['lcsc', 'mpn', 'state', 'captured_at_utc', 'conversion', 'symbol', 'footprints', 'models', 'review']);
  assert.equal(manifest.symbol.sha256, sha(join(f.asset('C1'), 'C1.kicad_sym')));
  const link = join(f.root, 'hardware-design/blocks/iot-lab.pretty/C1.kicad_mod');
  assert.ok(lstatSync(link).isSymbolicLink());
  assert.equal(readlinkSync(link), '../../registry/cad-assets/C1/C1.pretty/F.kicad_mod');
});
test('an existing capture and manifest are kept', t => {
  const f = fixture(t);
  f.run('C1');
  writeFileSync(join(f.asset('C1'), 'PQ-BRIDGE-MANIFEST.json'), '{"keep":1}');
  const r = f.run('C1');
  assert.equal(r.stdout, 'C1: kept (already captured)\nC1: MPN symbol "S" footprint F.kicad_mod\n');
  assert.equal(readFileSync(join(f.asset('C1'), 'PQ-BRIDGE-MANIFEST.json'), 'utf8'), '{"keep":1}');
});
test('failures stop with the old message and exit 1', t => {
  const f = fixture(t);
  for (const [code, text] of [['bad', 'bad: not an LCSC C-number\n'], ['C2', 'C2: expected one footprint, found 2\n'], ['C9', 'C9: easyeda2kicad failed: out\nbad\n\n']]) {
    const r = f.run(code);
    assert.equal(r.status, 1);
    assert.equal(r.stderr, text);
  }
  assert.equal(existsSync(join(f.asset('C2'), 'PQ-BRIDGE-MANIFEST.json')), false);
});
