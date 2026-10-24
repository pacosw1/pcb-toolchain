// Candidate runs UI (phase 5) against a throw-away project: a copy of a real iot-lab board and a stand-in tools/pcb
// that writes iot-lab style run records (run.end with candidate, candidate_verified, metrics) and a fake adopt.
// Never runs against the real iot-lab checkout.
import { test, expect, _electron as electron } from '@playwright/test'
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  writeFileSync
} from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

const APP = join(__dirname, '..')
const CORPUS = process.env.PCBSTUDIO_CORPUS ?? '/Users/pacosw/code/iot-lab'
const SOURCE = join(
  CORPUS,
  'hardware-design/boards/POE-ETHERNET/cad/POE-ETHERNET/POE-ETHERNET.kicad_pcb'
)
const REL = 'hardware-design/boards/DEMO/cad/DEMO/DEMO.kicad_pcb'

const FAKE_PCB = `#!/bin/sh
op=$1; board=$2; root=$(pwd)
if [ "$op" = adopt ]; then
  ev=$root/.gate/cli/$2; tgt=$root/${REL}
  cp "$tgt" "$ev/backup.kicad_pcb"; cp "$ev/workspace/${REL}" "$tgt"; echo adopted > "$root/adopted.txt"
  echo '{"schema_version": 1, "board": "DEMO", "target": "'$tgt'", "before_sha256": "b", "after_sha256": "a", "candidate_run": "'$2'", "adopted_at": 1}'
  exit 0
fi
rid=run-$op-$$; ev=$root/.gate/cli/$rid; cand=$ev/workspace/${REL}
echo '{"schema_version": 1, "run_id": "'$rid'", "seq": 1, "type": "run.start", "board": "'$board'"}'
if [ "$op" = check ]; then
  echo '{"schema_version": 1, "run_id": "'$rid'", "seq": 2, "type": "run.end", "status": "failed", "exit_code": 1, "cause": "unconnected items", "metrics": {"drc_errors": 0, "unconnected": 12}, "elapsed_s": 0.1}'
  exit 1
fi
mkdir -p "$(dirname "$cand")"; cp "$root/${REL}" "$cand"
echo '{"schema_version": 1, "run_id": "'$rid'", "seq": 2, "type": "tool.exit", "stage": "'$op'", "status": "passed"}'
echo '{"schema_version": 1, "run_id": "'$rid'", "seq": 3, "type": "run.end", "status": "passed", "exit_code": 0, "cause": "candidate meets configured gate targets", "candidate_verified": true, "identity_preserved": true, "candidate": "'$cand'", "candidate_sha256": "c0", "metrics": {"drc_errors": 0, "unconnected": 0}, "operation": "'$op'", "evidence_dir": "'$ev'", "elapsed_s": 0.2}'
`

function makeProject(): string {
  const root = mkdtempSync(join(tmpdir(), 'pcbstudio-runs-'))
  mkdirSync(join(root, 'hardware-design/boards/DEMO/cad/DEMO'), { recursive: true })
  mkdirSync(join(root, 'hardware-design/registry'), { recursive: true })
  mkdirSync(join(root, 'tools'))
  copyFileSync(SOURCE, join(root, REL))
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
  writeFileSync(join(root, 'tools/pcb'), FAKE_PCB)
  chmodSync(join(root, 'tools/pcb'), 0o755)
  return root
}

test('route a candidate, compare it and adopt it', async () => {
  test.skip(!existsSync(SOURCE), 'iot-lab corpus missing')
  const root = makeProject()
  const app = await electron.launch({
    args: [APP],
    env: { ...process.env, PCBSTUDIO_PROJECT: root }
  })
  const win = await app.firstWindow()
  await expect(win.getByRole('status', { name: 'Engine status' })).toContainText('engine ready', {
    timeout: 30_000
  })
  await win.getByRole('button', { name: 'Choose board' }).click({ timeout: 15_000 })
  await win.getByRole('option', { name: /DEMO/ }).click()
  await expect(win.getByRole('img', { name: /DEMO\.kicad_pcb/ })).toBeVisible({ timeout: 15_000 })

  await win
    .getByRole('navigation', { name: 'Board' })
    .getByRole('button', { name: /^Runs/ })
    .click()
  await win.getByRole('button', { name: 'Route…' }).click()
  const form = win.getByRole('form', { name: 'Route policy' })
  await form.getByLabel('Passes').fill('7')
  await form.getByRole('button', { name: 'Start route' }).click()
  await expect(win.getByRole('status', { name: 'Candidate run state' })).toHaveText(
    /route · passed/,
    { timeout: 30_000 }
  )
  const review = win.getByRole('region', { name: 'Run review' })
  await expect(review).toContainText(`.gate/cli/run-route-`)
  await expect(review).toContainText(REL)
  // The policy the engine wrote (every board net, 7 passes) went to the CLI as --spec.
  const metrics = win.getByRole('table', { name: 'Candidate metrics' })
  await expect(metrics).toContainText('unconnected')
  await expect(metrics).toContainText('(no check)')

  // Compare with the current board: run a check, then the table has both columns.
  await review.getByRole('button', { name: /Run a check of the current board/ }).click()
  await expect(metrics).not.toContainText('(no check)', { timeout: 30_000 })
  await expect(metrics.locator('tr', { hasText: 'unconnected' })).toContainText(/0\s*↓\s*12/)
  await expect(win.getByRole('region', { name: 'Runs list' }).getByRole('button')).toHaveCount(2)

  const board = win.getByRole('region', { name: 'Candidate board' })
  await expect(board.getByRole('img', { name: /run-route-.*DEMO\.kicad_pcb/ })).toBeVisible({
    timeout: 15_000
  })
  await board.getByRole('button', { name: 'Current' }).click()
  await expect(board.getByRole('img', { name: `Board ${REL}`, exact: true })).toBeVisible()
  await win.screenshot({ path: join(APP, 'test-results', 'runs.png') })

  await win.getByRole('button', { name: 'Adopt…' }).click()
  const dialog = win.getByRole('dialog', { name: /Adopt candidate/ })
  await expect(dialog).toContainText(REL)
  await dialog.getByRole('button', { name: 'Replace board file' }).click()
  await expect(win.getByText(/Adopted run-route-.*replaced/)).toBeVisible({ timeout: 15_000 })
  expect(readFileSync(join(root, 'adopted.txt'), 'utf8').trim()).toBe('adopted')
  await expect(win.getByRole('button', { name: 'Adopt…' })).toHaveCount(0)
  await app.close()
})
