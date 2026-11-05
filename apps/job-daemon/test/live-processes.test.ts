import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import { test } from 'node:test';
import { discoverExternal, parseElapsed, parseProcessTable } from '../../../tools/pcb-live-processes.mts';
import { Worker } from '../../../tools/pcb-live-worker.mts';
import { createServer } from '../src/server.ts';
import { rig, TOKEN } from './helpers.ts';

test('discovers an owned placement process and its actual routing child', async () => {
  const r = rig(), root = path.join(r.dir, 'project'), out = path.join(r.dir, 'placement output');
  fs.mkdirSync(path.join(root, 'hardware-design/boards/DEMO'), { recursive: true });
  fs.mkdirSync(path.join(out, 'step-1/b'), { recursive: true });
  fs.writeFileSync(path.join(out, 'step-1/b/DEMO.kicad_pcb'), 'candidate');
  fs.writeFileSync(path.join(out, 'stages.jsonl'), JSON.stringify({ stage: 'placement', status: 'complete', command: ['secret-must-not-leak'] }) + '\n');
  fs.writeFileSync(path.join(out, 'step-1/search.log'), 'epoch 1/5 best 123\n');
  const uid = process.getuid!(), pid = 99999999;
  const text = ` ${pid} 1 ${uid} 01:02 Mon Jan  1 12:00:00 2024 node tools/placer/compact_cli.py in.json /tmp/DEMO.kicad_pcb --board-dir hardware-design/boards/DEMO/cad/DEMO --outdir ${out} --budget 300\n` +
    ` 88888888 ${pid} ${uid} 00:10 Mon Jan  1 12:01:00 2024 node tools/router/run.py DEMO output\n`;
  const rows = parseProcessTable(text), realRoot = fs.realpathSync(root);
  assert.equal(parseElapsed('1-02:03:04'), 93784);
  const found = discoverExternal([realRoot], rows, () => realRoot)!;
  assert.equal(found.length, 1); assert.equal(found[0].board, 'DEMO'); assert.equal(found[0].stage, 'routing'); assert.equal(found[0].timeout, 300);
  const token = path.join(r.dir, 'token'); fs.writeFileSync(token, TOKEN);
  const server = createServer(r.mgr); await new Promise<void>(ok => server.listen(0, '127.0.0.1', ok));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`, headers = { Authorization: `Bearer ${TOKEN}` };
  const worker = new Worker({ project: root, projectId: 'project', host: 'mini', url, tokenFile: token,
    stateFile: path.join(r.dir, 'state.json'), interval: 1, discover: false, once: true });
  try {
    await worker.syncEpoch(); await worker.scanExternal(found);
    let events = await (await fetch(url + '/live/events', { headers })).json() as { kind: string; data: Record<string, unknown> }[];
    assert.ok(events.some(e => e.kind === 'run.state' && e.data.coordinated === false && (e.data.active_stages as string[])[0] === 'routing'));
    assert.ok(events.some(e => e.kind === 'candidate.snapshot'));
    assert.ok(events.some(e => e.kind === 'run.event' && e.data.stage === 'placement'));
    assert.equal(JSON.stringify(events).includes('secret-must-not-leak'), false);
    await worker.scanExternal([]);
    events = await (await fetch(url + '/live/events', { headers })).json() as { kind: string; data: Record<string, unknown> }[];
    assert.ok(events.some(e => e.kind === 'run.state' && e.data.status === 'stopped'));
  } finally { server.closeAllConnections(); await new Promise<void>(ok => server.close(() => ok())); r.cleanup(); }
});
