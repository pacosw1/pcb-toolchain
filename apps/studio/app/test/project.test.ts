// Port of engine/tests/test_project.py, without the migrate writer. Run: node --test test/
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import type { TestContext } from 'node:test'
import { Project, ProjectError } from '../src/main/project.ts'

const CORPUS = process.env.PCBSTUDIO_CORPUS ?? path.join(os.homedir(), 'code/iot-lab')

function write(p: string, text: string): void {
  fs.mkdirSync(path.dirname(p), { recursive: true })
  fs.writeFileSync(p, text)
}

function tmp(t: TestContext): string {
  const d = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'project-')))
  t.after(() => fs.rmSync(d, { recursive: true, force: true }))
  return d
}

/** MAIN rev A (gate MAIN + a variant) and rev B (gate in the gate-only folder MAIN-B; the registry names another
 *  gate), and NEW, a board the registry does not list but whose gate.json points at it. */
function multi(t: TestContext): string {
  const root = tmp(t), b = path.join(root, 'hardware-design/boards')
  for (const rel of ['MAIN/cad/MAIN/MAIN.kicad_pcb', 'MAIN/cad/MAIN-B/MAIN-B.kicad_pcb', 'NEW/cad/NEW/NEW.kicad_pcb']) {
    write(path.join(b, rel), '(kicad_pcb (version 1))')
  }
  write(path.join(b, 'MAIN/cad/MAIN/MAIN.kicad_sch'), '(kicad_sch)')
  write(path.join(b, 'MAIN/SPEC.md'), '# spec')
  write(path.join(b, 'MAIN/BOM-B.csv'), 'Designator,LCSC\n')
  write(path.join(b, 'MAIN/gate.json'), JSON.stringify({ project: 'cad/MAIN/MAIN' }))
  write(path.join(b, 'MAIN/gate-6layer.json'), JSON.stringify({ project: 'cad/MAIN/MAIN' }))
  write(path.join(b, 'MAIN/gate-metrics.json'), '{}')
  write(path.join(b, 'MAIN-B/gate.json'), JSON.stringify({ project: '../MAIN/cad/MAIN-B/MAIN-B', pipeline: 'tools/main_b_pipeline.sh' }))
  write(path.join(b, 'NEW/gate.json'), JSON.stringify({ project: 'cad/NEW/NEW', pipeline: 'tools/missing.sh' }))
  write(path.join(root, 'tools/main_b_pipeline.sh'), '#!/bin/sh\n')
  write(path.join(root, 'hardware-design/registry/boards.json'), JSON.stringify({ boards: [
    { id: 'MAIN', directory: 'MAIN', lifecycle: 'active', kind: 'board', revisions: [
      { revision: 'A', state: 'old', project: 'cad/MAIN/MAIN', spec: 'SPEC.md', gate: null },
      { revision: 'B', state: 'layout', project: 'cad/MAIN-B/MAIN-B', gate: 'WRONG', bom: 'BOM-B.csv' }] },
    { id: 'MAIN-B', directory: 'MAIN-B', kind: 'gate-only', revision: 'B' }] }))
  return root
}

test('a folder without boards is no project', t => {
  assert.throws(() => new Project(tmp(t)), ProjectError)
})

test('a small project', t => {
  const root = tmp(t)
  write(path.join(root, 'hardware-design/boards/DEMO/cad/DEMO/DEMO.kicad_pcb'), '(kicad_pcb (version 1))')
  assert.deepEqual(new Project(root).boards(), [{ id: 'DEMO', directory: 'DEMO', lifecycle: 'unregistered', kind: null, variant_of: null,
    identity: 'legacy', revisions: [{ revision: null, state: 'unregistered', pcb: 'hardware-design/boards/DEMO/cad/DEMO/DEMO.kicad_pcb',
      sch: null, spec: null, bom: null, gate: null, gates: [], pipeline: null }] }])
  assert.throws(() => new Project(root).resolve('../outside.kicad_pcb'), ProjectError)
})

test('resolve follows a link before it applies ..', t => {
  const root = tmp(t), outside = tmp(t)
  write(path.join(root, 'hardware-design/boards/DEMO/x'), '')
  fs.mkdirSync(path.join(outside, 'deep'))
  fs.symlinkSync(path.join(outside, 'deep'), path.join(root, 'link'))
  const p = new Project(root)
  assert.throws(() => p.resolve('link/../secret'), ProjectError)          // lexically inside; really outside
  assert.throws(() => p.resolve('link/file'), ProjectError)
  assert.equal(p.existing(root, 'link/../secret'), null)
  assert.equal(p.resolve('hardware-design'), path.join(root, 'hardware-design'))
})

test('gates come from gate.json', t => {
  const p = new Project(multi(t))
  const boards = new Map(p.boards().map(b => [b.id, b]))
  assert.deepEqual([...boards.keys()].sort(), ['MAIN', 'NEW'])            // MAIN-B is gate data, not a board
  const [a, b] = boards.get('MAIN')!.revisions
  assert.equal(a.gate, 'MAIN')
  assert.deepEqual(a.gates.map(g => [g.name, g.config, g.variant]), [['MAIN', 'gate.json', null], ['MAIN', 'gate-6layer.json', '6layer']])
  assert.ok(a.sch!.endsWith('MAIN.kicad_sch'))
  assert.equal(a.spec, 'hardware-design/boards/MAIN/SPEC.md')
  assert.equal(b.gate, 'MAIN-B')
  assert.equal(b.pipeline, 'tools/main_b_pipeline.sh')
  assert.ok(b.bom!.endsWith('BOM-B.csv'))
  assert.equal(boards.get('NEW')!.revisions[0].gate, 'NEW')
  assert.equal(boards.get('NEW')!.revisions[0].pipeline, null)            // named in gate.json, but no such file
  const kinds = new Set(p.conflicts.map(c => `${c.board} ${c.kind}`))
  for (const k of ['MAIN registry_gate_differs', 'MAIN registry_gate_missing', 'MAIN-B gate_only_folder', 'NEW unregistered_board']) {
    assert.ok(kinds.has(k), k)
  }
})

test('the layout is configurable', t => {
  const root = multi(t)
  fs.mkdirSync(path.join(root, 'hw'))
  fs.renameSync(path.join(root, 'hardware-design'), path.join(root, 'hw/design'))
  assert.throws(() => new Project(root), ProjectError)
  const p = new Project(root, { boards_dir: 'hw/design/boards', registry: 'hw/design/registry/boards.json' })
  assert.deepEqual(p.boards().map(b => b.id).sort(), ['MAIN', 'NEW'])
})

test('board.yaml wins over the registry, and a wrong gate is a conflict', t => {
  const root = multi(t), b = path.join(root, 'hardware-design/boards')
  write(path.join(b, 'NEW/board.yaml'), 'schema: pcbstudio.board.v1\nid: NEW\nlifecycle: active\nrevisions:\n' +
    '- rev: A\n  state: layout\n  pcb: cad/NEW/NEW.kicad_pcb\n  gate: NEW\n  gates:\n  - name: NEW\n  pipeline: tools/main_b_pipeline.sh\n')
  let p = new Project(root)
  const board = p.boards().find(x => x.id === 'NEW')!
  assert.equal(board.identity, 'board.yaml')
  assert.deepEqual(board.revisions[0].gates, [{ name: 'NEW', config: 'gate.json', variant: null }])
  assert.equal(board.revisions[0].pipeline, 'tools/main_b_pipeline.sh')
  assert.deepEqual(p.conflicts.filter(c => c.kind.startsWith('board_yaml')), [])
  const f = path.join(b, 'NEW/board.yaml')
  fs.writeFileSync(f, fs.readFileSync(f, 'utf8').replace('name: NEW', 'name: MAIN'))
  p = new Project(root)
  p.boards()
  assert.ok(p.conflicts.some(c => c.kind === 'board_yaml_gate_mismatch' && c.board === 'NEW'))
  assert.ok(p.conflicts.some(c => c.kind === 'board_yaml_gate_unlisted' && c.board === 'NEW'))
})

test('board.yaml rejects unknown fields', t => {
  const root = multi(t)
  write(path.join(root, 'hardware-design/boards/NEW/board.yaml'), 'schema: pcbstudio.board.v1\nid: NEW\nlifecycle: x\nrevs: []\n')
  assert.throws(() => new Project(root).boards(), (e: Error) => e instanceof ProjectError && /revs/.test(e.message))
})

test('the iot-lab project opens', { skip: !fs.existsSync(path.join(CORPUS, 'hardware-design/boards')) }, () => {
  const info = new Project(CORPUS).info()
  assert.ok(info.boards.length > 10)
  const hit = info.boards.flatMap(b => b.revisions).find(r => r.pcb)
  assert.ok(hit && new Project(CORPUS).revisionForPcb(hit.pcb!))
})
