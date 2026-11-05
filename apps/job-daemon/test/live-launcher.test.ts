import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import { test } from 'node:test';
import { createServer } from '../src/server.ts';
import { rig, TOKEN } from './helpers.ts';

const repo = path.resolve('..', '..');
test('registered projects retain their pinned legacy CLI inside the new lock guard', { timeout: 15000 }, async () => {
  const r = rig(), home = path.join(r.dir, 'home'), root = path.join(r.dir, 'project'), bundle = path.join(home, '.local/share/pcb-toolchain/new');
  const cad = path.join(root, 'hardware-design/boards/DEMO/cad'), old = path.join(home, '.local/share/pcb-toolchain/old/bin');
  fs.mkdirSync(cad, { recursive: true }); fs.mkdirSync(old, { recursive: true }); fs.mkdirSync(path.join(bundle, 'bin'), { recursive: true }); fs.mkdirSync(path.join(bundle, 'tools'), { recursive: true });
  fs.copyFileSync(path.join(repo, 'bin/pcb'), path.join(bundle, 'bin/pcb')); fs.chmodSync(path.join(bundle, 'bin/pcb'), 0o755);
  for (const name of ['pcb-live-guard.mts', 'pcb-live-common.mts', 'pcb-live-worker.mts']) fs.copyFileSync(path.join(repo, 'tools', name), path.join(bundle, 'tools', name));
  fs.writeFileSync(path.join(bundle, 'VERSION'), 'new test\n'); fs.writeFileSync(path.join(root, 'toolchain.lock'), '{"version":"old"}');
  fs.writeFileSync(path.join(root, '.pcb-live.json'), '{"projectId":"project"}'); fs.writeFileSync(path.join(cad, 'demo.kicad_pcb'), 'board');
  fs.writeFileSync(path.join(root, 'hardware-design/boards/DEMO/gate.json'), '{"project":"cad/demo"}');
  const fixture = path.join(r.dir, 'legacy.mjs');
  fs.writeFileSync(fixture, `import fs from 'node:fs';import path from 'node:path';const root=process.env.IOT_LAB,dir=path.join(root,'.gate/cli/run-legacy');fs.mkdirSync(dir,{recursive:true});fs.writeFileSync(path.join(dir,'run.json'),JSON.stringify({root,board:'DEMO'}));fs.writeFileSync(path.join(dir,'result.json'),JSON.stringify({status:'passed',cleanup:{complete:true}}));fs.writeFileSync(path.join(root,'used-legacy'),process.env.PCB_LIVE_GUARD_ACTIVE||'');console.log(JSON.stringify({run_id:'run-legacy'}));`);
  const oldCli = path.join(old, 'pcb'); fs.writeFileSync(oldCli, `#!/bin/sh\nexec '${process.execPath}' '${fixture}' "$@"\n`, { mode: 0o755 });
  const token = path.join(r.dir, 'token'); fs.writeFileSync(token, TOKEN);
  const server = createServer(r.mgr); await new Promise<void>(ok => server.listen(0, '127.0.0.1', ok));
  const config = path.join(r.dir, 'config.json'); fs.writeFileSync(config, JSON.stringify({ url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, tokenFile: token }));
  try {
    const result = await new Promise<{ code: number | null; output: string }>((resolve, reject) => {
      const child = spawn(path.join(bundle, 'bin/pcb'), ['route', 'DEMO', '--json'], { cwd: root, env: { ...process.env, HOME: home, IOT_LAB: root, PCB_LIVE_CONFIG: config }, stdio: ['ignore', 'pipe', 'pipe'] });
      let output = ''; child.stdout.on('data', b => { output += b.toString(); }); child.stderr.on('data', b => { output += b.toString(); });
      child.once('error', reject); child.once('close', code => resolve({ code, output }));
    });
    assert.equal(result.code, 0, result.output); assert.equal(fs.readFileSync(path.join(root, 'used-legacy'), 'utf8'), '1');
    assert.match(result.output, /run-legacy/);
    const status = await (await fetch(`http://127.0.0.1:${(server.address() as AddressInfo).port}/board-leases/status?board=` + encodeURIComponent('project/hardware-design/boards/DEMO/cad/demo.kicad_pcb'), { headers: { Authorization: `Bearer ${TOKEN}` } })).json() as { generation: number };
    assert.equal(status.generation, 1);
    // Wait for the detached guard before deleting its fixture.
    const receipts = path.join(root, '.gate/live-guards');
    for (let i = 0; i < 50 && fs.readdirSync(receipts).length; i++) await new Promise(ok => setTimeout(ok, 100));
    assert.equal(fs.readdirSync(receipts).length, 0);
  } finally { server.closeAllConnections(); await new Promise<void>(ok => server.close(() => ok())); r.cleanup(); }
});
