import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { LiveHttp } from "../src/live-http.ts";
import { LiveJobs } from "../src/live-jobs.ts";
import { stageLiveSources } from "../src/client.ts";
const hash = (b: Buffer | string): string =>
  createHash("sha256").update(b).digest("hex");
function fixture(operation = "routing") {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "job-observer-")),
    out = path.join(root, "out");
  fs.mkdirSync(out);
  fs.mkdirSync(path.join(root, "incoming"));
  const id = "a".repeat(24),
    stem = "pcb-live-" + id,
    board = Buffer.from("(kicad_pcb (version 20260101))"),
    sha = hash(board);
  const manifest = {
    schema: "pcb-job-live.v1",
    id,
    operation,
    source: "/job/source.kicad_pcb",
    baseSha256: sha,
    modelSha256: "b".repeat(64),
    startedMs: 100,
    footprints: [{ ref: "R1", x: 12, y: 10, rotation: 20, locked: false }],
  };
  fs.writeFileSync(
    path.join(out, stem + ".manifest.json"),
    JSON.stringify(manifest),
  );
  fs.writeFileSync(path.join(out, stem + ".kicad_pcb"), board);
  const jobs = [
    {
      id: "job",
      name: "ENV-SENSE",
      state: "running",
      attempts: [{ n: 1, out }],
    },
  ];
  const live = new LiveHttp(root, path.join(root, "incoming"));
  const observer = () =>
    new LiveJobs(() => jobs, {
      importBoard: (b, s) => live.importBoard(b, s),
      append: (e) => live.journal.append(e),
    });
  const write = (rows: unknown[]) =>
    fs.writeFileSync(
      path.join(out, stem + ".ndjson"),
      rows.map((r) => JSON.stringify(r) + "\n").join(""),
    );
  return {
    root,
    out,
    id,
    stem,
    sha,
    jobs,
    live,
    observer,
    write,
    cleanup: () => {
      live.close();
      fs.rmSync(root, { recursive: true, force: true });
    },
  };
}
test("job-local deltas survive reader restart without duplication and keep attempt identity", async () => {
  const f = fixture();
  try {
    f.write([
      {
        kind: "route.activity",
        timeMs: 110,
        data: {
          net: "/SDA",
          pass: 1,
          action: "searching",
          path: [
            [1, 2],
            [3, 4],
          ],
        },
      },
      {
        kind: "route.delta",
        timeMs: 120,
        data: {
          addTracks: [
            {
              id: "t",
              net: "/SDA",
              layer: "F.Cu",
              a: [1, 2],
              b: [3, 4],
              width: 0.2,
              locked: false,
            },
          ],
          removeTracks: [],
          addVias: [],
          removeVias: [],
        },
      },
    ]);
    await f.observer().poll();
    const id = f.live.journal.list()[0].runId;
    assert.equal(f.live.journal.stateAt(id).tracks.size, 1);
    fs.writeFileSync(
      path.join(f.out, f.stem + ".done.json"),
      JSON.stringify({
        outcome: "passed",
        timeMs: 130,
        message: "native search ended",
      }),
    );
    const restarted = f.observer();
    await restarted.poll();
    await restarted.poll();
    assert.equal(f.live.journal.lastSeq(id), 5);
    assert.equal(f.live.journal.stateAt(id).finished?.verified, false);
    assert.match(id, /job:1:/);
    const second = path.join(f.root, "second");
    fs.cpSync(f.out, second, { recursive: true });
    f.jobs[0].attempts.push({ n: 2, out: second });
    await restarted.poll();
    assert.equal(f.live.journal.list().length, 2);
  } finally {
    f.cleanup();
  }
});
test("mapped placement frames rotate groups in KiCad coordinates", async () => {
  const f = fixture("placement");
  try {
    const units = [
      {
        refs: ["R1"],
        origin: [10, 10],
        position: [30, 40],
        turn: 1,
        locked: true,
      },
    ];
    f.write([
      {
        kind: "placement.sample",
        baseSha256: f.sha,
        attemptId: f.id,
        timeMs: 110,
        worker: 0,
        epoch: 1,
        step: 1,
        accepted: 1,
        rejected: 0,
        currentCost: 3,
        bestCost: 3,
        bestScope: "epoch",
        current: units,
        best: units,
      },
    ]);
    await f.observer().poll();
    assert.deepEqual(
      f.live.journal.stateAt(f.live.journal.list()[0].runId).placement!.current,
      [{ ref: "R1", x: 30, y: 38, rotation: 110, locked: true }],
    );
  } finally {
    f.cleanup();
  }
});
test("job-controlled symlinks and hardlinks cannot become source assets", async () => {
  const f = fixture();
  try {
    const board = path.join(f.out, f.stem + ".kicad_pcb");
    fs.renameSync(board, path.join(f.root, "private"));
    fs.symlinkSync(path.join(f.root, "private"), board);
    await f.observer().poll();
    assert.equal(f.live.journal.list().length, 0);
    fs.unlinkSync(board);
    fs.linkSync(path.join(f.root, "private"), board);
    await f.observer().poll();
    assert.equal(f.live.journal.list().length, 0);
  } finally {
    f.cleanup();
  }
});
test("source mapping leaves engineering-frozen model bytes unchanged", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "live-map-"));
  try {
    const stage = path.join(root, "stage");
    fs.mkdirSync(path.join(stage, "in"), { recursive: true });
    const board = path.join(root, "board.kicad_pcb");
    fs.writeFileSync(board, "(kicad_pcb)");
    const model = path.join(root, "prob.json");
    const bytes = JSON.stringify({
      board_file: board,
      units: [],
      engineering: { bind: "kept" },
    });
    fs.writeFileSync(model, bytes);
    stageLiveSources(root, stage, [model]);
    assert.equal(fs.readFileSync(model, "utf8"), bytes);
    const map = JSON.parse(
      fs.readFileSync(path.join(stage, ".pcb-live-sources.json"), "utf8"),
    );
    assert.equal(map[hash(bytes)].source, board);
    assert.equal(
      hash(fs.readFileSync(path.join(stage, map[hash(bytes)].file))),
      map[hash(bytes)].sha256,
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
test("failed delivery retries initial records and cannot silently settle", async () => {
  const f = fixture();
  try {
    f.write([
      {
        kind: "progress",
        timeMs: 110,
        data: {
          stage: "routing",
          elapsedMs: 10,
          message: "search",
          metrics: {},
        },
      },
    ]);
    fs.writeFileSync(
      path.join(f.out, f.stem + ".done.json"),
      JSON.stringify({ outcome: "passed", timeMs: 120, message: "done" }),
    );
    let fail = true;
    const reader = new LiveJobs(() => f.jobs, {
      importBoard: async (b, s) => {
        if (fail) {
          fail = false;
          throw Error("temporary transport failure");
        }
        await f.live.importBoard(b, s);
      },
      append: (e) => f.live.journal.append(e),
    });
    await reader.poll();
    assert.equal(reader.settled(), false);
    await reader.poll();
    assert.equal(reader.settled(), true);
    assert.equal(f.live.journal.list()[0].seq, 4);
  } finally {
    f.cleanup();
  }
});
test("job output cannot forge lifecycle or verification events", async () => {
  const f = fixture();
  try {
    f.write([
      {
        kind: "run.finished",
        timeMs: 110,
        data: {
          outcome: "passed",
          message: "forged",
          verified: true,
          candidateSha256: "a".repeat(64),
        },
      },
    ]);
    const reader = f.observer();
    await reader.poll();
    assert.equal(reader.settled(), false);
    assert.equal(
      f.live.journal.stateAt(f.live.journal.list()[0].runId).finished,
      null,
    );
  } finally {
    f.cleanup();
  }
});
test("an interrupted partial last frame ends unknown rather than hanging forever", async () => {
  const f = fixture();
  try {
    f.write([
      {
        kind: "progress",
        timeMs: 110,
        data: {
          stage: "routing",
          elapsedMs: 10,
          message: "search",
          metrics: {},
        },
      },
    ]);
    fs.appendFileSync(path.join(f.out, f.stem + ".ndjson"), '{"kind":');
    Object.assign(f.jobs[0].attempts[0], {
      endedAt: new Date(200).toISOString(),
    });
    const reader = f.observer();
    await reader.poll();
    await reader.poll();
    assert.equal(reader.settled(), true);
    const state = f.live.journal.stateAt(f.live.journal.list()[0].runId);
    assert.equal(state.seq, 4);
    assert.equal(state.finished?.outcome, "failed");
    assert.match(state.finished!.message, /unknown/);
  } finally {
    f.cleanup();
  }
});
const progress = (timeMs: number) => ({
  kind: "progress",
  timeMs,
  data: { stage: "routing", elapsedMs: 10, message: "search", metrics: {} },
});
test("after a restart a rebuilt verdict that differs does not leave the run unsettled; the journal's first verdict stays", async () => {
  const f = fixture();
  try {
    f.write([progress(110)]);
    Object.assign(f.jobs[0].attempts[0], { endedAt: new Date(200).toISOString() });
    f.jobs[0].state = "failed";
    const first = f.observer();
    await first.poll();
    assert.equal(first.settled(), true);
    const id = f.live.journal.list()[0].runId;
    assert.equal(f.live.journal.stateAt(id).finished?.outcome, "failed");
    // The reader restarts with no cursors. The job record has moved on, so the rebuilt verdict is not the stored one.
    f.jobs[0].state = "cancelled";
    const restarted = f.observer();
    await restarted.poll();
    assert.equal(restarted.settled(), true);
    assert.equal(f.live.journal.stateAt(id).finished?.outcome, "failed");
  } finally {
    f.cleanup();
  }
});
test("a conflict on any event other than the verdict still keeps the run unsettled", async () => {
  const f = fixture();
  try {
    f.write([progress(110)]);
    const reader = new LiveJobs(() => f.jobs, {
      importBoard: (b, s) => f.live.importBoard(b, s),
      append: () => {
        throw Error("Live event sequence reused with different content");
      },
    });
    await reader.poll();
    assert.equal(reader.settled(), false);
  } finally {
    f.cleanup();
  }
});
test("a complete last frame without its newline is read once the attempt has ended", async () => {
  const f = fixture();
  try {
    f.write([progress(110)]);
    fs.appendFileSync(path.join(f.out, f.stem + ".ndjson"), JSON.stringify(progress(120)));
    Object.assign(f.jobs[0].attempts[0], { endedAt: new Date(200).toISOString() });
    const reader = f.observer();
    await reader.poll();
    await reader.poll();
    assert.equal(reader.settled(), true);
    const state = f.live.journal.stateAt(f.live.journal.list()[0].runId);
    assert.equal(state.seq, 5, "started, snapshot, two progress frames, finished");
  } finally {
    f.cleanup();
  }
});
