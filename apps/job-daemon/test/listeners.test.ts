import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { startListeners } from '../src/listeners.ts';

test('a failed primary bind never starts the health listener', async () => {
  const occupied = http.createServer(), primary = http.createServer(), health = http.createServer();
  await new Promise<void>((resolve) => occupied.listen(0, '127.0.0.1', resolve));
  try {
    const port = (occupied.address() as AddressInfo).port;
    await assert.rejects(startListeners(primary, health, port, '127.0.0.1'), /EADDRINUSE/);
    assert.equal(health.listening, false);
  } finally { await new Promise<void>((resolve) => occupied.close(() => resolve())); }
});

test('an IPv6 primary still uses IPv4 loopback for local health', async () => {
  const primary = http.createServer(), health = http.createServer();
  try {
    await startListeners(primary, health, 0, '::1');
    assert.equal((primary.address() as AddressInfo).address, '::1');
    assert.equal((health.address() as AddressInfo).address, '127.0.0.1');
    assert.equal((health.address() as AddressInfo).port, (primary.address() as AddressInfo).port);
  } finally {
    if (health.listening) await new Promise<void>((resolve) => health.close(() => resolve()));
    if (primary.listening) await new Promise<void>((resolve) => primary.close(() => resolve()));
  }
});

test('a failed local health bind closes the primary listener', async () => {
  const occupied = http.createServer(), primary = http.createServer(), health = http.createServer();
  await new Promise<void>((resolve) => occupied.listen(0, '127.0.0.1', resolve));
  try {
    const port = (occupied.address() as AddressInfo).port;
    await assert.rejects(startListeners(primary, health, port, '::1'), /EADDRINUSE/);
    assert.equal(primary.listening, false);
  } finally { await new Promise<void>((resolve) => occupied.close(() => resolve())); }
});
