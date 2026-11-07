/** Read bounded, flat observation files from the job's out mount. Never follows job-controlled links. */
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { openNoFollow } from "./store.ts";
import { isDigest, SEQUENCE_REUSED, validateLiveEvent } from "./live-protocol.ts";
import type { LiveEvent, LivePayload, LivePlacement } from "./live-protocol.ts";

const digest = (b: Buffer): string =>
  createHash("sha256").update(b).digest("hex");
function read(file: string, max: number): Buffer | null {
  const fd = openNoFollow(file);
  if (fd === null) return null;
  try {
    const s = fs.fstatSync(fd);
    if (s.nlink !== 1 || s.size > max) return null;
    const b = Buffer.alloc(s.size);
    let n = 0;
    while (n < b.length) {
      const got = fs.readSync(fd, b, n, b.length - n, n);
      if (!got) break;
      n += got;
    }
    return n === b.length ? b : null;
  } finally {
    fs.closeSync(fd);
  }
}
interface Footprint {
  ref: string;
  x: number;
  y: number;
  rotation: number;
  locked: boolean;
}
interface Manifest {
  schema: string;
  id: string;
  operation: "placement" | "routing";
  source: string;
  baseSha256: string;
  modelSha256: string;
  startedMs: number;
  footprints: Footprint[];
}
interface Cursor {
  offset: number;
  line: number;
  time: number;
  manifest: Manifest;
  done: boolean;
  inode: number | null;
}
export interface ObservedJob {
  id: string;
  name: string;
  state: string;
  host?: string;
  attempts: { n: number; out: string; endedAt?: string }[];
}
export interface LiveSink {
  importBoard(bytes: Buffer, sha: string): Promise<void>;
  append(events: LiveEvent[]): unknown | Promise<unknown>;
}
export class LiveJobs {
  private readonly cursors = new Map<string, Cursor>();
  private readonly errors = new Map<string, number>();
  private pending = false;
  private busy = false;
  private stopped = false;
  private source: () => Iterable<ObservedJob>;
  private sink: LiveSink;
  constructor(source: () => Iterable<ObservedJob>, sink: LiveSink) {
    this.source = source;
    this.sink = sink;
  }
  settled(): boolean {
    return !this.pending && [...this.cursors.values()].every((c) => c.done);
  }
  stop(): void {
    this.stopped = true;
  }
  async poll(): Promise<void> {
    if (this.busy || this.stopped) return;
    this.busy = true;
    this.pending = false;
    try {
      for (const job of this.source())
        for (const attempt of job.attempts) {
          if (this.stopped) return;
          const out = attempt.out;
          let entries: fs.Dirent[];
          try {
            entries = fs.readdirSync(out, { withFileTypes: true });
          } catch {
            continue;
          }
          const names = entries
            .filter(
              (e) =>
                e.isFile() &&
                /^pcb-live-[a-f0-9]{24}\.manifest\.json$/.test(e.name),
            )
            .slice(0, 128);
          for (const entry of names) {
            try {
              await this.ingest(job, attempt, out, entry.name);
            } catch (error) {
              this.warn(`${job.id}/${attempt.n}/${entry.name}`, error);
            }
            const id = `${job.id}:${attempt.n}:${entry.name.slice(9, -14)}`;
            if (!this.cursors.get(id)?.done) this.pending = true;
          }
        }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT")
        console.error(`live observer: ${String(error)}`);
    } finally {
      this.busy = false;
    }
  }
  private warn(id: string, error: unknown): void {
    const now = Date.now();
    if (now - (this.errors.get(id) ?? 0) > 10000) {
      this.errors.set(id, now);
      console.error(`live observation ${id}: ${String(error).slice(0, 500)}`);
    }
  }
  private async ingest(
    job: ObservedJob,
    attempt: ObservedJob["attempts"][number],
    out: string,
    name: string,
  ): Promise<void> {
    const stem = name.slice(0, -".manifest.json".length),
      runId = `${job.id}:${attempt.n}:${stem.slice(9)}`;
    let c = this.cursors.get(runId);
    if (c?.done) return;
    if (!c) {
      const bytes = read(path.join(out, name), 4 * 1024 * 1024);
      if (!bytes) return;
      const m = JSON.parse(bytes.toString()) as Manifest;
      if (
        m.schema !== "pcb-job-live.v1" ||
        stem !== `pcb-live-${m.id}` ||
        !["placement", "routing"].includes(m.operation) ||
        !isDigest(m.baseSha256) ||
        !isDigest(m.modelSha256) ||
        !Number.isSafeInteger(m.startedMs) ||
        m.startedMs < 0 ||
        typeof m.source !== "string" ||
        m.source.length > 512 ||
        !Array.isArray(m.footprints) ||
        m.footprints.length > 20000 ||
        m.footprints.some(
          (f) =>
            typeof f.ref !== "string" ||
            f.ref.length > 512 ||
            typeof f.locked !== "boolean" ||
            ![f.x, f.y, f.rotation].every(Number.isFinite),
        )
      )
        throw Error("Invalid native observation manifest");
      const board = read(
        path.join(out, stem + ".kicad_pcb"),
        128 * 1024 * 1024,
      );
      if (!board || digest(board) !== m.baseSha256) return;
      await this.sink.importBoard(board, m.baseSha256);
      if (this.stopped) return;
      c = {
        offset: 0,
        line: 0,
        time: m.startedMs,
        manifest: m,
        done: false,
        inode: null,
      };
      await this.append(
        runId,
        c,
        {
          kind: "run.started",
          data: {
            project: job.name || "PCB job",
            board: path.basename(m.source),
            host: job.host ?? "job-daemon",
            operation: m.operation,
            label: `${job.name} / ${m.operation} / attempt ${attempt.n} / ${m.id.slice(0, 8)}`,
          },
        },
        1,
        m.startedMs,
      );
      await this.append(
        runId,
        c,
        {
          kind: "board.snapshot",
          data: {
            blobSha256: m.baseSha256,
            path: m.source,
            phase: m.operation,
            includesBaseCopper: m.operation === "placement",
          },
        },
        2,
        m.startedMs,
      );
      this.cursors.set(runId, c);
    }
    const fd = openNoFollow(path.join(out, stem + ".ndjson"));
    if (fd !== null)
      try {
        const stat = fs.fstatSync(fd);
        if (
          stat.nlink !== 1 ||
          stat.size > 512 * 1024 * 1024 ||
          stat.size < c.offset ||
          (c.inode !== null && c.inode !== stat.ino)
        )
          throw Error("Native observation file changed or exceeds limit");
        c.inode = stat.ino;
        const buffer = Buffer.alloc(
          Math.min(stat.size - c.offset, 8 * 1024 * 1024),
        );
        const count = fs.readSync(fd, buffer, 0, buffer.length, c.offset);
        let end = buffer.subarray(0, count).lastIndexOf(10);
        if (attempt.endedAt && c.offset + count >= stat.size && end < count - 1) {
          // The writer is gone, so an unterminated tail will never be finished: read it if it is whole, else say so.
          try {
            JSON.parse(buffer.subarray(end + 1, count).toString("utf8"));
            end = count;
          } catch {
            this.warn(runId, `dropped ${count - end - 1} bytes of an incomplete last frame`);
          }
        }
        if (end < 0) {
          if (count === 8 * 1024 * 1024)
            throw Error("Native frame exceeds limit");
        } else {
          const batch: LiveEvent[] = [];
          let batchBytes = 0;
          let offset = c.offset,
            lineNumber = c.line,
            time = c.time;
          for (const line of buffer
            .subarray(0, end)
            .toString("utf8")
            .split("\n")
            .slice(0, 64)) {
            const raw = JSON.parse(line);
            if (
              ![
                "placement.sample",
                "route.delta",
                "route.activity",
                "route.failure",
                "progress",
                "checkpoint",
              ].includes(raw.kind)
            )
              throw Error(
                "Native stream cannot claim lifecycle or verification",
              );
            time = Math.max(time, raw.timeMs ?? c.manifest.startedMs);
            const payload =
              raw.kind === "placement.sample"
                ? this.placement(raw, c.manifest)
                : { kind: raw.kind, data: raw.data };
            const event = this.event(
                runId,
                c,
                payload as LivePayload,
                lineNumber + 3,
                time,
              );
            validateLiveEvent(event);
            const bytes = Buffer.byteLength(JSON.stringify(event));
            if (bytes > 8 * 1024 * 1024) throw Error("Expanded native frame exceeds limit");
            if (batch.length && batchBytes + bytes > 8 * 1024 * 1024) break;
            batch.push(event); batchBytes += bytes;
            lineNumber++;
            offset += Buffer.byteLength(line) + 1;
          }
          if (!this.stopped) await this.sink.append(batch);
          c.line = lineNumber;
          c.time = time;
          c.offset = offset;
        }
        if (c.offset < stat.size && !(attempt.endedAt && end < 0)) return;
      } finally {
        fs.closeSync(fd);
      }
    const doneBytes = read(path.join(out, stem + ".done.json"), 4096);
    if (!doneBytes && !attempt.endedAt) return;
    const done = doneBytes ? JSON.parse(doneBytes.toString()) : null;
    const time = Math.max(c.time, done?.timeMs ?? Date.parse(attempt.endedAt!));
    try {
      await this.append(
        runId,
        c,
        {
          kind: "run.finished",
          data: {
            outcome:
              done?.outcome === "passed"
                ? "passed"
                : job.state === "cancelled"
                  ? "cancelled"
                  : "failed",
            message:
              done?.message ??
              "Job ended without a native completion record; result is unknown",
            verified: false,
          },
        },
        c.line + 3,
        time,
      );
    } catch (error) {
      // Cursors live in memory only. After a restart this verdict is built again from a job record that may have moved
      // on, and the journal already holds the first one. The first verdict stands: the run is settled, not stuck.
      if (!String(error).includes(SEQUENCE_REUSED)) throw error;
    }
    c.done = true;
    c.manifest.footprints = [];
  }
  private event(
    runId: string,
    c: Cursor,
    payload: LivePayload,
    seq: number,
    timeMs: number,
  ): LiveEvent {
    return {
      schema: "pcb-live.v1",
      runId,
      attemptId: runId,
      seq,
      timeMs,
      baseSha256: c.manifest.baseSha256,
      ...payload,
    } as LiveEvent;
  }
  private async append(
    runId: string,
    c: Cursor,
    payload: LivePayload,
    seq: number,
    timeMs: number,
  ): Promise<void> {
    if (!this.stopped)
      await this.sink.append([this.event(runId, c, payload, seq, timeMs)]);
  }
  private placement(raw: any, m: Manifest): LivePayload {
    if (raw.baseSha256 !== m.baseSha256 || raw.attemptId !== m.id)
      throw Error("Native placement binding mismatch");
    const fps = new Map(m.footprints.map((f) => [f.ref, f]));
    for (const units of [raw.current, raw.best]) {
      if (!Array.isArray(units) || units.length > 20000) throw Error("Too many placement units");
      let refs = 0;
      for (const unit of units) {
        if (!unit || !Array.isArray(unit.refs) || (refs += unit.refs.length) > 20000 ||
            !Array.isArray(unit.origin) || unit.origin.length !== 2 || !unit.origin.every(Number.isFinite) ||
            !Array.isArray(unit.position) || unit.position.length !== 2 || !unit.position.every(Number.isFinite) ||
            !Number.isInteger(unit.turn) || unit.turn < 0 || unit.turn > 3)
          throw Error("Invalid placement unit");
      }
    }
    const positions = (units: any[]): LivePlacement[] =>
      units.flatMap((u) =>
        u.refs.map((ref: string) => {
          const f = fps.get(ref);
          if (!f) throw Error("Unknown placement footprint");
          const a = (u.turn * Math.PI) / 2,
            dx = f.x - u.origin[0],
            dy = f.y - u.origin[1];
          return {
            ref,
            x: u.position[0] + dx * Math.cos(a) + dy * Math.sin(a),
            y: u.position[1] - dx * Math.sin(a) + dy * Math.cos(a),
            rotation: f.rotation + u.turn * 90,
            locked: !!u.locked || f.locked,
          };
        }),
      );
    return {
      kind: "placement.frame",
      data: {
        worker: raw.worker,
        epoch: raw.epoch,
        step: raw.step,
        accepted: raw.accepted,
        rejected: raw.rejected,
        currentCost: raw.currentCost,
        bestCost: raw.bestCost,
        bestScope: raw.bestScope,
        current: positions(raw.current),
        best: positions(raw.best),
        terms: {},
      },
    };
  }
}
