import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import type { AddressInfo } from 'node:net';
import { placementHistory } from '../../../tools/pcb-live-placement-history.mts';
import { Worker } from '../../../tools/pcb-live-worker.mts';
import { createServer } from '../src/server.ts';
import { rig, TOKEN } from './helpers.ts';

test('replay converts real epoch poses only for matching placer inputs and units', () => {
  const r = rig(), root = path.join(r.dir, 'project'), out = path.join(root, 'out'), step = path.join(out, 'step-0');
  fs.mkdirSync(path.join(step, 'search'), { recursive: true });
  const board = path.join(root, 'test.kicad_pcb'), problem = path.join(root, 'prob.json');
  fs.writeFileSync(board, 'board');
  const units = [{ refs: ['U1', 'R1'], x: 10, y: 20 }];
  fs.writeFileSync(problem, JSON.stringify({ board_file: board, units }));
  fs.writeFileSync(path.join(step, 'prob.json'), JSON.stringify({ units }));
  fs.writeFileSync(path.join(step, 'search/res.json'), JSON.stringify({ history: [
    { epoch: 1, cost: 40, pose: [[12, 23, 1]] }, { epoch: 2, cost: 30, pose: [[14, 25, 2]] }
  ] }));
  const sha = (file: string): string => createHash('sha256').update(fs.readFileSync(file)).digest('hex');
  fs.writeFileSync(path.join(out, 'input-manifest.json'), JSON.stringify({ board, board_sha256: sha(board), problem_sha256: sha(problem), configuration: { prob: problem } }));
  try {
    const replay = placementHistory(root, root, out, step);
    assert.equal(replay.frames.length, 2);
    const first = JSON.parse(replay.frames[0].toString());
    assert.deepEqual(first.units[0], { refs: ['U1', 'R1'], origin: [10, 20], position: [12, 23], turn: 1 });
    fs.writeFileSync(board, 'changed');
    assert.throws(() => placementHistory(root, root, out, step), /no longer match/);
  } finally { r.cleanup(); }
});

test('worker publishes completed placement steps in order across bounded scans and restart', async () => {
  const r = rig(), root = path.join(r.dir, 'project'), out = path.join(root, 'out');
  fs.mkdirSync(path.join(root, 'hardware-design/boards/DEMO/cad'), { recursive: true }); fs.mkdirSync(out);
  const board = path.join(root, 'hardware-design/boards/DEMO/cad/demo.kicad_pcb'), prob = path.join(root, 'prob.json');
  fs.writeFileSync(board, 'board'); const units = [{ refs: ['U1'], x: 1, y: 2 }];
  fs.writeFileSync(prob, JSON.stringify({ board_file: board, units }));
  const sha = (file: string): string => createHash('sha256').update(fs.readFileSync(file)).digest('hex');
  fs.writeFileSync(path.join(out, 'input-manifest.json'), JSON.stringify({ board, board_sha256: sha(board), problem_sha256: sha(prob), configuration: { prob } }));
  for (const [step, count] of [[0, 7], [1, 2]]) {
    const dir = path.join(out, `step-${step}`); fs.mkdirSync(path.join(dir, 'search'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'prob.json'), JSON.stringify({ units }));
    fs.writeFileSync(path.join(dir, 'search/res.json'), JSON.stringify({ history: Array.from({ length: count }, (_, i) => ({ epoch: i + 1, cost: 10, pose: [[i, 2, 0]] })) }));
  }
  const token = path.join(r.dir, 'token'); fs.writeFileSync(token, TOKEN);
  const server = createServer(r.mgr); await new Promise<void>(ok => server.listen(0, '127.0.0.1', ok));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const args = { project: root, projectId: 'p', host: 'mini', url, tokenFile: token, stateFile: path.join(r.dir, 'state'), interval: 1, discover: false, once: true };
  const run = { pid: process.pid, started: 'test', root, board: 'DEMO', outdir: out, boardFile: board, elapsed: 10, timeout: 60, stage: 'placement', runId: 'external-test' };
  try {
    let worker = new Worker(args); await worker.syncEpoch(); await worker.scanExternal([run]);
    worker = new Worker(args); await worker.syncEpoch(); await worker.scanExternal([run]); await worker.scanExternal([run]); await worker.scanExternal([run]);
    const query = new URLSearchParams({ source: worker.source, board: 'p/DEMO', run: run.runId });
    const result = await (await fetch(url + '/live/history?' + query, { headers: { Authorization: `Bearer ${TOKEN}` } })).json() as { events: { data: { epoch: number } }[] };
    assert.deepEqual(result.events.map(e => e.data.epoch), [1, 2, 3, 4, 5, 6, 7, 1, 2]);
  } finally { server.closeAllConnections(); await new Promise<void>(ok => server.close(() => ok())); r.cleanup(); }
});
