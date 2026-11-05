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
  append(input: LiveInput): LiveEvent {
    for (const field of ['source', 'eventId', 'host', 'board', 'run', 'kind'] as const) {
      const value = input[field];
      if (typeof value !== 'string' || !value || value.length > 512) throw new Error(`invalid ${field}`);
    }
    const data = JSON.stringify(input.data);
    if (data === undefined || Buffer.byteLength(data) > 256 * 1024) throw new Error('invalid event data');
    const receivedAt = Date.now();
    this.db.exec('BEGIN IMMEDIATE');
    let event: LiveEvent;
    try {
      const result = this.db.prepare(`INSERT INTO live_events (source,event_id,host,board,run,kind,data,received_at)
        VALUES (?,?,?,?,?,?,?,?) ON CONFLICT(source,event_id) DO NOTHING`)
        .run(input.source, input.eventId, input.host, input.board, input.run, input.kind, data, receivedAt);
      if (!result.changes) {
        const prior = this.db.prepare('SELECT * FROM live_events WHERE source=? AND event_id=?').get(input.source, input.eventId) as unknown as Row;
        if (prior.host !== input.host || prior.board !== input.board || prior.run !== input.run || prior.kind !== input.kind || prior.data !== data)
          throw new Error('event ID reused with different content');
        this.db.exec('COMMIT'); return fromRow(prior);
      }
      event = { ...input, cursor: Number(result.lastInsertRowid), receivedAt };
      const value = input.data as { path?: unknown } | null;
      const keyPath = ['board.snapshot', 'board.invalid', 'board.removed', 'route.preview', 'placement.preview'].includes(input.kind) && typeof value?.path === 'string' ? value.path : '';
      this.db.prepare(`INSERT INTO live_latest VALUES (?,?,?,?,?,?) ON CONFLICT(source,board,run,kind,path)
        DO UPDATE SET cursor=excluded.cursor`).run(input.source, input.board, input.run, input.kind, keyPath, event.cursor);
      this.db.exec('COMMIT');
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
    if (receivedAt - this.lastSweep > 3600_000) {
      this.lastSweep = receivedAt;
      this.db.prepare(`DELETE FROM live_events WHERE cursor IN (SELECT cursor FROM live_events
        WHERE kind='host.heartbeat' AND received_at < ? AND cursor NOT IN (SELECT cursor FROM live_latest) LIMIT 5000)`)
        .run(receivedAt - 48 * 3600_000);
    }
    for (const subscriber of [...this.subscribers]) {
      try { subscriber(event); } catch { this.subscribers.delete(subscriber); }
    }
    return event;
  }
  after(cursor: number, limit = 500): LiveEvent[] {
    if (!Number.isSafeInteger(cursor) || cursor < 0 || !Number.isSafeInteger(limit) || limit < 1 || limit > 500)
      throw new Error('invalid cursor or limit');
    return (this.db.prepare('SELECT * FROM live_events WHERE cursor > ? ORDER BY cursor LIMIT ?').all(cursor, limit) as unknown as Row[]).map(fromRow);
  }
  head(): number {
    return (this.db.prepare('SELECT COALESCE(MAX(cursor), 0) AS cursor FROM live_events').get() as { cursor: number }).cursor;
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
function fromRow(row: Row): LiveEvent {
  return { cursor: row.cursor, source: row.source, eventId: row.event_id, host: row.host, board: row.board,
    run: row.run, kind: row.kind, data: JSON.parse(row.data) as unknown, receivedAt: row.received_at };
}
