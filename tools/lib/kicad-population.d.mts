// Types of the parts of kicad-population.mjs that TypeScript tools use. Add a line when a tool needs another export.
export type Tree = (string | Tree)[];
export function sha256(bytes: Uint8Array | string): string;
export function parseNative(text: string): Tree;
export function children(node: Tree, name: string): Tree[];
/** The one child list called `name`, undefined when absent; a second one is an error. */
export function single(node: Tree, name: string): Tree | undefined;

export interface NativeSymbol {
  reference: string;
  lcsc: string;
  mpn: string;
  footprint: string;
  power_symbol: boolean;
  in_bom: boolean;
  on_board: boolean;
  dnp: boolean;
}

export interface NativeFootprint {
  reference: string;
  footprint: string;
  path?: string;
  lcsc: string;
  mpn: string;
  dnp: boolean;
  excluded: boolean;
  board_only: boolean;
}

export interface Population {
  symbols: Map<string, NativeSymbol>;
  footprints: Map<string, NativeFootprint>;
  /** Repository-relative file: SHA-256, in reading order. */
  sources: Record<string, string>;
}

export function readPopulation(root: string, project: string): Population;
