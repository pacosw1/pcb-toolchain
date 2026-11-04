// Port of the corpus-free cases of engine/tests/test_board.py. Run: node --test test/
import assert from 'node:assert/strict'
import test from 'node:test'
import { bbox, fromTree } from '../src/main/kicad/board.ts'
import { parse } from '../src/main/kicad/sexpr.ts'

const load = (text: string): ReturnType<typeof fromTree> => fromTree(parse(text))

test('an empty board has a bbox', () => {
  const geo = load('(kicad_pcb (version 20260206) (generator "test"))\n')
  assert.deepEqual(bbox(geo), [0, 0, 0, 0])
  assert.deepEqual(geo.outline, [])
  assert.equal(geo.outline_open, 0)
})

test('outline pieces join into one loop', () => {
  const lines = [[[0, 0], [10, 0]], [[10, 5], [10, 0]], [[10, 5], [0, 5]], [[0, 0], [0, 5]]]     // mixed directions
  const body = lines.map(([a, b]) => `(gr_line (start ${a[0]} ${a[1]}) (end ${b[0]} ${b[1]}) (layer "Edge.Cuts"))`).join('')
  const geo = load(`(kicad_pcb (version 20260206) ${body})\n`)
  assert.equal(geo.outline.length, 1)
  assert.equal(geo.outline_open, 0)
  assert.equal(geo.outline[0].length, 5)
  assert.deepEqual(geo.outline[0][0], geo.outline[0][4])
  assert.deepEqual(bbox(geo), [0, 0, 10, 5])
})

test('a pad without an angle is not rotated with its footprint', () => {
  const geo = load('(kicad_pcb (version 20260206) (footprint "X" (layer "F.Cu") (at 10 10 90)' +
    ' (property "Reference" "U1")' +
    ' (pad "1" smd rect (at 1 0) (size 1 2) (layers "F.Cu"))' +
    ' (pad "2" thru_hole oval (at -1 0 90) (size 1 2) (drill oval 0.4 0.8) (layers "*.Cu"))))\n')
  const [p1, p2] = geo.footprints[0].pads
  assert.equal(p1.rot, 0)
  assert.deepEqual([p1.x, p1.y], [10, 9])
  assert.equal(p2.rot, 90)
  assert.deepEqual([p2.drill, p2.drill_h, p2.drill_shape], [0.4, 0.8, 'oval'])
})

test('a missing width is an error, not NaN', () => {
  assert.throws(() => load('(kicad_pcb (segment (start 0 0) (end 1 1) (layer "F.Cu")))'), /not a number/)
})
