export function gateChecks(dir: string, checks?: Record<string, any>): Record<string, any>;
export function gateInputs(root: string, board: string, configName?: string, environment?: Record<string, unknown>): { cfg: Record<string, any>; project: string; files: string[]; rules: string[] };
export function fingerprint(root: string, files: string[], versions?: Record<string, unknown>, externalRoots?: Record<string, string>): { input_sha256: string; inputs: { path: string; sha256: string | null }[]; tools: Record<string, unknown> };
