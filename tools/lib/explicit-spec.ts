// Pure admission of explicit placement/routing JSON. Types alone do not validate an agent's input.
import type { GridSpec, PlaceSpec, RouteSpec } from './route-spec.ts';

export interface MoveVia { net: string; from: [number, number]; to: [number, number] }
export interface RouteFile { clear?: string[]; routes: RouteSpec[]; move_vias?: MoveVia[]; via?: { size: number; drill: number } }

function object(value: unknown, fields: string[] | null, path: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${path}: expected an object`);
  const row = value as Record<string, unknown>;
  const unknown = fields && Object.keys(row).filter(key => !fields.includes(key));
  if (unknown && unknown.length) throw new Error(`${path}: unknown fields: ${unknown.join(', ')}`);
  return row;
}
function list(value: unknown, path: string): unknown[] {
  if (!Array.isArray(value)) throw new Error(`${path}: expected an array`);
  return value;
}
function number(value: unknown, path: string, positive = false): void {
  if (typeof value !== 'number' || !Number.isFinite(value) || (positive && value <= 0)) throw new Error(`${path}: expected a ${positive ? 'positive ' : ''}finite number`);
}
function name(value: unknown, path: string): void {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${path}: expected a nonempty name`);
}
function tuple(value: unknown, size: number, path: string): void {
  const values = list(value, path);
  if (values.length !== size) throw new Error(`${path}: expected ${size} numbers`);
  values.forEach((n, i) => number(n, `${path}[${i}]`));
}
function names(value: unknown, path: string): void {
  list(value, path).forEach((n, i) => name(n, `${path}[${i}]`));
}
export function validateGrid(value: unknown, path = 'grid'): asserts value is GridSpec {
  const row = object(value, ['refs', 'origin', 'pitch', 'cols', 'rot'], path);
  names(row.refs, `${path}.refs`); tuple(row.origin, 2, `${path}.origin`); tuple(row.pitch, 2, `${path}.pitch`);
  if ('cols' in row) {
    number(row.cols, `${path}.cols`, true);
    if (!Number.isInteger(row.cols)) throw new Error(`${path}.cols: expected a positive integer`);
  }
  if ('rot' in row) number(row.rot, `${path}.rot`);
}
export function validatePlaceSpec(value: unknown): asserts value is PlaceSpec {
  const row = object(value, ['place', 'grids'], 'place spec');
  if ('place' in row) for (const [ref, pose] of Object.entries(object(row.place, null, 'place'))) {
    name(ref, 'place reference'); tuple(pose, 3, `place.${ref}`);
  }
  if ('grids' in row) list(row.grids, 'grids').forEach((grid, i) => validateGrid(grid, `grids[${i}]`));
}
export function validateRouteSpec(value: unknown, path = 'route'): asserts value is RouteSpec {
  const row = object(value, ['net', 'width', 'layer', 'path', 'any_angle', 'via_size', 'via_drill'], path);
  name(row.net, `${path}.net`); name(row.layer, `${path}.layer`); number(row.width, `${path}.width`, true);
  for (const key of ['via_size', 'via_drill']) if (key in row) number(row[key], `${path}.${key}`, true);
  if ('any_angle' in row && typeof row.any_angle !== 'boolean') throw new Error(`${path}.any_angle: expected a boolean`);
  list(row.path, `${path}.path`).forEach((point, i) => {
    const at = `${path}.path[${i}]`;
    if (Array.isArray(point)) tuple(point, 2, at);
    else {
      const via = object(point, ['via', 'to'], at);
      tuple(via.via, 2, `${at}.via`);
      if ('to' in via) name(via.to, `${at}.to`);
    }
  });
}
export function validateRouteFile(value: unknown): asserts value is RouteFile {
  const row = object(value, ['clear', 'routes', 'move_vias', 'via'], 'route spec');
  list(row.routes, 'routes').forEach((route, i) => validateRouteSpec(route, `routes[${i}]`));
  if ('clear' in row) names(row.clear, 'clear');
  if ('move_vias' in row) list(row.move_vias, 'move_vias').forEach((move, i) => {
    const path = `move_vias[${i}]`, item = object(move, ['net', 'from', 'to'], path);
    name(item.net, `${path}.net`); tuple(item.from, 2, `${path}.from`); tuple(item.to, 2, `${path}.to`);
  });
  if ('via' in row) {
    const via = object(row.via, ['size', 'drill'], 'via');
    number(via.size, 'via.size', true); number(via.drill, 'via.drill', true);
  }
}

/** Called at supervisor admission and again in the owned child, before design/native probes. */
export function validateExplicitSpec(operation: string, kind: string | undefined, router: string | undefined, spec: unknown): void {
  if (operation === 'edit' && kind === 'place') validatePlaceSpec(spec);
  else if ((operation === 'edit' && kind === 'route') || (operation === 'route' && (router ?? 'explicit') === 'explicit')) validateRouteFile(spec);
}
