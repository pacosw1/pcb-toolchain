// The rows of the stage panel: a pure map from the JSON of `pcb state` and `pcb history`. The panel has no list of stages.
import assert from 'node:assert/strict'
import fs from 'node:fs'
import test from 'node:test'
import { buildRows, formatSize } from '../src/renderer/src/stateRows.ts'
import type { HistoryJson, StageJson, StateJson } from '../src/renderer/src/stateRows.ts'

const TABLE = JSON.parse(
  fs.readFileSync(new URL('../../../../tools/pcb-transitions.json', import.meta.url), 'utf8')
) as {
  states: {
    id: string
    name: string
    status: string
    evidence: string | null
    next: string[]
    back: { to: string; on: string }[]
    inputs: { name: string; path?: string }[]
    outputs: { name: string; path?: string }[]
  }[]
}

/** The state JSON of a board at `here`, built from the real table: evidence before `here` is current, the rest is unknown. */
function stateAt(
  here: string,
  patch: {
    freshness?: Record<string, string>
    next?: StateJson['next']
    change?: Partial<StateJson['change']>
  } = {}
): StateJson {
  const at = TABLE.states.findIndex((state) => state.id === here)
  const states: StageJson[] = TABLE.states.map((state, index) => ({
    id: state.id,
    name: state.name,
    status: state.status,
    evidence: state.evidence,
    freshness:
      patch.freshness?.[state.id] ?? (state.evidence ? (index < at ? 'current' : 'unknown') : null),
    position: state.id === here,
    next: state.next,
    back: state.back,
    inputs: state.inputs.map((item) => ({
      name: item.name,
      path: item.path ? `/p/${item.path}` : null,
      exists: !!item.path
    })),
    outputs: state.outputs.map((item) => ({
      name: item.name,
      path: item.path ? `/p/${item.path}` : null,
      exists: false
    }))
  }))
  return {
    board: 'X',
    position: { state: here, name: TABLE.states[at]!.name, evidence: null, freshness: null },
    allowed: ['check'],
    next: patch.next ?? { state: 'ready' },
    change: {
      state: 'recorded',
      events: 0,
      problems: [],
      pending: [],
      last: null,
      ...patch.change
    },
    images: [],
    states
  }
}
const noHistory: HistoryJson = { entries: [], problems: [] }
const byId = (
  rows: ReturnType<typeof buildRows>['rows'],
  id: string
): ReturnType<typeof buildRows>['rows'][number] => rows.find((row) => row.id === id)!

test('every state of the table is a row, and exactly one row is where the board is', () => {
  const { rows } = buildRows(stateAt('A9'), noHistory)
  assert.deepEqual(
    rows.map((row) => row.id),
    TABLE.states.map((state) => state.id)
  )
  assert.deepEqual(
    rows.filter((row) => row.here).map((row) => row.id),
    ['A9']
  )
})

test('current evidence is done, the position runs, and a stage not reached is pending', () => {
  const { rows } = buildRows(stateAt('A9'), noHistory)
  assert.equal(byId(rows, 'A4').status, 'done')
  assert.equal(byId(rows, 'A9').status, 'running')
  assert.equal(byId(rows, 'A12').status, 'pending')
})

test('a stage before the position that has no proof reads as unproven, not as done', () => {
  const { rows } = buildRows(stateAt('A9', { freshness: { A3: 'unknown' } }), noHistory)
  assert.equal(byId(rows, 'A3').status, 'unproven')
  const bare = TABLE.states.find((state) => state.id.startsWith('A') && state.evidence === null)! // a stage that has no evidence class
  assert.equal(byId(buildRows(stateAt('A25'), noHistory).rows, bare.id).status, 'unproven')
  assert.equal(byId(buildRows(stateAt('A1'), noHistory).rows, bare.id).status, 'pending')
})

test('stale evidence is stale with its reason, wherever the stage is', () => {
  const { rows } = buildRows(stateAt('A9', { freshness: { A4: 'stale', A18: 'stale' } }), noHistory)
  assert.equal(byId(rows, 'A4').status, 'stale')
  assert.match(byId(rows, 'A4').why!, /schematic is stale/)
  assert.equal(byId(rows, 'A18').status, 'stale')
})

test('a person gate that waits has its own status and says who must act', () => {
  const { rows } = buildRows(stateAt('A8', { freshness: { A8: 'missing' } }), noHistory)
  assert.equal(byId(rows, 'A8').status, 'person')
  assert.match(byId(rows, 'A8').why!, /person/i)
  assert.equal(byId(rows, 'A8').person, true)
  assert.equal(byId(rows, 'A7').person, false)
})

test('a blocked position shows the block and its cause, and an active run shows it as running', () => {
  const next = {
    state: 'blocked',
    code: 'run_not_completed',
    command: 'tools/pcb explain run-x --json'
  }
  const blocked = byId(buildRows(stateAt('A9', { next }), noHistory).rows, 'A9')
  assert.equal(blocked.status, 'blocked')
  assert.match(blocked.why!, /run_not_completed/)
  assert.equal(
    byId(buildRows(stateAt('A9', { next }), noHistory, { active: true }).rows, 'A9').status,
    'running'
  )
})

test('a decision that is unavailable is a block, not a silent running', () => {
  const row = byId(
    buildRows(stateAt('A9', { next: { state: 'unavailable', cause: 'no tools' } }), noHistory).rows,
    'A9'
  )
  assert.equal(row.status, 'blocked')
  assert.match(row.why!, /no tools/)
})

test('the log lines of a stage come from the history entries that name it, newest first', () => {
  const history: HistoryJson = {
    problems: [],
    entries: [
      {
        at: '2026-11-07T07:10:00Z',
        placed_by: 'time',
        source: 'layout',
        id: 'layout-1',
        type: 'layout_plan.approved',
        by: 'Ana',
        summary: 'ok',
        stages: ['A8'],
        inputs: [],
        outputs: []
      },
      {
        at: null,
        placed_by: 'log_order',
        source: 'seal',
        id: 'seal-1',
        type: 'seal-accept',
        by: null,
        summary: 'first',
        stages: ['A4', 'B4'],
        inputs: [],
        outputs: []
      },
      {
        at: '2026-11-07T07:20:00Z',
        placed_by: 'time',
        source: 'layout',
        id: 'layout-2',
        type: 'layout_plan.approved',
        by: 'Bo',
        summary: 'again',
        stages: ['A8'],
        inputs: [],
        outputs: []
      }
    ]
  }
  const { rows } = buildRows(stateAt('A9'), history)
  assert.deepEqual(
    byId(rows, 'A8').log.map((line) => [line.id, line.by]),
    [
      ['layout-2', 'Bo'],
      ['layout-1', 'Ana']
    ]
  )
  assert.deepEqual(
    byId(rows, 'A4').log.map((line) => line.id),
    ['seal-1']
  )
  assert.deepEqual(
    byId(rows, 'B4').log.map((line) => line.id),
    ['seal-1']
  )
  assert.deepEqual(byId(rows, 'A9').log, [])
})

test('inputs and outputs keep their paths and sizes, and images are the existing image files', () => {
  const state = stateAt('A9')
  state.states.find((stage) => stage.id === 'A8')!.outputs = [
    {
      name: 'approved image PNG',
      path: '/p/layout-plan.png',
      exists: true,
      size: 2048,
      image: true
    },
    { name: 'approved image SVG', path: '/p/layout-plan.svg', exists: false, image: true },
    { name: 'approval', path: '/p/layout-plan.json', exists: true, size: 12 }
  ]
  const row = byId(buildRows(state, noHistory).rows, 'A8')
  assert.deepEqual(row.images, ['/p/layout-plan.png'])
  assert.deepEqual(
    row.outputs.map((item) => [item.name, item.size]),
    [
      ['approved image PNG', 2048],
      ['approved image SVG', undefined],
      ['approval', 12]
    ]
  )
})

test('a change that opened a go-back move marks the stages it re-enters', () => {
  const kind = {
    kind: 'fab_defect',
    reenter: ['A7', 'A14'],
    redo: [{ evidence: 'gate', status: 'stale' }],
    keep: [],
    approve: []
  }
  const change = {
    last: { ...kind, id: 'c-0002', at: '2026-11-07T07:00:00Z', by: 'Ana', reason: 'short on U3' }
  }
  const { rows } = buildRows(stateAt('A9', { change }), noHistory)
  assert.equal(byId(rows, 'A7').reopened.length, 1)
  assert.match(byId(rows, 'A7').reopened[0]!.text, /fab_defect/)
  assert.match(byId(rows, 'A7').reopened[0]!.text, /Ana/)
  assert.match(byId(rows, 'A7').reopened[0]!.text, /gate=stale/)
  assert.equal(byId(rows, 'A14').reopened.length, 1)
  assert.equal(byId(rows, 'A9').reopened.length, 0)
})

test('the rows count their statuses, and the position is named from the CLI', () => {
  const result = buildRows(stateAt('A9'), noHistory)
  assert.equal(result.position.id, 'A9')
  assert.equal(result.counts.running, 1)
  assert.equal(
    Object.values(result.counts).reduce((a, b) => a + b, 0),
    result.rows.filter((row) => row.group === 'stage').length
  )
})

test('stages A are the process and stages B are rules', () => {
  const { rows } = buildRows(stateAt('A9'), noHistory)
  assert.equal(byId(rows, 'A1').group, 'stage')
  assert.equal(byId(rows, 'B3').group, 'rule')
})

test('sizes are short and exact enough to read', () => {
  assert.equal(formatSize(0), '0 B')
  assert.equal(formatSize(999), '999 B')
  assert.equal(formatSize(2048), '2.0 kB')
  assert.equal(formatSize(5 * 1024 * 1024), '5.0 MB')
})
