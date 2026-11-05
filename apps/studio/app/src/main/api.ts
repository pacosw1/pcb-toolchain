import { liveRuns, liveEvents, liveState, liveGeometry, watchLive, stopLive } from './live.ts'
import { specification } from './spec.ts'
import { exportSchematic } from './kicad/schematic.ts'
import { batchGlb } from './kicad/glb.ts'
import { nativeInventory } from './kicad/inventory.ts'
import { inspectBoard } from './kicad/inspector.ts'
// Engine API methods. The desktop app, the agent and the web viewer call the same registry.
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
registry.method('board.inventory', ['pcb'], 1, (pcb: string) => {
  const p = needProject(), revision = p.revisionForPcb(pcb)?.[1]
  if (!revision) throw new Error('Select a registered board revision')
  return nativeInventory(p.root, pcb, revision.sch)
})

registry.method('board.schematic', ['pcb', 'out_dir'], 2, (pcb: string, outDir: string) => {
  const p = needProject(), schematic = p.revisionForPcb(pcb)?.[1].sch
  if (!schematic) throw new Error('No schematic is assigned to this board revision.')
  return exportSchematic(p.root, schematic, expandHome(outDir))
})

registry.method('board.spec', ['pcb'], 1, (pcb: string) => specification(needProject(), pcb))

registry.method('board.inspect', ['pcb'], 1, (pcb: string) => inspectBoard(needProject().resolve(pcb), pcb))

registry.method('board.parts', ['pcb'], 1, (pcb: string) => boardParts(needProject(), pcb))

/** Part record of a C-number from the parts index: datasheets with sha256, MPN, CAD asset, evidence. */
registry.method('part.get', ['c_number'], 1, (c: string) => indexFor(needProject()).part(c))

/** Build the parts index if its inputs changed (else reuse it) and return its coverage counts. */
registry.method('parts.index', [], 0, () => indexFor(needProject()).ensure())

/** 3D model (binary glTF) of a board with its part models; cached by the board file hash. */
registry.method('board.glb', ['pcb', 'out_dir'], 2, async (pcb: string, outDir: string) => {
  const p = needProject(), file = p.resolve(pcb)
  const digest = createHash('sha256').update(fs.readFileSync(file)).digest('hex').slice(0, 20)
  const raw = path.join(expandHome(outDir), `${path.parse(file).name}-${digest}.glb`)
  const out = raw.replace(/\.glb$/, '-view-v1.glb')
  const size = fs.existsSync(out) && fs.statSync(out).isFile() ? fs.statSync(out).size : 0
  if (size > 0) return { path: out, cached: true, size }
  const cached = fs.existsSync(raw) && fs.statSync(raw).size > 0
  if (!cached) await exportGlb(file, raw, { defines: { IOT_LAB: p.root, KIPRJMOD: path.dirname(file) } })
  const optimized = batchGlb(fs.readFileSync(raw))
  const temporary = out + '.' + process.pid + '.tmp'
  fs.writeFileSync(temporary, optimized.bytes)
  fs.renameSync(temporary, out)
  return { path: out, cached, size: optimized.bytes.length }
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

interface ShortPolicy { iters?: number, timeout_s?: number, keep?: string, layers?: string[], nets?: string[] }

/** `tools/pcb route BOARD --router iotroute --spec POLICY.json`: iotroute on an isolated candidate, then the complete
 *  fresh gate on it. `policy` is a full iot-lab.iotroute-policy.v1 object, or the short form {iters?, timeout_s?, keep?, layers?, nets?}.
 *  The third argument `timeout_s` is the total CLI deadline (router + verification), default router time + 600 s. */
registry.method('op.route', ['board', 'policy', 'timeout_s'], 2, (board: string, given: ShortPolicy | RoutingPolicy, timeoutS?: number | null) => {
  const p = needProject()
  let policy: RoutingPolicy
  if ('schema' in given) {
    policy = given
  } else {
    policy = routingPolicy(Math.trunc(given.iters ?? 80), Math.trunc(given.timeout_s ?? 300), given.keep ?? 'lock-nets', given.layers, given.nets)
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

registry.method('live.runs', [], 0, liveRuns)
registry.method('live.events', ['run', 'after'], 1, liveEvents)
registry.method('live.state', ['run', 'at'], 1, liveState)
registry.method('live.geometry', ['sha'], 1, liveGeometry)

registry.method('live.watch', ['run', 'after'], 1, (run: string, after?: number) => watchLive(currentClient(), run, after))
registry.method('live.unwatch', [], 0, () => stopLive(currentClient()))
