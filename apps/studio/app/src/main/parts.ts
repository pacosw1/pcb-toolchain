// BOM and part evidence for a board revision, from its .kicad_pcb footprints plus the project registry. Read only.
// Port of engine/src/pcbstudio/parts.py.
//
// A BOM line groups footprints with the same value, C-number, MPN and footprint. Joined per line:
// - datasheet: the parts index (partsIndex.ts: file names, source.json, CAD manifests, components.json, BOM CSVs), else
//   the footprint's Datasheet URL;
// - CAD asset: `<cad_assets_dir>/<C-number>/` exists;
// - evidence: the revision's own BOM CSV (its `bom` field; none = no stock/assembly evidence), by designator, after
//   column normalisation (bomcsv.ts). The CSV C-number is compared with the PCB C-number for every ref.
import fs from 'node:fs'
import path from 'node:path'
import type { BoardParts, Bom, BomLine, BomSource, Footprint } from '../shared/generated'
import * as bomcsv from './bomcsv.ts'
import { bbox, load } from './kicad/board.ts'
import { indexFor } from './partsIndex.ts'
import type { Project } from './project.ts'

const C_NUMBER_PROPS = ['LCSC', 'JLC', 'LCSC Part #', 'LCSC Part', 'JLCPCB Part #']

const isDir = (p: string): boolean => { try { return fs.statSync(p).isDirectory() } catch { return false } }

/** The one rule for a footprint's JLC/LCSC C-number: the first of C_NUMBER_PROPS (any case) that holds a C-number. */
export function footprintCNumber(props: Record<string, string>): string | null {
  const lower = new Map(Object.entries(props).map(([k, v]) => [k.toLowerCase(), v]))
  for (const k of C_NUMBER_PROPS) {
    const c = bomcsv.cNumber(k in props ? props[k] : lower.get(k.toLowerCase()))
    if (c) return c
  }
  return null
}

/** Natural order: R2 before R10. Digits sit at the odd places of the split, so like compares with like. */
function natural(a: string, b: string): number {
  const x = a.split(/(\d+)/), y = b.split(/(\d+)/)
  for (let i = 0; i < Math.min(x.length, y.length); i++) {
    if (x[i] === y[i]) continue
    if (i % 2) {
      const d = Number(x[i]) - Number(y[i])
      if (d) return d
    } else {
      return x[i] < y[i] ? -1 : 1
    }
  }
  return x.length - y.length
}

const inBom = (fp: Footprint): boolean =>
  Boolean(fp.ref) && !fp.ref.startsWith('#') && !fp.attrs.includes('board_only') && !fp.attrs.includes('exclude_from_bom')

/** bomCsv (project-relative) overrides the revision's own `bom` (for a what-if comparison). */
export function bom(project: Project, pcbRel: string, bomCsv: string | null = null): Bom {
  const geo = load(project.resolve(pcbRel))
  const sheets = indexFor(project).datasheets()
  const revision = project.revisionForPcb(pcbRel)?.[1] ?? null
  const csvRel = bomCsv ?? revision?.bom ?? null
  let source: BomSource | null = null
  let verified = new Map<string, bomcsv.BomRow>()
  if (csvRel) {
    const b = bomcsv.read(project.resolve(csvRel))
    verified = b.byRef()
    source = { path: csvRel, rows: b.rows.length, columns: b.columns, unknown_columns: b.unknown, header_only: !b.rows.length }
  }
  const assets = project.path(project.layout.cad_assets_dir)
  const lines = new Map<string, BomLine>()
  const seen = new Set<string>()
  for (const fp of geo.footprints) {
    if (!inBom(fp)) continue
    const pr = fp.props, attrs = fp.attrs, ref = fp.ref
    seen.add(ref)
    const lcsc = footprintCNumber(pr)
    const dnp = attrs.includes('dnp')
    const key = JSON.stringify([pr.Value ?? '', lcsc, pr.MPN ?? '', fp.lib, dnp])
    let line = lines.get(key)
    if (!line) {
      const sheet = lcsc ? sheets.get(lcsc) : undefined
      const url = pr.Datasheet ?? ''
      line = {
        refs: [], qty: 0, value: pr.Value ?? '', lcsc, mpn: pr.MPN || null, manufacturer: pr.Manufacturer || null,
        footprint: fp.lib, description: pr.Description || null, dnp,
        assembly: attrs.includes('through_hole') ? 'tht' : attrs.includes('smd') ? 'smd' : 'other',
        datasheet: sheet?.path ?? null, datasheet_sha256: sheet?.sha256 ?? null,
        datasheet_url: url.startsWith('http') ? url : null,
        cad_asset: Boolean(lcsc) && isDir(path.join(assets, lcsc!)), stock_status: null, assembly_status: null,
        csv_lcsc: null, lcsc_mismatch_refs: [], csv_missing_refs: []
      }
      lines.set(key, line)
    }
    line.refs.push(ref)
    if (!source) continue
    const v = verified.get(ref)
    if (!v) {
      line.csv_missing_refs.push(ref)
      continue
    }
    line.stock_status ||= v.stock_status || null
    line.assembly_status ||= v.assembly_status || null
    const csvC = bomcsv.cNumber(v.lcsc)
    if (csvC && csvC !== lcsc) {
      line.lcsc_mismatch_refs.push(ref)
      line.csv_lcsc ||= csvC
    } else if (csvC && line.csv_lcsc === null) {
      line.csv_lcsc = csvC
    }
  }
  const out = [...lines.values()]
  for (const line of out) {
    line.refs.sort(natural)
    line.lcsc_mismatch_refs.sort(natural)
    line.csv_missing_refs.sort(natural)
    line.qty = line.refs.length
  }
  out.sort((a, b) => natural(a.refs[0], b.refs[0]))
  const placed = out.filter(l => !l.dnp)
  const csvOnly = [...verified.keys()].filter(r => !seen.has(r)).sort(natural)
  const total = (f: (l: BomLine) => number): number => out.reduce((n, l) => n + f(l), 0)
  return {
    pcb: pcbRel, revision: revision?.revision ?? null, source, csv_only_refs: csvOnly, lines: out,
    summary: {
      refs: total(l => l.qty), lines: out.length, dnp_refs: total(l => l.dnp ? l.qty : 0),
      missing_lcsc: placed.filter(l => !l.lcsc).length, missing_datasheet: placed.filter(l => !l.datasheet).length,
      missing_cad_asset: placed.filter(l => l.lcsc && !l.cad_asset).length,
      lcsc_mismatches: total(l => l.lcsc_mismatch_refs.length), lines_with_mismatch: out.filter(l => l.lcsc_mismatch_refs.length).length,
      csv_missing_refs: total(l => l.csv_missing_refs.length), csv_only_refs: csvOnly.length
    }
  }
}

/** Footprints of a board with the engine's C-number rule (the agent's board_parts tool). */
export function boardParts(project: Project, pcbRel: string): BoardParts {
  const geo = load(project.resolve(pcbRel))
  return {
    pcb: pcbRel, bbox: bbox(geo), tracks: geo.tracks.length, vias: geo.vias.length,
    footprints: geo.footprints.filter(f => f.ref).map(f => ({
      ref: f.ref, value: f.props.Value ?? null, lcsc: footprintCNumber(f.props), mpn: f.props.MPN || null, x: f.x, y: f.y,
      rot: f.rot, layer: f.layer, pads: f.pads.length, dnp: f.attrs.includes('dnp')
    }))
  }
}
