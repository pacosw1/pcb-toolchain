// Port of engine/tests/test_parts.py. Run: node --test test/
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import type { TestContext } from 'node:test'
import { cNumber, normalise, parseCsv, read } from '../src/main/bomcsv.ts'
import { bom, boardParts, footprintCNumber } from '../src/main/parts.ts'
import { PartsIndex } from '../src/main/partsIndex.ts'
import { Project } from '../src/main/project.ts'

const CORPUS = process.env.PCBSTUDIO_CORPUS ?? path.join(os.homedir(), 'code/iot-lab')
const skipCorpus = !fs.existsSync(path.join(CORPUS, 'hardware-design/boards'))
const B = 'hardware-design/boards/'
const DEMO = B + 'DEMO/cad/DEMO/DEMO.kicad_pcb'
const POE = B + 'POE-ETHERNET/cad/POE-ETHERNET/POE-ETHERNET.kicad_pcb'
const BASE = (d: string): string => B + `BASE-PWR/cad/${d}/${d}.kicad_pcb`
const PQ_A = B + 'PQ-METER/cad/PQ-METER/PQ-METER.kicad_pcb'
const PQ_B = B + 'PQ-METER/cad/PQ-METER-B/PQ-METER-B.kicad_pcb'

function fp(ref: string, props: Record<string, string>): string {
  const p = Object.entries(props).map(([k, v]) => ` (property "${k}" "${v}")`).join('')
  return `(footprint "lib:R" (layer "F.Cu") (at 1 1) (property "Reference" "${ref}")${p} (attr smd)` +
         ' (pad "1" smd rect (at 0 0) (size 1 1) (layers "F.Cu") (net "N")))'
}

function write(p: string, text: string): void {
  fs.mkdirSync(path.dirname(p), { recursive: true })
  fs.writeFileSync(p, text)
}

function tmp(t: TestContext): string {
  const d = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'parts-')))
  t.after(() => fs.rmSync(d, { recursive: true, force: true }))
  return d
}

function small(t: TestContext): string {
  const root = tmp(t), j = (x: string): string => path.join(root, x)
  process.env.PCBSTUDIO_CACHE = path.join(root, '.cache-test')
  write(j(DEMO), '(kicad_pcb (version 1) (gr_rect (start 0 0) (end 10 10) (layer "Edge.Cuts"))\n' +
    fp('R1', { Value: '10k', LCSC: 'C1001' }) + fp('R2', { Value: '10k', JLC: 'c1002' }) +
    fp('R3', { Value: '1k' }) + fp('U1', { Value: 'IC', 'LCSC Part #': 'C1004' }) + ')')
  const ds = 'hardware-design/registry/datasheets/'
  write(j(ds + 'R10K_C1001.pdf'), '%PDF-1 a')
  write(j(ds + 'R10K-other.pdf'), '%PDF-1 b')                       // no C-number in the name
  write(j(ds + 'R10K-other.pdf.source.json'), JSON.stringify({ catalog_url: 'https://jlcpcb.com/partdetail/X-Y/C1002', sha256: 'f'.repeat(64) }))
  write(j(ds + 'IC.pdf'), '%PDF-1 c')
  write(j('hardware-design/registry/cad-assets/C1004/MANIFEST.json'),
        JSON.stringify({ lcsc: 'C1004', mpn: 'IC-1', footprint: { datasheet: ds + 'IC.pdf' } }))
  write(j('hardware-design/registry/components.json'), JSON.stringify({ candidates: [{ lcsc: 'C1005', mpn: 'GONE', datasheet: 'datasheets/missing.pdf' }] }))
  write(j(B + 'DEMO/BOM-VERIFIED.csv'), 'Designator,LCSC,MPN/value,Stock observed,Observed UTC,Odd column\n' +
        'R1,C1001,RC0603,5000,2026-10-01T00:00Z,x\nR2,C9999,RC0603,7,2026-10-01T00:00Z,y\nR9,C1001,,1,,\n')
  write(j('hardware-design/registry/boards.json'), JSON.stringify({ boards: [{ id: 'DEMO', directory: 'DEMO',
    revisions: [{ revision: 'A', state: 's', project: 'cad/DEMO/DEMO', bom: 'BOM-VERIFIED.csv' }] }] }))
  return root
}

test('the footprint C-number rule', () => {
  assert.equal(footprintCNumber({ LCSC: ' c123 ' }), 'C123')
  assert.equal(footprintCNumber({ JLC: 'C456' }), 'C456')
  assert.equal(footprintCNumber({ lcsc: 'C789' }), 'C789')
  assert.equal(footprintCNumber({ LCSC: 'n/a', JLC: 'C5000' }), 'C5000')
  assert.equal(footprintCNumber({ Value: '10k' }), null)
})

test('CSV text parses as Python csv.reader does', () => {
  assert.deepEqual(parseCsv('a,b\n1,2\n'), [['a', 'b'], ['1', '2']])
  assert.deepEqual(parseCsv('a,\n,\n'), [['a', ''], ['', '']])
  assert.deepEqual(parseCsv('a\n\nb'), [['a'], [], ['b']])
  assert.deepEqual(parseCsv('"a,b","c""d","e\nf"\r\ng\rh'), [['a,b', 'c"d', 'e\nf'], ['g'], ['h']])
  assert.deepEqual(parseCsv('x"y,"z"w,""\n'), [['x"y', 'zw', '']])
  assert.deepEqual(parseCsv(''), [])
  assert.equal(normalise(' MPN/value '), 'mpn_value')
  assert.equal(cNumber(5 as unknown as string), null)
})

test('CSV columns are normalised', t => {
  const f = path.join(tmp(t), 'b.csv')
  fs.writeFileSync(f, '﻿Designator,LCSC Part #,Stock observed,Observed UTC,Assembly,Whatever\nC1 C2,C14663,12,2026Z,JLC SMT,1\n')
  const b = read(f)
  assert.deepEqual(b.columns, ['designator', 'lcsc', 'stock_status', 'stock_observed_utc', 'assembly_status'])
  assert.deepEqual(b.unknown, ['Whatever'])
  assert.deepEqual(b.byRef().get('C2'), { designator: 'C1 C2', lcsc: 'C14663', stock_status: 'stock 12 observed 2026Z',
                                          stock_observed_utc: '2026Z', assembly_status: 'JLC SMT' })
  fs.writeFileSync(f, 'Designator,LCSC\n')
  assert.deepEqual(read(f).rows, [])
})

test('a small BOM, its index and a mismatch', t => {
  const root = small(t), p = new Project(root), b = bom(p, DEMO)
  const lines = new Map(b.lines.map(l => [l.refs[0], l]))
  assert.equal(b.revision, 'A')
  assert.deepEqual(b.source!.columns.slice(0, 3), ['designator', 'lcsc', 'mpn'])
  assert.equal(b.source!.header_only, false)
  assert.deepEqual(b.source!.unknown_columns, ['Odd column'])
  const r1 = lines.get('R1')!, r2 = lines.get('R2')!, u1 = lines.get('U1')!, r3 = lines.get('R3')!
  assert.equal(r1.lcsc, 'C1001')
  assert.equal(r1.stock_status, 'stock 5000 observed 2026-10-01T00:00Z')
  assert.ok(r1.datasheet!.endsWith('R10K_C1001.pdf'))
  assert.equal(r1.datasheet_sha256!.length, 64)
  assert.equal(r2.lcsc, 'C1002')
  assert.ok(r2.datasheet!.endsWith('R10K-other.pdf'))                // via source.json
  assert.deepEqual(r2.lcsc_mismatch_refs, ['R2'])
  assert.equal(r2.csv_lcsc, 'C9999')
  assert.ok(u1.datasheet!.endsWith('IC.pdf'))                        // via cad manifest
  assert.deepEqual(u1.csv_missing_refs, ['U1'])
  assert.equal(r3.lcsc, null)
  assert.equal(r3.datasheet, null)
  const s = b.summary
  assert.deepEqual([s.lcsc_mismatches, s.lines_with_mismatch, s.csv_missing_refs, s.csv_only_refs], [1, 1, 2, 1])
  assert.deepEqual(b.csv_only_refs, ['R9'])

  const idx = new PartsIndex(p), st = idx.ensure()
  assert.equal(st.rebuilt, false)                                    // bom() built it; inputs unchanged
  assert.deepEqual([st.pdfs, st.pdfs_c_in_name, st.pdfs_mapped], [3, 1, 3])
  assert.deepEqual([st.by_source.filename, st.by_source.source_json, st.by_source.cad_manifest], [1, 1, 1])
  assert.deepEqual([st.missing_paths, st.hash_mismatches], [1, 1])   // components.json path; source.json sha 'fff..'
  const rec = idx.part('c1004')!
  assert.equal(rec.mpn, 'IC-1')
  assert.equal(rec.cad_asset, 'hardware-design/registry/cad-assets/C1004')
  assert.deepEqual(rec.datasheet!.sources, ['cad_manifest'])
  assert.equal(idx.part('C1005')!.mpn, 'GONE')
  assert.equal(idx.part('C1005')!.datasheet, null)
  assert.equal(idx.part('C424242'), null)
  write(path.join(root, 'hardware-design/registry/datasheets/R1K_C1003.pdf'), '%PDF-1 d')   // a changed input rebuilds
  const again = idx.ensure()
  assert.equal(again.rebuilt, true)
  assert.equal(again.pdfs, 4)
  assert.equal(idx.ensure().rebuilt, false)
})

test('board parts use the same C-number rule', t => {
  const bp = boardParts(new Project(small(t)), DEMO)
  assert.deepEqual(Object.fromEntries(bp.footprints.map(f => [f.ref, f.lcsc])), { R1: 'C1001', R2: 'C1002', R3: null, U1: 'C1004' })
  assert.deepEqual(bp.bbox, [0, 0, 10, 10])
})

test('refs sort naturally', t => {
  const root = small(t)
  const body = ['R10', 'R2', 'R1'].map(r => fp(r, { Value: 'same' })).join('')
  write(path.join(root, DEMO), `(kicad_pcb (version 1) ${body})`)
  assert.deepEqual(bom(new Project(root), DEMO).lines[0].refs, ['R1', 'R2', 'R10'])
})

test('the POE BOM is consistent', { skip: skipCorpus }, t => {
  process.env.PCBSTUDIO_CACHE = tmp(t)
  const b = bom(new Project(CORPUS), POE), refs = b.lines.flatMap(l => l.refs)
  assert.equal(refs.length, new Set(refs).size)
  assert.equal(refs.length, b.summary.refs)
  assert.ok(refs.length > 20)
  assert.ok(b.lines.every(l => l.qty === l.refs.length))
  assert.ok(!refs.some(r => /^H\d+$/.test(r)))                       // board-only footprints are not BOM lines
})

test('the BOM is per revision', { skip: skipCorpus }, t => {
  process.env.PCBSTUDIO_CACHE = tmp(t)
  const p = new Project(CORPUS)
  for (const d of ['BASE-PWR', 'BASE-PWR-B']) {
    const b = bom(p, BASE(d))
    assert.equal(b.source, null, d)
    assert.ok(!b.lines.some(l => l.stock_status || l.assembly_status), d)
  }
  const c = bom(p, BASE('BASE-PWR-C'))
  assert.equal(c.source!.path, B + 'BASE-PWR/BOM-VERIFIED.csv')
  assert.equal(c.summary.lcsc_mismatches, 0)
  assert.ok(c.lines.filter(l => l.stock_status).length > 50)
  const a = bom(p, PQ_A)
  assert.ok(a.source && a.summary.lcsc_mismatches === 0 && a.lines.some(l => l.stock_status))
  assert.equal(bom(p, PQ_B).source, null)
  const wrong = bom(p, PQ_B, B + 'PQ-METER/BOM-VERIFIED.csv')
  assert.equal(wrong.summary.lcsc_mismatches, 90)
  assert.ok(wrong.summary.lines_with_mismatch > 30)
})
