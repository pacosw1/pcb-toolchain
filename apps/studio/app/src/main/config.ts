// Where the app finds its tools and the engine. One place, with environment overrides:
//   PCBSTUDIO_PATH        complete PATH for the engine and the agent (default: see toolPath)
//   PCBSTUDIO_UV          the uv executable
//   PCBSTUDIO_ENGINE_DIR  the engine project folder (with pyproject.toml)
import { execFileSync } from 'child_process'
import { existsSync } from 'fs'
import { homedir } from 'os'
import { delimiter, join, resolve } from 'path'

// Standard install folders of Homebrew (Apple silicon, Intel) and uv/pipx. A Finder-launched app gets only
// /usr/bin:/bin:/usr/sbin:/sbin, so these are the fallback when the login shell gives nothing.
const STANDARD_DIRS = ['/opt/homebrew/bin', '/usr/local/bin', join(homedir(), '.local', 'bin')]

let loginPath: string | null | undefined

/** PATH of the user's login shell (what `which` sees in Terminal), or null. Read once, 3 s at most. */
function loginShellPath(): string | null {
  if (loginPath !== undefined) return loginPath
  loginPath = null
  const shell = process.env.SHELL
  if (!shell || !existsSync(shell)) return loginPath
  try {
    const out = execFileSync(shell, ['-lc', 'printf "__PATH__%s__PATH__" "$PATH"'], {
      encoding: 'utf8',
      timeout: 3000,
      stdio: ['ignore', 'pipe', 'ignore']
    })
    const m = /__PATH__(.*)__PATH__/.exec(out)
    loginPath = m ? m[1] : null
  } catch {
    loginPath = null
  }
  return loginPath
}

/** PATH for the engine and the agent: PCBSTUDIO_PATH, else this process's PATH + the login shell PATH + standard dirs. */
export function toolPath(): string {
  if (process.env.PCBSTUDIO_PATH) return process.env.PCBSTUDIO_PATH
  const dirs = [process.env.PATH ?? '', loginShellPath() ?? '', STANDARD_DIRS.join(delimiter)]
    .join(delimiter)
    .split(delimiter)
    .filter((d) => d)
  return [...new Set(dirs)].join(delimiter)
}

/** An executable by name: the env override, else the first match on toolPath(). */
export function findTool(name: string, envVar?: string): string | null {
  const override = envVar ? process.env[envVar] : undefined
  if (override) return override
  for (const d of toolPath().split(delimiter)) {
    const p = join(d, name)
    if (existsSync(p)) return p
  }
  return null
}

/** The engine project: PCBSTUDIO_ENGINE_DIR, else `engine/` beside the app folder (dev), else in the app resources. */
export function engineDir(appPath: string, resourcesPath: string): string | null {
  const candidates = [process.env.PCBSTUDIO_ENGINE_DIR, resolve(appPath, '..', 'engine'), join(resourcesPath, 'engine')]
  return candidates.find((p): p is string => !!p && existsSync(join(p, 'pyproject.toml'))) ?? null
}
