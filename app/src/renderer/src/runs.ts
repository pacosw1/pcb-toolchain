// Run shapes from the engine (engine/src/pcbstudio/runs.py Run.summary) and helpers shared by Checks and Runs.

/** A candidate board of a build/route run (engine runs.py Run.candidate). */
export interface Candidate {
  pcb: string // project-relative, under .gate/cli/RUN_ID/workspace/
  target: string | null // the canonical board file adopt replaces
  exists: boolean
  sha256: string | null
  verified: boolean
  identity_preserved: boolean | null
  metrics: Record<string, number> | null
}

export interface RunSummary {
  id: string
  op?: 'check' | 'build' | 'route'
  board: string
  mode: string
  state: 'running' | 'passed' | 'failed' | 'error' | 'cancelled'
  started: number
  exit_code: number | null
  run_id: string | null
  cause: string | null
  metrics: Record<string, number> | null
  findings: number
  events: number
  elapsed_s: number | null
  candidate?: Candidate | null
  policy?: Record<string, unknown> | null
  adoption?: Record<string, unknown> | null
  adoptable?: boolean
}

export type Ev = Record<string, unknown> & { type?: string; seq?: number }

export const STATE_COLOR: Record<RunSummary['state'], string> = {
  running: 'var(--warn)',
  passed: 'var(--ok)',
  failed: 'var(--err)',
  error: 'var(--err)',
  cancelled: 'var(--dim)'
}

export function isWarning(metric: string): boolean {
  return metric.endsWith('warnings')
}

export function line(e: Ev): string {
  const t = e.type ?? '?'
  const bits = [t]
  for (const k of ['stage', 'check', 'tool', 'status', 'verdict', 'text', 'message', 'cause']) {
    const v = e[k]
    if (typeof v === 'string' && v) bits.push(v)
  }
  return bits.join('  ')
}
