import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

test("ordinary local observer uploads native records and preserves command exit", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "live-local-")),
    events: { kind: string; data: { verified?: boolean } }[] = [];
  const server = http.createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const b of req) chunks.push(b);
    assert.equal(req.headers.authorization, "Bearer fixture-token");
    if (req.url === "/live/events")
      events.push(...JSON.parse(Buffer.concat(chunks).toString()).events);
    res.end("{}");
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const producer = path.join(root, "producer.cjs");
  fs.writeFileSync(
    producer,
    `const fs=require('fs'),p=require('path'),c=require('crypto');const d=process.env.PCB_LIVE_DIR,id='a'.repeat(24),s=p.join(d,'pcb-live-'+id),board='(kicad_pcb)',sha=c.createHash('sha256').update(board).digest('hex');fs.writeFileSync(s+'.kicad_pcb',board);fs.writeFileSync(s+'.manifest.json',JSON.stringify({schema:'pcb-job-live.v1',id,operation:'routing',source:'source.kicad_pcb',baseSha256:sha,modelSha256:'b'.repeat(64),startedMs:100,footprints:[]}));fs.writeFileSync(s+'.ndjson',JSON.stringify({kind:'progress',timeMs:110,data:{stage:'routing',elapsedMs:10,message:'native',metrics:{}}})+'\\n');fs.writeFileSync(s+'.done.json',JSON.stringify({outcome:'failed',timeMs:120,message:'native failure'}));process.exit(3);`,
  );
  try {
    const code = await new Promise<number | null>((resolve, reject) => {
      const child = spawn(
        process.execPath,
        [
          "--experimental-strip-types",
          "--no-warnings",
          fileURLToPath(new URL("../src/client.ts", import.meta.url)),
          "observe",
          path.join(root, "spool"),
          "--",
          process.execPath,
          producer,
        ],
        {
          env: {
            ...process.env,
            JOBD_URL: `http://127.0.0.1:${(server.address() as { port: number }).port}`,
            JOBD_TOKEN: "fixture-token",
          },
          stdio: "pipe",
        },
      );
      let error = "";
      child.stderr.on("data", (b) => (error += b));
      child.on("error", reject);
      child.on("close", (c) => (error ? reject(new Error(error)) : resolve(c)));
    });
    assert.equal(code, 3);
    assert.deepEqual(
      events.map((e) => e.kind),
      ["run.started", "board.snapshot", "progress", "run.finished"],
    );
    assert.equal(events.at(-1)?.data.verified, false);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((r) => server.close(() => r()));
    fs.rmSync(root, { recursive: true, force: true });
  }
});
