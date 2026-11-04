// The live board watch against real files: debounce, content hash, replace by rename, half-written files, cleanup.
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import type { TestContext } from 'node:test'
import { projectOpen, registry } from '../src/main/api.ts'
import { DEBOUNCE_MS, watchedBoards } from '../src/main/boardWatch.ts'
import { subscribe, unsubscribe } from '../src/main/events.ts'
import type { Sender } from '../src/main/events.ts'
import { rebasePick } from '../src/renderer/src/boardCache.ts'
import type { Pick } from '../src/renderer/src/boardCache.ts'
import type { Footprint, Geometry, Pad, Track } from '../src/shared/generated'

const PCB = 'hardware-design/boards/DEMO/DEMO.kicad_pcb'
const board = (w: number): string => `(kicad_pcb (version 20260206) (segment (start 0 0) (end 1 1) (width ${w}) (layer "F.Cu")))\n`
const SETTLE = DEBOUNCE_MS + 400                    // the debounce, plus file event latency
const settle = (): Promise<void> => new Promise(resolve => setTimeout(resolve, SETTLE))

interface Note { method: string, params: { pcb: string, sha256: string | null, error?: string } }
interface Client { send: Sender, notes: Note[], call: (method: string, params: unknown) => Promise<{ result?: { sha256?: string, watching?: boolean }, error?: { message: string } }> }

function client(t: TestContext): Client {
  const notes: Note[] = []
  const send: Sender = text => { notes.push(JSON.parse(text) as Note) }
  subscribe(send)
  t.after(() => unsubscribe(send))
  const call: Client['call'] = async (method, params) =>
    JSON.parse((await registry.handle(JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }), send))!) as Awaited<ReturnType<Client['call']>>
  return { send, notes, call }
}

/** A project with one board; returns the board's absolute path. */
function project(t: TestContext): string {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'watch-')))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  fs.mkdirSync(path.join(root, 'hardware-design/boards/DEMO'), { recursive: true })
  const file = path.join(root, PCB)
  fs.writeFileSync(file, board(0.2))
  projectOpen(root)
  return file
}

async function watching(t: TestContext): Promise<{ file: string, c: Client }> {
  const file = project(t), c = client(t)
  assert.match((await c.call('board.watch', { pcb: PCB })).result!.sha256!, /^[0-9a-f]{64}$/)
  await settle()                                    // events of the fixture's own write, if the OS delivers them late
  c.notes.length = 0
  return { file, c }
}

test('a burst of writes publishes one change with the final hash', async t => {
  const { file, c } = await watching(t)
  for (const w of [0.3, 0.4, 0.5]) fs.writeFileSync(file, board(w))
  await settle()
  assert.deepEqual(c.notes.map(n => n.method), ['board.changed'])
  assert.equal(c.notes[0].params.pcb, PCB)
  const again = await c.call('board.watch', { pcb: PCB })
  assert.equal(c.notes[0].params.sha256, again.result!.sha256)
})

test('a touch and a rewrite of the same bytes publish nothing', async t => {
  const { file, c } = await watching(t)
  const now = new Date()
  fs.utimesSync(file, now, now)
  fs.writeFileSync(file, board(0.2))
  await settle()
  assert.deepEqual(c.notes, [])
})

test('a file replaced by rename keeps being watched', async t => {
  const { file, c } = await watching(t)
  for (const w of [0.3, 0.4]) {
    fs.writeFileSync(`${file}.tmp`, board(w))
    fs.renameSync(`${file}.tmp`, file)
    await settle()
  }
  assert.deepEqual(c.notes.map(n => n.method), ['board.changed', 'board.changed'])
})

test('a half-written file is reported, and the finished file recovers', async t => {
  const { file, c } = await watching(t)
  fs.writeFileSync(file, board(0.3).slice(0, 30))
  await settle()
  assert.deepEqual(c.notes.map(n => n.method), ['board.invalid'])
  assert.match(c.notes[0].params.error!, /unbalanced/)
  fs.writeFileSync(file, board(0.2))                // back to the content of the baseline: still a recovery
  await settle()
  assert.deepEqual(c.notes.map(n => n.method), ['board.invalid', 'board.changed'])
})

test('a deleted file is reported once and its return is a change', async t => {
  const { file, c } = await watching(t)
  fs.rmSync(file)
  await settle()
  assert.deepEqual(c.notes.map(n => n.method), ['board.invalid'])
  assert.equal(c.notes[0].params.sha256, null)
  fs.writeFileSync(file, board(0.2))
  await settle()
  assert.deepEqual(c.notes.map(n => n.method), ['board.invalid', 'board.changed'])
})

test('board.unwatch stops the watch only after its last client', async t => {
  const { file, c } = await watching(t)
  const other = client(t)
  await other.call('board.watch', { pcb: PCB })
  assert.equal((await c.call('board.unwatch', { pcb: PCB })).result!.watching, true)
  assert.equal((await other.call('board.unwatch', { pcb: PCB })).result!.watching, false)
  assert.deepEqual(watchedBoards(), [])
  fs.writeFileSync(file, board(0.3))
  await settle()
  assert.deepEqual(c.notes, [])
})

test('a change waiting for its debounce dies with the watch', async t => {
  const { file, c } = await watching(t)
  fs.writeFileSync(file, board(0.3))
  await new Promise(resolve => setTimeout(resolve, 100))
  await c.call('board.unwatch', { pcb: PCB })
  await settle()
  assert.deepEqual(c.notes, [])
})

test('a client that disconnects stops watching', async t => {
  const { c } = await watching(t)
  assert.deepEqual(watchedBoards(), [PCB])
  unsubscribe(c.send)
  assert.deepEqual(watchedBoards(), [])
})

test('opening another project closes the watches', async t => {
  await watching(t)
  project(t)
  assert.deepEqual(watchedBoards(), [])
})

test('a watch needs a client and an existing file', async t => {
  project(t)
  const anonymous = JSON.parse((await registry.handle(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'board.watch', params: { pcb: PCB } })))!) as { error: { message: string } }
  assert.match(anonymous.error.message, /connected client/)
  const c = client(t)
  assert.match((await c.call('board.watch', { pcb: 'hardware-design/boards/DEMO/NONE.kicad_pcb' })).error!.message, /ENOENT/)
  assert.deepEqual(watchedBoards(), [])
})

const pad = (num: string, x: number): Pad => ({ num, x, y: 0 }) as Pad
const part = (ref: string, pads: Pad[]): Footprint => ({ ref, pads }) as Footprint
const track = (x2: number): Track => ({ x1: 0, y1: 0, x2, y2: 0, w: 0.2, layer: 'F.Cu', net: 'A' })
const geo = (footprints: Footprint[], tracks: Track[] = []): Geometry => ({ footprints, tracks }) as Geometry

test('a pick follows its item into the new geometry, or ends with it', () => {
  const old = part('U1', [pad('1', 1)])
  const moved = part('U1', [pad('1', 5)])
  const padPick: Pick = { kind: 'pad', fp: old, pad: old.pads[0] }
  assert.deepEqual(rebasePick(padPick, geo([moved])), { kind: 'pad', fp: moved, pad: moved.pads[0] })
  assert.equal(rebasePick(padPick, geo([part('U2', [pad('1', 1)])])), null)
  assert.equal(rebasePick(padPick, geo([part('U1', [pad('2', 1)])])), null)
  assert.deepEqual(rebasePick({ kind: 'part', fp: old }, geo([moved])), { kind: 'part', fp: moved })
  const same = track(3)
  assert.deepEqual(rebasePick({ kind: 'track', track: track(3) }, geo([], [track(9), same])), { kind: 'track', track: same })
  assert.equal(rebasePick({ kind: 'track', track: track(3) }, geo([], [track(9)])), null)
})

test('of pads sharing a number the nearest one stays picked', () => {
  const old = part('U1', [pad('1', 0), pad('1', 10)])
  const now = part('U1', [pad('1', 0.1), pad('1', 10.1)])
  assert.equal((rebasePick({ kind: 'pad', fp: old, pad: old.pads[1] }, geo([now])) as { pad: Pad }).pad, now.pads[1])
})
