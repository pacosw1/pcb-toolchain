import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Config } from '../src/config.ts';
import type { ContainerState, Runtime, StartRequest, StartResult } from '../src/docker.ts';
import type { HostState } from '../src/host.ts';
import { JobManager, validateSpec } from '../src/manager.ts';
import { Store } from '../src/store.ts';
import type { JobRecord } from '../src/types.ts';

export const TOKEN = 'test-token-0123456789abcdef0123456789';

export function testConfig(dataDir: string, over: Partial<Config> = {}): Config {
  return {
    bind: '127.0.0.1', port: 0, token: TOKEN, dataDir, instance: 'test', images: ['img:1'],
    cpuBudget: 16, memBudgetGb: 16, cgroupParent: '', defaultCpus: 8, defaultMemGb: 8, defaultTimeoutS: 300,
    maxTimeoutS: 21600, defaultRetries: 2, maxRetriesCap: 5, retryBackoffS: 30, cpuPsiMax: 5, memFloorFraction: 0.2,
    minFreeGb: 20, maxUploadMb: 1, retainDays: 7, jobUid: null, tickMs: 20,
    ...over,
  };
}

/**
 * The fake job. The command names what the attempt does, one word per attempt, the last one repeating:
 *   pass | exit:N | hang | oom | killed | vanish | start-infra | start-image
 * It writes what the real wrapper writes: out/job.log and .exit-code.
 */
export class FakeRuntime implements Runtime {
  containers = new Map<string, ContainerState>();
  started: StartRequest[] = [];
  killed: string[] = [];
  dockerUp = true;
  inspectBroken = false;

  async ping(): Promise<boolean> {
    return this.dockerUp;
  }

  async start(req: StartRequest): Promise<StartResult> {
    const n = Number(req.container.split('-').pop());
    const act = req.command[Math.min(n - 1, req.command.length - 1)];
    this.started.push(req);
    if (act === 'start-infra') return { ok: false, permanent: false, detail: 'docker: daemon busy' };
    if (act === 'start-image') return { ok: false, permanent: true, detail: 'No such image' };
    fs.mkdirSync(path.join(req.workDir, 'out'), { recursive: true });
    fs.writeFileSync(path.join(req.workDir, 'out', 'job.log'), `attempt ${n}: ${act}\n`);
    const finish = (rc: number): void => {
      fs.writeFileSync(path.join(req.workDir, '.exit-code'), `${rc}\n`);
      this.containers.set(req.container, { status: 'exited', exitCode: rc, oomKilled: false });
    };
    if (act === 'pass') finish(0);
    else if (act.startsWith('exit:')) finish(Number(act.slice(5)));
    else if (act === 'oom') this.containers.set(req.container, { status: 'exited', exitCode: 137, oomKilled: true });
    else if (act === 'killed') this.containers.set(req.container, { status: 'exited', exitCode: 137, oomKilled: false });
    else if (act === 'vanish') this.containers.set(req.container, { status: 'missing' });
    else this.containers.set(req.container, { status: 'running' });
    return { ok: true };
  }

  async inspect(c: string): Promise<ContainerState> {
    if (this.inspectBroken) return { status: 'unknown', detail: 'cannot connect' };
    return this.containers.get(c) ?? { status: 'missing' };
  }

  async kill(c: string): Promise<void> {
    this.killed.push(c);
    this.containers.set(c, { status: 'exited', exitCode: 137, oomKilled: false });
  }

  async remove(c: string): Promise<void> {
    this.containers.delete(c);
  }
}

export interface Rig {
  dir: string;
  cfg: Config;
  runtime: FakeRuntime;
  mgr: JobManager;
  host: HostState;
  clock: { now: number };
  submit: (command: string[], over?: Record<string, unknown>) => JobRecord;
  /** A new manager on the same data and containers: what a daemon restart does. */
  restart: () => void;
  cleanup: () => void;
}

export function tarOf(dir: string): string {
  const src = path.join(dir, 'src');
  fs.mkdirSync(src, { recursive: true });
  fs.writeFileSync(path.join(src, 'input.txt'), 'in\n');
  const tar = path.join(dir, `in-${Math.random().toString(16).slice(2)}.tar.gz`);
  const r = spawnSync('tar', ['-czf', tar, '-C', src, '.']);
  if (r.status !== 0) throw new Error('tar failed');
  return tar;
}

export function rig(over: Partial<Config> = {}): Rig {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jobd-test-'));
  const cfg = testConfig(path.join(dir, 'data'), over);
  const runtime = new FakeRuntime();
  const clock = { now: Date.parse('2026-11-04T12:00:00Z') };
  const host: HostState = { cpuPsiSome10: 0, memAvailableGb: 50, memTotalGb: 62, diskFreeGb: 500 };
  const make = (): JobManager => new JobManager(cfg, new Store(cfg.dataDir), runtime, () => host, () => clock.now);
  const r: Rig = {
    dir, cfg, runtime, host, clock,
    mgr: make(),
    submit: (command, o = {}) => r.mgr.submit(validateSpec({ command, ...o }, cfg), tarOf(dir)),
    restart: () => {
      r.mgr = make();
    },
    cleanup: () => fs.rmSync(dir, { recursive: true, force: true }),
  };
  return r;
}
