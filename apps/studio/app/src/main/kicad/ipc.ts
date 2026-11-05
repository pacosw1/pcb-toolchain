// Read-only subset of KiCad's NNG/protobuf protocol. Wire schema matches the
// generated Rust definitions in tools/router/core/src/kicad/api/proto.
import net from 'node:net'
import { randomUUID } from 'node:crypto'
const MAX_FRAME = 32 * 1024 * 1024
const PREFIX = 'type.googleapis.com/kiapi.common.commands.'
const varint = (value: number): Buffer => {
  const bytes: number[] = []
  do { bytes.push((value & 127) | (value > 127 ? 128 : 0)); value = Math.floor(value / 128) } while (value)
  return Buffer.from(bytes)
}
export const field = (tag: number, bytes: Buffer): Buffer => Buffer.concat([varint(tag * 8 + 2), varint(bytes.length), bytes])
type WireField = [number, Buffer | bigint]
export function decode(bytes: Buffer): WireField[] {
  let offset = 0
  const result: WireField[] = []
  const number = (): bigint => {
    let value = 0n
    for (let i = 0; i < 10; i++) {
      if (offset >= bytes.length) throw new Error('Truncated protobuf value')
      const byte = bytes[offset++]
      if (i === 9 && byte > 1) throw new Error('Protobuf integer overflow')
      value |= BigInt(byte & 127) << BigInt(i * 7)
      if (!(byte & 128)) return value
    }
    throw new Error('Invalid protobuf integer')
  }
  while (offset < bytes.length) {
    const key = number()
    if (key > 0xffffffffn || key < 8n) throw new Error('Invalid protobuf field')
    const tag = Number(key >> 3n), wire = Number(key & 7n)
    if (wire === 0) { result.push([tag, number()]); continue }
    const length = wire === 2 ? Number(number()) : wire === 1 ? 8 : wire === 5 ? 4 : -1
    if (!Number.isSafeInteger(length) || length < 0 || length > bytes.length - offset) throw new Error('Invalid protobuf length')
    result.push([tag, bytes.subarray(offset, offset + length)]); offset += length
  }
  return result
}
export const bufferField = (bytes: Buffer, tag: number): Buffer => {
  const value = decode(bytes).find(([key]) => key === tag)?.[1]
  if (value === undefined) return Buffer.alloc(0)
  if (!Buffer.isBuffer(value)) throw new Error('Unexpected protobuf field type')
  return value
}
export const integerField = (bytes: Buffer, tag: number): number => {
  const value = decode(bytes).find(([key]) => key === tag)?.[1] ?? 0n
  if (typeof value !== 'bigint' || value > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error('Unexpected protobuf integer')
  return Number(value)
}
export class ApiStatusError extends Error {
  readonly status: number
  constructor(status: number, message: string) { super(message || `KiCad API status ${status}`); this.status = status }
}

export class ReadOnlyIpc {
  private readonly socket: net.Socket
  private pending: Buffer = Buffer.alloc(0)
  private wake: (() => void) | null = null
  private failure: Error | null = null
  private token: Buffer = Buffer.alloc(0)
  private id = 0
  private busy = false
  private readonly client = Buffer.from(`pcb-studio-${randomUUID()}`)
  private constructor(socket: net.Socket) {
    this.socket = socket
    socket.on('data', chunk => {
      if (this.pending.length + chunk.length > MAX_FRAME + 9) { this.close(new Error('IPC buffer limit exceeded')); return }
      this.pending = Buffer.concat([this.pending, chunk]); this.wake?.()
    })
    socket.on('error', error => { this.failure = error; this.wake?.() })
    socket.on('close', () => { this.failure ??= new Error('KiCad IPC disconnected'); this.wake?.() })
  }
  private async read(length: number): Promise<Buffer> {
    while (this.pending.length < length) {
      if (this.failure) throw this.failure
      await new Promise<void>(resolve => { this.wake = resolve })
    }
    const result = this.pending.subarray(0, length)
    this.pending = this.pending.subarray(length)
    return result
  }
  static async connect(socketPath: string): Promise<ReadOnlyIpc> {
    const client = new ReadOnlyIpc(net.createConnection(socketPath))
    const timer = setTimeout(() => client.close(new Error('KiCad IPC connection timed out')), 2000)
    try {
      client.socket.write(Buffer.from([0, 83, 80, 0, 0, 48, 0, 0]))
      if (!(await client.read(8)).equals(Buffer.from([0, 83, 80, 0, 0, 49, 0, 0]))) throw new Error('Unexpected IPC greeting')
      return client
    } catch (error) { client.close(); throw error } finally { clearTimeout(timer) }
  }
  close(error = new Error('IPC session closed')): void { this.failure ??= error; this.socket.destroy(); this.wake?.() }
  async request(name: 'GetVersion' | 'GetOpenDocuments' | 'GetItems', payload: Buffer = Buffer.alloc(0)): Promise<Buffer> {
    if (!['GetVersion', 'GetOpenDocuments', 'GetItems'].includes(name)) throw new Error('IPC operation is not read-only')
    if (this.busy) throw new Error('Concurrent IPC requests are not supported')
    this.busy = true
    const timer = setTimeout(() => this.close(new Error('KiCad IPC request timed out')), 10_000)
    try {
      if (this.failure) throw this.failure
      const header = Buffer.concat([field(1, this.token), field(2, this.client)])
      const message = Buffer.concat([field(1, Buffer.from(PREFIX + name)), field(2, payload)])
      const envelope = Buffer.concat([field(1, header), field(2, message)])
      const frame = Buffer.alloc(13), id = 0x80000000 + (++this.id)
      frame[0] = 1; frame.writeBigUInt64BE(BigInt(envelope.length + 4), 1); frame.writeUInt32BE(id, 9)
      this.socket.write(Buffer.concat([frame, envelope]))
      const replyHeader = await this.read(9), length = Number(replyHeader.readBigUInt64BE(1))
      if (replyHeader[0] !== 1 || length < 4 || length > MAX_FRAME) throw new Error('Invalid IPC reply frame')
      const reply = await this.read(length)
      if (reply.readUInt32BE() !== id) throw new Error('IPC response ID mismatch')
      const response = reply.subarray(4), token = bufferField(bufferField(response, 1), 1)
      if (this.token.length && !token.equals(this.token)) throw new Error('KiCad IPC session changed')
      const status = bufferField(response, 2), code = integerField(status, 1)
      if (code !== 1) throw new ApiStatusError(code, bufferField(status, 2).toString())
      if (!token.length) throw new Error('KiCad omitted its session token')
      this.token = token
      const any = bufferField(response, 3)
      if (bufferField(any, 1).toString() !== PREFIX + name + 'Response') throw new Error('Unexpected IPC response type')
      return bufferField(any, 2)
    } catch (error) { if (!(error instanceof ApiStatusError)) this.close(); throw error }
    finally { clearTimeout(timer); this.busy = false }
  }
}
