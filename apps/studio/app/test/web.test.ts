// Port of engine/tests/test_web.py and the migrate cases of test_project.py. Run: node --test test/
import assert from 'node:assert/strict'
import fs from 'node:fs'
import http from 'node:http'
import type { Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import type { TestContext } from 'node:test'
import yaml from 'js-yaml'
import WebSocket from 'ws'
import { migrate } from '../src/main/migrate.ts'
import { Project } from '../src/main/project.ts'
import { READ_ONLY, allowedFile, loadToken, makeServer } from '../src/main/web.ts'

function tmp(t: TestContext): string {
  const d = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'web-')))
  t.after(() => fs.rmSync(d, { recursive: true, force: true }))
  return d
}

function write(p: string, text: string): void {
  fs.mkdirSync(path.dirname(p), { recursive: true })
  fs.writeFileSync(p, text)
}

interface Viewer { base: string, root: string, top: string, tok: string, server: Server }

async function viewer(t: TestContext): Promise<Viewer> {
  const top = tmp(t), root = path.join(top, 'proj')
  fs.mkdirSync(path.join(root, 'hardware-design/boards/DEMO'), { recursive: true })
  write(path.join(root, '.git/config'), '[core]\n')
  write(path.join(root, '.git/x.pdf'), '%PDF-1.4 hidden')
  write(path.join(root, 'ds.pdf'), '%PDF-1.4 datasheet')
  write(path.join(root, 'notes.txt'), 'secret')
  write(path.join(top, 'static/index.html'), '<!doctype html><title>viewer</title>')
  write(path.join(top, 'static/app.js'), 'x')
  const file = path.join(top, 'cfg/web-token'), tok = loadToken(file)
  assert.equal(fs.statSync(file).mode & 0o777, 0o600)
  assert.equal(loadToken(file), tok)                // stable across restarts
  const server = makeServer(path.join(top, 'static'), root, path.join(top, 'glb'), tok)
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  t.after(() => { server.closeAllConnections(); server.close() })
  return { base: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, root, top, tok, server }
}

const get = (url: string, cookie?: string, headers: Record<string, string> = {}): Promise<Response> =>
  fetch(url, { redirect: 'manual', headers: { ...(cookie ? { Cookie: cookie } : {}), ...headers } })
const files = (v: Viewer, p: string): string => `${v.base}/files?path=${encodeURIComponent(p)}`

test('viewer token, cookie and files', async t => {
  const v = await viewer(t)
  assert.equal((await get(`${v.base}/`)).status, 401)
  assert.equal((await get(files(v, path.join(v.root, 'ds.pdf')))).status, 401)
  assert.equal((await get(`${v.base}/?t=wrong`)).status, 401)
  const r = await get(`${v.base}/?t=${v.tok}&x=1`)
  assert.equal(r.status, 302)
  assert.equal(r.headers.get('location'), '/?x=1')
  const set = r.headers.get('set-cookie')!
  assert.match(set, /HttpOnly/)
  assert.match(set, /SameSite=Strict/)
  assert.doesNotMatch(set, /Secure/)
  assert.match((await get(`${v.base}/?t=${v.tok}`, undefined, { 'X-Forwarded-Proto': 'https' })).headers.get('set-cookie')!, /Secure/)
  const cookie = set.split(';')[0]
  assert.equal((await get(`${v.base}/`, cookie)).status, 200)
  assert.equal((await get(`${v.base}/app.js`, cookie)).status, 200)
  const ok = await get(files(v, path.join(v.root, 'ds.pdf')), cookie)
  assert.equal(ok.status, 200)
  assert.equal(ok.headers.get('content-type'), 'application/pdf')
  assert.equal(ok.headers.get('x-content-type-options'), 'nosniff')
  for (const bad of [path.join(v.root, '.git/config'), path.join(v.root, '.git/x.pdf'), path.join(v.root, 'notes.txt'), path.join(v.top, 'static/index.html'),
                     v.root + '/hardware-design/../.git/config', '/etc/passwd', '']) {
    assert.equal((await get(files(v, bad), cookie)).status, 403, bad)
  }
})

test('a Range request returns that part of a file', async t => {
  const v = await viewer(t)
  const cookie = `pcbstudio_view=${v.tok}`, url = files(v, path.join(v.root, 'ds.pdf'))
  const r = await get(url, cookie, { Range: 'bytes=0-3' })
  assert.equal(r.status, 206)
  assert.equal(await r.text(), '%PDF')
  assert.equal((await get(url, cookie, { Range: 'bytes=9999-' })).status, 416)
})

test('the static folder cannot be left, and nothing is written', async t => {
  const v = await viewer(t), cookie = `pcbstudio_view=${v.tok}`
  const raw = (p: string): Promise<number> => new Promise((resolve, reject) => {
    const { hostname, port } = new URL(v.base)
    http.get({ hostname, port, path: p, headers: { Cookie: cookie } }, res => { res.resume(); resolve(res.statusCode!) }).on('error', reject)
  })
  assert.equal(await raw('/../proj/ds.pdf'), 404)
  assert.equal(await raw('/%2e%2e/proj/ds.pdf'), 404)
  assert.equal(await raw('/..%2fproj%2fds.pdf'), 404)
  assert.equal((await fetch(`${v.base}/`, { method: 'POST', headers: { Cookie: cookie } })).status, 405)
})

/** The status of a WebSocket handshake, or 101. */
function upgrade(url: string, headers: Record<string, string>): Promise<number> {
  return new Promise(resolve => {
    const ws = new WebSocket(url, { headers })
    ws.on('open', () => { ws.close(); resolve(101) })
    ws.on('unexpected-response', (_q, res) => resolve(res.statusCode ?? 0))
    ws.on('error', () => resolve(0))
  })
}

test('the socket allows viewing methods only and refuses other sites', async t => {
  const v = await viewer(t), cookie = `pcbstudio_view=${v.tok}`, url = v.base.replace('http', 'ws') + '/rpc'
  const ws = new WebSocket(url, { headers: { Cookie: cookie } })
  await new Promise(resolve => ws.on('open', resolve))
  const next = (): Promise<{ error?: { message: string }, result?: { ok?: boolean, root?: string } }> =>
    new Promise(resolve => ws.once('message', d => resolve(JSON.parse(String(d)))))
  const ask = (body: unknown): ReturnType<typeof next> => { const r = next(); ws.send(JSON.stringify(body)); return r }
  for (const method of ['run.adopt', 'op.build', 'op.route', 'gate.check', 'run.cancel', 'nope']) {
    assert.match((await ask({ jsonrpc: '2.0', id: 1, method, params: { id: 'x' } })).error!.message, /not available/)
  }
  assert.equal((await ask({ jsonrpc: '2.0', id: 2, method: 'engine.ping' })).result!.ok, true)
  assert.equal((await ask({ jsonrpc: '2.0', id: 3, method: 'project.open', params: { root: '/etc' } })).result!.root, v.root)   // pinned
  ws.close()
  assert.equal(await upgrade(url, { Cookie: cookie, Origin: 'http://evil.example' }), 403)
  assert.equal(await upgrade(url, { Cookie: cookie, Origin: v.base }), 101)
  assert.equal(await upgrade(url, {}), 401)                     // no cookie: the socket is refused
  assert.equal(await upgrade(`${url}?t=wrong`, {}), 401)
  assert.equal(await upgrade(`${url}?t=${v.tok}`, {}), 101)
  assert.equal((await get(`${v.base}/rpc`)).status, 401)
})

test('the web viewer has no write methods', () => {
  assert.ok(READ_ONLY.has('run.candidate'))
  for (const m of ['op.build', 'op.route', 'run.adopt', 'gate.check', 'run.cancel']) assert.ok(!READ_ONLY.has(m))
})

test('a file is allowed only by type, root and no dot folder', () => {
  assert.equal(allowedFile('/p/a.PDF', ['/p']), true)
  assert.equal(allowedFile('/p/.gate/a.pdf', ['/p']), false)
  assert.equal(allowedFile('/p/a.txt', ['/p']), false)
  assert.equal(allowedFile('/q/a.pdf', ['/p']), false)
  assert.equal(allowedFile('/p2/a.pdf', ['/p']), false)
})

test('migrate writes board.yaml files that read back the same', t => {
  const root = tmp(t), out = tmp(t), b = path.join(root, 'hardware-design/boards')
  write(path.join(b, 'MAIN/cad/MAIN/MAIN.kicad_pcb'), '(kicad_pcb (version 1))')
  write(path.join(b, 'MAIN/cad/MAIN-B/MAIN-B.kicad_pcb'), '(kicad_pcb (version 1))')
  write(path.join(b, 'MAIN/BOM-B.csv'), 'Designator\n')
  write(path.join(b, 'MAIN/gate.json'), JSON.stringify({ project: 'cad/MAIN/MAIN' }))
  write(path.join(b, 'MAIN-B/gate.json'), JSON.stringify({ project: '../MAIN/cad/MAIN-B/MAIN-B', pipeline: 'tools/b.sh' }))
  write(path.join(root, 'tools/b.sh'), '#!/bin/sh\n')
  write(path.join(root, 'hardware-design/registry/boards.json'), JSON.stringify({ boards: [
    { id: 'MAIN', directory: 'MAIN', lifecycle: 'active', kind: 'board', revisions: [
      { revision: 'A', state: 'old', project: 'cad/MAIN/MAIN' }, { revision: 'B', state: 'layout', project: 'cad/MAIN-B/MAIN-B', bom: 'BOM-B.csv' }] },
    { id: 'MAIN-B', directory: 'MAIN-B', kind: 'gate-only', revision: 'B' }] }))
  const r = migrate(root, out)
  assert.ok(r.round_trip)
  assert.deepEqual([r.boards, r.revisions, r.gates], [1, 2, 2])
  const data = yaml.load(fs.readFileSync(path.join(out, 'MAIN/board.yaml'), 'utf8')) as { schema: string, revisions: unknown[] }
  assert.equal(data.schema, 'pcbstudio.board.v1')
  assert.deepEqual(data.revisions[1], { rev: 'B', state: 'layout', pcb: 'cad/MAIN-B/MAIN-B.kicad_pcb', bom: 'BOM-B.csv', gate: 'MAIN-B', gates: [{ name: 'MAIN-B' }], pipeline: 'tools/b.sh' })
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(out, 'migrate-report.json'), 'utf8')).written, ['MAIN/board.yaml'])
  write(path.join(b, 'MAIN/board.yaml'), fs.readFileSync(path.join(out, 'MAIN/board.yaml'), 'utf8'))
  fs.rmSync(path.join(root, 'hardware-design/registry/boards.json'))
  assert.ok(new Project(root).boards().some(x => x.id === 'MAIN' && x.identity === 'board.yaml'))
})
