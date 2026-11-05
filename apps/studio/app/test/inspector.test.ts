import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { inspectBoard } from '../src/main/kicad/inspector.ts'

test('inspector uses private snapshots and separates unsupported exports from failures', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'inspector-test-'))
  const file = path.join(dir, 'board.kicad_pcb'), exe = path.join(dir, 'cli')
  fs.writeFileSync(file, '(kicad_pcb)')
  fs.writeFileSync(path.join(dir, 'board.kicad_pro'), '{}')
  fs.writeFileSync(exe, `#!/bin/sh
if [ "$1" = version ]; then echo 10.99.0-test; exit 0; fi
if [ "$4" = --help ]; then [ "$3" != stackup ]; exit $?; fi
if [ "$3" = bom ]; then echo export-failed; exit 2; fi
for arg in "$@"; do last="$arg"; done
[ "$last" != '${file}' ] || exit 8
[ -f "$(dirname "$last")/board.kicad_pro" ] || exit 9
while [ "$1" != -o ]; do shift; done
printf '{"board":{"width":"30 mm"}}' > "$2"
printf '%s' "$last" > '${path.join(dir, 'snapshot')}'
`, { mode: 0o755 })
  const before = process.env.PCBSTUDIO_KICAD_CLI
  process.env.PCBSTUDIO_KICAD_CLI = exe
  t.after(() => { if (before === undefined) delete process.env.PCBSTUDIO_KICAD_CLI; else process.env.PCBSTUDIO_KICAD_CLI = before; fs.rmSync(dir, { recursive: true, force: true }) })
  const result = await inspectBoard(file, 'board.kicad_pcb')
  assert.equal(result.stats.state, 'ready')
  assert.equal(result.stackup.state, 'unavailable')
  assert.equal(result.bom.state, 'error')
  assert.match(result.bom.message!, /export-failed/)
  assert.equal(fs.readFileSync(file, 'utf8'), '(kicad_pcb)')
  assert.equal(fs.existsSync(fs.readFileSync(path.join(dir, 'snapshot'), 'utf8')), false)
  await assert.rejects(inspectBoard(path.join(dir, 'board.kicad_pro'), 'bad'), /PCB file/)
})
