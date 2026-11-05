import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { placements } from "./pcb-live-run.mts";
import { fromBytes } from "../apps/studio/app/src/main/kicad/board.ts";
import { replayLiveEvents } from "../apps/job-daemon/src/live-protocol.ts";
import type { LiveEvent } from "../apps/job-daemon/src/live-protocol.ts";
const board = Buffer.from(
  '(kicad_pcb (version 20241229) (layers (0 "F.Cu" signal) (31 "B.Cu" signal)) (footprint "R" (layer "F.Cu") (at 12 10 20) (property "Reference" "R1") (pad "1" smd rect (at 0 0) (size 1 1) (layers "F.Cu"))))',
);
test("group placement follows KiCad y-down rotation and preserves footprint angle", () => {
  assert.deepEqual(
    placements(
      [
        {
          refs: ["R1"],
          origin: [10, 10],
          position: [30, 40],
          turn: 1,
          locked: true,
        },
      ],
      fromBytes(board),
    ),
    [{ ref: "R1", x: 30, y: 38, rotation: 110, locked: true }],
  );
});
test("worker records native events and retries the same sequence after lost acknowledgment", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "live-worker-"));
  fs.writeFileSync(path.join(dir, "board.kicad_pcb"), board);
  fs.writeFileSync(path.join(dir, "token"), "a".repeat(64));
  let lost = false;
  const events = new Map<number, LiveEvent>();
  let requests = 0;
  const server = http.createServer(async (req, res) => {
    assert.equal(req.headers.authorization, "Bearer " + "a".repeat(64));
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk);
    if (req.url === "/live/events") {
      requests++;
      for (const e of JSON.parse(Buffer.concat(chunks).toString()).events) {
        if (events.has(e.seq)) assert.deepEqual(events.get(e.seq), e);
        events.set(e.seq, e);
      }
      if (!lost) {
        lost = true;
        res.destroy();
        return;
      }
    }
    res.end("{}");
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as { port: number }).port;
  const producer = path.join(dir, "producer.cjs");
  fs.writeFileSync(
    producer,
    `const fs=require('fs');fs.writeFileSync(process.env.PCB_LIVE_EVENTS,JSON.stringify({kind:'route.activity',data:{net:'A',pass:1,action:'searching',path:[[1,2],[3,4]]}})+'\\n');console.log('ROUTE FAIL unresolved 1');`,
  );
  const run = (extra: string[], command: string[]): Promise<number | null> =>
    new Promise((resolve, reject) => {
      const p = spawn(
        process.execPath,
        [
          "--experimental-strip-types",
          "--no-warnings",
          fileURLToPath(new URL("./pcb-live-run.mts", import.meta.url)),
          "--spool",
          path.join(dir, "spool"),
          "--url",
          `http://127.0.0.1:${port}`,
          "--token-file",
          path.join(dir, "token"),
          ...extra,
          ...command,
        ],
        { stdio: "pipe" },
      );
      let err = "";
      p.stderr.on("data", (b) => (err += b));
      p.on("error", reject);
      p.on("exit", (c) => (c === 0 ? resolve(c) : reject(new Error(err))));
    });
  try {
    await run(
      ["--board", path.join(dir, "board.kicad_pcb"), "--operation", "routing"],
      ["--", process.execPath, producer],
    );
    assert.ok(requests >= 2);
    const state = replayLiveEvents([...events.values()][0].runId, [
      ...events.values(),
    ]);
    assert.equal(state.activity?.net, "A");
    assert.equal(state.finished?.outcome, "failed");
    assert.match(state.finished!.message, /FAIL/);
    const count = events.size;
    await run(["--resume"], []);
    assert.equal(events.size, count);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((r) => server.close(() => r()));
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
