// Resolve the per-user coordinator registration for a project or any of its Git worktrees.
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

type Config = { url?: string; tokenFile?: string; cliPath?: string; projects?: Record<string, string> }
function expand(p: string): string { return p.startsWith('~/') ? path.join(os.homedir(), p.slice(2)) : p }
export function liveProject(root: string): boolean {
  const markerPath = path.join(root, '.pcb-live.json')
  const hasMarker = fs.existsSync(markerPath)
  const marker = hasMarker ? (JSON.parse(fs.readFileSync(markerPath, 'utf8')) as { projectId?: unknown }).projectId : undefined
  if (hasMarker && (typeof marker !== 'string' || !marker || marker.includes('/'))) throw new Error('invalid PCB live project marker')
  const file = expand(process.env.PCB_LIVE_CONFIG ?? '~/.config/pcb-live/config.json')
  const config = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) as Config : null
  let registered: string | undefined
  if (config?.projects) {
    try {
      const common = execFileSync('git', ['-C', root, 'rev-parse', '--git-common-dir'], { encoding: 'utf8', timeout: 2000, stdio: ['ignore', 'pipe', 'ignore'] }).trim()
      registered = config.projects[fs.realpathSync(path.resolve(root, common))]
    } catch { /* non-Git project */ }
  }
  if (marker !== undefined && registered !== undefined && marker !== registered) throw new Error('project marker conflicts with its registered project ID')
  const id = marker ?? registered
  if (id === undefined) return false
  if (typeof id !== 'string' || !id || id.includes('/')) throw new Error('invalid PCB live project ID')
  if (!config?.url || !config.tokenFile) throw new Error('live coordinator is not configured')
  return true
}
export function coordinatedTool(root: string): string | null {
  if (!liveProject(root)) return null
  const file = expand(process.env.PCB_LIVE_CONFIG ?? '~/.config/pcb-live/config.json')
  const config = JSON.parse(fs.readFileSync(file, 'utf8')) as Config
  const cli = expand(config.cliPath ?? '~/.local/bin/pcb')
  try { fs.accessSync(cli, fs.constants.X_OK) } catch { throw new Error('live-coordinated PCB CLI is not installed') }
  return cli
}
