// KiCad s-expression reader for tools that only look at a file. Atoms stay strings; the reader knows no KiCad schema.
import { splitlines } from './py-compat.mjs';

export type SExpr = string | SList;
export type SList = SExpr[];

const TOKEN = /\s*(?:(\()|(\))|"((?:[^"\\]|\\.)*)"|([^\s()"]+))/g;

export function parse(text: string): SList {
  const stack: SList[] = [];
  let current: SList = [];
  for (const [, open, close, quoted, bare] of text.matchAll(TOKEN)) {
    if (open) {
      stack.push(current);
      current = [];
    } else if (close) {
      const parent = stack.pop();
      if (!parent) throw new Error('s-expression: unbalanced )');
      parent.push(current);
      current = parent;
    } else if (quoted !== undefined) {
      current.push(quoted.replaceAll('\\"', '"'));
    } else if (bare) {
      current.push(bare);
    }
  }
  const root = current[0];
  if (!Array.isArray(root)) throw new Error('s-expression: no top-level list');
  return root;
}

/**
 * Every top-level form as the native tools read it: a quoted atom loses its quotes and keeps its escapes, a line that
 * starts with # is dropped, and an unclosed list ends the read. Hashes of native forms depend on this exact text.
 */
export function forms(text: string): SList {
  const kept = splitlines(text).filter(line => !line.trimStart().startsWith('#')).join('\n');
  const stack: SList[] = [[]];
  for (const [token] of kept.matchAll(/"(?:[^"\\]|\\[^\n])*"|\(|\)|[^\s()]+/g)) {
    if (token === '(') {
      stack.push([]);
    } else if (token === ')') {
      const closed = stack.pop() as SList;
      if (!stack.length) throw new Error('s-expression: unbalanced )');
      (stack.at(-1) as SList).push(closed);
    } else {
      (stack.at(-1) as SList).push(token.startsWith('"') ? token.slice(1, -1) : token);
    }
  }
  return stack[0] as SList;
}

/** The fields after the name of the one child `name`; two such children are ambiguous. */
export function field(form: SList, name: string): SList | undefined {
  const rows = form.filter((item): item is SList => Array.isArray(item) && item[0] === name);
  if (rows.length > 1) throw new Error('ambiguous native field: ' + name);
  return rows[0]?.slice(1);
}

/** The index just after the list that opens at text[start]. For tools that edit a file and keep every other byte. */
export function listEnd(text: string, start: number): number {
  let depth = 0;
  let quoted = false;
  for (let i = start; i < text.length; i++) {
    const c = text[i];
    if (quoted) quoted = c !== '"' || text[i - 1] === '\\';
    else if (c === '"') quoted = true;
    else if (c === '(') depth++;
    else if (c === ')' && --depth === 0) return i + 1;
  }
  throw new Error(`unbalanced s-expression at ${start}`);
}

/** The child lists of `node` that start with `name`. */
export const kids = (node: SList, name: string): SList[] =>
  node.slice(1).filter((child): child is SList => Array.isArray(child) && child[0] === name);

export const one = (node: SList, name: string): SList | undefined => kids(node, name)[0];

/** The atom at `index`; a list there, or nothing, is a malformed file. */
export function atom(node: SList, index: number): string {
  const value = node.at(index);
  if (typeof value !== 'string') throw new Error(`s-expression: no atom at ${index} of ${String(node[0])}`);
  return value;
}

export interface Pose { x: number; y: number; angle: number }

/** The (at x y [angle]) of `node`, or the origin. */
export function pose(node: SList): Pose {
  const at = one(node, 'at');
  if (!at) return { x: 0, y: 0, angle: 0 };
  return { x: Number(atom(at, 1)), y: Number(atom(at, 2)), angle: at.length > 3 ? Number(atom(at, 3)) : 0 };
}

export const layerOf = (node: SList): string | undefined => {
  const layer = one(node, 'layer');
  return layer ? atom(layer, 1) : undefined;
};
