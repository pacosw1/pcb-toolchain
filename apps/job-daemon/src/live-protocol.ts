/** Observer-only wire contract. Geometry is mm/degrees in KiCad board coordinates. */
export type Point = [number, number]
export interface LiveTrack { id: string; net: string; layer: string; a: Point; b: Point; width: number; locked: boolean }
export interface LiveVia { id: string; net: string; at: Point; diameter: number; drill: number; layers: string[]; locked: boolean }
export interface LivePlacement { ref: string; x: number; y: number; rotation: number; locked: boolean }
export interface LiveFailure {
  id: string; net: string; reason: string; rule?: string
  region: [number, number, number, number]
  blockers: { id: string; ref?: string; net?: string; region: [number, number, number, number] }[]
  rejectedPath: Point[]
}
export interface LivePlacementFrame {
  worker: number; epoch: number; step: number; accepted: number; rejected: number
  currentCost: number; bestCost: number; bestScope: 'attempt' | 'epoch'
  current: LivePlacement[]; best: LivePlacement[]; terms: Record<string, number>
}
export interface LiveDelta {
  addTracks: LiveTrack[]; removeTracks: string[]; addVias: LiveVia[]; removeVias: string[]
}
export type LivePayload =
  | { kind: 'run.started'; data: { project: string; board: string; host: string; operation: 'placement' | 'routing' | 'build'; label: string } }
  | { kind: 'board.snapshot'; data: { blobSha256: string; path: string; phase: 'placement' | 'routing'; includesBaseCopper: boolean } }
  | { kind: 'placement.frame'; data: LivePlacementFrame }
  | { kind: 'route.delta'; data: LiveDelta }
  | { kind: 'route.activity'; data: { net: string; pass: number; action: 'searching' | 'accepted' | 'ripup' | 'rejected'; path: Point[] } }
  | { kind: 'route.failure'; data: LiveFailure }
  | { kind: 'progress'; data: { stage: string; elapsedMs: number; message: string; metrics: Record<string, number> } }
  | { kind: 'checkpoint'; data: { label: string; best: boolean } }
  | { kind: 'run.finished'; data: { outcome: 'passed' | 'failed' | 'cancelled'; message: string; candidateSha256?: string; verified: boolean } }
export type LiveEvent = { schema: 'pcb-live.v1'; runId: string; attemptId: string; seq: number; timeMs: number; baseSha256: string } & LivePayload

const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value)
const text = (value: unknown, max = 512): value is string => typeof value === 'string' && value.length <= max && !/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(value)
const number = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value)
const integer = (value: unknown): value is number => number(value) && Number.isSafeInteger(value) && value >= 0
export const isDigest = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value)
const point = (value: unknown): boolean => Array.isArray(value) && value.length === 2 && value.every(number)
const region = (value: unknown): boolean => Array.isArray(value) && value.length === 4 && value.every(number) && value[0] <= value[2] && value[1] <= value[3]
const array = (value: unknown, check: (v: unknown) => boolean, max = 100_000): boolean => Array.isArray(value) && value.length <= max && value.every(check)
const metrics = (value: unknown): boolean => record(value) && Object.keys(value).length <= 128 && Object.entries(value).every(([key, v]) => text(key, 128) && number(v))
const placement = (v: unknown): boolean => record(v) && text(v.ref) && !!v.ref && number(v.x) && number(v.y) && number(v.rotation) && typeof v.locked === 'boolean'
const track = (v: unknown): boolean => record(v) && text(v.id) && !!v.id && text(v.net) && text(v.layer) && point(v.a) && point(v.b) && number(v.width) && v.width > 0 && typeof v.locked === 'boolean'
const via = (v: unknown): boolean => record(v) && text(v.id) && !!v.id && text(v.net) && point(v.at) && number(v.diameter) && number(v.drill) && v.drill > 0 && v.diameter >= v.drill && array(v.layers, x => text(x), 64) && typeof v.locked === 'boolean'
const unique = (rows: unknown, key: string): boolean => Array.isArray(rows) && new Set(rows.map(v => (v as Record<string, unknown>)[key])).size === rows.length

/** Fail closed at ingress rather than let malformed events corrupt a replay. */
export function validateLiveEvent(value: unknown): asserts value is LiveEvent {
  if (!record(value) || value.schema !== 'pcb-live.v1' || !text(value.runId) || !value.runId || !text(value.attemptId) || !value.attemptId ||
      !integer(value.seq) || value.seq < 1 || !number(value.timeMs) || value.timeMs < 0 || !isDigest(value.baseSha256) || !record(value.data)) throw new Error('Invalid live event envelope')
  const d = value.data
  let valid = false
  switch (value.kind) {
    case 'run.started': valid = text(d.project) && !!d.project && text(d.board) && !!d.board && text(d.host) && text(d.label) && ['placement', 'routing', 'build'].includes(String(d.operation)); break
    case 'board.snapshot': valid = isDigest(d.blobSha256) && d.blobSha256 === value.baseSha256 && text(d.path) && ['placement', 'routing'].includes(String(d.phase)) && typeof d.includesBaseCopper === 'boolean'; break
    case 'placement.frame': valid = [d.worker, d.epoch, d.step, d.accepted, d.rejected].every(integer) && number(d.currentCost) && number(d.bestCost) && ['attempt', 'epoch'].includes(String(d.bestScope)) && array(d.current, placement, 20_000) && array(d.best, placement, 20_000) && unique(d.current, 'ref') && unique(d.best, 'ref') && metrics(d.terms); break
    case 'route.delta': valid = array(d.addTracks, track) && array(d.addVias, via) && array(d.removeTracks, x => text(x)) && array(d.removeVias, x => text(x)) && unique(d.addTracks, 'id') && unique(d.addVias, 'id'); break
    case 'route.activity': valid = text(d.net) && integer(d.pass) && ['searching', 'accepted', 'ripup', 'rejected'].includes(String(d.action)) && array(d.path, point, 20_000); break
    case 'route.failure': valid = text(d.id) && !!d.id && text(d.net) && text(d.reason, 4096) && (d.rule === undefined || text(d.rule, 4096)) && region(d.region) && array(d.rejectedPath, point, 20_000) && array(d.blockers, b => record(b) && text(b.id) && region(b.region) && (b.ref === undefined || text(b.ref)) && (b.net === undefined || text(b.net)), 10_000); break
    case 'progress': valid = text(d.stage) && number(d.elapsedMs) && d.elapsedMs >= 0 && text(d.message, 4096) && metrics(d.metrics); break
    case 'checkpoint': valid = text(d.label) && typeof d.best === 'boolean'; break
    case 'run.finished': valid = ['passed', 'failed', 'cancelled'].includes(String(d.outcome)) && text(d.message, 4096) && typeof d.verified === 'boolean' && (!d.verified || (d.outcome === 'passed' && isDigest(d.candidateSha256))) && (d.candidateSha256 === undefined || isDigest(d.candidateSha256)); break
  }
  if (!valid) throw new Error(`Invalid live payload: ${String(value.kind)}`)
}

export interface LiveState {
  runId: string; seq: number; timeMs: number; baseSha256: string; attemptId: string
  run: Extract<LivePayload, { kind: 'run.started' }>['data'] | null
  board: Extract<LivePayload, { kind: 'board.snapshot' }>['data'] | null
  placement: LivePlacementFrame | null
  previousPlacement: LivePlacement[]
  tracks: Map<string, LiveTrack>; vias: Map<string, LiveVia>
  removedTracks: LiveTrack[]; removedVias: LiveVia[]; addedTrackIds: string[]
  activity: Extract<LivePayload, { kind: 'route.activity' }>['data'] | null
  failures: LiveFailure[]
  progress: Extract<LivePayload, { kind: 'progress' }>['data'] | null
  checkpoints: { seq: number; timeMs: number; label: string; best: boolean }[]
  finished: Extract<LivePayload, { kind: 'run.finished' }>['data'] | null
}
export function emptyLiveState(runId: string): LiveState {
  return { runId, seq: 0, timeMs: 0, baseSha256: '', attemptId: '', run: null, board: null, placement: null, previousPlacement: [], tracks: new Map(), vias: new Map(), removedTracks: [], removedVias: [], addedTrackIds: [], activity: null, failures: [], progress: null, checkpoints: [], finished: null }
}

/** Deterministic state reducer shared by live playback, historical replay and verification. */
export function applyLiveEvent(state: LiveState, event: LiveEvent): void {
  validateLiveEvent(event)
  if (state.runId !== event.runId) throw new Error('Live event belongs to another run')
  if (event.seq !== state.seq + 1) throw new Error(`Live sequence gap: expected ${state.seq + 1}, received ${event.seq}`)
  if (state.finished) throw new Error('Live run is already terminal')
  if (state.seq === 0 && event.kind !== 'run.started') throw new Error('Live run must begin with run.started')
  if (state.seq > 0 && event.kind === 'run.started') throw new Error('Live run already started')
  if (state.seq > 0 && state.baseSha256 !== event.baseSha256 && event.kind !== 'board.snapshot') throw new Error('Live base revision mismatch')
  if (['placement.frame', 'route.delta', 'route.activity', 'route.failure'].includes(event.kind) && !state.board) throw new Error('Live geometry requires a board snapshot')
  if (event.timeMs < state.timeMs) throw new Error('Live time moved backwards')
  if (event.kind === 'run.started') state.run = structuredClone(event.data)
  else if (event.kind === 'board.snapshot') {
    state.board = structuredClone(event.data); state.placement = null; state.previousPlacement = []
    state.tracks.clear(); state.vias.clear(); state.removedTracks = []; state.removedVias = []; state.addedTrackIds = []; state.activity = null; state.failures = []
  } else if (event.kind === 'placement.frame') {
    state.previousPlacement = state.placement?.current ?? []
    state.placement = structuredClone(event.data)
  } else if (event.kind === 'route.delta') {
    // Validate the whole transition before touching state: rejected deltas are atomic.
    for (const id of event.data.removeTracks) if (!state.tracks.has(id)) throw new Error(`Unknown removed track ${id}`)
    for (const id of event.data.removeVias) if (!state.vias.has(id)) throw new Error(`Unknown removed via ${id}`)
    for (const item of event.data.addTracks) if (state.tracks.has(item.id) && !event.data.removeTracks.includes(item.id)) throw new Error(`Duplicate track ${item.id}`)
    for (const item of event.data.addVias) if (state.vias.has(item.id) && !event.data.removeVias.includes(item.id)) throw new Error(`Duplicate via ${item.id}`)
    state.removedTracks = event.data.removeTracks.map(id => state.tracks.get(id)!)
    state.removedVias = event.data.removeVias.map(id => state.vias.get(id)!)
    state.addedTrackIds = event.data.addTracks.map(t => t.id)
    for (const id of event.data.removeTracks) state.tracks.delete(id)
    for (const id of event.data.removeVias) state.vias.delete(id)
    for (const item of event.data.addTracks) state.tracks.set(item.id, structuredClone(item))
    for (const item of event.data.addVias) state.vias.set(item.id, structuredClone(item))
  } else if (event.kind === 'route.activity') state.activity = structuredClone(event.data)
  else if (event.kind === 'route.failure') state.failures = [...state.failures.filter(f => f.id !== event.data.id), structuredClone(event.data)].slice(-200)
  else if (event.kind === 'progress') state.progress = structuredClone(event.data)
  else if (event.kind === 'checkpoint') state.checkpoints.push({ seq: event.seq, timeMs: event.timeMs, ...event.data })
  else if (event.kind === 'run.finished') state.finished = structuredClone(event.data)
  state.seq = event.seq; state.timeMs = event.timeMs; state.baseSha256 = event.baseSha256; state.attemptId = event.attemptId
}

export function replayLiveEvents(runId: string, events: readonly LiveEvent[], through = Infinity): LiveState {
  const state = emptyLiveState(runId)
  for (const event of events) { if (event.seq > through) break; applyLiveEvent(state, event) }
  return state
}
