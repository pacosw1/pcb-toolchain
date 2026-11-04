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

/** Production's root-owned default instance is pinned to /run. Other runs can select a private root. */
export function healthRoot(instance: string, uid: number, dataDir: string, configured?: string): string {
  if (configured && !path.isAbsolute(configured)) throw new Error('JOBD_HEALTH_ROOT must be absolute');
  if (uid === 0 && instance === 'default' && configured && configured !== '/run/pcb-job-daemon') throw new Error('production health root is fixed');
  const root = configured || (uid === 0 ? '/run/pcb-job-daemon' : path.resolve(dataDir, '.health'));
  let ancestor = fs.realpathSync(path.dirname(root));
  const resolved = path.join(ancestor, path.basename(root));
  for (;;) {
    const parent = fs.lstatSync(ancestor);
    const stickyRoot = parent.uid === 0 && (parent.mode & 0o1000) !== 0;
    if (!parent.isDirectory() || (parent.uid !== uid && parent.uid !== 0) || ((parent.mode & 0o022) !== 0 && !stickyRoot)) throw new Error('unsafe health socket parent');
    const next = path.dirname(ancestor);
    if (next === ancestor) break;
    ancestor = next;
  }
  return resolved;
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
