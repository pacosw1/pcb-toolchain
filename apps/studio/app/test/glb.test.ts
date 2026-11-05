import assert from 'node:assert/strict'
import test from 'node:test'
import { batchGlb } from '../src/main/kicad/glb.ts'

function fixture(transparent = false): Buffer {
  const positions = Buffer.alloc(72), indices = Buffer.from([0, 1, 2, 0, 1, 2])
  ;[0, 0, 0, 1, 0, 0, 0, 1, 0, 2, 0, 0, 3, 0, 0, 2, 1, 0].forEach((value, index) => positions.writeFloatLE(value, index * 4))
  const bin = Buffer.concat([positions, indices, Buffer.alloc(2)])
  const doc = { asset: { version: '2.0' }, scene: 0, scenes: [{ nodes: [0] }], nodes: [{ mesh: 0, translation: [3, 4, 5] }],
    buffers: [{ byteLength: bin.length }], bufferViews: [{ buffer: 0, byteOffset: 0, byteLength: 72 }, { buffer: 0, byteOffset: 72, byteLength: 6 }],
    accessors: [{ bufferView: 0, byteOffset: 0, componentType: 5126, count: 3, type: 'VEC3', min: [0, 0, 0], max: [1, 1, 0] },
      { bufferView: 0, byteOffset: 36, componentType: 5126, count: 3, type: 'VEC3', min: [2, 0, 0], max: [3, 1, 0] },
      { bufferView: 1, byteOffset: 0, componentType: 5121, count: 3, type: 'SCALAR' }, { bufferView: 1, byteOffset: 3, componentType: 5121, count: 3, type: 'SCALAR' }],
    meshes: [{ primitives: [{ attributes: { POSITION: 0 }, indices: 2, material: 0 }, { attributes: { POSITION: 1 }, indices: 3, material: 0 }] }],
    materials: [{ alphaMode: transparent ? 'BLEND' : 'OPAQUE', pbrMetallicRoughness: { baseColorFactor: [0, 1, 0, 1] } }] }
  const json = Buffer.from(JSON.stringify(doc)), padded = Buffer.alloc(Math.ceil(json.length / 4) * 4, 0x20); json.copy(padded)
  const head = Buffer.alloc(20), tail = Buffer.alloc(8)
  head.writeUInt32LE(0x46546c67); head.writeUInt32LE(2, 4); head.writeUInt32LE(28 + padded.length + bin.length, 8); head.writeUInt32LE(padded.length, 12); head.writeUInt32LE(0x4e4f534a, 16)
  tail.writeUInt32LE(bin.length); tail.writeUInt32LE(0x004e4942, 4)
  return Buffer.concat([head, padded, tail, bin])
}

test('batching retains vertex bytes, rebases indices, bounds, material and node transforms', () => {
  const original = fixture(), result = batchGlb(original)
  assert.equal(result.before, 2); assert.equal(result.after, 1); assert.equal(result.optimized, true)
  const length = result.bytes.readUInt32LE(12), doc = JSON.parse(result.bytes.subarray(20, 20 + length).toString())
  const bin = result.bytes.subarray(28 + length), primitive = doc.meshes[0].primitives[0]
  assert.deepEqual(doc.nodes[0].translation, [3, 4, 5])
  assert.deepEqual(doc.materials[0].pbrMetallicRoughness.baseColorFactor, [0, 1, 0, 1])
  const position = doc.accessors[primitive.attributes.POSITION], view = doc.bufferViews[position.bufferView]
  assert.deepEqual(position.min, [0, 0, 0]); assert.deepEqual(position.max, [3, 1, 0]); assert.equal(position.count, 6)
  const originalBin = original.subarray(28 + original.readUInt32LE(12))
  assert.deepEqual(bin.subarray(view.byteOffset, view.byteOffset + view.byteLength), originalBin.subarray(0, 72))
  const indexView = doc.bufferViews[doc.accessors[primitive.indices].bufferView]
  assert.deepEqual(Array.from({ length: 6 }, (_, i) => bin.readUInt32LE(indexView.byteOffset + i * 4)), [0, 1, 2, 3, 4, 5])
})

test('transparent face ordering is preserved and malformed GLB passes through', () => {
  const original = fixture(true)
  assert.deepEqual(batchGlb(original).bytes, original)
  assert.equal(batchGlb(original).optimized, false)
  assert.deepEqual(batchGlb(Buffer.from('bad')).bytes, Buffer.from('bad'))
})
