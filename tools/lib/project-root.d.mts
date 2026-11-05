export const fileRoot: string;
export function findProjectRoot(start: string): string | null;
export function projectRoot(explicit?: string | null, env?: NodeJS.ProcessEnv, cwd?: string): string;
