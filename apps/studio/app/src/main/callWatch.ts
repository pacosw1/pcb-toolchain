// Tool call log view: reads `<project>/.gate/calls.jsonl` (one start line and one end line for each `tools/pcb` call) and the run
// starts in `.gate/cli/*/events.jsonl`, and tells clients when they change. The engine stores nothing. The renderer maps the
// lines to a timeline (callRows.ts). The log is a record for people: no gate reads it.
//
// Notifications (through events.ts, to every client):
//   calls.changed {rev, calls, runs}   a read that differs from the last one; a full snapshot; `rev` counts them
//   calls.error   {rev, error}         a read that failed; the client keeps its last good view
//
// One watch for the open project, on .gate (recursive). A burst of events is one read (debounce). Logs and temp files are no
// change. A read that equals the last one publishes nothing.
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { DEBOUNCE_MS, MAX_WAIT_MS } from './boardWatch.ts'
import { onUnsubscribe, publish } from './events.ts'
import { realDeps as stateDeps } from './stateWatch.ts'
import type { Closer, WatchDir } from './stateWatch.ts'

export interface CallsSnapshot {
  calls: unknown[]
  runs: { id: string; board: string; at: string }[]
}
export interface CallDeps {
  read: (root: string) => Promise<CallsSnapshot>
  watchDir: WatchDir
  debounceMs: number
  maxWaitMs: number
}

/** A call log larger than this is read from its end. */
const MAX_BYTES = 8 * 1024 * 1024
const MAX_RUNS = 500
const FIRST_LINE_BYTES = 16 * 1024
const NOISE = /\.(log|tmp|lock)$/

function lines(text: string): unknown[] {
  const out: unknown[] = []
  for (const line of text.split('\n')) {
    if (!line.trim()) continue
    try {
      out.push(JSON.parse(line))
    } catch {
      /* a half written or damaged line is skipped */
    }
  }
  return out
}

function readTail(file: string): string {
  let fd: number
  try {
    fd = fs.openSync(file, 'r')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return ''
    throw error
  }
  try {
    const { size } = fs.fstatSync(fd),
      start = Math.max(0, size - MAX_BYTES),
      buffer = Buffer.alloc(size - start)
    fs.readSync(fd, buffer, 0, buffer.length, start)
    const text = buffer.toString('utf8')
    return start ? text.slice(text.indexOf('\n') + 1) : text // the first line of a cut read is partial
  } finally {
    fs.closeSync(fd)
  }
}

function firstLine(file: string): string {
  let fd: number
  try {
    fd = fs.openSync(file, 'r')
  } catch {
    return ''
  }
  try {
    const buffer = Buffer.alloc(FIRST_LINE_BYTES),
      n = fs.readSync(fd, buffer, 0, buffer.length, 0)
    return buffer.toString('utf8', 0, n).split('\n')[0] ?? ''
  } finally {
    fs.closeSync(fd)
  }
}

/** The lines of the call log and the starts of the runs of the project (the newest MAX_RUNS). */
export async function readCalls(root: string): Promise<CallsSnapshot> {
  const gate = path.join(root, '.gate'),
    calls = lines(readTail(path.join(gate, 'calls.jsonl'))),
    runs: CallsSnapshot['runs'] = []
  let names: string[] = []
  try {
    names = fs.readdirSync(path.join(gate, 'cli'))
  } catch {
    /* no run yet */
  }
  for (const name of names) {
    const [event] = lines(firstLine(path.join(gate, 'cli', name, 'events.jsonl'))) as {
      type?: string
      run_id?: string
      board?: string
      time?: string
    }[]
    if (event?.type === 'run.start' && event.run_id && event.board && event.time)
      runs.push({ id: event.run_id, board: event.board, at: event.time })
  }
  runs.sort((a, b) => Date.parse(a.at) - Date.parse(b.at))
  return { calls, runs: runs.slice(-MAX_RUNS) }
}

export const realDeps: CallDeps = {
  read: readCalls,
  watchDir: stateDeps.watchDir,
  debounceMs: DEBOUNCE_MS,
  maxWaitMs: MAX_WAIT_MS
}

const digest = (snapshot: CallsSnapshot): string =>
  createHash('sha256').update(JSON.stringify(snapshot)).digest('hex')

class CallWatch {
  readonly owners = new Set<unknown>()
  rev = 0
  private last: { hash: string; snapshot: CallsSnapshot } | null = null
  private timer: ReturnType<typeof setTimeout> | null = null
  private burstStart = 0
  private reading: Promise<void> | null = null
  private again = false
  private closer: Closer | null = null

  readonly root: string
  private deps: CallDeps

  constructor(root: string, deps: CallDeps, onStop: (w: CallWatch) => void) {
    this.root = root
    this.deps = deps
    try {
      this.closer = deps.watchDir(
        path.join(root, '.gate'),
        true,
        (name) => {
          if (name === null || !NOISE.test(name)) this.schedule()
        },
        (error) => {
          publish('calls.error', {
            rev: this.rev,
            error: `file watch stopped: ${error.message}`
          })
          onStop(this)
        }
      )
    } catch {
      /* a .gate that does not exist yet has nothing to watch */
    }
  }

  refresh(): Promise<CallsSnapshot & { rev: number }> {
    const done = (this.reading ??= this.loop())
    return done.then(() => ({ ...this.last!.snapshot, rev: this.rev }))
  }

  private async loop(): Promise<void> {
    try {
      do {
        this.again = false
        const snapshot = await this.deps.read(this.root),
          hash = digest(snapshot)
        if (hash !== this.last?.hash) {
          this.last = { hash, snapshot }
          this.rev++
          publish('calls.changed', { rev: this.rev, ...snapshot })
        }
      } while (this.again)
    } catch (error) {
      publish('calls.error', { rev: this.rev, error: (error as Error).message })
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
        if (this.reading) this.again = true
        else this.refresh().catch(() => undefined) // the error is published as calls.error
      },
      Math.max(0, Math.min(this.deps.debounceMs, left))
    )
  }

  close(): void {
    if (this.timer) clearTimeout(this.timer)
    this.timer = null
    this.closer?.()
    this.closer = null
  }
}

export interface CallWatcher {
  watch: (client: unknown, root: string) => Promise<CallsSnapshot & { rev: number }>
  unwatch: (client: unknown) => { watching: boolean }
  unwatchAll: () => void
  active: () => boolean
}

export function createCallWatcher(deps: CallDeps = realDeps): CallWatcher {
  let current: CallWatch | null = null
  const drop = (w: CallWatch): void => {
    w.close()
    if (current === w) current = null
  }
  const unwatch: CallWatcher['unwatch'] = (client) => {
    if (current) {
      current.owners.delete(client)
      if (!current.owners.size) drop(current)
    }
    return { watching: current !== null }
  }
  onUnsubscribe((client) => {
    unwatch(client)
  })
  return {
    async watch(client, root) {
      if (client === undefined) throw new Error('calls.watch needs a connected client')
      if (current && current.root !== root) drop(current)
      const w = (current ??= new CallWatch(root, deps, drop))
      w.owners.add(client)
      try {
        return await w.refresh()
      } catch (error) {
        unwatch(client) // a client whose first read failed holds no watch
        throw error
      }
    },
    unwatch,
    unwatchAll: () => {
      if (current) drop(current)
    },
    active: () => current !== null
  }
}
