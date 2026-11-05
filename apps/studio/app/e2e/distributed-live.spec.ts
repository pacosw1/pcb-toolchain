import { test, expect, _electron as electron } from '@playwright/test'
import { createHash } from 'node:crypto'
import { createServer, type ServerResponse } from 'node:http'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { hostname } from 'node:os'
import { join } from 'node:path'
import type { AddressInfo } from 'node:net'

const APP = join(__dirname, '..')
const digest = (b: Buffer): string => createHash('sha256').update(b).digest('hex')
function modelFixture(): Buffer {
  const positions = Buffer.alloc(36)
  ;[0, 0, 0, 0.02, 0, 0, 0, 0, 0.02].forEach((n, i) => positions.writeFloatLE(n, i * 4))
  const json = Buffer.from(JSON.stringify({ asset: { version: '2.0' }, scene: 0, scenes: [{ nodes: [0] }], nodes: [{ mesh: 0 }],
    meshes: [{ primitives: [{ attributes: { POSITION: 0 } }] }], buffers: [{ byteLength: positions.length }],
    bufferViews: [{ buffer: 0, byteOffset: 0, byteLength: positions.length }],
    accessors: [{ bufferView: 0, componentType: 5126, count: 3, type: 'VEC3', min: [0, 0, 0], max: [0.02, 0, 0.02] }] }))
  const padded = Buffer.alloc(Math.ceil(json.length / 4) * 4, 0x20); json.copy(padded)
  const header = Buffer.alloc(12), chunk = Buffer.alloc(8), bin = Buffer.alloc(8)
  header.write('glTF'); header.writeUInt32LE(2, 4); header.writeUInt32LE(12 + 8 + padded.length + 8 + positions.length, 8)
  chunk.writeUInt32LE(padded.length); chunk.write('JSON', 4); bin.writeUInt32LE(positions.length); bin.write('BIN\0', 4)
  return Buffer.concat([header, chunk, padded, bin, positions])
}
const board = Buffer.from(`(kicad_pcb (version 20260206) (generator "test")
 (layers (0 "F.Cu" signal) (2 "B.Cu" signal))
 (gr_rect (start 0 0) (end 30 30) (layer "Edge.Cuts") (stroke (width 0.1) (type solid)))
 (footprint "Test:Pad" (layer "F.Cu") (at 10 10) (property "Reference" "U1")
  (pad "1" smd rect (at 0 0) (size 2 2) (layers "F.Cu"))))`)

test('a saved board follows its real run preview and readable activity', async () => {
  const root = mkdtempSync(join(tmpdir(), 'pcbstudio-dist-'))
  const token = 'test-token-0123456789abcdef0123456789'
  const boardSha = digest(board)
  const preview = Buffer.from(JSON.stringify({ schema: 'iot-lab.route-preview.v1', board_sha256: boardSha, passes: 2,
    tracks: [{ net: 'SIG', layer: 'F.Cu', a: [1, 1], b: [5, 5], w: 0.2 }], vias: [] }))
  const previewSha = digest(preview)
  const candidate = Buffer.from(board.toString().replace('(at 10 10)', '(at 15 10)'))
  const candidateSha = digest(candidate)
  const model = modelFixture(), modelSha = digest(model), modelId = '11111111-1111-1111-1111-111111111111'
  const blobs = new Map([[boardSha, board], [previewSha, preview], [candidateSha, candidate], [modelSha, model]])
  const now = Date.now()
  const common = { source: 'mini', host: 'franciscos-mac-mini', board: 'project/DEMO', receivedAt: now }
  const events = [
    { ...common, cursor: 1, eventId: 'saved', run: 'saved', kind: 'board.snapshot', data: { sha256: boardSha, path: 'board.kicad_pcb' } },
    { ...common, cursor: 2, eventId: 'base', run: 'run-1', kind: 'board.snapshot', data: { sha256: boardSha, path: 'live-route-base.kicad_pcb' } },
    { ...common, cursor: 3, eventId: 'state', run: 'run-1', kind: 'run.state', data: { status: 'running', operation: 'placement', active_stages: ['routing'], supervisorAlive: true, coordinated: false } },
    { ...common, board: 'project/_host', cursor: 4, eventId: 'hb', run: '_host', kind: 'host.heartbeat', data: {} },
    { ...common, source: 'local', host: hostname(), cursor: 5, eventId: 'local-board', run: 'saved', kind: 'board.snapshot', data: { sha256: boardSha, path: 'board.kicad_pcb' } },
    { ...common, source: 'local', host: hostname(), board: 'project/_host', cursor: 6, eventId: 'local-hb', run: '_host', kind: 'host.heartbeat', data: {} }
  ]
  const streams = new Set<ServerResponse>()
  const server = createServer((req, res) => {
    if (req.headers.authorization !== `Bearer ${token}`) { res.writeHead(401); res.end(); return }
    const url = new URL(req.url ?? '/', 'http://local')
    if (url.pathname === '/live/state') { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ epoch: 'test', cursor: 6, events, truncated: false })); return }
    if (url.pathname === '/live/models' && req.method === 'POST') { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ id: modelId, status: 'ready', modelSha, error: null })); return }
    if (url.pathname === '/live/history') {
      res.setHeader('content-type', 'application/json')
      res.end(JSON.stringify({ events: [
        { ...common, cursor: 7, run: 'run-1', kind: 'route.preview', data: { sha256: previewSha, baseSha256: boardSha, path: 'live-route.json' } },
        { ...common, cursor: 9, run: 'run-1', kind: 'candidate.snapshot', data: { sha256: candidateSha, path: 'candidate.kicad_pcb' } }
      ], more: false }))
      return
    }
    if (url.pathname === '/live/events') { res.writeHead(200, { 'content-type': 'text/event-stream' }); res.write(': connected\n\n'); streams.add(res); res.on('close', () => streams.delete(res)); return }
    const content = blobs.get(url.pathname.replace('/blobs/', ''))
    if (content) { res.writeHead(200, { 'content-type': 'application/octet-stream' }); res.end(content); return }
    res.writeHead(404); res.end()
  })
  await new Promise<void>(ok => server.listen(0, '127.0.0.1', ok))
  const port = (server.address() as AddressInfo).port
  const tokenPath = join(root, 'token'); writeFileSync(tokenPath, token)
  const config = join(root, 'config.json'); writeFileSync(config, JSON.stringify({ url: `http://127.0.0.1:${port}`, tokenFile: tokenPath }))
  mkdirSync(join(root, 'empty'), { recursive: true })
  const app = await electron.launch({ args: [APP], env: { ...process.env, PCB_LIVE_CONFIG: config } })
  try {
    const win = await app.firstWindow()
    await expect(win.getByRole('status', { name: 'Engine status' })).toContainText('engine ready', { timeout: 30_000 })
    await win.getByRole('button', { name: 'Live boards' }).click()
    await expect(win.getByText('Coordinator: connected')).toBeVisible({ timeout: 15_000 })
    const sidebar = win.getByRole('region', { name: 'Machines and boards' })
    await expect(sidebar.getByText('This computer')).toBeVisible()
    const mini = sidebar.locator('details').filter({ hasText: 'Mac mini' })
    await expect(mini.getByText('working', { exact: true })).toBeVisible()
    await mini.getByRole('button', { name: /DEMO/ }).click()
    const selector = win.getByLabel('Board and machine')
    await expect(selector.locator('option', { hasText: 'saved' })).toHaveCount(1)
    await expect(selector).toHaveValue(/saved/)
    await expect(win.getByRole('heading', { name: 'Current activity' })).toBeVisible()
    await expect(win.getByText('Working on: routing')).toBeVisible()
    await expect(win.getByText('This run is not protected by the shared board lock.')).toBeVisible()
    await expect.poll(() => streams.size).toBeGreaterThan(0)
    const frame = { ...common, cursor: 7, eventId: 'frame', run: 'run-1', kind: 'route.preview',
      data: { sha256: previewSha, baseSha256: boardSha, path: 'live-route.json', passes: 2, maxPasses: 5, conflictPairs: 3 } }
    for (const stream of streams) stream.write(`id: 7\ndata: ${JSON.stringify(frame)}\n\n`)
    await expect(win.getByText(/Following active run.*route preview, pass 2/)).toBeVisible({ timeout: 15_000 })
    await expect(win.locator('.boardview-bar').filter({ hasText: 'Layers' })).toContainText('1 tracks')
    const log = { ...common, cursor: 8, eventId: 'log', run: 'run-1', kind: 'run.event', data: { type: 'tool.output', stage: 'routing',
      text: 'iter  2: routed 1, conflicts 3, audit pairs 3 samples 7 hard 0, pour faults 0 (walls 0, fixed 0), involved 1, hard fails 0, pres 0.50, 1.2 s hard: involved: SIG' } }
    for (const stream of streams) stream.write(`id: 8\ndata: ${JSON.stringify(log)}\n\n`)
    await expect(win.getByText('Routing pass 2')).toBeVisible()
    await expect(win.getByText(/3 clearance conflicts/)).toBeVisible()
    const placed = { ...common, cursor: 9, eventId: 'candidate', run: 'run-1', kind: 'candidate.snapshot',
      data: { sha256: candidateSha, path: 'operation/work/step-1/demo.kicad_pcb' } }
    for (const stream of streams) stream.write(`id: 9\ndata: ${JSON.stringify(placed)}\n\n`)
    await expect(win.getByText(/Following active run.*Unverified working candidate/)).toBeVisible()
    await expect(win.getByRole('img', { name: `Board live:${candidateSha}` })).toBeVisible({ timeout: 15_000 })
    await win.getByRole('button', { name: 'Load recorded frames' }).click()
    await expect(win.getByText('1 / 2', { exact: true })).toBeVisible()
    await expect(win.getByText(/Replay.*route preview/)).toBeVisible()
    await win.getByLabel('Frame').fill('1')
    await expect(win.getByText('2 / 2', { exact: true })).toBeVisible()
    await expect(win.getByText(/Replay.*working candidate/)).toBeVisible()
    await win.getByRole('button', { name: '3D snapshot' }).click()
    await expect(win.getByRole('img', { name: '3D board view' })).toBeVisible()
    await expect(win.getByLabel('3D model info')).toContainText('1 meshes', { timeout: 15_000 })
    await win.getByRole('button', { name: '2D live view' }).click()
  } finally {
    await app.close()
    for (const stream of streams) stream.destroy()
    await new Promise<void>(ok => server.close(() => ok()))
    rmSync(root, { recursive: true, force: true })
  }
})
