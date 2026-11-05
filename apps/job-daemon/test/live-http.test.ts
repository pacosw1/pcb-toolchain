import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import type { AddressInfo } from 'node:net'
import { createServer } from '../src/server.ts'
import { rig, TOKEN } from './helpers.ts'
import type { LiveEvent, LivePayload } from '../src/live-protocol.ts'
const source = Buffer.from('(kicad_pcb (version 20260101))')
const hash = createHash('sha256').update(source).digest('hex')
const event = (seq: number, payload: LivePayload): LiveEvent => ({ schema: 'pcb-live.v1', runId: 'run-1', attemptId: 'attempt-1', seq, timeMs: seq * 100, baseSha256: hash, ...payload })
const start = event(1, { kind: 'run.started', data: { project: 'p', board: 'ENV-SENSE', host: 'mini', operation: 'routing', label: 'Route' } })
const board = event(2, { kind: 'board.snapshot', data: { blobSha256: hash, path: 'source.kicad_pcb', phase: 'routing', includesBaseCopper: true } })
const done = event(3, { kind: 'run.finished', data: { outcome: 'passed', message: 'candidate', verified: false } })
const auth = { authorization: `Bearer ${TOKEN}` }

test('authenticated live stream replays exactly after reconnect and daemon restart', async () => {
  const r = rig()
  let server = createServer(r.mgr)
  const listen = async (): Promise<string> => { await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve)); return `http://127.0.0.1:${(server.address() as AddressInfo).port}` }
  let base = await listen()
  const post = (events: LiveEvent[]): Promise<Response> => fetch(base + '/live/events', { method: 'POST', headers: { ...auth, 'content-type': 'application/json' }, body: JSON.stringify({ events }) })
  try {
    assert.equal((await fetch(base + '/live/runs')).status, 401)
    assert.equal((await post([start, board])).status, 409)
    assert.equal((await fetch(base + '/live/assets/' + hash, { method: 'PUT', headers: auth, body: source })).status, 201)
    assert.equal((await post([start, board])).status, 201)
    const controller = new AbortController()
    const response = await fetch(base + '/live/runs/run-1/stream?after=1', { headers: auth, signal: controller.signal })
    const reader = response.body!.getReader(); let text = ''
    while (!text.includes('id: 2')) text += new TextDecoder().decode((await reader.read()).value)
    assert.ok(!text.includes('id: 1'))
    controller.abort(); await reader.cancel().catch(() => undefined)
    assert.equal((await post([done])).status, 201)
    server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve()))
    server = createServer(r.mgr); base = await listen()
    const replay = await (await fetch(base + '/live/runs/run-1/stream?after=2', { headers: auth })).text()
    assert.ok(replay.includes('id: 3')); assert.ok(!replay.includes('id: 2'))
    const state = await (await fetch(base + '/live/runs/run-1/state?at=2', { headers: auth })).json()
    assert.equal(state.state.seq, 2); assert.equal(state.state.finished, null); assert.equal(state.headSeq, 3)
    assert.equal((await (await post([start, board, done])).json()).appended, 0)
    assert.equal((await fetch(base + '/live/runs/run-1/events?after=4', { headers: auth })).status, 409)
    assert.deepEqual(Buffer.from(await (await fetch(base + '/live/assets/' + hash, { headers: auth })).arrayBuffer()), source)
  } finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); r.cleanup() }
})
