// What a candidate may not change: part, pad, net, outline and rule identity. Placement and copper may change. Filled zone
// caches and generator metadata do not define the source contract; unknown native forms stay protected.
import { Decimal } from './decimal.ts';
import { footprints, footprintSignature, type Footprint } from './native-board.ts';
import { compare, jsonCanonical, PyError } from './py-compat.mjs';
import { textOf } from './py-path.ts';
import { field, forms, type SExpr, type SList } from './sexpr.ts';

const GEOMETRY = new Set(['at', 'start', 'end', 'mid', 'xy', 'xyz', 'size', 'offset', 'width', 'thickness', 'clearance', 'drill', 'diameter']);
const UNPROTECTED = new Set(['version', 'generator', 'generator_version', 'segment', 'arc', 'via']);
const ZONE_CACHE = new Set(['filled_polygon', 'fill_segments']);

export interface Pour { name: string; net: string; layer: string }
export type PourSet = ReadonlySet<string>;
interface RouteManifest { operation?: string; router?: string; spec?: { pours?: Pour[] } }
export interface BoardIdentity { footprints: Record<string, unknown>; protected: unknown[] }

const pourKey = (name: unknown, net: unknown, layer: unknown): string => JSON.stringify([name ?? null, net ?? null, layer ?? null]);

/** The pours an admitted route.json lets `iotroute route` create or replace: they are left out on both sides of a comparison. */
export function declaredPours(manifest: RouteManifest): PourSet {
  if (manifest.operation !== 'route' || manifest.router !== 'route-json') return new Set();
  return new Set((manifest.spec?.pours ?? []).map(pour => pourKey(pour.name, pour.net, pour.layer)));
}

function normalized(text: string): string {
  try {
    return Decimal.parse(text)?.normalize().toString() ?? text;
  } catch {
    return text;   // not a number: the form keeps its text
  }
}

function clean(value: SExpr): SExpr {
  if (!Array.isArray(value)) return value;
  if (value.length && GEOMETRY.has(value[0] as string)) {
    return [value[0]!, ...value.slice(1).map(item => (typeof item === 'string' ? normalized(item) : clean(item)))];
  }
  return value.map(clean);
}

const locked = (form: SList): boolean => form.includes('locked') || jsonCanonical(field(form, 'locked') ?? ['no']) !== jsonCanonical(['no']);

function footprintIdentity(part: Footprint): unknown {
  const signature = footprintSignature(part);
  return locked(part.form) ? { signature, locked_pose: part.pose.map(value => value.normalize().toString()) } : signature;
}

function zoneFields(form: SList): Map<string, string> {
  const rows = form.filter((item): item is [string, string] => Array.isArray(item) && item.length === 2 && typeof item[1] === 'string');
  return new Map(rows);
}

/** KiCad can reorder independent rule areas, even with equal UUIDs: only their order among keepout slots is immaterial. */
function sortKeepouts(protectedForms: SExpr[], slots: number[]): void {
  const areas = slots.map(slot => protectedForms[slot]!).sort((a, b) => compare(jsonCanonical(a), jsonCanonical(b)));
  slots.forEach((slot, index) => { protectedForms[slot] = areas[index]!; });
}

export function pcbIdentity(path: string, pours: PourSet = new Set()): BoardIdentity {
  const roots = forms(textOf(path));
  const top = roots[0];
  if (roots.length !== 1 || !Array.isArray(top) || top[0] !== 'kicad_pcb') throw new PyError('ValueError', 'invalid native PCB root');
  const parts = new Map(footprints(path).map(part => [part.props.get('Reference'), part]));
  const identity: Record<string, unknown> = {};
  const protectedForms: SExpr[] = [];
  const keepouts: number[] = [];
  for (const form of top.slice(1)) {
    if (!Array.isArray(form) || !form.length) throw new PyError('ValueError', 'malformed native PCB form');
    const tag = form[0] as string;
    if (UNPROTECTED.has(tag)) continue;
    if (tag === 'footprint') {
      const property = form.find(item => Array.isArray(item) && item.length > 2 && item[0] === 'property' && item[1] === 'Reference') as SList | undefined;
      const reference = property?.[2] as string | undefined;
      if (!reference || reference in identity) throw new PyError('ValueError', 'footprints need unique references');
      identity[reference] = footprintIdentity(parts.get(reference)!);
    } else if (tag === 'zone') {
      const fields = zoneFields(form);
      if (pours.has(pourKey(fields.get('name'), fields.get('net'), fields.get('layer')))) continue;
      if (form.some(item => Array.isArray(item) && item[0] === 'keepout')) keepouts.push(protectedForms.length);
      protectedForms.push(clean(form.filter(item => !(Array.isArray(item) && ZONE_CACHE.has(item[0] as string)))));
    } else {
      protectedForms.push(clean(form));
    }
  }
  sortKeepouts(protectedForms, keepouts);
  return { footprints: identity, protected: protectedForms };
}
