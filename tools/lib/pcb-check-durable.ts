// Terminal supervisor evidence is written whole and synced before it is used.
import { randomBytes } from 'node:crypto';
import { closeSync, fsyncSync, openSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { jsonDumps } from './py-compat.mjs';

export function durableJson(path: string, value: unknown): void {
  const parent = dirname(path), temporary = join(parent, `.tmp-${randomBytes(8).toString('hex')}`);
  let fd = -1;
  try {
    fd = openSync(temporary, 'wx', 0o600);
    writeFileSync(fd, jsonDumps(value, 2) + '\n');
    fsyncSync(fd); closeSync(fd); fd = -1;
    renameSync(temporary, path);
    const directory = openSync(parent, 'r');
    try { fsyncSync(directory); } finally { closeSync(directory); }
  } finally {
    if (fd >= 0) closeSync(fd);
    rmSync(temporary, { force: true });
  }
}

export function durableAppend(path: string, line: string): void {
  const fd = openSync(path, 'a');
  try { writeFileSync(fd, line); fsyncSync(fd); } finally { closeSync(fd); }
}
