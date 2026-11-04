// Engine API methods. The desktop app, the agent and the web viewer call the same registry. Port of
// engine/src/pcbstudio/api.py.
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { unwatchAll, unwatchBoard, watchBoard } from './boardWatch.ts'
import { exportGlb, version as kicadVersion } from './kicad/cli.ts'
import { bbox, load } from './kicad/board.ts'
import { bom, boardParts } from './parts.ts'
import { indexFor } from './partsIndex.ts'
import { Project } from './project.ts'
import { Registry, currentClient } from './rpc.ts'
import { routingPolicy, runs } from './runs.ts'
import type { RoutingPolicy } from './runs.ts'

export const ENGINE_VERSION = '0.1.0'

export const registry = new Registry()
const started = Date.now()
let project: Project | null = null

function needProject(): Project {
  if (!project) throw new Error('no project open')
  return project
}

const lexical = (a: string, b: string): number => a < b ? -1 : a > b ? 1 : 0
const expandHome = (p: string): string => p === '~' || p.startsWith('~/') ? path.join(os.homedir(), p.slice(1)) : p

registry.method('engine.ping', [], 0, () => ({ ok: true, uptime_s: Math.round(Date.now() - started) / 1000 }))

registry.method('engine.info', [], 0, async () => ({
  version: ENGINE_VERSION, node: process.versions.node, methods: registry.names(), kicad_cli: await kicadVersion()
}))

export function projectOpen(root: string): ReturnType<Project['info']> {
  const next = new Project(root)
  if (project && project.root !== next.root) unwatchAll()
  project = next
  runs.load(project.root)                           // runs of earlier engine processes (durable run records)
  return project.info()
}
registry.method('project.open', ['root'], 1, projectOpen)

/** `pcb` is project-relative (as listed by project.open). */
registry.method('board.geometry', ['pcb'], 1, (pcb: string) => {
  const geo = load(needProject().resolve(pcb))
  return { ...geo, bbox: bbox(geo), pcb }
})

/** Watch a board file for this client: board.changed / board.invalid notifications follow (boardWatch.ts). Ends with
 *  board.unwatch or when the client disconnects. Returns the file's hash now. */
registry.method('board.watch', ['pcb'], 1, (pcb: string) => watchBoard(currentClient(), pcb, needProject().resolve(pcb)))

registry.method('board.unwatch', ['pcb'], 1, (pcb: string) => unwatchBoard(currentClient(), pcb))

/** BOM of a board revision joined to that revision's own BOM CSV (`bom` overrides it, project-relative). */
registry.method('board.bom', ['pcb', 'bom'], 1, (pcb: string, csv?: string | null) => bom(needProject(), pcb, csv ?? null))

/** Footprints with the engine's C-number rule, position, rotation and pad count. */
registry.method('board.parts', ['pcb'], 1, (pcb: string) => boardParts(needProject(), pcb))

/** Part record of a C-number from the parts index: datasheets with sha256, MPN, CAD asset, evidence. */
registry.method('part.get', ['c_number'], 1, (c: string) => indexFor(needProject()).part(c))

/** Build the parts index if its inputs changed (else reuse it) and return its coverage counts. */
registry.method('parts.index', [], 0, () => indexFor(needProject()).ensure())

/** 3D model (binary glTF) of a board with its part models; cached by the board file hash. */
registry.method('board.glb', ['pcb', 'out_dir'], 2, async (pcb: string, outDir: string) => {
  const p = needProject(), file = p.resolve(pcb)
  const digest = createHash('sha256').update(fs.readFileSync(file)).digest('hex').slice(0, 20)
  const out = path.join(expandHome(outDir), `${path.parse(file).name}-${digest}.glb`)
  const size = fs.existsSync(out) && fs.statSync(out).isFile() ? fs.statSync(out).size : 0
  if (size > 0) return { path: out, cached: true, size }
  const res = await exportGlb(file, out, { defines: { IOT_LAB: p.root, KIPRJMOD: path.dirname(file) } })
  return { ...res, cached: false }
})

/** Absolute path of a project file (for the app's PDF viewer), refusing anything outside the project. */
registry.method('file.resolve', ['path'], 1, (rel: string) => {
  const p = needProject().resolve(rel)
  let st: fs.Stats | null = null
  try { st = fs.statSync(p) } catch { /* below */ }
  if (!st?.isFile()) throw new Error(`no such file: ${rel}`)
  return { path: p, size: st.size }
})

/** Start `tools/pcb check BOARD` in the project; progress arrives as run.event / run.state notifications. */
registry.method('gate.check', ['board', 'fresh'], 1, (board: string, fresh: boolean = true) =>
  runs.start(needProject().root, 'check', board, { fresh }).summary())

/** `tools/pcb build BOARD`: the board's own pipeline makes an isolated candidate and gates it. Canonical CAD changes
 *  only in run.adopt. */
registry.method('op.build', ['board', 'timeout_s'], 1, (board: string, timeoutS?: number | null) =>
  runs.start(needProject().root, 'build', board, { timeoutS: timeoutS ?? undefined }).summary())

function boardNets(gate: string): string[] {
  const p = needProject()
  const pcbs = p.boards().flatMap(b => b.revisions).filter(r => r.gate === gate && r.pcb).map(r => r.pcb!)
  if (!pcbs.length) throw new Error(`no board revision with gate '${gate}'; pass policy.nets`)
  const nets = load(p.resolve(pcbs[0])).footprints.flatMap(f => f.pads.map(pad => pad.net)).filter(Boolean)
  return [...new Set(nets)].sort(lexical)
}

interface ShortPolicy { layers?: string[], nets?: string[], passes?: number, timeout_s?: number, threads?: number, optimizer?: string }

/** `tools/pcb route BOARD --router fastroute --spec POLICY.json`: Fastroute on an isolated candidate, then the complete
 *  fresh gate on it. `policy` is a full iot-lab.routing-policy.v1 object, or the short form {layers, nets?, passes,
 *  timeout_s, threads?, optimizer?}; no nets = every named net with pads on the board. `timeout_s` is the total CLI
 *  deadline (solver + verification), default router timeout + 600 s. */
registry.method('op.route', ['board', 'policy', 'timeout_s'], 2, (board: string, given: ShortPolicy | RoutingPolicy, timeoutS?: number | null) => {
  const p = needProject()
  let policy: RoutingPolicy
  if ('schema' in given) {
    policy = given
  } else {
    const nets = given.nets?.length ? [...given.nets] : boardNets(board)
    policy = routingPolicy(given.layers?.length ? given.layers : ['F.Cu', 'B.Cu'], nets, Math.trunc(given.passes ?? 40),
                           Math.trunc(given.timeout_s ?? 300), Math.trunc(given.threads ?? 1), given.optimizer ?? 'if-routed')
  }
  return runs.start(p.root, 'route', board, { policy, timeoutS: timeoutS ?? undefined }).summary()
})

/** The candidate board of a build/route run: project-relative `pcb` (load it with board.geometry), the canonical
 *  `target` file adopt would replace, its gate `metrics`, `verified`, and whether run.adopt would be accepted. */
registry.method('run.candidate', ['id'], 1, (id: string) => {
  const r = runs.get(id), c = r.candidate()
  if (!c) throw new Error(`run ${id} has no candidate board (${r.op}, ${r.state})`)
  const why = r.adoptable()
  return { ...c, id, run_id: r.run_id, state: r.state, adoptable: why === null, not_adoptable_because: why, adoption: r.adoption }
})

/** `tools/pcb adopt RUN_ID --json` (desktop only, on a user click; never in the web viewer or the agent). */
registry.method('run.adopt', ['id'], 1, (id: string) => runs.adopt(id))

/** Runs of the open project (this engine's and earlier engines'), oldest first. */
registry.method('run.list', [], 0, () => runs.list(project?.root).map(r => r.summary()))

registry.method('run.get', ['id', 'after'], 1, (id: string, after: number = 0) => {
  const r = runs.get(id)
  return { summary: r.summary(), events: r.events.slice(after), stderr: r.stderr.slice(-50), end: r.end }
})

registry.method('run.findings', ['id'], 1, (id: string) => runs.findings(id, needProject().root))

registry.method('run.cancel', ['id'], 1, (id: string) => runs.cancel(id))
