import test from 'node:test'
import assert from 'node:assert/strict'
import { runsOfBoard } from '../src/renderer/src/live-runs.ts'

const run = (runId: string, board?: string) => ({ runId, summary: { run: board ? { board } : null } })

test('the live list shows only runs of the selected PCB file', () => {
  const runs = [run('a', 'ENV-SENSE.kicad_pcb'), run('b', 'CELLULAR.kicad_pcb'), run('c')]
  assert.deepEqual(runsOfBoard(runs, '/lab/boards/CELLULAR/cad/revB/CELLULAR.kicad_pcb').map((r) => r.runId), ['b'])
})

test('with no selected board the list is empty, never the runs of other boards', () => {
  assert.deepEqual(runsOfBoard([run('a', 'ENV-SENSE.kicad_pcb')], null), [])
})
