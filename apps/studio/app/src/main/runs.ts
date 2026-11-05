// Runs of the project's CLI in the project root: gate checks and candidate operations.
//
//   check  `tools/pcb check BOARD --fresh|--changed --json`
//   build  `tools/pcb build BOARD --json`              (the board's own pipeline; unsupported boards fail explicitly)
//   route  `tools/pcb route BOARD --router iotroute --spec POLICY.json --timeout S --json`
//   adopt  `tools/pcb adopt RUN_ID --json`             (only on a user click; the only step that writes canonical CAD)
//
// Each JSON Lines event of the run record is kept and published as a `run.event` notification; the terminal `run.end`
// event carries status, cause and the gate metrics. For build/route, `run.end` is the sealed operation/result.json plus
// supervisor fields: `candidate` (absolute path of the isolated native board under `evidence_dir`/workspace/),
// `candidate_sha256`, `candidate_verified`, `identity_preserved` and `metrics` (the candidate's own gate result). The
// run record (.gate/cli/RUN_ID) stays the durable evidence; this module only supervises and relays it.
//
// Studio runs are durable too: each run has a random id (`r-` + 16 hex digits, unique across engine restarts) and a
// folder `<project>/.gate/studio/runs/<id>/` with `run.json` (the record, rewritten atomically at each state change)
// and `events.jsonl` (every event, appended). load(root) brings back the runs of earlier engine processes; a run still
// `running` in its record lost its supervisor when that engine died and becomes `interrupted`.
import { spawn } from 'node:child_process'
import type { ChildProcess } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { Readable } from 'node:stream'
import type { Candidate, Finding, Findings, RunSummary } from '../shared/generated'
import { publish } from './events.ts'
import { resolveReal } from './project.ts'

const MAX_EVENTS = 2000
const MAX_STDERR = 200
const OPS = ['check', 'build', 'route']
const POLICY_SCHEMA = 'iot-lab.iotroute-policy.v1'
const POLICY_FIELDS = ['schema', 'iters', 'max_time_s', 'keep', 'layers', 'nets']
const STORE = '.gate/studio/runs'
const RECORD_FIELDS = ['id', 'op', 'board', 'mode', 'argv', 'policy', 'started', 'state', 'exit_code', 'run_id', 'end',
                       'adoption', 'stderr'] as const

type Json = Record<string, unknown>
export type RunState = RunSummary['state']
export type RunOp = RunSummary['op']

export interface RoutingPolicy { schema: string, iters: number, max_time_s: number, keep: string, layers: string[], nets: string[] }

const isObject = (x: unknown): x is Json => x !== null && typeof x === 'object' && !Array.isArray(x)
const isFile = (p: string): boolean => { try { return fs.statSync(p).isFile() } catch { return false } }
const isInside = (base: string, p: string): boolean => p.startsWith(base + path.sep)
const newId = (): string => 'r-' + randomBytes(8).toString('hex')
const message = (e: unknown): string => e instanceof Error ? `${e.name}: ${e.message}` : String(e)

/** One text line at a time, split on \n only; a last line without \n counts. Lines have no length limit. */
function eachLine(stream: Readable, onLine: (line: string) => void): void {
  let rest: Buffer = Buffer.alloc(0)
  stream.on('data', (d: Buffer) => {
    rest = rest.length ? Buffer.concat([rest, d]) : d
    let at: number, from = 0
    while ((at = rest.indexOf(10, from)) >= 0) {
      onLine(rest.toString('utf8', from, at))
      from = at + 1
    }
    rest = rest.subarray(from)
  })
  stream.on('end', () => { if (rest.length) onLine(rest.toString()) })
}

/** Python's returncode: the exit code, or minus the signal number. */
function returnCode(code: number | null, signal: NodeJS.Signals | null): number {
  return code ?? -(signal ? os.constants.signals[signal] : 1)
}

export class Run {
  id: string
  op: RunOp
  board: string
  mode: string                      // check: fresh | changed; build: build; route: the router (iotroute)
  argv: string[]
  root: string | null
  policy: RoutingPolicy | null = null
  started: number = Date.now() / 1000
  state: RunState = 'running'
  exit_code: number | null = null
  run_id: string | null = null      // the CLI's run id (run-…)
  end: Json | null = null
  events: Json[] = []
  stderr: string[] = []
  proc: ChildProcess | null = null
  adoption: Json | null = null      // the adopt receipt (target, before/after sha256) once adopted
  adopting = false                  // a `tools/pcb adopt` of this run is in progress
  cancelRequested = false           // cancel sent SIGTERM; the state becomes cancelled when the process exits

  constructor(id: string, op: RunOp, board: string, mode: string, argv: string[], root: string | null) {
    this.id = id
    this.op = op
    this.board = board
    this.mode = mode
    this.argv = argv
    this.root = root
  }

  dir(): string | null { return this.root === null ? null : path.join(this.root, STORE, this.id) }

  record(): Json {
    return Object.fromEntries(RECORD_FIELDS.map(k => [k, this[k]]))
  }

  /** Write run.json atomically. A project that cannot be written keeps the run in memory only. */
  persist(): void {
    const d = this.dir()
    if (d === null) return
    try {
      fs.mkdirSync(d, { recursive: true })
      const tmp = path.join(d, 'run.json.tmp')
      fs.writeFileSync(tmp, JSON.stringify(this.record()))
      fs.renameSync(tmp, path.join(d, 'run.json'))
    } catch (e) {
      console.error(`pcbstudio: cannot persist run ${this.id}: ${message(e)}`)
    }
  }

  appendEvent(ev: Json): void {
    const d = this.dir()
    if (d === null) return
    try {
      fs.mkdirSync(d, { recursive: true })
      fs.appendFileSync(path.join(d, 'events.jsonl'), JSON.stringify(ev) + '\n')
    } catch (e) {
      console.error(`pcbstudio: cannot persist an event of run ${this.id}: ${message(e)}`)
    }
  }

  /** The isolated candidate board of a build/route run, project-relative, or null. `target` is the canonical board
   *  file adopt replaces: the run workspace is a snapshot of the checkout, so the candidate's path inside it is the
   *  same project-relative path in the checkout. */
  candidate(): Candidate | null {
    const e = this.end ?? {}
    if (this.op === 'check' || !e.candidate || this.root === null) return null
    const rp = resolveReal(this.root), cand = resolveReal(String(e.candidate))
    if (!isInside(rp, cand)) return null            // a run store outside the project (PCB_RUNS_DIR)
    let target: string | null = null
    if (e.evidence_dir) {
      const ws = path.join(resolveReal(String(e.evidence_dir)), 'workspace')
      if (isInside(ws, cand)) target = path.relative(ws, cand)
    }
    return {
      pcb: path.relative(rp, cand), target, exists: isFile(cand), sha256: (e.candidate_sha256 as string) ?? null,
      verified: Boolean(e.candidate_verified), identity_preserved: (e.identity_preserved as boolean) ?? null,
      metrics: (e.metrics as Record<string, number>) ?? null
    }
  }

  /** Why this run cannot be adopted, or null. The CLI re-verifies everything; this only refuses early. */
  adoptable(): string | null {
    if (this.op === 'check') return 'a gate check has no candidate'
    if (this.adoption) return 'already adopted'
    if (this.adopting) return 'an adoption of this run is in progress'
    if (this.state !== 'passed') return `run is ${this.state}, not passed`
    const c = this.candidate()
    if (!c || !c.exists || !c.target) return 'run has no candidate board inside the project'
    if (!c.verified || !c.identity_preserved) return 'candidate is not gate-verified with preserved design identity'
    return null
  }

  summary(): RunSummary {
    const e = this.end ?? {}
    return {
      id: this.id, op: this.op, board: this.board, mode: this.mode, state: this.state, started: this.started,
      exit_code: this.exit_code, run_id: this.run_id, cause: (e.cause as string) ?? null,
      metrics: (e.metrics as Record<string, number>) ?? null, findings: ((e.findings as unknown[]) || []).length,
      events: this.events.length, elapsed_s: (e.elapsed_s as number) ?? null, candidate: this.candidate(),
      policy: this.policy as unknown as Json | null, adoption: this.adoption,
      adoptable: this.op !== 'check' && this.adoptable() === null
    }
  }
}

export function killGroup(pid: number): void {
  try {
    process.kill(-pid, 'SIGTERM')
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'ESRCH') throw e    // ESRCH: the process group has exited already
  }
}

function toolOf(root: string): string {
  const tool = path.join(root, 'tools', 'pcb')
  if (!isFile(tool)) throw new Error(`${tool} (this project has no tools/pcb)`)
  return tool
}

/** An early, readable refusal of what the CLI refuses anyway (the CLI stays the authority). */
function checkPolicy(p: RoutingPolicy): void {
  if (!isObject(p) || [...Object.keys(p)].sort().join() !== [...POLICY_FIELDS].sort().join() || p.schema !== POLICY_SCHEMA) {
    throw new Error(`routing policy needs exactly the ${POLICY_SCHEMA} fields ${[...POLICY_FIELDS].sort().join(', ')}`)
  }
  if (!Number.isInteger(p.iters) || p.iters < 1 || p.iters > 1000) throw new Error('iters must be an integer 1..1000')
  if (!Number.isInteger(p.max_time_s) || p.max_time_s <= 0) throw new Error('max_time_s must be a positive integer')
  if (!['lock-nets', 'all'].includes(p.keep)) throw new Error('keep must be lock-nets or all')
  for (const k of ['layers', 'nets'] as const) {
    const v = p[k]
    if (!Array.isArray(v) || v.some(x => typeof x !== 'string' || !x) || new Set(v).size !== v.length) throw new Error(`${k} needs a list of distinct names`)
  }
}

/** The exact iot-lab.iotroute-policy.v1 object (tools/PCB-CLI.md; iotroute route-policy). No layers or nets means all of them. */
export function routingPolicy(iters: number, maxTimeS: number, keep = 'lock-nets', layers: string[] = [], nets: string[] = []): RoutingPolicy {
  const policy = { schema: POLICY_SCHEMA, iters, max_time_s: maxTimeS, keep, layers: [...layers], nets: [...nets] }
  checkPolicy(policy)
  return policy
}

/** Drop bulky fields from a relayed event (the full event stays in run.events). */
function compact(ev: Json): Json {
  return Object.fromEntries(Object.entries(ev).filter(([k]) => !['timing', 'cleanup', 'command'].includes(k)))
}

function writeSpec(board: string, policy: RoutingPolicy): string {
  const spec = path.join(os.tmpdir(), `pcbstudio-route-${board}-${randomBytes(6).toString('hex')}.json`)
  fs.writeFileSync(spec, JSON.stringify(policy), { flag: 'wx', mode: 0o600 })
  return spec
}

export interface StartOptions { fresh?: boolean, policy?: RoutingPolicy, timeoutS?: number }

export class Runs {
  runs = new Map<string, Run>()

  get(id: string): Run {
    const run = this.runs.get(id)
    if (!run) throw new Error(`unknown run ${id}`)
    return run
  }

  /** Bring back the runs of earlier engine processes from <root>/.gate/studio/runs. Returns how many. */
  load(root: string): number {
    const store = path.join(root, STORE)
    if (!fs.existsSync(store)) return 0
    let n = 0
    for (const name of fs.readdirSync(store).sort()) {
      const d = path.join(store, name), file = path.join(d, 'run.json')
      if (this.runs.has(name) || !isFile(file)) continue
      let run: Run
      try {
        const rec = JSON.parse(fs.readFileSync(file, 'utf8')) as Json
        if (!isObject(rec) || typeof rec.id !== 'string' || typeof rec.board !== 'string' || typeof rec.mode !== 'string' ||
            !Array.isArray(rec.argv)) throw new TypeError('record lacks id, board, mode or argv')
        run = new Run(rec.id, (rec.op as RunOp) ?? 'check', rec.board, rec.mode, rec.argv as string[], root)
        for (const k of RECORD_FIELDS) if (k in rec) Object.assign(run, { [k]: rec[k] })
      } catch (e) {
        console.error(`pcbstudio: skip unreadable run record ${d}: ${message(e)}`)
        continue
      }
      if (run.id !== name) continue
      const evFile = path.join(d, 'events.jsonl')
      if (isFile(evFile)) {
        for (const line of fs.readFileSync(evFile, 'utf8').split(/\r\n|\r|\n/).slice(-MAX_EVENTS)) {
          try { run.events.push(JSON.parse(line) as Json) } catch { /* a torn last line */ }
        }
      }
      if (run.state === 'running') {                // its engine died: nobody supervises it any more
        run.state = 'interrupted'
        run.stderr.push('interrupted: the engine that supervised this run stopped')
        run.persist()
      }
      this.runs.set(run.id, run)
      n += 1
    }
    return n
  }

  list(root?: string): Run[] {
    const real = root === undefined ? null : resolveReal(root)
    return [...this.runs.values()].filter(r => real === null || (r.root !== null && resolveReal(r.root) === real))
      .sort((a, b) => a.started - b.started)
  }

  /** Start one CLI run. route needs a complete routing policy (see routingPolicy); it goes to a spec file outside the
   *  project (the CLI reads it once at admission and keeps it in its sealed run.json). */
  start(root: string, op: string, board: string, options: StartOptions = {}): Run {
    const { fresh = true, policy, timeoutS } = options
    if (!OPS.includes(op)) throw new Error(`unknown run op '${op}' (one of ${OPS.join(', ')})`)
    if (!board || board.includes('/') || board.startsWith('-')) throw new Error(`invalid board gate name: '${board}'`)
    const tool = toolOf(root)
    let mode: string, argv: string[]
    if (op === 'check') {
      mode = fresh ? 'fresh' : 'changed'
      argv = [tool, 'check', board, `--${mode}`, '--json']
    } else if (op === 'build') {
      mode = 'build'
      argv = [tool, 'build', board, ...(timeoutS ? ['--timeout', String(timeoutS)] : []), '--json']
    } else {
      if (!policy) throw new Error('route needs a routing policy')
      checkPolicy(policy)
      // The CLI deadline covers the solver and the complete fresh verification of the candidate.
      const total = timeoutS || Math.max(600, policy.max_time_s + 600)
      if (total < policy.max_time_s) throw new Error('the total timeout must be at least the router max_time_s')
      mode = 'iotroute'
      argv = [tool, 'route', board, '--router', 'iotroute', '--spec', writeSpec(board, policy), '--timeout', String(total), '--json']
    }
    const run = new Run(newId(), op as RunOp, board, mode, argv, root)
    if (op === 'route') run.policy = policy!
    this.runs.set(run.id, run)
    run.persist()
    publish('run.state', run.summary())
    void this.supervise(run, root)
    return run
  }

  private async supervise(run: Run, root: string): Promise<void> {
    try {
      const child = spawn(run.argv[0], run.argv.slice(1), { cwd: root, stdio: ['ignore', 'pipe', 'pipe'], detached: true, env: { ...process.env } })
      run.proc = child
      eachLine(child.stdout, line => this.onEvent(run, line))
      eachLine(child.stderr, line => {
        run.stderr.push(line.trimEnd())
        run.stderr.splice(0, run.stderr.length - MAX_STDERR)
      })
      run.exit_code = await new Promise<number>((resolve, reject) => {
        child.on('error', reject)
        child.on('close', (code, signal) => resolve(returnCode(code, signal)))
      })
    } catch (e) {                                   // reported on the run, never swallowed
      run.stderr.push(message(e))
      run.state = 'error'
    }
    if (run.state === 'running' && run.cancelRequested) {
      run.state = 'cancelled'
    } else if (run.state === 'running') {
      const status = run.end?.status
      run.state = status === 'passed' && run.exit_code === 0 ? 'passed' : run.end && status !== 'error' ? 'failed' : 'error'
    }
    if (run.op === 'route') fs.rmSync(run.argv[run.argv.indexOf('--spec') + 1], { force: true })  // the CLI keeps a copy
    run.persist()
    publish('run.state', run.summary())
  }

  private onEvent(run: Run, raw: string): void {
    const line = raw.trim()
    if (!line) return
    let parsed: unknown = null
    try { parsed = JSON.parse(line) } catch { /* plain output */ }
    let ev: Json = isObject(parsed) ? parsed : { type: 'output.text', text: line }
    run.run_id ||= (ev.run_id as string) ?? null
    if (ev.type === 'run.end') {
      run.end = ev
    } else if (!('type' in ev) && 'status' in ev && 'cause' in ev && run.end === null) {
      // Admission errors (bad spec, unknown board) print one bare {status, exit_code, cause} object.
      ev = { ...ev, type: 'run.end' }
      run.end = ev
    }
    run.events.push(ev)
    run.appendEvent(ev)
    run.events.splice(0, run.events.length - MAX_EVENTS)
    publish('run.event', { id: run.id, event: compact(ev) })
  }

  /** DRC violations and unconnected items of a finished run, with board positions (mm), from its drc.json. */
  findings(runId: string, root: string): Findings {
    const run = this.get(runId)
    const none: Findings = { id: runId, items: [], source: null }
    const gateResult = run.end?.gate_result
    if (!gateResult) return none
    const drc = path.join(path.dirname(String(gateResult)), 'drc.json')
    const rp = resolveReal(root)
    if (!isFile(drc) || !isInside(rp, resolveReal(drc))) return none
    interface Item { description?: string, pos?: { x: number, y: number } }
    interface Row { type?: string, severity?: string, description?: string, items?: Item[] }
    const data = JSON.parse(fs.readFileSync(drc, 'utf8')) as { violations?: Row[], unconnected_items?: Row[] }
    const items: Finding[] = []
    for (const [kind, rows] of [['violation', data.violations ?? []], ['unconnected', data.unconnected_items ?? []]] as const) {
      for (const v of rows) {
        const placed = (v.items ?? []).filter(i => i.pos)
        if (!placed.length) continue
        const mean = (axis: 'x' | 'y'): number => placed.reduce((s, i) => s + i.pos![axis], 0) / placed.length
        items.push({ kind, type: v.type ?? kind, severity: v.severity ?? 'error', description: v.description ?? '',
                     x: mean('x'), y: mean('y'),
                     items: placed.map(i => ({ description: i.description ?? '', x: i.pos!.x, y: i.pos!.y })) })
      }
    }
    const rank = (s: string): number => s === 'error' ? 0 : s === 'warning' ? 1 : 2
    items.sort((a, b) => (rank(a.severity) - rank(b.severity)) || (a.type < b.type ? -1 : a.type > b.type ? 1 : 0))
    return { id: runId, items, source: path.relative(rp, drc) }
  }

  /** `tools/pcb adopt RUN_ID --json`. The CLI re-verifies the sealed candidate, its evidence and the unchanged canonical
   *  inputs, takes the board writer lock, backs the original up into the run folder and atomically replaces only the
   *  canonical PCB. Its receipt: {board, target, before_sha256, after_sha256, candidate_run}. */
  async adopt(runId: string): Promise<Json> {
    const run = this.get(runId)
    const why = run.adoptable()
    if (why) throw new Error(`cannot adopt ${runId}: ${why}`)
    if (!run.run_id) throw new Error(`cannot adopt ${runId}: no CLI run id`)
    const target = run.candidate()?.target
    const busy = [...this.runs.values()].filter(r => r.adopting && r.root === run.root && r.candidate()?.target === target)
    if (busy.length) throw new Error(`cannot adopt ${runId}: run ${busy[0].id} is adopting into ${target} now`)
    run.adopting = true                             // set before the first await: a second adopt is refused
    let code: number, out: string, err: string
    try {
      ({ code, out, err } = await collect(toolOf(run.root!), ['adopt', run.run_id, '--json'], run.root!))
    } finally {
      run.adopting = false
    }
    const lines = out.split(/\r\n|\r|\n/).filter(ln => ln.trim())
    let data: unknown = {}
    try { data = lines.length ? JSON.parse(lines[lines.length - 1]) : {} } catch { /* stays {} */ }
    if (code !== 0 || !isObject(data) || !('after_sha256' in data)) {
      const cause = (isObject(data) ? data.cause as string : '') || err.trim().slice(-800) || (lines[lines.length - 1] ?? '')
      throw new Error(`tools/pcb adopt refused (exit ${code}): ${cause}`)
    }
    run.adoption = data
    run.persist()
    publish('run.state', run.summary())
    return data
  }

  /** Ask a running run to stop. The state becomes `cancelled` only when its process has exited. */
  cancel(runId: string): RunSummary {
    const run = this.get(runId)
    if (run.state === 'running') {
      run.cancelRequested = true
      const p = run.proc
      if (p?.pid !== undefined && p.exitCode === null && p.signalCode === null) killGroup(p.pid)   // the CLI cleans its family
    }
    return run.summary()
  }
}

function collect(cmd: string, args: string[], cwd: string): Promise<{ code: number, out: string, err: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { cwd, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env } })
    const out: Buffer[] = [], err: Buffer[] = []
    child.stdout.on('data', (d: Buffer) => out.push(d))
    child.stderr.on('data', (d: Buffer) => err.push(d))
    child.on('error', reject)
    child.on('close', (code, signal) => resolve({ code: returnCode(code, signal), out: Buffer.concat(out).toString(), err: Buffer.concat(err).toString() }))
  })
}

export const runs = new Runs()
