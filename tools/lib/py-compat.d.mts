// Types of the parts of py-compat.mjs that TypeScript tools use. Add a line when a tool needs another export.
export class Float { constructor(value: number); value: number; }
export function floatRepr(x: number): string;
/** f'{x:.Nf}': half even on the exact binary value, as Python rounds. */
export function fixed(x: number, places: number): string;
/** datetime.now(timezone.utc).isoformat(). */
export function utcNow(now?: Date): string;
/** json.dumps: ensure_ascii, ", " and ": " separators, or indent. A number prints as Python's int or float would. */
export function jsonDumps(value: unknown, indent?: number | null): string;
