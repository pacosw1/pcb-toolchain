import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import { test } from 'node:test';
import { createServer } from '../src/server.ts';
import { rig, TOKEN } from './helpers.ts';

type Recorded = { kind: string; run: string; data: { type?: string; sha256?: string } };
test('worker sends board and CLI progress, resumes after restart without replaying acknowledged records', { timeout: 20_000 }, async () => {
  const r = rig();
  const project = path.join(r.dir, 'project');
  const cad = path.join(project, 'hardware-design/boards/DEMO/cad');
  const run = path.join(project, '.gate/cli/run-test');
  fs.mkdirSync(cad, { recursive: true }); fs.mkdirSync(run, { recursive: true });
  fs.writeFileSync(path.join(cad, 'demo.kicad_pcb'), '(kicad_pcb)');
  fs.writeFileSync(path.join(run, 'run.json'), JSON.stringify({ board: 'DEMO' }));
  fs.writeFileSync(path.join(run, 'events.jsonl'), '{"type":"run.start"}\n');
  const tokenFile = path.join(r.dir, 'token'); fs.writeFileSync(tokenFile, TOKEN, { mode: 0o600 });
  const stateFile = path.join(r.dir, 'worker.json');
  const server = createServer(r.mgr);
  await new Promise<void>(ok => server.listen(0, '127.0.0.1', ok));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const workerFile = path.resolve('..', '..', 'tools', 'pcb-live-worker.mts');
  let worker = start();
  function start() {
    return spawn(process.execPath, ['--experimental-strip-types', '--no-warnings', workerFile, '--project', project, '--project-id', 'fixture', '--host', 'mini',
      '--url', url, '--token-file', tokenFile, '--state-file', stateFile, '--interval', '1'], { stdio: 'ignore' });
  }
  async function events() {
    const response = await fetch(url + '/live/events', { headers: { Authorization: `Bearer ${TOKEN}` } });
    return await response.json() as Recorded[];
  }
  async function until(predicate: (items: Recorded[]) => boolean) {
    const end = Date.now() + 8000;
    while (Date.now() < end) {
      const list = await events();
      if (predicate(list)) return list;
      await new Promise(ok => setTimeout(ok, 100));
    }
    throw new Error('worker did not publish expected events');
  }
  try {
    const first = await until(list => list.some(e => e.kind === 'board.snapshot') && list.some(e => e.kind === 'run.event'));
    const hash = first.find(e => e.kind === 'board.snapshot')!.data.sha256!;
    const blob = await fetch(url + '/blobs/' + hash, { headers: { Authorization: `Bearer ${TOKEN}` } });
    assert.equal(await blob.text(), '(kicad_pcb)');
    worker.kill('SIGTERM');
    await new Promise<void>(ok => worker.once('exit', () => ok()));
    fs.appendFileSync(path.join(run, 'events.jsonl'), '{"type":"run.end"}\n');
    worker = start();
    const replay = await until(list => list.some(e => e.kind === 'run.event' && e.data.type === 'run.end'));
    assert.equal(replay.filter(e => e.kind === 'run.event' && e.data.type === 'run.start').length, 1);
    assert.equal(replay.filter(e => e.kind === 'board.snapshot').length, 1);
  } finally {
    worker.kill('SIGTERM');
    await new Promise<void>(ok => worker.once('exit', () => ok()));
    server.closeAllConnections(); await new Promise<void>(ok => server.close(() => ok()));
    r.cleanup();
  }
});

test('coordinator restart preserves history identity and replay cursor', async () => {
  const r = rig();
  const start = async () => {
    const server = createServer(r.mgr);
    await new Promise<void>(ok => server.listen(0, '127.0.0.1', ok));
    return { server, url: `http://127.0.0.1:${(server.address() as AddressInfo).port}` };
  };
  const stop = async (server: ReturnType<typeof createServer>) => {
    server.closeAllConnections(); await new Promise<void>(ok => server.close(() => ok()));
  };
  let current = await start();
  const headers = { Authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' };
  try {
    const input = { source: 'mini', eventId: 'one', host: 'mini', board: 'p/b', run: 'r', kind: 'run.event', data: { type: 'run.start' } };
    const response = await fetch(current.url + '/live/events', { method: 'POST', headers, body: JSON.stringify(input) });
    const event = await response.json() as { cursor: number };
    const before = await (await fetch(current.url + '/live/state', { headers })).json() as { epoch: string };
    await stop(current.server);
    current = await start();
    const after = await (await fetch(current.url + '/live/state', { headers })).json() as { epoch: string };
    assert.equal(after.epoch, before.epoch);
    const replay = await (await fetch(`${current.url}/live/events?after=0&epoch=${after.epoch}`, { headers })).json() as { cursor: number }[];
    assert.deepEqual(replay.map(e => e.cursor), [event.cursor]);
  } finally { await stop(current.server); r.cleanup(); }
});
