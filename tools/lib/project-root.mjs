// One resolver for the project (repository) root. The Python twin is tools/project_root.py. No side effects.
// Order: an explicit argument (for example --project) > env IOT_LAB > the nearest parent of the current
// directory that holds hardware-design/boards > the old file-relative root (the folder above tools/).
// Use it for project data; imports of sibling modules stay relative.
import {existsSync} from 'node:fs';
import {join, resolve, dirname} from 'node:path';
import {fileURLToPath} from 'node:url';

export const fileRoot = fileURLToPath(new URL('../..', import.meta.url)).replace(/\/$/, '');
export function findProjectRoot(start) {
  for (let dir = resolve(start); ; dir = dirname(dir)) {
    if (existsSync(join(dir, 'hardware-design', 'boards'))) return dir;
    if (dirname(dir) === dir) return null;
  }
}
export function projectRoot(explicit, env = process.env, cwd = process.cwd()) {
  if (explicit) return resolve(explicit);
  if (env.IOT_LAB) return resolve(env.IOT_LAB);
  return findProjectRoot(cwd) ?? fileRoot;
}
