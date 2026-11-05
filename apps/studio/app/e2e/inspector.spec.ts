import { test, expect, _electron as electron } from '@playwright/test'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const APP = join(__dirname, '..')
test('native specifications render with units and BOM, without opening the assistant', async () => {
  const root = mkdtempSync(join(tmpdir(), 'studio-inspector-'))
  const cad = join(root, 'hardware-design/boards/DEMO/cad')
  mkdirSync(cad, { recursive: true })
  writeFileSync(join(cad, 'DEMO.kicad_pcb'), `(kicad_pcb (version 20260206) (generator "test")
    (layers (0 "F.Cu" signal) (2 "B.Cu" signal))
    (gr_rect (start 0 0) (end 30 30) (layer "Edge.Cuts") (stroke (width 0.1) (type solid)))
    (footprint "Test:R" (layer "F.Cu") (at 10 10) (property "Reference" "R1") (property "Value" "10k") (property "LCSC" "C1001") (attr smd)))`)
  writeFileSync(join(root, 'hardware-design/boards/DEMO/board.yaml'), 'id: DEMO\nlifecycle: prototype\nrevisions:\n  - rev: A\n    pcb: cad/DEMO.kicad_pcb\n    bom: BOM.csv\n')
  writeFileSync(join(root, 'hardware-design/boards/DEMO/BOM.csv'), 'Designator,LCSC,Unit price,Currency,Supplier,Price observed UTC,Minimum quantity\nR1,C1001,0.0123,USD,Example,2026-10-01,100\n')
  const cli = join(root, 'kicad-cli')
  writeFileSync(cli, `#!/bin/sh
if [ "$1" = api-server ]; then echo "headless API unavailable in fixture"; exit 2; fi
if [ "$1" = version ]; then echo 10.99.0-fixture; exit 0; fi
if [ "$4" = --help ]; then exit 0; fi
kind="$3"
while [ "$1" != -o ]; do shift; done
case "$kind" in
stats) printf '%s' '{"board":{"width":"30.0000 mm","height":"30.0000 mm","board_thickness":"1.6000 mm"}}' > "$2";;
stackup) printf '%s' '{"layers":[{"userName":"F.Cu","materialName":"copper","thickness":{"valueNm":"35000"}}]}' > "$2";;
bom) printf 'Refs,Value,Footprint,Qty\\nR1,10k,0603,1\\n' > "$2";;
esac
`, { mode: 0o755 })
  const app = await electron.launch({ args: [APP], env: { ...process.env, PCBSTUDIO_PROJECT: root, PCBSTUDIO_KICAD_CLI: cli } })
  try {
    const win = await app.firstWindow()
    await expect(win.getByRole('status', { name: 'Engine status' })).toContainText('engine ready', { timeout: 30_000 })
    await win.getByRole('button', { name: 'Choose board' }).click()
    await win.getByRole('option', { name: /DEMO/ }).click()
    await win.getByRole('button', { name: 'Specifications' }).click()
    await win.getByRole('button', { name: 'Native board data' }).click()
    const panel = win.getByRole('region', { name: 'Board specifications' })
    await expect(panel.getByText('1.6000 mm', { exact: true })).toBeVisible()
    await expect(panel.getByRole('cell', { name: '0.035', exact: true })).toBeVisible()
    await expect(panel.getByRole('cell', { name: 'R1', exact: true })).toBeVisible()
    await expect(win.getByRole('button', { name: 'Show assistant' })).toBeVisible()
    await win.screenshot({ path: join(APP, 'test-results/inspector.png') })
    await panel.getByRole('button', { name: 'Inspect native objects' }).click()
    await expect(panel.getByRole('alert')).toContainText('headless API unavailable in fixture')
    await panel.getByRole('button', { name: 'Refresh specifications' }).click()
    await expect(panel.getByRole('cell', { name: 'R1', exact: true })).toBeVisible()
    await win.getByRole('button', { name: /Parts \/ BOM/ }).click()
    await expect(win.getByRole('cell', { name: 'USD 0.0123', exact: true })).toBeVisible()
    await win.getByRole('button', { name: 'R1', exact: true }).click()
    await expect(win.getByRole('region', { name: 'Recorded price evidence' })).toContainText('2026-10-01')
    await win.screenshot({ path: join(APP, 'test-results/prices.png') })
  } finally { await app.close(); rmSync(root, { recursive: true, force: true }) }
})
