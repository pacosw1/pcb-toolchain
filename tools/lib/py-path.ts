// pathlib where Node differs: evidence holds these paths, and Python tools read the same files.
//   joinPath keeps '..' (Node's join collapses it, which changes a recorded path).
//   resolvePath is Path.resolve(): non-strict, follows symlinks, and a '..' after a symlink is physical.
//   textOf is Path.read_text(): universal newlines. Node's readFileSync keeps \r\n.
import { readlinkSync, statSync } from 'node:fs';
import { basename, dirname } from 'node:path';
import { jsonLoads, osError, PyError, readText, typeName } from './py-compat.mjs';

const MAX_LINKS = 40;
const ABSENT = new Set(['ENOENT', 'ENOTDIR', 'ELOOP', 'EBADF']);
const OS_ERRORS = new Set(['OSError', 'FileNotFoundError', 'FileExistsError', 'PermissionError', 'NotADirectoryError', 'IsADirectoryError']);
const VALUE_ERRORS = new Set(['ValueError', 'json.decoder.JSONDecodeError', 'UnicodeDecodeError']);

const normalize = (path: string): string => {
  const segments = path.split('/').filter(part => part && part !== '.');
  return (path.startsWith('/') ? '/' : '') + segments.join('/') || '.';
};

export function joinPath(base: string, ...parts: unknown[]): string {
  let path = base;
  for (const part of parts) {
    if (typeof part !== 'string') throw new PyError('TypeError', `unsupported operand type(s) for /: 'PosixPath' and '${typeName(part)}'`);
    path = part.startsWith('/') ? part : `${path}/${part}`;
  }
  return normalize(path);
}

export function resolvePath(path: string): string {
  const pending = joinPath(process.cwd(), path).split('/').filter(Boolean).reverse();
  let current = '/';
  for (let links = 0; pending.length;) {
    const part = pending.pop()!;
    if (part === '.') continue;
    if (part === '..') { current = dirname(current); continue; }
    const next = joinPath(current, part);
    const target = links < MAX_LINKS ? linkTarget(next) : null;
    if (target === null) { current = next; continue; }
    links += 1;
    if (target.startsWith('/')) current = '/';
    pending.push(...target.split('/').filter(Boolean).reverse());
  }
  return current;
}

function linkTarget(path: string): string | null {
  try {
    return readlinkSync(path);
  } catch {
    return null;   // not a link, or nothing there: non-strict keeps the name
  }
}

export const isRelativeTo = (path: string, root: string): boolean =>
  path === root || path.startsWith(root === '/' ? '/' : `${root}/`);

/** `root in Path(path).parents`: the root itself does not count. */
export const isInside = (path: string, root: string): boolean => path !== root && isRelativeTo(path, root);

export function relativeTo(path: string, root: string): string {
  if (!isRelativeTo(path, root)) throw new PyError('ValueError', `'${path}' is not in the subpath of '${root}'`);
  return path === root ? '.' : path.slice(root === '/' ? 1 : root.length + 1);
}

export function withSuffix(path: string, suffix: string): string {
  const name = basename(path);
  const dot = name.lastIndexOf('.');
  const stem = dot > 0 && dot < name.length - 1 ? name.slice(0, dot) : name;
  return joinPath(dirname(path), stem + suffix);
}

const stat = (path: string) => {
  try {
    return statSync(path);
  } catch (error) {
    if (ABSENT.has((error as NodeJS.ErrnoException).code ?? '')) return null;
    throw osError(error, path);
  }
};
export const pathExists = (path: string): boolean => stat(path) !== null;
export const isFile = (path: string): boolean => stat(path)?.isFile() ?? false;
export const isDirectory = (path: string): boolean => stat(path)?.isDirectory() ?? false;

export const textOf = (path: string): string => readText(path).replace(/\r\n?/g, '\n');
export const jsonOf = (path: string): unknown => jsonLoads(textOf(path));

/** `except (OSError, ValueError, ...)`: families are OSError, ValueError or an exact Python type. */
export function caught(error: unknown, ...families: string[]): boolean {
  if (!(error instanceof PyError)) return families.includes('OSError') && typeof (error as NodeJS.ErrnoException)?.code === 'string';
  const type = (error as PyError & { type: string }).type;
  return families.some(family => family === type || (family === 'OSError' && OS_ERRORS.has(type)) || (family === 'ValueError' && VALUE_ERRORS.has(type)));
}
