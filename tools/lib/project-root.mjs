// One resolver for the project (repository) root. No side effects.
// Order: an explicit argument (for example --project) > env IOT_LAB > the nearest parent of the current
// directory that holds hardware-design/boards > the old file-relative root (the folder above tools/).
// Use it for project data; imports of sibling modules stay relative.
import {realpathSync, statSync} from 'node:fs';
import {join, resolve, dirname} from 'node:path';
import {fileURLToPath} from 'node:url';

export const fileRoot = fileURLToPath(new URL('../..', import.meta.url)).replace(/\/$/, '');
const isDirectory = (p) => statSync(p, {throwIfNoEntry: false})?.isDirectory() ?? false;
export function findProjectRoot(start) {
  for (let dir = real(resolve(start)); ; dir = dirname(dir)) {   // real: a linked start climbs its real parents
    if (isDirectory(join(dir, 'hardware-design', 'boards'))) return dir;
    if (dirname(dir) === dir) return null;
  }
}
// The real path, like the old file-relative root (import.meta.url is a real path), so that relative()
// against real input paths never climbs out through a symlink such as /var -> /private/var.
const real = (p) => { try { return realpathSync(p); } catch { return p; } };
export function projectRoot(explicit, env = process.env, cwd = process.cwd()) {
  if (explicit) return real(resolve(explicit));
  if (env.IOT_LAB) return real(resolve(env.IOT_LAB));
  return real(findProjectRoot(cwd) ?? fileRoot);
}
