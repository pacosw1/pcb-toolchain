// The Tool calls panel against a throw-away project. The test writes .gate/calls.jsonl in the format that tools/pcb writes
// (tools/lib/call-log.ts), and a run start in .gate/cli. No corpus and no CLI are needed.
import { test, expect, _electron as electron } from '@playwright/test'
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

const APP = join(__dirname, '..')
const REL = 'hardware-design/boards/DEMO/cad/DEMO/DEMO.kicad_pcb'
const SCHEMA = 'iot-lab.cli-call.v1'

const ago = (seconds: number): string => new Date(Date.now() - seconds * 1000).toISOString()
let serial = 0
/** The two lines of one call: it started `startS` seconds ago and took `tookS` seconds. `exit` null: no end line. */
function call(
  startS: number,
  command: string,
  args: string[],
  tookS: number,
  exit: number | null
): string {
  const id = `c${++serial}`
  const lines = [
    { schema: SCHEMA, id, phase: 'start', at: ago(startS), command, args, pid: 100 + serial }
  ]
  if (exit !== null)
    lines.push({
      schema: SCHEMA,
      id,
      phase: 'end',
      at: ago(startS - tookS),
      exit_code: exit,
      signal: null,
      duration_ms: tookS * 1000
    } as never)
  return lines.map((line) => JSON.stringify(line)).join('\n') + '\n'
}

function makeProject(): string {
  const root = mkdtempSync(join(tmpdir(), 'pcbstudio-calls-'))
  mkdirSync(join(root, 'hardware-design/boards/DEMO/cad/DEMO'), { recursive: true })
  mkdirSync(join(root, 'hardware-design/registry'), { recursive: true })
  mkdirSync(join(root, '.gate/cli/run-demo1'), { recursive: true })
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
  writeFileSync(
    join(root, '.gate/cli/run-demo1/events.jsonl'),
    JSON.stringify({ run_id: 'run-demo1', type: 'run.start', time: ago(1500), board: 'DEMO' }) +
      '\n'
  )
  let log = ''
  log += call(2400, 'state', ['DEMO'], 1, 0)
  log += call(2300, 'check', ['DEMO', '--changed'], 42, 1)
  log += call(2100, 'explain', ['run-prev', '--json'], 2, 0) // no board in the arguments: not shown
  log += call(1900, 'next', ['DEMO', '--json'], 1, 0)
  log += call(1700, 'place', ['DEMO', '--seed', '4'], 95, 0)
  log += call(1520, 'check', ['DEMO'], 70, 0) // starts a run (run-demo1 at 1500 s ago)
  log += call(1300, 'state', ['DEMO', '--json'], 1, 0)
  log += call(1100, 'layout', ['DEMO', '--plan'], 12, 0)
  log += call(900, 'state', ['DEMO', '--json'], 1, 0)
  log += call(700, 'check', ['DEMO'], 58, 1)
  log += call(500, 'next', ['DEMO', '--json'], 1, 0)
  log += call(300, 'loop', ['DEMO', '--token', '***'], 0, null) // no end line: the end is not known
  log += call(120, 'state', ['DEMO'], 1, 0)
  writeFileSync(join(root, '.gate/calls.jsonl'), log)
  return root
}

test('the Tool calls panel draws the lanes of the board, follows new calls, and pauses', async () => {
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
      .getByRole('button', { name: /^Tool calls/ })
      .click()
    const panel = win.getByRole('region', { name: 'Tool calls' })
    // One lane for each command of this board. `explain` names no run of the board, so it has no lane.
    await expect(panel.getByRole('group', { name: 'state: 4 calls' })).toBeVisible({
      timeout: 15_000
    })
    await expect(panel.getByRole('group', { name: 'check: 3 calls' })).toBeVisible()
    await expect(panel.getByRole('group', { name: /^explain/ })).toHaveCount(0)
    // A failed call is colored, and a call with no end line is not shown as passed.
    await expect(panel.locator('.tick[data-state="failed"]')).toHaveCount(2)
    await expect(
      panel.locator('.tick[data-state="unknown"], .tick[data-state="running"]')
    ).toHaveCount(1)

    // Hover shows the tool, the arguments, the exit code and the duration.
    const failed = panel.locator('.tick[data-state="failed"]').first()
    await failed.hover()
    await expect(failed.getByRole('tooltip')).toContainText('--changed')
    await expect(failed.getByRole('tooltip')).toContainText('exit 1')
    await expect(failed.getByRole('tooltip')).toContainText('42 s')

    // A click selects the call, with its details and the link to the run.
    await panel
      .getByRole('button', { name: /^check DEMO:/ })
      .first()
      .click()
    const detail = panel.locator('.detail')
    await expect(detail).toContainText('run-demo1')
    await expect(detail.getByRole('button', { name: 'Open the Runs tab' })).toBeVisible()
    await expect(panel.locator('.calls-foot')).toContainText('12 calls')

    // A new call on disk adds a tick with no reload.
    appendFileSync(join(root, '.gate/calls.jsonl'), call(2, 'state', ['DEMO'], 1, 0))
    await expect(panel.getByRole('group', { name: 'state: 5 calls' })).toBeVisible({
      timeout: 15_000
    })

    // Pause stops the view. New calls wait. Play follows again.
    await panel.getByRole('button', { name: 'Pause live updates' }).click()
    await expect(panel.getByRole('status').filter({ hasText: 'Paused' })).toBeVisible()
    appendFileSync(join(root, '.gate/calls.jsonl'), call(1, 'check', ['DEMO'], 1, 0))
    await expect(panel.getByText('new calls waiting')).toBeVisible({ timeout: 15_000 })
    await expect(panel.getByRole('group', { name: 'check: 3 calls' })).toBeVisible()
    await panel.getByRole('button', { name: 'Follow live calls' }).click()
    await expect(panel.getByRole('group', { name: 'check: 4 calls' })).toBeVisible({
      timeout: 15_000
    })
    // A row of the list selects its call as well.
    await panel.locator('.calls-list button').filter({ hasText: '1 min 10 s' }).click()
    await expect(panel.locator('.detail')).toContainText('run-demo1')
    await win.mouse.move(2, 2)
    await win.screenshot({ path: join(APP, 'test-results', 'tool-timeline.png') })
  } finally {
    await app.close()
    rmSync(root, { recursive: true, force: true })
  }
})
