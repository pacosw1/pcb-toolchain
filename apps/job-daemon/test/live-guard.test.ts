import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import { test } from 'node:test';
import { createServer } from '../src/server.ts';
import { rig, TOKEN } from './helpers.ts';
import { verifiedCandidate } from '../../../tools/pcb-live-guard.mts';
import { createHash } from 'node:crypto';

const guard = path.resolve('..', '..', 'tools', 'pcb-live-guard.mts');
const wait = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms));

test('recovery refuses changed sealed evidence', () => {
  const r = rig(), folder = path.join(r.dir, 'sealed'); fs.mkdirSync(path.join(folder, 'operation'), { recursive: true });
  const sha = (v: string): string => createHash('sha256').update(v).digest('hex');
  try {
    fs.writeFileSync(path.join(folder, 'run.json'), '{}');
    const op = JSON.stringify({ candidate_verified: true, identity_preserved: true, protected_source_changes: [], candidate_sha256: sha('board') });
    fs.writeFileSync(path.join(folder, 'operation/result.json'), op);
    fs.writeFileSync(path.join(folder, 'result.json'), JSON.stringify({ status: 'passed', cleanup: { complete: true }, candidate_sha256: sha('board'),
      evidence_sha256: { 'run.json': sha('{}'), 'operation/result.json': sha(op) } }));
    assert.equal(verifiedCandidate(folder, sha('board')), true);
    fs.writeFileSync(path.join(folder, 'operation/result.json'), '{}');
    assert.equal(verifiedCandidate(folder, sha('board')), false);
  } finally { r.cleanup(); }
});

test('detached writers keep a board pinned until verified cleanup', { timeout: 20000 }, async () => {
  const r = rig(), root = path.join(r.dir, 'project'), cad = path.join(root, 'hardware-design/boards/DEMO/cad');
  fs.mkdirSync(cad, { recursive: true }); fs.writeFileSync(path.join(cad, 'demo.kicad_pcb'), 'original');
  fs.writeFileSync(path.join(root, 'hardware-design/boards/DEMO/gate.json'), JSON.stringify({ project: 'cad/demo' }));
  fs.writeFileSync(path.join(root, '.pcb-live.json'), JSON.stringify({ projectId: 'project' }));
  const token = path.join(r.dir, 'token'); fs.writeFileSync(token, TOKEN);
  const server = createServer(r.mgr); await new Promise<void>(ok => server.listen(0, '127.0.0.1', ok));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const config = path.join(r.dir, 'config.json'); fs.writeFileSync(config, JSON.stringify({ url, tokenFile: token }));
  const fixture = path.join(r.dir, 'fixture.mjs');
  fs.writeFileSync(fixture, `import fs from 'node:fs'; import path from 'node:path'; import {spawn} from 'node:child_process';
const root=process.env.IOT_LAB,id=process.env.TEST_RUN,dir=path.join(root,'.gate/cli',id);
fs.mkdirSync(dir,{recursive:true});fs.writeFileSync(path.join(dir,'run.json'),JSON.stringify({root,board:'DEMO'}));
const code='setTimeout(()=>require("fs").writeFileSync('+JSON.stringify(path.join(root,'.gate/cli'))+'+"/"+process.env.TEST_RUN+"/result.json",JSON.stringify({status:"passed",cleanup:{complete:true}})),1800)';
const child=spawn(process.execPath,['-e',code],{detached:true,stdio:'ignore',env:process.env});child.unref();
console.log(JSON.stringify({run_id:id,status:'starting'}));`);
  const env = { ...process.env, IOT_LAB: root, PCB_LIVE_CONFIG: config, TEST_RUN: 'run-one' };
  const runGuard = (run: string) => spawn(process.execPath, ['--experimental-strip-types', '--no-warnings', guard, '--project', root, '--',
    process.execPath, fixture, 'route', 'DEMO', '--detach', '--json'], { cwd: root, env: { ...env, TEST_RUN: run }, stdio: ['ignore', 'pipe', 'pipe'] });
  const exited = (p: ReturnType<typeof spawn>): Promise<number | null> => new Promise((ok, reject) => { p.once('error', reject); p.once('close', code => ok(code)); });
  const headers = { Authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' };
  const key = 'project/hardware-design/boards/DEMO/cad/demo.kicad_pcb';
  const probe = () => fetch(url + '/board-leases/acquire', { method: 'POST', headers, body: JSON.stringify({ board: key, owner: 'contender', ttlMs: 30000 }) });
  try {
    const first = runGuard('run-one'); assert.equal(await exited(first), 0);
    assert.equal((await probe()).status, 409, 'detached caller exited while work continues');
    let available: Response | undefined;
    for (let i = 0; i < 60; i++) { await wait(100); const response = await probe(); if (response.status === 201) { available = response; break; } }
    assert.ok(available, 'guardian released after confirmed cleanup');
    const lease = await available.json();
    await fetch(url + '/board-leases/release', { method: 'POST', headers, body: JSON.stringify({ lease }) });
  } finally {
    server.closeAllConnections(); await new Promise<void>(ok => server.close(() => ok())); r.cleanup();
  }
});

test('adoption publishes the verified target and refuses a diverged checkout', { timeout: 20000 }, async () => {
  const r = rig(), root = path.join(r.dir, 'project'), cad = path.join(root, 'hardware-design/boards/DEMO/cad');
  fs.mkdirSync(cad, { recursive: true }); const target = path.join(cad, 'demo.kicad_pcb'); fs.writeFileSync(target, 'original');
  fs.writeFileSync(path.join(root, 'hardware-design/boards/DEMO/gate.json'), JSON.stringify({ project: 'cad/demo' }));
  fs.writeFileSync(path.join(root, '.pcb-live.json'), JSON.stringify({ projectId: 'project' }));
  const run = path.join(root, '.gate/cli/run-adopt'); fs.mkdirSync(run, { recursive: true });
  fs.writeFileSync(path.join(run, 'run.json'), JSON.stringify({ board: 'DEMO', root }));
  const token = path.join(r.dir, 'token'); fs.writeFileSync(token, TOKEN);
  const server = createServer(r.mgr); await new Promise<void>(ok => server.listen(0, '127.0.0.1', ok));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const config = path.join(r.dir, 'config.json'); fs.writeFileSync(config, JSON.stringify({ url, tokenFile: token }));
  const fixture = path.join(r.dir, 'adopt.mjs');
  fs.writeFileSync(fixture, `import fs from 'node:fs'; import {createHash} from 'node:crypto';
const target=process.env.TEST_BOARD,receipt=process.env.TEST_RECEIPT,sha=s=>createHash('sha256').update(s).digest('hex');
const before=fs.readFileSync(target);fs.writeFileSync(target,'adopted');const after=fs.readFileSync(target);
const result={before_sha256:sha(before),after_sha256:sha(after)};fs.writeFileSync(receipt,JSON.stringify(result));console.log(JSON.stringify(result));`);
  const invoke = (): Promise<{ code: number | null; out: string }> => new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--experimental-strip-types', '--no-warnings', guard, '--project', root, '--',
      process.execPath, fixture, 'adopt', 'run-adopt', '--json'], { cwd: root, env: { ...process.env, IOT_LAB: root, PCB_LIVE_CONFIG: config,
        TEST_BOARD: target, TEST_RECEIPT: path.join(run, 'adoption.json') }, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = ''; child.stdout.on('data', chunk => { out += chunk.toString(); }); child.once('error', reject); child.once('close', code => resolve({ code, out }));
  });
  try {
    const first = await invoke(); assert.equal(first.code, 0, first.out); assert.equal(fs.readFileSync(target, 'utf8'), 'adopted');
    const key = encodeURIComponent('project/hardware-design/boards/DEMO/cad/demo.kicad_pcb');
    const meta = await (await fetch(url + '/board-revisions?board=' + key, { headers: { Authorization: `Bearer ${TOKEN}` } })).json() as { revision: number; sha256: string };
    assert.equal(meta.revision, 2);
    fs.writeFileSync(target, 'diverged');
    const next = await invoke(); assert.equal(next.code, 2); assert.match(next.out, /differs from the coordinator revision/);
    assert.equal(fs.readFileSync(target, 'utf8'), 'diverged');
  } finally { server.closeAllConnections(); await new Promise<void>(ok => server.close(() => ok())); r.cleanup(); }
});

test('a CLI validation failure before run creation releases its pin', async () => {
  const r = rig(), root = path.join(r.dir, 'project'), cad = path.join(root, 'hardware-design/boards/DEMO/cad');
  fs.mkdirSync(cad, { recursive: true }); fs.writeFileSync(path.join(cad, 'demo.kicad_pcb'), 'board');
  fs.writeFileSync(path.join(root, 'hardware-design/boards/DEMO/gate.json'), JSON.stringify({ project: 'cad/demo' }));
  fs.writeFileSync(path.join(root, '.pcb-live.json'), JSON.stringify({ projectId: 'project' }));
  const token = path.join(r.dir, 'token'); fs.writeFileSync(token, TOKEN);
  const server = createServer(r.mgr); await new Promise<void>(ok => server.listen(0, '127.0.0.1', ok));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`, config = path.join(r.dir, 'config.json');
  fs.writeFileSync(config, JSON.stringify({ url, tokenFile: token }));
  const fixture = path.join(r.dir, 'fail.mjs'); fs.writeFileSync(fixture, 'console.log(JSON.stringify({status:"error",cause:"invalid policy"})); process.exit(2);');
  const headers = { Authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' };
  try {
    const result = await new Promise<number | null>((resolve, reject) => {
      const child = spawn(process.execPath, ['--experimental-strip-types', '--no-warnings', guard, '--project', root, '--', process.execPath,
        fixture, 'route', 'DEMO', '--json'], { env: { ...process.env, PCB_LIVE_CONFIG: config }, stdio: 'ignore' });
      child.once('error', reject); child.once('close', resolve);
    });
    assert.equal(result, 2);
    const board = 'project/hardware-design/boards/DEMO/cad/demo.kicad_pcb';
    const response = await fetch(url + '/board-leases/acquire', { method: 'POST', headers, body: JSON.stringify({ board, owner: 'next', ttlMs: 30000 }) });
    assert.equal(response.status, 201);
  } finally { server.closeAllConnections(); await new Promise<void>(ok => server.close(() => ok())); r.cleanup(); }
});
