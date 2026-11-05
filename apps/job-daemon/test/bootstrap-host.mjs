#!/usr/bin/env node
// Isolated host exercise: real legacy and new daemon processes, temporary data only.
import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { bootstrap } from '../deploy/bootstrap-release.mjs';

const [root, archive, legacyDir] = process.argv.slice(2);
if (!root || !archive || !legacyDir || !path.resolve(root).startsWith('/tmp/') || fs.existsSync(root)) throw Error('requires a new /tmp test root, archive and legacy source directory');
fs.mkdirSync(root, { recursive: true, mode: 0o700 });
const host = path.join(root, 'host'), data = path.join(root, 'data'), tokenFile = path.join(root, 'token');
fs.mkdirSync(host); fs.cpSync(legacyDir, path.join(host, 'src'), { recursive: true });
const token = randomBytes(32).toString('hex'); fs.writeFileSync(tokenFile, token, { mode: 0o600 });
const manifest = JSON.parse(fs.readFileSync(archive + '.json', 'utf8'));
const probe = net.createServer(); await new Promise(resolve => probe.listen(0, '127.0.0.1', resolve));
const port = probe.address().port; await new Promise(resolve => probe.close(resolve));
const url = `http://127.0.0.1:${port}/status`;
const headers = { authorization: `Bearer ${token}` };
let processHandle = null, errors = '';
const identity = dir => {
  const h = createHash('sha256'); h.update('pcb-job-daemon-source-v1\0');
  for (const n of fs.readdirSync(dir).sort()) { const b = fs.readFileSync(path.join(dir, n)); h.update(`${n}\0${b.length}\0`); h.update(b); }
  return h.digest('hex');
};
const old = identity(path.join(host, 'src'));
async function stop() {
  if (!processHandle || processHandle.exitCode !== null) return;
  const child = processHandle; child.kill('SIGTERM');
  await Promise.race([new Promise(resolve => child.once('exit', resolve)), new Promise((_, reject) => setTimeout(() => reject(Error('staging daemon did not stop')), 5000))]);
}
async function start() {
  processHandle = spawn(process.execPath, ['--no-warnings', path.join(host, 'src/main.ts')], { env: { ...process.env,
    JOBD_BIND: '127.0.0.1', JOBD_PORT: String(port), JOBD_TOKEN_FILE: tokenFile, JOBD_DATA_DIR: data,
    JOBD_INSTANCE: 'bootstrap-staging', JOBD_HEALTH_ROOT: path.join(root, 'health'), JOBD_MIN_FREE_GB: '0' }, stdio: ['ignore', 'ignore', 'pipe'] });
  processHandle.stderr.on('data', chunk => { errors += chunk.toString(); });
}
async function status() {
  const response = await fetch(url, { headers, signal: AbortSignal.timeout(1000) });
  if (!response.ok) throw Error(`status HTTP ${response.status}`);
  return response.json();
}
async function waitFor(fn) {
  for (let i = 0; i < 100; i++) { try { if (await fn()) return true; } catch {} await new Promise(resolve => setTimeout(resolve, 100)); }
  return false;
}
let allowNew = false;
const service = {
  restart: async () => { await stop(); await start(); },
  legacyHealthy: async expected => waitFor(async () => {
    const s = await status(); return identity(path.join(host, 'src')) === expected && s.sourceSha256 == null && s.running === 0 && s.queued === 0;
  }),
  newHealthy: async expected => allowNew && waitFor(async () => (await status()).sourceSha256 === expected)
};
try {
  await start(); assert.ok(await service.legacyHealthy(old), `legacy service did not start: ${errors}`);
  await assert.rejects(bootstrap(host, archive, manifest, manifest.sha256, service), /previous service restored/);
  assert.equal(identity(path.join(host, 'src')), old); assert.ok(await service.legacyHealthy(old));
  allowNew = true;
  const result = await bootstrap(host, archive, manifest, manifest.sha256, service);
  assert.equal(result.sourceSha256, manifest.sourceSha256); assert.equal((await status()).sourceSha256, manifest.sourceSha256);
  console.log(JSON.stringify({ passed: true, rollbackVerified: true, sourceSha256: result.sourceSha256, isolatedRoot: root }));
} finally { await stop(); }
