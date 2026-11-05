import { Readable } from 'node:stream'
import type http from 'node:http'
import fs from 'node:fs'
import path from 'node:path'
import { pipeline } from 'node:stream/promises'
import { BlobStore, isSha256 } from './blobs.ts'
import { openNoFollow } from './store.ts'
import { HttpError } from './types.ts'
import { LiveJournal, packLiveState } from './live-journal.ts'
import { validateLiveEvent } from './live-protocol.ts'
import type { LiveEvent } from './live-protocol.ts'

const send = (res: http.ServerResponse, body: unknown, status = 200): void => { res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' }); res.end(JSON.stringify(body) + '\n') }
const integer = (raw: string | null, fallback: number): number => {
  if (raw === null) return fallback
  if (!/^\d+$/.test(raw) || !Number.isSafeInteger(Number(raw))) throw new HttpError(400, 'Invalid live cursor')
  return Number(raw)
}
const delay = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms))
function drained(res: http.ServerResponse): Promise<void> {
  return new Promise(resolve => {
    const done = (): void => { res.off('drain', done); res.off('close', done); resolve() }
    res.once('drain', done); res.once('close', done)
    if (res.destroyed) done()
  })
}

export class LiveHttp {
  readonly journal: LiveJournal
  private readonly assets: BlobStore
  private readonly assetDir: string
  constructor(root: string, incoming: string) {
    this.journal = new LiveJournal(path.join(root, 'live.sqlite'))
    this.assetDir = path.join(root, 'live-assets')
    this.assets = new BlobStore(this.assetDir, incoming, 3650)
  }
  async importBoard(bytes: Buffer, sha: string): Promise<void> {
    if (this.assets.missing([sha]).length) await this.assets.put(Readable.from(bytes) as http.IncomingMessage, sha, 128*1024*1024)
  }
  close(): void { this.journal.close() }
  async handle(req: http.IncomingMessage, res: http.ServerResponse, url: URL,
    readJson: () => Promise<unknown>, maxUploadBytes: number, takeStream: () => () => void, takeUpload: () => () => void): Promise<boolean> {
    if (!url.pathname.startsWith('/live/')) return false
    const method = req.method ?? 'GET'
    if (url.pathname === '/live/runs' && method === 'GET') { send(res, { runs: this.journal.list() }); return true }
    if (url.pathname === '/live/events' && method === 'POST') {
      const body = await readJson(), events = (body as { events?: unknown } | null)?.events
      if (!Array.isArray(events)) throw new HttpError(400, 'Live events must be an array')
      try { for (const event of events) validateLiveEvent(event) } catch (error) { throw new HttpError(400, String(error)) }
      for (const event of events as LiveEvent[]) {
        if (event.kind === 'board.snapshot' && this.assets.missing([event.data.blobSha256]).length) throw new HttpError(409, 'Live source asset must be uploaded before its snapshot')
      }
      try { send(res, this.journal.append(events as LiveEvent[]), 201) }
      catch (error) { if (error instanceof Error && 'code' in error) throw error; throw new HttpError(409, error instanceof Error ? error.message : String(error)) }
      return true
    }
    const asset = /^\/live\/assets\/([a-f0-9]{64})$/.exec(url.pathname)
    if (asset) {
      if (!isSha256(asset[1])) throw new HttpError(400, 'Invalid live asset hash')
      if (method === 'PUT') {
        const release = takeUpload()
        try { await this.assets.put(req, asset[1], Math.min(maxUploadBytes, 128 * 1024 * 1024)); send(res, { sha256: asset[1] }, 201) } finally { release() }
        return true
      }
      if (method === 'GET' || method === 'HEAD') {
        const fd = openNoFollow(path.join(this.assetDir, asset[1]))
        if (fd === null) throw new HttpError(404, 'Live asset not found')
        const size = fs.fstatSync(fd).size
        if (size > 128 * 1024 * 1024) { fs.closeSync(fd); throw new HttpError(413, 'Live asset exceeds limit') }
        res.writeHead(200, { 'content-type': 'application/octet-stream', 'content-length': size, 'cache-control': 'private, immutable', etag: `"${asset[1]}"` })
        if (method === 'HEAD') { fs.closeSync(fd); res.end() }
        else await pipeline(fs.createReadStream('', { fd, autoClose: true }), res)
        return true
      }
    }
    const route = /^\/live\/runs\/([^/]+)\/(state|events|stream)$/.exec(url.pathname)
    if (route && method === 'GET') {
      let runId: string
      try { runId = decodeURIComponent(route[1]) } catch { throw new HttpError(400, 'Invalid run ID') }
      const last = this.journal.lastSeq(runId)
      if (last === null) throw new HttpError(404, 'Live run not found')
      if (route[2] === 'state') {
        const through = integer(url.searchParams.get('at'), last)
        if (through > last) throw new HttpError(409, 'Requested live position is ahead of the journal')
        send(res, { state: packLiveState(this.journal.stateAt(runId, through)), headSeq: last }); return true
      }
      const after = integer(url.searchParams.get('after') ?? (typeof req.headers['last-event-id'] === 'string' ? req.headers['last-event-id'] : null), 0)
      if (after > last) throw new HttpError(409, 'Live cursor is ahead of the journal')
      if (route[2] === 'events') {
        const limit = integer(url.searchParams.get('limit'), 500)
        if (limit < 1 || limit > 500) throw new HttpError(400, 'Live limit must be 1..500')
        const events = this.journal.events(runId, after, limit)
        send(res, { events, headSeq: last, next: events.at(-1)?.seq ?? after }); return true
      }
      const release = takeStream()
      try { await this.stream(res, runId, after) } finally { release() }
      return true
    }
    throw new HttpError(404, 'Live endpoint not found')
  }
  private async stream(res: http.ServerResponse, runId: string, after: number): Promise<void> {
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', 'x-accel-buffering': 'no' })
    let closed = false, cursor = after, heartbeat = Date.now()
    res.on('close', () => { closed = true })
    res.write(': pcb-live.v1\n\n')
    while (!closed) {
      const events = this.journal.events(runId, cursor, 128)
      for (const event of events) {
        if (closed) return
        const accepted = res.write(`id: ${event.seq}\ndata: ${JSON.stringify(event)}\n\n`)
        cursor = event.seq
        if (!accepted) await drained(res)
      }
      if (events.at(-1)?.kind === 'run.finished') { res.end(); return }
      if (!events.length) {
        if (cursor === this.journal.lastSeq(runId) && this.journal.isFinished(runId)) { res.end(); return }
        if (Date.now() - heartbeat > 5000) { res.write(': heartbeat\n\n'); heartbeat = Date.now() }
        await delay(100)
      }
    }
  }
}
