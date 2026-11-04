// tools/build-release-image.mjs against stand-in docker and curl. Run: node --test tools/lib/build-release-image.test.mjs
// The fixture copies the tool and replaces its pinned wheels with a small one, so no real wheel is needed.
import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {delimiter, join} from 'node:path';

const here = name => new URL(name, import.meta.url).pathname;
const BASE = 'sha256:d7909a97456e89bef202e49c6c3c40bb14b6060a45f6559e08f3c3dc7e000fcf';
const ALIAS = 'iot-lab-release-base:d7909a97456e';
const TAG = 'iot-lab-release:10.0.6-gerber0.13.0-r2';
const WHEEL = 'fixture-1.0-py3-none-any.whl', BYTES = 'fixture wheel';
const sha = data => createHash('sha256').update(data).digest('hex');

// docker reads images.json ({name: inspect record}) and logs its argv; `build` adds the tag with the recipe label.
function fixture(t, images = {[BASE]: {Id: BASE}}) {
  const root = mkdtempSync(join(tmpdir(), 'release-image-'));
  t.after(() => rmSync(root, {recursive: true, force: true}));
  const tools = join(root, 'tools'), bin = join(root, 'bin');
  mkdirSync(join(tools, 'lib'), {recursive: true}); mkdirSync(bin);
  for (const name of ['release-native.Dockerfile', 'requirements-gerbercheck.txt']) copyFileSync(here('../' + name), join(tools, name));
  copyFileSync(here('./py-compat.mjs'), join(tools, 'lib/py-compat.mjs'));
  const source = readFileSync(here('../build-release-image.mjs'), 'utf8');
  const pinned = source.replace(/const WHEELS = \[[\s\S]*?\n\];/, `const WHEELS = [[${JSON.stringify(WHEEL)}, ${JSON.stringify(sha(BYTES))}, 'aa/bb/cc']];`);
  assert.notEqual(pinned, source);
  writeFileSync(join(tools, 'build-release-image.mjs'), pinned);
  writeFileSync(join(root, 'images.json'), JSON.stringify(images));
  writeFileSync(join(bin, 'docker'), `#!${process.execPath}
const fs=require('fs'),a=process.argv.slice(2),p=${JSON.stringify(root)},file=p+'/images.json',images=JSON.parse(fs.readFileSync(file));
fs.appendFileSync(p+'/docker.log',JSON.stringify(a)+'\\n');
if(process.env.DOCKER_FAIL===a[0]){process.stderr.write('docker broke\\n');process.exit(3);}
if(a[0]==='image'&&a[1]==='inspect'){if(!images[a[2]]){process.stderr.write('No such image\\n');process.exit(1);}console.log(JSON.stringify([images[a[2]]]));}
else if(a[0]==='image'&&a[1]==='tag'){images[a[3]]=images[a[2]];fs.writeFileSync(file,JSON.stringify(images));}
else if(a[0]==='build'){const r=a.find(x=>x.startsWith('RELEASE_RECIPE_SHA256=')).split('=')[1];images[a[a.indexOf('-t')+1]]={Id:'sha256:built',Config:{Labels:{'org.iot-lab.release-recipe':r}}};fs.writeFileSync(file,JSON.stringify(images));}
`, {mode: 0o755});
  writeFileSync(join(bin, 'curl'), `#!${process.execPath}
const fs=require('fs'),a=process.argv.slice(2),p=${JSON.stringify(root)};
fs.appendFileSync(p+'/curl.log',JSON.stringify(a)+'\\n');
if(process.env.CURL_FAIL){process.stderr.write('curl: (6) no host\\n');process.exit(6);}
process.stdout.write(process.env.CURL_BYTES??${JSON.stringify(BYTES)});
`, {mode: 0o755});
  const run = (args, env = {}) => spawnSync(process.execPath, [join(tools, 'build-release-image.mjs'), ...args], {cwd: root, encoding: 'utf8',
    env: {...process.env, PATH: bin + delimiter + process.env.PATH, ...env}});
  const docker = () => readFileSync(join(root, 'docker.log'), 'utf8').trim().split('\n').map(line => JSON.parse(line));
  const image = run_ => JSON.parse(readFileSync(join(root, run_, 'image.json'), 'utf8'));
  return {root, tools, run, docker, image};
}

test('the recipe is the same bytes as the Python tool: its inputs give the label of the live image', async () => {
  const {recipeOf} = await import(here('../build-release-image.mjs'));
  assert.equal(recipeOf({
    'release-native.Dockerfile': 'a198e09fcc33e540eca73163c1823c3efac87dd7f9065cb069b33ba92e8c0916',
    'requirements-gerbercheck.txt': 'e464169f63cd0dcf6b30b2d115648e9ee6691bf2c83bbd829412a49cf94d5601',
    'build-release-image.py': '883531097d7f9ae390ca06ce2de42f006d7017c1d215febbea099687f8763560',
  }), '1f96079f3767ab4457b6c343541bf3867c323b2e975107a5dd9bf6d598495522');
});

test('a new tag: tags the base alias, fetches the wheels, builds offline and records the evidence', t => {
  const f = fixture(t), r = f.run(['run']);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout, `START: pinned wheel ${WHEEL}\nPASS: original wheel ${WHEEL}\nPASS: Gerber-capable release image sha256:built; evidence=run\n`);
  const image = f.image('run'), file = join(f.root, 'run');
  assert.deepEqual(Object.keys(image), ['base', 'base_alias', 'recipe_sha256', 'inputs', 'tag', 'wheels', 'image_id', 'reused']);
  assert.deepEqual(Object.keys(image.inputs), ['release-native.Dockerfile', 'requirements-gerbercheck.txt', 'build-release-image.mjs']);
  assert.equal(image.tag, TAG);
  assert.equal(image.reused, false);
  assert.equal(image.inputs['build-release-image.mjs'], sha(readFileSync(join(f.tools, 'build-release-image.mjs'))));
  assert.deepEqual(image.wheels, [{file: WHEEL, url: `https://files.pythonhosted.org/packages/aa/bb/cc/${WHEEL}`, sha256: sha(BYTES)}]);
  assert.equal(readFileSync(join(file, 'wheels', WHEEL), 'utf8'), BYTES);
  assert.deepEqual(readdirSync(file).sort(), ['image.json', 'release-native.Dockerfile', 'requirements-gerbercheck.txt', 'wheels']);
  assert.deepEqual(f.docker(), [
    ['image', 'inspect', BASE], ['image', 'inspect', ALIAS], ['image', 'tag', BASE, ALIAS], ['image', 'inspect', TAG],
    ['build', '--network=none', '--pull=false', '--build-arg', 'NATIVE_BASE=' + ALIAS, '--build-arg', 'RELEASE_RECIPE_SHA256=' + image.recipe_sha256,
      '-f', 'run/release-native.Dockerfile', '-t', TAG, 'run'],
    ['image', 'inspect', TAG]]);
  const text = readFileSync(join(file, 'image.json'), 'utf8');
  assert.match(text, /^\{\n {2}"base": "sha256:/);
  assert.ok(text.endsWith('\n}\n'));
});

test('an image with the same recipe is reused; another recipe under the tag is refused', t => {
  const f = fixture(t);
  assert.equal(f.run(['first']).status, 0);
  const again = f.run(['second']);
  assert.equal(again.status, 0, again.stderr);
  assert.equal(again.stdout, 'PASS: Gerber-capable release image sha256:built; evidence=second\n');
  assert.equal(f.image('second').reused, true);
  assert.deepEqual(f.image('second').wheels, []);
  const other = fixture(t, {[BASE]: {Id: BASE}, [TAG]: {Id: 'sha256:old', Config: {Labels: {'org.iot-lab.release-recipe': 'x'}}}});
  const refused = other.run(['run']);
  assert.equal(refused.status, 1);
  assert.equal(refused.stderr, 'FAIL: release image: image tag exists with different inputs; choose a new --tag\n');
  const unlabelled = fixture(t, {[BASE]: {Id: BASE}, custom: {Id: 'sha256:x', Config: {}}});
  assert.match(unlabelled.run(['run', '--tag', 'custom']).stderr, /different inputs/);
});

test('the base must be the pinned image, and the alias may not point elsewhere', t => {
  const wrong = fixture(t, {[BASE]: {Id: 'sha256:other'}}), r = wrong.run(['run']);
  assert.equal(r.status, 1);
  assert.equal(r.stderr, 'FAIL: release image: native base image identity mismatch\n');
  const alias = fixture(t, {[BASE]: {Id: BASE}, [ALIAS]: {Id: 'sha256:other'}}), s = alias.run(['run']);
  assert.equal(s.status, 1);
  assert.equal(s.stderr, 'FAIL: release image: release-only base alias already points to another image\n');
  const kept = fixture(t, {[BASE]: {Id: BASE}, [ALIAS]: {Id: BASE}});
  assert.equal(kept.run(['run']).status, 0);
  assert.ok(!kept.docker().some(a => a[1] === 'tag'));
});

test('wheels: a wrong hash stops, the cache is used only when it matches, a failed download stops', t => {
  const f = fixture(t), r = f.run(['run'], {CURL_BYTES: 'tampered'});
  assert.equal(r.status, 1);
  assert.equal(r.stderr, `FAIL: release image: original wheel hash mismatch: ${WHEEL}\n`);
  assert.ok(!f.docker().some(a => a[0] === 'build'));
  const cached = fixture(t), cache = join(cached.root, 'cache');
  mkdirSync(cache); writeFileSync(join(cache, WHEEL), BYTES);
  assert.equal(cached.run(['run', '--wheel-cache', cache]).status, 0);
  assert.equal(existsSync(join(cached.root, 'curl.log')), false);
  const stale = fixture(t), other = join(stale.root, 'cache');
  mkdirSync(other); writeFileSync(join(other, WHEEL), 'stale');
  assert.match(stale.run(['run', '--wheel-cache', other]).stderr, /original wheel hash mismatch/);
  const offline = fixture(t), s = offline.run(['run'], {CURL_FAIL: '1'});
  assert.equal(s.status, 1);
  assert.equal(s.stderr, `FAIL: release image: ${WHEEL}: download failed (curl: (6) no host)\n`);
});

test('the run folder must be new, and a failed docker step fails like Python', t => {
  const f = fixture(t);
  mkdirSync(join(f.root, 'taken'));
  const r = f.run(['taken']);
  assert.equal(r.status, 1);
  assert.equal(r.stderr, "FAIL: release image: [Errno 17] File exists: 'taken'\n");
  assert.equal(existsSync(join(f.root, 'docker.log')), false);
  const b = fixture(t), s = b.run(['run'], {DOCKER_FAIL: 'build'});
  assert.equal(s.status, 1);
  assert.match(s.stderr, /^docker broke\nFAIL: release image: Command '\['docker', 'build', '--network=none', .*' returned non-zero exit status 3\.\n$/);
  const missing = spawnSync(process.execPath, [join(b.tools, 'build-release-image.mjs'), 'other'], {cwd: b.root, encoding: 'utf8', env: {...process.env, PATH: join(b.root, 'nothing')}});
  assert.equal(missing.status, 1);
  assert.equal(missing.stderr, "FAIL: release image: [Errno 2] No such file or directory: 'docker'\n");
});
