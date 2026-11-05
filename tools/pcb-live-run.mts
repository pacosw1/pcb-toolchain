#!/usr/bin/env node
/** Observe one native solver invocation. Local SQLite spool is the source of truth; uploads retry by sequence. */
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { parseArgs } from "node:util";
import { pathToFileURL } from "node:url";
import { fromBytes } from "../apps/studio/app/src/main/kicad/board.ts";
import { validateLiveEvent } from "../apps/job-daemon/src/live-protocol.ts";
import type {
  LiveEvent,
  LivePayload,
  LivePlacement,
} from "../apps/job-daemon/src/live-protocol.ts";

const hash = (b: Uint8Array): string =>
  createHash("sha256").update(b).digest("hex");
const delay = (ms: number): Promise<void> =>
  new Promise((r) => setTimeout(r, ms));
type Unit = {
  refs: string[];
  origin: [number, number];
  position: [number, number];
  turn: number;
  locked: boolean;
};
export function placements(
  units: Unit[],
  board: ReturnType<typeof fromBytes>,
): LivePlacement[] {
  const fps = new Map(board.footprints.map((f) => [f.ref, f]));
  return units.flatMap((u) =>
    u.refs.map((ref) => {
      const f = fps.get(ref);
      if (!f) throw new Error(`Unknown footprint ${ref}`);
      const angle = (u.turn * Math.PI) / 2,
        dx = f.x - u.origin[0],
        dy = f.y - u.origin[1];
      return {
        ref,
        x: u.position[0] + dx * Math.cos(angle) + dy * Math.sin(angle),
        y: u.position[1] - dx * Math.sin(angle) + dy * Math.cos(angle),
        rotation: f.rot + u.turn * 90,
        locked: u.locked || f.locked,
      };
    }),
  );
}
export async function main(argv = process.argv.slice(2)): Promise<void> {
  const split = argv.indexOf("--"),
    flags = split < 0 ? argv : argv.slice(0, split),
    command = split < 0 ? [] : argv.slice(split + 1);
  const { values: v } = parseArgs({
    args: flags,
    options: {
      board: { type: "string" },
      model: { type: "string" },
      operation: { type: "string" },
      spool: { type: "string" },
      project: { type: "string" },
      label: { type: "string" },
      url: { type: "string" },
      "token-file": { type: "string" },
      resume: { type: "boolean" },
    },
  });
  if (!v.spool) throw new Error("--spool is required");
  const dir = path.resolve(v.spool);
  fs.mkdirSync(dir, { recursive: true });
  const db = new DatabaseSync(path.join(dir, "observer.sqlite"));
  db.exec(
    "PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; CREATE TABLE IF NOT EXISTS meta(k TEXT PRIMARY KEY,v TEXT NOT NULL); CREATE TABLE IF NOT EXISTS events(seq INTEGER PRIMARY KEY,body TEXT NOT NULL);",
  );
  const get = (k: string): string | undefined =>
    (
      db.prepare("SELECT v FROM meta WHERE k=?").get(k) as
        { v: string } | undefined
    )?.v;
  const put = (k: string, value: string): void => {
    db.prepare("INSERT OR REPLACE INTO meta VALUES(?,?)").run(k, value);
  };
  if (get("run") && !v.resume)
    throw new Error(
      "Spool already exists; use --resume to upload recorded events without restarting the solver",
    );
  if (!get("run")) {
    if (
      !v.board ||
      !["placement", "routing"].includes(v.operation ?? "") ||
      !command.length
    )
      throw new Error(
        "--board, --operation placement|routing and -- solver command are required",
      );
    const bytes = fs.readFileSync(v.board);
    if (bytes.length > 128 * 1024 * 1024)
      throw new Error("Board exceeds limit");
    const run = randomUUID();
    fs.writeFileSync(path.join(dir, "base.kicad_pcb"), bytes, { flag: "wx" });
    db.exec("BEGIN IMMEDIATE");
    put("run", run);
    put("base", hash(bytes));
    put("operation", v.operation!);
    put("board", path.resolve(v.board));
    put("offset", "0");
    put("ack", "0");
    db.exec("COMMIT");
  }
  const runId = get("run")!,
    baseSha256 = get("base")!,
    operation = get("operation") as "placement" | "routing";
  const board = fromBytes(fs.readFileSync(path.join(dir, "base.kicad_pcb")));
  let seq = Number(
    (db.prepare("SELECT max(seq) as seq FROM events").get() as { seq: number })
      .seq ?? 0,
  );
  let time = seq
    ? JSON.parse(
        (
          db.prepare("SELECT body FROM events WHERE seq=?").get(seq) as {
            body: string;
          }
        ).body,
      ).timeMs
    : 0;
  const append = (payload: LivePayload): void => {
    const event = {
      schema: "pcb-live.v1",
      runId,
      attemptId: runId,
      seq: ++seq,
      timeMs: (time = Math.max(time, Date.now())),
      baseSha256,
      ...payload,
    } as LiveEvent;
    validateLiveEvent(event);
    db.prepare("INSERT INTO events VALUES(?,?)").run(
      seq,
      JSON.stringify(event),
    );
  };
  if (seq === 0) {
    db.exec("BEGIN IMMEDIATE");
    append({
      kind: "run.started",
      data: {
        project: v.project ?? path.basename(get("board")!, ".kicad_pcb"),
        board: path.basename(get("board")!),
        host: os.hostname(),
        operation,
        label: v.label ?? `${operation} ${path.basename(get("board")!)}`,
      },
    });
    append({
      kind: "board.snapshot",
      data: {
        blobSha256: baseSha256,
        path: get("board")!,
        phase: operation,
        includesBaseCopper: operation === "placement",
      },
    });
    db.exec("COMMIT");
  }
  const raw = path.join(dir, "native.ndjson");
  const ingest = (): void => {
    if (!fs.existsSync(raw)) return;
    let offset = Number(get("offset"));
    const fd = fs.openSync(raw, "r");
    try {
      const size = fs.fstatSync(fd).size;
      if (size < offset) throw new Error("Native observation was truncated");
      if (size > 512 * 1024 * 1024)
        throw new Error("Native observation exceeds 512 MiB");
      const buf = Buffer.alloc(Math.min(16 * 1024 * 1024, size - offset));
      fs.readSync(fd, buf, 0, buf.length, offset);
      const end = buf.lastIndexOf(10);
      if (end < 0) {
        if (buf.length >= 16 * 1024 * 1024)
          throw new Error("Native frame exceeds limit");
        return;
      }
      db.exec("BEGIN IMMEDIATE");
      const oldSeq = seq;
      try {
        for (const line of buf.subarray(0, end).toString("utf8").split("\n")) {
          const r = JSON.parse(line);
          if (r.kind === "placement.sample") {
            if (r.baseSha256 !== baseSha256 || r.attemptId !== runId)
              throw new Error("Native placement identity mismatch");
            append({
              kind: "placement.frame",
              data: {
                worker: r.worker,
                epoch: r.epoch,
                step: r.step,
                accepted: r.accepted,
                rejected: r.rejected,
                currentCost: r.currentCost,
                bestCost: r.bestCost,
                bestScope: r.bestScope,
                current: placements(r.current, board),
                best: placements(r.best, board),
                terms: {},
              },
            });
            if (r.step === Number(get("steps")))
              append({
                kind: "checkpoint",
                data: {
                  label: `Epoch ${r.epoch}, worker ${r.worker}`,
                  best: true,
                },
              });
          } else append(r as LivePayload);
        }
        offset += end + 1;
        put("offset", String(offset));
        db.exec("COMMIT");
      } catch (e) {
        db.exec("ROLLBACK");
        seq = oldSeq;
        throw e;
      }
    } finally {
      fs.closeSync(fd);
    }
  };
  const url = v.url ?? process.env.JOBD_URL,
    tokenFile = v["token-file"] ?? process.env.JOBD_TOKEN_FILE;
  if (!url || !tokenFile)
    throw new Error("JOBD_URL and JOBD_TOKEN_FILE (or flags) are required");
  const origin = new URL(url);
  if (
    !["https:", "http:"].includes(origin.protocol) ||
    origin.username ||
    origin.password ||
    origin.search ||
    origin.hash
  )
    throw new Error("Invalid coordinator URL");
  const request = async (
    route: string,
    init: RequestInit = {},
  ): Promise<Response> => {
    const token = fs.readFileSync(tokenFile, "utf8").trim();
    const r = await fetch(new URL(route, origin), {
      ...init,
      headers: { ...init.headers, authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(10000),
    });
    if (!r.ok)
      throw new Error(
        `Live coordinator ${r.status}: ${(await r.text()).slice(0, 200)}`,
      );
    return r;
  };
  let asset = false;
  const upload = async (): Promise<void> => {
    if (!asset) {
      await request(`/live/assets/${baseSha256}`, {
        method: "PUT",
        body: fs.readFileSync(path.join(dir, "base.kicad_pcb")),
      });
      asset = true;
    }
    const rows = db
      .prepare("SELECT seq,body FROM events WHERE seq>? ORDER BY seq LIMIT 16")
      .all(Number(get("ack"))) as { seq: number; body: string }[];
    if (rows.length) {
      await request("/live/events", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ events: rows.map((r) => JSON.parse(r.body)) }),
      });
      put("ack", String(rows.at(-1)!.seq));
    }
  };
  let finished = Boolean(get("exit"));
  let child: ReturnType<typeof spawn> | undefined;
  if (!v.resume) {
    const env = { ...process.env, PCB_LIVE_EVENTS: raw };
    if (operation === "placement") {
      if (!v.model)
        throw new Error("--model is required for placement identity");
      Object.assign(env, {
        IOTPLACE_LIVE_FILE: path.join(dir, "live-place.json"),
        IOTPLACE_LIVE_BOARD: get("board"),
        IOTPLACE_LIVE_BOARD_SHA256: baseSha256,
        IOTPLACE_LIVE_MODEL_SHA256: hash(fs.readFileSync(v.model)),
        IOTPLACE_LIVE_MODEL_ID: hash(fs.readFileSync(v.model)),
        IOTPLACE_LIVE_RULES_ID: "model-bound",
        IOTPLACE_LIVE_ATTEMPT_ID: runId,
      });
      put(
        "steps",
        command.includes("--steps")
          ? command[command.indexOf("--steps") + 1]
          : "20000",
      );
    }
    const log = fs.openSync(path.join(dir, "solver.log"), "a");
    let pending = "";
    child = spawn(command[0], command.slice(1), {
      env,
      stdio: ["inherit", "pipe", "pipe"],
    });
    put("pid", String(child.pid ?? 0));
    const record = (chunk: Buffer, isError: boolean): void => {
      fs.writeSync(log, chunk);
      (isError ? process.stderr : process.stdout).write(chunk);
      pending += chunk.toString();
      const lines = pending.split("\n");
      pending = lines.pop() ?? "";
      for (const line of lines) {
        const m = /^ROUTE (PASS|FAIL|STUCK|YIELDED)\b/.exec(line);
        if (m) put("routeStatus", m[1]);
      }
      if (pending.length > 65536) pending = pending.slice(-65536);
    };
    child.stdout!.on("data", (b) => record(b, false));
    child.stderr!.on("data", (b) => record(b, true));
    child.on("close", () => fs.closeSync(log));
    child.on("error", (e) => {
      put("exit", "127");
      put("error", e.message);
      finished = true;
    });
    child.on("close", (code, signal) => {
      put("exit", String(code ?? 128));
      put("signal", signal ?? "");
      finished = true;
    });
  } else if (!finished) {
    // Recovery uploads every recorded frame but cannot infer success from an orphaned child.
    try {
      const pid = Number(get("pid"));
      if (pid > 0) process.kill(pid, 0);
      else throw new Error("no pid");
    } catch {
      put("exit", "128");
      put(
        "error",
        "Observer restarted without a recorded solver exit; outcome unknown",
      );
      finished = true;
    }
  }
  let terminal = false,
    failures = 0,
    observationError = false;
  try {
    while (true) {
      if (v.resume && !finished) {
        try {
          process.kill(Number(get("pid")), 0);
        } catch {
          put("exit", "128");
          put("error", "Solver ended without a recorded exit; outcome unknown");
          finished = true;
        }
      }
      if (!observationError)
        try {
          ingest();
        } catch (error) {
          observationError = true;
          put("error", String(error));
          append({
            kind: "progress",
            data: {
              stage: "observation-error",
              elapsedMs: 0,
              message: String(error).slice(0, 4000),
              metrics: {},
            },
          });
        }
      if (finished && !terminal) {
        // Drain all complete native records before the terminal event.
        if (
          !observationError &&
          fs.existsSync(raw) &&
          Number(get("offset")) < fs.statSync(raw).size
        ) {
          const remaining = fs.statSync(raw).size - Number(get("offset"));
          if (remaining >= 16 * 1024 * 1024) continue;
          // A killed producer can leave a partial last line; retain it, mark the run incomplete.
          put("error", "Native observation ended with a partial frame");
          put("exit", "128");
        }
        const last = JSON.parse(
          (
            db
              .prepare("SELECT body FROM events ORDER BY seq DESC LIMIT 1")
              .get() as { body: string }
          ).body,
        );
        if (last.kind !== "run.finished")
          append({
            kind: "run.finished",
            data: {
              outcome:
                !get("error") &&
                get("exit") === "0" &&
                (operation !== "routing" || get("routeStatus") === "PASS")
                  ? "passed"
                  : "failed",
              message:
                get("error") ??
                `Native solver ${get("routeStatus") ?? "exit " + get("exit")}; candidate is not independently verified`,
              verified: false,
            },
          });
        terminal = true;
      }
      try {
        await upload();
        failures = 0;
      } catch (e) {
        if (failures++ % 20 === 0) console.error(String(e));
      }
      if (terminal && Number(get("ack")) === seq) break;
      if (terminal && failures >= 6) {
        console.error(`Events saved in ${dir}; use --resume to retry upload`);
        break;
      }
      await delay(100);
    }
  } finally {
    db.close();
  }
  process.exitCode = Number(getExit(dir));
}
function getExit(dir: string): string {
  const d = new DatabaseSync(path.join(dir, "observer.sqlite"));
  try {
    return (
      (
        d.prepare("SELECT v FROM meta WHERE k='exit'").get() as
          { v: string } | undefined
      )?.v ?? "0"
    );
  } finally {
    d.close();
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  main().catch((e) => {
    console.error(e);
    process.exitCode = 1;
  });
