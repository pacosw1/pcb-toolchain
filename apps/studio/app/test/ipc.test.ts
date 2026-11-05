import test from 'node:test'
import assert from 'node:assert/strict'
import net from 'node:net'
import fs from 'node:fs'
import { ReadOnlyIpc, ApiStatusError, field, bufferField, decode } from '../src/main/kicad/ipc.ts'

const prefix = 'type.googleapis.com/kiapi.common.commands.'
test('IPC binds successful requests to a session and rejects changed sessions', async t => {
  const dir = fs.mkdtempSync('/tmp/pcb-ipc-test-'), socketPath = dir + '/s'
  const server = net.createServer(socket => {
    let pending = Buffer.alloc(0), greeted = false, requests = 0
    socket.on('data', chunk => {
      pending = Buffer.concat([pending, chunk])
      if (!greeted && pending.length >= 8) {
        assert.deepEqual(pending.subarray(0, 8), Buffer.from([0, 83, 80, 0, 0, 48, 0, 0]))
        pending = pending.subarray(8); greeted = true
        socket.write(Buffer.from([0, 83, 80, 0, 0, 49, 0, 0]))
      }
      while (greeted && pending.length >= 9) {
        const length = Number(pending.readBigUInt64BE(1))
        if (pending.length < 9 + length) return
        const request = pending.subarray(9, 9 + length); pending = pending.subarray(9 + length)
        const env = request.subarray(4), header = bufferField(env, 1)
        const name = bufferField(bufferField(env, 2), 1).toString().slice(prefix.length)
        requests++
        assert.equal(bufferField(header, 1).toString(), requests <= 2 ? '' : 'token-a')
        const status = requests === 1 ? 4 : 1
        const token = Buffer.from(requests === 4 ? 'token-b' : 'token-a')
        const reply = Buffer.concat([field(1, field(1, token)), field(2, Buffer.from([8, status])), field(3,
          Buffer.concat([field(1, Buffer.from(prefix + name + 'Response')), field(2, Buffer.from([8, 1]))]))])
        const frame = Buffer.alloc(9); frame[0] = 1; frame.writeBigUInt64BE(BigInt(reply.length + 4), 1)
        // Fragment the response to exercise framing independent of socket chunk boundaries.
        socket.write(frame.subarray(0, 3)); socket.write(Buffer.concat([frame.subarray(3), request.subarray(0, 4), reply]))
      }
    })
  })
  await new Promise<void>(resolve => server.listen(socketPath, resolve))
  const client = await ReadOnlyIpc.connect(socketPath)
  t.after(async () => { client.close(); await new Promise<void>(resolve => server.close(() => resolve())); fs.rmSync(dir, { recursive: true, force: true }) })
  await assert.rejects(client.request('GetVersion'), error => error instanceof ApiStatusError && error.status === 4)
  await client.request('GetVersion')
  await client.request('GetOpenDocuments')
  await assert.rejects(client.request('GetItems'), /session changed/)
})

test('wire parser rejects truncation, overflow and unsupported wire types', () => {
  for (const bytes of [[10, 20, 1], [0], [15], [8, ...Array(11).fill(255)]]) assert.throws(() => decode(Buffer.from(bytes)))
  assert.throws(() => bufferField(Buffer.from([8, 1]), 1), /field type/)
})
