import { test, expect, _electron as electron } from '@playwright/test'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
const APP = join(__dirname, '..')

test('schematic sheets render with zoom, fit and sheet selection', async () => {
  const root = mkdtempSync(join(tmpdir(), 'studio-sch-')), cad = join(root, 'hardware-design/boards/DEMO/cad')
  mkdirSync(cad, { recursive: true })
  writeFileSync(join(cad, 'DEMO.kicad_pcb'), '(kicad_pcb (version 20260206) (generator "test") (layers (0 "F.Cu" signal)) (gr_rect (start 0 0) (end 30 30) (layer "Edge.Cuts") (stroke (width 0.1) (type solid))))')
  writeFileSync(join(cad, 'DEMO.kicad_sch'), '(kicad_sch (sheet (property "Sheetfile" "child.kicad_sch")))')
  writeFileSync(join(cad, 'child.kicad_sch'), '(kicad_sch)')
  writeFileSync(join(root, 'hardware-design/boards/DEMO/board.yaml'), 'id: DEMO\nlifecycle: prototype\nrevisions:\n  - rev: A\n    pcb: cad/DEMO.kicad_pcb\n    sch: cad/DEMO.kicad_sch\n')
  const cli = join(root, 'cli')
  writeFileSync(cli, `#!/bin/sh
if [ "$1" = version ]; then echo 10.0.6-fixture; exit 0; fi
while [ "$1" != -o ]; do shift; done
printf '<svg xmlns="http://www.w3.org/2000/svg" width="800" height="600"><rect width="800" height="600" fill="white"/><path d="M100 100 H600 V400 H100 Z" stroke="green" fill="none"/><text x="200" y="250" font-size="36">Schematic fixture</text></svg>' > "$2/DEMO.svg"
cp "$2/DEMO.svg" "$2/DEMO-child.svg"
`, { mode: 0o755 })
  const app = await electron.launch({ args: [APP], env: { ...process.env, PCBSTUDIO_PROJECT: root, PCBSTUDIO_KICAD_CLI: cli } })
  try {
    const win = await app.firstWindow()
    await expect(win.getByRole('status', { name: 'Engine status' })).toContainText('engine ready', { timeout: 30_000 })
    await win.getByRole('button', { name: 'Choose board' }).click()
    await win.getByRole('option', { name: /DEMO/ }).click()
    await win.getByRole('button', { name: 'Schematic', exact: true }).click()
    const panel = win.getByRole('region', { name: 'Schematic viewer' })
    await expect(panel.getByRole('img')).toBeVisible()
    await expect.poll(() => panel.getByRole('img').evaluate(el => (el as HTMLImageElement).naturalWidth)).toBeGreaterThan(0)
    await expect(win.getByLabel('Sheet', { exact: true }).locator('option')).toHaveCount(2)
    await win.getByRole('button', { name: 'Zoom in schematic' }).click()
    await expect(win.getByLabel('Schematic zoom')).toHaveText('125%')
    await win.getByRole('button', { name: 'Fit sheet' }).click()
    await expect(win.getByLabel('Schematic zoom')).toHaveText('100%')
    const viewport = win.getByLabel('Schematic pan and zoom', { exact: true })
    await viewport.dispatchEvent('wheel', { deltaY: 40, deltaX: 20, deltaMode: 0 })
    await expect(win.getByLabel('Schematic zoom')).toHaveText('100%')
    await expect.poll(() => panel.getByRole('img').evaluate(el => { const m = new DOMMatrix(getComputedStyle(el).transform); return [m.a, m.e, m.f] })).toEqual([1, -20, -40])
    await viewport.dispatchEvent('wheel', { deltaY: -10, deltaX: 0, deltaMode: 0, ctrlKey: true, clientX: 500, clientY: 400 })
    await expect(win.getByLabel('Schematic zoom')).not.toHaveText('100%')
    await win.getByRole('button', { name: 'Fit sheet' }).click()
    await win.getByLabel('Sheet', { exact: true }).selectOption('1')
    await expect(panel.getByRole('img')).toHaveAttribute('alt', /Schematic DEMO/)
    await win.screenshot({ path: join(APP, 'test-results/schematic-fixture.png') })
  } finally { await app.close(); rmSync(root, { recursive: true, force: true }) }
})

test('real ENV-SENSE schematic uses native KiCad SVG', async () => {
  const root = process.env.PCBSTUDIO_SCHEMATIC_PROOF
  test.skip(!root, 'Set PCBSTUDIO_SCHEMATIC_PROOF for real native schematic rendering')
  const app = await electron.launch({ args: [APP], env: { ...process.env, PCBSTUDIO_PROJECT: root! } })
  try {
    const win = await app.firstWindow()
    await expect(win.getByRole('status', { name: 'Engine status' })).toContainText('engine ready', { timeout: 30_000 })
    await win.getByRole('button', { name: 'Choose board' }).click()
    await win.getByRole('dialog', { name: 'Boards' }).getByRole('searchbox').fill('ENV-SENSE')
    await win.getByRole('option', { name: /ENV-SENSE/ }).click()
    await win.getByRole('button', { name: 'Schematic', exact: true }).click()
    const sheet = win.getByRole('img', { name: 'Schematic ENV-SENSE', exact: true })
    await expect(sheet).toBeVisible({ timeout: 30_000 })
    await expect.poll(() => sheet.evaluate(el => (el as HTMLImageElement).naturalWidth)).toBeGreaterThan(0)
    await win.screenshot({ path: join(APP, 'test-results/schematic-native.png') })
    await win.getByRole('button', { name: 'Zoom in schematic' }).click({ clickCount: 3 })
    const viewport = win.getByLabel('Schematic pan and zoom', { exact: true })
    const box = (await viewport.boundingBox())!
    await win.evaluate(() => {
      const frames: number[] = []; let last = performance.now()
      const sample = (now: number): void => { frames.push(now - last); last = now; if (frames.length < 120) requestAnimationFrame(sample) }
      ;(window as unknown as { schematicFrames: number[] }).schematicFrames = frames
      requestAnimationFrame(sample)
    })
    await win.mouse.move(box.x + box.width * 0.5, box.y + box.height * 0.5)
    await win.mouse.down(); await win.mouse.move(box.x + box.width * 0.65, box.y + box.height * 0.6, { steps: 80 }); await win.mouse.up()
    await win.waitForTimeout(1000)
    const frames = await win.evaluate(() => (window as unknown as { schematicFrames: number[] }).schematicFrames)
    const sorted = frames.slice(3).sort((a, b) => a - b)
    writeFileSync(join(APP, 'test-results/schematic-performance.json'), JSON.stringify({ samples: sorted.length, medianMs: sorted[Math.floor(sorted.length / 2)], p95Ms: sorted[Math.floor(sorted.length * 0.95)] }, null, 2))
    await win.screenshot({ path: join(APP, 'test-results/schematic-detail.png') })
  } finally { await app.close() }
})
