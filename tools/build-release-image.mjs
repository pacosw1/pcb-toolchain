#!/usr/bin/env node
// Build the bounded, pinned Gerber-capable derivative on the existing executor.
//
//   node tools/build-release-image.mjs NEW_RUN_DIR [--tag TAG] [--wheel-cache DIR]
//
// Downloads unmodified, hash-pinned original wheels once; Docker install is offline. --wheel-cache reuses only original
// wheels with the matching pinned SHA256. The default native base ID is the existing image built by .cip/native.Dockerfile.
//
// The recipe hashes this file, so any change here needs a new default tag: an existing tag with another recipe is refused.
// iot-lab-release:10.0.6-gerber0.13.0 is the image of the Python tool (recipe 1f96079f...); -r2 is the first of this one.
import {createHash} from 'node:crypto';
import {copyFileSync, existsSync, mkdirSync, readFileSync, realpathSync, statSync, writeFileSync} from 'node:fs';
import {dirname, join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {PyError, SystemExit, decode, eprint, get, head, item, jsonDumps, jsonLoads, osError, parseArgs, print, run, strip} from './lib/py-compat.mjs';

const BASE = 'sha256:d7909a97456e89bef202e49c6c3c40bb14b6060a45f6559e08f3c3dc7e000fcf';
const BASE_ALIAS = 'iot-lab-release-base:d7909a97456e';
const LABEL = 'org.iot-lab.release-recipe';
// pip21.2.4 in the old local venv predates Python3.13. This bootstrap wheel is
// used only as an installer; it is not added to the native/system runtime.
const WHEELS = [
  ['pip-25.0.1-py3-none-any.whl', 'c46efd13b6aa8279f33f2864459c8ce587ea6a1a59ee20de055868d8f7688f7f', 'c9/bc/b7db44f5f39f9d0494071bddae6880eb645970366d0a200022a1a93d57f5'],
  ['gerbonara-0.13.0-py3-none-any.whl', '7b79b1c1caa667bd1557f9131e690f2cd5c6898131c991c21458bbe520a9431e', '84/ce/1b38df83f7ac315de81f9cdc5cff7cb0ba3cabd9aaa86f505ccd47125aec'],
  ['shapely-2.0.7-cp313-cp313-manylinux_2_17_x86_64.manylinux2014_x86_64.whl', 'adeddfb1e22c20548e840403e5e0b3d9dc3daf66f05fa59f1fcf5b5f664f0e98', 'f5/8a/2545cc2a30afc63fc6176c1da3b76af28ef9c7358ed4f68f7c6a9d86cf5b'],
  ['click-8.1.8-py3-none-any.whl', '63c132bbbed01578a06712a2d1f497bb62d9c1c0d329b7903a866228027263b2', '7e/d4/7ebdbd03970677812aac39c869717059dbb71a4cfc033ca6e5221787892c'],
  ['numpy-2.1.3-cp313-cp313-manylinux_2_17_x86_64.manylinux2014_x86_64.whl', '5641516794ca9e5f8a4d17bb45446998c6554704d888f86df9b200e66bdcce56', '70/50/73f9a5aa0810cdccda9c1d20be3cbe4a4d6ea6bfd6931464a44c95eef731'],
];

const digest = data => createHash('sha256').update(data).digest('hex');
// json.dumps(dict(base=, inputs=, wheels=), sort_keys=True): the bytes the Python tool hashed.
export function recipeOf(inputs) {
  const sortedInputs = new Map(Object.entries(inputs).sort(([a], [b]) => (a < b ? -1 : 1)));
  return digest(jsonDumps(new Map([['base', BASE], ['inputs', sortedInputs], ['wheels', WHEELS]])));
}
const inspect = name => run('docker', ['image', 'inspect', name], {timeout: 20});
const image = result => item(jsonLoads(result.stdout), 0);

function wheelBytes(name, url, cache) {
  const cached = cache ? join(cache, name) : null;
  if (cached && existsSync(cached) && statSync(cached).isFile()) return readFileSync(cached);
  // urllib's timeout=30 limits each socket wait, not the whole download.
  const p = run('curl', ['-sS', '-f', '-L', '--connect-timeout', '30', '--speed-limit', '1', '--speed-time', '30', url]);
  if (p.status !== 0) throw new PyError('RuntimeError', `${name}: download failed (${strip(head(decode(p.stderr), 120))})`);
  return p.stdout;
}

function main() {
  const args = parseArgs({prog: 'build-release-image.mjs', positionals: ['run'], options: [
    {flag: '--tag', fallback: 'iot-lab-release:10.0.6-gerber0.13.0-r2'}, {flag: '--wheel-cache'}]}, process.argv.slice(2));
  const source = dirname(fileURLToPath(import.meta.url));
  const inputs = Object.fromEntries(['release-native.Dockerfile', 'requirements-gerbercheck.txt', 'build-release-image.mjs']
    .map(name => [name, digest(readFileSync(join(source, name)))]));
  const recipe = recipeOf(inputs), wheels = [];
  mkdirSync(args.run);  // New durable run record; never overwrite prior evidence.
  const metadata = new Map([['base', BASE], ['base_alias', BASE_ALIAS], ['recipe_sha256', recipe], ['inputs', new Map(Object.entries(inputs))], ['tag', args.tag], ['wheels', wheels]]);
  const base = image(run('docker', ['image', 'inspect', BASE], {check: true, stdio: ['inherit', 'pipe', 'inherit'], timeout: 20}));
  if (item(base, 'Id') !== BASE) throw new PyError('ValueError', 'native base image identity mismatch');
  const alias = inspect(BASE_ALIAS);
  if (alias.status === 0) {
    if (item(image(alias), 'Id') !== BASE) throw new PyError('ValueError', 'release-only base alias already points to another image');
  } else run('docker', ['image', 'tag', BASE, BASE_ALIAS], {check: true, stdio: 'inherit', timeout: 20});
  const existing = inspect(args.tag);
  if (existing.status === 0) {
    const found = image(existing);
    if (get(get(item(found, 'Config'), 'Labels', new Map()), LABEL) !== recipe) throw new PyError('ValueError', 'image tag exists with different inputs; choose a new --tag');
    metadata.set('image_id', item(found, 'Id')).set('reused', true);
  } else {
    mkdirSync(join(args.run, 'wheels'));
    for (const [name, expected, path] of WHEELS) {
      const url = `https://files.pythonhosted.org/packages/${path}/${name}`;
      print('START: pinned wheel ' + name);
      const raw = wheelBytes(name, url, args.wheel_cache);
      if (digest(raw) !== expected) throw new PyError('ValueError', 'original wheel hash mismatch: ' + name);
      writeFileSync(join(args.run, 'wheels', name), raw);
      wheels.push(new Map([['file', name], ['url', url], ['sha256', expected]]));
      print('PASS: original wheel ' + name);
    }
    for (const name of ['release-native.Dockerfile', 'requirements-gerbercheck.txt']) copyFileSync(join(source, name), join(args.run, name));
    run('docker', ['build', '--network=none', '--pull=false', '--build-arg', 'NATIVE_BASE=' + BASE_ALIAS, '--build-arg', 'RELEASE_RECIPE_SHA256=' + recipe,
      '-f', join(args.run, 'release-native.Dockerfile'), '-t', args.tag, args.run], {check: true, stdio: 'inherit', timeout: 300});
    const built = image(run('docker', ['image', 'inspect', args.tag], {check: true, stdio: ['inherit', 'pipe', 'inherit'], timeout: 20}));
    metadata.set('image_id', item(built, 'Id')).set('reused', false);
  }
  writeFileSync(join(args.run, 'image.json'), jsonDumps(metadata, 2) + '\n');
  print(`PASS: Gerber-capable release image ${metadata.get('image_id')}; evidence=${args.run}`);
}

if (realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { main(); } catch (error) {
    if (error instanceof SystemExit) process.exitCode = error.code;
    else {
      eprint('FAIL: release image: ' + osError(error).message);
      process.exitCode = 1;
    }
  }
}
