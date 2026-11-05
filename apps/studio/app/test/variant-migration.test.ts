import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { Project } from '../src/main/project.ts'
import { migrate } from '../src/main/migrate.ts'

test('schematic pending layout can omit PCB without an active gate', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'studio-schematic-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const dir = path.join(root, 'hardware-design/boards/MAIN')
  fs.mkdirSync(dir, { recursive: true })
  fs.mkdirSync(path.join(root, 'hardware-design/registry'), { recursive: true })
  fs.writeFileSync(path.join(dir, 'P.kicad_sch'), '')
  const rev = { revision: 'C', state: 'schematic-pending-layout', project: 'P', gate: null as string | null }
  const write = () => fs.writeFileSync(path.join(root, 'hardware-design/registry/boards.json'), JSON.stringify({ boards: [{ id: 'MAIN', directory: 'MAIN', revisions: [rev] }] }))
  write()
  const p = new Project(root); p.boards()
  assert.equal(p.conflicts.some(c => c.kind === 'registry_pcb_missing'), false)
  rev.gate = 'MAIN'; write(); p.boards()
  assert.equal(p.conflicts.some(c => c.kind === 'registry_pcb_missing'), true)
})

test('virtual variants survive migration without inventing a directory', t => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'studio-variant-'))
  t.after(() => fs.rmSync(temp, { recursive: true, force: true }))
  const root = path.join(temp, 'project'), base = path.join(root, 'hardware-design/boards')
  fs.mkdirSync(path.join(base, 'MAIN'), { recursive: true })
  fs.mkdirSync(path.join(root, 'hardware-design/registry'), { recursive: true })
  fs.writeFileSync(path.join(root, 'hardware-design/registry/boards.json'), JSON.stringify({ boards: [
    { id: 'MAIN', directory: 'MAIN', kind: 'board', lifecycle: 'active', revisions: [] },
    { id: 'MAIN-V', directory: null, kind: 'variant', lifecycle: 'planned', variant_of: 'MAIN' }
  ] }))
  const before = new Project(root).boards()
  assert.equal(before.find(b => b.id === 'MAIN-V')?.identity, 'registry-variant')
  const out = path.join(temp, 'output'), report = migrate(root, out)
  assert.equal(report.round_trip, true)
  assert.equal(report.ready_for_promotion, true)
  assert.equal(report.boards, 2)
  assert.equal(fs.existsSync(path.join(out, 'MAIN-V')), false)
  assert.equal(new Project(root, {}, out).boards().find(b => b.id === 'MAIN-V')?.variant_of, 'MAIN')
  assert.equal(report.conflicts.some(c => c.board === 'MAIN-V'), false)
})

test('unassigned native CAD is preserved but blocks metadata promotion', t => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'studio-unregistered-'))
  t.after(() => fs.rmSync(temp, { recursive: true, force: true }))
  const root = path.join(temp, 'project'), board = path.join(root, 'hardware-design/boards/MAIN')
  fs.mkdirSync(path.join(board, 'cad'), { recursive: true })
  fs.writeFileSync(path.join(board, 'cad/MAIN.kicad_pcb'), '(kicad_pcb (version 1))')
  fs.writeFileSync(path.join(board, 'gate.json'), JSON.stringify({ project: 'cad/MAIN' }))
  fs.mkdirSync(path.join(root, 'hardware-design/registry'), { recursive: true })
  fs.writeFileSync(path.join(root, 'hardware-design/registry/boards.json'), JSON.stringify({ boards: [
    { id: 'MAIN', directory: 'MAIN', kind: 'board', lifecycle: 'planned',
      revisions: [{ revision: 'A', state: 'needs-review', project: null }] }
  ] }))
  const report = migrate(root, path.join(temp, 'output'))
  assert.equal(report.round_trip, true)
  assert.equal(report.ready_for_promotion, false)
  assert.ok(report.conflicts.some(c => c.board === 'MAIN' && c.kind === 'unregistered_native_revision'))
  const unregistered = new Project(root).boards()[0].revisions.find(r => r.state === 'unregistered')
  assert.equal(unregistered?.revision, null)
  assert.equal(unregistered?.gate, 'MAIN')
})
