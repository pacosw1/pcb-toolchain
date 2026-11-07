#!/usr/bin/env node
// Host-side transaction for an already prepared release. Never changes config, units, or job data.
import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomBytes } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import http from 'node:http';

function identity(dir) {
  if (!fs.lstatSync(dir).isDirectory()) throw Error('source is not a directory');
  const h = createHash('sha256'); h.update('pcb-job-daemon-source-v1\0');
  for (const n of fs.readdirSync(dir).sort()) {
    if (!/^[A-Za-z0-9_.-]+$/.test(n) || !fs.lstatSync(path.join(dir, n)).isFile()) throw Error(`unsupported source entry: ${n}`);
    const b = fs.readFileSync(path.join(dir, n)); h.update(`${n}\0${b.length}\0`); h.update(b);
  }
  return h.digest('hex');
}
function syncDir(dir) { const fd = fs.openSync(dir, 'r'); try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); } }
function save(file, value) {
  const temp = `${file}.new`;
  const fd = fs.openSync(temp, 'w', 0o600);
  try { fs.writeFileSync(fd, JSON.stringify(value)); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  fs.renameSync(temp, file);
  syncDir(path.dirname(file));
}
function prepare(archive, manifest, stage) {
  const bytes = fs.readFileSync(archive);
  if (createHash('sha256').update(bytes).digest('hex') !== manifest.sha256) throw Error('archive checksum mismatch');
  if (!/^[0-9a-f]{64}$/.test(manifest.sourceSha256)) throw Error('invalid source identity');
  // Read each flat regular file individually; never extract archive paths or links onto the host.
  const names = execFileSync('tar', ['-tf', '-'], { input: bytes, encoding: 'utf8', maxBuffer: 1 << 20 }).trim().split('\n');
  const entries = execFileSync('tar', ['-tvf', '-'], { input: bytes, encoding: 'utf8', maxBuffer: 1 << 20 }).trim().split('\n');
  if (names.length !== entries.length) throw Error('ambiguous archive listing');
  const seen = new Set();
  fs.mkdirSync(stage, { mode: 0o700 });
  for (let i = 0; i < names.length; i++) {
    const name = names[i];
    if (['apps/', 'apps/job-daemon/', 'apps/job-daemon/src/'].includes(name)) {
      if (entries[i][0] !== 'd') throw Error('invalid archive directory');
      continue;
    }
    const m = /^apps\/job-daemon\/src\/([A-Za-z0-9_.-]+)$/.exec(name);
    if (!m || entries[i][0] !== '-' || seen.has(m[1])) throw Error(`invalid archive entry: ${name}`);
    seen.add(m[1]);
    const content = execFileSync('tar', ['-xOf', '-', name], { input: bytes, maxBuffer: 16 << 20 });
    const fd = fs.openSync(path.join(stage, m[1]), 'wx', entries[i][3] === 'x' ? 0o755 : 0o644);
    try { fs.writeFileSync(fd, content); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  }
  if (!seen.has('main.ts') || identity(stage) !== manifest.sourceSha256) throw Error('source identity mismatch');
  syncDir(stage); syncDir(path.dirname(stage));
}

const LEFTOVER = /^\.src-(?:backup|failed|stage)-[0-9a-f]{16}$/;
// Only the backup of the newest deployment stays, as the way back. Other backups, failed sources and stages are leftovers.
function prune(root, keepBackup) {
  for (const n of fs.readdirSync(root)) if (LEFTOVER.test(n) && n !== keepBackup) fs.rmSync(path.join(root, n), { recursive: true, force: true });
}

// service.restart() and service.healthy(expectedHash) are supplied separately so the transaction is testable.
// rollbackOnly: the caller has just seen the target fail its health check, so do not wait for it a second time.
export async function recover(root, service, { rollbackOnly = false } = {}) {
  const journalFile = path.join(root, '.deploy-journal.json');
  if (!fs.existsSync(journalFile)) throw Error('no interrupted deployment');
  const j = JSON.parse(fs.readFileSync(journalFile, 'utf8'));
  if (!/^[0-9a-f]{16}$/.test(j.id) || !/^[0-9a-f]{64}$/.test(j.previous)) throw Error('invalid recovery journal');
  const src = path.join(root, 'src'), backup = path.join(root, `.src-backup-${j.id}`), displaced = path.join(root, `.src-failed-${j.id}`);
  // A crash after the target proved healthy and before the journal went: the deployment is done, so finish it forward.
  if (!rollbackOnly && /^[0-9a-f]{64}$/.test(j.target ?? '') && fs.existsSync(src) && identity(src) === j.target && await service.healthy(j.target)) {
    fs.unlinkSync(journalFile); syncDir(root);
    prune(root, path.basename(backup));
    return { committed: j.target };
  }
  if (fs.existsSync(backup)) {
    if (identity(backup) !== j.previous) throw Error('backup source cannot be verified');
    if (fs.existsSync(src)) {
      if (fs.existsSync(displaced)) throw Error('recovery conflict: failed source already exists');
      fs.renameSync(src, displaced); syncDir(root);
    }
    fs.renameSync(backup, src); syncDir(root);
  }
  if (!fs.existsSync(src) || identity(src) !== j.previous) throw Error('previous source cannot be verified');
  await service.restart();
  if (!await service.healthy(j.previous)) throw Error('previous service did not pass identity health check');
  fs.unlinkSync(journalFile); syncDir(root);
  return { restored: j.previous };
}
export async function install(root, archive, manifest, expectedArchiveSha256, service) {
  if (!/^[0-9a-f]{64}$/.test(expectedArchiveSha256) || manifest.sha256 !== expectedArchiveSha256) throw Error('manifest does not match independently supplied archive hash');
  const journal = path.join(root, '.deploy-journal.json');
  if (fs.existsSync(journal)) throw Error('recovery required before another deployment');
  const id = randomBytes(8).toString('hex');
  const stage = path.join(root, `.src-stage-${id}`), backup = path.join(root, `.src-backup-${id}`), src = path.join(root, 'src');
  const previous = identity(src);
  // No journal, so no deployment is in flight: a stage directory here is what a crash during prepare left behind.
  for (const n of fs.readdirSync(root)) if (/^\.src-stage-[0-9a-f]{16}$/.test(n)) fs.rmSync(path.join(root, n), { recursive: true, force: true });
  if (!await service.healthy(previous)) throw Error('current service identity is not verified; bootstrap separately');
  try { prepare(archive, manifest, stage); }
  catch (e) { fs.rmSync(stage, { recursive: true, force: true }); throw e; }
  save(journal, { id, previous, target: manifest.sourceSha256 });
  try {
    fs.renameSync(src, backup); syncDir(root);
    fs.renameSync(stage, src); syncDir(root);
    await service.restart();
    if (!await service.healthy(manifest.sourceSha256)) throw Error('new service did not pass identity health check');
    fs.unlinkSync(journal); syncDir(root);
    prune(root, path.basename(backup));
    return { sourceSha256: manifest.sourceSha256, backup };
  } catch (e) {
    try { await recover(root, service, { rollbackOnly: true }); }
    catch (recovery) { throw Error(`deployment failed: ${e.message}; recovery required: ${recovery.message}`); }
    throw Error(`deployment failed and previous service restored: ${e.message}`);
  }
}

const isAlive = (pid) => { try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; } };
const UNMARKED_LOCK_MS = 60_000;
// One installer at a time. The lock names its holder, so a lock left by a killed installer is taken over, not removed by hand.
export function acquireLock(lock, { pid = process.pid, alive = isAlive, now = Date.now } = {}) {
  for (let n = 0; n < 2; n++) {
    try { fs.mkdirSync(lock); }
    catch (e) {
      if (e.code !== 'EEXIST') throw e;
      let holder = 0;
      try { holder = Number(fs.readFileSync(path.join(lock, 'pid'), 'utf8')); } catch { /* no pid file yet, or none */ }
      if (Number.isInteger(holder) && holder > 0) { if (alive(holder)) throw Error(`another installer is running (pid ${holder}): ${lock}`); }
      else if (now() - fs.statSync(lock).mtimeMs < UNMARKED_LOCK_MS) throw Error(`deploy lock ${lock} is being created`);
      // Stale. A rename is the take-over: of two installers that see it, one wins and the other starts again.
      const stale = `${lock}.stale-${pid}-${now()}`;
      try { fs.renameSync(lock, stale); fs.rmSync(stale, { recursive: true, force: true }); }
      catch (err) { if (err.code !== 'ENOENT') throw err; }
      continue;
    }
    fs.writeFileSync(path.join(lock, 'pid'), String(pid));
    return () => fs.rmSync(lock, { recursive: true, force: true });
  }
  throw Error(`deploy lock ${lock} changed while it was taken over; run again`);
}

export function verifySocket(socket, uid) {
  for (const p of [path.dirname(socket), path.dirname(path.dirname(socket))]) {
    const dir = fs.lstatSync(p);
    if (!dir.isDirectory() || dir.uid !== uid || (dir.mode & 0o777) !== 0o700) throw Error('unsafe health socket directory');
  }
  const endpoint = fs.lstatSync(socket);
  if (!endpoint.isSocket() || endpoint.uid !== uid) throw Error('unsafe health socket');
}
async function main() {
  const [operation, archive, tokenFile, expectedArchiveSha256] = process.argv.slice(2);
  if (!['install', 'recover'].includes(operation) || (operation === 'install' && (!archive || !expectedArchiveSha256)) || !tokenFile) throw Error('usage: install-release.mjs install|recover ARCHIVE_OR_- TOKEN_FILE [EXPECTED_ARCHIVE_SHA256]');
  if (process.getuid?.() !== 0) throw Error('installer must run as root');
  const servicePid = () => {
    const raw = execFileSync('systemctl', ['show', 'pcb-job-daemon.service', '--property=MainPID', '--value'], { encoding: 'utf8' }).trim();
    if (!/^[1-9][0-9]*$/.test(raw)) throw Error('service has no main process');
    return raw;
  };
  const token = fs.readFileSync(tokenFile, 'utf8').trim(); if (token.length < 32) throw Error('invalid token');
  const root = '/opt/pcb-job-daemon', lock = path.join(root, '.deploy-lock');
  const release = acquireLock(lock);
  const service = {
    restart: async () => { execFileSync('systemctl', ['restart', 'pcb-job-daemon.service']); },
    healthy: async (expected) => {
      for (let n = 0; n < 15; n++) {
        try {
          const pid = servicePid();
          const socket = `/run/pcb-job-daemon/default/pid-${pid}.sock`;
          verifySocket(socket, 0);
          const identity = await new Promise((resolve, reject) => {
            const request = http.get({ socketPath: socket, path: '/status', headers: { authorization: `Bearer ${token}` }, timeout: 1000 }, (response) => {
              let body = '';
              response.setEncoding('utf8'); response.on('data', (chunk) => { body += chunk; if (body.length > 16384) request.destroy(); });
              response.on('end', () => { try { resolve(response.statusCode === 200 ? JSON.parse(body).sourceSha256 : null); } catch (e) { reject(e); } });
            });
            request.on('timeout', () => request.destroy()); request.on('error', reject);
          });
          if (identity === expected && servicePid() === pid) return true;
        } catch { /* retry during startup */ }
        await new Promise((resolve) => setTimeout(resolve, 1000));
      }
      return false;
    },
  };
  try {
    const result = operation === 'recover' ? await recover(root, service) : await install(root, archive, JSON.parse(fs.readFileSync(`${archive}.json`, 'utf8')), expectedArchiveSha256, service);
    console.log(JSON.stringify(result));
  } finally { release(); }
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main().catch((e) => { console.error(`install-release: ${e.message}`); process.exitCode = 1; });
