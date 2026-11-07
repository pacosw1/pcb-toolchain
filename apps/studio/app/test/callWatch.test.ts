// The call log watch: the engine reads .gate/calls.jsonl and the run starts, and pushes a full snapshot when they change.
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
import { createCallWatcher, readCalls } from '../src/main/callWatch.ts'
import type { CallDeps, CallsSnapshot } from '../src/main/callWatch.ts'

interface Note {
  method: string
  params: { rev: number; calls?: { id: string }[]; error?: string }
}

function client(t: TestContext): { send: Sender; next: (method: string) => Promise<Note> } {
  const waiting: { method: string; resolve: (note: Note) => void }[] = []
  const send: Sender = (text) => {
    const note = JSON.parse(text) as Note
    for (const wait of [...waiting])
      if (wait.method === note.method) {
        waiting.splice(waiting.indexOf(wait), 1)
        wait.resolve(note)
      }
  }
  subscribe(send)
  t.after(() => unsubscribe(send))
  // The watcher is not persistent, so the timer holds the event loop open until the note comes, and bounds the wait.
  const next = (method: string): Promise<Note> =>
    new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`no ${method} in 5 s`)), 5000)
      waiting.push({ method, resolve: (note) => (clearTimeout(timer), resolve(note)) })
    })
  return { send, next }
}

function fakes(output: () => CallsSnapshot | Error): {
  deps: CallDeps
  fire: (name?: string | null) => void
  reads: () => number
  closed: string[]
  watched: string[]
} {
  const events: ((name: string | null) => void)[] = [],
    closed: string[] = [],
    watched: string[] = []
  let reads = 0
  const deps: CallDeps = {
    read: async () => {
      reads++
      const value = output()
      if (value instanceof Error) throw value
      return value
    },
    watchDir: (dir, _recursive, onEvent) => {
      watched.push(dir)
      events.push(onEvent)
      return () => closed.push(dir)
    },
    debounceMs: 0,
    maxWaitMs: 0
  }
  return {
    deps,
    fire: (name: string | null = 'calls.jsonl') => events.forEach((onEvent) => onEvent(name)),
    reads: () => reads,
    closed,
    watched
  }
}
const snap = (...ids: string[]): CallsSnapshot => ({
  calls: ids.map((id) => ({ id })),
  runs: []
})

test('the first watch returns the read with revision 1, publishes it, and watches .gate', async (t) => {
  const f = fakes(() => snap('a')),
    c = client(t),
    watcher = createCallWatcher(f.deps)
  const first = c.next('calls.changed')
  const result = await watcher.watch(c.send, '/p')
  assert.deepEqual(result, { rev: 1, ...snap('a') })
  assert.equal((await first).params.rev, 1)
  assert.deepEqual(f.watched, ['/p/.gate'])
  watcher.unwatchAll()
})

test('a write to the call log pushes the next snapshot, and an equal read pushes nothing', async (t) => {
  let ids = ['a']
  const f = fakes(() => snap(...ids)),
    c = client(t),
    watcher = createCallWatcher(f.deps)
  await watcher.watch(c.send, '/p')
  ids = ['a', 'b']
  const second = c.next('calls.changed')
  f.fire('calls.jsonl')
  const note = await second
  assert.equal(note.params.rev, 2)
  assert.deepEqual(
    note.params.calls!.map((call) => call.id),
    ['a', 'b']
  )
  f.fire('cli/run-a/events.jsonl') // a run event: same snapshot, no push
  ids = ['a', 'b', 'c']
  const third = c.next('calls.changed')
  f.fire('calls.jsonl')
  assert.equal((await third).params.rev, 3) // the equal read in between took no revision
  watcher.unwatchAll()
})

test('logs and temp files are no change', async (t) => {
  let ids = ['a']
  const f = fakes(() => snap(...ids)),
    c = client(t),
    watcher = createCallWatcher(f.deps)
  await watcher.watch(c.send, '/p')
  f.fire('cli/run-a/worker.log')
  f.fire('cad-seal.json.tmp')
  ids = ['a', 'b']
  const second = c.next('calls.changed')
  f.fire('calls.jsonl')
  await second
  assert.equal(f.reads(), 2) // the noise started no read
  watcher.unwatchAll()
})

test('a failed read is published as calls.error, the first watch fails and holds no watch', async (t) => {
  const f = fakes(() => new Error('disk gone')),
    c = client(t),
    watcher = createCallWatcher(f.deps)
  const note = c.next('calls.error')
  await assert.rejects(watcher.watch(c.send, '/p'), /disk gone/)
  assert.match((await note).params.error!, /disk gone/)
  assert.equal(watcher.active(), false)
})

test('the file watch closes with the last client, and a disconnect drops the client', async (t) => {
  const f = fakes(() => snap('a')),
    a = client(t),
    b = client(t),
    watcher = createCallWatcher(f.deps)
  await watcher.watch(a.send, '/p')
  await watcher.watch(b.send, '/p')
  assert.deepEqual(f.closed, [])
  watcher.unwatch(a.send)
  assert.deepEqual(f.closed, [])
  unsubscribe(b.send) // the client goes away
  assert.deepEqual(f.closed, ['/p/.gate'])
  assert.equal(watcher.active(), false)
})

// ---- the real read ----------------------------------------------------------------------------------------------------

function project(t: TestContext): string {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'calls-')))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  fs.mkdirSync(path.join(root, '.gate/cli/run-x'), { recursive: true })
  fs.mkdirSync(path.join(root, 'hardware-design/boards'), { recursive: true })
  return root
}

test('a project with no call log has an empty snapshot', async (t) => {
  assert.deepEqual(await readCalls(project(t)), { calls: [], runs: [] })
})

test('the read keeps good lines, skips a broken line, and takes run starts from the first event of each run', async (t) => {
  const root = project(t)
  fs.writeFileSync(
    path.join(root, '.gate/calls.jsonl'),
    '{"schema":"iot-lab.cli-call.v1","id":"a","phase":"start","at":"2026-11-07T08:00:00.000Z","command":"state","args":["B"]}\n' +
      'not json\n' +
      '{"schema":"iot-lab.cli-call.v1","id":"a","phase":"end","at":"2026-11-07T08:00:01.000Z","exit_code":0,"signal":null}\n'
  )
  fs.writeFileSync(
    path.join(root, '.gate/cli/run-x/events.jsonl'),
    '{"run_id":"run-x","type":"run.start","time":"2026-11-07T08:00:02.000+00:00","board":"B"}\n{"type":"x"}\n'
  )
  fs.mkdirSync(path.join(root, '.gate/cli/run-y'))
  fs.writeFileSync(path.join(root, '.gate/cli/run-y/events.jsonl'), '{"type":"other"}\n')
  const out = await readCalls(root)
  assert.deepEqual(
    out.calls.map((call) => (call as { phase: string }).phase),
    ['start', 'end']
  )
  assert.deepEqual(out.runs, [{ id: 'run-x', board: 'B', at: '2026-11-07T08:00:02.000+00:00' }])
})

test('the viewer may read the calls and may not write', () => {
  for (const method of ['calls.watch', 'calls.unwatch']) assert.ok(READ_ONLY.has(method), method)
})

test('calls.watch through the registry reads the log and pushes the next read after a file write', async (t) => {
  const root = project(t),
    c = client(t)
  projectOpen(root)
  const call = async (
    method: string
  ): Promise<{ result?: { rev?: number; calls?: unknown[] }; error?: { message: string } }> =>
    JSON.parse(
      (await registry.handle(
        JSON.stringify({ jsonrpc: '2.0', id: 1, method, params: {} }),
        c.send
      ))!
    )
  const first = await call('calls.watch')
  assert.equal(first.result!.rev, 1)
  assert.deepEqual(first.result!.calls, [])
  const second = c.next('calls.changed')
  fs.writeFileSync(
    path.join(root, '.gate/calls.jsonl'),
    '{"schema":"iot-lab.cli-call.v1","id":"a","phase":"start","at":"2026-11-07T08:00:00.000Z","command":"state","args":[]}\n'
  )
  const note = await second
  assert.equal(note.params.rev, 2)
  assert.equal(note.params.calls!.length, 1)
  await call('calls.unwatch')
})
