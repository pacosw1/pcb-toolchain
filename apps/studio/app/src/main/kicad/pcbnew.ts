// Client of KiCad's own pcbnew, isolated in a subprocess of KiCad's bundled Python.
// The server is resources/pcbnew_worker.py: Python, because it is the one place that needs the pcbnew API. This client starts `<kicad python> -I SCRIPT --serve` and talks one JSON object
// per line.
//
// Request  {"id": n, "op": "...", ...params}
// Reply    {"id": n, "ok": true, "result": ...} | {"id": n, "ok": false, "error": "..."}
//
// Headless pcbnew can crash or assert. A crash, an exit or a timeout of the subprocess rejects with WorkerError; the
// next call starts a fresh worker. Calls run one at a time.
import { spawn } from 'node:child_process'
import type { ChildProcessWithoutNullStreams } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import readline from 'node:readline'

const MAC_PY = '/Applications/KiCad/KiCad.app/Contents/Frameworks/Python.framework/Versions/Current/bin/python3'
const PROBE_TIMEOUT_MS = 30_000
const CLOSE_TIMEOUT_MS = 10_000
const STDERR_LINES = 200

/** The worker died, timed out or answered with an error. */
export class WorkerError extends Error {}

const isFile = (p: string): boolean => { try { return fs.statSync(p).isFile() } catch { return false } }

function canImportPcbnew(python: string): Promise<boolean> {
  return new Promise(resolve => {
    const p = spawn(python, ['-c', 'import pcbnew'], { stdio: 'ignore', timeout: PROBE_TIMEOUT_MS })
    p.on('error', () => resolve(false))
    p.on('close', code => resolve(code === 0))
  })
}

/** PCBSTUDIO_KICAD_PYTHON, then the macOS KiCad app, then a `python3` on PATH that can import pcbnew. */
export async function findKicadPython(): Promise<string | null> {
  const env = process.env.PCBSTUDIO_KICAD_PYTHON
  if (env) return isFile(env) ? env : null
  if (isFile(MAC_PY)) return MAC_PY
  for (const dir of (process.env.PATH ?? '').split(path.delimiter)) {
    const p = path.join(dir || '.', 'python3')
    if (isFile(p) && await canImportPcbnew(p)) return p
  }
  return null
}

interface Reply { id?: number, ok?: boolean, result?: unknown, error?: string }

/** One running server. `next` gives the next stdout line, or null once stdout has closed. */
class Session {
  readonly proc: ChildProcessWithoutNullStreams
  readonly stderr: string[] = []
  readonly exited: Promise<number | string | null>
  private lines: (string | null)[] = []
  private waiter: ((line: string | null) => void) | null = null
  running = true

  constructor(python: string, script: string) {
    this.proc = spawn(python, ['-I', script, '--serve'], { stdio: ['pipe', 'pipe', 'pipe'] })
    this.proc.stdin.on('error', () => { /* a dead worker shows as stdout closing */ })
    this.exited = new Promise(resolve => {
      this.proc.on('error', e => {
        this.stderr.push(e.message)
        this.running = false
        this.push(null)
        resolve(null)
      })
      this.proc.on('close', (code, signal) => {
        this.running = false
        resolve(code ?? signal)
      })
    })
    const out = readline.createInterface({ input: this.proc.stdout })
    out.on('line', line => this.push(line))
    out.on('close', () => this.push(null))
    readline.createInterface({ input: this.proc.stderr }).on('line', line => {
      if (line.includes('Adding duplicate image handler')) return
      this.stderr.push(line)
      this.stderr.splice(0, this.stderr.length - STDERR_LINES)
    })
  }

  private push(line: string | null): void {
    if (this.waiter) {
      const w = this.waiter
      this.waiter = null
      w(line)
    } else {
      this.lines.push(line)
    }
  }

  /** The next line, null at the end, undefined after timeoutMs. */
  next(timeoutMs: number): Promise<string | null | undefined> {
    if (this.lines.length) return Promise.resolve(this.lines.shift()!)
    return new Promise(resolve => {
      const timer = setTimeout(() => {
        this.waiter = null
        resolve(undefined)
      }, timeoutMs)
      this.waiter = line => {
        clearTimeout(timer)
        resolve(line)
      }
    })
  }
}

export interface WorkerOptions {
  script: string                    // path of pcbnew_worker.py
  python?: string
  timeoutS?: number
}

export class PcbnewWorker {
  private readonly script: string
  private readonly timeoutS: number
  private python: string | null
  private session: Session | null = null
  private nextId = 0
  private queue: Promise<unknown> = Promise.resolve()

  constructor(options: WorkerOptions) {
    this.script = options.script
    this.python = options.python ?? null
    this.timeoutS = options.timeoutS ?? 300
  }

  private async fail(msg: string): Promise<WorkerError> {
    const s = this.session
    this.session = null
    let code: number | string | null = null
    if (s) {
      if (s.running) s.proc.kill('SIGKILL')
      code = await Promise.race([s.exited, new Promise<null>(r => { setTimeout(() => r(null), CLOSE_TIMEOUT_MS).unref() })])
    }
    const tail = s ? s.stderr.slice(-15).join('\n') : ''
    return new WorkerError(`pcbnew worker ${msg} (exit ${code})` + (tail ? `:\n${tail}` : ''))
  }

  private async send(op: string, params: Record<string, unknown>, timeoutS?: number): Promise<unknown> {
    this.python ??= await findKicadPython()
    if (!this.python) throw new WorkerError('KiCad Python with pcbnew not found (set PCBSTUDIO_KICAD_PYTHON)')
    if (!this.session?.running) this.session = new Session(this.python, this.script)
    const session = this.session
    const id = ++this.nextId
    session.proc.stdin.write(JSON.stringify({ id, op, ...params }) + '\n')
    const timeoutMs = (timeoutS ?? this.timeoutS) * 1000
    for (;;) {
      const line = await session.next(timeoutMs)
      if (line === undefined) throw await this.fail(`timed out on '${op}'`)
      if (line === null) throw await this.fail(`stopped during '${op}'`)
      let msg: Reply
      try { msg = JSON.parse(line) as Reply } catch { continue }   // not protocol: fd 1 goes to stderr
      if (msg.id !== id) continue
      if (!msg.ok) throw new WorkerError(`${op}: ${msg.error}`)
      return msg.result
    }
  }

  /** One operation; calls wait their turn. */
  call<T = unknown>(op: string, params: Record<string, unknown> = {}, timeoutS?: number): Promise<T> {
    const run = (): Promise<unknown> => this.send(op, params, timeoutS)
    const result = this.queue.then(run, run)
    this.queue = result.catch(() => undefined)
    return result as Promise<T>
  }

  async close(): Promise<void> {
    await this.queue
    const s = this.session
    this.session = null
    if (!s) return
    s.proc.stdin.end()
    const timer = setTimeout(() => s.proc.kill('SIGKILL'), CLOSE_TIMEOUT_MS)
    await s.exited
    clearTimeout(timer)
  }
}
