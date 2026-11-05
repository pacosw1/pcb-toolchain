/** Read-only coordinator access. Credentials stay in the engine process. */
import fs from 'node:fs'
import { createHash } from 'node:crypto'
import { fromBytes, bbox } from './kicad/board.ts'
import { isDigest } from '../../../../job-daemon/src/live-protocol.ts'
const cache = new Map<string, ReturnType<typeof fromBytes>>()
async function request(route: string, signal?: AbortSignal): Promise<Response> {
  const url = process.env.JOBD_URL,
    file = process.env.JOBD_TOKEN_FILE
  if (!url || !file)
    throw new Error(
      'Configure JOBD_URL and JOBD_TOKEN_FILE in the Studio engine to view solver runs.'
    )
  const token = fs.readFileSync(file, 'utf8').trim()
  const response = await fetch(new URL(route, url), {
    headers: { authorization: `Bearer ${token}` },
    signal: signal ?? AbortSignal.timeout(15_000)
  })
  if (!response.ok) throw new Error(`Live coordinator returned ${response.status}`)
  return response
}
export async function liveRuns(): Promise<unknown> {
  return (await request('/live/runs')).json()
}
export async function liveEvents(run: string, after = 0): Promise<unknown> {
  if (typeof run !== 'string' || !run || !Number.isSafeInteger(after) || after < 0)
    throw new Error('Invalid live cursor')
  return (await request(`/live/runs/${encodeURIComponent(run)}/events?after=${after}`)).json()
}
export async function liveState(run: string, at?: number): Promise<unknown> {
  if (
    typeof run !== 'string' ||
    !run ||
    (at !== undefined && (!Number.isSafeInteger(at) || at < 0))
  )
    throw new Error('Invalid live position')
  return (
    await request(
      `/live/runs/${encodeURIComponent(run)}/state${at === undefined ? '' : `?at=${at}`}`
    )
  ).json()
}
export async function liveGeometry(sha: string): Promise<unknown> {
  if (!isDigest(sha)) throw new Error('Invalid live asset digest')
  let geo = cache.get(sha)
  if (!geo) {
    const response = await request(`/live/assets/${sha}`)
    if (Number(response.headers.get('content-length')) > 128 * 1024 * 1024)
      throw new Error('Live board is too large')
    const bytes = new Uint8Array(await response.arrayBuffer())
    if (
      bytes.length > 128 * 1024 * 1024 ||
      createHash('sha256').update(bytes).digest('hex') !== sha
    )
      throw new Error('Live asset integrity failure')
    geo = fromBytes(bytes)
    cache.set(sha, geo)
    if (cache.size > 4) cache.delete(cache.keys().next().value!)
  }
  return { ...geo, pcb: sha, bbox: bbox(geo) }
}

// Long-lived upstream SSE avoids paying a cross-machine round trip for each geometry frame.
import { onUnsubscribe } from './events.ts'
import type { Sender } from './events.ts'
import { validateLiveEvent } from '../../../../job-daemon/src/live-protocol.ts'
import type { LiveEvent } from '../../../../job-daemon/src/live-protocol.ts'
const observers = new Map<Sender, { run: string; abort: AbortController }>()
export function stopLive(client: unknown): { watching: false } {
  if (typeof client === 'function') {
    const send = client as Sender
    observers.get(send)?.abort.abort()
    observers.delete(send)
  }
  return { watching: false }
}
onUnsubscribe(stopLive)
export function watchLive(client: unknown, run: string, after = 0): { watching: true } {
  if (
    typeof client !== 'function' ||
    typeof run !== 'string' ||
    !run ||
    !Number.isSafeInteger(after) ||
    after < 0
  )
    throw new Error('Invalid live subscription')
  const send = client as Sender
  if (observers.get(send)?.run === run) return { watching: true }
  stopLive(send)
  const abort = new AbortController()
  observers.set(send, { run, abort })
  void forwardLive(run, after, send, abort.signal)
  return { watching: true }
}
async function forwardLive(
  run: string,
  after: number,
  send: Sender,
  signal: AbortSignal
): Promise<void> {
  let cursor = after,
    finished = false
  while (!signal.aborted && !finished) {
    let batch: LiveEvent[] = [],
      bytes = 0,
      timer: ReturnType<typeof setTimeout> | undefined
    let delivery = Promise.resolve()
    const flush = (): void => {
      clearTimeout(timer)
      timer = undefined
      if (!batch.length || signal.aborted) return
      const events = batch
      batch = []
      bytes = 0
      delivery = delivery
        .then(() =>
          send(JSON.stringify({ jsonrpc: '2.0', method: 'live.events', params: { run, events } }))
        )
        .catch(() => {
          stopLive(send)
        })
    }
    try {
      const response = await request(
        `/live/runs/${encodeURIComponent(run)}/stream?after=${cursor}`,
        signal
      )
      if (!response.body) throw new Error('Live stream has no response body')
      let pending = ''
      const decoder = new TextDecoder()
      for await (const chunk of response.body) {
        pending += decoder.decode(chunk, { stream: true })
        if (pending.length > 16 * 1024 * 1024) throw new Error('Live stream frame exceeds limit')
        let end: number
        while ((end = pending.indexOf('\n\n')) >= 0) {
          const frame = pending.slice(0, end)
          pending = pending.slice(end + 2)
          const data = frame
            .split('\n')
            .filter((l) => l.startsWith('data:'))
            .map((l) => l.slice(5).trimStart())
            .join('\n')
          if (!data) continue
          const event: unknown = JSON.parse(data)
          validateLiveEvent(event)
          if (event.runId !== run || event.seq !== cursor + 1)
            throw new Error('Live stream sequence mismatch')
          cursor = event.seq
          batch.push(event)
          bytes += data.length
          finished ||= event.kind === 'run.finished'
          if (!timer) timer = setTimeout(flush, 100)
          if (batch.length >= 64 || bytes >= 1024 * 1024) {
            flush()
            await delivery
          }
        }
      }
      flush()
      await delivery
    } catch (error) {
      flush()
      await delivery
      if (!signal.aborted)
        try {
          await send(
            JSON.stringify({
              jsonrpc: '2.0',
              method: 'live.error',
              params: { run, error: String(error) }
            })
          )
        } catch {
          stopLive(send)
        }
    } finally {
      clearTimeout(timer)
    }
    if (!signal.aborted && !finished)
      await new Promise<void>((resolve) => {
        const done = (): void => {
          clearTimeout(timer)
          signal.removeEventListener('abort', done)
          resolve()
        }
        const timer = setTimeout(done, 500)
        signal.addEventListener('abort', done, { once: true })
      })
  }
}
