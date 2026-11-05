// The coordinator token stays in the engine, never in renderer messages.
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { publish } from './events.ts'
import { bbox, fromBytes } from './kicad/board.ts'

interface Config { url: string; tokenFile: string; label?: string }
interface State { epoch: string; cursor: number; events: unknown[]; truncated: boolean; label?: string }
class CoordinatorError extends Error {
  readonly status: number
  constructor(status: number) { super(`coordinator HTTP ${status}`); this.status = status }
}
function config(): Config {
  const file = process.env.PCB_LIVE_CONFIG ?? path.join(os.homedir(), '.config/pcb-live/config.json')
  const raw = JSON.parse(fs.readFileSync(file, 'utf8')) as Config
  if (typeof raw.url !== 'string' || typeof raw.tokenFile !== 'string') throw new Error('live coordinator is not configured')
  const url = new URL(raw.url)
  if (url.username || url.password || url.search || url.hash || url.pathname !== '/') throw new Error('invalid coordinator URL')
  if (url.protocol === 'http:') {
    const ip = url.hostname.split('.').map(Number)
    const tailnet = net.isIPv4(url.hostname) && ip[0] === 100 && ip[1] >= 64 && ip[1] <= 127
    if (!tailnet && url.hostname !== '127.0.0.1' && url.hostname !== '[::1]') throw new Error('HTTP coordinator requires a tailnet or loopback IP')
  } else if (url.protocol !== 'https:') throw new Error('invalid coordinator protocol')
  return { url: url.origin, tokenFile: raw.tokenFile.startsWith('~/') ? path.join(os.homedir(), raw.tokenFile.slice(2)) : raw.tokenFile,
    label: typeof raw.label === 'string' ? raw.label.slice(0, 100) : undefined }
}
async function get(endpoint: string, signal?: AbortSignal): Promise<Response> {
  const cfg = config(), token = fs.readFileSync(cfg.tokenFile, 'utf8').trim()
  if (token.length < 32) throw new Error('coordinator token is invalid')
  const response = await fetch(cfg.url + endpoint, { headers: { Authorization: `Bearer ${token}` }, redirect: 'error', signal })
  if (!response.ok) throw new CoordinatorError(response.status)
  return response
}
let abort: AbortController | null = null
let generation = 0
export async function openLive(): Promise<State> {
  const state = await (await get('/live/state', AbortSignal.timeout(5000))).json() as State
  if (typeof state.epoch !== 'string' || !Number.isSafeInteger(state.cursor) || !Array.isArray(state.events)) throw new Error('invalid coordinator state')
  state.label = config().label
  abort?.abort()
  abort = new AbortController()
  const gen = ++generation
  void follow(state.cursor, state.epoch, abort.signal, gen)
  return state
}
async function follow(cursor: number, epoch: string, signal: AbortSignal, gen: number): Promise<void> {
  while (!signal.aborted && gen === generation) {
    try {
      const response = await get(`/live/events?after=${cursor}&epoch=${encodeURIComponent(epoch)}&follow=1`, signal)
      if (!response.body) throw new Error('empty live stream')
      publish('live.connection', { state: 'connected' })
      const reader = response.body.getReader(), decoder = new TextDecoder()
      let pending = ''
      while (!signal.aborted) {
        const chunk = await reader.read()
        if (chunk.done) break
        pending += decoder.decode(chunk.value, { stream: true })
        if (pending.length > 2 * 1024 * 1024) throw new Error('live event too large')
        let end: number
        while ((end = pending.indexOf('\n\n')) >= 0) {
          const frame = pending.slice(0, end); pending = pending.slice(end + 2)
          const id = frame.split('\n').find(s => s.startsWith('id: '))?.slice(4)
          const data = frame.split('\n').find(s => s.startsWith('data: '))?.slice(6)
          if (!id || !data) continue
          const next = Number(id)
          if (!Number.isSafeInteger(next) || next <= cursor) continue
          const event = JSON.parse(data) as unknown
          cursor = next
          publish('live.event', event)
        }
      }
      if (!signal.aborted) throw new Error('coordinator stream ended')
    } catch (error) {
      if (signal.aborted) break
      if (error instanceof CoordinatorError && error.status === 409) {
        try {
          const state = await (await get('/live/state', AbortSignal.timeout(5000))).json() as State
          if (typeof state.epoch !== 'string' || !Number.isSafeInteger(state.cursor) || !Array.isArray(state.events)) throw new Error('invalid coordinator state')
          cursor = state.cursor; epoch = state.epoch
          publish('live.reset', state)
          continue
        } catch { /* report disconnect and retry below */ }
      }
      publish('live.connection', { state: 'disconnected', error: error instanceof Error ? error.message : String(error) })
      await new Promise<void>(resolve => {
        const done = (): void => { clearTimeout(t); signal.removeEventListener('abort', done); resolve() }
        const t = setTimeout(done, 3000)
        signal.addEventListener('abort', done, { once: true })
      })
    }
  }
}
async function blob(sha256: string): Promise<Buffer> {
  if (!/^[0-9a-f]{64}$/.test(sha256)) throw new Error('invalid board hash')
  const response = await get('/blobs/' + sha256, AbortSignal.timeout(15000))
  const size = Number(response.headers.get('content-length') ?? 0)
  if (size > 20 * 1024 * 1024) throw new Error('board snapshot too large')
  if (!response.body) throw new Error('empty board snapshot')
  const reader = response.body.getReader(), parts: Uint8Array[] = []
  let length = 0
  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    length += value.length
    if (length > 20 * 1024 * 1024) { await reader.cancel(); throw new Error('board snapshot too large') }
    parts.push(value)
  }
  const bytes = Buffer.concat(parts, length)
  if (createHash('sha256').update(bytes).digest('hex') !== sha256) throw new Error('board snapshot hash mismatch')
  return bytes
}

export async function liveGeometry(sha256: string): Promise<unknown> {
  const geo = fromBytes(await blob(sha256))
  return { ...geo, bbox: bbox(geo), pcb: `live:${sha256}` }
}

export async function livePreview(sha256: string): Promise<unknown> {
  const frame = JSON.parse((await blob(sha256)).toString('utf8')) as Record<string, unknown>
  if (frame.schema !== 'iot-lab.route-preview.v1' || !Array.isArray(frame.tracks) || !Array.isArray(frame.vias) ||
      frame.tracks.length > 500_000 || frame.vias.length > 100_000) throw new Error('invalid route preview')
  const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v)
  const point = (v: unknown): boolean => Array.isArray(v) && v.length === 2 && v.every(finite)
  if (!frame.tracks.every((t: Record<string, unknown>) => t && point(t.a) && point(t.b) && finite(t.w) && t.w > 0 && typeof t.layer === 'string' && typeof t.net === 'string') ||
      !frame.vias.every((v: Record<string, unknown>) => v && finite(v.x) && finite(v.y) && finite(v.d) && v.d > 0 && finite(v.drill) && typeof v.net === 'string'))
    throw new Error('invalid route preview geometry')
  return frame
}

export async function livePlacement(sha256: string): Promise<unknown> {
  const frame = JSON.parse((await blob(sha256)).toString('utf8')) as Record<string, unknown>
  if (frame.schema !== 'iot-lab.placement-preview.v1' || typeof frame.board_sha256 !== 'string' ||
      !/^[0-9a-f]{64}$/.test(frame.board_sha256) || !Array.isArray(frame.units) || frame.units.length > 100_000)
    throw new Error('invalid placement preview')
  const point = (v: unknown): boolean => Array.isArray(v) && v.length === 2 && v.every(x => typeof x === 'number' && Number.isFinite(x))
  if (!frame.units.every((u: Record<string, unknown>) => u && Array.isArray(u.refs) && u.refs.every(r => typeof r === 'string') &&
      point(u.origin) && point(u.position) && Number.isInteger(u.turn) && (u.turn as number) >= 0 && (u.turn as number) < 4))
    throw new Error('invalid placement geometry')
  return frame
}
