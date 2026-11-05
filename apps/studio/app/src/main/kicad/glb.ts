// KiCad's STEP tessellation can export one glTF primitive per CAD face. Batch
// compatible faces within each mesh, preserving nodes, materials and every triangle.
// Unsupported/animated formats pass through unchanged rather than lose semantics.
interface Accessor { bufferView: number; byteOffset?: number; componentType: number; count: number; type: string; normalized?: boolean; min?: number[]; max?: number[]; sparse?: unknown }
interface View { buffer: number; byteOffset?: number; byteLength: number; byteStride?: number; target?: number }
interface Primitive { attributes: Record<string, number>; indices?: number; material?: number; mode?: number; targets?: unknown; extensions?: unknown; extras?: unknown }
interface Document {
  buffers: { byteLength: number; uri?: string }[]; bufferViews: View[]; accessors: Accessor[];
  meshes: { primitives: Primitive[]; weights?: unknown }[];
  materials?: { alphaMode?: string }[]; images?: { bufferView?: number }[];
  animations?: unknown[]; skins?: unknown[]; extensionsUsed?: string[];
}
const COMPONENT_BYTES: Record<number, number> = { 5120: 1, 5121: 1, 5122: 2, 5123: 2, 5125: 4, 5126: 4 }
const COMPONENTS: Record<string, number> = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4 }
const align = (n: number): number => Math.ceil(n / 4) * 4

export interface GlbOptimization { bytes: Buffer; before: number; after: number; optimized: boolean }
export function batchGlb(bytes: Buffer): GlbOptimization {
  const unchanged = (count = 0): GlbOptimization => ({ bytes, before: count, after: count, optimized: false })
  try {
    if (bytes.length < 28 || bytes.readUInt32LE(0) !== 0x46546c67 || bytes.readUInt32LE(4) !== 2 || bytes.readUInt32LE(8) !== bytes.length) return unchanged()
    const jsonLength = bytes.readUInt32LE(12), binHeader = 20 + jsonLength
    if (bytes.readUInt32LE(16) !== 0x4e4f534a || binHeader + 8 > bytes.length || bytes.readUInt32LE(binHeader + 4) !== 0x004e4942) return unchanged()
    const doc = JSON.parse(bytes.subarray(20, binHeader).toString()) as Document
    const bin = bytes.subarray(binHeader + 8, binHeader + 8 + bytes.readUInt32LE(binHeader))
    const before = doc.meshes.reduce((sum, mesh) => sum + mesh.primitives.length, 0)
    if (doc.buffers.length !== 1 || doc.buffers[0].uri || doc.buffers[0].byteLength > bin.length ||
        doc.animations?.length || doc.skins?.length || doc.extensionsUsed?.length || doc.meshes.some(m => m.weights)) return unchanged(before)
    const views: View[] = [], accessors: Accessor[] = [], chunks: Buffer[] = []
    let offset = 0
    function append(data: Buffer, target?: number): number {
      const index = views.length
      views.push({ buffer: 0, byteOffset: offset, byteLength: data.length, ...(target ? { target } : {}) })
      chunks.push(data)
      const padding = align(data.length) - data.length
      if (padding) chunks.push(Buffer.alloc(padding))
      offset += data.length + padding
      return index
    }
    function packed(index: number): { source: Accessor; data: Buffer; stride: number } {
      const source = doc.accessors[index], view = doc.bufferViews[source.bufferView]
      const width = COMPONENT_BYTES[source.componentType] * COMPONENTS[source.type]
      if (!width || source.sparse || view.buffer !== 0 || !Number.isSafeInteger(source.count) || source.count < 0) throw new Error('Unsupported accessor')
      const start = (view.byteOffset ?? 0) + (source.byteOffset ?? 0), stride = view.byteStride ?? width
      const end = start + (source.count ? (source.count - 1) * stride + width : 0)
      if (stride < width || start < 0 || end > bin.length || end > (view.byteOffset ?? 0) + view.byteLength) throw new Error('Invalid accessor bounds')
      if (stride === width) return { source, data: bin.subarray(start, start + source.count * width), stride: width }
      const data = Buffer.alloc(source.count * width)
      for (let n = 0; n < source.count; n++) bin.copy(data, n * width, start + n * stride, start + n * stride + width)
      return { source, data, stride: width }
    }
    function addAccessor(source: Accessor, data: Buffer, target: number): number {
      const index = accessors.length
      accessors.push({ ...source, byteOffset: 0, bufferView: append(data, target) })
      return index
    }
    const copied = new Map<number, number>()
    function copy(index: number, target: number): number {
      if (copied.has(index)) return copied.get(index)!
      const value = packed(index), next = addAccessor(value.source, value.data, target)
      copied.set(index, next); return next
    }
    let after = 0
    for (const mesh of doc.meshes) {
      const groups = new Map<string, Primitive[]>()
      mesh.primitives.forEach((primitive, index) => {
        const keys = Object.keys(primitive.attributes).sort()
        const supported = !primitive.targets && !primitive.extensions && !primitive.extras && (primitive.mode ?? 4) === 4 &&
          doc.materials?.[primitive.material ?? -1]?.alphaMode !== 'BLEND' && keys.includes('POSITION')
        const signature = supported ? JSON.stringify([primitive.material, keys.map(key => {
          const a = doc.accessors[primitive.attributes[key]]
          return [key, a.componentType, a.type, a.normalized ?? false]
        })]) : `single-${index}`
        const group = groups.get(signature) ?? []; group.push(primitive); groups.set(signature, group)
      })
      const primitives: Primitive[] = []
      for (const group of groups.values()) {
        if (group.length === 1) {
          const p = group[0]
          if (p.targets || p.extensions) throw new Error('Unsupported primitive extension')
          primitives.push({ ...p, attributes: Object.fromEntries(Object.entries(p.attributes).map(([key, value]) => [key, copy(value, 34962)])),
            ...(p.indices === undefined ? {} : { indices: copy(p.indices, 34963) }) })
          continue
        }
        const attributes: Record<string, number> = {}
        const count = group.reduce((n, p) => n + doc.accessors[p.attributes.POSITION].count, 0)
        for (const key of Object.keys(group[0].attributes)) {
          const values = group.map(p => packed(p.attributes[key]))
          if (values.some((v, i) => v.source.count !== doc.accessors[group[i].attributes.POSITION].count)) throw new Error('Attribute count mismatch')
          const source: Accessor = { ...values[0].source, count }
          if (values.every(v => v.source.min && v.source.max)) {
            source.min = source.min!.map((_, i) => values.reduce((n, v) => Math.min(n, v.source.min![i]), Infinity))
            source.max = source.max!.map((_, i) => values.reduce((n, v) => Math.max(n, v.source.max![i]), -Infinity))
          } else { delete source.min; delete source.max }
          attributes[key] = addAccessor(source, Buffer.concat(values.map(v => v.data)), 34962)
        }
        const indexCount = group.reduce((n, p) => n + doc.accessors[p.indices ?? p.attributes.POSITION].count, 0)
        const indices = Buffer.alloc(indexCount * 4)
        let cursor = 0, vertexOffset = 0
        for (const p of group) {
          const vertices = doc.accessors[p.attributes.POSITION].count
          if (p.indices === undefined) {
            for (let i = 0; i < vertices; i++) indices.writeUInt32LE(vertexOffset + i, cursor++ * 4)
          } else {
            const { source, data, stride } = packed(p.indices)
            if (source.type !== 'SCALAR' || ![5121, 5123, 5125].includes(source.componentType)) throw new Error('Unsupported indices')
            for (let i = 0; i < source.count; i++) {
              const index = data.readUIntLE(i * stride, stride)
              if (index >= vertices) throw new Error('Index out of range')
              indices.writeUInt32LE(vertexOffset + index, cursor++ * 4)
            }
          }
          vertexOffset += vertices
        }
        primitives.push({ ...group[0], attributes, indices: addAccessor({ bufferView: 0, componentType: 5125, count: indexCount, type: 'SCALAR' }, indices, 34963) })
      }
      after += primitives.length
      mesh.primitives = primitives
    }
    if (after >= before) return unchanged(before)
    for (const image of doc.images ?? []) {
      if (image.bufferView === undefined) continue
      const view = doc.bufferViews[image.bufferView], start = view.byteOffset ?? 0
      if (view.buffer !== 0 || start + view.byteLength > bin.length) throw new Error('Invalid image buffer')
      image.bufferView = append(bin.subarray(start, start + view.byteLength))
    }
    doc.bufferViews = views; doc.accessors = accessors; doc.buffers = [{ byteLength: offset }]
    const json = Buffer.from(JSON.stringify(doc)), paddedJson = Buffer.alloc(align(json.length), 0x20); json.copy(paddedJson)
    const header = Buffer.alloc(20), binaryHeader = Buffer.alloc(8)
    header.writeUInt32LE(0x46546c67, 0); header.writeUInt32LE(2, 4); header.writeUInt32LE(28 + paddedJson.length + offset, 8)
    header.writeUInt32LE(paddedJson.length, 12); header.writeUInt32LE(0x4e4f534a, 16)
    binaryHeader.writeUInt32LE(offset, 0); binaryHeader.writeUInt32LE(0x004e4942, 4)
    return { bytes: Buffer.concat([header, paddedJson, binaryHeader, ...chunks]), before, after, optimized: true }
  } catch { return unchanged() }
}
