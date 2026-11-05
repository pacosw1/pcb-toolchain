import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import http from 'node:http'
import { watchLive, stopLive } from '../src/main/live.ts'
import { subscribe, unsubscribe } from '../src/main/events.ts'

test('live relay reconnects by sequence and releases its upstream on disconnect', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'studio-live-relay-'))
  const token = path.join(dir, 'token')
  fs.writeFileSync(token, 'a'.repeat(64))
  const old = { url: process.env.JOBD_URL, token: process.env.JOBD_TOKEN_FILE }
  const cursors: string[] = [],
    got: number[] = []
  const base = { schema: 'pcb-live.v1', runId: 'r', attemptId: 'a', baseSha256: 'b'.repeat(64) }
  const server = http.createServer((req, res) => {
    assert.equal(req.headers.authorization, 'Bearer ' + 'a'.repeat(64))
    const after = new URL(req.url!, 'http://localhost').searchParams.get('after')!
    cursors.push(after)
    res.writeHead(200, { 'content-type': 'text/event-stream' })
    const emit = (seq: number, kind: string, data: unknown): void => {
      res.write(
        `id: ${seq}\ndata: ${JSON.stringify({ ...base, seq, timeMs: seq, kind, data })}\n\n`
      )
    }
    if (after === '0')
      emit(1, 'run.started', {
        project: 'p',
        board: 'b',
        host: 'h',
        operation: 'routing',
        label: 'test'
      })
    else {
      emit(2, 'progress', { stage: 'routing', elapsedMs: 1, message: 'search', metrics: {} })
      emit(3, 'run.finished', { outcome: 'failed', message: 'native failure', verified: false })
    }
    res.end()
  })
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  process.env.JOBD_URL = `http://127.0.0.1:${(server.address() as { port: number }).port}`
  process.env.JOBD_TOKEN_FILE = token
  let done!: () => void
  const complete = new Promise<void>((resolve) => {
    done = resolve
  })
  const send = (text: string): void => {
    const n = JSON.parse(text)
    if (n.method === 'live.events') {
      got.push(...n.params.events.map((e: { seq: number }) => e.seq))
      if (got.includes(3)) done()
    }
  }
  subscribe(send)
  try {
    watchLive(send, 'r', 0)
    const timeout = setTimeout(done, 5000)
    await complete
    clearTimeout(timeout)
    assert.deepEqual(got, [1, 2, 3])
    assert.deepEqual(cursors, ['0', '1'])
    unsubscribe(send)
    assert.deepEqual(stopLive(send), { watching: false })
  } finally {
    stopLive(send)
    unsubscribe(send)
    server.closeAllConnections()
    await new Promise<void>((r) => server.close(() => r()))
    if (old.url === undefined) delete process.env.JOBD_URL
    else process.env.JOBD_URL = old.url
    if (old.token === undefined) delete process.env.JOBD_TOKEN_FILE
    else process.env.JOBD_TOKEN_FILE = old.token
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('disconnect aborts a still-open upstream stream', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'studio-live-abort-'))
  const token = path.join(dir, 'token')
  fs.writeFileSync(token, 'c'.repeat(64))
  const old = { url: process.env.JOBD_URL, token: process.env.JOBD_TOKEN_FILE }
  let opened!: () => void, closed!: () => void
  const ready = new Promise<void>((r) => {
      opened = r
    }),
    stopped = new Promise<void>((r) => {
      closed = r
    })
  const server = http.createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' })
    res.write(': connected\n\n')
    res.on('close', closed)
    opened()
  })
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  process.env.JOBD_URL = `http://127.0.0.1:${(server.address() as { port: number }).port}`
  process.env.JOBD_TOKEN_FILE = token
  const send = (): void => {}
  subscribe(send)
  try {
    watchLive(send, 'open-run')
    await ready
    unsubscribe(send)
    let expired = false
    const timeout = setTimeout(() => {
      expired = true
      closed()
    }, 3000)
    await stopped
    clearTimeout(timeout)
    assert.equal(expired, false)
  } finally {
    stopLive(send)
    unsubscribe(send)
    server.closeAllConnections()
    await new Promise<void>((r) => server.close(() => r()))
    if (old.url === undefined) delete process.env.JOBD_URL
    else process.env.JOBD_URL = old.url
    if (old.token === undefined) delete process.env.JOBD_TOKEN_FILE
    else process.env.JOBD_TOKEN_FILE = old.token
    fs.rmSync(dir, { recursive: true, force: true })
  }
})
