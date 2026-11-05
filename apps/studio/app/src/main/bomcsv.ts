// BOM evidence CSVs (BOM-VERIFIED.csv and friends) with normalised column names.
//
// Board CSVs name the same thing in different ways ('Stock status' / 'Stock observed', 'LCSC' / 'LCSC Part #',
// 'MPN/value' / 'MPN'). Each header is normalised (lower case, non-alphanumerics to '_') and mapped to one canonical
// name; headers with no mapping are reported, not guessed.
import fs from 'node:fs'

const ALIASES: Record<string, string[]> = {
  designator: ['designator', 'designators', 'ref', 'refs', 'reference', 'references'],
  lcsc: ['lcsc', 'lcsc_part', 'lcsc_part_number', 'lcsc_part_no', 'jlc', 'jlc_part', 'jlcpcb_part', 'c_number'],
  mpn: ['mpn', 'mpn_value', 'part_number', 'manufacturer_part', 'manufacturer_part_number'],
  manufacturer: ['manufacturer', 'mfr'],
  value: ['value', 'comment'],
  footprint: ['footprint'],
  package: ['package'],
  qty: ['qty', 'quantity'],
  function_block: ['function_block'],
  datasheet: ['datasheet'],
  datasheet_sha256: ['datasheet_sha256'],
  unit_price: ['unit_price', 'unit_cost'],
  currency: ['currency', 'price_currency'],
  supplier: ['supplier', 'vendor'],
  price_observed_utc: ['price_observed_utc', 'quote_observed_utc', 'quote_date'],
  minimum_quantity: ['minimum_quantity', 'price_break_quantity', 'moq'],
  stock_status: ['stock_status', 'stock', 'stock_observed'],
  stock_observed_utc: ['observed_utc', 'stock_observed_utc'],
  assembly_status: ['assembly_status', 'assembly'],
  jlc_class: ['jlc_class'],
  pcba_type: ['pcba_type'],
  variant: ['variant', 'population'],
  evidence: ['evidence'],
  reviewer_note: ['reviewer_note', 'note', 'notes'],
  selection_state: ['selection_state']
}
const CANON = new Map(Object.entries(ALIASES).flatMap(([canon, names]) => names.map((a): [string, string] => [a, canon])))

export type BomRow = Record<string, string>

export function normalise(header: string): string {
  return header.trim().toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '')
}

export function cNumber(raw: unknown): string | null {
  const v = (typeof raw === 'string' ? raw : '').trim().toUpperCase()
  return /^C\d{3,}$/.test(v) ? v : null
}

/** Rows of CSV text, as Python's csv.reader: "" is a quote in a quoted field, a quote inside an unquoted field is plain
 *  text, and a blank line is an empty row. */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = []
  let row: string[] = [], field = ''
  let quoted = false, fieldStart = true, lineOpen = false
  const endLine = (): void => {
    if (lineOpen) row.push(field)
    rows.push(row)
    row = []
    field = ''
    fieldStart = true
    lineOpen = false
  }
  for (let i = 0; i < text.length; i++) {
    const c = text[i]
    if (quoted) {
      if (c !== '"') field += c
      else if (text[i + 1] === '"') { field += '"'; i += 1 } else quoted = false
    } else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i += 1
      endLine()
    } else {
      lineOpen = true
      if (c === ',') {
        row.push(field)
        field = ''
        fieldStart = true
        continue
      }
      if (c === '"' && fieldStart) quoted = true
      else field += c
      fieldStart = false
    }
  }
  if (lineOpen) endLine()
  return rows
}

export class BomCsv {
  columns: string[] = []            // canonical names found
  unknown: string[] = []            // original headers with no mapping
  rows: BomRow[] = []               // canonical name -> value

  byRef(): Map<string, BomRow> {
    const out = new Map<string, BomRow>()
    for (const row of this.rows) {
      for (const ref of (row.designator ?? '').split(/[,\s]+/)) if (ref) out.set(ref, row)
    }
    return out
  }
}

export function read(file: string): BomCsv {
  const out = new BomCsv()
  const [header = [], ...rows] = parseCsv(fs.readFileSync(file).toString('utf8').replace(/^﻿/, ''))
  const mapping: (string | null)[] = []
  for (const h of header) {
    const canon = CANON.get(normalise(h)) ?? null
    if (canon === null || out.columns.includes(canon)) {    // first column wins on a duplicate meaning
      if (h.trim()) out.unknown.push(h)
      mapping.push(null)
    } else {
      out.columns.push(canon)
      mapping.push(canon)
    }
  }
  for (const raw of rows) {
    if (!raw.some(c => c.trim())) continue
    const row: BomRow = {}
    mapping.forEach((canon, i) => { if (canon) row[canon] = i < raw.length ? raw[i].trim() : '' })
    const stock = row.stock_status, utc = row.stock_observed_utc
    if (stock && utc && /^\d+$/.test(stock.replaceAll(',', ''))) row.stock_status = `stock ${stock} observed ${utc}`
    out.rows.push(row)
  }
  return out
}
