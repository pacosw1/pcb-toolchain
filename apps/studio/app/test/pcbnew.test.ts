// The worker client, and board.ts against KiCad's own pcbnew on every iot-lab board.
// Compared per board: pad position, orientation, size, shape, drill, custom pad
// extent; track and via counts; zone count, rule-area flag, keepout flags, polygon counts; board outline loops.
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import type { TestContext } from 'node:test'
import { load } from '../src/main/kicad/board.ts'
import { PcbnewWorker, WorkerError, findKicadPython } from '../src/main/kicad/pcbnew.ts'
import type { Pad } from '../src/shared/generated'

const CORPUS = process.env.PCBSTUDIO_CORPUS ?? path.join(os.homedir(), 'code/iot-lab')
const SCRIPT = path.join(import.meta.dirname, '../resources/pcbnew_worker.py')
const BOARDS_DIR = path.join(CORPUS, 'hardware-design/boards')
const TOL = 1e-3                    // mm and degrees

function boards(): string[] {
  if (!fs.existsSync(BOARDS_DIR)) return []
  const out: string[] = []
  for (const b of fs.readdirSync(BOARDS_DIR)) {
    const cad = path.join(BOARDS_DIR, b, 'cad')
    if (!fs.existsSync(cad)) continue
    for (const d of fs.readdirSync(cad)) {
      const dir = path.join(cad, d)
      if (d === 'backups' || !fs.statSync(dir).isDirectory()) continue
      for (const f of fs.readdirSync(dir)) if (f.endsWith('.kicad_pcb')) out.push(path.join(dir, f))
    }
  }
  return out.sort()
}

const python = await findKicadPython()
const skip = !python

function angleDiff(a: number, b: number): number {
  const d = (((a - b) % 360) + 360) % 360
  return Math.min(d, 360 - d)
}

/** Extent of a custom pad: its anchor plus every primitive, strokes included. */
function customExtent(p: Pad): number[] {
  const pts: number[][] = []
  if (p.anchor === 'circle') {
    const r = p.w / 2
    pts.push([p.x - r, p.y - r], [p.x + r, p.y + r])
  } else {
    const a = p.rot * Math.PI / 180
    for (const [sx, sy] of [[-1, -1], [1, -1], [1, 1], [-1, 1]]) {
      const x = sx * p.w / 2, y = sy * p.h / 2
      pts.push([p.x + x * Math.cos(a) + y * Math.sin(a), p.y - x * Math.sin(a) + y * Math.cos(a)])
    }
  }
  for (const prim of p.prims ?? []) {
    const r = prim.w / 2
    for (const [x, y] of prim.pts) pts.push([x - r, y - r], [x + r, y + r])
  }
  const xs = pts.map(q => q[0]), ys = pts.map(q => q[1])
  return [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)]
}

interface RefPad { ref: string, num: string, x: number, y: number, rot: number, w: number, h: number, shape: string,
                   drill: [number, number] | null, drill_shape: string | null, bbox: number[] }
interface RefZone { rule_area: boolean, keepout: unknown, outline: { holes: number }[], filled: Record<string, number> }
interface RefOutline { ok: boolean, outlines: { holes: number }[] }
interface Counts { segments: number, arcs: number, vias: number }

const group = <T>(items: T[], key: (x: T) => string): Map<string, T[]> => {
  const m = new Map<string, T[]>()
  for (const x of items) m.set(key(x), [...(m.get(key(x)) ?? []), x])
  return m
}
const bySpot = (a: { x: number, y: number }, b: { x: number, y: number }): number =>
  (Math.round(a.x * 1000) - Math.round(b.x * 1000)) || (Math.round(a.y * 1000) - Math.round(b.y * 1000))

/** Mismatches by kind ({} = agrees with pcbnew). */
async function compare(file: string, w: PcbnewWorker): Promise<Record<string, string[]>> {
  const bad: Record<string, string[]> = {}
  const miss = (kind: string, msg: string): void => { (bad[kind] ??= []).push(msg) }
  const { board } = await w.call<{ board: string }>('load', { path: file })
  const q = <T>(what: string): Promise<T> => w.call<T>('query', { board, what })
  const refPads = await q<RefPad[]>('pads'), counts = await q<Counts>('counts')
  const refZones = await q<RefZone[]>('zones'), refOutline = await q<RefOutline>('outline')
  await w.call('close', { board })
  const geo = load(file)

  const ours = group(geo.footprints.flatMap(fp => fp.pads.map(p => ({ key: `${fp.ref}.${p.num}`, p }))), x => x.key)
  const theirs = group(refPads, p => `${p.ref}.${p.num}`)
  const onlyOne = [...ours.keys()].filter(k => !theirs.has(k)).concat([...theirs.keys()].filter(k => !ours.has(k)))
  if (onlyOne.length) miss('pad_keys', onlyOne.slice(0, 5).join(' '))
  for (const [key, list] of ours) {
    if (!theirs.has(key)) continue
    const a = list.map(x => x.p).sort(bySpot), b = [...theirs.get(key)!].sort(bySpot)
    if (a.length !== b.length) { miss('pad_keys', `${key}: ${a.length} vs ${b.length}`); continue }
    a.forEach((p, i) => {
      const r = b[i]
      if (Math.abs(p.x - r.x) > TOL || Math.abs(p.y - r.y) > TOL) miss('pad_position', `${key}: ${p.x},${p.y} vs ${r.x},${r.y}`)
      if (angleDiff(p.rot, r.rot) > TOL) miss('pad_rotation', `${key}: ${p.rot} vs ${r.rot}`)
      if (Math.abs(p.w - r.w) > TOL || Math.abs(p.h - r.h) > TOL) miss('pad_size', `${key}: ${p.w}x${p.h} vs ${r.w}x${r.h}`)
      if (p.shape !== r.shape) miss('pad_shape', `${key}: ${p.shape} vs ${r.shape}`)
      if ((p.drill === null) !== (r.drill === null)) miss('pad_drill', `${key}: ${p.drill} vs ${r.drill}`)
      else if (r.drill !== null && (Math.abs(p.drill! - r.drill[0]) > TOL || Math.abs(p.drill_h! - r.drill[1]) > TOL ||
               p.drill_shape !== r.drill_shape)) miss('pad_drill', `${key}: ${p.drill_shape} ${p.drill}x${p.drill_h} vs ${r.drill_shape} ${r.drill}`)
      if (p.shape === 'custom' && Math.max(...customExtent(p).map((v, k) => Math.abs(v - r.bbox[k]))) > 0.01) {
        miss('pad_custom', `${key}: ${customExtent(p)} vs ${r.bbox}`)
      }
    })
  }

  const segments = geo.tracks.length - counts.arcs * 8          // arcs are drawn as 8 chords
  if (segments !== counts.segments) miss('tracks', `${segments} segments vs ${counts.segments}`)
  if (geo.vias.length !== counts.vias) miss('vias', `${geo.vias.length} vs ${counts.vias}`)

  if (geo.zones.length !== refZones.length) miss('zones', `${geo.zones.length} vs ${refZones.length}`)
  geo.zones.slice(0, refZones.length).forEach((a, i) => {      // file order = pcbnew order
    const b = refZones[i], tag = `zone ${i} ${a.name || a.net}`
    if (a.rule_area !== b.rule_area) miss('zone_rule_area', `${tag}: ${a.rule_area} vs ${b.rule_area}`)
    if (b.rule_area) {
      try { assert.deepEqual(a.allow, b.keepout) } catch { miss('zone_keepout', `${tag}: ${JSON.stringify(a.allow)} vs ${JSON.stringify(b.keepout)}`) }
    }
    const nRef = b.outline.reduce((n, o) => n + 1 + o.holes, 0)
    if (a.polygons.length !== nRef) miss('zone_polygons', `${tag}: ${a.polygons.length} vs ${nRef}`)
    const mine: Record<string, number> = {}
    for (const f of a.filled) mine[f.layer] = (mine[f.layer] ?? 0) + 1
    const theirsFilled = Object.fromEntries(Object.entries(b.filled).filter(([, v]) => v))
    try { assert.deepEqual(mine, theirsFilled) } catch { miss('zone_filled', `${tag}: ${JSON.stringify(mine)} vs ${JSON.stringify(b.filled)}`) }
  })

  const closed = geo.outline.filter(c => c.length > 2 && c[0][0] === c[c.length - 1][0] && c[0][1] === c[c.length - 1][1]).length
  const nRef = refOutline.outlines.reduce((n, o) => n + 1 + o.holes, 0)
  if (geo.outline_open || closed !== nRef) miss('outline', `${closed} closed + ${geo.outline_open} open vs pcbnew ${nRef}`)
  return bad
}

/** A stand-in for KiCad's Python, so the client is tested where KiCad is missing. */
function fakePython(t: TestContext, body: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pcbnew-'))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  const exe = path.join(dir, 'python3')
  fs.writeFileSync(exe, '#!/bin/sh\n' + body + '\n', { mode: 0o755 })
  return exe
}

test('a silent worker times out and the error says so', async t => {
  const w = new PcbnewWorker({ script: 'x', python: fakePython(t, 'exec sleep 30'), timeoutS: 0.3 })
  await assert.rejects(w.call('ping'), (e: Error) => e instanceof WorkerError && /timed out on 'ping'/.test(e.message))
  await w.close()
})

test('a reply is matched by id and other output is skipped', async t => {
  const exe = fakePython(t, 'while read line; do echo noise; echo \'{"id":99,"ok":true,"result":"old"}\'; ' +
                            'echo \'{"id":1,"ok":true,"result":"mine"}\'; done')
  const w = new PcbnewWorker({ script: 'x', python: exe, timeoutS: 5 })
  assert.equal(await w.call('ping'), 'mine')
  await w.close()
})

test('an op error is a rejection and stderr reaches a crash report', async t => {
  const exe = fakePython(t, 'read line; echo \'{"id":1,"ok":false,"error":"bad op"}\'; read line; echo "assert failed" >&2; exit 7')
  const w = new PcbnewWorker({ script: 'x', python: exe, timeoutS: 5 })
  await assert.rejects(w.call('one'), /one: bad op/)
  await assert.rejects(w.call('two'), (e: Error) => /stopped during 'two' \(exit 7\)/.test(e.message) && /assert failed/.test(e.message))
  await w.close()
})

test('a crash is an error and the next call works', { skip }, async () => {
  const w = new PcbnewWorker({ script: SCRIPT, python: python! })
  await assert.rejects(w.call('crash'), (e: Error) => e instanceof WorkerError && /stopped/.test(e.message))
  await assert.rejects(w.call('nope'), /unknown op/)            // an op error is a reply, the worker lives
  assert.ok((await w.call<{ pcbnew: string }>('ping')).pcbnew)
  await w.close()
})

test('calls run in order and an exit reports its code', { skip }, async () => {
  const w = new PcbnewWorker({ script: SCRIPT, python: python!, timeoutS: 120 })
  const replies = await Promise.all([w.call('ping'), w.call('ping'), w.call('ping')])
  assert.equal(replies.length, 3)
  await assert.rejects(w.call('crash', { how: 'exit' }), /exit 3/)
  await w.close()
})

test('a missing script is an error, not a hang', { skip }, async () => {
  const w = new PcbnewWorker({ script: '/nonexistent/worker.py', python: python!, timeoutS: 20 })
  await assert.rejects(w.call('ping'), WorkerError)
  await w.close()
})

test('a board handle stays valid after another board closes', { skip: skip || !boards().length }, async () => {
  const [one] = boards()
  const w = new PcbnewWorker({ script: SCRIPT, python: python! })
  try {
    const load1 = await w.call<{ board: string }>('load', { path: one })
    const load2 = await w.call<{ board: string }>('load', { path: one })
    await w.call('close', { board: load1.board })
    const load3 = await w.call<{ board: string }>('load', { path: one })
    assert.notEqual(load3.board, load2.board)
  } finally {
    await w.close()
  }
})

test('board geometry matches pcbnew on every board', { skip: skip || !boards().length }, async () => {
  const files = boards()
  assert.ok(files.length >= 30, `${files.length} boards`)
  const w = new PcbnewWorker({ script: SCRIPT, python: python! })
  const failures: string[] = []
  for (const f of files) {
    const bad = await compare(f, w)
    for (const [k, v] of Object.entries(bad)) failures.push(`${path.basename(f)} ${k} x${v.length}: ${v.slice(0, 3).join(' | ')}`)
  }
  await w.close()
  assert.deepEqual(failures, [])
  console.log(`pcbnew: ${files.length} boards agree`)
})
