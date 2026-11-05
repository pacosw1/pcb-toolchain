import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { capture, type Bridge } from '../fetch-pq-bridge-assets.ts';

const CODE = 'C1001';
const SHAPE = `SVGNODE~${JSON.stringify({ attrs: { c_etype: 'outline3D', title: 'Body', uuid: 'm1' } })}`;
const SOURCE = {
  success: true,
  result: {
    title: 'MPN', uuid: 'u1', lcsc: { number: CODE },
    dataStr: { head: { c_para: { Manufacturer: 'Maker' } } },
    packageDetail: { title: 'PKG', uuid: 'p1', dataStr: { shape: ['TRACK~1', SHAPE] } },
  },
};
const DEVICE = { uuid: 'dev', supplierId: CODE, footprintUuid: 'fp', manufacturerId: 'MPN', otherProperty: { Symbol: 'sym' } };

const fetched = (status: number, body: string) => ({ status, b64: Buffer.from(body).toString('base64') });

function fakeBridge(device: unknown, model = fetched(200, 'ISO-10303-21;\n'), source: unknown = SOURCE): Bridge {
  return async code => {
    if (code.includes('getByLcscIds')) {
      if (device instanceof Error) throw device;
      return [device];
    }
    return code.includes('modules.easyeda.com') ? model : fetched(200, JSON.stringify(source));
  };
}

function folders() {
  const root = mkdtempSync(join(tmpdir(), 'pq-bridge-'));
  const converter = join(root, 'converter.sh');
  writeFileSync(converter, `#!/bin/sh
out=$(printf '%s' "$2" | sed -n "s/.*'--output', '\\([^']*\\)'.*/\\1/p")
printf '%s' "$2" > "$out.program"
printf 'symbol\\n' > "$out"
mkdir -p "\${out%.kicad_sym}.pretty"
printf 'footprint\\n' > "\${out%.kicad_sym}.pretty/a.kicad_mod"
`);
  chmodSync(converter, 0o755);
  return { assets: join(root, 'assets'), converter };
}

const manifest = (assets: string) => JSON.parse(readFileSync(join(assets, CODE, 'PQ-BRIDGE-MANIFEST.json'), 'utf8'));

test('a capture writes the symbol, footprint, model and manifest', async () => {
  const paths = folders();
  const summary = await capture(CODE, { ...paths, bridge: fakeBridge(DEVICE) });
  assert.deepEqual(summary, { lcsc: CODE, mpn: 'MPN', symbol: `${CODE}.kicad_sym`, footprints: 1, step: true });
  const written = manifest(paths.assets);
  assert.equal(written.pro_symbol_uuid, 'sym');
  assert.equal(written.model.file, `${CODE}.3dshapes/Body.step`);
  assert.equal(written.model_error, null);
  assert.ok(existsSync(join(paths.assets, CODE, `${CODE}.3dshapes/Body.step`)));
});

test('the easyeda2kicad program hands over the captured source', async () => {
  const paths = folders();
  await capture(CODE, { ...paths, bridge: fakeBridge(DEVICE) });
  const program = readFileSync(join(paths.assets, CODE, `${CODE}.kicad_sym.program`), 'utf8');
  const source = join(paths.assets, CODE, 'easyeda-bridge-source.json');
  assert.ok(program.includes(`source=json.load(open('${source}'))["result"]\n`));
  assert.ok(program.includes(`main(['--lcsc_id', '${CODE}', '--symbol', '--footprint', '--output', '`));
});

test('without the editor the device comes from the public source and says so', async () => {
  const paths = folders();
  await capture(CODE, { ...paths, bridge: fakeBridge(new Error('no editor')) });
  const device = JSON.parse(readFileSync(join(paths.assets, CODE, 'bridge-device.json'), 'utf8'));
  assert.equal(device.uuid, 'u1');
  assert.equal(device.source, 'public EasyEDA component API (no editor eda.lib_Device); no editor');
});

test('a failed model download is recorded, not fatal', async () => {
  const paths = folders();
  const summary = await capture(CODE, { ...paths, bridge: fakeBridge(DEVICE, fetched(404, '')) });
  assert.equal(summary.step, false);
  assert.match(manifest(paths.assets).model_error, /^HTTP 404: https:\/\/modules\.easyeda\.com\//);
});

test('a response that is not STEP is recorded as a model error', async () => {
  const paths = folders();
  await capture(CODE, { ...paths, bridge: fakeBridge(DEVICE, fetched(200, '<html>')) });
  assert.equal(manifest(paths.assets).model_error, 'Model response is not STEP');
});

test('a title mismatch with another supplier number stops the capture', async () => {
  const paths = folders();
  const source = { ...SOURCE, result: { ...SOURCE.result, lcsc: { number: 'C9' } } };
  await assert.rejects(capture(CODE, { ...paths, bridge: fakeBridge({ ...DEVICE, manufacturerId: 'OTHER' }, undefined, source) }),
    /title\/identity mismatch: MPN vs OTHER/);
});

test('an unsafe model title and a bad C-number stop the capture', async () => {
  const paths = folders();
  const unsafe = SHAPE.replace('Body', '../x');
  const source = { ...SOURCE, result: { ...SOURCE.result, packageDetail: { dataStr: { shape: [unsafe] } } } };
  await assert.rejects(capture(CODE, { ...paths, bridge: fakeBridge(DEVICE, undefined, source) }), /Unsafe model title/);
  await assert.rejects(capture('X1', { ...paths, bridge: fakeBridge(DEVICE) }), /Expected exact LCSC C-number/);
});
