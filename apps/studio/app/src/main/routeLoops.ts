// Studio calls the same durable CLI controller used by coding agents. Candidate
// execution, gates and process ownership remain in the existing CLI supervisor.
import { execFile } from 'node:child_process'
import { existsSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { toolOf } from './runs.ts'

export type LoopData = Record<string, unknown>
export async function loopCommand(
  root: string,
  action: string,
  args: string[] = [],
  waitS = 0
): Promise<unknown> {
  if (!existsSync(join(root, 'tools/pcb-loop.ts'))) {
    if (action === 'list') return []
    throw new Error(
      'This project uses a toolchain without routing loops. Install a release containing pcb loop and update its toolchain.lock.'
    )
  }
  const result = await new Promise<string>((resolve, reject) => {
    execFile(
      toolOf(root),
      ['--project', root, 'loop', action, ...args, '--json'],
      { cwd: root, encoding: 'utf8', timeout: (waitS + 30) * 1000, maxBuffer: 8 * 1024 * 1024 },
      (error, stdout, stderr) => {
        if (error) {
          let cause = stderr.trim() || error.message
          try {
            cause = JSON.parse(stderr.trim()).cause || cause
          } catch {
            /* preserve bounded tool error */
          }
          reject(new Error(cause.slice(0, 2000)))
        } else resolve(stdout)
      }
    )
  })
  return JSON.parse(result.trim())
}
export async function startRouteLoop(
  root: string,
  board: string,
  policy: LoopData
): Promise<unknown> {
  if (policy.experimental !== true)
    throw new Error('Enable the experimental routing loop explicitly.')
  const folder = mkdtempSync(join(tmpdir(), 'pcbstudio-loop-')),
    file = join(folder, 'policy.json')
  try {
    writeFileSync(file, JSON.stringify(policy), { mode: 0o600 })
    return await loopCommand(root, 'start', [board, '--experimental', '--policy', file])
  } finally {
    rmSync(folder, { recursive: true, force: true })
  }
}
