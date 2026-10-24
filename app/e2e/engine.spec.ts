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

test('opens iot-lab and draws a board', async () => {
  test.skip(!existsSync(CORPUS), 'iot-lab corpus missing')
  const app = await electron.launch({ args: [APP], env: { ...process.env, PCBSTUDIO_PROJECT: CORPUS } })
  const win = await app.firstWindow()
  await expect(win.getByRole('status', { name: 'Engine status' })).toContainText('engine ready', { timeout: 30_000 })
  const boards = win.getByRole('navigation', { name: 'Boards' })
  await expect(boards).toContainText('POE-ETHERNET', { timeout: 15_000 })
  await boards.locator('li', { hasText: 'POE-ETHERNET' }).getByRole('button').first().click()
  await expect(win.getByRole('img', { name: /POE-ETHERNET\.kicad_pcb/ })).toBeVisible({ timeout: 15_000 })
  await expect(win.locator('.boardview-bar')).toContainText(/\d+ parts · \d+ tracks · \d+ vias/)
  await win.waitForTimeout(300)
  await win.screenshot({ path: join(APP, 'test-results', 'board.png') })
  await app.close()
})
