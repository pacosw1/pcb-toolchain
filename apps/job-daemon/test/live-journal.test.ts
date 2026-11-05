import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { LiveJournal, packLiveState } from '../src/live-journal.ts'
import type { LiveEvent, LivePayload } from '../src/live-protocol.ts'
const base = 'a'.repeat(64)
const event = (seq: number, payload: LivePayload): LiveEvent => ({ schema: 'pcb-live.v1', runId: 'r', attemptId: 'try-1', seq, timeMs: seq * 100, baseSha256: base, ...payload })
const begin = event(1, { kind: 'run.started', data: { project: 'iot-lab', board: 'ENV-SENSE', host: 'linux', operation: 'routing', label: 'Route' } })
const snapshot = event(2, { kind: 'board.snapshot', data: { blobSha256: base, path: 'board.kicad_pcb', phase: 'routing', includesBaseCopper: true } })

test('journal survives restart, retries idempotently and seeks a past frame', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'live-journal-')), file = path.join(dir, 'live.sqlite')
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  let journal = new LiveJournal(file)
  assert.equal(journal.append([begin, snapshot]).appended, 2)
  for (let seq = 3; seq < 70; seq++) journal.append([event(seq, { kind: 'progress', data: { stage: 'routing', elapsedMs: seq * 100, message: `Pass ${seq}`, metrics: { pass: seq } } })])
  const last = packLiveState(journal.stateAt('r'))
  journal.close(); journal = new LiveJournal(file)
  assert.deepEqual(packLiveState(journal.stateAt('r')), last)
  assert.equal(journal.stateAt('r', 10).progress?.metrics.pass, 10)
  assert.equal(journal.append([begin, snapshot]).appended, 0)
  assert.equal(journal.events('r', 65, 4).at(-1)?.seq, 69)
  assert.equal(journal.list()[0].seq, 69)
  assert.throws(() => journal.append([{ ...begin, data: { ...begin.data, label: 'Changed' } } as LiveEvent]), /different content/)
  journal.close()
})

test('a rejected batch changes neither memory nor disk', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'live-journal-')), file = path.join(dir, 'live.sqlite')
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  const journal = new LiveJournal(file)
  journal.append([begin, snapshot])
  const before = packLiveState(journal.stateAt('r'))
  assert.throws(() => journal.append([
    event(3, { kind: 'progress', data: { stage: 'routing', elapsedMs: 300, message: 'tentative', metrics: {} } }),
    event(5, { kind: 'checkpoint', data: { label: 'gap', best: false } })
  ]), /sequence gap/)
  assert.deepEqual(packLiveState(journal.stateAt('r')), before)
  assert.equal(journal.lastSeq('r'), 2)
  assert.equal(journal.events('r').length, 2)
  journal.close()
})

test('terminal state and board revision boundaries survive checkpoint replay', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'live-journal-')), file = path.join(dir, 'live.sqlite')
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  const journal = new LiveJournal(file)
  const end = event(4, { kind: 'run.finished', data: { outcome: 'passed', message: 'Candidate produced', verified: false } })
  journal.append([begin, snapshot, event(3, { kind: 'checkpoint', data: { label: 'Before write', best: true } }), end])
  assert.equal(journal.stateAt('r', 3).finished, null)
  assert.equal(journal.stateAt('r').finished?.verified, false)
  assert.throws(() => journal.append([event(5, { kind: 'progress', data: { stage: 'routing', elapsedMs: 500, message: '', metrics: {} } })]), /terminal/)
  journal.close()
})
