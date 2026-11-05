import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { Project } from '../src/main/project.ts'
import { specification } from '../src/main/spec.ts'

test('spec reader follows the assigned revision and refuses files outside the project', t => {
  const root = fs.mkdtempSync('/tmp/spec-document-'), board = root + '/hardware-design/boards/DEMO'
  fs.mkdirSync(board + '/cad', { recursive: true })
  for (const rev of ['A', 'B']) {
    fs.writeFileSync(`${board}/cad/${rev}.kicad_pcb`, '(kicad_pcb)')
    fs.writeFileSync(`${board}/SPEC-${rev}.md`, `# Revision ${rev}\n\n| Rating | Value |\n| --- | --- |\n| Voltage | 5 V |`)
  }
  fs.writeFileSync(board + '/board.yaml', 'id: DEMO\nlifecycle: prototype\nrevisions:\n  - rev: A\n    pcb: cad/A.kicad_pcb\n    spec: SPEC-A.md\n  - rev: B\n    pcb: cad/B.kicad_pcb\n    spec: SPEC-B.md\n')
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const project = new Project(root), doc = specification(project, 'hardware-design/boards/DEMO/cad/B.kicad_pcb')
  assert.equal(doc.revision, 'B'); assert.match(doc.source, /SPEC-B.md$/); assert.match(doc.text!, /Revision B/)
  assert.equal(doc.sha256.length, 64)
  fs.unlinkSync(board + '/SPEC-B.md'); fs.symlinkSync('/etc/hosts', board + '/SPEC-B.md')
  assert.throws(() => specification(project, 'hardware-design/boards/DEMO/cad/B.kicad_pcb'))
})
