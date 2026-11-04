// Web viewer (PWA) smoke test against a running `pcbstudio web` (PCBSTUDIO_WEB_URL, default http://127.0.0.1:8787).
import { test, expect, devices } from '@playwright/test'
import { existsSync, readFileSync } from 'fs'
import { homedir } from 'os'
import { join } from 'path'

const URL = process.env.PCBSTUDIO_WEB_URL ?? 'http://127.0.0.1:8787'
// The viewer token (engine web.py): PCBSTUDIO_WEB_TOKEN, else the server's token file.
const TOKEN_FILE = join(homedir(), 'Library', 'Application Support', 'pcbstudio', 'web-token')
const TOKEN = process.env.PCBSTUDIO_WEB_TOKEN ?? (existsSync(TOKEN_FILE) ? readFileSync(TOKEN_FILE, 'utf8').trim() : '')

test.use({ ...devices['iPhone 15 Pro'], browserName: 'chromium' })

test('phone: open a board read-only', async ({ page }) => {
  await page.goto(`${URL}/?t=${encodeURIComponent(TOKEN)}`)
  await expect(page.getByRole('status', { name: 'Engine status' })).toContainText('engine ready', { timeout: 20_000 })
  await expect(page.getByText('web viewer · read-only')).toBeVisible()
  await page.getByRole('button', { name: 'Choose board' }).click()
  await page.getByRole('dialog', { name: 'Boards' }).getByRole('searchbox').fill('POE-ETH')
  await page.getByRole('option', { name: /POE-ETHERNET/ }).click()
  await expect(page.getByRole('img', { name: /POE-ETHERNET\.kicad_pcb/ })).toBeVisible({ timeout: 20_000 })
  await page.waitForTimeout(500)
  await page.screenshot({ path: 'test-results/web-phone.png' })
})
