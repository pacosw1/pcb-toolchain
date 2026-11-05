#!/usr/bin/env node
import { LiveJobs } from './live-jobs.ts';
import type { ObservedJob } from './live-jobs.ts';
// Thin client for the job daemon. README "Client" has the commands.
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { JobRecord } from './types.ts';
import { isTerminal } from './types.ts';

const USAGE = `usage:
  pcb-job run <board-dir> [options] -- <command...>     submit, stream, fetch results, exit with the job's code
  pcb-job submit <board-dir> [options] -- <command...>  submit and print the job id
  pcb-job watch <id>                                    stream states and logs until the job ends
  pcb-job status [<id>]                                 one job, or the daemon's budget and queue
  pcb-job list                                          all jobs on record
  pcb-job cancel <id>
  pcb-job results <id> [<dir>]
options: --in FILE (repeatable) --results DIR --cpus N --mem GB --disk GB --timeout S --queue-wait S --image I
         --retries N --retry-exit CODE (repeatable) --name NAME --snapshot board
env: JOBD_URL, JOBD_TOKEN or JOBD_TOKEN_FILE, IOT_LAB (project root), PCB_TOOLCHAIN_ROOT`;

/** The client gives up when the daemon stays unreachable this long. The job itself goes on. A default to tune. */
const GIVE_UP_MS = 300_000;
const RECONNECT_MS = 2_000;
const EXIT_UNREACHABLE = 3;
/** The job reached its queue bound and never ran. EX_TEMPFAIL of sysexits.h: nothing is wrong with it, try again later. */
const EXIT_QUEUE_BOUND = 75;

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
const die = (msg: string, code = 2): never => {
  console.error(`pcb-job: ${msg}`);
  process.exit(code);
};

const baseUrl = (): string => (process.env.JOBD_URL || die('set JOBD_URL=http://host:port')).replace(/\/$/, '');

function token(): string {
  if (process.env.JOBD_TOKEN) return process.env.JOBD_TOKEN;
  if (process.env.JOBD_TOKEN_FILE) return fs.readFileSync(process.env.JOBD_TOKEN_FILE, 'utf8').trim();
  return die('set JOBD_TOKEN or JOBD_TOKEN_FILE');
}

function api(p: string, init: RequestInit = {}): Promise<Response> {
  const headers = new Headers(init.headers);
  headers.set('authorization', `Bearer ${token()}`);
  return fetch(baseUrl() + p, { ...init, headers });
}

async function apiJson<T>(p: string, init?: RequestInit): Promise<T> {
  const res = await api(p, init);
  const body = (await res.json()) as T & { error?: string };
  if (!res.ok) die(`${res.status}: ${body.error ?? 'request failed'}`);
  return body;
}

/** Keeps trying through a dropped connection or a daemon restart. An HTTP error is an answer and is not retried. */
async function persist<T>(what: string, fn: () => Promise<T>): Promise<T> {
  let downSince = 0;
  for (;;) {
    try {
      return await fn();
    } catch (e) {
      downSince ||= Date.now();
      if (Date.now() - downSince > GIVE_UP_MS) {
        die(`daemon unreachable for ${GIVE_UP_MS / 1000} s during ${what} (${String(e)}); the job goes on, run: pcb-job watch`, EXIT_UNREACHABLE);
      }
      await sleep(RECONNECT_MS);
    }
  }
}

/** Streams one file from the daemon into `sink` and returns the new offset, also when the connection drops. */
async function stream(p: string, offset: number, sink: (b: Buffer) => void): Promise<number> {
  let pos = offset;
  try {
    const res = await api(`${p}${p.includes('?') ? '&' : '?'}offset=${pos}&follow=1`);
    if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}`);
    for await (const chunk of res.body) {
      const b = Buffer.from(chunk);
      sink(b);
      pos += b.length;
    }
    return pos;
  } catch (e) {
    if (pos === offset) throw e; // no progress: let persist() count the outage
    return pos;
  }
}

async function watchEvents(id: string): Promise<void> {
  let offset = 0;
  let rest = '';
  const print = (b: Buffer): void => {
    rest += b.toString('utf8');
    const lines = rest.split('\n');
    rest = lines.pop() ?? '';
    for (const line of lines) {
      const e = JSON.parse(line) as { t: string; from: string | null; to: string; detail: string };
      console.error(e.from === e.to ? `[${e.t}] ${e.detail}` : `[${e.t}] ${e.to}: ${e.detail}`); // from = to: a hold
    }
  };
  for (;;) {
    offset = await persist('events', () => stream(`/jobs/${id}/events`, offset, print));
    const job = await persist('status', () => apiJson<JobRecord>(`/jobs/${id}`));
    if (isTerminal(job.state)) {
      offset = await persist('events', () => stream(`/jobs/${id}/events`, offset, print));
      return;
    }
    await sleep(RECONNECT_MS);
  }
}

async function watchLogs(id: string): Promise<void> {
  let n = 1;
  let offset = 0;
  for (;;) {
    const job = await persist('status', () => apiJson<JobRecord>(`/jobs/${id}`));
    if (job.attempts.length < n) {
      if (isTerminal(job.state)) return;
      await sleep(RECONNECT_MS / 2);
      continue;
    }
    offset = await persist('log', () => stream(`/jobs/${id}/log?attempt=${n}`, offset, (b) => process.stdout.write(b)));
    const now = await persist('status', () => apiJson<JobRecord>(`/jobs/${id}`));
    if (now.attempts[n - 1]?.endedAt) {
      if (isTerminal(now.state) && now.attempts.length === n) return;
      n += 1;
      offset = 0;
    }
  }
}

async function watch(id: string): Promise<JobRecord> {
  await Promise.all([watchEvents(id), watchLogs(id)]);
  return persist('status', () => apiJson<JobRecord>(`/jobs/${id}`));
}

function exitCodeOf(job: JobRecord): number {
  if (job.state === 'passed') return 0;
  if (job.state === 'cancelled') return 130;
  if (job.result?.outcome === 'queue') return EXIT_QUEUE_BOUND;
  return job.result?.exitCode || 1;
}

async function fetchResults(id: string, dir: string): Promise<void> {
  fs.mkdirSync(dir, { recursive: true });
  const res = await api(`/jobs/${id}/results`);
  if (res.status === 409) throw new Error('results are not ready yet'); // `run` waits this out through persist()
  const body = res.ok ? res.body : null;
  if (!body) return die(`results: HTTP ${res.status}`);
  const tar = spawn('tar', ['-xzf', '-', '-C', dir], { stdio: ['pipe', 'inherit', 'inherit'] });
  const done = new Promise<number | null>((r) => tar.on('close', r));
  for await (const chunk of body) {
    if (!tar.stdin.write(chunk)) await new Promise((r) => tar.stdin.once('drain', r));
  }
  tar.stdin.end();
  if ((await done) !== 0) die('results: tar failed');
  console.error(`pcb-job: results in ${dir}`);
}

// remote.sh's selection: design files only, no renders, fab outputs, reports or 3D models.
const SKIP_DIRS = new Set(['__pycache__', 'render', 'fab', 'reports']);
const DESIGN_EXT = ['.kicad_pcb', '.kicad_sch', '.kicad_pro', '.kicad_dru', '.kicad_sym', '.kicad_mod', '.json'];
const DESIGN_NAMES = new Set(['fp-lib-table', 'sym-lib-table']);

export function isDesignFile(name: string): boolean {
  return !name.startsWith('.') && (DESIGN_NAMES.has(name) || DESIGN_EXT.includes(path.extname(name)));
}

function copyDesign(src: string, dst: string): void {
  for (const e of fs.readdirSync(src, { withFileTypes: true })) {
    if (e.name.startsWith('.')) continue;
    const from = path.join(src, e.name);
    if (e.isDirectory()) {
      if (!SKIP_DIRS.has(e.name) && !e.name.endsWith('.3dshapes')) copyDesign(from, path.join(dst, e.name));
    } else if (isDesignFile(e.name)) {
      fs.mkdirSync(dst, { recursive: true });
      fs.cpSync(from, path.join(dst, e.name), { preserveTimestamps: true });
    }
  }
}

/**
 * The planes check refuses to run unless the evidence files named by these two tables are in the project, by sha256
 * (iotroute si-planes). remote.sh does not ship them. A missing file stays missing: the check reports it.
 */
function copyDriverEvidence(toolchain: string, project: string, stage: string): void {
  for (const name of ['driver-edges.json', 'edge-rates.json']) {
    const table = path.join(toolchain, 'tools', name);
    if (!fs.existsSync(table)) continue;
    const raw = JSON.parse(fs.readFileSync(table, 'utf8')) as { evidence_files?: { path: string }[] };
    for (const { path: rel } of raw.evidence_files ?? []) {
      const from = path.join(project, rel);
      if (fs.existsSync(from)) fs.cpSync(from, path.join(stage, rel), { preserveTimestamps: true });
    }
  }
}

/** Reuse the candidate workflow's declared input closure when the job performs full verification. */
function copySnapshot(toolchain: string, project: string, board: string, stage: string): void {
  const provider=path.join(toolchain,'tools/lib/pcb-sources.ts');
  const code="import {pathToFileURL} from 'node:url'; const [module,root,board]=process.argv.slice(1); const {sourceFiles}=await import(pathToFileURL(module).href); console.log(JSON.stringify(sourceFiles(root,board)));";
  const result=spawnSync(process.execPath,['--experimental-strip-types','--no-warnings','--input-type=module','-e',code,provider,project,path.basename(board)],
    {encoding:'utf8',timeout:30_000,maxBuffer:16*1024*1024,env:{...process.env,IOT_LAB:project}});
  if(result.status!==0)throw Error(`board snapshot failed: ${result.stderr?.trim()||result.error?.message}`);
  const files:unknown=JSON.parse(result.stdout);
  if(!Array.isArray(files)||files.some(f=>typeof f!=='string'))throw Error('invalid board snapshot file list');
  for(const file of files as string[]){
    const rel=path.relative(project,file);
    if(!rel||rel.startsWith('..')||path.isAbsolute(rel))throw Error(`snapshot dependency outside project: ${file}`);
    const real=path.relative(fs.realpathSync(project),fs.realpathSync(file));
    if(real.startsWith('..')||path.isAbsolute(real))throw Error(`snapshot symlink escapes project: ${rel}`);
    // The selected toolchain owns its tools; retain additional project semantic hooks.
    if(rel.startsWith('tools'+path.sep)&&fs.existsSync(path.join(stage,rel)))continue;
    fs.mkdirSync(path.dirname(path.join(stage,rel)),{recursive:true});
    fs.copyFileSync(file,path.join(stage,rel));
  }
}

/** Keep the frozen problem byte-identical; map its original source path to an explicit job input. */
export function stageLiveSources(project: string, stage: string, inputs: string[]): void {
  const mapping: Record<string, {source: string; file: string; sha256: string}> = {};
  for (const input of inputs) {
    if (!input.endsWith('.json') || fs.statSync(input).size > 32 * 1024 * 1024) continue;
    try {
      const bytes = fs.readFileSync(input), model = JSON.parse(bytes.toString('utf8'));
      if (!Array.isArray(model.units) || typeof model.board_file !== 'string' || !model.board_file.endsWith('.kicad_pcb')) continue;
      const source = fs.realpathSync(model.board_file), root = fs.realpathSync(project), relative = path.relative(root, source);
      if (!relative || relative.startsWith('..') || path.isAbsolute(relative) || fs.statSync(source).size > 128 * 1024 * 1024) continue;
      const board = fs.readFileSync(source), sha256 = createHash('sha256').update(board).digest('hex');
      const file = 'in/pcb-live-' + sha256 + '.kicad_pcb';
      fs.writeFileSync(path.join(stage, file), board);
      mapping[createHash('sha256').update(bytes).digest('hex')] = {source: model.board_file, file, sha256};
    } catch { /* Optional observation never changes submission or engineering validation. */ }
  }
  if (Object.keys(mapping).length) fs.writeFileSync(path.join(stage, '.pcb-live-sources.json'), JSON.stringify(mapping));
}

/** The job folder of tools/remote.sh, at the same relative paths, plus the driver evidence. The caller removes it. */
export function stageJob(toolchain: string, project: string, board: string, inputs: string[], snapshot=false): string {
  const rel = path.isAbsolute(board) ? path.relative(project, board) : board.replace(/\/$/, '');
  if (rel.startsWith('..') || !fs.statSync(path.join(project, rel), { throwIfNoEntry: false })?.isDirectory()) {
    die(`no board dir ${board} under ${project} (set IOT_LAB to the project root)`);
  }
  const stage = fs.mkdtempSync(path.join(os.tmpdir(), 'pcb-job-'));
  try {
    fs.cpSync(path.join(toolchain, 'tools'), path.join(stage, 'tools'), {
      recursive: true,
      preserveTimestamps: true,
      verbatimSymlinks: true,
      filter: (f) => !path.relative(path.join(toolchain,'tools'),f).split(path.sep).some(p=>['__pycache__','node_modules','target','.git','.gate'].includes(p)),
    });
    copyDesign(path.join(project, rel), path.join(stage, rel));
    copyDriverEvidence(toolchain, project, stage);
    if(snapshot)copySnapshot(toolchain,project,rel,stage);
    fs.mkdirSync(path.join(stage, 'in'));
    for (const f of inputs) fs.cpSync(f, path.join(stage, 'in', path.basename(f)), { preserveTimestamps: true });
    if (process.env.PCB_LIVE === '0') fs.writeFileSync(path.join(stage, '.pcb-live-disabled'), 'disabled\n');
    else stageLiveSources(project, stage, inputs);
    return stage;
  } catch (e) {
    fs.rmSync(stage, { recursive: true, force: true });
    throw e;
  }
}

export function pack(toolchain: string, project: string, board: string, inputs: string[], tarFile: string): void {
  const stage = stageJob(toolchain, project, board, inputs);
  try {
    packStage(stage, tarFile);
  } finally {
    fs.rmSync(stage, { recursive: true, force: true });
  }
}

function packStage(stage: string, tarFile: string): void {
  // COPYFILE_DISABLE and --no-xattrs: no macOS metadata entries for GNU tar on the host to trip over.
  const r = spawnSync('tar', ['--no-xattrs', '-czf', tarFile, '-C', stage, '.'], {
    env: { ...process.env, COPYFILE_DISABLE: '1' },
    stdio: 'inherit',
  });
  if (r.status !== 0) die('tar failed');
}

interface ManifestFile {
  path: string;
  sha256: string;
  mode: number;
  mtimeMs: number;
  bytes: number;
  source: string;
}

/** Every file of the stage with its hash, or null when it holds anything else: only the tar keeps a link. */
export function manifestOf(stage: string): ManifestFile[] | null {
  const files: ManifestFile[] = [];
  const walk = (dir: string): boolean => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const source = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (!walk(source)) return false;
      } else if (e.isFile()) {
        const st = fs.statSync(source);
        const sha256 = createHash('sha256').update(fs.readFileSync(source)).digest('hex');
        files.push({ path: path.relative(stage, source), sha256, mode: st.mode & 0o777, mtimeMs: st.mtimeMs, bytes: st.size, source });
      } else {
        return false;
      }
    }
    return true;
  };
  return walk(stage) ? files : null;
}

/** Two at a time: the daemon's upload slots are shared with other clients. */
const SEND_AT_ONCE = 2;
const BUSY_RETRIES = 60;

async function sendBlob(f: ManifestFile): Promise<void> {
  for (let i = 0; i < BUSY_RETRIES; i++) {
    const res = await api(`/blobs/${f.sha256}`, { method: 'PUT', body: await fs.openAsBlob(f.source) });
    if (res.ok) return;
    if (res.status !== 503) die(`${res.status}: upload of ${f.path} failed`);
    await sleep(2000);
  }
  die(`upload of ${f.path}: daemon busy`);
}

/** The job as a manifest: only the files the daemon lacks cross the network. null when the daemon has no cache. */
async function sendCached(spec: Parsed['spec'], stage: string): Promise<JobRecord | null> {
  const files = manifestOf(stage);
  if (!files) return null;
  const header = Buffer.from(JSON.stringify(spec)).toString('base64');
  for (let round = 0; round < 2; round++) {
    const asked = await api('/blobs/missing', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ sha256: files.map((f) => f.sha256) }),
    });
    if (asked.status === 404) return null;
    if (!asked.ok) die(`${asked.status}: cache check failed`);
    const missing = new Set(((await asked.json()) as { missing: string[] }).missing);
    const send = [...new Map(files.filter((f) => missing.has(f.sha256)).map((f) => [f.sha256, f])).values()];
    const bytes = send.reduce((n, f) => n + f.bytes, 0);
    console.error(`pcb-job: cache: ${files.length} files, sending ${send.length} (${Math.ceil(bytes / 1024)} KB)`);
    const queue = [...send];
    await Promise.all(Array.from({ length: SEND_AT_ONCE }, async () => {
      for (let f = queue.shift(); f; f = queue.shift()) await sendBlob(f);
    }));
    const res = await api('/jobs', {
      method: 'POST',
      headers: { 'x-job-spec': header, 'content-type': 'application/json' },
      body: JSON.stringify({ files: files.map(({ path: p, sha256, mode, mtimeMs }) => ({ path: p, sha256, mode, mtimeMs })) }),
    });
    if (res.status === 409) continue; // a file left the cache between the check and the job
    const body = (await res.json()) as JobRecord & { error?: string };
    if (!res.ok) die(`${res.status}: ${body.error ?? 'request failed'}`);
    return body;
  }
  return die('the cache lost files twice during one submit');
}

interface Parsed {
  board: string;
  inputs: string[];
  results: string;
  spec: Record<string, unknown>;
  fit: boolean;
  snapshot: boolean;
}

function parseSubmit(argv: string[]): Parsed {
  const split = argv.indexOf('--');
  if (split < 1 || split === argv.length - 1) die(USAGE);
  const command = argv.slice(split + 1);
  const opts = argv.slice(1, split);
  const p: Parsed = { board: argv[0], inputs: [], results: '', spec: { command }, fit: false, snapshot:false };
  const retryExitCodes: number[] = [];
  for (let i = 0; i < opts.length; i += 2) {
    const [k, v] = [opts[i], opts[i + 1]];
    if (v === undefined) die(`${k} needs a value`);
    if (k === '--in') p.inputs.push(fs.existsSync(v) ? v : die(`no input file ${v}`));
    else if (k === '--results') p.results = v;
    else if (k === '--cpus') p.spec.cpus = Number(v);
    else if (k === '--mem') p.spec.memGb = Number(v);
    else if (k === '--disk') p.spec.diskGb = Number(v);
    else if (k === '--timeout') p.spec.timeoutS = Number(v);
    else if (k === '--queue-wait') p.spec.queueWaitS = Number(v);
    else if (k === '--retries') p.spec.maxRetries = Number(v);
    else if (k === '--retry-exit') retryExitCodes.push(Number(v));
    else if (k === '--image') p.spec.image = v;
    else if (k === '--name') p.spec.name = v;
    else if (k === '--fit') p.fit = v === 'budget' || die('--fit takes the value budget');
    else if (k === '--snapshot') p.snapshot = v === 'board' || die('--snapshot takes the value board');
    else die(`unknown option ${k}\n${USAGE}`);
  }
  if (retryExitCodes.length) p.spec.retryExitCodes = retryExitCodes;
  return p;
}

/** --fit budget: lower --cpus and --mem to what the daemon allows, for callers written for a bigger machine. */
async function fitBudget(p: Parsed): Promise<void> {
  if (!p.fit) return;
  const { budget } = await apiJson<{ budget: { cpus: number; memGb: number } }>('/status');
  for (const [key, most] of [['cpus', budget.cpus], ['memGb', budget.memGb]] as const) {
    const asked = p.spec[key];
    if (typeof asked === 'number' && asked > most) {
      console.error(`pcb-job: ${key} ${asked} is over the daemon budget, using ${most}`);
      p.spec[key] = most;
    }
  }
}

async function submit(p: Parsed): Promise<JobRecord> {
  await fitBudget(p);
  const here = path.dirname(fileURLToPath(import.meta.url));
  const toolchain = process.env.PCB_TOOLCHAIN_ROOT || path.resolve(here, '../../..');
  const project = process.env.IOT_LAB || toolchain;
  if (!p.spec.name) p.spec.name = path.basename(p.board);
  const stage = stageJob(toolchain, project, p.board, p.inputs,p.snapshot);
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pcb-job-tar-'));
  try {
    const cached = await sendCached(p.spec, stage);
    if (cached) return cached;
    const tarFile = path.join(tmp, 'input.tar.gz');
    packStage(stage, tarFile);
    const header = Buffer.from(JSON.stringify(p.spec)).toString('base64');
    return await apiJson<JobRecord>('/jobs', {
      method: 'POST',
      headers: { 'x-job-spec': header, 'content-type': 'application/gzip' },
      body: await fs.openAsBlob(tarFile),
    });
  } finally {
    fs.rmSync(stage, { recursive: true, force: true });
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

async function main(): Promise<void> {
  const [cmd, ...rest] = process.argv.slice(2);
  const print = (o: unknown): void => console.log(JSON.stringify(o, null, 2));
  switch (cmd) {
    case 'observe': case 'observe-resume': {
      process.exitCode=await observeLocal(rest,cmd==='observe-resume'); return;
    }
    case 'submit': {
      console.log((await submit(parseSubmit(rest))).id);
      return;
    }
    case 'run': {
      const p = parseSubmit(rest);
      const { id } = await submit(p);
      console.error(`pcb-job: job ${id}`);
      const job = await watch(id);
      await persist('results', () => fetchResults(id, p.results || path.join(os.tmpdir(), 'pcb-job', id)));
      process.exit(exitCodeOf(job));
      return;
    }
    case 'watch': {
      process.exit(exitCodeOf(await watch(rest[0] ?? die(USAGE))));
      return;
    }
    case 'status':
      print(await apiJson(rest[0] ? `/jobs/${rest[0]}` : '/status'));
      return;
    case 'list':
      for (const j of await apiJson<JobRecord[]>('/jobs')) {
        const held = j.hold ? `  held: ${j.hold}` : '';
        console.log(`${j.id}  ${j.state.padEnd(9)}  attempts ${j.attempts.length}  cpus ${j.spec.cpus}  ${j.spec.name}${held}`);
      }
      return;
    case 'cancel':
      print(await apiJson(`/jobs/${rest[0] ?? die(USAGE)}/cancel`, { method: 'POST' }));
      return;
    case 'results': {
      const id = rest[0] ?? die(USAGE);
      await fetchResults(id, rest[1] ?? path.join(os.tmpdir(), 'pcb-job', id));
      return;
    }
    default:
      die(USAGE);
  }
}

if (process.argv[1] && fs.realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((e: unknown) => die(String(e), 1));
}

/** Mac-side upload only. The command and its native result are unchanged by observation failures. */
async function observeLocal(args:string[],resume:boolean):Promise<number>{
 const [parent,separator,...command]=args;if(!parent||(!resume&&(separator!=='--'||!command.length)))throw Error('observe SPOOL -- COMMAND or observe-resume SPOOL');
 fs.mkdirSync(parent,{recursive:true});const out=resume?path.resolve(parent):fs.mkdtempSync(path.join(path.resolve(parent),'attempt-'));
 const meta=path.join(out,'observer.json');
 const job:ObservedJob=resume?JSON.parse(fs.readFileSync(meta,'utf8')):{id:'local-'+createHash('sha256').update(out).digest('hex').slice(0,24),name:path.basename(parent),state:'running',host:os.hostname(),attempts:[{n:1,out}]};
 job.attempts[0].out=out;let code=0,ended=resume;
 if(resume&&!job.attempts[0].endedAt){job.state='failed';job.attempts[0].endedAt=new Date().toISOString()}
 const save=():void=>{fs.writeFileSync(meta+'.tmp',JSON.stringify(job));fs.renameSync(meta+'.tmp',meta)};save();
 const request=async(p:string,init:RequestInit):Promise<void>=>{const r=await api(p,{...init,signal:AbortSignal.timeout(3000)});const body=await r.text();if(!r.ok)throw Error(`live HTTP ${r.status}: ${body.slice(0,200)}`)};
 const observer=new LiveJobs(()=>[job],{importBoard:(bytes,sha)=>request('/live/assets/'+sha,{method:'PUT',body:new Uint8Array(bytes)}),append:events=>request('/live/events',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({events})})});
 if(!resume){
  const child=spawn(command[0]!,command.slice(1),{stdio:'inherit',env:{...process.env,PCB_LIVE_DIR:out}});
  child.on('error',()=>{code=127;ended=true;job.state='failed';job.attempts[0].endedAt=new Date().toISOString();save()});
  child.on('close',(status,signal)=>{code=status??128+(os.constants.signals[signal as NodeJS.Signals]??0);ended=true;job.state=code===0?'passed':'failed';job.attempts[0].endedAt=new Date().toISOString();save()});
 }
 let finishDeadline=Infinity;
 do{await observer.poll();if(ended){if(observer.settled())break;if(finishDeadline===Infinity)finishDeadline=Date.now()+10000;}await sleep(100)}while(Date.now()<finishDeadline)
 if(!observer.settled())console.error(`Live observation retained at ${out}; retry with pcb-job observe-resume ${out}`);
 observer.stop();return code;
}
