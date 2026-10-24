// Smoke tests of the built app.
import { test, expect, _electron as electron } from '@playwright/test'
import { existsSync } from 'fs'
import { join } from 'path'

const APP = join(__dirname, '..')
const CORPUS = process.env.PCBSTUDIO_CORPUS ?? '/Users/pacosw/code/iot-lab'

test('engine starts, pings, and recovers after a crash', async () => {
  const app = await electron.launch({ args: [APP], env: { ...process.env, PCBSTUDIO_PROJECT: '' } })
  const win = await app.firstWindow()
  const pill = win.getByRole('status', { name: 'Engine status' })
  await expect(pill).toContainText('engine ready', { timeout: 30_000 })
  await win.locator('details.panel summary').click()

  await win.getByRole('button', { name: 'Ping engine' }).click()
  await expect(win.locator('pre.log')).toContainText('ping ok', { timeout: 10_000 })
  await expect(win.locator('dl.kv')).toContainText('board.geometry')

  await win.getByRole('button', { name: 'Kill engine (crash test)' }).click()
  await expect(pill).not.toContainText('engine ready', { timeout: 10_000 })
  await expect(pill).toContainText('engine ready', { timeout: 30_000 })
  await expect(win.locator('dl.kv')).toContainText(/Restarts\s*1/)

  await win.getByRole('button', { name: 'Ping engine' }).click()
  await expect(win.locator('pre.log')).toContainText(/ping ok[\s\S]*ping ok/, { timeout: 10_000 })
  await app.close()
})

async function openPoe(): Promise<Awaited<ReturnType<typeof electron.launch>>> {
  const app = await electron.launch({
    args: [APP],
    env: { ...process.env, PCBSTUDIO_PROJECT: CORPUS }
  })
  const win = await app.firstWindow()
  await expect(win.getByRole('status', { name: 'Engine status' })).toContainText('engine ready', {
    timeout: 30_000
  })
  await win.getByRole('button', { name: 'Choose board' }).click({ timeout: 15_000 })
  await win.getByRole('dialog', { name: 'Boards' }).getByRole('searchbox').fill('POE-ETH')
  await win.getByRole('option', { name: /POE-ETHERNET/ }).click()
  await expect(win.getByRole('img', { name: /POE-ETHERNET\.kicad_pcb/ })).toBeVisible({
    timeout: 15_000
  })
  return app
}

test('opens iot-lab and draws a board', async () => {
  test.skip(!existsSync(CORPUS), 'iot-lab corpus missing')
  const app = await openPoe()
  const win = await app.firstWindow()
  await expect(win.locator('.boardview-bar')).toContainText(/\d+ parts · \d+ tracks · \d+ vias/)
  await win.waitForTimeout(300)
  await win.screenshot({ path: join(APP, 'test-results', 'board.png') })
  await app.close()
})

test('board viewer: search, net highlight, hover, measure, keys', async () => {
  test.skip(!existsSync(CORPUS), 'iot-lab corpus missing')
  const app = await openPoe()
  const win = await app.firstWindow()
  const canvas = win.getByRole('img', { name: /POE-ETHERNET\.kicad_pcb/ })
  const sel = win.getByRole('status', { name: 'Selection' })

  // Search: unknown ref -> hint; U1 -> zoom + part selection.
  const find = win.getByRole('searchbox', { name: 'Find part' })
  await find.fill('NOPE99')
  await find.press('Enter')
  await expect(win.getByRole('alert')).toHaveText('not found')
  await find.fill('u1')
  await find.press('Enter')
  await expect(sel).toContainText('U1')
  await expect(sel).toContainText(/\d+ pads/)

  // Screen position of a U1 pad that has a net, from the engine geometry and the view transform.
  const pcb = ((await canvas.getAttribute('aria-label')) ?? '').replace(/^Board /, '')
  const view = JSON.parse((await canvas.getAttribute('data-view'))!) as {
    scale: number
    ox: number
    oy: number
  }
  const pad = await win.evaluate(async (p) => {
    const g = (await window.api.engine.call('board.geometry', { pcb: p })) as {
      footprints: { ref: string; pads: { num: string; x: number; y: number; net: string }[] }[]
    }
    return g.footprints.find((f) => f.ref === 'U1')!.pads.find((q) => q.net)!
  }, pcb)
  const box = (await canvas.boundingBox())!
  const sx = box.x + view.ox + pad.x * view.scale
  const sy = box.y + view.oy + pad.y * view.scale

  await win.mouse.move(sx, sy)
  await expect(win.locator('.bv-tip')).toContainText(`U1.${pad.num}`)
  await win.mouse.click(sx, sy)
  await expect(sel).toContainText(`U1.${pad.num}`)
  await expect(sel).toContainText(pad.net)
  await expect(sel).toContainText(/\d+ pads on net/)
  await win.waitForTimeout(200)
  await win.screenshot({ path: join(APP, 'test-results', 'viewer2.png') })

  // Escape (canvas focused by the click) clears the selection.
  await win.keyboard.press('Escape')
  await expect(sel).toHaveCount(0)

  // Shift+drag measures; the result stays until Escape.
  await win.keyboard.down('Shift')
  await win.mouse.move(box.x + 100, box.y + 100)
  await win.mouse.down()
  await win.mouse.move(box.x + 160, box.y + 180, { steps: 5 })
  await win.mouse.up()
  await win.keyboard.up('Shift')
  const meas = win.getByRole('status', { name: 'Measurement' })
  const len = (100 / view.scale).toFixed(3) // 60 x 80 px = 100 px
  await expect(meas).toContainText(`${len} mm`)
  await win.screenshot({ path: join(APP, 'test-results', 'viewer2-measure.png') })
  await win.getByLabel('Board canvas').press('Escape')
  await expect(meas).toHaveCount(0)

  // Keys: 2 toggles In1.Cu, F fits the board.
  const in1 = win.getByRole('button', { name: 'In1.Cu' })
  const before = await in1.getAttribute('aria-pressed')
  await win.getByLabel('Board canvas').press('2')
  await expect(in1).not.toHaveAttribute('aria-pressed', before!)
  await win.getByLabel('Board canvas').press('f')
  await expect(canvas).not.toHaveAttribute('data-view', JSON.stringify(view))
  // Typing in the search box does not trigger the keys.
  const after = await in1.getAttribute('aria-pressed')
  await find.fill('')
  await find.press('2')
  await expect(in1).toHaveAttribute('aria-pressed', after!)
  await app.close()
})

test('3D view of the board', async () => {
  test.skip(!existsSync(CORPUS), 'iot-lab corpus missing')
  test.setTimeout(240_000)
  const app = await openPoe()
  const win = await app.firstWindow()
  await win.getByRole('navigation', { name: 'Board' }).getByRole('button', { name: /^3D/ }).click()
  await expect(win.getByLabel('3D model info')).toContainText(/meshes/, { timeout: 180_000 })
  await win.waitForTimeout(800)
  await win.screenshot({ path: join(APP, 'test-results', '3d.png') })
  await app.close()
})

test('runs the real gate from the Checks tab', async () => {
  test.skip(!existsSync(join(CORPUS, 'tools', 'pcb')), 'iot-lab corpus missing')
  const app = await openPoe()
  const win = await app.firstWindow()
  await win.getByRole('button', { name: 'Checks' }).click()
  await win.getByRole('button', { name: 'Run changed checks' }).click()
  const state = win.getByRole('status', { name: 'Run state' })
  await expect(state).toHaveText(/passed|failed/, { timeout: 180_000 })
  await expect(win.getByRole('region', { name: 'Run events' })).toContainText('run.end')
  await expect(win.locator('table.metrics')).toContainText('drc errors')
  await win.screenshot({ path: join(APP, 'test-results', 'checks.png') })
  // Findings (POE-ETHERNET has DRC warnings with positions) -> jump to the board with markers.
  const findings = win.getByRole('region', { name: 'Findings' })
  await expect(findings).toBeVisible({ timeout: 10_000 })
  await findings.getByRole('button').first().click()
  await expect(win.getByRole('button', { name: /DRC \d+/ })).toBeVisible()
  await win.waitForTimeout(300)
  await win.screenshot({ path: join(APP, 'test-results', 'drc.png') })
  await app.close()
})

test('parts / BOM and a datasheet PDF', async () => {
  test.skip(!existsSync(CORPUS), 'iot-lab corpus missing')
  const app = await openPoe()
  const win = await app.firstWindow()
  await win.getByRole('button', { name: /Parts \/ BOM/ }).click()
  const table = win.locator('.tablewrap table')
  await expect(table.locator('tbody tr')).not.toHaveCount(0, { timeout: 15_000 })
  await win.screenshot({ path: join(APP, 'test-results', 'parts.png') })

  // A line that has a local datasheet (✓ in the Datasheet column).
  await table
    .locator('tbody tr', { has: win.locator('td:nth-child(7)', { hasText: '✓' }) })
    .first()
    .click()
  await win.getByRole('button', { name: 'Open datasheet' }).click()
  const frame = win.locator('.dsdoc iframe')
  await expect(frame).toBeVisible({ timeout: 15_000 })
  const src = await frame.getAttribute('src')
  expect(src).toMatch(/^pcbfile:\/\/local\/.*\.pdf$/i)
  const status = await win.evaluate(async (u) => (await fetch(u)).status, src!)
  expect(status).toBe(200)
  const denied = await win.evaluate(async () => (await fetch('pcbfile://local/etc/hosts')).status)
  expect(denied).toBe(403)
  await win.waitForTimeout(1500)
  await win.screenshot({ path: join(APP, 'test-results', 'datasheet.png') })

  // Show on board from the parts list.
  await win.getByRole('button', { name: /Parts \/ BOM/ }).click()
  await table.locator('tbody tr').first().click()
  await win.getByRole('button', { name: 'Show on board' }).click()
  await expect(win.getByRole('status', { name: 'Selection' })).toBeVisible({ timeout: 10_000 })
  await app.close()
})
