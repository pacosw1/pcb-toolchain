import { test, expect, _electron as electron } from '@playwright/test'
import { join } from 'node:path'
import { writeFileSync } from 'node:fs'
const APP = join(__dirname, '..')

test('real revision spec renders as a branded document and prints to PDF', async () => {
  const root = process.env.PCBSTUDIO_SPEC_PROOF
  test.skip(!root, 'Set PCBSTUDIO_SPEC_PROOF to render a real project specification')
  const app = await electron.launch({ args: [APP], env: { ...process.env, PCBSTUDIO_PROJECT: root! } })
  try {
    const win = await app.firstWindow()
    await expect(win.getByRole('status', { name: 'Engine status' })).toContainText('engine ready', { timeout: 30_000 })
    await win.getByRole('button', { name: 'Choose board' }).click()
    await win.getByRole('dialog', { name: 'Boards' }).getByRole('searchbox').fill('POE-ETHERNET')
    await win.getByRole('option', { name: /POE-ETHERNET/ }).click()
    await win.getByRole('button', { name: 'Specifications', exact: true }).click()
    const doc = win.getByRole('region', { name: 'Specification document' })
    await expect(doc.getByRole('heading', { name: 'POE-ETHERNET', exact: true })).toBeVisible()
    await expect(doc.getByLabel('SW Industries')).toBeVisible()
    await expect(doc.getByText('Revision 0.1. Candidate requirements only.')).toBeVisible()
    await win.screenshot({ path: join(APP, 'test-results/spec-document.png') })
    const bytes = await app.evaluate(async ({ BrowserWindow }) => {
      const result = await BrowserWindow.getAllWindows()[0].webContents.printToPDF({ printBackground: true, preferCSSPageSize: true })
      return result.toString('base64')
    })
    writeFileSync(join(APP, 'test-results/POE-ETHERNET-spec-sheet.pdf'), Buffer.from(bytes, 'base64'))
    await doc.getByRole('button', { name: 'Native board data' }).click()
    await expect(win.getByRole('heading', { name: 'Board specifications', exact: true })).toBeVisible()
  } finally { await app.close() }
})
