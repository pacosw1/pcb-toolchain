#!/usr/bin/env node
// Verify the exact files netchecked in a ZIP equal the staged fabrication set.
//   node tools/check-fab-zip.mjs ZIP DIRECTORY
// Prints {"status": "passed", "files": N, "sha256": "..."}; on a failure a FAIL line on stderr and exit 1.
import {createHash} from 'node:crypto';
import {lstatSync, readFileSync, readdirSync} from 'node:fs';
import {join} from 'node:path';
import {eprint, jsonDumps, osError, print} from './lib/py-compat.mjs';
import {openZip, readEntry, testZip} from './lib/zip-read.mjs';

const sha256 = data => createHash('sha256').update(data).digest('hex');
const read = path => { try { return readFileSync(path); } catch (error) { throw osError(error, path); } };

// Path.rglob('*'): every entry, hidden ones too; a missing or unreadable folder is simply empty.
function staged(directory, prefix, found) {
  let names;
  try { names = readdirSync(directory); } catch { return found; }
  for (const name of names) {
    const path = join(directory, name), info = lstatSync(path);
    if (info.isSymbolicLink()) throw new Error('staged fabrication symlink');
    if (info.isDirectory()) staged(path, prefix + name + '/', found);
    else if (info.isFile()) found.set(prefix + name, sha256(read(path)));
  }
  return found;
}

export function verify(archive, directory) {
  const expected = staged(directory || '.', '', new Map());
  const bytes = read(archive), zip = openZip(bytes);
  if (testZip(zip) !== null) throw new Error('fabrication ZIP CRC failure');
  const actual = new Map();
  for (const entry of zip.entries) {
    const name = entry.filename;
    if (!name) throw new Error('string index out of range');
    if (name.endsWith('/')) continue;
    if (actual.has(name) || name.startsWith('/') || name.split('/').some(part => ['', '.', '..'].includes(part))) {
      throw new Error('duplicate/unsafe fabrication ZIP entry');
    }
    actual.set(name, sha256(readEntry(zip, entry)));
  }
  const same = actual.size === expected.size && [...expected].every(([name, hash]) => actual.get(name) === hash);
  if (!expected.size || !same) throw new Error('fabrication ZIP differs from staged Gerbers/drill files');
  return {status: 'passed', files: actual.size, sha256: sha256(bytes)};
}

const [archive, directory] = process.argv.slice(2);
try {
  if (archive === undefined) throw new Error("verify() missing 2 required positional arguments: 'archive' and 'directory'");
  if (directory === undefined) throw new Error("verify() missing 1 required positional argument: 'directory'");
  print(jsonDumps(verify(archive, directory)));
} catch (error) {
  eprint('FAIL: fabrication ZIP: ' + error.message);
  process.exitCode = 1;
}
