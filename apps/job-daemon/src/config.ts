import fs from 'node:fs';
import net from 'node:net';

/** Every default is explained in README "Defaults". The numbers marked "to tune" there have no harder source. */
export interface Config {
  bind: string;
  port: number;
  token: string;
  dataDir: string;
  /** Marks this daemon's containers, so a test instance and a deployed one can be told apart. */
  instance: string;
  images: string[];
  cpuBudget: number;
  memBudgetGb: number;
  cgroupParent: string;
  defaultCpus: number;
  defaultMemGb: number;
  defaultTimeoutS: number;
  maxTimeoutS: number;
  defaultRetries: number;
  maxRetriesCap: number;
  retryBackoffS: number;
  cpuBusyMaxPct: number;
  defaultQueueWaitS: number;
  maxQueueWaitS: number;
  memFloorFraction: number;
  minFreeGb: number;
  maxUploadMb: number;
  blobKeepDays: number;
  requestTimeoutS: number;
  retainDays: number;
  jobUid: number | null;
  tickMs: number;
  pidsLimit: number;
  nofile: number;
  defaultDiskGb: number;
  maxDiskGb: number;
  diskCheckS: number;
  maxQueued: number;
  maxUploads: number;
  maxStreams: number;
}

/** 127.0.0.1, ::1 or a Tailscale 100.64.0.0/10 address, the same rule as tools/route_live.py. Never 0.0.0.0. */
export function bindAllowed(addr: string): boolean {
  if (addr === '127.0.0.1' || addr === '::1') return true;
  if (!net.isIPv4(addr)) return false;
  const [a, b] = addr.split('.').map(Number);
  return a === 100 && b >= 64 && b <= 127;
}

function num(env: NodeJS.ProcessEnv, key: string, fallback: number): number {
  const raw = env[key];
  if (raw === undefined || raw === '') return fallback;
  const v = Number(raw);
  if (!Number.isFinite(v) || v < 0) throw new Error(`${key}=${raw} is not a non-negative number`);
  return v;
}

export function loadConfig(env: NodeJS.ProcessEnv): Config {
  const bind = env.JOBD_BIND || '127.0.0.1';
  if (!bindAllowed(bind)) throw new Error(`JOBD_BIND=${bind}: only 127.0.0.1, ::1 or a Tailscale 100.64.0.0/10 address`);
  const tokenFile = env.JOBD_TOKEN_FILE;
  if (!tokenFile) throw new Error('JOBD_TOKEN_FILE is required');
  const token = fs.readFileSync(tokenFile, 'utf8').trim();
  if (token.length < 32) throw new Error(`${tokenFile}: token shorter than 32 characters (use: openssl rand -hex 32)`);
  const dataDir = env.JOBD_DATA_DIR;
  if (!dataDir) throw new Error('JOBD_DATA_DIR is required');
  const cfg: Config = {
    bind,
    port: num(env, 'JOBD_PORT', 8793),
    token,
    dataDir,
    instance: env.JOBD_INSTANCE || 'default',
    images: (env.JOBD_IMAGES || 'iot-lab-route:10.0,iot-lab-route:10.0-fr241').split(',').map((s) => s.trim()).filter(Boolean),
    cpuBudget: num(env, 'JOBD_CPU_BUDGET', 16),
    memBudgetGb: num(env, 'JOBD_MEM_BUDGET_GB', 16),
    cgroupParent: env.JOBD_CGROUP_PARENT || '',
    defaultCpus: num(env, 'JOBD_DEFAULT_CPUS', 8),
    defaultMemGb: num(env, 'JOBD_DEFAULT_MEM_GB', 8),
    defaultTimeoutS: num(env, 'JOBD_DEFAULT_TIMEOUT_S', 300),
    maxTimeoutS: num(env, 'JOBD_MAX_TIMEOUT_S', 21600),
    defaultRetries: num(env, 'JOBD_DEFAULT_RETRIES', 2),
    maxRetriesCap: num(env, 'JOBD_MAX_RETRIES', 5),
    retryBackoffS: num(env, 'JOBD_RETRY_BACKOFF_S', 30),
    cpuBusyMaxPct: num(env, 'JOBD_CPU_BUSY_MAX_PCT', 95),
    defaultQueueWaitS: num(env, 'JOBD_DEFAULT_QUEUE_WAIT_S', 3600),
    maxQueueWaitS: num(env, 'JOBD_MAX_QUEUE_WAIT_S', 21600),
    memFloorFraction: num(env, 'JOBD_MEM_FLOOR_FRACTION', 0.2),
    minFreeGb: num(env, 'JOBD_MIN_FREE_GB', 20),
    maxUploadMb: num(env, 'JOBD_MAX_UPLOAD_MB', 512),
    blobKeepDays: num(env, 'JOBD_BLOB_KEEP_DAYS', 30),
    requestTimeoutS: num(env, 'JOBD_REQUEST_TIMEOUT_S', 3600),
    retainDays: num(env, 'JOBD_RETAIN_DAYS', 7),
    jobUid: env.JOBD_JOB_UID === 'none' ? null : num(env, 'JOBD_JOB_UID', 1000),
    tickMs: num(env, 'JOBD_TICK_MS', 2000),
    pidsLimit: num(env, 'JOBD_PIDS_LIMIT', 4096),
    nofile: num(env, 'JOBD_NOFILE', 1024),
    defaultDiskGb: num(env, 'JOBD_DEFAULT_DISK_GB', 10),
    maxDiskGb: num(env, 'JOBD_MAX_DISK_GB', 50),
    diskCheckS: num(env, 'JOBD_DISK_CHECK_S', 5),
    maxQueued: num(env, 'JOBD_MAX_QUEUED', 64),
    maxUploads: num(env, 'JOBD_MAX_UPLOADS', 2),
    maxStreams: num(env, 'JOBD_MAX_STREAMS', 64),
  };
  if (cfg.images.length === 0) throw new Error('JOBD_IMAGES is empty');
  // A hyphen in a slice name means nesting: pcb-jobs.slice would sit under pcb.slice, not beside ci.slice.
  if (cfg.cgroupParent.includes('-')) throw new Error(`JOBD_CGROUP_PARENT=${cfg.cgroupParent}: no hyphen (systemd reads it as nesting)`);
  return cfg;
}
