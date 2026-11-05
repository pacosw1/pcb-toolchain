import assert from 'node:assert/strict'
import { test } from 'node:test'
import { activityRows } from '../src/renderer/src/liveActivity.ts'

test('router passes show clearance conflicts rather than raw search counts', () => {
  const text = 'iter  6: routed 4, conflicts 147, audit pairs 9 samples 309 hard 0, pour faults 0 (walls 0, fixed 0), involved 4, hard fails 0, pres 3.80, 8.2 s hard: involved: +3V3 /SCL /SDA GND'
  const row = activityRows({ type: 'tool.output', stage: 'routing', text })[0]
  assert.equal(row.title, 'Routing pass 6')
  assert.match(row.detail, /9 clearance conflicts/)
  assert.match(row.detail, /Nets: \+3V3/)
  assert.equal(row.tone, 'warning')
  assert.equal(row.raw, text)
})

test('router pass remains distinct from a verified run verdict', () => {
  const row = activityRows({ type: 'tool.output', text: 'ROUTE PASS converged true iters 7 tracks 188 vias 30 failed 0 notes 6 11 s -> /tmp/result.json' })[0]
  assert.equal(row.title, 'Router finished')
  assert.match(row.detail, /188 tracks · 30 vias/)
  assert.equal(row.tone, 'success')
  assert.equal(activityRows({ type: 'run.end', status: 'failed', cause: 'Gate failed' })[0].tone, 'error')
})
