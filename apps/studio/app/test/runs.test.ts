// Runs, candidates and durable records, with a stand-in tools/pcb that writes
// CLI style run records. Run: node --test test/
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import type { TestContext } from 'node:test'
import { setTimeout as sleep } from 'node:timers/promises'
import { subscribe, unsubscribe } from '../src/main/events.ts'
import { Run, Runs, killGroup, routingPolicy } from '../src/main/runs.ts'

const REL = 'hardware-design/boards/DEMO/cad/DEMO/DEMO.kicad_pcb'
const CHECK = `#!/bin/sh
echo '{"schema_version": 1, "run_id": "run-test", "seq": 1, "type": "run.start", "board": "'$2'"}'
echo '{"schema_version": 1, "run_id": "run-test", "seq": 2, "type": "stage.start", "stage": "drc"}'
echo 'not json output line'
echo '{"schema_version": 1, "run_id": "run-test", "seq": 3, "type": "run.end", "status": "passed", "exit_code": 0, "cause": "all configured gate targets met", "metrics": {"drc_errors": 0}, "findings": [], "elapsed_s": 0.1}'
`
// $1 = op. route copies its --spec into the run folder so the test can read what was written. adopt replaces the canonical file.
const CANDIDATE = `#!/bin/sh
op=$1; board=$2
root=$(pwd); rid=run-$op-$board; ev=$root/.gate/cli/$rid; cand=$ev/workspace/${REL}
if [ "$op" = adopt ]; then
  rid=$2; ev=$root/.gate/cli/$rid; cand=$ev/workspace/${REL}
  [ -f "$cand" ] || { echo '{"status": "error", "exit_code": 2, "cause": "no such run"}'; exit 2; }
  tgt=$root/${REL}; cp "$tgt" "$ev/backup.kicad_pcb"; cp "$cand" "$tgt"
  echo "$rid" >> "$root/adopted"
  sleep 0.1
  echo '{"schema_version": 1, "board": "DEMO", "target": "'$tgt'", "before_sha256": "b", "after_sha256": "a", "candidate_run": "'$rid'", "adopted_at": 1}'
  exit 0
fi
if [ "$board" = NOPE ]; then echo '{"status": "error", "exit_code": 2, "cause": "unknown board NOPE"}'; exit 2; fi
mkdir -p $(dirname $cand)
if [ "$op" = route ]; then
  while [ $# -gt 0 ]; do [ "$1" = --spec ] && cp "$2" $ev/spec.json && echo "$2" > $ev/spec.path; [ "$1" = --timeout ] && echo $2 > $ev/timeout; shift; done
fi
echo candidate > $cand
echo '{"schema_version": 1, "run_id": "'$rid'", "seq": 1, "type": "run.start", "board": "'$board'"}'
if [ "$board" = bad ]; then st=failed; code=1; ver=false; else st=passed; code=0; ver=true; fi
echo '{"schema_version": 1, "run_id": "'$rid'", "seq": 3, "type": "run.end", "status": "'$st'", "exit_code": '$code', "cause": "candidate meets configured gate targets", "candidate_verified": '$ver', "identity_preserved": true, "candidate": "'$cand'", "candidate_sha256": "c0ffee", "metrics": {"drc_errors": 0, "unconnected": 3}, "scope": "candidate_board_gate", "operation": "'$op'", "gate_result": "'$ev'/gate/result.json", "evidence_dir": "'$ev'", "elapsed_s": 0.1}'
exit $code
`
const SLOW = `#!/bin/sh
board=$2
echo '{"schema_version": 1, "run_id": "run-'$board'", "seq": 1, "type": "run.start", "board": "'$board'"}'
if [ "$board" = SLOW ]; then echo $$ > "$(pwd)/slow.pid"; exec sleep 30; fi
echo '{"schema_version": 1, "run_id": "run-'$board'", "seq": 2, "type": "run.end", "status": "passed", "exit_code": 0, "cause": "ok", "metrics": {"drc_errors": 0}, "findings": [], "elapsed_s": 0.1}'
`

function project(t: TestContext, tool: string): string {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'runs-')))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  fs.mkdirSync(path.dirname(path.join(root, REL)), { recursive: true })
  fs.writeFileSync(path.join(root, REL), 'canonical\n')
  fs.mkdirSync(path.join(root, 'tools'))
  fs.writeFileSync(path.join(root, 'tools/pcb'), tool, { mode: 0o755 })
  return root
}

async function finish(run: Run): Promise<void> {
  for (let i = 0; i < 500 && run.state === 'running'; i++) await sleep(10)
  assert.notEqual(run.state, 'running', 'run did not end')
}

const record = (root: string, id: string): Record<string, unknown> =>
  JSON.parse(fs.readFileSync(path.join(root, '.gate/studio/runs', id, 'run.json'), 'utf8'))

test('a gate check streams its events', async t => {
  const root = project(t, CHECK), seen: string[] = [], states: string[] = []
  const send = (text: string): void => {
    const m = JSON.parse(text)
    if (m.method === 'run.event') seen.push(m.params.event.type)
    else states.push(m.params.state)
  }
  subscribe(send)
  t.after(() => unsubscribe(send))
  const r = new Runs(), run = r.start(root, 'check', 'DEMO')
  assert.equal(run.state, 'running')
  assert.match(run.id, /^r-[0-9a-f]{16}$/)
  assert.deepEqual(run.argv.slice(1), ['check', 'DEMO', '--fresh', '--json'])
  await finish(run)
  await sleep(10)
  assert.deepEqual(seen, ['run.start', 'stage.start', 'output.text', 'run.end'])
  assert.deepEqual(states, ['running', 'passed'])
  const s = run.summary()
  assert.equal(s.state, 'passed')
  assert.deepEqual(s.metrics, { drc_errors: 0 })
  assert.equal(s.run_id, 'run-test')
  assert.equal(s.adoptable, false)
})

test('an event longer than any stream buffer is read', async t => {
  const root = project(t, `#!/bin/sh
printf '{"run_id": "run-long", "type": "run.end", "status": "passed", "exit_code": 0, "cause": "'
head -c 200000 /dev/zero | tr '\\0' a
printf '"}\\n'
`)
  const run = new Runs().start(root, 'check', 'DEMO')
  await finish(run)
  assert.equal(run.state, 'passed')
  assert.equal(String(run.end!.cause).length, 200000)
})

test('route writes the spec, sets the deadline, removes the spec; adopt replaces the board once', async t => {
  const root = project(t, CANDIDATE), r = new Runs()
  const policy = routingPolicy(['F.Cu'], ['/A', 'GND'], 5, 30)
  const run = r.start(root, 'route', 'DEMO', { policy })
  assert.equal(run.mode, 'fastroute')
  await finish(run)
  const ev = path.join(root, '.gate/cli/run-route-DEMO')
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(ev, 'spec.json'), 'utf8')), policy)
  assert.equal(fs.readFileSync(path.join(ev, 'timeout'), 'utf8').trim(), '630')     // router + verification deadline
  assert.equal(fs.existsSync(fs.readFileSync(path.join(ev, 'spec.path'), 'utf8').trim()), false)
  const s = run.summary()
  assert.equal(s.state, 'passed')
  assert.equal(s.adoptable, true)
  assert.equal(s.candidate!.pcb, `.gate/cli/run-route-DEMO/workspace/${REL}`)
  assert.equal(s.candidate!.target, REL)
  assert.deepEqual(s.candidate!.metrics, { drc_errors: 0, unconnected: 3 })
  const receipt = await r.adopt(run.id)
  assert.equal(receipt.candidate_run, 'run-route-DEMO')
  assert.equal(fs.readFileSync(path.join(root, REL), 'utf8'), 'candidate\n')       // canonical board replaced
  assert.deepEqual(run.summary().adoption, receipt)
  await assert.rejects(r.adopt(run.id), /already adopted/)
})

test('two adopts at once run the CLI once', async t => {
  const root = project(t, CANDIDATE), r = new Runs()
  const run = r.start(root, 'build', 'DEMO')
  await finish(run)
  const [a, b] = await Promise.allSettled([r.adopt(run.id), r.adopt(run.id)])
  assert.equal(a.status, 'fulfilled')
  assert.equal(b.status, 'rejected')
  assert.match(String((b as PromiseRejectedResult).reason), /in progress/)
  assert.equal(run.adopting, false)
  assert.equal(fs.readFileSync(path.join(root, 'adopted'), 'utf8').trim().split('\n').length, 1)
  assert.deepEqual(record(root, run.id).adoption, (a as PromiseFulfilledResult<unknown>).value)  // receipt is durable
})

test('a failed candidate is not adoptable, and a check has no candidate', async t => {
  const root = project(t, CANDIDATE), r = new Runs()
  const run = r.start(root, 'build', 'bad')
  await finish(run)
  const s = run.summary()
  assert.equal(s.state, 'failed')
  assert.equal(s.adoptable, false)
  assert.equal(s.candidate!.verified, false)
  assert.equal(run.exit_code, 1)
  await assert.rejects(r.adopt(run.id), /run is failed/)
  const check = r.start(root, 'check', 'DEMO')
  await assert.rejects(r.adopt(check.id), /no candidate/)
  await finish(check)
})

test('an admission error is the terminal event', async t => {
  const run = new Runs().start(project(t, CANDIDATE), 'build', 'NOPE')
  await finish(run)
  const s = run.summary()
  assert.equal(s.state, 'error')
  assert.equal(s.cause, 'unknown board NOPE')
  assert.equal(s.candidate, null)
})

test('a refusal from the CLI is reported', async t => {
  const r = new Runs(), run = r.start(project(t, CANDIDATE), 'build', 'DEMO')
  await finish(run)
  run.run_id = 'run-missing'
  await assert.rejects(r.adopt(run.id), /tools\/pcb adopt refused \(exit 2\): no such run/)
  assert.equal(run.adopting, false)
})

test('a tool that cannot start is an error on the run', async t => {
  const root = project(t, CHECK)
  fs.chmodSync(path.join(root, 'tools/pcb'), 0o644)
  const run = new Runs().start(root, 'check', 'DEMO')
  await finish(run)
  assert.equal(run.state, 'error')
  assert.match(run.stderr.join(), /EACCES/)
  assert.equal(record(root, run.id).state, 'error')
})

test('bad input is refused before anything starts', t => {
  const root = project(t, CHECK), r = new Runs()
  assert.throws(() => r.start(root, 'erase', 'DEMO'), /unknown run op/)
  for (const board of ['', 'a/b', '-x']) assert.throws(() => r.start(root, 'check', board), /invalid board gate name/)
  assert.throws(() => r.start(root, 'route', 'DEMO'), /needs a routing policy/)
  assert.throws(() => r.start(path.join(root, 'nope'), 'check', 'DEMO'), /no tools\/pcb/)
  assert.throws(() => r.start(root, 'route', 'DEMO', { policy: routingPolicy(['F.Cu'], ['/A'], 1, 900), timeoutS: 10 }), /at least the router/)
  assert.equal(r.runs.size, 0)
})

test('the routing policy is validated', () => {
  assert.deepEqual(Object.keys(routingPolicy(['F.Cu', 'B.Cu'], ['/A'], 40, 30)).sort(),
                   ['layers', 'max_repairs', 'only_nets', 'optimizer', 'passes', 'schema', 'threads', 'timeout_s'])
  assert.throws(() => routingPolicy(['F.Cu'], [], 40, 30))
  assert.throws(() => routingPolicy(['F.Cu'], ['/A,/B'], 40, 30))
  assert.throws(() => routingPolicy(['F.Cu'], ['/A'], 0, 30))
  assert.throws(() => routingPolicy(['F.Cu', 'F.Cu'], ['/A'], 40, 30))
  assert.throws(() => routingPolicy(['F.Cu'], ['/A'], 40, 30, 1, 'always'))
})

test('cancel waits for the exit and tolerates a gone process', async t => {
  const root = project(t, SLOW), r = new Runs(), run = r.start(root, 'check', 'SLOW')
  for (let i = 0; i < 200 && !fs.existsSync(path.join(root, 'slow.pid')); i++) await sleep(10)
  const s = r.cancel(run.id)
  assert.equal(s.state, 'running')                  // not cancelled before the process exits
  assert.ok(run.cancelRequested)
  await finish(run)
  assert.equal(run.state, 'cancelled')
  assert.equal(r.cancel(run.id).state, 'cancelled') // cancel after the end: no error
  assert.equal(record(root, run.id).state, 'cancelled')
  assert.equal(run.exit_code, -15)
})

test('killing an exited process group does not throw', async () => {
  const p = spawn('true', { detached: true })
  await new Promise(resolve => p.on('close', resolve))
  killGroup(p.pid!)
})

test('runs survive an engine crash', async t => {
  const root = project(t, SLOW), first = new Runs()
  const fast = first.start(root, 'check', 'DEMO'), slow = first.start(root, 'check', 'SLOW')
  await finish(fast)
  for (let i = 0; i < 200 && !fs.existsSync(path.join(root, 'slow.pid')); i++) await sleep(10)
  await sleep(50)
  assert.equal(record(root, slow.id).state, 'running')
  const second = new Runs()                         // a new engine: the first one is gone, its record says running
  assert.equal(second.load(root), 2)
  assert.equal(second.load(root), 0)                // known runs are not loaded twice
  assert.equal(second.get(fast.id).state, 'passed')
  assert.deepEqual(second.get(fast.id).summary().metrics, { drc_errors: 0 })
  assert.equal(second.get(slow.id).state, 'interrupted')
  assert.deepEqual(second.get(fast.id).events.map(e => e.type), ['run.start', 'run.end'])
  assert.equal(record(root, slow.id).state, 'interrupted')    // the record itself is updated
  first.cancel(slow.id)
  await finish(slow)
})

test('a record written by the Python engine loads, and a broken one is skipped', t => {
  const root = project(t, CHECK), store = path.join(root, '.gate/studio/runs')
  const write = (id: string, text: string): void => {
    fs.mkdirSync(path.join(store, id), { recursive: true })
    fs.writeFileSync(path.join(store, id, 'run.json'), text)
  }
  write('r-0000000000000001', '{"id": "r-0000000000000001", "op": "build", "board": "DEMO", "mode": "build", "argv": ["x"], ' +
    '"policy": null, "started": 1800000000.25, "state": "failed", "exit_code": 1, "run_id": "run-1", ' +
    '"end": {"status": "failed", "cause": "no"}, "adoption": null, "stderr": ["boom"]}')
  fs.writeFileSync(path.join(store, 'r-0000000000000001/events.jsonl'), '{"type": "run.start"}\n{"type": "run.end"}\n{"torn')
  write('r-0000000000000002', 'not json')
  write('r-0000000000000003', '{"id": "other", "board": "B", "mode": "m", "argv": []}')       // id differs from its folder
  const r = new Runs()
  assert.equal(r.load(root), 1)
  const run = r.get('r-0000000000000001')
  assert.deepEqual([run.state, run.exit_code, run.started, run.summary().cause, run.stderr], ['failed', 1, 1800000000.25, 'no', ['boom']])
  assert.deepEqual(run.events.map(e => e.type), ['run.start', 'run.end'])
})

test('findings come from drc.json inside the project', t => {
  const root = project(t, CHECK), r = new Runs()
  const gate = path.join(root, '.gate/cli/x/gate')
  fs.mkdirSync(gate, { recursive: true })
  fs.writeFileSync(path.join(gate, 'drc.json'), JSON.stringify({
    violations: [{ type: 'b', severity: 'warning', description: 'w', items: [{ description: 'i', pos: { x: 1, y: 2 } }, { description: 'j', pos: { x: 3, y: 4 } }] },
                 { type: 'z', severity: 'error', items: [{ pos: { x: 0, y: 0 } }] }, { type: 'a', severity: 'error', items: [{ description: 'no position' }] }],
    unconnected_items: [{ items: [{ pos: { x: 5, y: 5 } }] }] }))
  const run = new Run('r-1', 'check', 'DEMO', 'fresh', [], root)
  run.end = { gate_result: path.join(gate, 'result.json') }
  r.runs.set(run.id, run)
  const f = r.findings('r-1', root)
  assert.equal(f.source, '.gate/cli/x/gate/drc.json')
  assert.deepEqual(f.items.map(i => [i.severity, i.type]), [['error', 'unconnected'], ['error', 'z'], ['warning', 'b']])
  assert.deepEqual([f.items[2].x, f.items[2].y, f.items[2].items.length], [2, 3, 2])
  run.end = { gate_result: '/tmp/outside/result.json' }
  assert.deepEqual(r.findings('r-1', root), { id: 'r-1', items: [], source: null })
  assert.throws(() => r.findings('r-2', root), /unknown run/)
})

test('a run outside any project keeps working in memory', () => {
  const run = new Run('r-2', 'check', 'DEMO', 'fresh', [], null)
  run.persist()
  run.appendEvent({})
  assert.equal(run.candidate(), null)
})
