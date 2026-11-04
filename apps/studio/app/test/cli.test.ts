// Port of engine/tests/test_cli.py, plus the exact arguments of each command. Run: node --test test/
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import type { TestContext } from 'node:test'
import { KiCadCliError, drc, erc, exportGlb, find, netlist, run, version } from '../src/main/kicad/cli.ts'

const CORPUS = process.env.PCBSTUDIO_CORPUS ?? path.join(os.homedir(), 'code/iot-lab')
const SMALL = path.join(CORPUS, 'hardware-design/boards/CHECKIN-FRONT/cad/CHECKIN-FRONT/CHECKIN-FRONT.kicad_pcb')

/** A stand-in kicad-cli for the length of one test. */
function fake(t: TestContext, body: string): { exe: string, dir: string } {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cli-')))
  const exe = path.join(dir, 'kicad-cli')
  fs.writeFileSync(exe, '#!/bin/sh\n' + body + '\n', { mode: 0o755 })
  const before = process.env.PCBSTUDIO_KICAD_CLI
  process.env.PCBSTUDIO_KICAD_CLI = exe
  t.after(() => {
    if (before === undefined) delete process.env.PCBSTUDIO_KICAD_CLI
    else process.env.PCBSTUDIO_KICAD_CLI = before
    fs.rmSync(dir, { recursive: true, force: true })
  })
  return { exe, dir }
}

/** Records its arguments, one per line, then writes `{}` to the path after -o. */
const RECORD = 'dir=$(dirname "$0"); for a in "$@"; do echo "$a"; done > "$dir/args"\n' +
  'while [ $# -gt 0 ]; do if [ "$1" = -o ]; then echo "{}" > "$2"; fi; shift; done'
const recorded = (dir: string): string[] => fs.readFileSync(path.join(dir, 'args'), 'utf8').trim().split('\n')

test('env override, timeout and failure', async t => {
  const { exe } = fake(t, 'if [ "$1" = version ]; then echo 9.9.9; exit 0; fi\n' +
                          'if [ "$1" = sleep ]; then sleep 5; fi\necho boom; exit 2')
  assert.equal(find(), exe)
  assert.equal(await version(), '9.9.9')
  await assert.rejects(run(['sleep'], { timeoutS: 0.5 }), /timed out/)
  await assert.rejects(run(['pcb', 'drc']), (e: KiCadCliError) => {
    assert.match(e.message, /exit 2/)
    assert.equal(e.returncode, 2)
    assert.ok(e.log.includes('boom'))
    return true
  })
  assert.equal((await run(['x'], { check: false })).returncode, 2)
})

test('a missing executable', async t => {
  const { dir } = fake(t, 'exit 0')
  process.env.PCBSTUDIO_KICAD_CLI = path.join(dir, 'nope')
  assert.equal(find(), null)
  assert.equal(await version(), null)
  await assert.rejects(run(['version']), /not found/)
})

test('stderr reaches the log and a bad folder is an error', async t => {
  fake(t, 'echo out; echo err >&2; exit 3')
  const r = await run(['x'], { check: false })
  assert.ok(r.log.includes('out') && r.log.includes('err'))
  await assert.rejects(run(['x'], { cwd: '/nonexistent-folder' }), /could not start/)
})

test('drc keeps schematic parity on by default and passes defines', async t => {
  const { dir } = fake(t, RECORD)
  const pcb = path.join(dir, 'b.kicad_pcb')
  assert.deepEqual(await drc(pcb, { defines: { IOT_LAB: '/p' } }), {})
  const a = recorded(dir)
  assert.deepEqual(a.slice(0, 11), ['pcb', 'drc', '--units', 'mm', '--schematic-parity', '-D', 'IOT_LAB=/p', '--format', 'json', '--severity-all', '-o'])
  assert.equal(a[a.length - 1], pcb)
  await drc(pcb, { schematicParity: false, refillZones: true })
  assert.deepEqual(recorded(dir).slice(0, 5), ['pcb', 'drc', '--units', 'mm', '--refill-zones'])
})

test('erc and netlist arguments', async t => {
  const { dir } = fake(t, RECORD)
  const sch = path.join(dir, 'b.kicad_sch')
  await erc(sch)
  assert.deepEqual(recorded(dir).slice(0, 8), ['sch', 'erc', '--units', 'mm', '--format', 'json', '--severity-all', '-o'])
  const out = path.join(dir, 'x/y/n.net')
  assert.equal(await netlist(sch, out), out)
  assert.deepEqual(recorded(dir), ['sch', 'export', 'netlist', '--format', 'kicadsexpr', '-o', out, sch])
})

test('a report that was not written is an error', async t => {
  fake(t, 'exit 0')
  await assert.rejects(drc('/tmp/x.kicad_pcb'), /wrote no report/)
})

test('glb is written through a temp name and a failure leaves nothing', async t => {
  const { dir } = fake(t, RECORD + '\necho "model not found: a.step"')
  const out = path.join(dir, 'm/b.glb')
  const res = await exportGlb(path.join(dir, 'b.kicad_pcb'), out, { defines: { K: 'v' } })
  assert.deepEqual([res.path, res.size, res.warnings], [out, 3, ['model not found: a.step']])
  assert.deepEqual(fs.readdirSync(path.dirname(out)), ['b.glb'])
  const a = recorded(dir)
  assert.deepEqual(a.slice(0, 14), ['pcb', 'export', 'glb', '--force', '--subst-models', '--include-tracks', '--include-pads',
    '--include-zones', '--include-silkscreen', '--include-soldermask', '--no-dnp', '-D', 'K=v', '-o'])
  assert.equal(a[14], path.join(dir, 'm/b.tmp.glb'))
  fs.writeFileSync(path.join(dir, 'kicad-cli'), '#!/bin/sh\necho x > "$(dirname "$0")/m/c.tmp.glb"\nexit 4\n')
  await assert.rejects(exportGlb(path.join(dir, 'b.kicad_pcb'), path.join(dir, 'm/c.glb')), /exit 4/)
  assert.deepEqual(fs.readdirSync(path.dirname(out)), ['b.glb'])
})

test('only this module runs kicad-cli', () => {
  const root = path.join(import.meta.dirname, '../src/main')
  const hits = (fs.readdirSync(root, { recursive: true }) as string[])
    .filter(f => f.endsWith('.ts') && path.basename(f) !== 'cli.ts' && /['"`]kicad-cli/.test(fs.readFileSync(path.join(root, f), 'utf8')))
  assert.deepEqual(hits, [])
})

test('real version and DRC report', { skip: !find() || !fs.existsSync(SMALL) }, async () => {
  assert.match((await version()) ?? '', /^\d+\.\d+/)
  const rep = await drc(SMALL, { schematicParity: false, timeoutS: 120 })
  assert.ok('violations' in rep && 'unconnected_items' in rep)
})
