// Types of the parts of env.mjs that TypeScript tools use.
export const root: string;
export const kicadCli: string;
export const TS_NODE: string[];
/** Importing env.mjs looks for it by running each python3.1x, unless PYTHON_MODERN is set. */
export function modernPython(): string;
