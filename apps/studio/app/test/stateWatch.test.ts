// The board stage watch: the read comes from the CLI, a file change pushes a new read, and a same read pushes nothing.
// Time is not waited for: a test waits for the notification itself.
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import type { TestContext } from 'node:test'
import { projectOpen, registry } from '../src/main/api.ts'
import { subscribe, unsubscribe } from '../src/main/events.ts'
import type { Sender } from '../src/main/events.ts'
import { READ_ONLY } from '../src/main/web.ts'
import { createStateWatcher, readSnapshot } from '../src/main/stateWatch.ts'
import type { Deps, Snapshot } from '../src/main/stateWatch.ts'

interface Note { method: string, params: { board: string, rev: number, state?: { n: number }, error?: string } }

function client(t: TestContext): { send: Sender, notes: Note[], next: (method: string) => Promise<Note> } {
  const notes: Note[] = [], waiting: { method: string, resolve: (note: Note) => void }[] = []
  const send: Sender = text => {
    const note = JSON.parse(text) as Note
    notes.push(note)
    for (const wait of [...waiting]) if (wait.method === note.method) { waiting.splice(waiting.indexOf(wait), 1); wait.resolve(note) }
  }
  subscribe(send)
  t.after(() => unsubscribe(send))
  return { send, notes, next: method => new Promise(resolve => waiting.push({ method, resolve })) }
}

/** Fake reads and a fake file watch: a test fires a file event by hand. */
function fakes(output: () => Snapshot | Error) {
  const events: ((name: string | null) => void)[] = [], closed: string[] = [], counting: { n: number, resolve: () => void }[] = []
  let reads = 0
  const deps: Deps = {
    read: async () => {
      reads++
      for (const wait of [...counting]) if (reads >= wait.n) { counting.splice(counting.indexOf(wait), 1); wait.resolve() }
      const value = output()
      if (value instanceof Error) throw value
      return value
    },
    watchDir: (dir, _recursive, onEvent) => { events.push(onEvent); return () => closed.push(dir) },
    debounceMs: 0, maxWaitMs: 0
  }
  /** Resolves when the n-th read has run and its result is handled (the macrotask lets the promise chain finish). */
  const readReached = async (n: number): Promise<void> => {
    if (reads < n) await new Promise<void>(resolve => counting.push({ n, resolve }))
    await new Promise<void>(resolve => setImmediate(resolve))
  }
  return { deps, fire: (name: string | null = 'changes.jsonl') => events.forEach(onEvent => onEvent(name)), reads: () => reads, closed, readReached }
}

const view = (n: number): Snapshot => ({ state: { n }, history: { entries: [] } })

test('the first watch returns the read and publishes it with revision 1', async t => {
  const f = fakes(() => view(1)), c = client(t), watcher = createStateWatcher(f.deps)
  const first = c.next('state.changed')
  const result = await watcher.watch(c.send, '/p', 'CELLULAR-B')
  assert.deepEqual(result, { board: 'CELLULAR-B', rev: 1, ...view(1) })
  assert.equal((await first).params.rev, 1)
  watcher.unwatchAll()
})

test('a file change pushes a new read, and a burst of events is one read', async t => {
  let n = 1
  const f = fakes(() => view(n)), c = client(t), watcher = createStateWatcher(f.deps)
  await watcher.watch(c.send, '/p', 'B')
  n = 2
  const second = c.next('state.changed')
  f.fire(); f.fire(); f.fire()
  const note = await second
  assert.equal(note.params.rev, 2)
  assert.equal(note.params.state!.n, 2)
  assert.equal(f.reads(), 2)
  watcher.unwatchAll()
})

test('a change that leaves the read as it was publishes nothing', async t => {
  let n = 1
  const f = fakes(() => view(n)), c = client(t), watcher = createStateWatcher(f.deps)
  await watcher.watch(c.send, '/p', 'B')
  f.fire()                                           // same output: no push
  await f.readReached(2)
  assert.deepEqual(c.notes.map(note => note.params.rev), [1])
  n = 2
  const second = c.next('state.changed')
  f.fire()
  await second
  assert.deepEqual(c.notes.map(note => note.params.rev), [1, 2])
  watcher.unwatchAll()
})

test('logs and temp files are no change', async t => {
  let n = 1
  const f = fakes(() => view(n)), c = client(t), watcher = createStateWatcher(f.deps)
  await watcher.watch(c.send, '/p', 'B')
  f.fire('cli/run-a/worker.log'); f.fire('cad-seal.json.tmp')
  n = 2
  const second = c.next('state.changed')
  f.fire('cli/run-a/result.json')
  await second
  assert.equal(f.reads(), 2)
  watcher.unwatchAll()
})

test('the file watch closes with the last client', async t => {
  const f = fakes(() => view(1)), a = client(t), b = client(t), watcher = createStateWatcher(f.deps)
  await watcher.watch(a.send, '/p', 'B')
  await watcher.watch(b.send, '/p', 'B')
  assert.deepEqual(watcher.unwatch(a.send, 'B'), { board: 'B', watching: true })
  assert.equal(f.closed.length, 0)
  assert.deepEqual(watcher.unwatch(b.send, 'B'), { board: 'B', watching: false })
  assert.equal(f.closed.length, 2)                   // the board folder and .gate
  assert.deepEqual(watcher.boards(), [])
})

test('a client that disconnects stops watching', async t => {
  const f = fakes(() => view(1)), watcher = createStateWatcher(f.deps)
  const send: Sender = () => undefined
  subscribe(send)
  await watcher.watch(send, '/p', 'B')
  unsubscribe(send)
  assert.deepEqual(watcher.boards(), [])
})

test('a failed read is published as state.error and the first watch fails closed', async t => {
  const f = fakes(() => new Error('boom')), c = client(t), watcher = createStateWatcher(f.deps)
  const error = c.next('state.error')
  await assert.rejects(watcher.watch(c.send, '/p', 'B'), /boom/)
  assert.match((await error).params.error!, /boom/)
  assert.deepEqual(watcher.boards(), [])
})

test('a board name that is not a plain name is refused', async t => {
  const f = fakes(() => view(1)), c = client(t), watcher = createStateWatcher(f.deps)
  for (const board of ['', '../x', '--json', 'a/b', 'a b']) await assert.rejects(watcher.watch(c.send, '/p', board), /Invalid board name/)
  await assert.rejects(readSnapshot('/p', '../x'), /Invalid board name/)
  assert.equal(f.reads(), 0)
})

// A project with a fake tools/pcb: it prints the canned file of its command and exits with the canned code.
function project(t: TestContext): string {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'state-')))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  fs.mkdirSync(path.join(root, 'tools'))
  fs.mkdirSync(path.join(root, 'hardware-design/boards/DEMO'), { recursive: true })
  fs.writeFileSync(path.join(root, 'tools/pcb'), '#!/bin/sh\ncat "$2/.canned-$3.json"\nexit "$(cat "$2/.exit-$3" 2>/dev/null || echo 0)"\n', { mode: 0o755 })
  return root
}
const can = (root: string, command: string, value: unknown, exit = 0): void => {
  fs.writeFileSync(path.join(root, `.canned-${command}.json`), JSON.stringify(value))
  fs.writeFileSync(path.join(root, `.exit-${command}`), String(exit))
}
const STATE = { schema: 'iot-lab.board-state.v1', board: 'DEMO', states: [] }
const HISTORY = { schema: 'iot-lab.board-history.v1', board: 'DEMO', entries: [], problems: [] }

test('the CLI read keeps a history with problems and refuses a state that failed', async t => {
  const root = project(t)
  can(root, 'state', STATE)
  can(root, 'history', { ...HISTORY, problems: ['x'] }, 1)
  assert.deepEqual((await readSnapshot(root, 'DEMO')).history, { ...HISTORY, problems: ['x'] })
  can(root, 'state', STATE, 1)
  await assert.rejects(readSnapshot(root, 'DEMO'), /pcb state failed/)
  can(root, 'state', { schema: 'other' })
  await assert.rejects(readSnapshot(root, 'DEMO'), /pcb state failed/)
})

test('the viewer may read the stages and may not write', () => {
  for (const method of ['state.watch', 'state.unwatch']) assert.ok(READ_ONLY.has(method), method)
})

test('state.watch through the registry reads the CLI and pushes the next read after a file write', async t => {
  const root = project(t), c = client(t)
  can(root, 'state', { ...STATE, n: 1 })
  can(root, 'history', HISTORY)
  projectOpen(root)
  const call = async (method: string, params: unknown): Promise<{ result?: { rev?: number, state?: { n: number } }, error?: { message: string } }> =>
    JSON.parse((await registry.handle(JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }), c.send))!)
  const first = await call('state.watch', { board: 'DEMO' })
  assert.equal(first.result!.rev, 1)
  assert.equal(first.result!.state!.n, 1)
  can(root, 'state', { ...STATE, n: 2 })
  const second = c.next('state.changed')
  fs.writeFileSync(path.join(root, 'hardware-design/boards/DEMO/changes.jsonl'), '{}\n')
  const note = await second
  assert.deepEqual([note.params.board, note.params.rev, note.params.state!.n], ['DEMO', 2, 2])
  assert.equal((await call('state.unwatch', { board: 'DEMO' })).result!.rev, undefined)
})
