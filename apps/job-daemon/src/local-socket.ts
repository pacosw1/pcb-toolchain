import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';

function privateDirectory(directory: string, uid: number): void {
  try { fs.mkdirSync(directory, { mode: 0o700 }); } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
  }
  const stat = fs.lstatSync(directory);
  if (!stat.isDirectory() || stat.uid !== uid || (stat.mode & 0o777) !== 0o700) throw new Error('unsafe health socket directory');
}

/** Separate instances and processes; never remove an existing endpoint. */
export function prepareLocalSocket(root: string, instance: string, uid: number, pid: number): string {
  if (!instance || !Number.isSafeInteger(pid) || pid <= 0) throw new Error('invalid health socket instance or pid');
  privateDirectory(root, uid);
  const directory = path.join(root, instance === 'default' ? 'default' : `i-${createHash('sha256').update(instance).digest('hex').slice(0, 24)}`);
  privateDirectory(directory, uid);
  const socket = path.join(directory, `pid-${pid}.sock`);
  try {
    fs.lstatSync(socket);
    throw new Error('health socket already exists; investigate before removing it');
  } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  return socket;
}
