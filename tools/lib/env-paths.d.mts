// Types of env-paths.mjs. Unlike env.mjs it starts no process, so a TypeScript tool can import it.
export interface KiCadPaths {
  kicadApp: string;
  kicadCli: string;
  kicadPython: string;
  kicadShared: string;
  kicadConfig: string;
}
export function kiCadPaths(platform: string, home: string, env?: Record<string, string | undefined>): KiCadPaths;
