import fs from 'node:fs';
import path from 'node:path';

/** The containing directory is private to the daemon user; never remove a pre-existing socket. */
export function prepareLocalSocket(directory: string, uid: number): string {
  try { fs.mkdirSync(directory, { mode: 0o700 }); } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
  }
  const stat = fs.lstatSync(directory);
  if (!stat.isDirectory() || stat.uid !== uid || (stat.mode & 0o777) !== 0o700) throw new Error('unsafe health socket directory');
  const socket = path.join(directory, 'status.sock');
  try { fs.lstatSync(socket); throw new Error('health socket already exists; investigate before removing it'); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  return socket;
}
