import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import { test } from 'node:test';
import { Worker, coordinatorUrl, worktrees } from '../../../tools/pcb-live-worker.mts';
import { createServer } from '../src/server.ts';
import { rig, TOKEN } from './helpers.ts';

test('worker restricts insecure origins and discovers Git worktrees', () => {
  assert.equal(coordinatorUrl('http://100.93.34.43:8793/'), 'http://100.93.34.43:8793');
  for (const url of ['http://example.com', 'http://192.168.1.2', 'http://user:secret@127.0.0.1', 'http://127.0.0.1/?token=x'])
    assert.throws(() => coordinatorUrl(url));
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pcb-worktrees-')), root = path.join(tmp, 'repo'), other = path.join(tmp, 'other');
  try {
    fs.mkdirSync(root); assert.equal(spawnSync('git', ['init', '-q', root]).status, 0);
    assert.equal(spawnSync('git', ['-C', root, '-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '--allow-empty', '-qm', 'test']).status, 0);
    fs.mkdirSync(path.join(root, 'hardware-design/boards'), { recursive: true });
    assert.equal(spawnSync('git', ['-C', root, 'worktree', 'add', '-q', '--detach', other]).status, 0);
    fs.mkdirSync(path.join(other, 'hardware-design/boards'), { recursive: true });
    assert.deepEqual(worktrees(root).sort(), [fs.realpathSync(root), fs.realpathSync(other)].sort());
  } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
});

test('worker reports state, agent messages, large records, and board removal without losing later updates', async () => {
  const r = rig(), root = path.join(r.dir, 'project'), cad = path.join(root, 'hardware-design/boards/DEMO/cad');
  const run = path.join(root, '.gate/cli/run-1'), agent = path.join(root, '.gate/live-agent/DEMO');
  fs.mkdirSync(cad, { recursive: true }); fs.mkdirSync(run, { recursive: true }); fs.mkdirSync(agent, { recursive: true });
  const board = path.join(cad, 'demo.kicad_pcb'); fs.writeFileSync(board, 'board');
  fs.writeFileSync(path.join(root, 'hardware-design/boards/DEMO/gate.json'), JSON.stringify({ project: 'cad/demo' }));
  fs.writeFileSync(path.join(run, 'run.json'), JSON.stringify({ board: 'DEMO', operation: 'route', timeout_s: 90 }));
  fs.writeFileSync(path.join(run, 'state.json'), JSON.stringify({ status: 'running', elapsed_s: 2, active_stages: ['routing'], worker_pid: process.pid, updated_unix: Date.now() / 1000 }));
  fs.writeFileSync(path.join(run, 'events.jsonl'), JSON.stringify({ type: 'tool.output', text: 'x'.repeat(3 * 1024 * 1024) }) + '\n' + JSON.stringify({ type: 'run.end', status: 'passed' }) + '\n');
  fs.writeFileSync(path.join(run, 'notes.jsonl'), JSON.stringify({ kind: 'decision', message: 'Move connector' }) + '\n');
  fs.writeFileSync(path.join(agent, 'events.jsonl'), JSON.stringify({ state: 'message', message: 'Checking clearances' }) + '\n');
  const token = path.join(r.dir, 'token'); fs.writeFileSync(token, TOKEN);
  const server = createServer(r.mgr); await new Promise<void>(ok => server.listen(0, '127.0.0.1', ok));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const worker = new Worker({ project: root, projectId: 'project', host: 'mini', url, tokenFile: token,
    stateFile: path.join(r.dir, 'state.json'), interval: 1, discover: false, once: true });
  const events = async () => await (await fetch(url + '/live/events', { headers: { Authorization: `Bearer ${TOKEN}` } })).json() as { kind: string; data: Record<string, unknown>; eventId: string }[];
  try {
    await worker.syncEpoch(); await worker.scan();
    const first = await events();
    assert.ok(first.some(e => e.kind === 'run.state' && e.data.supervisorAlive === true && e.data.timeoutS === 90));
    assert.ok(first.some(e => e.kind === 'run.state' && e.data.boardKey === 'project/hardware-design/boards/DEMO/cad/demo.kicad_pcb'));
    assert.ok(first.some(e => e.kind === 'run.event' && e.data.type === 'run.event_oversize'));
    assert.ok(first.some(e => e.kind === 'run.event' && e.data.type === 'run.end'));
    assert.ok(first.some(e => e.kind === 'run.note' && e.data.message === 'Move connector'));
    assert.ok(first.some(e => e.kind === 'agent.message' && e.data.message === 'Checking clearances'));
    const original = fs.statSync(board); fs.unlinkSync(board); await worker.scan();
    fs.writeFileSync(board, 'board'); fs.utimesSync(board, original.atime, original.mtime); await worker.scan();
    const snapshots = (await events()).filter(e => e.kind === 'board.snapshot');
    assert.equal(snapshots.length, 2); assert.notEqual(snapshots[0].eventId, snapshots[1].eventId);
    assert.equal((await events()).filter(e => e.kind === 'board.removed').length, 1);
  } finally { server.closeAllConnections(); await new Promise<void>(ok => server.close(() => ok())); r.cleanup(); }
});

test('worker restarts a lock guardian only after confirmed run cleanup', { timeout: 10000 }, async () => {
  const r = rig(), root = path.join(r.dir, 'project'), run = path.join(root, '.gate/cli/run-recover');
  const guards = path.join(root, '.gate/live-guards'); fs.mkdirSync(run, { recursive: true }); fs.mkdirSync(guards, { recursive: true });
  fs.mkdirSync(path.join(root, 'hardware-design/boards'), { recursive: true });
  fs.writeFileSync(path.join(run, 'run.json'), JSON.stringify({ board: 'DEMO', root }));
  fs.writeFileSync(path.join(run, 'result.json'), JSON.stringify({ status: 'passed', cleanup: { complete: false } }));
  const token = path.join(r.dir, 'token'); fs.writeFileSync(token, TOKEN);
  const server = createServer(r.mgr); await new Promise<void>(ok => server.listen(0, '127.0.0.1', ok));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`, headers = { Authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' };
  const post = async (endpoint: string, body: unknown) => await fetch(url + endpoint, { method: 'POST', headers, body: JSON.stringify(body) });
  const lease = await (await post('/board-leases/acquire', { board: 'project/DEMO', owner: 'test', ttlMs: 30000 })).json();
  assert.equal((await post('/board-leases/commit-begin', { lease })).status, 200);
  const receipt = path.join(guards, 'recover.json');
  fs.writeFileSync(receipt, JSON.stringify({ schema: 1, root: fs.realpathSync(root), config: { url, tokenFile: token }, lease, board: 'DEMO', operation: 'route', runId: 'run-recover', runDir: run, previewDir: path.join(root, '.gate/live-previews') }));
  const worker = new Worker({ project: root, projectId: 'project', host: 'mini', url, tokenFile: token, stateFile: path.join(r.dir, 'state.json'), interval: 1, discover: false, once: true });
  try {
    await worker.syncEpoch(); await worker.scan();
    assert.ok(fs.existsSync(receipt));
    fs.writeFileSync(path.join(run, 'result.json'), JSON.stringify({ status: 'passed', cleanup: { complete: true } }));
    await worker.scan();
    for (let i = 0; i < 50 && fs.existsSync(receipt); i++) await new Promise(ok => setTimeout(ok, 100));
    assert.equal(fs.existsSync(receipt), false);
    const status = await (await fetch(url + '/board-leases/status?board=project%2FDEMO', { headers })).json() as { commitGeneration: number | null };
    assert.equal(status.commitGeneration, null);
  } finally { server.closeAllConnections(); await new Promise<void>(ok => server.close(() => ok())); r.cleanup(); }
});

test('recovery publishes a completed adoption only with matching sealed evidence', { timeout: 10000 }, async () => {
  const { createHash } = await import('node:crypto');
  const sha = (x: string | Buffer): string => createHash('sha256').update(x).digest('hex');
  const r = rig(), root = path.join(r.dir, 'project'), run = path.join(root, '.gate/cli/run-adopt'), guards = path.join(root, '.gate/live-guards');
  fs.mkdirSync(path.join(root, 'hardware-design/boards/DEMO/cad'), { recursive: true }); fs.mkdirSync(path.join(run, 'operation'), { recursive: true }); fs.mkdirSync(guards, { recursive: true });
  const target = path.join(root, 'hardware-design/boards/DEMO/cad/demo.kicad_pcb'); fs.writeFileSync(target, 'adopted');
  const token = path.join(r.dir, 'token'); fs.writeFileSync(token, TOKEN);
  const server = createServer(r.mgr); await new Promise<void>(ok => server.listen(0, '127.0.0.1', ok));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`, headers = { Authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' };
  const post = async (endpoint: string, body: unknown) => await fetch(url + endpoint, { method: 'POST', headers, body: JSON.stringify(body) });
  const lease = await (await post('/board-leases/acquire', { board: 'project/DEMO', owner: 'test', ttlMs: 30000 })).json();
  await post('/board-leases/commit-begin', { lease });
  await post('/board-revisions', { lease, expected: null, content: Buffer.from('original').toString('base64') });
  const runFile = path.join(run, 'run.json'), op = path.join(run, 'operation/result.json');
  fs.writeFileSync(runFile, JSON.stringify({ board: 'DEMO', root }));
  fs.writeFileSync(op, JSON.stringify({ candidate_verified: true, identity_preserved: true, protected_source_changes: [], candidate_sha256: sha('adopted') }));
  fs.writeFileSync(path.join(run, 'result.json'), JSON.stringify({ status: 'passed', cleanup: { complete: true }, candidate_sha256: sha('adopted'),
    evidence_sha256: { 'run.json': sha(fs.readFileSync(runFile)), 'operation/result.json': sha(fs.readFileSync(op)) } }));
  fs.writeFileSync(path.join(run, 'adoption.json'), JSON.stringify({ target, before_sha256: sha('original'), after_sha256: sha('adopted') }));
  const receipt = path.join(guards, 'adopt.json');
  fs.writeFileSync(receipt, JSON.stringify({ schema: 1, root: fs.realpathSync(root), config: { url, tokenFile: token }, lease, board: 'DEMO', operation: 'adopt',
    runId: 'run-adopt', runDir: run, previewDir: path.join(root, '.gate/live-previews'), target, before: sha('original'), revision: 1, guardPid: 99999998, writerPid: 99999999 }));
  const worker = new Worker({ project: root, projectId: 'project', host: 'mini', url, tokenFile: token, stateFile: path.join(r.dir, 'state.json'), interval: 1, discover: false, once: true });
  try {
    await worker.syncEpoch(); await worker.scan();
    for (let i = 0; i < 50 && fs.existsSync(receipt); i++) await new Promise(ok => setTimeout(ok, 100));
    assert.equal(fs.existsSync(receipt), false);
    const meta = await (await fetch(url + '/board-revisions?board=project%2FDEMO', { headers })).json() as { revision: number; sha256: string };
    assert.equal(meta.revision, 2); assert.equal(meta.sha256, sha('adopted'));
  } finally { server.closeAllConnections(); await new Promise<void>(ok => server.close(() => ok())); r.cleanup(); }
});

test('observes changing native candidate boards written by an existing placement pipeline', async () => {
  const r = rig(), root = path.join(r.dir, 'project'), run = path.join(root, '.gate/cli/run-place');
  const gate = path.join(run, 'workspace/hardware-design/boards/DEMO/gate.json');
  const work = path.join(run, 'operation/work/place/loop');
  fs.mkdirSync(path.dirname(gate), { recursive: true }); fs.mkdirSync(path.join(work, 'step-0/b'), { recursive: true });
  fs.writeFileSync(gate, JSON.stringify({ project: 'cad/demo' }));
  fs.writeFileSync(path.join(run, 'run.json'), JSON.stringify({ board: 'DEMO', operation: 'build' }));
  fs.writeFileSync(path.join(work, 'step-0/b/demo.kicad_pcb'), 'first candidate');
  const token = path.join(r.dir, 'token'); fs.writeFileSync(token, TOKEN);
  const server = createServer(r.mgr); await new Promise<void>(ok => server.listen(0, '127.0.0.1', ok));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const worker = new Worker({ project: root, projectId: 'project', host: 'mini', url, tokenFile: token,
    stateFile: path.join(r.dir, 'state.json'), interval: 1, discover: false, once: true });
  try {
    await worker.syncEpoch(); await worker.scanActivity();
    fs.mkdirSync(path.join(work, 'step-1/b'), { recursive: true });
    const next = path.join(work, 'step-1/b/demo.kicad_pcb'); fs.writeFileSync(next, 'second candidate');
    const future = new Date(Date.now() + 1000); fs.utimesSync(next, future, future);
    await worker.scanActivity();
    const records = await (await fetch(url + '/live/events', { headers: { Authorization: `Bearer ${TOKEN}` } })).json() as { kind: string; data: { sha256?: string } }[];
    const candidates = records.filter(e => e.kind === 'candidate.snapshot');
    assert.equal(candidates.length, 2); assert.notEqual(candidates[0].data.sha256, candidates[1].data.sha256);
  } finally { server.closeAllConnections(); await new Promise<void>(ok => server.close(() => ok())); r.cleanup(); }
});

test('a gate alias marks the owning board as active', async () => {
  const r = rig(), root = path.join(r.dir, 'project'), boards = path.join(root, 'hardware-design/boards');
  const run = path.join(root, '.gate/cli/run-alias');
  fs.mkdirSync(path.join(boards, 'ALIAS'), { recursive: true }); fs.mkdirSync(path.join(boards, 'OWNER/cad'), { recursive: true }); fs.mkdirSync(run, { recursive: true });
  fs.writeFileSync(path.join(boards, 'ALIAS/gate.json'), JSON.stringify({ project: '../OWNER/cad/demo' }));
  fs.writeFileSync(path.join(boards, 'OWNER/cad/demo.kicad_pcb'), 'board');
  fs.writeFileSync(path.join(run, 'run.json'), JSON.stringify({ board: 'ALIAS', operation: 'route' }));
  fs.writeFileSync(path.join(run, 'state.json'), JSON.stringify({ status: 'running', worker_pid: process.pid, updated_unix: Date.now() / 1000 }));
  const token = path.join(r.dir, 'token'); fs.writeFileSync(token, TOKEN);
  const server = createServer(r.mgr); await new Promise<void>(ok => server.listen(0, '127.0.0.1', ok));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const worker = new Worker({ project: root, projectId: 'project', host: 'mini', url, tokenFile: token, stateFile: path.join(r.dir, 'state.json'), interval: 1, discover: false, once: true });
  try {
    await worker.syncEpoch(); await worker.scan();
    const records = await (await fetch(url + '/live/events', { headers: { Authorization: `Bearer ${TOKEN}` } })).json() as { kind: string; board: string; data: { gate?: string } }[];
    assert.ok(records.some(e => e.kind === 'board.snapshot' && e.board === 'project/OWNER'));
    assert.ok(records.some(e => e.kind === 'run.state' && e.board === 'project/OWNER' && e.data.gate === 'ALIAS'));
  } finally { server.closeAllConnections(); await new Promise<void>(ok => server.close(() => ok())); r.cleanup(); }
});
