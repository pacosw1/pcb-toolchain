// The tool call timeline. A pure map from the call log of the project (`.gate/calls.jsonl`, written by tools/pcb) and the run
// starts of the board to lanes, ticks, a list of calls and totals. The time is an argument: nothing here reads the clock.

export interface CallRecord {
  schema: string
  id: string
  phase: 'start' | 'end'
  at: string
  command?: string
  args?: string[]
  caller?: string
  pid?: number
  exit_code?: number | null
  signal?: string | null
  duration_ms?: number
}
export interface RunMark {
  id: string
  board: string
  at: string
}
export interface CallsJson {
  calls: CallRecord[]
  runs: RunMark[]
}

/** ok and failed: the end is known. running: no end yet and the call is young. unknown: no end, and the end is not coming
 *  or was not written. An unknown call is never shown as ok. */
export type CallState = 'ok' | 'failed' | 'running' | 'unknown'
export interface Call {
  id: string
  command: string
  args: string[]
  caller: string | null
  start: number
  end: number | null
  duration: number | null
  exit: number | null
  signal: string | null
  state: CallState
  run: string | null
  /** The call is after the play head. */
  dim: boolean
}
export interface Lane {
  command: string
  count: number
  failed: number
  ticks: { id: string; x: number; state: CallState; dim: boolean }[]
}
export interface Timeline {
  from: number
  to: number
  lanes: Lane[]
  /** Newest first. */
  calls: Call[]
  marks: { id: string; x: number; at: number }[]
  totals: { calls: number; failed: number; unfinished: number; runs: number; span: number }
}

const SCHEMA = 'iot-lab.cli-call.v1'
const STUDIO = 'studio'
/** A call with no end line is `running` for this long, then `unknown`. */
export const RUNNING_MS = 10 * 60_000
const MIN_SPAN_MS = 60_000
const SLACK_MS = 1000

/** 450 ms, 2.5 s, 1 min 1 s, 1 h 2 min. No end line gives `not recorded`. */
export function formatDuration(ms: number | null): string {
  if (ms === null) return 'not recorded'
  if (ms < 1000) return `${Math.round(ms)} ms`
  if (ms < 60_000) return `${Math.round(ms / 100) / 10} s`
  const minutes = Math.floor(ms / 60_000)
  if (ms < 3_600_000) return `${minutes} min ${Math.floor((ms % 60_000) / 1000)} s`
  return `${Math.floor(minutes / 60)} h ${minutes % 60} min`
}

/** The age of a call: now, 4 s ago, 2 min ago, 2 h ago, 1 d ago. */
export function ago(ms: number): string {
  if (ms < 1000) return 'now'
  if (ms < 60_000) return `${Math.floor(ms / 1000)} s ago`
  if (ms < 3_600_000) return `${Math.floor(ms / 60_000)} min ago`
  if (ms < 86_400_000) return `${Math.floor(ms / 3_600_000)} h ago`
  return `${Math.floor(ms / 86_400_000)} d ago`
}

export function buildTimeline(
  input: CallsJson,
  options: { board: string; now: number; head?: number | null }
): Timeline {
  const { board, now } = options
  const starts = new Map<string, CallRecord>(),
    ends = new Map<string, CallRecord>()
  for (const record of input.calls) {
    if (
      record?.schema !== SCHEMA ||
      typeof record.id !== 'string' ||
      !Number.isFinite(Date.parse(record.at))
    )
      continue
    const into = record.phase === 'start' ? starts : record.phase === 'end' ? ends : null
    if (into && !into.has(record.id)) into.set(record.id, record)
  }
  const runs = input.runs
    .filter((run) => run.board === board && Number.isFinite(Date.parse(run.at)))
    .map((run) => ({ id: run.id, at: Date.parse(run.at) }))
    .sort((a, b) => a.at - b.at)

  const all: Call[] = []
  for (const [id, begin] of starts) {
    const finish = ends.get(id),
      start = Date.parse(begin.at),
      end = finish ? Date.parse(finish.at) : null
    const args = begin.args ?? []
    if (begin.caller === STUDIO) continue // Studio reads the state for its own panels: no work of the board
    const run =
      runs.find((r) => r.at >= start - SLACK_MS && r.at <= (end ?? now) + SLACK_MS) ?? null
    if (!args.includes(board) && !run) continue
    const state: CallState = finish
      ? finish.exit_code === 0 && !finish.signal
        ? 'ok'
        : 'failed'
      : now - start < RUNNING_MS
        ? 'running'
        : 'unknown'
    all.push({
      id,
      command: begin.command ?? 'check',
      args,
      caller: begin.caller ?? null,
      start,
      end,
      duration: finish && end !== null ? (finish.duration_ms ?? end - start) : null,
      exit: finish?.exit_code ?? null,
      signal: finish?.signal ?? null,
      state,
      run: run?.id ?? null,
      dim: options.head != null && start > options.head
    })
  }
  all.sort((a, b) => a.start - b.start)

  const from = all.length ? all[0]!.start : now
  const to = Math.max(now, from + MIN_SPAN_MS)
  const x = (time: number): number => Math.min(1, Math.max(0, (time - from) / (to - from)))
  const byCommand = new Map<string, Lane>()
  for (const call of all) {
    const lane = byCommand.get(call.command) ?? {
      command: call.command,
      count: 0,
      failed: 0,
      ticks: []
    }
    lane.count++
    if (call.state === 'failed') lane.failed++
    lane.ticks.push({ id: call.id, x: x(call.start), state: call.state, dim: call.dim })
    byCommand.set(call.command, lane)
  }
  const lanes = [...byCommand.values()].sort(
    (a, b) => b.count - a.count || a.command.localeCompare(b.command)
  )
  const marks = runs
    .filter((run) => run.at >= from)
    .map((run) => ({ id: run.id, x: x(run.at), at: run.at }))
  return {
    from,
    to,
    lanes,
    calls: [...all].reverse(),
    marks,
    totals: {
      calls: all.length,
      failed: all.filter((call) => call.state === 'failed').length,
      unfinished: all.filter((call) => call.state === 'running' || call.state === 'unknown').length,
      runs: marks.length,
      span: all.length ? to - from : 0
    }
  }
}
