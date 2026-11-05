import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { exportSchematic } from '../src/main/kicad/schematic.ts'

test('schematic export copies hierarchy, preserves source bytes and rejects external sheets', async t => {
  const dir = fs.mkdtempSync('/tmp/studio-sch-test-'), root = path.join(dir, 'project')
  fs.mkdirSync(root)
  fs.writeFileSync(path.join(root, 'main.kicad_sch'), '(kicad_sch (sheet (property "Sheetfile" "child.kicad_sch")))')
  fs.writeFileSync(path.join(root, 'child.kicad_sch'), '(kicad_sch)')
  const cli = path.join(dir, 'cli'), observed = path.join(dir, 'input')
  fs.writeFileSync(cli, `#!/bin/sh
if [ "$1" = version ]; then echo 10.0.6-test; exit 0; fi
for arg in "$@"; do input="$arg"; done
[ "$input" != '${path.join(root, 'main.kicad_sch')}' ] || exit 8
[ -f "$(dirname "$input")/child.kicad_sch" ] || exit 9
printf '%s' "$input" > '${observed}'
while [ "$1" != -o ]; do shift; done
printf '<svg xmlns="http://www.w3.org/2000/svg"/>' > "$2/main.svg"
printf '<svg xmlns="http://www.w3.org/2000/svg"/>' > "$2/main-child.svg"
`, { mode: 0o755 })
  const before = process.env.PCBSTUDIO_KICAD_CLI
  process.env.PCBSTUDIO_KICAD_CLI = cli
  t.after(() => { if (before === undefined) delete process.env.PCBSTUDIO_KICAD_CLI; else process.env.PCBSTUDIO_KICAD_CLI = before; fs.rmSync(dir, { recursive: true, force: true }) })
  const original = fs.readFileSync(path.join(root, 'main.kicad_sch'))
  const result = await exportSchematic(root, 'main.kicad_sch', path.join(dir, 'output'))
  assert.deepEqual(result.sheets.map(s => s.name), ['main', 'main-child'])
  assert.deepEqual(fs.readFileSync(path.join(root, 'main.kicad_sch')), original)
  assert.equal(fs.existsSync(fs.readFileSync(observed, 'utf8')), false)
  fs.writeFileSync(path.join(dir, 'external.kicad_sch'), '(kicad_sch)')
  fs.writeFileSync(path.join(root, 'main.kicad_sch'), '(kicad_sch (sheet (property "Sheetfile" "../external.kicad_sch")))')
  await assert.rejects(exportSchematic(root, 'main.kicad_sch', path.join(dir, 'output')), /leaves the project/)
})
