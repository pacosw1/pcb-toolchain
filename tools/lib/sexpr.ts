// KiCad s-expression reader for tools that only look at a file. Atoms stay strings; the reader knows no KiCad schema.
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
