// tools/check-fab-zip.mjs: the ZIP must hold exactly the staged bytes. Run: node --test tools/lib/check-fab-zip.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {deflateRawSync} from 'node:zlib';
import {crc32} from './zip-read.mjs';

const tool = new URL('../check-fab-zip.mjs', import.meta.url).pathname;
const run = (...args) => spawnSync(process.execPath, [tool, ...args], {encoding: 'utf8'});

function zipBytes(files, {method = 8} = {}) {
  const locals = [], central = [];
  let offset = 0;
  for (const [name, text] of files) {
    const data = Buffer.from(text), packed = method === 8 ? deflateRawSync(data) : data, path = Buffer.from(name);
    const local = Buffer.alloc(30);
    local.write('PK\x03\x04', 0, 'latin1'); local.writeUInt16LE(20, 4); local.writeUInt16LE(method, 8);
    local.writeUInt32LE(crc32(data), 14); local.writeUInt32LE(packed.length, 18); local.writeUInt32LE(data.length, 22); local.writeUInt16LE(path.length, 26);
    const head = Buffer.alloc(46);
    head.write('PK\x01\x02', 0, 'latin1'); head.writeUInt16LE(20, 4); head.writeUInt16LE(20, 6); head.writeUInt16LE(method, 10);
    head.writeUInt32LE(crc32(data), 16); head.writeUInt32LE(packed.length, 20); head.writeUInt32LE(data.length, 24); head.writeUInt16LE(path.length, 28); head.writeUInt32LE(offset, 42);
    locals.push(local, path, packed); central.push(head, path);
    offset += 30 + path.length + packed.length;
  }
  const directory = Buffer.concat(central), end = Buffer.alloc(22);
  end.write('PK\x05\x06', 0, 'latin1'); end.writeUInt16LE(files.length, 8); end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(directory.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, directory, end]);
}
function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'fab-zip-'));
  t.after(() => rmSync(root, {recursive: true, force: true}));
  const dir = join(root, 'gerber'), zip = join(root, 'fab.zip');
  mkdirSync(join(dir, 'sub'), {recursive: true});
  writeFileSync(join(dir, 'board.gbr'), 'original');
  writeFileSync(join(dir, 'sub/board.drl'), 'drill');
  return {root, dir, zip, files: [['board.gbr', 'original'], ['sub/board.drl', 'drill']]};
}
const failure = (result, text) => {
  assert.equal(result.status, 1);
  assert.equal(result.stdout, '');
  assert.equal(result.stderr, `FAIL: fabrication ZIP: ${text}\n`);
};

for (const method of [0, 8]) {
  test(`identical bytes pass and print the same JSON as json.dumps (method ${method})`, t => {
    const f = fixture(t);
    writeFileSync(f.zip, zipBytes(f.files, {method}));
    const result = run(f.zip, f.dir), sha256 = createHash('sha256').update(readFileSync(f.zip)).digest('hex');
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, `{"status": "passed", "files": 2, "sha256": "${sha256}"}\n`);
  });
}
test('a changed, missing or extra file fails', t => {
  const f = fixture(t), text = 'fabrication ZIP differs from staged Gerbers/drill files';
  writeFileSync(f.zip, zipBytes(f.files));
  writeFileSync(join(f.dir, 'board.gbr'), 'changed');
  failure(run(f.zip, f.dir), text);
  writeFileSync(join(f.dir, 'board.gbr'), 'original');
  writeFileSync(join(f.dir, '.hidden'), 'x');
  failure(run(f.zip, f.dir), text);
  rmSync(join(f.dir, '.hidden'));
  writeFileSync(f.zip, zipBytes(f.files.slice(1)));
  failure(run(f.zip, f.dir), text);
});
test('an unsafe or repeated name fails', t => {
  const f = fixture(t);
  for (const name of ['../board.gbr', './board.gbr', '/board.gbr', 'a//b']) {
    writeFileSync(f.zip, zipBytes([...f.files, [name, 'x']]));
    failure(run(f.zip, f.dir), 'duplicate/unsafe fabrication ZIP entry');
  }
  writeFileSync(f.zip, zipBytes([...f.files, ['board.gbr', 'original']]));
  failure(run(f.zip, f.dir), 'duplicate/unsafe fabrication ZIP entry');
});
test('a CRC failure, a symlink and a bad archive fail', t => {
  const f = fixture(t), good = zipBytes(f.files, {method: 0}), bad = Buffer.from(good);
  bad[bad.indexOf('original') + 1] ^= 1;
  writeFileSync(f.zip, bad);
  failure(run(f.zip, f.dir), 'fabrication ZIP CRC failure');
  writeFileSync(f.zip, 'not a zip');
  failure(run(f.zip, f.dir), 'File is not a zip file');
  rmSync(f.zip);
  failure(run(f.zip, f.dir), `[Errno 2] No such file or directory: '${f.zip}'`);
  failure(run(f.dir, f.dir), `[Errno 21] Is a directory: '${f.dir}'`);
  symlinkSync('board.gbr', join(f.dir, 'link.gbr'));
  writeFileSync(f.zip, good);
  failure(run(f.zip, f.dir), 'staged fabrication symlink');
});
test('missing arguments give the old messages', () => {
  failure(run(), "verify() missing 2 required positional arguments: 'archive' and 'directory'");
  failure(run('x'), "verify() missing 1 required positional argument: 'directory'");
});
