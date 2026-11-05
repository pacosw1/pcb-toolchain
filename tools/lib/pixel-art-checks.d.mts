// Types of pixel-art-checks.mjs.
type Check = (name: string, ok: boolean, detail: string) => void;
interface Measure { edge_mm: number; art: Record<string, unknown> }
export function pixelArtChecks(options: { pcb: string; arts: Record<string, string>; check: Check; measure?: (pcb: string, names: string[]) => Measure; python?: string; probe?: string }): void;
