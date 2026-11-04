import { loadConfig } from './config.ts';
import { DockerRuntime } from './docker.ts';
import { hostReader } from './host.ts';
import { JobManager } from './manager.ts';
import { createHealthServer, createServer } from './server.ts';
import { Store } from './store.ts';
import { sourceIdentity } from './source-identity.ts';
import { fileURLToPath } from 'node:url';
import { startListeners } from './listeners.ts';
import { prepareLocalSocket } from './local-socket.ts';
import fs from 'node:fs';

const cfg = loadConfig(process.env);
const mgr = new JobManager(cfg, new Store(cfg.dataDir), new DockerRuntime(cfg), hostReader(cfg.dataDir));
const identity = sourceIdentity(fileURLToPath(new URL('.', import.meta.url)));
const server = createServer(mgr, identity);
const health = createHealthServer(mgr, identity);
const socket = prepareLocalSocket('/run/pcb-job-daemon', process.getuid!());

const timer = setInterval(() => {
  mgr.tick().catch((e: unknown) => console.error('tick failed:', e));
}, cfg.tickMs);
const diskTimer = setInterval(() => {
  mgr.watchDisk().catch((e: unknown) => console.error('disk check failed:', e));
}, cfg.diskCheckS * 1000);
const cleanTimer = setInterval(() => {
  mgr.clean().catch((e: unknown) => console.error('cleanup failed:', e));
}, cfg.tickMs);

startListeners(server, health, cfg.port, cfg.bind, socket).then(() => {
  const s = mgr.status();
  console.log(`pcb-job-daemon on ${cfg.bind}:${cfg.port} data ${cfg.dataDir}: ${mgr.jobs.size} jobs on record, ${s.running} running`);
}).catch((error: unknown) => {
  console.error('daemon listener failed:', error);
  clearInterval(timer); clearInterval(diskTimer); clearInterval(cleanTimer);
  process.exitCode = 1;
});

// A later listener failure must not leave an apparently healthy local endpoint.
for (const listener of [server, health]) listener?.on('error', (error: Error) => {
  console.error('daemon listener failed:', error);
  health?.close(); health?.closeAllConnections(); server.close(); server.closeAllConnections();
  clearInterval(timer); clearInterval(diskTimer); clearInterval(cleanTimer);
  process.exitCode = 1;
});

// A stop leaves the containers running; the next start finds them through their records.
for (const signal of ['SIGTERM', 'SIGINT'] as const) {
  process.on(signal, () => {
    clearInterval(timer);
    clearInterval(diskTimer);
    clearInterval(cleanTimer);
    server.close();
    server.closeAllConnections();
    const socketWasListening = health.listening;
    health?.close();
    health?.closeAllConnections();
    if (socketWasListening) {
      try { fs.unlinkSync(socket); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') console.error('cannot remove health socket:', error); }
    }
    process.exit(0);
  });
}
