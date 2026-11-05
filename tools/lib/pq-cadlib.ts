// KiCad s-expressions that can be written back: a bare atom stays bare and a quoted string stays quoted, which sexpr.ts
// does not keep. For edits to synthetic fixtures, not for reading boards.
import { jsonCanonical, PyError } from './py-compat.mjs';

export class Atom {
  readonly text: string;
  constructor(text: string) {
    this.text = text;
  }
}

export type CadNode = string | Atom | CadList;
export type CadList = CadNode[];

const TOKEN = /\(|\)|"(?:\\.|[^"\\])*"|[^\s()]+/g;
const textOf = (node: CadNode | undefined): string | undefined => (node instanceof Atom ? node.text : typeof node === 'string' ? node : undefined);

export function parse(text: string): CadList {
  const stack: CadList[] = [];
  let root: CadList | null = null;
  for (const [token] of text.matchAll(TOKEN)) {
    if (token === '(') {
      const node: CadList = [];
      const parent = stack.at(-1);
      if (parent) parent.push(node);
      else if (root !== null) throw new PyError('ValueError', 'Multiple root expressions');
      else root = node;
      stack.push(node);
    } else if (token === ')') {
      if (!stack.pop()) throw new PyError('ValueError', 'Unbalanced expression');
    } else {
      stack.at(-1)?.push(token.startsWith('"') ? JSON.parse(token) as string : new Atom(token));
    }
  }
  if (stack.length || root === null) throw new PyError('ValueError', 'Unbalanced expression');
  return root;
}

/** Lists on their own lines, indented two spaces per level; a list of atoms stays on one line. */
export function dump(node: CadNode, depth = 0): string {
  if (!Array.isArray(node)) return node instanceof Atom ? node.text : jsonCanonical(node, { ascii: false });
  const firstList = node.findIndex(Array.isArray);
  const lead = (firstList < 0 ? node : node.slice(0, firstList)).map(child => dump(child)).join(' ');
  if (firstList < 0) return `(${lead})`;
  const indent = `\n${'  '.repeat(depth + 1)}`;
  return `(${lead}${node.slice(firstList).map(child => indent + dump(child, depth + 1)).join('')})`;
}

export const items = (node: CadList, kind: string): CadList[] =>
  node.filter((child): child is CadList => Array.isArray(child) && textOf(child[0]) === kind);

export const item = (node: CadList, kind: string): CadList | undefined => items(node, kind)[0];

/** Every list called `kind` at any depth, parents before children. */
export function* walk(node: CadNode, kind: string): Generator<CadList> {
  if (!Array.isArray(node)) return;
  if (textOf(node[0]) === kind) yield node;
  for (const child of node) yield* walk(child, kind);
}
