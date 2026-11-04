// Live board updates: watches open .kicad_pcb files and tells clients when the content changes. Replaces the polling
// loop of tools/live-view.py.
//
// The watch is on the parent directory, not the file: KiCad and most tools save by writing a temp file and renaming it
// over the board, and a watch on the file would stay on the old, replaced inode.
//
// Notifications (through events.ts, to every client; a client filters on `pcb`):
//   board.changed {pcb, sha256}         new content that parses; load it with board.geometry
//   board.invalid {pcb, sha256, error}  new content that does not parse, or a file that cannot be read (sha256 null);
//                                       the client keeps its last good board
// A touch, or any event that leaves the bytes as they were, publishes nothing.
//
// Limit: a move or delete of the board's directory itself gives no event on macOS; the watch then stays silent.
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { onUnsubscribe, publish } from './events.ts'
import { fromBytes } from './kicad/board.ts'

/** Quiet time after the last file event before the file is read. One save is a burst of events (write chunks, temp file,
 *  rename); this reads it once. 500 ms is the settle time tools/live-view.py has used on KiCad saves. */
export const DEBOUNCE_MS = 500
/** Longest wait from the first event of a burst, so a writer that never pauses for DEBOUNCE_MS still gets seen. */
export const MAX_WAIT_MS = 2000

const sha256 = (bytes: Buffer): string => createHash('sha256').update(bytes).digest('hex')

class Watch {
  readonly owners = new Set<unknown>()
  readonly pcb: string
  private file: string
  private seen: string | null                       // hash of the last content looked at, good or bad; null = unreadable
  private timer: NodeJS.Timeout | null = null
  private burstStart = 0
  private watcher: fs.FSWatcher

  constructor(pcb: string, file: string) {
    this.pcb = pcb
    this.file = file
    this.seen = sha256(fs.readFileSync(file))
    const base = path.basename(file)
    this.watcher = fs.watch(path.dirname(file), { persistent: false }, (_event, name) => {
      if (name === null || name === base) this.schedule()
    })
    this.watcher.on('error', e => {
      publish('board.invalid', { pcb, sha256: null, error: `file watch stopped: ${e.message}` })
      drop(this)
    })
  }

  get sha256(): string | null { return this.seen }

  private schedule(): void {
    const now = Date.now()
    if (this.timer) clearTimeout(this.timer)
    else this.burstStart = now
    const left = this.burstStart + MAX_WAIT_MS - now
    this.timer = setTimeout(() => this.check(), Math.max(0, Math.min(DEBOUNCE_MS, left)))
  }

  private check(): void {
    this.timer = null
    let bytes: Buffer
    try {
      bytes = fs.readFileSync(this.file)
    } catch (e) {
      if (this.seen !== null) publish('board.invalid', { pcb: this.pcb, sha256: null, error: `cannot read the board file: ${(e as Error).message}` })
      this.seen = null
      return
    }
    const digest = sha256(bytes)
    if (digest === this.seen) return
    this.seen = digest
    try {
      fromBytes(bytes)
    } catch (e) {
      publish('board.invalid', { pcb: this.pcb, sha256: digest, error: (e as Error).message })
      return
    }
    publish('board.changed', { pcb: this.pcb, sha256: digest })
  }

  close(): void {
    if (this.timer) clearTimeout(this.timer)
    this.timer = null
    this.watcher.close()
  }
}

const watches = new Map<string, Watch>()            // by project-relative pcb, as the clients name it

function drop(w: Watch): void {
  w.close()
  watches.delete(w.pcb)
}

/** Add `client` as a watcher of `pcb`. `file` is its absolute path. The hash is the baseline of later changes. */
export function watchBoard(client: unknown, pcb: string, file: string): { pcb: string, sha256: string | null } {
  if (client === undefined) throw new Error('board.watch needs a connected client')
  let w = watches.get(pcb)
  if (!w) {
    w = new Watch(pcb, file)
    watches.set(pcb, w)
  }
  w.owners.add(client)
  return { pcb, sha256: w.sha256 }
}

/** Remove `client` from `pcb`; the file watch closes with its last client. */
export function unwatchBoard(client: unknown, pcb: string): { pcb: string, watching: boolean } {
  const w = watches.get(pcb)
  if (w) {
    w.owners.delete(client)
    if (!w.owners.size) drop(w)
  }
  return { pcb, watching: watches.has(pcb) }
}

/** Close every watch (the engine switched to another project). */
export function unwatchAll(): void {
  for (const w of [...watches.values()]) drop(w)
}

export const watchedBoards = (): string[] => [...watches.keys()].sort()

// A client that disconnects stops watching, whatever it had open.
onUnsubscribe(client => {
  for (const w of [...watches.values()]) unwatchBoard(client, w.pcb)
})
