// Real Claude call (opt in: PCBSTUDIO_AGENT_E2E=1): the agent uses the engine tools to answer about the board.
import { test, expect, _electron as electron } from '@playwright/test'
import { existsSync } from 'fs'
import { join } from 'path'

const APP = join(__dirname, '..')
const CORPUS = process.env.PCBSTUDIO_CORPUS ?? '/Users/pacosw/code/iot-lab'

test('Claude answers from the board with engine tools', async () => {
  test.skip(process.env.PCBSTUDIO_AGENT_E2E !== '1', 'set PCBSTUDIO_AGENT_E2E=1 (uses the Claude login, costs tokens)')
  test.skip(!existsSync(CORPUS), 'iot-lab corpus missing')
  test.setTimeout(240_000)
  const app = await electron.launch({ args: [APP], env: { ...process.env, PCBSTUDIO_PROJECT: CORPUS } })
  app.process().stdout?.on('data', (d) => process.stdout.write(`[main] ${d}`))
  app.process().stderr?.on('data', (d) => process.stdout.write(`[main!] ${d}`))
  const win = await app.firstWindow()
  win.on('console', (m) => console.log('[renderer]', m.type(), m.text()))
  win.on('pageerror', (e) => console.log('[pageerror]', e.message))
  await expect(win.getByRole('status', { name: 'Engine status' })).toContainText('engine ready', { timeout: 30_000 })
  await win.getByRole('button', { name: 'Choose board' }).click({ timeout: 15_000 })
  await win.getByRole('dialog', { name: 'Boards' }).getByRole('searchbox').fill('POE-ETH')
  await win.getByRole('option', { name: /POE-ETHERNET/ }).click()
  await expect(win.getByRole('img', { name: /POE-ETHERNET/ })).toBeVisible({ timeout: 15_000 })

  await win.getByLabel('Message').fill('How many parts does this board have in its BOM, and how many BOM lines? Use the tools.')
  await win.getByRole('button', { name: 'Send' }).click()
  const log = win.getByRole('log', { name: 'Conversation' })
  await expect(log.locator('.toolchip', { hasText: 'pcb.' }).first()).toBeVisible({ timeout: 120_000 })
  await expect(log.locator('.meta').last()).toContainText(/turns|\$/, { timeout: 180_000 })
  await expect(log.locator('.bubble.claude').last()).toContainText('40')
  await win.screenshot({ path: join(APP, 'test-results', 'agent.png') })
  await app.close()
})
