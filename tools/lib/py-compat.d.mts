// Types of the parts of py-compat.mjs that TypeScript tools use. Add a line when a tool needs another export.
export class PyError extends Error { constructor(type: string, message: string); type: string; }
export class Float { constructor(value: number); value: number; }
/** A Python exception: `type` is its class name, the message is str(exception). */
export class PyError extends Error { constructor(type: string, message: string); type: string; }
/** bool(value). */
export function truthy(value: unknown): boolean;
/** type(value).__name__ of a value from jsonLoads. */
export function typeName(value: unknown): string;
/** d.get(key, default); AttributeError on anything but a dict. */
export function get(dict: unknown, key: string, otherwise?: unknown): unknown;
/** d[key]; KeyError or TypeError as Python raises them. */
export function item(dict: unknown, key: string | number): unknown;
/** sorted(list). */
export function sorted(list: Iterable<unknown>): unknown[];
/** An OSError from a Node errno error, worded as Python words it; other errors unchanged. */
export function osError(error: unknown, name?: string): unknown;
/** open(path).read(): strict UTF-8, the BOM stays, newlines stay. */
export function readText(path: string): string;
/** json.loads: dict = Map, int = BigInt, float = Float. */
export function jsonLoads(input: string | Uint8Array): unknown;
export function floatRepr(x: number): string;
/** f'{x:.Nf}': half even on the exact binary value, as Python rounds. */
export function fixed(x: number, places: number): string;
/** datetime.now(timezone.utc).isoformat(). */
export function utcNow(now?: Date): string;
/** json.dumps: ensure_ascii, ", " and ": " separators, or indent. A number prints as Python's int or float would. */
export function jsonDumps(value: unknown, indent?: number | null): string;
/** json.dumps with sort_keys, compact separators and allow_nan=False unless told otherwise. */
export function jsonCanonical(value: unknown, options?: { separators?: [string, string]; ascii?: boolean; sort?: boolean }): string;
/** json.load: dicts are Maps, ints BigInts, floats Float, so a hash of the value matches Python's. */
export function jsonLoad(path: string): unknown;
/** open(path).read(), with Python's error text. */
export function readText(path: string): string;
/** The Python exception for a Node file error; other errors unchanged. */
export function osError(error: unknown, name?: string): Error;
export function pyStr(value: unknown): string;
export function compare(a: string, b: string): number;
export function splitlines(text: string): string[];
/** csv.DictReader over text from open(path). */
export function dictRows(text: string): Map<string, string | null>[];
