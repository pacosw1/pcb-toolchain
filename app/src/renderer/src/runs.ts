// Run shapes (generated from engine/src/pcbstudio/model/runs.py) and helpers shared by Checks and Runs.
import type { RunSummary } from '../../shared/generated'

export type { Candidate, RunSummary } from '../../shared/generated'

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
