import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { nativeInventory } from '../src/main/kicad/inventory.ts'

test('native inventory rejects external sheets and cleans up unsupported sessions', async t => {
  const dir = fs.mkdtempSync('/tmp/inventory-test-'), root = path.join(dir, 'project')
  fs.mkdirSync(root)
  fs.writeFileSync(path.join(root, 'board.kicad_pcb'), '(kicad_pcb)')
  fs.writeFileSync(path.join(dir, 'outside.kicad_sch'), '(kicad_sch)')
  fs.writeFileSync(path.join(root, 'board.kicad_sch'), '(kicad_sch (sheet (property "Sheetfile" "../outside.kicad_sch")))')
  const cli = path.join(dir, 'cli'), marker = path.join(dir, 'started')
  fs.writeFileSync(cli, `#!/bin/sh\npwd > '${marker}'\necho 'Unsupported headless API'\nexit 2\n`, { mode: 0o755 })
  const before = process.env.PCBSTUDIO_KICAD_CLI
  process.env.PCBSTUDIO_KICAD_CLI = cli
  t.after(() => { if (before === undefined) delete process.env.PCBSTUDIO_KICAD_CLI; else process.env.PCBSTUDIO_KICAD_CLI = before; fs.rmSync(dir, { recursive: true, force: true }) })
  await assert.rejects(nativeInventory(root, 'board.kicad_pcb', 'board.kicad_sch'), /leaves the project/)
  assert.equal(fs.existsSync(marker), false)
  await assert.rejects(nativeInventory(root, 'board.kicad_pcb', null), /Unsupported headless API/)
  assert.equal(fs.existsSync(fs.readFileSync(marker, 'utf8').trim()), false)
  assert.equal(fs.readFileSync(path.join(root, 'board.kicad_pcb'), 'utf8'), '(kicad_pcb)')
})
