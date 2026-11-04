import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtempSync, rmSync, chmodSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { startListeners } from '../src/listeners.ts';
import { prepareLocalSocket } from '../src/local-socket.ts';

test('a failed primary bind never starts the health listener', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'jobd-sock-')); const occupied = http.createServer(), primary = http.createServer(), health = http.createServer();
  await new Promise<void>((resolve) => occupied.listen(0, '127.0.0.1', resolve));
  try {
    const port = (occupied.address() as AddressInfo).port;
    await assert.rejects(startListeners(primary, health, port, '127.0.0.1', prepareLocalSocket(dir, 'test', process.getuid!(), process.pid)), /EADDRINUSE/);
    assert.equal(health.listening, false);
  } finally { await new Promise<void>((resolve) => occupied.close(() => resolve())); rmSync(dir, { recursive: true, force: true }); }
});

test('IPv6 primary serves health over a private Unix socket', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'jobd-sock-')); const primary = http.createServer(), health = http.createServer();
  try {
    const socket = prepareLocalSocket(dir, 'test', process.getuid!(), process.pid);
    await startListeners(primary, health, 0, '::1', socket);
    assert.equal((primary.address() as AddressInfo).address, '::1'); assert.equal(health.address(), socket);
  } finally {
    if (health.listening) await new Promise<void>((resolve) => health.close(() => resolve()));
    if (primary.listening) await new Promise<void>((resolve) => primary.close(() => resolve()));
    rmSync(dir, { recursive: true, force: true });
  }
});

test('unsafe directory and existing socket path are refused', () => {
  const dir = mkdtempSync(join(tmpdir(), 'jobd-sock-'));
  try {
    chmodSync(dir, 0o755); assert.throws(() => prepareLocalSocket(dir, 'test', process.getuid!(), process.pid), /unsafe/);
    chmodSync(dir, 0o700); const socket = prepareLocalSocket(dir, 'test', process.getuid!(), process.pid);
    writeFileSync(socket, 'occupied');
    assert.throws(() => prepareLocalSocket(dir, 'test', process.getuid!(), process.pid), /already exists/);
    assert.notEqual(prepareLocalSocket(dir, 'test', process.getuid!(), process.pid + 1), socket);
    assert.notEqual(prepareLocalSocket(dir, 'other', process.getuid!(), process.pid), socket);
    assert.ok(prepareLocalSocket(dir, '../bad', process.getuid!(), process.pid).startsWith(`${dir}/i-`));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('health bind failure closes primary', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'jobd-sock-')); const primary = http.createServer(), health = http.createServer();
  try {
    await assert.rejects(startListeners(primary, health, 0, '127.0.0.1', join(dir, 'missing', 'socket')), /ENOENT|EACCES/);
    assert.equal(primary.listening, false);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('crashed instance leaves a stale socket without blocking a new process or another instance', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'jobd-sock-'));
  const code = `import http from 'node:http'; import { prepareLocalSocket } from ${JSON.stringify(new URL('../src/local-socket.ts', import.meta.url).href)}; const p = prepareLocalSocket(process.argv[1], process.argv[2], process.getuid(), process.pid); http.createServer((q,r)=>r.end('ok')).listen(p,()=>console.log(p));`;
  const start = async (instance: string) => {
    const child = spawn(process.execPath, ['--experimental-strip-types', '--input-type=module', '-e', code, dir, instance], { stdio: ['ignore', 'pipe', 'pipe'] });
    const [chunk] = await once(child.stdout!, 'data');
    return { child, socket: String(chunk).trim() };
  };
  let crashed: Awaited<ReturnType<typeof start>> | undefined, replacement: Awaited<ReturnType<typeof start>> | undefined, other: Awaited<ReturnType<typeof start>> | undefined;
  try {
    crashed = await start('test'); other = await start('other');
    crashed.child.kill('SIGKILL'); await once(crashed.child, 'exit');
    replacement = await start('test');
    assert.notEqual(replacement.socket, crashed.socket);
    const response = await new Promise<string>((resolve, reject) => http.get({ socketPath: other!.socket, path: '/' }, (r) => { let s = ''; r.on('data', (c) => { s += c; }); r.on('end', () => resolve(s)); }).on('error', reject));
    assert.equal(response, 'ok');
  } finally {
    for (const entry of [crashed, replacement, other]) if (entry && entry.child.exitCode === null && entry.child.signalCode === null) { entry.child.kill('SIGKILL'); await once(entry.child, 'exit'); }
    rmSync(dir, { recursive: true, force: true });
  }
});
