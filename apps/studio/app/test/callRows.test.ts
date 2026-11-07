// The tool call timeline: a pure map from the call log (.gate/calls.jsonl) and the run starts to lanes, ticks and totals.
import assert from 'node:assert/strict'
import test from 'node:test'
import { ago, buildTimeline, formatDuration } from '../src/renderer/src/callRows.ts'
import type { CallRecord, RunMark } from '../src/renderer/src/callRows.ts'

const T0 = Date.parse('2026-11-07T08:00:00Z')
const at = (seconds: number): string => new Date(T0 + seconds * 1000).toISOString()
const start = (id: string, seconds: number, command: string, args: string[]): CallRecord => ({
  schema: 'iot-lab.cli-call.v1',
  id,
  phase: 'start',
  at: at(seconds),
  command,
  args
})
const end = (
  id: string,
  seconds: number,
  code: number | null,
  signal: string | null = null
): CallRecord => ({
  schema: 'iot-lab.cli-call.v1',
  id,
  phase: 'end',
  at: at(seconds),
  exit_code: code,
  signal
})
const NOW = T0 + 3600_000

test('a start line and an end line make one call with the exit code and the duration', () => {
  const { calls } = buildTimeline(
    { calls: [start('a', 0, 'check', ['B', '--json']), end('a', 2.5, 0)], runs: [] },
    { board: 'B', now: NOW }
  )
  assert.equal(calls.length, 1)
  assert.deepEqual(
    [calls[0]!.command, calls[0]!.state, calls[0]!.exit, calls[0]!.duration],
    ['check', 'ok', 0, 2500]
  )
})

test('a non zero exit code and a signal are failed calls', () => {
  const { calls } = buildTimeline(
    {
      calls: [
        start('a', 0, 'check', ['B']),
        end('a', 1, 1),
        start('b', 5, 'check', ['B']),
        end('b', 6, null, 'SIGTERM')
      ],
      runs: []
    },
    { board: 'B', now: NOW }
  )
  assert.deepEqual(
    calls.map((call) => call.state),
    ['failed', 'failed']
  )
})

test('a call with no end line is running while it is young, and unknown when it is old, and never ok', () => {
  const calls = [start('young', 3590, 'loop', ['B']), start('old', 0, 'check', ['B'])]
  const out = buildTimeline({ calls, runs: [] }, { board: 'B', now: NOW }).calls
  assert.equal(out.find((call) => call.id === 'young')!.state, 'running')
  assert.equal(out.find((call) => call.id === 'old')!.state, 'unknown')
})

test('an end line with no start line, a broken record and a repeated start are ignored', () => {
  const records = [
    end('ghost', 1, 0),
    { schema: 'x', id: 'z', phase: 'start', at: at(1) } as CallRecord,
    start('a', 0, 'state', ['B']),
    start('a', 9, 'state', ['B', 'again']),
    end('a', 1, 0)
  ]
  const { calls, totals } = buildTimeline({ calls: records, runs: [] }, { board: 'B', now: NOW })
  assert.equal(calls.length, 1)
  assert.deepEqual(calls[0]!.args, ['B'])
  assert.equal(totals.calls, 1)
})

test('only the calls of the board are shown: by the board in the arguments, or by a run of the board that began during the call', () => {
  const runs: RunMark[] = [
    { id: 'run-1', board: 'B', at: at(31) },
    { id: 'run-2', board: 'OTHER', at: at(61) }
  ]
  const calls = [
    start('own', 0, 'state', ['B']),
    end('own', 1, 0),
    start('other', 10, 'state', ['OTHER']),
    end('other', 11, 0),
    start('none', 20, 'list', []),
    end('none', 21, 0),
    start('run', 30, 'check', ['--changed']),
    end('run', 40, 0),
    start('run2', 60, 'check', []),
    end('run2', 70, 0)
  ]
  const out = buildTimeline({ calls, runs }, { board: 'B', now: NOW }).calls
  assert.deepEqual(out.map((call) => call.id).sort(), ['own', 'run'])
  assert.equal(out.find((call) => call.id === 'run')!.run, 'run-1')
  assert.equal(out.find((call) => call.id === 'own')!.run, null)
})

test('lanes are the commands, the busiest first, with a count and the failed count', () => {
  const calls = [
    start('a', 0, 'state', ['B']),
    end('a', 1, 0),
    start('b', 10, 'state', ['B']),
    end('b', 11, 0),
    start('c', 20, 'check', ['B']),
    end('c', 25, 1)
  ]
  const { lanes } = buildTimeline({ calls, runs: [] }, { board: 'B', now: NOW })
  assert.deepEqual(
    lanes.map((lane) => [lane.command, lane.count, lane.failed]),
    [
      ['state', 2, 0],
      ['check', 1, 1]
    ]
  )
})

test('ticks sit between 0 and 1 on the axis from the first call to now, and the list is newest first', () => {
  const calls = [
    start('a', 0, 'state', ['B']),
    end('a', 1, 0),
    start('b', 1800, 'check', ['B']),
    end('b', 1810, 0)
  ]
  const out = buildTimeline({ calls, runs: [] }, { board: 'B', now: NOW })
  assert.equal(out.from, T0)
  assert.equal(out.to, NOW)
  const x = out.lanes.flatMap((lane) => lane.ticks.map((tick) => [tick.id, tick.x])).sort()
  assert.deepEqual(x, [
    ['a', 0],
    ['b', 0.5]
  ])
  assert.deepEqual(
    out.calls.map((call) => call.id),
    ['b', 'a']
  )
})

test('one call still has an axis with a width', () => {
  const out = buildTimeline(
    { calls: [start('a', 0, 'state', ['B']), end('a', 1, 0)], runs: [] },
    { board: 'B', now: T0 }
  )
  assert.ok(out.to > out.from)
  assert.equal(out.lanes[0]!.ticks[0]!.x, 0)
})

test('the play head dims the calls after it', () => {
  const calls = [
    start('a', 0, 'state', ['B']),
    end('a', 1, 0),
    start('b', 100, 'state', ['B']),
    end('b', 101, 0)
  ]
  const out = buildTimeline({ calls, runs: [] }, { board: 'B', now: NOW, head: T0 + 50_000 })
  assert.deepEqual(
    out.calls.map((call) => [call.id, call.dim]),
    [
      ['b', true],
      ['a', false]
    ]
  )
})

test('the marks are the runs of the board, and the totals count calls, failed, unfinished, runs and the span', () => {
  const runs: RunMark[] = [{ id: 'run-1', board: 'B', at: at(30) }]
  const calls = [
    start('a', 0, 'state', ['B']),
    end('a', 1, 0),
    start('b', 30, 'check', ['B']),
    end('b', 40, 1),
    start('c', 3590, 'loop', ['B'])
  ]
  const { marks, totals } = buildTimeline({ calls, runs }, { board: 'B', now: NOW })
  assert.deepEqual(
    marks.map((mark) => mark.id),
    ['run-1']
  )
  assert.deepEqual(totals, { calls: 3, failed: 1, unfinished: 1, runs: 1, span: 3600_000 })
})

test('the reads that Studio makes for its own panels (caller studio) are not tool calls of the work', () => {
  const own = { ...start('s', 0, 'state', ['B']), caller: 'studio' }
  const out = buildTimeline(
    { calls: [own, end('s', 1, 0), start('a', 5, 'state', ['B']), end('a', 6, 0)], runs: [] },
    { board: 'B', now: NOW }
  )
  assert.deepEqual(
    out.calls.map((call) => call.id),
    ['a']
  )
})

test('a duration and an age read in the short form', () => {
  assert.deepEqual([0, 450, 2500, 61_000, 3_725_000].map(formatDuration), [
    '0 ms',
    '450 ms',
    '2.5 s',
    '1 min 1 s',
    '1 h 2 min'
  ])
  assert.equal(formatDuration(null), 'not recorded')
  assert.deepEqual([0, 4000, 59_000, 125_000, 7_300_000, 90_000_000].map(ago), [
    'now',
    '4 s ago',
    '59 s ago',
    '2 min ago',
    '2 h ago',
    '1 d ago'
  ])
  assert.equal(ago(-5000), 'now')
})

test('an empty log is an empty timeline, not an error', () => {
  const out = buildTimeline({ calls: [], runs: [] }, { board: 'B', now: NOW })
  assert.deepEqual([out.lanes.length, out.calls.length, out.totals.calls], [0, 0, 0])
})
