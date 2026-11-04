// Where the app finds its tools. One place, with an environment override:
//   PCBSTUDIO_PATH        complete PATH for the engine and the agent (default: see toolPath)
import { execFileSync } from 'child_process'
import { existsSync } from 'fs'
import { homedir } from 'os'
import { delimiter, join } from 'path'

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
