// Board stage view: reads `pcb state BOARD --json` and `pcb history BOARD --json` (both read only) and tells clients when
// the files they read change. The engine stores nothing: the CLI is the only source of the position and of the log.
//
// Notifications (through events.ts, to every client; a client filters on `board`):
//   state.changed {board, rev, state, history}  a new read that differs from the last one; `rev` counts them
//   state.error   {board, rev, error}           a read that failed; the client keeps its last good view
//
// The watch is on the board folder and on .gate (recursive), not on single files: tools save by writing a temp file and
// renaming it. A burst of events is one read (debounce). A read whose output equals the last one publishes nothing.
//
// Limit: .gate that does not exist when the watch starts is not watched until the next state.watch.
import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { DEBOUNCE_MS, MAX_WAIT_MS } from './boardWatch.ts'
import { onUnsubscribe, publish } from './events.ts'

export interface Snapshot {
  state: unknown
  history: unknown
}
export type Read = (root: string, board: string) => Promise<Snapshot>
export type Closer = () => void
/** Starts a watch on `dir`; calls `onEvent` with the path below `dir` of each change. */
export type WatchDir = (
  dir: string,
  recursive: boolean,
  onEvent: (name: string | null) => void,
  onError: (error: Error) => void
) => Closer
export interface Deps {
  read: Read
  watchDir: WatchDir
  debounceMs: number
  maxWaitMs: number
}

const BOARD = /^[A-Za-z0-9][A-Za-z0-9._-]*$/
const STATE_SCHEMA = 'iot-lab.board-state.v1'
const HISTORY_SCHEMA = 'iot-lab.board-history.v1'
const READ_TIMEOUT_MS = 60_000
/** Logs and temp files change all the time while a run works and are no evidence. */
export const NOISE = /(\.(log|tmp|lock)|(^|\/)calls\.jsonl)$/

/** The `tools/pcb` of the project, else the one of PCB_TOOLCHAIN_ROOT (a project with no tools of its own). */
export function toolOf(root: string): string {
  for (const base of [root, process.env.PCB_TOOLCHAIN_ROOT]) {
    const tool = base ? path.join(base, 'tools', 'pcb') : ''
    if (tool && fs.existsSync(tool) && fs.statSync(tool).isFile()) return tool
  }
  throw new Error(`no tools/pcb in ${root} or in PCB_TOOLCHAIN_ROOT`)
}

function run(
  tool: string,
  root: string,
  args: string[]
): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    execFile(
      tool,
      ['--project', root, ...args],
      {
        cwd: root,
        timeout: READ_TIMEOUT_MS,
        maxBuffer: 64 * 1024 * 1024,
        env: { ...process.env, PCB_CALLER: 'studio' }
      },
      (error, stdout, stderr) => {
        const code = (error as { code?: unknown } | null)?.code
        if (error && typeof code !== 'number')
          return reject(new Error(`${path.basename(tool)} ${args[0]}: ${error.message}`))
        resolve({ code: typeof code === 'number' ? code : 0, stdout, stderr })
      }
    )
  })
}

function parse(
  label: string,
  out: { code: number; stdout: string; stderr: string },
  schema: string,
  okCodes: number[]
): unknown {
  let value: { schema?: unknown } | null = null
  try {
    value = JSON.parse(out.stdout) as { schema?: unknown }
  } catch {
    /* below */
  }
  if (!okCodes.includes(out.code) || value?.schema !== schema)
    throw new Error(
      `pcb ${label} failed (exit ${out.code}): ${(out.stderr || out.stdout).trim().slice(0, 400)}`
    )
  return value
}

/** The state and the history of a board, from the CLI. `pcb history` exits 1 when a source has a problem and still prints the log. */
export const readSnapshot: Read = async (root, board) => {
  if (!BOARD.test(board)) throw new Error('Invalid board name')
  const tool = toolOf(root)
  const [state, history] = await Promise.all([
    run(tool, root, ['state', board, '--json']),
    run(tool, root, ['history', board, '--json'])
  ])
  return {
    state: parse('state', state, STATE_SCHEMA, [0]),
    history: parse('history', history, HISTORY_SCHEMA, [0, 1])
  }
}

const watchFs: WatchDir = (dir, recursive, onEvent, onError) => {
  const watcher = fs.watch(dir, { persistent: false, recursive }, (_event, name) => onEvent(name))
  watcher.on('error', onError)
  return () => watcher.close()
}

export const realDeps: Deps = {
  read: readSnapshot,
  watchDir: watchFs,
  debounceMs: DEBOUNCE_MS,
  maxWaitMs: MAX_WAIT_MS
}

const digest = (snapshot: Snapshot): string =>
  createHash('sha256').update(JSON.stringify(snapshot)).digest('hex')

class StateWatch {
  readonly owners = new Set<unknown>()
  rev = 0
  private last: { hash: string; snapshot: Snapshot } | null = null
  private timer: ReturnType<typeof setTimeout> | null = null
  private burstStart = 0
  private reading: Promise<void> | null = null
  private again = false
  private closers: Closer[] = []

  readonly root: string
  readonly board: string
  private deps: Deps

  constructor(root: string, board: string, deps: Deps, onStop: (w: StateWatch) => void) {
    this.root = root
    this.board = board
    this.deps = deps
    const onEvent = (name: string | null): void => {
      if (name === null || !NOISE.test(name)) this.schedule()
    }
    const onError = (error: Error): void => {
      publish('state.error', {
        board,
        rev: this.rev,
        error: `file watch stopped: ${error.message}`
      })
      onStop(this)
    }
    const dirs: [string, boolean][] = [
      [path.join(root, 'hardware-design', 'boards', board), false],
      [path.join(root, '.gate'), true]
    ]
    for (const [dir, recursive] of dirs) {
      try {
        this.closers.push(deps.watchDir(dir, recursive, onEvent, onError))
      } catch {
        /* a folder that does not exist yet has nothing to watch */
      }
    }
  }

  /** The read now. Publishes when the output differs from the last one. Resolves with the newest view or throws the read error. */
  refresh(): Promise<Snapshot & { rev: number }> {
    const done = (this.reading ??= this.loop())
    return done.then(() => ({ ...this.last!.snapshot, rev: this.rev }))
  }

  private async loop(): Promise<void> {
    try {
      do {
        this.again = false
        const snapshot = await this.deps.read(this.root, this.board),
          hash = digest(snapshot)
        if (hash !== this.last?.hash) {
          this.last = { hash, snapshot }
          this.rev++
          publish('state.changed', { board: this.board, rev: this.rev, ...snapshot })
        }
      } while (this.again)
    } catch (error) {
      publish('state.error', { board: this.board, rev: this.rev, error: (error as Error).message })
      throw error
    } finally {
      this.reading = null
    }
  }

  private schedule(): void {
    const now = Date.now()
    if (this.timer) clearTimeout(this.timer)
    else this.burstStart = now
    const left = this.burstStart + this.deps.maxWaitMs - now
    this.timer = setTimeout(
      () => {
        this.timer = null
        this.fire()
      },
      Math.max(0, Math.min(this.deps.debounceMs, left))
    )
  }

  /** The read after a change. A change during a read asks for one more read. */
  private fire(): void {
    if (this.reading) this.again = true
    else this.refresh().catch(() => undefined) // the error is published as state.error
  }

  close(): void {
    if (this.timer) clearTimeout(this.timer)
    this.timer = null
    for (const closer of this.closers) closer()
    this.closers = []
  }
}

export interface StateWatcher {
  watch: (
    client: unknown,
    root: string,
    board: string
  ) => Promise<Snapshot & { board: string; rev: number }>
  unwatch: (client: unknown, board: string) => { board: string; watching: boolean }
  unwatchAll: () => void
  /** The boards that have a watch now. */
  boards: () => string[]
}

export function createStateWatcher(deps: Deps = realDeps): StateWatcher {
  const watches = new Map<string, StateWatch>()
  const drop = (w: StateWatch): void => {
    w.close()
    watches.delete(w.board)
  }
  const unwatch: StateWatcher['unwatch'] = (client, board) => {
    const w = watches.get(board)
    if (w) {
      w.owners.delete(client)
      if (!w.owners.size) drop(w)
    }
    return { board, watching: watches.has(board) }
  }
  onUnsubscribe((client) => {
    for (const w of [...watches.values()]) unwatch(client, w.board)
  })
  return {
    async watch(client, root, board) {
      if (client === undefined) throw new Error('state.watch needs a connected client')
      if (!BOARD.test(board)) throw new Error('Invalid board name')
      let w = watches.get(board)
      if (w && w.root !== root) {
        drop(w)
        w = undefined
      }
      if (!w) {
        w = new StateWatch(root, board, deps, drop)
        watches.set(board, w)
      }
      w.owners.add(client)
      try {
        return { board, ...(await w.refresh()) }
      } catch (error) {
        unwatch(client, board) // a client whose first read failed holds no watch
        throw error
      }
    },
    unwatch,
    unwatchAll: () => {
      for (const w of [...watches.values()]) drop(w)
    },
    boards: () => [...watches.keys()].sort()
  }
}
