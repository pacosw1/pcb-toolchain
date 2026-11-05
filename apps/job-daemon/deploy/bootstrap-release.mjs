#!/usr/bin/env node
// One-time upgrade from a legacy service that predates source-identity health sockets.
// The old runtime cannot attest its source; verify its on-disk source and authenticated status,
// then use the normal journaled swap/rollback and require the new PID-specific identity socket.
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { install, recover, verifySocket } from './install-release.mjs';

function identity(dir) {
  const hash = createHash('sha256'); hash.update('pcb-job-daemon-source-v1\0');
  for (const name of fs.readdirSync(dir).sort()) {
    const file = path.join(dir, name);
    if (!/^[A-Za-z0-9_.-]+$/.test(name) || !fs.lstatSync(file).isFile()) throw Error(`invalid legacy source entry ${name}`);
    const bytes = fs.readFileSync(file); hash.update(`${name}\0${bytes.length}\0`); hash.update(bytes);
  }
  return hash.digest('hex');
}

/** service supplies legacyHealthy, newHealthy and restart; the standard installer owns swap and rollback. */
export async function bootstrap(root, archive, manifest, expectedArchiveSha256, service) {
  const previous = identity(path.join(root, 'src'));
  if (!await service.legacyHealthy(previous)) throw Error('legacy daemon preflight failed');
  const wrapped = { restart: service.restart, healthy: async expected => expected === previous
    ? service.legacyHealthy(previous) : service.newHealthy(expected) };
  const result = await install(root, archive, manifest, expectedArchiveSha256, wrapped);
  return { ...result, previousSourceSha256: previous,
    legacyEvidence: 'authenticated status and on-disk source hash; legacy runtime did not report its own source identity' };
}

export async function recoverLegacy(root, service) {
  return recover(root, { restart: service.restart, healthy: service.legacyHealthy });
}

function getJson(options) {
  return new Promise((resolve, reject) => {
    const req = http.get({ ...options, timeout: 2000 }, res => {
      let text = ''; res.setEncoding('utf8');
      res.on('data', chunk => { text += chunk; if (text.length > 16384) req.destroy(); });
      res.on('end', () => { try { resolve(res.statusCode === 200 ? JSON.parse(text) : null); } catch (error) { reject(error); } });
    });
    req.on('timeout', () => req.destroy()); req.on('error', reject);
  });
}
async function main() {
  const [operation, archive, tokenFile, expected, statusUrl] = process.argv.slice(2);
  if (!['install', 'recover'].includes(operation) || !archive || !tokenFile || !expected || !statusUrl || process.argv.length !== 7)
    throw Error('usage: bootstrap-release.mjs install ARCHIVE TOKEN_FILE ARCHIVE_SHA256 STATUS_URL | recover - TOKEN_FILE - STATUS_URL');
  if (process.getuid?.() !== 0) throw Error('bootstrap must run as root');
  const u = new URL(statusUrl), addr = u.hostname.split('.').map(Number);
  const tailnet = addr.length === 4 && addr[0] === 100 && addr[1] >= 64 && addr[1] <= 127 && addr.every(n => Number.isInteger(n) && n >= 0 && n <= 255);
  if (u.protocol !== 'http:' || (!tailnet && u.hostname !== '127.0.0.1') || u.pathname !== '/status' || u.search || u.hash || u.username || u.password)
    throw Error('status URL must be a loopback or Tailscale HTTP /status endpoint');
  const token = fs.readFileSync(tokenFile, 'utf8').trim(); if (token.length < 32) throw Error('invalid token');
  const root = '/opt/pcb-job-daemon', lock = path.join(root, '.deploy-lock');
  const pid = () => {
    const value = execFileSync('systemctl', ['show', 'pcb-job-daemon.service', '--property=MainPID', '--value'], { encoding: 'utf8' }).trim();
    if (!/^[1-9][0-9]*$/.test(value)) throw Error('service has no main process');
    return value;
  };
  let preflight = operation === 'install';
  const service = {
    legacyHealthy: async expectedHash => {
      for (let n = 0; n < 15; n++) {
        try {
          const before = pid(), source = identity(path.join(root, 'src'));
          const status = await getJson({ hostname: u.hostname, port: u.port || 80, path: '/status', headers: { authorization: `Bearer ${token}` } });
          if (source === expectedHash && status && status.sourceSha256 == null && before === pid() &&
              (!preflight || (status.running === 0 && status.queued === 0 && status.retrying === 0))) return true;
        } catch { /* wait for the service */ }
        await new Promise(resolve => setTimeout(resolve, 1000));
      }
      return false;
    },
    newHealthy: async expectedHash => {
      for (let n = 0; n < 15; n++) {
        try {
          const before = pid(), socket = `/run/pcb-job-daemon/default/pid-${before}.sock`;
          verifySocket(socket, 0);
          const status = await getJson({ socketPath: socket, path: '/status', headers: { authorization: `Bearer ${token}` } });
          if (status?.sourceSha256 === expectedHash && before === pid()) return true;
        } catch { /* wait for the service */ }
        await new Promise(resolve => setTimeout(resolve, 1000));
      }
      return false;
    },
    restart: async () => { preflight = false; execFileSync('systemctl', ['restart', 'pcb-job-daemon.service']); }
  };
  fs.mkdirSync(lock);
  try {
    const result = operation === 'recover' ? await recoverLegacy(root, service)
      : await bootstrap(root, archive, JSON.parse(fs.readFileSync(archive + '.json', 'utf8')), expected, service);
    console.log(JSON.stringify(result));
  } finally { fs.rmdirSync(lock); }
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main().catch(error => { console.error(`bootstrap-release: ${error.message}`); process.exitCode = 1; });
