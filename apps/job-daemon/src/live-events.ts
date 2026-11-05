// Durable, replayable progress records from workers. A source event ID makes retries idempotent.
import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';

export interface LiveInput {
  source: string;
  eventId: string;
  host: string;
  board: string;
  run: string;
  kind: string;
  data: unknown;
}
export interface LiveEvent extends LiveInput { cursor: number; receivedAt: number }

export class LiveEvents {
  private db: DatabaseSync;
  private subscribers = new Set<(event: LiveEvent) => void>();
  private lastSweep = 0;
  readonly epoch: string;
  constructor(file: string) {
    this.db = new DatabaseSync(file);
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;
      CREATE TABLE IF NOT EXISTS live_events (cursor INTEGER PRIMARY KEY AUTOINCREMENT,
        source TEXT NOT NULL, event_id TEXT NOT NULL, host TEXT NOT NULL, board TEXT NOT NULL,
        run TEXT NOT NULL, kind TEXT NOT NULL, data TEXT NOT NULL, received_at INTEGER NOT NULL,
        UNIQUE(source, event_id)) STRICT;
      CREATE TABLE IF NOT EXISTS live_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL) STRICT;
      CREATE TABLE IF NOT EXISTS live_latest (source TEXT NOT NULL, board TEXT NOT NULL, run TEXT NOT NULL,
        kind TEXT NOT NULL, path TEXT NOT NULL, cursor INTEGER NOT NULL,
        PRIMARY KEY(source, board, run, kind, path)) STRICT;
      CREATE INDEX IF NOT EXISTS live_kind_cursor ON live_events(kind, cursor DESC);`);
    this.db.exec(`CREATE TABLE IF NOT EXISTS live_models (
      id TEXT PRIMARY KEY, source TEXT NOT NULL, board TEXT NOT NULL, run TEXT NOT NULL,
      path TEXT NOT NULL, board_sha TEXT NOT NULL, created_at INTEGER NOT NULL,
      status TEXT NOT NULL, model_sha TEXT, error TEXT
    ) STRICT;
    CREATE INDEX IF NOT EXISTS live_models_pending ON live_models(source, status, created_at);`);
    this.db.exec(`CREATE TABLE IF NOT EXISTS live_job_offsets (job TEXT NOT NULL, attempt INTEGER NOT NULL, offset INTEGER NOT NULL,
      PRIMARY KEY(job, attempt)) STRICT;`);
    this.db.exec('CREATE INDEX IF NOT EXISTS live_run_cursor ON live_events(source, board, run, cursor);');
    this.db.exec('CREATE INDEX IF NOT EXISTS live_kind_time ON live_events(kind, received_at);');
    this.db.prepare("INSERT INTO live_meta VALUES ('epoch', ?) ON CONFLICT(key) DO NOTHING").run(randomUUID());
    if (!this.db.prepare("SELECT 1 FROM live_meta WHERE key='latest-v1'").get()) {
      this.db.exec(`BEGIN IMMEDIATE;
        INSERT INTO live_latest (source,board,run,kind,path,cursor)
        SELECT source,board,run,kind,
          CASE WHEN kind IN ('board.snapshot','board.invalid','board.removed','route.preview','placement.preview')
            AND json_type(data,'$.path')='text' THEN json_extract(data,'$.path') ELSE '' END, MAX(cursor)
        FROM live_events GROUP BY source,board,run,kind,
          CASE WHEN kind IN ('board.snapshot','board.invalid','board.removed','route.preview','placement.preview')
            AND json_type(data,'$.path')='text' THEN json_extract(data,'$.path') ELSE '' END
        ON CONFLICT(source,board,run,kind,path) DO UPDATE SET cursor=excluded.cursor;
        INSERT INTO live_meta VALUES ('latest-v1','1'); COMMIT;`);
    }
    this.epoch = (this.db.prepare("SELECT value FROM live_meta WHERE key='epoch'").get() as { value: string }).value;
  }
  append(input: LiveInput): LiveEvent { return this.appendBatch([input])[0]; }
  appendBatch(inputs: LiveInput[]): LiveEvent[] {
    if (!Array.isArray(inputs) || !inputs.length || inputs.length > 20) throw new Error('event batch must contain 1 to 20 events');
    const encoded = inputs.map(input => {
      if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('invalid event');
      for (const field of ['source', 'eventId', 'host', 'board', 'run', 'kind'] as const) {
        const value = input[field];
        if (typeof value !== 'string' || !value || value.length > 512) throw new Error(`invalid ${field}`);
      }
      const data = JSON.stringify(input.data);
      if (data === undefined || Buffer.byteLength(data) > 256 * 1024) throw new Error('invalid event data');
      return { input, data };
    });
    const receivedAt = Date.now();
    this.db.exec('BEGIN IMMEDIATE');
    const events: LiveEvent[] = [], fresh: LiveEvent[] = [];
    try {
      for (const { input, data } of encoded) {
        const result = this.db.prepare(`INSERT INTO live_events (source,event_id,host,board,run,kind,data,received_at)
          VALUES (?,?,?,?,?,?,?,?) ON CONFLICT(source,event_id) DO NOTHING`)
          .run(input.source, input.eventId, input.host, input.board, input.run, input.kind, data, receivedAt);
        if (!result.changes) {
          const prior = this.db.prepare('SELECT * FROM live_events WHERE source=? AND event_id=?').get(input.source, input.eventId) as unknown as Row;
          if (prior.host !== input.host || prior.board !== input.board || prior.run !== input.run || prior.kind !== input.kind || prior.data !== data)
            throw new Error('event ID reused with different content');
          events.push(fromRow(prior)); continue;
        }
        const event = { ...input, cursor: Number(result.lastInsertRowid), receivedAt };
        const value = input.data as { path?: unknown } | null;
        const keyPath = ['board.snapshot', 'board.invalid', 'board.removed', 'route.preview', 'placement.preview'].includes(input.kind) && typeof value?.path === 'string' ? value.path : '';
        this.db.prepare(`INSERT INTO live_latest VALUES (?,?,?,?,?,?) ON CONFLICT(source,board,run,kind,path)
          DO UPDATE SET cursor=excluded.cursor`).run(input.source, input.board, input.run, input.kind, keyPath, event.cursor);
        events.push(event); fresh.push(event);
      }
      this.db.exec('COMMIT');
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
    if (receivedAt - this.lastSweep > 3600_000) {
      this.lastSweep = receivedAt;
      this.db.prepare(`DELETE FROM live_events WHERE cursor IN (SELECT cursor FROM live_events
        WHERE kind='host.heartbeat' AND received_at < ? AND cursor NOT IN (SELECT cursor FROM live_latest) LIMIT 5000)`)
        .run(receivedAt - 48 * 3600_000);
    }
    for (const event of fresh) for (const subscriber of [...this.subscribers]) {
      try { subscriber(event); } catch { this.subscribers.delete(subscriber); }
    }
    return events;
  }
  after(cursor: number, limit = 500): LiveEvent[] {
    if (!Number.isSafeInteger(cursor) || cursor < 0 || !Number.isSafeInteger(limit) || limit < 1 || limit > 500)
      throw new Error('invalid cursor or limit');
    return (this.db.prepare('SELECT * FROM live_events WHERE cursor > ? ORDER BY cursor LIMIT ?').all(cursor, limit) as unknown as Row[]).map(fromRow);
  }
  head(): number {
    return (this.db.prepare('SELECT COALESCE(MAX(cursor), 0) AS cursor FROM live_events').get() as { cursor: number }).cursor;
  }
  jobBindings(): LiveEvent[] {
    return (this.db.prepare(`SELECT e.* FROM live_latest l JOIN live_events e ON e.cursor=l.cursor
      WHERE l.kind='job.binding' AND e.received_at>? ORDER BY e.cursor DESC LIMIT 2000`)
      .all(Date.now() - 7 * 86_400_000) as unknown as Row[]).map(fromRow);
  }
  sourceOnline(source: string, since: number): boolean {
    return !!this.db.prepare(`SELECT 1 FROM live_latest l JOIN live_events e ON e.cursor=l.cursor
      WHERE l.source=? AND l.kind='host.heartbeat' AND e.received_at>=? LIMIT 1`).get(source, since);
  }
  jobOffset(job: string, attempt: number): number {
    const row = this.db.prepare('SELECT offset FROM live_job_offsets WHERE job=? AND attempt=?').get(job, attempt) as { offset: number } | undefined;
    return row?.offset ?? 0;
  }
  setJobOffset(job: string, attempt: number, offset: number): void {
    this.db.prepare('INSERT INTO live_job_offsets VALUES (?,?,?) ON CONFLICT(job,attempt) DO UPDATE SET offset=excluded.offset').run(job, attempt, offset);
  }
  /** Keep replay frame blobs for the same window as the job cache, plus every current observation. */
  retainedBlobs(since: number): Set<string> {
    const rows = this.db.prepare(`SELECT data FROM live_events WHERE
      (received_at >= ? AND kind IN ('candidate.snapshot','route.preview','placement.preview'))
      OR cursor IN (SELECT cursor FROM live_latest)`).iterate(since) as Iterable<{ data: string }>;
    const hashes = new Set<string>();
    for (const row of rows) {
      const data = JSON.parse(row.data) as { sha256?: unknown; baseSha256?: unknown };
      for (const value of [data?.sha256, data?.baseSha256]) if (typeof value === 'string' && /^[0-9a-f]{64}$/.test(value)) hashes.add(value);
    }
    for (const row of this.db.prepare('SELECT model_sha FROM live_models WHERE created_at >= ? AND model_sha IS NOT NULL').iterate(since) as Iterable<{ model_sha: string }>) hashes.add(row.model_sha);
    return hashes;
  }
  requestModel(cursor: number): ModelRequest {
    if (!Number.isSafeInteger(cursor) || cursor < 1) throw new Error('invalid snapshot cursor');
    const row = this.db.prepare('SELECT * FROM live_events WHERE cursor=?').get(cursor) as unknown as Row | undefined;
    if (!row || !['board.snapshot', 'candidate.snapshot'].includes(row.kind)) throw new Error('3D export requires a board snapshot');
    const data = JSON.parse(row.data) as { sha256?: unknown; path?: unknown };
    if (typeof data.sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(data.sha256) || typeof data.path !== 'string' || !data.path || data.path.length > 2048)
      throw new Error('invalid snapshot');
    const existing = this.db.prepare("SELECT * FROM live_models WHERE source=? AND board_sha=? AND path=? AND created_at>? AND status IN ('pending','ready') ORDER BY created_at DESC LIMIT 1")
      .get(row.source, data.sha256, data.path, Date.now() - 3600_000) as unknown as ModelRow | undefined;
    if (existing) return modelFromRow(existing);
    const pending = this.db.prepare("SELECT COUNT(*) AS n FROM live_models WHERE status='pending' AND created_at>?").get(Date.now() - 3600_000) as { n: number };
    if (pending.n >= 100) throw new Error('3D export queue is full');
    const id = randomUUID(), now = Date.now();
    this.db.prepare("INSERT INTO live_models VALUES (?,?,?,?,?,?,?,'pending',NULL,NULL)").run(id, row.source, row.board, row.run, data.path, data.sha256, now);
    return this.model(id)!;
  }
  model(id: string): ModelRequest | null {
    if (!/^[0-9a-f-]{36}$/.test(id)) throw new Error('invalid model request');
    const row = this.db.prepare('SELECT * FROM live_models WHERE id=?').get(id) as unknown as ModelRow | undefined;
    return row ? modelFromRow(row) : null;
  }
  pendingModels(source: string): ModelRequest[] {
    if (!source || source.length > 512) throw new Error('invalid source');
    return (this.db.prepare("SELECT * FROM live_models WHERE source=? AND status='pending' AND created_at>? ORDER BY created_at LIMIT 5")
      .all(source, Date.now() - 3600_000) as unknown as ModelRow[]).map(modelFromRow);
  }
  finishModel(id: string, source: string, modelSha: string | null, error: string | null): ModelRequest {
    if ((!modelSha && !error) || (modelSha !== null && !/^[0-9a-f]{64}$/.test(modelSha)) || (error !== null && (typeof error !== 'string' || error.length > 1000))) throw new Error('invalid model result');
    const req = this.model(id); if (!req || req.source !== source) throw new Error('model request not found');
    if (req.status === 'pending') this.db.prepare('UPDATE live_models SET status=?, model_sha=?, error=? WHERE id=? AND status=\'pending\'')
      .run(modelSha ? 'ready' : 'error', modelSha, error, id);
    return this.model(id)!;
  }
  history(source: string, board: string, run: string, after: number, since = 0): { events: LiveEvent[]; more: boolean; expired: boolean } {
    if (![source, board, run].every(v => typeof v === 'string' && v.length > 0 && v.length <= 512) ||
        !Number.isSafeInteger(after) || after < 0 || !Number.isFinite(since) || since < 0) throw new Error('invalid history request');
    const rows = this.db.prepare(`SELECT * FROM live_events WHERE source=? AND board=? AND run=? AND cursor>?
      AND received_at >= ? AND kind IN ('candidate.snapshot','route.preview','placement.preview') ORDER BY cursor LIMIT 201`)
      .all(source, board, run, after, since) as unknown as Row[];
    const expired = !!this.db.prepare(`SELECT 1 FROM live_events WHERE source=? AND board=? AND run=? AND received_at < ?
      AND kind IN ('candidate.snapshot','route.preview','placement.preview') LIMIT 1`).get(source, board, run, since);
    return { events: rows.slice(0, 200).map(fromRow), more: rows.length > 200, expired };
  }
  /** Latest observation per source/board/run/kind, and the cursor from which to follow. */
  current(): { epoch: string; cursor: number; events: LiveEvent[]; truncated: boolean } {
    const head = { cursor: this.head() };
    const rows = this.db.prepare(`SELECT e.* FROM live_latest l JOIN live_events e ON e.cursor=l.cursor
      WHERE e.cursor <= ? ORDER BY e.cursor DESC LIMIT 2001`).all(head.cursor) as unknown as Row[];
    const recent = this.db.prepare("SELECT * FROM live_events WHERE kind='run.event' AND cursor <= ? ORDER BY cursor DESC LIMIT 300")
      .all(head.cursor) as unknown as Row[];
    const unique = new Map<number, LiveEvent>();
    for (const row of [...rows.slice(0, 2000), ...recent]) unique.set(row.cursor, fromRow(row));
    return { epoch: this.epoch, cursor: head.cursor, events: [...unique.values()].sort((a, b) => a.cursor - b.cursor), truncated: rows.length > 2000 };
  }
  subscribe(fn: (event: LiveEvent) => void): () => void {
    this.subscribers.add(fn);
    return () => { this.subscribers.delete(fn); };
  }
  close(): void { this.db.close(); }
}

interface Row { cursor: number; source: string; event_id: string; host: string; board: string; run: string; kind: string; data: string; received_at: number }
export interface ModelRequest { id: string; source: string; board: string; run: string; path: string; boardSha: string; createdAt: number; status: string; modelSha: string | null; error: string | null }
interface ModelRow { id: string; source: string; board: string; run: string; path: string; board_sha: string; created_at: number; status: string; model_sha: string | null; error: string | null }
function modelFromRow(row: ModelRow): ModelRequest {
  return { id: row.id, source: row.source, board: row.board, run: row.run, path: row.path, boardSha: row.board_sha,
    createdAt: row.created_at, status: row.status, modelSha: row.model_sha, error: row.error };
}
function fromRow(row: Row): LiveEvent {
  return { cursor: row.cursor, source: row.source, eventId: row.event_id, host: row.host, board: row.board,
    run: row.run, kind: row.kind, data: JSON.parse(row.data) as unknown, receivedAt: row.received_at };
}
