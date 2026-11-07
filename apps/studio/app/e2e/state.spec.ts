// The Stages panel against a throw-away project. A stand-in tools/pcb prints the state and the history from two JSON files
// that the test writes from the real table of stages (tools/pcb-transitions.json). No corpus is needed.
import { test, expect, _electron as electron } from '@playwright/test'
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

const APP = join(__dirname, '..')
const REL = 'hardware-design/boards/DEMO/cad/DEMO/DEMO.kicad_pcb'
const TABLE = JSON.parse(
  readFileSync(join(APP, '../../../tools/pcb-transitions.json'), 'utf8')
) as {
  states: {
    id: string
    name: string
    status: string
    evidence: string | null
    next: string[]
    back: unknown[]
  }[]
}

const FAKE_PCB = `#!/bin/sh
[ "$1" = --project ] && shift 2
case "$1" in
  state) cat "$(dirname "$0")/state.json" ;;
  history) cat "$(dirname "$0")/history.json" ;;
  *) echo "unknown $1" >&2; exit 2 ;;
esac
`

/** The state JSON of the board at stage HERE: the stages before it have current evidence. */
function stateAt(here: string, next: Record<string, string>): string {
  const at = TABLE.states.findIndex((s) => s.id === here)
  return JSON.stringify({
    schema: 'iot-lab.board-state.v1',
    board: 'DEMO',
    position: { state: here, name: TABLE.states[at].name, evidence: null, freshness: null },
    allowed: ['check'],
    next,
    evidence: {},
    change: {
      state: 'recorded',
      path: 'changes.jsonl',
      events: 0,
      problems: [],
      pending: [],
      last: null
    },
    release: {},
    images: [],
    states: TABLE.states.map((s, i) => ({
      id: s.id,
      name: s.name,
      status: s.status,
      evidence: s.evidence,
      freshness: s.evidence ? (i < at ? 'current' : 'unknown') : null,
      position: s.id === here,
      next: s.next,
      back: s.back,
      inputs: [],
      outputs: [{ name: 'report', path: '/nowhere/report.json', exists: true, size: 2048 }]
    }))
  })
}

const HISTORY = JSON.stringify({
  schema: 'iot-lab.board-history.v1',
  board: 'DEMO',
  entries: [
    {
      at: '2026-11-07T07:10:00Z',
      placed_by: 'time',
      source: 'run',
      id: 'run-1',
      type: 'route',
      by: 'router',
      summary: 'route run passed',
      stages: ['A3'],
      inputs: [],
      outputs: []
    }
  ],
  problems: []
})

function makeProject(): string {
  const root = mkdtempSync(join(tmpdir(), 'pcbstudio-state-'))
  mkdirSync(join(root, 'hardware-design/boards/DEMO/cad/DEMO'), { recursive: true })
  mkdirSync(join(root, 'hardware-design/registry'), { recursive: true })
  mkdirSync(join(root, 'tools'))
  writeFileSync(
    join(root, REL),
    `(kicad_pcb (version 20260206) (generator "test") (layers (0 "F.Cu" signal) (2 "B.Cu" signal))
  (gr_line (start 0 0) (end 40 0) (layer "Edge.Cuts") (stroke (width 0.1) (type solid))))\n`
  )
  writeFileSync(
    join(root, 'hardware-design/registry/boards.json'),
    JSON.stringify({
      boards: [
        {
          id: 'DEMO',
          directory: 'DEMO',
          lifecycle: 'test',
          revisions: [{ revision: 'A', state: 'test', project: 'cad/DEMO/DEMO', gate: 'DEMO' }]
        }
      ]
    })
  )
  writeFileSync(
    join(root, 'hardware-design/boards/DEMO/gate.json'),
    JSON.stringify({ project: 'cad/DEMO/DEMO' })
  )
  writeFileSync(join(root, 'tools/pcb'), FAKE_PCB)
  chmodSync(join(root, 'tools/pcb'), 0o755)
  writeFileSync(
    join(root, 'tools/state.json'),
    stateAt('A3', { state: 'ready', command: 'tools/pcb check DEMO' })
  )
  writeFileSync(join(root, 'tools/history.json'), HISTORY)
  return root
}

test('the Stages panel shows the stage of the board, and follows a change on disk without a reload', async () => {
  const root = makeProject()
  const app = await electron.launch({
    args: [APP],
    env: { ...process.env, PCBSTUDIO_PROJECT: root }
  })
  try {
    const win = await app.firstWindow()
    await expect(win.getByRole('status', { name: 'Engine status' })).toContainText('engine ready', {
      timeout: 30_000
    })
    await win.getByRole('button', { name: 'Choose board' }).click({ timeout: 15_000 })
    await win.getByRole('option', { name: /DEMO/ }).click()
    await expect(win.getByRole('img', { name: /DEMO\.kicad_pcb/ })).toBeVisible({ timeout: 15_000 })

    await win
      .getByRole('navigation', { name: 'Board' })
      .getByRole('button', { name: /^Stages/ })
      .click()
    const stages = win.getByRole('region', { name: 'Stages' })
    const here = stages.locator('[aria-current="step"]')
    await expect(here).toContainText(TABLE.states.find((s) => s.id === 'A3')!.name, {
      timeout: 15_000
    })
    // The stage that the board is at is open, the others are closed.
    const trigger = here.getByRole('button').first()
    await expect(trigger).toHaveAttribute('aria-expanded', 'true')
    const done = stages.locator('.trace-item[data-status="done"]').first()
    await expect(done.getByRole('button').first()).toHaveAttribute('aria-expanded', 'false')
    // The legend is shown once.
    await expect(stages.getByRole('list', { name: 'Status' })).toHaveCount(1)
    // A row opens by a click and shows its outputs with their sizes.
    await done.getByRole('button').first().click()
    await expect(done).toContainText('2.0 kB')
    await win.screenshot({ path: join(APP, 'test-results', 'state.png') })

    // The board moves on disk: the panel follows with no reload and no click.
    writeFileSync(
      join(root, 'tools/state.json'),
      stateAt('A9', { state: 'blocked', code: 'run_not_completed' })
    )
    writeFileSync(join(root, 'hardware-design/boards/DEMO/changes.jsonl'), '\n')
    await expect(stages.locator('[aria-current="step"]')).toContainText(
      TABLE.states.find((s) => s.id === 'A9')!.name,
      {
        timeout: 15_000
      }
    )
    await expect(stages.locator('[aria-current="step"]')).toContainText('run_not_completed')
  } finally {
    await app.close()
    rmSync(root, { recursive: true, force: true })
  }
})
