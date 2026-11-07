// Rows of the stage panel. A pure map from the JSON of `pcb state BOARD --json` and `pcb history BOARD --json`.
// The panel has no list of stages: names, order, inputs, outputs and moves come from that output. The position is never stored.

export interface ItemJson {
  name: string
  path: string | null
  template?: string
  exists: boolean
  size?: number
  image?: true
}
export interface StageJson {
  id: string
  name: string
  status: string
  evidence: string | null
  freshness: string | null
  position: boolean
  next: string[]
  back: { to: string; on: string }[]
  inputs: ItemJson[]
  outputs: ItemJson[]
  gap?: string
}
export interface RedoJson {
  evidence: string
  status: string
  cause?: string
}
export interface KindJson {
  kind: string
  reenter: string[]
  redo: RedoJson[]
  keep: string[]
  approve: string[]
}
export interface StateJson {
  board: string
  position: { state: string; name: string; evidence: string | null; freshness: string | null }
  allowed: string[]
  next: { state?: string; code?: string; command?: string; cause?: string }
  change: {
    state: string
    events: number
    problems: string[]
    pending: (KindJson & { group: string })[]
    last: (KindJson & { id: string; at: string; by: string; reason: string }) | null
  }
  images: string[]
  states: StageJson[]
}
export interface EntryJson {
  at: string | null
  placed_by: string
  source: string
  id: string
  type: string
  by: string | null
  summary: string
  stages: string[]
  inputs: { name: string }[]
  outputs: { name: string }[]
  status?: string
  sealed?: boolean
  cause?: string
}
export interface HistoryJson {
  entries: EntryJson[]
  problems: string[]
}

/** done: evidence is current. running: where the board is. blocked: where the board is, and the next step is refused or not readable.
 *  stale: evidence exists and is out of date. person: a person must act. pending: not reached. unproven: passed, with no evidence to read. */
export type Status = 'done' | 'running' | 'blocked' | 'stale' | 'person' | 'pending' | 'unproven'
export const STATUSES: readonly Status[] = [
  'done',
  'running',
  'blocked',
  'stale',
  'person',
  'pending',
  'unproven'
]

export interface LogLine {
  id: string
  at: string | null
  placedBy: string
  by: string | null
  source: string
  type: string
  summary: string
  status?: string
  cause?: string
}
export interface Row {
  id: string
  name: string
  group: 'stage' | 'rule'
  enforcement: string
  status: Status
  why: string | null
  here: boolean
  person: boolean
  gap: string | null
  next: string[]
  back: { to: string; on: string }[]
  inputs: ItemJson[]
  outputs: ItemJson[]
  images: string[]
  log: LogLine[]
  reopened: { text: string; pending: boolean }[]
}
export interface Rows {
  rows: Row[]
  position: { id: string; name: string }
  counts: Record<Status, number>
  next: { command: string | null; blocked: string | null }
}

/** The name of a person gate carries the marker in tools/pcb-transitions.json. */
const isPerson = (name: string): boolean => /person gate/i.test(name)
const redoText = (rows: RedoJson[]): string =>
  rows.map((row) => `${row.evidence}=${row.status}`).join(', ') || 'nothing'
const blocked = (next: StateJson['next']): string | null =>
  next.state === 'blocked'
    ? [next.code, next.cause].filter(Boolean).join(': ') || 'blocked'
    : next.state === 'unavailable'
      ? `The next step cannot be read${next.cause ? `: ${next.cause}` : ''}`
      : null

function statusOf(
  stage: StageJson,
  before: boolean,
  state: StateJson,
  person: boolean,
  active: boolean
): { status: Status; why: string | null } {
  const stale = stage.evidence ? `${stage.evidence} is ${stage.freshness}` : null
  if (stage.position) {
    if (person && stage.freshness !== 'current' && stage.freshness !== 'exempt')
      return { status: 'person', why: `A person must act. ${stale ?? 'No approval is recorded.'}` }
    const stop = blocked(state.next)
    if (stop && !active) return { status: 'blocked', why: stop }
    return { status: 'running', why: active ? 'A run is active.' : stale }
  }
  switch (stage.freshness) {
    case 'current':
      return { status: 'done', why: null }
    case 'exempt':
      return { status: 'done', why: 'exempt' }
    case 'stale':
      return { status: 'stale', why: stale }
    case 'missing':
      return before ? { status: 'stale', why: stale } : { status: 'pending', why: null }
    default:
      return before
        ? { status: 'unproven', why: stage.evidence ? null : 'This stage has no evidence to read.' }
        : { status: 'pending', why: null }
  }
}

export function buildRows(
  state: StateJson,
  history: HistoryJson | null,
  options: { active?: boolean } = {}
): Rows {
  const here = state.states.findIndex((stage) => stage.position)
  const kinds = [
    ...state.change.pending.map((row) => ({
      ...row,
      text: `A change with no event in ${row.group}: re-enter ${row.reenter.join(' or ')}; redo ${redoText(row.redo)}`,
      pending: true
    })),
    ...(state.change.last
      ? [
          {
            ...state.change.last,
            text: `${state.change.last.kind} by ${state.change.last.by}: ${state.change.last.reason}; redo ${redoText(state.change.last.redo)}`,
            pending: false
          }
        ]
      : [])
  ]
  const lines = [...(history?.entries ?? [])].reverse()
  const counts = Object.fromEntries(STATUSES.map((status) => [status, 0])) as Record<Status, number>
  const rows = state.states.map((stage, index): Row => {
    const group = stage.id.startsWith('A') ? 'stage' : 'rule',
      person = isPerson(stage.name)
    const { status, why } =
      group === 'stage'
        ? statusOf(stage, index < here, state, person, options.active === true)
        : {
            status: (stage.freshness === 'current' || stage.freshness === 'exempt'
              ? 'done'
              : 'unproven') as Status,
            why: null
          }
    if (group === 'stage') counts[status]++
    return {
      id: stage.id,
      name: stage.name,
      group,
      enforcement: stage.status,
      status,
      why,
      here: stage.position,
      person,
      gap: stage.gap ?? null,
      next: stage.next,
      back: stage.back,
      inputs: stage.inputs,
      outputs: stage.outputs,
      images: [...stage.inputs, ...stage.outputs]
        .filter((item) => item.image && item.exists && item.path)
        .map((item) => item.path!),
      log: lines
        .filter((entry) => entry.stages.includes(stage.id))
        .map((entry) => ({
          id: entry.id,
          at: entry.at,
          placedBy: entry.placed_by,
          by: entry.by,
          source: entry.source,
          type: entry.type,
          summary: entry.summary,
          status: entry.status,
          cause: entry.cause
        })),
      reopened: kinds
        .filter((kind) => kind.reenter.includes(stage.id))
        .map((kind) => ({ text: kind.text, pending: kind.pending }))
    }
  })
  return {
    rows,
    position: { id: state.position.state, name: state.position.name },
    counts,
    next: { command: state.next.command ?? null, blocked: blocked(state.next) }
  }
}

export function formatSize(bytes: number): string {
  if (bytes < 1000) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} kB`
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`
}
