import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtempSync, rmSync, chmodSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import { startListeners } from '../src/listeners.ts';
import { prepareLocalSocket } from '../src/local-socket.ts';

test('a failed primary bind never starts the health listener', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'jobd-sock-')); const occupied = http.createServer(), primary = http.createServer(), health = http.createServer();
  await new Promise<void>((resolve) => occupied.listen(0, '127.0.0.1', resolve));
  try {
    const port = (occupied.address() as AddressInfo).port;
    await assert.rejects(startListeners(primary, health, port, '127.0.0.1', prepareLocalSocket(dir, process.getuid!())), /EADDRINUSE/);
    assert.equal(health.listening, false);
  } finally { await new Promise<void>((resolve) => occupied.close(() => resolve())); rmSync(dir, { recursive: true, force: true }); }
});

test('IPv6 primary serves health over a private Unix socket', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'jobd-sock-')); const primary = http.createServer(), health = http.createServer();
  try {
    const socket = prepareLocalSocket(dir, process.getuid!());
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
    chmodSync(dir, 0o755); assert.throws(() => prepareLocalSocket(dir, process.getuid!()), /unsafe/);
    chmodSync(dir, 0o700); writeFileSync(join(dir, 'status.sock'), 'occupied');
    assert.throws(() => prepareLocalSocket(dir, process.getuid!()), /already exists/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('health bind failure closes primary', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'jobd-sock-')); const primary = http.createServer(), health = http.createServer();
  try {
    await assert.rejects(startListeners(primary, health, 0, '127.0.0.1', join(dir, 'missing', 'socket')), /ENOENT|EACCES/);
    assert.equal(primary.listening, false);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
