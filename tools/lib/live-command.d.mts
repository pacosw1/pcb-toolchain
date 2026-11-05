export function liveCommand(
  command: string[],
  spool: string,
  env?: NodeJS.ProcessEnv,
  cwd?: string,
): { command: string[]; env: NodeJS.ProcessEnv };
