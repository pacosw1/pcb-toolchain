import assert from 'node:assert/strict'
import { test } from 'node:test'
import { interpolatePlacement, placementGeometry } from '../src/renderer/src/livePlacement.ts'
import type { Placement } from '../src/renderer/src/livePlacement.ts'
import type { Geometry } from '../src/shared/generated.ts'

test('placement animation moves footprints and pads without claiming original copper is routed', () => {
  const base = { pcb: 'board', layers: ['F.Cu'], outline: [], outline_open: 0, zones: [], bbox: [0, 0, 10, 10],
    tracks: [{ x1: 1, y1: 1, x2: 2, y2: 2, w: 0.2, layer: 'F.Cu', net: 'A' }], vias: [], graphics: [],
    footprints: [{ ref: 'U1', lib: 'x', x: 2, y: 1, rot: 0, layer: 'F.Cu', locked: false, props: {}, attrs: [],
      pads: [{ num: '1', type: 'smd', shape: 'rect', x: 2, y: 1, rot: 0, w: 1, h: 1, layers: ['F.Cu'], net: 'A', drill: null, drill_h: null, drill_shape: null, rratio: 0 }] }] } as Geometry
  const frame: Placement = { board_sha256: 'a'.repeat(64), epoch: 2, epochs: 5, cost: 3,
    units: [{ refs: ['U1'], origin: [1, 1], position: [4, 4], turn: 1 }] }
  const out = placementGeometry(base, interpolatePlacement(null, frame, 1))
  assert.ok(Math.abs(out.footprints[0].x - 4) < 1e-9)
  assert.ok(Math.abs(out.footprints[0].y - 3) < 1e-9)
  assert.equal(out.footprints[0].pads[0].rot, 90)
  assert.equal(out.tracks.length, 0)
  assert.equal(base.tracks.length, 1)
  const half = interpolatePlacement(null, frame, 0.5)
  assert.deepEqual(half.units[0].position, [2.5, 2.5])
  assert.equal(half.units[0].turn, 0.5)
})
