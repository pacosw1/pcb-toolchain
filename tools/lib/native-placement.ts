// Verify that moved footprints kept their definition and everything else on the board.
import { Decimal, positiveDegrees } from './decimal.ts';
import { fingerprint } from './fingerprint.ts';
import { footprints, footprintSignature, rotate, type Footprint } from './native-board.ts';
import { compare } from './py-compat.mjs';
import { roundWhole } from './py-numbers.ts';
import { textOf } from './py-path.ts';
import { field, forms, type SList } from './sexpr.ts';

export interface PlacementUnit {
  refs: string[];
  x: number;
  y: number;
  fixed: boolean;
  borders?: unknown[];
  cuts?: unknown[];
  zones?: unknown[];
}

export interface PlacementProblem { units: PlacementUnit[] }

/** A proposed pose of a unit: x, y and quarter turns. */
export type UnitPose = [number, number, number];

const OWNED_GEOMETRY = ['borders', 'cuts', 'zones'] as const;
const NOT_PROTECTED = ['generator', 'generator_version'];

const toNanometres = (mm: number): number => roundWhole(mm * 1e6);
const exactNanometres = (mm: Decimal): number => toNanometres(Number(mm.toString()));

export function locked(form: SList): boolean {
  const value = field(form, 'locked');
  return form.includes('locked') || (value !== undefined && !(value.length === 1 && value[0] === 'no'));
}

function byReference(path: string): Map<string, Footprint> {
  const rows = footprints(path);
  const indexed = new Map(rows.map(row => [row.props.get('Reference') as string, row]));
  if (indexed.size !== rows.length || [...indexed.keys()].some(reference => !reference)) throw new Error('ambiguous native footprint reference');
  return indexed;
}

function checkMembership(before: Map<string, Footprint>, after: Map<string, Footprint>, refs: string[]): void {
  const sameNames = (a: Iterable<string>, b: Map<string, Footprint>) => {
    const names = new Set(a);
    return names.size === b.size && [...names].every(name => b.has(name));
  };
  if (refs.length !== new Set(refs).size || !sameNames(refs, before) || !sameNames(before.keys(), after)) {
    throw new Error('native/model footprint membership changed');
  }
}

function checkRigidMove(unit: PlacementUnit, destination: UnitPose, before: Map<string, Footprint>, after: Map<string, Footprint>): string[] {
  if (unit.fixed) throw new Error('fixed unit moved');
  if (OWNED_GEOMETRY.some(name => unit[name]?.length)) throw new Error('owned drawings/cuts/zones need an explicit geometry transform contract');
  const centreX = toNanometres(unit.x), centreY = toNanometres(unit.y);
  const moveX = toNanometres(destination[0] - unit.x), moveY = toNanometres(destination[1] - unit.y);
  const quarters = Math.trunc(destination[2]);
  if (!moveX && !moveY && !quarters) throw new Error('proposed move collapses at native coordinate precision');
  for (const reference of unit.refs) {
    const source = before.get(reference) as Footprint, target = after.get(reference) as Footprint;
    if (locked(source.form)) throw new Error('locked native footprint moved');
    const [x, y] = rotate(exactNanometres(source.pose[0]) - centreX, exactNanometres(source.pose[1]) - centreY, quarters, value => -value);
    const turned = target.pose[2].sub(source.pose[2]).sub(Decimal.of(String(90 * quarters)));
    if (exactNanometres(target.pose[0]) !== x + centreX + moveX || exactNanometres(target.pose[1]) !== y + centreY + moveY || !positiveDegrees(turned).isZero) {
      throw new Error(`native pose does not match proposed rigid transform: ${reference}`);
    }
    if (footprintSignature(source) !== footprintSignature(target)) throw new Error(`native footprint definition changed: ${reference}`);
  }
  return unit.refs;
}

/** The hash of every form of the board except writer identity and the moved footprints. */
function protectedForms(path: string, moved: string[]): string {
  const root = forms(textOf(path))[0] as SList;
  const hashes: string[] = [];
  for (const form of root.slice(1) as SList[]) {
    if (NOT_PROTECTED.includes(form[0] as string)) continue;
    if (form[0] === 'footprint') {
      const reference = form.find(item => Array.isArray(item) && item[0] === 'property' && item[1] === 'Reference') as SList | undefined;
      if (reference && moved.includes(reference[2] as string)) continue;
    }
    hashes.push(fingerprint(form));
  }
  return fingerprint(hashes.sort(compare));
}

/** Independently verify exact rigid poses and every unchanged native form. Returns the moved references and the protected hash. */
export function verifyPreserved(source: string, target: string, problem: PlacementProblem, pose: UnitPose[]): [string[], string] {
  const before = byReference(source), after = byReference(target);
  checkMembership(before, after, problem.units.flatMap(unit => unit.refs));
  const changed: string[] = [];
  problem.units.slice(0, pose.length).forEach((unit, index) => {
    const destination = pose[index] as UnitPose;
    if (destination[0] === unit.x && destination[1] === unit.y && destination[2] === 0) return;
    changed.push(...checkRigidMove(unit, destination, before, after));
  });
  if (!changed.length) throw new Error('proposal has no placement change');
  const original = protectedForms(source, changed);
  if (original !== protectedForms(target, changed)) throw new Error('unrelated native forms or retained copper changed');
  return [changed.sort(compare), original];
}
