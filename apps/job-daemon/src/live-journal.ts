import { DatabaseSync } from 'node:sqlite'
import { createHash } from 'node:crypto'
import { applyLiveEvent, emptyLiveState, SEQUENCE_REUSED, validateLiveEvent } from './live-protocol.ts'
import type { LiveEvent, LiveState, LiveTrack, LiveVia } from './live-protocol.ts'

const MAX_EVENT = 8 * 1024 * 1024
function canonical(value: unknown): string {
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']'
  if (value && typeof value === 'object') return '{' + Object.entries(value).filter(([, v]) => v !== undefined).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => JSON.stringify(k) + ':' + canonical(v)).join(',') + '}'
  return JSON.stringify(value)
}
const digest = (body: string): string => createHash('sha256').update(body).digest('hex')
export type StoredLiveState = Omit<LiveState, 'tracks' | 'vias'> & { tracks: LiveTrack[]; vias: LiveVia[] }
export function packLiveState(state: LiveState): StoredLiveState {
  return structuredClone({ ...state, tracks: [...state.tracks.values()], vias: [...state.vias.values()] })
}
function unpack(value: StoredLiveState): LiveState { return { ...emptyLiveState(value.runId), ...value, tracks: new Map(value.tracks.map(t => [t.id, t])), vias: new Map(value.vias.map(v => [v.id, v])) } }
function fork(state: LiveState): LiveState { return { ...state, tracks: new Map(state.tracks), vias: new Map(state.vias), checkpoints: [...state.checkpoints] } }
interface Row { body: string; digest: string }
function checked(row: Row): string { if (digest(row.body) !== row.digest) throw new Error('Live journal integrity failure'); return row.body }

/** One durable event order per run. Retried delivery is idempotent; conflicting or missing sequences are rejected. */
export class LiveJournal {
  private readonly db: DatabaseSync
  private readonly cache = new Map<string, LiveState>()
  constructor(file: string) {
    this.db = new DatabaseSync(file)
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA foreign_keys=ON;
      CREATE TABLE IF NOT EXISTS live_runs (run_id TEXT PRIMARY KEY, last_seq INTEGER NOT NULL, updated_at INTEGER NOT NULL, summary TEXT NOT NULL) STRICT;
      CREATE TABLE IF NOT EXISTS live_frames (run_id TEXT NOT NULL, seq INTEGER NOT NULL, body TEXT NOT NULL, digest TEXT NOT NULL,
        PRIMARY KEY(run_id,seq), FOREIGN KEY(run_id) REFERENCES live_runs(run_id)) STRICT;
      CREATE TABLE IF NOT EXISTS live_checkpoints (run_id TEXT NOT NULL, seq INTEGER NOT NULL, body TEXT NOT NULL, digest TEXT NOT NULL,
        PRIMARY KEY(run_id,seq), FOREIGN KEY(run_id) REFERENCES live_runs(run_id)) STRICT;`)
  }
  close(): void { this.cache.clear(); this.db.close() }
  list(): { runId: string; seq: number; updatedAt: number; summary: unknown }[] {
    const rows = this.db.prepare('SELECT * FROM live_runs ORDER BY updated_at DESC LIMIT 200').all() as unknown as { run_id: string; last_seq: number; updated_at: number; summary: string }[]
    return rows.map(r => ({ runId: r.run_id, seq: r.last_seq, updatedAt: r.updated_at, summary: JSON.parse(r.summary) }))
  }
  lastSeq(runId: string): number | null {
    return (this.db.prepare('SELECT last_seq FROM live_runs WHERE run_id=?').get(runId) as { last_seq: number } | undefined)?.last_seq ?? null
  }
  isFinished(runId: string): boolean {
    const row = this.db.prepare('SELECT summary FROM live_runs WHERE run_id=?').get(runId) as { summary: string } | undefined
    return row ? Boolean(JSON.parse(row.summary).finished) : false
  }
  events(runId: string, after = 0, limit = 500): LiveEvent[] {
    if (!Number.isSafeInteger(after) || after < 0 || !Number.isSafeInteger(limit) || limit < 1 || limit > 500) throw new Error('Invalid live event cursor')
    const events: LiveEvent[] = []; let bytes = 0
    for (const raw of this.db.prepare('SELECT body,digest FROM live_frames WHERE run_id=? AND seq>? ORDER BY seq LIMIT ?').iterate(runId, after, limit)) {
      const row = raw as unknown as Row
      bytes += Buffer.byteLength(row.body)
      if (events.length && bytes > 16 * 1024 * 1024) break
      events.push(JSON.parse(checked(row)) as LiveEvent)
    }
    return events
  }
  stateAt(runId: string, through?: number): LiveState {
    const last = this.lastSeq(runId)
    if (last === null) return emptyLiveState(runId)
    const end = through ?? last
    if (!Number.isSafeInteger(end) || end < 0 || end > last) throw new Error('Live seek outside recorded range')
    const cached = this.cache.get(runId)
    if (end === last && cached?.seq === last) return fork(cached)
    const row = this.db.prepare('SELECT body,digest FROM live_checkpoints WHERE run_id=? AND seq<=? ORDER BY seq DESC LIMIT 1').get(runId, end) as unknown as Row | undefined
    const state = row ? unpack(JSON.parse(checked(row)) as StoredLiveState) : emptyLiveState(runId)
    while (state.seq < end) {
      const events = this.events(runId, state.seq, Math.min(500, end - state.seq))
      if (!events.length) throw new Error('Live journal has a missing event')
      for (const event of events) applyLiveEvent(state, event)
    }
    if (end === last) {
      if (this.cache.size >= 32) this.cache.delete(this.cache.keys().next().value!)
      this.cache.set(runId, state)
    }
    return fork(state)
  }
  append(events: LiveEvent[]): { appended: number; cursors: Record<string, number> } {
    if (!Array.isArray(events) || !events.length || events.length > 64) throw new Error('Live batch must contain 1 to 64 events')
    const prepared = events.map(event => {
      validateLiveEvent(event)
      const body = canonical(event)
      if (Buffer.byteLength(body) > MAX_EVENT) throw new Error('Live event exceeds 8 MiB')
      return { event, body, hash: digest(body) }
    })
    const staged = new Map<string, LiveState>(), fresh: typeof prepared = []
    const duplicateKeys = new Map<string, string>()
    // Validate before BEGIN, with private copies. A rejected batch changes neither disk nor memory.
    for (const item of prepared) {
      const { event, body, hash } = item, key = `${event.runId}\0${event.seq}`
      const duplicate = duplicateKeys.get(key)
      if (duplicate !== undefined) { if (duplicate !== body) throw new Error(SEQUENCE_REUSED); continue }
      duplicateKeys.set(key, body)
      const old = this.db.prepare('SELECT body,digest FROM live_frames WHERE run_id=? AND seq=?').get(event.runId, event.seq) as unknown as Row | undefined
      if (old) { if (checked(old) !== body || old.digest !== hash) throw new Error(SEQUENCE_REUSED); continue }
      const state = staged.get(event.runId) ?? this.stateAt(event.runId)
      applyLiveEvent(state, event); staged.set(event.runId, state); fresh.push(item)
    }
    this.db.exec('BEGIN IMMEDIATE')
    try {
      const now = Date.now()
      for (const [runId, state] of staged) {
        const summary = { run: state.run, board: state.board, progress: state.progress, finished: state.finished, baseSha256: state.baseSha256, attemptId: state.attemptId }
        this.db.prepare(`INSERT INTO live_runs VALUES (?,?,?,?) ON CONFLICT(run_id) DO UPDATE SET last_seq=excluded.last_seq,updated_at=excluded.updated_at,summary=excluded.summary`).run(runId, state.seq, now, JSON.stringify(summary))
      }
      for (const item of fresh) this.db.prepare('INSERT INTO live_frames VALUES (?,?,?,?)').run(item.event.runId, item.event.seq, item.body, item.hash)
      for (const [runId, state] of staged) {
        const previous = this.lastCheckpointSeq(runId)
        if (state.seq - previous >= 32 || state.finished || fresh.some(e => e.event.runId === runId && e.event.kind === 'checkpoint')) {
          const body = JSON.stringify(packLiveState(state))
          this.db.prepare('INSERT OR REPLACE INTO live_checkpoints VALUES (?,?,?,?)').run(runId, state.seq, body, digest(body))
        }
      }
      this.db.exec('COMMIT')
    } catch (error) { this.db.exec('ROLLBACK'); throw error }
    for (const [runId, state] of staged) this.cache.set(runId, state)
    const cursors = Object.fromEntries([...new Set(events.map(e => e.runId))].map(id => [id, this.lastSeq(id)!]))
    return { appended: fresh.length, cursors }
  }
  private lastCheckpointSeq(runId: string): number { return (this.db.prepare('SELECT MAX(seq) AS seq FROM live_checkpoints WHERE run_id=?').get(runId) as { seq: number | null }).seq ?? 0 }
}
