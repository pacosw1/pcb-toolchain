// What the design tools read from a native .kicad_pcb: footprints with exact poses, and the four files of a project.
import { basename } from 'node:path';
import { Decimal, positiveDegrees } from './decimal.ts';
import { fingerprint } from './fingerprint.ts';
import { sha256File } from './json-file.ts';
import { compare } from './py-compat.mjs';
import { isFile, textOf, withSuffix } from './py-path.ts';
import { field, forms, type SExpr, type SList } from './sexpr.ts';

export interface Footprint {
  form: SList;
  props: Map<string, string>;
  /** x, y, angle. */
  pose: [Decimal, Decimal, Decimal];
  path: string;
}

const PROJECT_EXTENSIONS = ['.kicad_pcb', '.kicad_pro', '.kicad_dru', '.kicad_sch'];

/** File name to sha256 of the four native project files; a missing one is an error. */
export function sourceSet(board: string): Map<string, string> {
  const files = PROJECT_EXTENSIONS.map(extension => withSuffix(board, extension));
  if (!files.every(isFile)) throw new Error('complete native project sidecars required');
  return new Map(files.map(path => [basename(path), sha256File(path)]));
}

function exactPose(at: SList | undefined): Footprint['pose'] {
  if (!at || (at.length !== 2 && at.length !== 3)) throw new Error('missing footprint pose');
  const values = [...at, ...(at.length === 2 ? ['0'] : [])].map(atom => Decimal.parse(atom as string));
  if (values.some(value => value === null)) throw new Error('nonfinite footprint pose');
  return values as Footprint['pose'];
}

function properties(form: SList): Map<string, string> {
  const rows = form.filter((item): item is SList => Array.isArray(item) && item[0] === 'property');
  const props = new Map(rows.map(row => [row[1] as string, row[2] as string]));
  if (props.size !== rows.length) throw new Error('duplicate footprint property');
  return props;
}

export function footprints(path: string): Footprint[] {
  const roots = forms(textOf(path));
  const root = roots[0];
  if (roots.length !== 1 || !Array.isArray(root) || root[0] !== 'kicad_pcb') throw new Error('expected native PCB');
  return root.slice(1).filter((item): item is SList => Array.isArray(item) && item[0] === 'footprint').map(form => ({
    form, props: properties(form), pose: exactPose(field(form, 'at')),
    path: ((field(form, 'path') ?? [''])[0] as string).replace(/\/+$/, ''),
  }));
}

/** The sheet instance of a footprint path, and the symbol inside it. */
export const instanceOf = (path: string): string => path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : path;
export const symbolOf = (path: string): string => path.slice(path.lastIndexOf('/') + 1);

/** KiCad positive rotation is counterclockwise with Y pointing down. */
export function rotate<T>(x: T, y: T, quarters: number, negate: (value: T) => T): [T, T] {
  const turns: [T, T][] = [[x, y], [y, negate(x)], [negate(x), negate(y)], [negate(y), x]];
  return turns[quarters] as [T, T];
}

const canonical = (value: Decimal): string => value.isZero ? '0' : value.normalize().toString();

/** A local (at x y [angle]) with its world angle made relative to the parent footprint. */
function localAt(at: SList, parentAngle: Decimal): SList {
  if (at.length !== 3 && at.length !== 4) throw new Error('unsupported local pose');
  const degrees = (at.length === 4 ? Decimal.of(at[3] as string) : Decimal.of('0')).sub(parentAngle);
  return ['at', canonical(Decimal.of(at[1] as string)), canonical(Decimal.of(at[2] as string)), canonical(positiveDegrees(degrees))];
}

const isLocalItem = (item: SExpr): item is SList => Array.isArray(item) && ['pad', 'property', 'fp_text'].includes(item[0] as string);

/**
 * The footprint definition apart from a rigid pose. KiCad sorts independent footprint items differently after a
 * rotation, so each whole item is hashed and only the order of these sibling forms is ignored; multiplicity stays.
 */
export function footprintSignature(footprint: Footprint): string {
  const angle = footprint.pose[2];
  const kept = footprint.form.filter(item => !(Array.isArray(item) && item[0] === 'at')).map(item =>
    isLocalItem(item) ? item.map(part => Array.isArray(part) && part[0] === 'at' ? localAt(part, angle) : part) : item);
  return fingerprint({ header: kept.slice(0, 2), fields: kept.slice(2).map(fingerprint).sort(compare) });
}
