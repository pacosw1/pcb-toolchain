// Durable, replayable progress records from workers. A source event ID makes retries idempotent.
import { EventEmitter } from 'node:events';
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
  private emitter = new EventEmitter();
  readonly epoch: string;
  constructor(file: string) {
    this.db = new DatabaseSync(file);
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;
      CREATE TABLE IF NOT EXISTS live_events (cursor INTEGER PRIMARY KEY AUTOINCREMENT,
        source TEXT NOT NULL, event_id TEXT NOT NULL, host TEXT NOT NULL, board TEXT NOT NULL,
        run TEXT NOT NULL, kind TEXT NOT NULL, data TEXT NOT NULL, received_at INTEGER NOT NULL,
        UNIQUE(source, event_id)) STRICT;
      CREATE TABLE IF NOT EXISTS live_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL) STRICT;`);
    this.db.prepare("INSERT INTO live_meta VALUES ('epoch', ?) ON CONFLICT(key) DO NOTHING").run(randomUUID());
    this.epoch = (this.db.prepare("SELECT value FROM live_meta WHERE key='epoch'").get() as { value: string }).value;
    this.emitter.setMaxListeners(0); // the HTTP server independently limits streams
  }
  append(input: LiveInput): LiveEvent {
    for (const field of ['source', 'eventId', 'host', 'board', 'run', 'kind'] as const) {
      const value = input[field];
      if (typeof value !== 'string' || !value || value.length > 512) throw new Error(`invalid ${field}`);
    }
    const data = JSON.stringify(input.data);
    if (data === undefined || Buffer.byteLength(data) > 256 * 1024) throw new Error('invalid event data');
    const receivedAt = Date.now();
    const result = this.db.prepare(`INSERT INTO live_events (source,event_id,host,board,run,kind,data,received_at)
      VALUES (?,?,?,?,?,?,?,?) ON CONFLICT(source,event_id) DO NOTHING`)
      .run(input.source, input.eventId, input.host, input.board, input.run, input.kind, data, receivedAt);
    if (!result.changes) {
      const prior = this.db.prepare('SELECT * FROM live_events WHERE source=? AND event_id=?').get(input.source, input.eventId) as unknown as Row;
      if (prior.host !== input.host || prior.board !== input.board || prior.run !== input.run || prior.kind !== input.kind || prior.data !== data)
        throw new Error('event ID reused with different content');
      return fromRow(prior);
    }
    const event = { ...input, cursor: Number(result.lastInsertRowid), receivedAt };
    this.emitter.emit('event', event);
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
    const rows = this.db.prepare(`SELECT * FROM (SELECT *, ROW_NUMBER() OVER
      (PARTITION BY source, board, run, kind,
        CASE WHEN kind IN ('board.snapshot', 'board.invalid', 'board.removed', 'route.preview', 'placement.preview') THEN COALESCE(json_extract(data, '$.path'), '') ELSE '' END
       ORDER BY cursor DESC) AS rank
      FROM live_events WHERE cursor <= ?) WHERE rank = 1 ORDER BY cursor DESC LIMIT 2001`).all(head.cursor) as unknown as Row[];
    const recent = this.db.prepare("SELECT * FROM live_events WHERE kind='run.event' AND cursor <= ? ORDER BY cursor DESC LIMIT 300")
      .all(head.cursor) as unknown as Row[];
    const unique = new Map<number, LiveEvent>();
    for (const row of [...rows.slice(0, 2000), ...recent]) unique.set(row.cursor, fromRow(row));
    return { epoch: this.epoch, cursor: head.cursor, events: [...unique.values()].sort((a, b) => a.cursor - b.cursor), truncated: rows.length > 2000 };
  }
  subscribe(fn: (event: LiveEvent) => void): () => void {
    this.emitter.on('event', fn);
    return () => this.emitter.off('event', fn);
  }
  close(): void { this.db.close(); }
}

interface Row { cursor: number; source: string; event_id: string; host: string; board: string; run: string; kind: string; data: string; received_at: number }
function fromRow(row: Row): LiveEvent {
  return { cursor: row.cursor, source: row.source, eventId: row.event_id, host: row.host, board: row.board,
    run: row.run, kind: row.kind, data: JSON.parse(row.data) as unknown, receivedAt: row.received_at };
}
