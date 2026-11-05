// A hardware project (an iot-lab style repo): boards, revisions, their KiCad files and gates. Read only.
//
// Board identity has one source per board:
// - `<boards_dir>/<DIR>/board.yaml` (schema pcbstudio.board.v1) when the board has one;
// - else the legacy derivation: registry `boards.json` (id, lifecycle, revisions, spec, bom) + board folders
//   (`cad/**/*.kicad_pcb`) + gate configs.
//
// Gate names come only from gate configs: `<boards_dir>/<NAME>/gate.json` (and `gate-<variant>.json`) checks the
// revision whose PCB is the config's `project` + `.kicad_pcb`. The registry `gate` field is only cross-checked, and a
// disagreement is an IdentityConflict. A folder that holds only gate data for a PCB in another folder (registry kind
// `gate-only`, for example BASE-PWR-B) is not a board: its gate shows on the revision it checks.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import yaml from 'js-yaml'
import { z } from 'zod'
import type { Board, GateRef, IdentityConflict, ProjectInfo, ProjectLayout, Revision } from '../shared/generated'

export const DEFAULT_LAYOUT: ProjectLayout = {
  boards_dir: 'hardware-design/boards',
  registry: 'hardware-design/registry/boards.json',
  datasheets_dir: 'hardware-design/registry/datasheets',
  cad_assets_dir: 'hardware-design/registry/cad-assets',
  components: 'hardware-design/registry/components.json',
  board_file: 'board.yaml',
  gate_file: 'gate.json',
  gate_variant_glob: 'gate-*.json',
  gate_reserved: ['gate-metrics.json', 'gate-waivers.json']
}

export class ProjectError extends Error {}

const text = z.string().nullable().default(null)
const BoardFile = z.strictObject({
  schema: z.literal('pcbstudio.board.v1').default('pcbstudio.board.v1'),
  id: z.string(),
  lifecycle: z.string(),
  kind: text,
  variant_of: text,
  revisions: z.array(z.strictObject({
    rev: z.string().nullable(),
    state: text, pcb: text, sch: text, spec: text, bom: text, gate: text, pipeline: text,
    gates: z.array(z.strictObject({ name: z.string(), config: z.string().default('gate.json') })).default([])
  })).default([])
})

interface RegistryRevision { revision?: string, state?: string, project?: string, spec?: string, bom?: string, gate?: string }
interface RegistryBoard { id?: string, directory?: string, lifecycle?: string, kind?: string, variant_of?: string,
                          revision?: string, revisions?: RegistryRevision[] }
interface Registry { boards?: RegistryBoard[], excluded_directories?: string[] }

const isFile = (p: string): boolean => { try { return fs.statSync(p).isFile() } catch { return false } }
const isDir = (p: string): boolean => { try { return fs.statSync(p).isDirectory() } catch { return false } }
const lexical = (a: string, b: string): number => a < b ? -1 : a > b ? 1 : 0

/** Text of a value in a message, as the Python engine writes it. */
const show = (x: string | null | undefined): string => x ?? 'None'
const repr = (x: string | null): string => x === null ? 'None' : `'${x}'`

/** Absolute path with symlinks resolved one part at a time; the parts that do not exist are kept. Not path.resolve,
 *  which removes `..` before it knows whether the part before it is a link. */
export function resolveReal(start: string): string {
  let cur = path.parse(start).root
  for (const part of start.split(path.sep)) {
    if (part === '' || part === '.') continue
    if (part === '..') { cur = path.dirname(cur); continue }
    const next = path.join(cur, part)
    try { cur = fs.realpathSync(next) } catch { cur = next }
  }
  return cur
}

const within = (base: string, rel: string): string => path.isAbsolute(rel) ? rel : base + path.sep + rel

function expandHome(p: string): string {
  return p === '~' || p.startsWith('~/') ? path.join(os.homedir(), p.slice(1)) : p
}

function variantOf(config: string): string | null {
  const stem = config.endsWith('.json') ? config.slice(0, -'.json'.length) : config
  return stem.startsWith('gate-') ? stem.slice('gate-'.length) : null
}

/** Every *.kicad_pcb below DIR/cad at any depth, by path part. Links to folders are not followed. */
function cadBoards(dir: string): string[] {
  const out: string[] = []
  const walk = (folder: string): void => {
    let entries: fs.Dirent[]
    try { entries = fs.readdirSync(folder, { withFileTypes: true }) } catch { return }
    for (const e of entries) {
      const p = path.join(folder, e.name)
      if (e.isDirectory()) walk(p)
      else if (e.name.endsWith('.kicad_pcb')) out.push(p)
    }
  }
  walk(path.join(dir, 'cad'))
  const parts = (p: string): string[] => p.split(path.sep)
  return out.sort((a, b) => {
    const x = parts(a), y = parts(b)
    for (let i = 0; i < Math.min(x.length, y.length); i++) if (x[i] !== y[i]) return lexical(x[i], y[i])
    return x.length - y.length
  })
}

function globName(name: string, glob: string): boolean {
  const body = glob.split('*').map(s => s.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('.*')
  return new RegExp(`^${body}$`, 's').test(name)
}

const newRevision = (r: Partial<Revision>): Revision => ({
  revision: null, state: null, pcb: null, sch: null, spec: null, bom: null, gate: null, gates: [], pipeline: null, ...r
})

export class Project {
  readonly root: string
  readonly layout: ProjectLayout
  readonly identityDir: string | null
  conflicts: IdentityConflict[] = []

  /** identityDir: read board.yaml files from `<identityDir>/<DIR>/board.yaml` in place of the board folders (a
   *  migrate output checked before it is copied into the project). */
  constructor(root: string, layout: Partial<ProjectLayout> = {}, identityDir: string | null = null) {
    this.root = resolveReal(path.resolve(expandHome(root)))
    this.layout = { ...DEFAULT_LAYOUT, ...layout }
    if (!isDir(path.join(this.root, this.layout.boards_dir))) {
      throw new ProjectError(`not a hardware project (no ${this.layout.boards_dir}/): ${this.root}`)
    }
    this.identityDir = identityDir ? resolveReal(path.resolve(expandHome(identityDir))) : null
  }

  get boardsPath(): string { return path.join(this.root, this.layout.boards_dir) }

  /** A layout path (project-relative) as an absolute path, unchecked. */
  path(rel: string): string { return path.join(this.root, rel) }

  private inside(p: string): boolean { return p.startsWith(this.root + path.sep) }

  /** A project-relative path; refuses anything outside the project root. */
  resolve(rel: string): string {
    const p = resolveReal(within(this.root, rel))
    if (p !== this.root && !this.inside(p)) throw new ProjectError(`path outside the project: ${rel}`)
    return p
  }

  rel(p: string): string { return path.relative(this.root, resolveReal(p)) }

  /** Project-relative path of `base/rel` when it is a file inside the project, else null. */
  existing(base: string, rel: string | null | undefined): string | null {
    if (!rel) return null
    const p = resolveReal(within(base, rel))
    return this.inside(p) && isFile(p) ? this.rel(p) : null
  }

  boardFile(directory: string): string {
    return path.join(this.identityDir ?? this.boardsPath, directory, this.layout.board_file)
  }

  info(): ProjectInfo {
    const boards = this.boards()
    return { root: this.root, boards, conflicts: [...this.conflicts] }
  }

  boards(): Board[] {
    this.conflicts = []
    const out = this.legacyBoards().map(b => {
      if (b.identity === 'registry-variant') return b
      const f = this.boardFile(b.directory)
      return isFile(f) ? this.fromBoardFile(b.directory, f) : b
    })
    // A board.yaml in a folder the legacy rules do not list as a board (gate-only folder, new folder).
    const known = new Set(out.map(b => b.directory))
    for (const d of this.folders()) {
      const name = path.basename(d)
      if (!known.has(name) && isFile(this.boardFile(name))) out.push(this.fromBoardFile(name, this.boardFile(name)))
    }
    return out.sort((a, b) => lexical(a.directory, b.directory))
  }

  revisionForPcb(pcbRel: string): [Board, Revision] | null {
    for (const b of this.boards()) {
      for (const r of b.revisions) if (r.pcb === pcbRel) return [b, r]
    }
    return null
  }

  private registry(): Registry {
    const f = this.path(this.layout.registry)
    return isFile(f) ? JSON.parse(fs.readFileSync(f, 'utf8')) as Registry : {}
  }

  private folders(): string[] {
    const excluded = new Set(this.registry().excluded_directories ?? [])
    return fs.readdirSync(this.boardsPath).sort(lexical)
      .filter(n => !n.startsWith('_') && !n.startsWith('.') && !excluded.has(n))
      .map(n => path.join(this.boardsPath, n))
      .filter(isDir)
  }

  private gateConfigs(d: string): string[] {
    const main = path.join(d, this.layout.gate_file)
    const variants = fs.readdirSync(d).sort(lexical)
      .filter(n => globName(n, this.layout.gate_variant_glob) && !this.layout.gate_reserved.includes(n))
      .map(n => path.join(d, n))
    return [...(isFile(main) ? [main] : []), ...variants]
  }

  private gatePcb(d: string, cfg: string): string | null {
    const name = path.basename(d)
    let data: unknown
    try {
      data = JSON.parse(fs.readFileSync(cfg, 'utf8'))
    } catch {
      this.conflict(name, 'gate_unreadable', `${this.rel(cfg)} is not valid JSON`)
      return null
    }
    const proj = data !== null && typeof data === 'object' ? (data as { project?: unknown }).project : undefined
    if (typeof proj !== 'string' || !proj) {
      this.conflict(name, 'gate_no_project', `${this.rel(cfg)} names no project`)
      return null
    }
    return this.existing(d, proj + '.kicad_pcb')
  }

  private conflict(board: string | null | undefined, kind: string, message: string): void {
    this.conflicts.push({ board: board ?? null, kind, message })
  }

  /** The "pipeline" key of the gate's gate.json, when that file exists. */
  private pipeline(gate: string | null): string | null {
    if (!gate) return null
    let data: unknown
    try {
      data = JSON.parse(fs.readFileSync(path.join(this.boardsPath, gate, this.layout.gate_file), 'utf8'))
    } catch { return null }
    const name = data !== null && typeof data === 'object' ? (data as { pipeline?: unknown }).pipeline : undefined
    return typeof name === 'string' ? this.existing(this.root, name) : null
  }

  private legacyBoards(): Board[] {
    const reg = this.registry()
    const excluded = reg.excluded_directories ?? []
    const entries = new Map((reg.boards ?? []).filter(b => b.directory).map(b => [b.directory!, b]))
    const folders = this.folders()
    const gatesByDir = new Map(folders.map(d => [path.basename(d), this.gateConfigs(d).map((c): [GateRef, string | null] => {
      const config = path.basename(c)
      return [{ name: path.basename(d), config, variant: variantOf(config) }, this.gatePcb(d, c)]
    })]))

    const gateOnly = (d: string): boolean => {
      const name = path.basename(d), e = entries.get(name)
      if (e?.kind === 'gate-only') return true
      const gs = gatesByDir.get(name)!
      return gs.length > 0 && !e?.revisions?.length && !cadBoards(d).length &&
             gs.every(([, pcb]) => pcb && !pcb.startsWith(this.rel(d) + '/'))
    }

    const boards: Board[] = []
    const registryGate = new Map<Revision, string | undefined>()
    const names = new Set(folders.map(d => path.basename(d)))
    for (const b of reg.boards ?? []) {
      if (!b.directory && b.kind === 'variant' && b.id && b.variant_of) {
        // A virtual variant has no independent board directory or CAD. Keep
        // its registry identity visible without inventing a filesystem folder.
        if (names.has(b.id)) {
          this.conflict(b.id, 'registry_variant_folder_collision', 'virtual variant ID also names a physical board folder')
          continue
        }
        boards.push({ id: b.id, directory: b.id, lifecycle: b.lifecycle || 'unregistered', kind: b.kind,
                      variant_of: b.variant_of, identity: 'registry-variant', revisions: [] })
        continue
      }
      if (!b.directory || (!names.has(b.directory) && !excluded.includes(b.directory))) {
        this.conflict(b.id, 'registry_no_folder', `registry board ${show(b.id)} has no board folder; not listed`)
      }
    }
    for (const d of folders) {
      const name = path.basename(d)
      if (gateOnly(d)) {
        continue
      }
      const e = entries.get(name)
      if (!e && cadBoards(d).length) this.conflict(name, 'unregistered_board', `${name} has CAD but no registry entry (lifecycle unregistered)`)
      const revs: Revision[] = []
      let named = false
      for (const r of e?.revisions ?? []) {
        const proj = r.project
        const pcb = proj ? this.existing(d, proj + '.kicad_pcb') : null
        named ||= pcb !== null
        const schematicPendingLayout = r.state === 'schematic-pending-layout' && r.gate == null &&
          proj && this.existing(d, proj + '.kicad_sch') !== null
        if (proj && !pcb && !schematicPendingLayout) this.conflict(name, 'registry_pcb_missing', `rev ${show(r.revision)}: ${proj}.kicad_pcb does not exist`)
        const bom = this.existing(d, r.bom)
        if (r.bom && !bom) this.conflict(name, 'registry_bom_missing', `rev ${show(r.revision)}: ${r.bom} does not exist`)
        const rev = newRevision({ revision: r.revision ?? null, state: r.state ?? null, pcb,
                                  sch: proj ? this.existing(d, proj + '.kicad_sch') : null,
                                  spec: this.existing(d, r.spec), bom })
        registryGate.set(rev, r.gate)
        revs.push(rev)
      }
      // Files the registry does not name show only for a board without a registered PCB (candidate and placement
      // copies beside a registered revision are not revisions).
      if (!named) {
        for (const pcb of cadBoards(d)) {
          if (path.relative(d, pcb).split(path.sep).some(part => part.startsWith('.'))) continue
          if (e?.revisions?.length) {
            this.conflict(name, 'unregistered_native_revision',
              `${this.rel(pcb)} is native CAD not assigned to a registry revision; review before promoting board.yaml`)
          }
          revs.push(newRevision({ state: 'unregistered', pcb: this.rel(pcb),
                                  sch: this.existing(path.dirname(pcb), path.basename(pcb, '.kicad_pcb') + '.kicad_sch') }))
        }
      }
      boards.push({ id: e?.id ?? name, directory: name, lifecycle: e?.lifecycle || 'unregistered', kind: e?.kind ?? null,
                    variant_of: e?.variant_of ?? null, identity: 'legacy', revisions: revs })
    }

    // Attach gates by PCB path.
    const byPcb = new Map<string, Revision>()
    for (const b of boards) for (const r of b.revisions) if (r.pcb) byPcb.set(r.pcb, r)
    const byDir = new Map(boards.map(b => [b.directory, b]))
    const prefix = this.layout.boards_dir.replace(/\/+$/, '') + '/'
    for (const d of folders) {
      const name = path.basename(d)
      for (const [g, pcb] of gatesByDir.get(name)!) {
        if (pcb === null) {
          this.conflict(name, 'gate_pcb_missing', `${g.name}/${g.config}: its project has no .kicad_pcb`)
          continue
        }
        if (!byPcb.has(pcb)) {
          const owner = pcb.startsWith(prefix) ? byDir.get(pcb.slice(prefix.length).split('/')[0]) : undefined
          if (!owner) {
            this.conflict(name, 'gate_no_board', `${g.name}/${g.config} checks ${pcb}, which is in no board folder`)
            continue
          }
          const rev = newRevision({ revision: entries.get(name)?.revision ?? null, state: 'unregistered', pcb,
                                    sch: this.existing(this.root, pcb.slice(0, -'.kicad_pcb'.length) + '.kicad_sch') })
          owner.revisions.push(rev)
          byPcb.set(pcb, rev)
          this.conflict(owner.directory, 'gate_unregistered_revision', `${g.name}/${g.config} checks ${pcb}, which the registry does not list`)
        }
        byPcb.get(pcb)!.gates.push(g)
      }
    }

    for (const b of boards) {
      for (const r of b.revisions) {
        const key = (g: GateRef): [number, number, string, string] =>
          [g.config !== this.layout.gate_file ? 1 : 0, g.name !== b.directory ? 1 : 0, g.name, g.config]
        r.gates.sort((x, y) => {
          const a = key(x), c = key(y)
          return (a[0] - c[0]) || (a[1] - c[1]) || lexical(a[2], c[2]) || lexical(a[3], c[3])
        })
        r.gate = r.gates.find(g => g.config === this.layout.gate_file)?.name ?? null
        r.pipeline = this.pipeline(r.gate)
        const rg = registryGate.get(r)
        if (rg && rg !== r.gate) {
          this.conflict(b.directory, 'registry_gate_differs',
                        `rev ${show(r.revision)}: registry gate ${repr(rg)}, gate.json gives ${repr(r.gate)} (gate.json wins)`)
        } else if (!rg && r.gate && registryGate.has(r)) {
          this.conflict(b.directory, 'registry_gate_missing', `rev ${show(r.revision)}: registry has no gate, gate.json gives ${repr(r.gate)}`)
        }
      }
    }
    return boards
  }

  private fromBoardFile(directory: string, f: string): Board {
    let bf: z.infer<typeof BoardFile>
    try {
      bf = BoardFile.parse(yaml.load(fs.readFileSync(f, 'utf8')) ?? {})
    } catch (e) {
      throw new ProjectError(`${f}: ${e instanceof Error ? e.message : String(e)}`)
    }
    const d = path.join(this.boardsPath, directory)
    const revisions = bf.revisions.map(r => {
      const gates = r.gates.map((g): GateRef => ({ name: g.name, config: g.config, variant: variantOf(g.config) }))
      const pcb = this.existing(d, r.pcb)
      for (const [name, raw] of [['pcb', r.pcb], ['sch', r.sch], ['spec', r.spec], ['bom', r.bom]] as const) {
        if (raw && !this.existing(d, raw)) this.conflict(directory, `board_yaml_${name}_missing`, `rev ${show(r.rev)}: ${raw} does not exist`)
      }
      for (const g of gates) {
        const cfg = path.join(this.boardsPath, g.name, g.config)
        const got = isFile(cfg) ? this.gatePcb(path.dirname(cfg), cfg) : null
        if (got !== pcb) this.conflict(directory, 'board_yaml_gate_mismatch', `rev ${show(r.rev)}: gate ${g.name}/${g.config} checks ${show(got)}, not ${show(pcb)}`)
      }
      if (r.gate && !gates.some(g => g.config === this.layout.gate_file && g.name === r.gate)) {
        this.conflict(directory, 'board_yaml_gate_unlisted', `rev ${show(r.rev)}: gate ${r.gate} is not in gates`)
      }
      return newRevision({ revision: r.rev, state: r.state, pcb, sch: this.existing(d, r.sch), spec: this.existing(d, r.spec),
                           bom: this.existing(d, r.bom), gate: r.gate, gates, pipeline: this.existing(this.root, r.pipeline) })
    })
    return { id: bf.id, directory, lifecycle: bf.lifecycle, kind: bf.kind, variant_of: bf.variant_of, identity: 'board.yaml', revisions }
  }
}

export interface BoardFileText {
  schema: string, id: string, lifecycle: string, kind?: string | null, variant_of?: string | null, revisions: Record<string, unknown>[]
}

/** The board.yaml content that reproduces `b` (paths relative to the board folder). */
export function boardFileFor(project: Project, b: Board): BoardFileText {
  const d = resolveReal(path.join(project.boardsPath, b.directory)), bp = resolveReal(project.boardsPath)
  const rel = (p: string | null): string | null => {
    if (!p) return null
    const ap = resolveReal(path.join(project.root, p))
    return ap.startsWith(d + path.sep) ? path.relative(d, ap) : path.join('..', path.relative(bp, ap))
  }
  return {
    schema: 'pcbstudio.board.v1', id: b.id, lifecycle: b.lifecycle, kind: b.kind, variant_of: b.variant_of,
    revisions: b.revisions.map(r => ({ rev: r.revision, state: r.state, pcb: rel(r.pcb), sch: rel(r.sch), spec: rel(r.spec), bom: rel(r.bom),
                                       gate: r.gate, gates: r.gates.map(g => ({ name: g.name, config: g.config })), pipeline: r.pipeline }))
  }
}

/** board.yaml text: empty fields left out, default gate config left out. */
export function dumpBoardFile(bf: BoardFileText): string {
  const revisions = bf.revisions.map(r => {
    const out: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(r)) {
      if (k === 'gates' && Array.isArray(v) && v.length) {
        out.gates = (v as { name: string, config: string }[]).map(g => g.config === 'gate.json' ? { name: g.name } : g)
      } else if (k === 'rev' || (v !== null && !(Array.isArray(v) && !v.length))) {
        out[k] = v
      }
    }
    return out
  })
  const data: Record<string, unknown> = { schema: bf.schema, id: bf.id, lifecycle: bf.lifecycle }
  if (bf.kind !== null && bf.kind !== undefined) data.kind = bf.kind
  if (bf.variant_of !== null && bf.variant_of !== undefined) data.variant_of = bf.variant_of
  data.revisions = revisions
  return yaml.dump(data, { lineWidth: -1, noRefs: true })
}
