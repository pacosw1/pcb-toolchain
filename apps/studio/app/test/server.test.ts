// JSON-RPC and socket access. Run: node --test test/
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import type { ChildProcessWithoutNullStreams } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import type { TestContext } from 'node:test'
import WebSocket from 'ws'
import { registry } from '../src/main/api.ts'

const ENTRY = path.join(import.meta.dirname, '../src/main/engineMain.ts')
const request = (body: unknown): Promise<string | null> => registry.handle(JSON.stringify(body))
const reply = async (body: unknown): Promise<{ id?: unknown, result?: never, error?: { code: number, message: string } }> => JSON.parse((await request(body))!)

test('ping and info', async () => {
  const a = await reply({ jsonrpc: '2.0', id: 1, method: 'engine.ping' })
  assert.equal(a.id, 1)
  assert.equal((a.result as unknown as { ok: boolean }).ok, true)
  const b = await reply({ jsonrpc: '2.0', id: 2, method: 'engine.info' })
  assert.ok((b.result as unknown as { methods: string[] }).methods.includes('engine.ping'))
})

for (const [raw, code] of [
  ['{not json', -32700],
  [JSON.stringify({ id: 1, method: 'engine.ping' }), -32600],
  [JSON.stringify({ jsonrpc: '2.0', id: 3, method: 'nope' }), -32601],
  [JSON.stringify({ jsonrpc: '2.0', id: 4, method: 'engine.ping', params: { x: 1 } }), -32602],
  [JSON.stringify({ jsonrpc: '2.0', id: 5, method: 'board.geometry', params: {} }), -32602],
  [JSON.stringify({ jsonrpc: '2.0', id: 6, method: 'board.geometry', params: ['a', 'b'] }), -32602],
  [JSON.stringify({ jsonrpc: '2.0', id: 7, method: 'run.get', params: ['no-such-run'] }), -32603]
] as const) {
  test(`error ${code}: ${raw}`, async () => assert.equal(JSON.parse((await registry.handle(raw))!).error.code, code))
}

test('a notification has no reply', async () => {
  assert.equal(await request({ jsonrpc: '2.0', method: 'engine.ping' }), null)
})

test('engine exposes the supported method registry', () => {
  assert.deepEqual(registry.names(), ['board.bom', 'board.geometry', 'board.glb', 'board.inspect', 'board.inventory', 'board.parts', 'board.schematic', 'board.spec', 'board.unwatch', 'board.watch', 'engine.info', 'engine.ping', 'file.resolve',
    'gate.check', 'live.events', 'live.geometry', 'live.runs', 'live.state', 'live.unwatch', 'live.watch', 'loop.cancel', 'loop.decide', 'loop.list', 'loop.start', 'loop.status', 'loop.wait', 'op.build', 'op.route', 'part.get', 'parts.index', 'project.open', 'run.adopt', 'run.cancel', 'run.candidate', 'run.findings',
    'run.get', 'run.list', 'state.unwatch', 'state.watch'])
})

interface Engine { proc: ChildProcessWithoutNullStreams, port: number, token: string | undefined }

function start(t: TestContext, env: Record<string, string> = {}): Promise<Engine> {
  const proc = spawn(process.execPath, ['--experimental-strip-types', '--no-warnings', ENTRY, 'serve'], { env: { ...process.env, ...env } })
  t.after(() => proc.kill('SIGKILL'))
  return new Promise((resolve, reject) => {
    let out = ''
    proc.stdout.on('data', (d: Buffer) => {
      out += d.toString()
      const m = /READY (\{.*\})/.exec(out)
      if (m) {
        const r = JSON.parse(m[1]) as { port: number, token?: string }
        resolve({ proc, port: r.port, token: r.token })
      }
    })
    proc.on('exit', code => reject(new Error(`engine exited ${code}`)))
  })
}

/** The HTTP status of a handshake, or 101 when it is accepted. */
function handshake(url: string, headers: Record<string, string> = {}): Promise<number> {
  return new Promise(resolve => {
    const ws = new WebSocket(url, { headers })
    ws.on('open', () => { ws.close(); resolve(101) })
    ws.on('unexpected-response', (_q, res) => resolve(res.statusCode ?? 0))
    ws.on('error', () => resolve(0))
  })
}

test('serves over a socket and exits when stdin closes', async t => {
  const e = await start(t)
  const ws = new WebSocket(`ws://127.0.0.1:${e.port}/?t=${e.token}`)
  await new Promise(resolve => ws.on('open', resolve))
  const got = new Promise<string>(resolve => ws.once('message', d => resolve(String(d))))
  ws.send(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'engine.ping' }))
  assert.equal(JSON.parse(await got).result.ok, true)
  ws.close()
  const exited = new Promise(resolve => e.proc.once('close', resolve))
  e.proc.stdin.end()
  assert.equal(await exited, 0)
})

test('the socket needs the token and refuses browser origins', async t => {
  const e = await start(t), url = `ws://127.0.0.1:${e.port}/`
  assert.equal(await handshake(url), 401)
  assert.equal(await handshake(`${url}?t=wrong`), 401)
  assert.equal(await handshake(`${url}?t=${e.token}`, { Origin: 'http://evil.example' }), 403)
  assert.equal(await handshake(`${url}?t=${e.token}`), 101)
  assert.equal(await handshake(url, { Authorization: `Bearer ${e.token}` }), 101)
})

test('a given token stays off the READY line and out of child processes', async t => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'srv-')))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  fs.mkdirSync(path.join(root, 'hardware-design/boards/DEMO'), { recursive: true })
  fs.mkdirSync(path.join(root, 'tools'))
  fs.writeFileSync(path.join(root, 'tools/pcb'), `#!/bin/sh\nenv > "$(pwd)/env.txt"\necho '{"type":"run.end","status":"passed","cause":"ok"}'\n`, { mode: 0o755 })
  const e = await start(t, { PCBSTUDIO_ENGINE_TOKEN: 'given-token-1234567890' })
  assert.equal(e.token, undefined)
  const ws = new WebSocket(`ws://127.0.0.1:${e.port}/?t=given-token-1234567890`)
  await new Promise(resolve => ws.on('open', resolve))
  const done = new Promise<void>(resolve => ws.on('message', d => {
    const m = JSON.parse(String(d))
    if (m.method === 'run.state' && m.params.state !== 'running') resolve()
  }))
  ws.send(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'project.open', params: { root } }))
  ws.send(JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'gate.check', params: { board: 'DEMO' } }))
  await done
  ws.close()
  assert.ok(!fs.readFileSync(path.join(root, 'env.txt'), 'utf8').includes('PCBSTUDIO_ENGINE_TOKEN'))
})
