import { loadConfig } from './config.ts';
import { DockerRuntime } from './docker.ts';
import { hostReader } from './host.ts';
import { JobManager } from './manager.ts';
import { createHealthServer, createServer } from './server.ts';
import { Store } from './store.ts';
import { sourceIdentity } from './source-identity.ts';
import { fileURLToPath } from 'node:url';

const cfg = loadConfig(process.env);
const mgr = new JobManager(cfg, new Store(cfg.dataDir), new DockerRuntime(cfg), hostReader(cfg.dataDir));
const identity = sourceIdentity(fileURLToPath(new URL('.', import.meta.url)));
const server = createServer(mgr, identity);
// The deployed API may bind to a Tailscale address; keep local deployment verification local.
const health = cfg.bind === '127.0.0.1' ? null : createHealthServer(mgr, identity);
health?.listen(cfg.port, '127.0.0.1');

const timer = setInterval(() => {
  mgr.tick().catch((e: unknown) => console.error('tick failed:', e));
}, cfg.tickMs);
const diskTimer = setInterval(() => {
  mgr.watchDisk().catch((e: unknown) => console.error('disk check failed:', e));
}, cfg.diskCheckS * 1000);
const cleanTimer = setInterval(() => {
  mgr.clean().catch((e: unknown) => console.error('cleanup failed:', e));
}, cfg.tickMs);

server.listen(cfg.port, cfg.bind, () => {
  const s = mgr.status();
  console.log(`pcb-job-daemon on ${cfg.bind}:${cfg.port} data ${cfg.dataDir}: ${mgr.jobs.size} jobs on record, ${s.running} running`);
});

// A stop leaves the containers running; the next start finds them through their records.
for (const signal of ['SIGTERM', 'SIGINT'] as const) {
  process.on(signal, () => {
    clearInterval(timer);
    clearInterval(diskTimer);
    clearInterval(cleanTimer);
    server.close();
    server.closeAllConnections();
    health?.close();
    health?.closeAllConnections();
    process.exit(0);
  });
}
