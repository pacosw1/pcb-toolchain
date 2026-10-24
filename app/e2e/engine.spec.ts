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
  const app = await electron.launch({ args: [APP], env: { ...process.env, PCBSTUDIO_PROJECT: CORPUS } })
  const win = await app.firstWindow()
  await expect(win.getByRole('status', { name: 'Engine status' })).toContainText('engine ready', { timeout: 30_000 })
  const boards = win.getByRole('navigation', { name: 'Boards' })
  await expect(boards).toContainText('POE-ETHERNET', { timeout: 15_000 })
  await boards.locator('li', { hasText: 'POE-ETHERNET' }).getByRole('button').first().click()
  return app
}

test('opens iot-lab and draws a board', async () => {
  test.skip(!existsSync(CORPUS), 'iot-lab corpus missing')
  const app = await openPoe()
  const win = await app.firstWindow()
  await expect(win.getByRole('img', { name: /POE-ETHERNET\.kicad_pcb/ })).toBeVisible({ timeout: 15_000 })
  await expect(win.locator('.boardview-bar')).toContainText(/\d+ parts · \d+ tracks · \d+ vias/)
  await win.waitForTimeout(300)
  await win.screenshot({ path: join(APP, 'test-results', 'board.png') })
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
  await table.locator('tbody tr', { has: win.locator('td:nth-child(7)', { hasText: '✓' }) }).first().click()
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
