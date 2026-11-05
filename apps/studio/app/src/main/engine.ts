// Engine supervisor: starts the engine process (engineMain, on this app's own binary running as Node), reads its READY
// line, keeps one WebSocket JSON-RPC connection, restarts the engine with backoff when it exits. The renderer reaches it
// only through IPC. Each engine process gets a new random token in its environment (not on the command line); the
// socket refuses connections without it (server.ts).
import { spawn, type ChildProcessWithoutNullStreams } from 'child_process'
import { randomBytes } from 'crypto'
import { EventEmitter } from 'events'
import { existsSync } from 'fs'
import type { EngineStatus } from '../preload/types'
import { toolPath } from './config'

type Pending = { resolve: (v: unknown) => void; reject: (e: Error) => void; timer: NodeJS.Timeout }

// Reply deadlines per method. Run starts (gate.check, op.*) return at once and finish through run.state
// notifications; these deadlines cover only work the engine does before it replies.
const DEFAULT_TIMEOUT_MS = 30_000
export const METHOD_TIMEOUT_MS: Record<string, number> = {
  'run.adopt': 30 * 60_000, // tools/pcb adopt re-verifies the sealed candidate before it replaces the board
  'board.glb': 10 * 60_000, // kicad-cli 3D export of a large board
  'live.model': 11 * 60_000,
  'board.geometry': 2 * 60_000,
  'board.bom': 2 * 60_000,
  'project.open': 60_000,
  'op.route': 2 * 60_000 // reads the board nets before the run starts
}
export const timeoutFor = (method: string): number => METHOD_TIMEOUT_MS[method] ?? DEFAULT_TIMEOUT_MS

export class EngineSupervisor extends EventEmitter {
  private proc: ChildProcessWithoutNullStreams | null = null
  private ws: WebSocket | null = null
  private nextId = 1
  private pending = new Map<number, Pending>()
  private stopping = false
  private backoffMs = 500
  private token = ''
  /** Increments each time a new engine process is connected: a run id is only meaningful in its project, and a
   * waiter for a run of an older engine generation knows that engine is gone. */
  generation = 0
  status: EngineStatus = { state: 'stopped', port: null, pid: null, restarts: 0, lastError: null }

  constructor(private engineEntry: string) {
    super()
  }

  start(): void {
    this.stopping = false
    this.setStatus({ state: this.status.restarts ? 'restarting' : 'starting', port: null, pid: null })
    let proc: ChildProcessWithoutNullStreams
    try {
      if (!existsSync(this.engineEntry)) throw new Error(`engine not found: ${this.engineEntry}`)
      this.token = randomBytes(32).toString('base64url')
      proc = spawn(process.execPath, [this.engineEntry, 'serve'], {
        env: { ...process.env, PATH: toolPath(), PCBSTUDIO_ENGINE_TOKEN: this.token, ELECTRON_RUN_AS_NODE: '1', NODE_NO_WARNINGS: '1' }
      })
    } catch (e) {
      this.setStatus({ state: 'stopped', lastError: String(e) })
      return
    }
    this.proc = proc
    this.setStatus({ pid: proc.pid ?? null })
    let buf = ''
    proc.stdout.on('data', (chunk: Buffer) => {
      buf += chunk.toString()
      let nl: number
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl).trim()
        buf = buf.slice(nl + 1)
        if (line.startsWith('READY ')) this.connect(JSON.parse(line.slice(6)).port as number)
        else if (line) this.emit('log', line)
      }
    })
    proc.stderr.on('data', (chunk: Buffer) => this.emit('log', chunk.toString().trimEnd()))
    proc.on('exit', (code, signal) => {
      this.proc = null
      this.ws?.close()
      this.ws = null
      this.failPending(new Error(`engine exited (code ${code}, signal ${signal})`))
      if (this.stopping) {
        this.setStatus({ state: 'stopped', port: null, pid: null })
        return
      }
      this.setStatus({ state: 'restarting', port: null, pid: null, restarts: this.status.restarts + 1,
        lastError: `engine exited (code ${code}, signal ${signal})` })
      setTimeout(() => this.start(), this.backoffMs)
      this.backoffMs = Math.min(this.backoffMs * 2, 10_000)
    })
  }

  private connect(port: number): void {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/?t=${encodeURIComponent(this.token)}`)
    ws.onopen = () => {
      this.ws = ws
      this.backoffMs = 500
      this.generation++
      this.setStatus({ state: 'ready', port })
    }
    ws.onmessage = (ev) => {
      const msg = JSON.parse(String(ev.data))
      if (msg.id === undefined && typeof msg.method === 'string') {
        this.emit('notify', { method: msg.method, params: msg.params })
        return
      }
      const p = this.pending.get(msg.id)
      if (!p) return
      this.pending.delete(msg.id)
      clearTimeout(p.timer)
      if (msg.error) p.reject(new Error(`${msg.error.code}: ${msg.error.message}`))
      else p.resolve(msg.result)
    }
    ws.onerror = () => this.setStatus({ lastError: 'engine socket error' })
  }

  call(method: string, params?: unknown, timeoutMs = timeoutFor(method)): Promise<unknown> {
    const ws = this.ws
    if (!ws || this.status.state !== 'ready') return Promise.reject(new Error(`engine not ready (${this.status.state})`))
    const id = this.nextId++
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error(`engine call ${method} timed out after ${Math.round(timeoutMs / 1000)} s`))
      }, timeoutMs)
      this.pending.set(id, { resolve, reject, timer })
      ws.send(JSON.stringify({ jsonrpc: '2.0', id, method, params }))
    })
  }

  /** Kill the engine process (used by the crash-recovery test and the debug menu). */
  kill(): void {
    this.proc?.kill('SIGKILL')
  }

  stop(): void {
    this.stopping = true
    this.proc?.stdin.end()
    setTimeout(() => this.proc?.kill(), 3000)
  }

  private failPending(err: Error): void {
    for (const p of this.pending.values()) {
      clearTimeout(p.timer)
      p.reject(err)
    }
    this.pending.clear()
  }

  private setStatus(patch: Partial<EngineStatus>): void {
    this.status = { ...this.status, ...patch }
    this.emit('status', this.status)
  }
}
