// Types of the parts of env.mjs that TypeScript tools use.
export const root: string;
export const kicadCli: string;
export const TS_NODE: string[];
export const PINNED_IMAGE: string;
export function happyRunsLocally(): boolean;
/** What runs kicad-happy: the job image and its Python, or the local Python, which this then starts. */
export function happyRuntime(): string;
/** The first call looks for it by running each python3.1x, unless PYTHON_MODERN is set. */
export function modernPython(): string;
