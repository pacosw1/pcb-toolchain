// Types of the parts of py-compat.mjs that TypeScript tools use. Add a line when a tool needs another export.
export class Float { constructor(value: number); value: number; }
/** A Python exception: `type` is its class name, the message is str(exception). */
export class PyError extends Error { constructor(type: string, message: string); type: string; }
/** str(value) and repr(value) of a value from jsonLoads. */
export function pyStr(value: unknown): string;
export function pyRepr(value: unknown): string;
/** text.splitlines(). */
export function splitlines(text: string): string[];
/** The number in an int, float or bool; TypeError on anything else. */
export function number(value: unknown): number;
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
export function compare(a: string, b: string): number;
/** sys.exit(code) from parseArgs. */
export class SystemExit extends Error { constructor(code: number, message?: string); code: number; }
/** argparse for positionals and options that take one value. */
export function parseArgs(spec: { prog: string; positionals: string[]; options: { flag: string; type?: 'int'; fallback?: unknown; required?: boolean }[] }, argv: string[]): Record<string, any>;
/** The names glob's * sees in a folder: no hidden names, a missing folder is empty. */
export function globNames(folder: string): string[];
/** str.strip(): Python's whitespace, which is not the set of String.prototype.trim. */
export function strip(text: string): string;
/** bytes.decode(): strict UTF-8, UnicodeDecodeError as Python words it. */
export function decode(data: Uint8Array): string;
/** Text of a subprocess run with text=True: strict UTF-8, universal newlines. */
export function processText(data: Uint8Array): string;
/** text[-n:], by code point. */
export function tail(text: string, n: number): string;
export interface RunResult { status: number | null; stdout: Buffer; stderr: Buffer }
/** subprocess.run with captured output; a timeout raises subprocess.TimeoutExpired, check=True a CalledProcessError. */
export function run(command: string, args: string[], options?: { check?: boolean; stdio?: unknown; timeout?: number; env?: NodeJS.ProcessEnv }): RunResult;
/** csv.DictReader over text from open(path). */
export function dictRows(text: string): Map<string, string | null>[];
