// Smoke test of the built app: the engine starts, answers a ping, and comes back after it is killed.
import { test, expect, _electron as electron } from '@playwright/test'
import { join } from 'path'

test('engine starts, pings, and recovers after a crash', async () => {
  const app = await electron.launch({ args: [join(__dirname, '..')] })
  const win = await app.firstWindow()
  const pill = win.getByRole('status', { name: 'Engine status' })
  await expect(pill).toContainText('engine ready', { timeout: 30_000 })

  await win.getByRole('button', { name: 'Ping engine' }).click()
  await expect(win.locator('pre.log')).toContainText('ping ok', { timeout: 10_000 })
  await expect(win.locator('dl.kv')).toContainText('engine.ping')
  await win.screenshot({ path: join(__dirname, '..', 'test-results', 'shell.png') })

  await win.getByRole('button', { name: 'Kill engine (crash test)' }).click()
  await expect(pill).not.toContainText('engine ready', { timeout: 10_000 })
  await expect(pill).toContainText('engine ready', { timeout: 30_000 })
  await expect(win.locator('dl.kv')).toContainText(/Restarts\s*1/)

  await win.getByRole('button', { name: 'Ping engine' }).click()
  await expect(win.locator('pre.log')).toContainText(/ping ok[\s\S]*ping ok/, { timeout: 10_000 })
  await app.close()
})
