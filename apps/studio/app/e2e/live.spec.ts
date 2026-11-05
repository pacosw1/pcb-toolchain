// Live board view against a throw-away project with a small generated board: no corpus needed.
import { test, expect, _electron as electron } from '@playwright/test'
import { mkdirSync, mkdtempSync, renameSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

const APP = join(__dirname, '..')
const REL = 'hardware-design/boards/DEMO/cad/DEMO/DEMO.kicad_pcb'

const edge = (x1: number, y1: number, x2: number, y2: number): string =>
  `(gr_line (start ${x1} ${y1}) (end ${x2} ${y2}) (layer "Edge.Cuts") (stroke (width 0.1) (type solid)))`

/** A 40 x 30 mm board with U1 at (u1x, 15) and `tracks` tracks. */
function boardText(u1x: number, tracks: number): string {
  const segments = Array.from(
    { length: tracks },
    (_, i) => `(segment (start 5 ${5 + i}) (end 35 ${5 + i}) (width 0.25) (layer "F.Cu"))`
  )
  return `(kicad_pcb (version 20260206) (generator "test")
  (layers (0 "F.Cu" signal) (2 "B.Cu" signal))
  ${edge(0, 0, 40, 0)} ${edge(40, 0, 40, 30)} ${edge(40, 30, 0, 30)} ${edge(0, 30, 0, 0)}
  (footprint "Test:Pad" (layer "F.Cu") (at ${u1x} 15)
    (property "Reference" "U1")
    (pad "1" smd rect (at 0 0) (size 3 3) (layers "F.Cu")))
  ${segments.join('\n  ')})\n`
}

function makeProject(): string {
  const root = mkdtempSync(join(tmpdir(), 'pcbstudio-live-'))
  mkdirSync(join(root, 'hardware-design/boards/DEMO/cad/DEMO'), { recursive: true })
  mkdirSync(join(root, 'hardware-design/registry'), { recursive: true })
  writeFileSync(join(root, REL), boardText(20, 1))
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
  writeFileSync(join(root, 'hardware-design/boards/DEMO/gate.json'), JSON.stringify({ project: 'cad/DEMO/DEMO' }))
  return root
}

test('a board rewritten on disk redraws without a reload and keeps zoom and selection', async () => {
  const root = makeProject()
  const file = join(root, REL)
  /** Save the way KiCad does: a temp file renamed over the board. */
  const save = (text: string): void => {
    writeFileSync(`${file}.tmp`, text)
    renameSync(`${file}.tmp`, file)
  }
  const app = await electron.launch({ args: [APP], env: { ...process.env, PCBSTUDIO_PROJECT: root } })
  try {
    const win = await app.firstWindow()
    await expect(win.getByRole('status', { name: 'Engine status' })).toContainText('engine ready', {
      timeout: 30_000
    })
    await win.getByRole('button', { name: 'Choose board' }).click({ timeout: 15_000 })
    await win.getByRole('option', { name: /DEMO/ }).click()
    const canvas = win.getByRole('img', { name: /DEMO\.kicad_pcb/ })
    await expect(canvas).toBeVisible({ timeout: 15_000 })

    const bar = win.locator('.boardview-bar')
    const status = win.getByRole('status', { name: 'Live view' })
    const liveButton = win.getByRole('button', { name: 'Live', exact: true })
    const liveError = win.getByRole('alert', { name: 'Live view error' })
    const selection = win.getByRole('status', { name: 'Selection' })
    await expect(bar).toContainText('1 parts · 1 tracks')
    await expect(liveButton).toHaveAttribute('aria-pressed', 'true')
    await expect(status).toContainText('updated')

    // Zoom away from the fit, and select the pad of U1.
    const view = async (): Promise<{ scale: number; ox: number; oy: number }> =>
      JSON.parse((await canvas.getAttribute('data-view')) ?? 'null')
    const box = (await canvas.boundingBox())!
    await expect.poll(async () => (await view())?.scale ?? 0).toBeGreaterThan(0)
    const fitted = await view()
    await win.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
    await win.mouse.wheel(0, -400) // one wheel event: the view is final once the scale moves
    await expect.poll(async () => (await view()).scale).toBeGreaterThan(fitted.scale)
    const zoomed = await view()
    await win.mouse.click(box.x + zoomed.ox + 20 * zoomed.scale, box.y + zoomed.oy + 15 * zoomed.scale)
    await expect(selection).toContainText('U1.1')
    await expect(selection).toContainText('20.00, 15.00')

    await win.evaluate(() => ((window as unknown as { noReload: boolean }).noReload = true))

    // A save: more tracks, and U1 moved. Same zoom and pan; the selection follows the pad.
    save(boardText(21, 3))
    await expect(bar).toContainText('3 tracks', { timeout: 10_000 })
    expect(await view()).toEqual(zoomed)
    await expect(selection).toContainText('U1.1')
    await expect(selection).toContainText('21.00, 15.00')

    // A half-written file: the error shows and the last good board stays.
    writeFileSync(file, boardText(21, 4).slice(0, 200))
    await expect(liveError).toContainText('last good board', { timeout: 10_000 })
    await expect(bar).toContainText('3 tracks')
    await expect(canvas).toBeVisible()
    expect(await view()).toEqual(zoomed)

    // The finished file clears the error.
    writeFileSync(file, boardText(21, 4))
    await expect(bar).toContainText('4 tracks', { timeout: 10_000 })
    await expect(liveError).toHaveCount(0)
    expect(await view()).toEqual(zoomed)

    // Off: saves are ignored. On again: the view catches up.
    await liveButton.click()
    await expect(liveButton).toHaveAttribute('aria-pressed', 'false')
    await expect(status).toHaveText('off')
    save(boardText(21, 5))
    await win.waitForTimeout(1500)
    await expect(bar).toContainText('4 tracks')
    await liveButton.click()
    await expect(bar).toContainText('5 tracks', { timeout: 10_000 })
    await expect(status).toContainText('updated')
    expect(await view()).toEqual(zoomed)

    expect(await win.evaluate(() => (window as unknown as { noReload?: boolean }).noReload)).toBe(true)
    await win.screenshot({ path: join(APP, 'test-results', 'live.png') })
  } finally {
    await app.close()
    rmSync(root, { recursive: true, force: true })
  }
})
