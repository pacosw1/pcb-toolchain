// Engine supervisor: starts `pcbstudio serve` (uv), reads its READY line, keeps one WebSocket JSON-RPC
// connection, restarts the engine with backoff when it exits. The renderer reaches it only through IPC.
import { spawn, type ChildProcessWithoutNullStreams } from 'child_process'
import { EventEmitter } from 'events'
import { existsSync } from 'fs'
import { delimiter, join } from 'path'

export type EngineState = 'starting' | 'ready' | 'restarting' | 'stopped'
export interface EngineStatus {
  state: EngineState
  port: number | null
  pid: number | null
  restarts: number
  lastError: string | null
}

type Pending = { resolve: (v: unknown) => void; reject: (e: Error) => void; timer: NodeJS.Timeout }

const EXTRA_PATH = ['/opt/homebrew/bin', '/usr/local/bin', join(process.env.HOME ?? '', '.local/bin')]

function findUv(): string {
  if (process.env.PCBSTUDIO_UV) return process.env.PCBSTUDIO_UV
  const dirs = (process.env.PATH ?? '').split(delimiter).concat(EXTRA_PATH)
  for (const d of dirs) {
    const p = join(d, 'uv')
    if (d && existsSync(p)) return p
  }
  throw new Error('uv not found (set PCBSTUDIO_UV)')
}

export class EngineSupervisor extends EventEmitter {
  private proc: ChildProcessWithoutNullStreams | null = null
  private ws: WebSocket | null = null
  private nextId = 1
  private pending = new Map<number, Pending>()
  private stopping = false
  private backoffMs = 500
  status: EngineStatus = { state: 'stopped', port: null, pid: null, restarts: 0, lastError: null }

  constructor(private engineDir: string) {
    super()
  }

  start(): void {
    this.stopping = false
    this.setStatus({ state: this.status.restarts ? 'restarting' : 'starting', port: null, pid: null })
    let proc: ChildProcessWithoutNullStreams
    try {
      proc = spawn(findUv(), ['run', '--project', this.engineDir, 'pcbstudio', 'serve'], {
        env: { ...process.env, PATH: [process.env.PATH ?? '', ...EXTRA_PATH].join(delimiter) }
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
    const ws = new WebSocket(`ws://127.0.0.1:${port}`)
    ws.onopen = () => {
      this.ws = ws
      this.backoffMs = 500
      this.setStatus({ state: 'ready', port })
    }
    ws.onmessage = (ev) => {
      const msg = JSON.parse(String(ev.data))
      const p = this.pending.get(msg.id)
      if (!p) return
      this.pending.delete(msg.id)
      clearTimeout(p.timer)
      if (msg.error) p.reject(new Error(`${msg.error.code}: ${msg.error.message}`))
      else p.resolve(msg.result)
    }
    ws.onerror = () => this.setStatus({ lastError: 'engine socket error' })
  }

  call(method: string, params?: unknown, timeoutMs = 30_000): Promise<unknown> {
    const ws = this.ws
    if (!ws || this.status.state !== 'ready') return Promise.reject(new Error(`engine not ready (${this.status.state})`))
    const id = this.nextId++
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error(`engine call ${method} timed out`))
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
