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

/** Runs the client with no daemon: these cases upload nothing. */
function runClient(args: string[]): Promise<number | null> {
  return new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      ["--experimental-strip-types", "--no-warnings", fileURLToPath(new URL("../src/client.ts", import.meta.url)), ...args],
      { env: { ...process.env, JOBD_URL: "http://127.0.0.1:9", JOBD_TOKEN: "fixture-token" }, stdio: "ignore" },
    );
    child.on("error", reject);
    child.on("close", resolve);
  });
}

test("a command that cannot start ends once, with code 127 and a failed record", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "live-local-"));
  try {
    const spool = path.join(root, "spool");
    const code = await runClient(["observe", spool, "--", path.join(root, "no-such-command")]);
    assert.equal(code, 127);
    const dirs = fs.readdirSync(spool);
    assert.equal(dirs.length, 1);
    const meta = JSON.parse(fs.readFileSync(path.join(spool, dirs[0]!, "observer.json"), "utf8"));
    assert.equal(meta.state, "failed");
    assert.equal(meta.exitCode, 127);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("resuming an interrupted observation does not report success", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "live-local-"));
  try {
    fs.writeFileSync(
      path.join(root, "observer.json"),
      JSON.stringify({ id: "local-x", name: "spool", state: "running", attempts: [{ n: 1, out: root }] }),
    );
    assert.equal(await runClient(["observe-resume", root]), 1);
    const meta = JSON.parse(fs.readFileSync(path.join(root, "observer.json"), "utf8"));
    assert.equal(meta.state, "failed");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("resuming a finished observation keeps the recorded command exit", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "live-local-"));
  try {
    fs.writeFileSync(
      path.join(root, "observer.json"),
      JSON.stringify({ id: "local-x", name: "spool", state: "failed", exitCode: 3, attempts: [{ n: 1, out: root, endedAt: "2026-11-04T12:00:00Z" }] }),
    );
    assert.equal(await runClient(["observe-resume", root]), 3);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
