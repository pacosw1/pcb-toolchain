// Parts index: C-number -> datasheets (with sha256), MPN, manufacturer, CAD asset and catalog evidence.
// Port of engine/src/pcbstudio/store/parts_index.py.
//
// SQLite file in the engine cache folder (`<cache>/index/parts-<root-hash>.sqlite`), never in the project. Sources, in
// preference order for a part's main datasheet:
// 1. filename      `<datasheets_dir>/<anything>_<C-number>.pdf`
// 2. source_json   `<pdf>.source.json` next to a PDF (catalog_url / catalog_snapshot name the C-number)
// 3. cad_manifest  `<cad_assets_dir>/<C>/MANIFEST.json` (any nested "datasheet" key)
// 4. components_json  `components.json` candidates (lcsc + datasheet)
// 5. bom_csv       board BOM CSVs (`<boards_dir>/*/*.csv`, LCSC + Datasheet columns)
//
// A source path that does not exist is counted (missing_paths) and ignored. The index is rebuilt only when the input
// fingerprint (path, size, mtime of every source file) changes; PDF hashes are reused while size and mtime stay.
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import type { DatasheetRef, PartRecord, PartsIndexStats } from '../shared/generated'
import * as bomcsv from './bomcsv.ts'
import { resolveReal } from './project.ts'
import type { Project } from './project.ts'

const SCHEMA = 2
const SOURCES = ['filename', 'source_json', 'cad_manifest', 'components_json', 'bom_csv'] as const
type Source = typeof SOURCES[number]
const NAME_C = /_(C\d{3,})\.pdf$/i
const URL_C = /\/(C\d{3,})(?:$|[/?#.])/
const FILE_C = /^(C\d{3,})\.json$/
const HASH_CHUNK = 1 << 20

type Json = Record<string, unknown>
type MapRow = [string, string, Source, string | null]    // c, rel path, source, recorded sha
interface Info { evidence: Set<string>, mpn?: string, manufacturer?: string }

const isFile = (p: string): boolean => { try { return fs.statSync(p).isFile() } catch { return false } }
const isDir = (p: string): boolean => { try { return fs.statSync(p).isDirectory() } catch { return false } }
const isObject = (x: unknown): x is Json => x !== null && typeof x === 'object' && !Array.isArray(x)
const text = (x: unknown): string | undefined => typeof x === 'string' ? x : undefined
const within = (base: string, rel: string): string => path.isAbsolute(rel) ? rel : base + path.sep + rel
const lexical = (a: string, b: string): number => a < b ? -1 : a > b ? 1 : 0

function sha256(file: string): string {
  const h = createHash('sha256'), fd = fs.openSync(file, 'r'), buf = Buffer.allocUnsafe(HASH_CHUNK)
  try {
    for (let n = fs.readSync(fd, buf); n > 0; n = fs.readSync(fd, buf)) h.update(buf.subarray(0, n))
  } finally {
    fs.closeSync(fd)
  }
  return h.digest('hex')
}

function* walk(o: unknown): Generator<Json> {
  if (Array.isArray(o)) {
    for (const v of o) yield * walk(v)
  } else if (isObject(o)) {
    yield o
    for (const v of Object.values(o)) yield * walk(v)
  }
}

function readJson(file: string): unknown {
  try { return JSON.parse(fs.readFileSync(file).toString('utf8')) } catch { return null }
}

/** `$PCBSTUDIO_CACHE`, else the OS user cache folder + /pcbstudio. */
export function cacheDir(): string {
  const env = process.env.PCBSTUDIO_CACHE
  if (env) return env.replace(/^~(?=$|\/)/, os.homedir())
  if (process.platform === 'darwin') return path.join(os.homedir(), 'Library/Caches/pcbstudio')
  return path.join(process.env.XDG_CACHE_HOME ?? path.join(os.homedir(), '.cache'), 'pcbstudio')
}

/** Every file `<dir>/*\/<match>`, sorted by folder, then name. */
function oneLevel(dir: string, match: (name: string) => boolean): string[] {
  if (!isDir(dir)) return []
  return fs.readdirSync(dir).sort(lexical).map(d => path.join(dir, d)).filter(isDir)
    .flatMap(d => fs.readdirSync(d).sort(lexical).filter(match).map(n => path.join(d, n)).filter(isFile))
}

export class PartsIndex {
  readonly project: Project
  readonly dbPath: string
  private readonly dsDir: string
  private readonly assetsDir: string
  private readonly components: string

  constructor(project: Project, dbPath?: string) {
    this.project = project
    const lay = project.layout
    this.dsDir = project.path(lay.datasheets_dir)
    this.assetsDir = project.path(lay.cad_assets_dir)
    this.components = project.path(lay.components)
    const key = createHash('sha256').update(project.root).digest('hex').slice(0, 16)
    this.dbPath = dbPath ?? path.join(cacheDir(), 'index', `parts-${key}.sqlite`)
  }

  private pdfs(): string[] {
    return isDir(this.dsDir) ? fs.readdirSync(this.dsDir).sort(lexical).filter(n => n.endsWith('.pdf')).map(n => path.join(this.dsDir, n)) : []
  }

  private manifests(): string[] { return oneLevel(this.assetsDir, n => n === 'MANIFEST.json') }

  private csvs(): string[] { return oneLevel(this.project.boardsPath, n => n.endsWith('.csv')) }

  private inputs(): string[] {
    const ds = isDir(this.dsDir) ? fs.readdirSync(this.dsDir).sort(lexical).filter(n => n.endsWith('.pdf') || n.endsWith('.source.json')).map(n => path.join(this.dsDir, n)) : []
    return [...ds, ...(isFile(this.components) ? [this.components] : []), ...this.manifests(), ...this.csvs()]
  }

  fingerprint(): string {
    const h = createHash('sha256').update(`schema ${SCHEMA}\n`)
    for (const p of this.inputs()) {
      let st: fs.BigIntStats
      try { st = fs.statSync(p, { bigint: true }) } catch { continue }
      h.update(`${path.relative(this.project.root, p)}\t${st.size}\t${st.mtimeNs}\n`)
    }
    return h.digest('hex')
  }

  private connect(): DatabaseSync {
    fs.mkdirSync(path.dirname(this.dbPath), { recursive: true })
    const db = new DatabaseSync(this.dbPath)
    db.exec(`
      CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT);
      CREATE TABLE IF NOT EXISTS files (path TEXT PRIMARY KEY, size INTEGER, mtime_ns INTEGER, sha256 TEXT);
      CREATE TABLE IF NOT EXISTS datasheets (c_number TEXT, path TEXT, source TEXT, recorded_sha256 TEXT,
                                             PRIMARY KEY (c_number, path, source));
      CREATE TABLE IF NOT EXISTS parts (c_number TEXT PRIMARY KEY, mpn TEXT, manufacturer TEXT, cad_asset TEXT,
                                        evidence TEXT);`)
    return db
  }

  ensure(): PartsIndexStats {
    const fp = this.fingerprint()
    const db = this.connect()
    try {
      const rows = db.prepare('SELECT key, value FROM meta').all() as unknown as { key: string, value: string }[]
      const meta = new Map(rows.map(r => [r.key, r.value]))
      if (meta.get('fingerprint') === fp && meta.get('stats')) {
        return { ...JSON.parse(meta.get('stats')!) as PartsIndexStats, rebuilt: false }
      }
      db.exec('BEGIN')
      try {
        const stats = this.build(db, fp)
        db.exec('COMMIT')
        return stats
      } catch (e) {
        db.exec('ROLLBACK')
        throw e
      }
    } finally {
      db.close()
    }
  }

  private build(db: DatabaseSync, fp: string): PartsIndexStats {
    const root = this.project.root
    const relOf = (p: string): string => path.relative(root, p)
    const stmtOld = db.prepare('SELECT path, size, mtime_ns, sha256 FROM files')
    stmtOld.setReadBigInts(true)
    const old = new Map((stmtOld.all() as unknown as { path: string, size: bigint, mtime_ns: bigint, sha256: string }[]).map(r => [r.path, r]))
    const maps: MapRow[] = []
    const info = new Map<string, Info>()
    let missing = 0

    const meta = (c: string, fields: { mpn?: unknown, manufacturer?: unknown, evidence?: string | null }): void => {
      if (!info.has(c)) info.set(c, { evidence: new Set() })
      const d = info.get(c)!
      if (fields.evidence) d.evidence.add(fields.evidence)
      for (const k of ['mpn', 'manufacturer'] as const) {
        const v = fields[k]
        if (v && !d[k]) d[k] = v as string
      }
    }
    const found = (raw: string, base: string): string | null => {
      const p = resolveReal(within(base, raw))
      return isFile(p) && p.startsWith(root + path.sep) ? relOf(p) : null
    }
    const pdf = (raw: unknown, ...bases: string[]): string | null => {
      if (typeof raw !== 'string' || !raw || raw.startsWith('http://') || raw.startsWith('https://')) return null
      for (const b of bases) {
        const rel = found(raw, b)
        if (rel) return rel
      }
      missing += 1
      return null
    }
    const evidence = (raw: unknown, ...bases: string[]): string | null => {
      if (typeof raw !== 'string' || !raw) return null
      for (const b of bases) {
        const rel = found(raw, b)
        if (rel) return rel
      }
      return null
    }

    const pdfs = this.pdfs()
    for (const p of pdfs) {
      const rel = relOf(p), m = NAME_C.exec(path.basename(p))
      if (m) maps.push([m[1].toUpperCase(), rel, 'filename', null])
      const src = readJson(p + '.source.json')
      if (!isObject(src)) continue
      const cs = new Set<string>()
      for (const k of ['catalog_url', 'catalog_identity_url']) {
        const mm = URL_C.exec(text(src[k]) ?? '')
        if (mm) cs.add(mm[1].toUpperCase())
      }
      const named = bomcsv.cNumber(src.part)
      if (named) cs.add(named)
      const snap = text(src.catalog_snapshot)
      if (snap !== undefined) {
        const mm = FILE_C.exec(path.basename(snap))
        if (mm) cs.add(mm[1].toUpperCase())
      }
      for (const c of cs) {
        maps.push([c, rel, 'source_json', text(src.sha256) ?? null])
        meta(c, { evidence: evidence(snap, root) })
      }
    }

    for (const man of this.manifests()) {
      const data = readJson(man)
      if (!isObject(data)) continue
      const dir = path.dirname(man)
      const c = bomcsv.cNumber(data.lcsc) ?? bomcsv.cNumber(path.basename(dir))
      if (!c) continue
      meta(c, { mpn: data.mpn, manufacturer: data.manufacturer })
      for (const d of walk(data)) {
        if (typeof d.datasheet !== 'string') continue
        const rel = pdf(d.datasheet, root, dir, this.dsDir)
        if (rel) maps.push([c, rel, 'cad_manifest', text(d.datasheet_sha256) ?? null])
      }
    }

    const comp = isFile(this.components) ? readJson(this.components) : null
    const compDir = path.dirname(this.components)
    for (const cand of isObject(comp) && Array.isArray(comp.candidates) ? comp.candidates as Json[] : []) {
      const c = bomcsv.cNumber(cand.lcsc)
      if (!c) continue
      meta(c, { mpn: cand.mpn, manufacturer: cand.manufacturer, evidence: evidence(cand.evidence, compDir, root) })
      const rel = pdf(cand.datasheet, compDir, root)
      if (rel) maps.push([c, rel, 'components_json', null])
    }

    for (const f of this.csvs()) {
      let b: bomcsv.BomCsv
      try { b = bomcsv.read(f) } catch { continue }
      if (!b.columns.includes('lcsc')) continue
      const dir = path.dirname(f)
      for (const row of b.rows) {
        const c = bomcsv.cNumber(row.lcsc)
        if (!c) continue
        meta(c, { mpn: row.mpn, manufacturer: row.manufacturer, evidence: evidence(row.evidence, dir, root) })
        const rel = pdf(row.datasheet, dir, root)
        if (rel) maps.push([c, rel, 'bom_csv', row.datasheet_sha256 || null])
      }
    }

    // Hash every mapped PDF (reuse hashes while size + mtime are unchanged).
    const files = new Map<string, { size: bigint, mtime: bigint, sha: string }>()
    for (const rel of [...new Set([...maps.map(m => m[1]), ...pdfs.map(relOf)])].sort(lexical)) {
      const st = fs.statSync(path.join(root, rel), { bigint: true }), prev = old.get(rel)
      const sha = prev && prev.size === st.size && prev.mtime_ns === st.mtimeNs ? prev.sha256 : sha256(path.join(root, rel))
      files.set(rel, { size: st.size, mtime: st.mtimeNs, sha })
    }

    db.exec('DELETE FROM files')
    const addFile = db.prepare('INSERT INTO files VALUES (?,?,?,?)')
    for (const [k, v] of files) addFile.run(k, v.size, v.mtime, v.sha)
    db.exec('DELETE FROM datasheets')
    const addSheet = db.prepare('INSERT OR IGNORE INTO datasheets VALUES (?,?,?,?)')
    for (const m of maps) addSheet.run(...m)
    db.exec('DELETE FROM parts')
    const assets = new Set(isDir(this.assetsDir) ? fs.readdirSync(this.assetsDir).filter(n => isDir(path.join(this.assetsDir, n))).map(n => n.toUpperCase()) : [])
    const addPart = db.prepare('INSERT INTO parts VALUES (?,?,?,?,?)')
    for (const c of [...new Set([...maps.map(m => m[0]), ...info.keys(), ...assets])].sort(lexical)) {
      const i = info.get(c)
      addPart.run(c, i?.mpn ?? null, i?.manufacturer ?? null, assets.has(c) ? relOf(path.join(this.assetsDir, c)) : null,
                  JSON.stringify([...(i?.evidence ?? [])].sort(lexical)))
    }

    const best = this.preferred(db)
    const bySource = Object.fromEntries(SOURCES.map(s => [s, 0]))
    for (const ref of best.values()) bySource[ref.sources[0]] += 1
    const ds = new Set(pdfs.map(relOf))
    const stats: PartsIndexStats = {
      path: this.dbPath, fingerprint: fp, rebuilt: true, pdfs: pdfs.length,
      pdfs_c_in_name: pdfs.filter(p => NAME_C.test(path.basename(p))).length,
      pdfs_mapped: new Set(maps.map(m => m[1]).filter(r => ds.has(r))).size, c_numbers: best.size, by_source: bySource,
      missing_paths: missing,
      hash_mismatches: maps.filter(([, rel, , rec]) => rec && rec.length === 64 && rec.toLowerCase() !== files.get(rel)!.sha).length
    }
    db.exec('DELETE FROM meta')
    const addMeta = db.prepare('INSERT INTO meta VALUES (?,?)')
    addMeta.run('fingerprint', fp)
    addMeta.run('built_at', String(Date.now() / 1000))
    addMeta.run('stats', JSON.stringify(stats))
    return stats
  }

  private refs(db: DatabaseSync, c?: string): Map<string, DatasheetRef[]> {
    const q = 'SELECT d.c_number AS c, d.path AS path, d.source AS source, d.recorded_sha256 AS rec, f.sha256 AS sha FROM datasheets d ' +
              'JOIN files f ON f.path = d.path'
    const stmt = db.prepare(q + (c ? ' WHERE d.c_number = ?' : ''))
    const rows = (c ? stmt.all(c) : stmt.all()) as unknown as { c: string, path: string, source: Source, rec: string | null, sha: string }[]
    const grouped = new Map<string, Map<string, DatasheetRef>>()
    for (const r of rows) {
      if (!grouped.has(r.c)) grouped.set(r.c, new Map())
      const paths = grouped.get(r.c)!
      if (!paths.has(r.path)) paths.set(r.path, { path: r.path, sha256: r.sha, recorded_sha256: null, sources: [] })
      const g = paths.get(r.path)!
      g.sources.push(r.source)
      if (r.rec && !g.recorded_sha256) g.recorded_sha256 = r.rec
    }
    const rank = (s: Source): number => SOURCES.indexOf(s)
    const out = new Map<string, DatasheetRef[]>()
    for (const [cn, paths] of grouped) {
      const refs = [...paths.values()].map(v => ({ ...v, sources: [...new Set(v.sources)].sort((a, b) => rank(a) - rank(b)) }))
      refs.sort((a, b) => (rank(a.sources[0]) - rank(b.sources[0])) || lexical(a.path, b.path))
      out.set(cn, refs)
    }
    return out
  }

  private preferred(db: DatabaseSync): Map<string, DatasheetRef> {
    return new Map([...this.refs(db)].map(([c, refs]) => [c, refs[0]]))
  }

  /** C-number -> preferred datasheet, for every indexed part. */
  datasheets(): Map<string, DatasheetRef> {
    this.ensure()
    const db = this.connect()
    try { return this.preferred(db) } finally { db.close() }
  }

  part(raw: string): PartRecord | null {
    const c = raw.trim().toUpperCase()
    this.ensure()
    const db = this.connect()
    let row: { mpn: string | null, manufacturer: string | null, cad_asset: string | null, evidence: string | null } | undefined
    let refs: DatasheetRef[]
    try {
      row = db.prepare('SELECT mpn, manufacturer, cad_asset, evidence FROM parts WHERE c_number = ?').get(c) as typeof row
      refs = this.refs(db, c).get(c) ?? []
    } finally {
      db.close()
    }
    if (!row && !refs.length) return null
    return { c_number: c, mpn: row?.mpn ?? null, manufacturer: row?.manufacturer ?? null, datasheet: refs[0] ?? null, datasheets: refs,
             cad_asset: row?.cad_asset ?? null, evidence: JSON.parse(row?.evidence || '[]') as string[] }
  }
}

const open = new Map<string, PartsIndex>()

export function indexFor(project: Project): PartsIndex {
  const known = open.get(project.root)
  if (known && JSON.stringify(known.project.layout) === JSON.stringify(project.layout)) return known
  const index = new PartsIndex(project)
  open.set(project.root, index)
  return index
}
