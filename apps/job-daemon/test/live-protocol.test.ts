import test from 'node:test'
import assert from 'node:assert/strict'
import { applyLiveEvent, emptyLiveState, replayLiveEvents, validateLiveEvent } from '../src/live-protocol.ts'
import type { LiveEvent, LivePayload } from '../src/live-protocol.ts'
const hash = 'a'.repeat(64)
const event = (seq: number, payload: LivePayload): LiveEvent => ({ schema: 'pcb-live.v1', runId: 'run', attemptId: 'one', seq, timeMs: seq * 100, baseSha256: hash, ...payload })
const start = event(1, { kind: 'run.started', data: { project: 'p', board: 'ENV-SENSE', host: 'mini', operation: 'build', label: 'Real run' } })
const board = event(2, { kind: 'board.snapshot', data: { blobSha256: hash, path: 'source.kicad_pcb', phase: 'routing', includesBaseCopper: true } })
const track = { id: 't1', net: 'SCL', layer: 'F.Cu', a: [0, 0] as [number, number], b: [1, 1] as [number, number], width: 0.2, locked: false }
const delta = event(3, { kind: 'route.delta', data: { addTracks: [track], addVias: [], removeTracks: [], removeVias: [] } })

test('live and replay reconstruct identical copper at each checkpoint', () => {
  const events: LiveEvent[] = [start, board, delta, event(4, { kind: 'checkpoint', data: { label: 'Pass 1', best: true } }),
    event(5, { kind: 'route.delta', data: { addTracks: [{ ...track, id: 't2', b: [3, 3] }], removeTracks: ['t1'], addVias: [], removeVias: [] } })]
  const live = emptyLiveState('run')
  for (const e of events) applyLiveEvent(live, e)
  const replay = replayLiveEvents('run', events)
  assert.deepEqual(live, replay)
  assert.deepEqual([...replay.tracks.keys()], ['t2'])
  assert.deepEqual([...replayLiveEvents('run', events, 4).tracks.keys()], ['t1'])
  assert.equal(events[2].kind, 'route.delta')
})

test('gaps, wrong bases and invalid transitions leave state untouched', () => {
  const state = replayLiveEvents('run', [start, board, delta]), before = structuredClone(state)
  assert.throws(() => applyLiveEvent(state, { ...delta, seq: 5 }), /sequence gap/)
  assert.throws(() => applyLiveEvent(state, { ...delta, seq: 4, baseSha256: 'b'.repeat(64) }), /revision mismatch/)
  assert.throws(() => applyLiveEvent(state, event(4, { kind: 'route.delta', data: { addTracks: [], removeTracks: ['absent'], addVias: [], removeVias: [] } })), /Unknown removed/)
  assert.deepEqual(state, before)
  const changed = event(4, { kind: 'board.snapshot', data: { blobSha256: 'b'.repeat(64), path: 'placed.kicad_pcb', phase: 'routing', includesBaseCopper: true } })
  applyLiveEvent(state, { ...changed, baseSha256: 'b'.repeat(64) })
  assert.equal(state.tracks.size, 0)
})

test('placement keeps current, previous and best poses distinct and preserves locks', () => {
  const pose = [{ ref: 'J1', x: 0, y: 0, rotation: 0, locked: true }, { ref: 'U1', x: 4, y: 4, rotation: 0, locked: false }]
  const first = event(3, { kind: 'placement.frame', data: { worker: 0, epoch: 1, step: 20, accepted: 10, rejected: 10, currentCost: 12, bestCost: 10,
    bestScope: 'attempt', current: pose, best: pose.map(p => ({ ...p, x: p.locked ? p.x : 3 })), terms: { wirelength: 12 } } })
  const state = replayLiveEvents('run', [start, board, first])
  const next = structuredClone(first); next.seq = 4; next.timeMs = 400
  if (next.kind !== 'placement.frame') throw new Error('test frame')
  next.data.current[1].x = 5
  applyLiveEvent(state, next)
  assert.equal(state.previousPlacement[1].x, 4)
  assert.equal(state.placement!.current[1].x, 5)
  assert.equal(state.placement!.best[1].x, 3)
  assert.equal(state.placement!.current[0].locked, true)
  next.data.current[1].x = 100
  assert.equal(state.placement!.current[1].x, 5)
})

test('malformed geometry and unsupported schemas are rejected', () => {
  assert.throws(() => validateLiveEvent({ ...start, schema: 'other' }))
  const bad = structuredClone(delta)
  if (bad.kind !== 'route.delta') throw new Error('test delta')
  bad.data.addTracks[0].width = NaN
  assert.throws(() => validateLiveEvent(bad), /payload/)
  bad.data.addTracks[0].width = -1
  assert.throws(() => validateLiveEvent(bad), /payload/)
})
