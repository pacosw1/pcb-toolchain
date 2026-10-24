// Tool policy of the in-app agent: which tool calls it may make. Used as the SDK canUseTool callback and as a
// PreToolUse hook (the hook runs before any allow rule, so a path check cannot be skipped).
// - mcp__pcb__* (the engine tools of this app's in-process server) and WebSearch: allowed.
// - Read, Grep, Glob: only inside the open project (real paths: a symlink out of the project is refused).
// - Everything else (Bash, Write, Edit, WebFetch, ...): denied.
import { realpathSync } from 'fs'
import { basename, dirname, isAbsolute, join, resolve, sep } from 'path'

export type PolicyResult =
  | { behavior: 'allow'; updatedInput: Record<string, unknown> }
  | { behavior: 'deny'; message: string }

/** The real path of p; for a missing file, the real path of its nearest existing parent plus the rest. */
export function realish(p: string): string {
  const abs = resolve(p)
  try {
    return realpathSync(abs)
  } catch {
    const parent = dirname(abs)
    if (parent === abs) return abs
    return join(realish(parent), basename(abs))
  }
}

export function insideRoot(p: string, root: string): boolean {
  const r = realish(root)
  const q = realish(isAbsolute(p) ? p : join(root, p))
  return q === r || q.startsWith(r + sep)
}

/** A glob pattern that cannot leave its base folder: relative, no `..` segment, no `~`. */
function safePattern(pattern: unknown): boolean {
  if (typeof pattern !== 'string') return false
  if (isAbsolute(pattern) || pattern.startsWith('~')) return false
  return !pattern.split(/[/\\]/).includes('..')
}

const ALWAYS_ALLOWED = new Set(['WebSearch'])
const FILE_TOOLS = new Set(['Read', 'Grep', 'Glob'])

export function checkToolUse(toolName: string, input: Record<string, unknown>, root: string | null): PolicyResult {
  const allow: PolicyResult = { behavior: 'allow', updatedInput: input }
  const deny = (why: string): PolicyResult => ({ behavior: 'deny', message: `${toolName} refused: ${why}` })
  if (toolName.startsWith('mcp__pcb__') || ALWAYS_ALLOWED.has(toolName)) return allow
  if (!FILE_TOOLS.has(toolName)) return deny('this tool is not available in PCB Studio')
  if (!root) return deny('no project is open')
  const out = (p: unknown): boolean => typeof p !== 'string' || !p || !insideRoot(p, root)
  if (toolName === 'Read') {
    if (out(input.file_path)) return deny('only files inside the open project can be read')
    return allow
  }
  // Grep and Glob: the search folder (default: the session cwd = the project) and the patterns stay inside.
  if (input.path !== undefined && out(input.path)) return deny('only the open project can be searched')
  if (toolName === 'Glob' && !safePattern(input.pattern)) return deny('the pattern must be relative, without ..')
  if (toolName === 'Grep' && input.glob !== undefined && !safePattern(input.glob)) {
    return deny('the glob must be relative, without ..')
  }
  return allow
}
