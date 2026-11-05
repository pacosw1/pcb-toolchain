import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import { test } from 'node:test';
import { rig, TOKEN } from './helpers.ts';

test('board inventory is published while a backlog upload is blocked', { timeout: 15000 }, async () => {
  const r = rig(), root = path.join(r.dir, 'project'), cad = path.join(root, 'hardware-design/boards/DEMO/cad'), run = path.join(root, '.gate/cli/run-test');
  fs.mkdirSync(cad, { recursive: true }); fs.mkdirSync(run, { recursive: true });
  fs.writeFileSync(path.join(cad, 'demo.kicad_pcb'), 'board');
  fs.writeFileSync(path.join(run, 'run.json'), JSON.stringify({ board: 'DEMO' }));
  fs.writeFileSync(path.join(run, 'events.jsonl'), JSON.stringify({ type: 'tool.output', text: 'log' }) + '\n');
  const token = path.join(r.dir, 'token'); fs.writeFileSync(token, TOKEN);
  let batchStarted = false, boardPublished = false, blobAttempts = 0, releaseBatch: (() => void) | null = null;
  const server = createServer((req, res) => {
    let body = ''; req.on('data', chunk => { body += chunk; }); req.on('end', () => {
      const reply = (value: unknown): void => { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify(value)); };
      if (req.url === '/live/identity') return reply({ epoch: 'one', maxSnapshotBytes: 100000 });
      if (req.url === '/blobs/missing') return reply({ missing: [] });
      if (req.url?.startsWith('/live/models')) return reply([]);
      if (req.url === '/live/events/batch') { batchStarted = true; releaseBatch = () => reply([]); return; }
      if (req.url === '/live/events') { if (JSON.parse(body).kind === 'board.snapshot') boardPublished = true; return reply({}); }
      if (req.url?.startsWith('/blobs/')) {
        if (++blobAttempts === 1) { res.writeHead(503); res.end(); return; }
        return reply({});
      }
      res.writeHead(404); res.end();
    });
  });
  await new Promise<void>(ok => server.listen(0, '127.0.0.1', ok));
  const worker = path.resolve('..', '..', 'tools/pcb-live-worker.mts');
  const child = spawn(process.execPath, ['--no-warnings', '--experimental-strip-types', worker, '--project', root, '--project-id', 'p', '--url', `http://127.0.0.1:${(server.address() as AddressInfo).port}`, '--token-file', token, '--state-file', path.join(r.dir, 'state'), '--interval', '1'], { stdio: 'ignore' });
  try {
    const deadline = Date.now() + 7000;
    while ((!batchStarted || !boardPublished) && Date.now() < deadline) await new Promise(ok => setTimeout(ok, 50));
    assert.equal(batchStarted, true);
    assert.equal(boardPublished, true, 'inventory must not wait for the blocked activity batch');
    assert.ok(blobAttempts >= 2, 'temporary upload saturation is retried');
  } finally {
    if (releaseBatch) (releaseBatch as () => void)();
    child.kill(); await new Promise<void>(ok => child.once('close', () => ok()));
    server.closeAllConnections(); await new Promise<void>(ok => server.close(() => ok())); r.cleanup();
  }
});
