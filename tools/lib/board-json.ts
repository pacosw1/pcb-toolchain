// Board JSON for Mac-side tools. Reads go through the KiCad API on Hetzner only, on one pinned nightly, so a board goes there
// once: `iotroute board-json` runs as a small daemon job and the result is kept by content. Any change to the board, its
// project or rules, the JSON schema or the pinned KiCad commit misses the cache.
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { projectName } from './board-edit.ts';
import { sha256File } from './json-file.ts';
import { fileRoot } from './project-root.mjs';

/** The version this code reads. It must equal the schema_version `iotroute board-json` writes. */
export const BOARD_JSON_SCHEMA = 1;

const BINARY = 'iotroute-linux-x86_64';
const DOCUMENT = 'board.json';
/** To tune. A read takes seconds; 0.62 s to start a server on MC-MAIN, the largest board. */
const JOB_TIMEOUT_S = 300;
const JOB_CPUS = 1;
const JOB_MEM_GB = 2;

export interface BoardDocument { schema_version: number }

export interface FetchInput { pcb: string; project: string[]; kicadCommit: string }
/** Writes the board's JSON to `file`. */
export type BoardFetcher = (input: FetchInput, file: string) => void;

export interface BoardJsonOptions { cacheDir?: string; schema?: number; kicadCommit?: string; fetcher?: BoardFetcher }

const defaultCacheDir = (): string =>
  join(process.env.XDG_CACHE_HOME || join(homedir(), '.cache'), 'pcb-toolchain', 'board-json');

/** The KiCad commit the protos are pinned to: the one source of what the API server must be. */
export function pinnedKicadCommit(toolchain = fileRoot): string {
  const pin = readFileSync(join(toolchain, 'tools/router/core/proto/PIN'), 'utf8');
  const commit = pin.match(/at commit ([0-9a-f]{40})/)?.[1];
  if (!commit) throw new Error('tools/router/core/proto/PIN names no commit');
  return commit;
}

/** The .kicad_pro and .kicad_dru of the board that exist. */
function projectFiles(pcb: string): string[] {
  const project = projectName(pcb);
  if (project === null) return [];
  return ['kicad_pro', 'kicad_dru'].map(suffix => join(dirname(pcb), `${project}.${suffix}`)).filter(file => existsSync(file));
}

export function cacheKey(pcb: string, schema: number, kicadCommit: string): string {
  const fileHash = (suffix: string) => {
    const file = projectFiles(pcb).find(name => name.endsWith(suffix));
    return `${suffix}=${file ? sha256File(file) : 'absent'}`;
  };
  const parts = [`.kicad_pcb=${sha256File(pcb)}`, fileHash('.kicad_pro'), fileHash('.kicad_dru'), `schema=${schema}`, `kicad=${kicadCommit}`];
  return createHash('sha256').update(parts.join('\n')).digest('hex');
}

function checkedDocument(text: string, schema: number, source: string): BoardDocument {
  const document = JSON.parse(text) as BoardDocument;
  if (document.schema_version !== schema) {
    throw new Error(`${source}: board JSON schema ${document.schema_version}, this tool reads ${schema}`);
  }
  return document;
}

/** The board's JSON, from the cache when nothing in the key changed. A file that fails the check is never kept. */
export function boardJson(pcb: string, options: BoardJsonOptions = {}): BoardDocument {
  const { cacheDir = defaultCacheDir(), schema = BOARD_JSON_SCHEMA, kicadCommit = pinnedKicadCommit(), fetcher = fetchThroughDaemon } = options;
  const cached = join(cacheDir, `${cacheKey(pcb, schema, kicadCommit)}.json`);
  if (existsSync(cached)) return checkedDocument(readFileSync(cached, 'utf8'), schema, cached);
  mkdirSync(cacheDir, { recursive: true });
  const fresh = `${cached}.${process.pid}`;
  try {
    fetcher({ pcb, project: projectFiles(pcb), kicadCommit }, fresh);
    const document = checkedDocument(readFileSync(fresh, 'utf8'), schema, pcb);
    renameSync(fresh, cached);
    return document;
  } finally {
    rmSync(fresh, { force: true });
  }
}

/** The client arguments of the job. Files reach it through --in, so a scratch copy outside the project works too. */
export function jobArguments(input: FetchInput, binary: string, image: string, results: string): string[] {
  const script = `mkdir -p out && chmod +x in/${BINARY} && exec in/${BINARY} board-json "in/$1" > out/${DOCUMENT}`;
  return ['run', 'job', ...[input.pcb, ...input.project, binary].flatMap(file => ['--in', file]), '--image', image,
    '--timeout', String(JOB_TIMEOUT_S), '--cpus', String(JOB_CPUS), '--mem', String(JOB_MEM_GB), '--results', results,
    '--', 'sh', '-c', script, '_', basename(input.pcb)];
}

function jobClient(toolchain: string): string {
  const client = [join(toolchain, 'tools/pcb-job/client.ts'), join(toolchain, 'apps/job-daemon/src/client.ts')].find(file => existsSync(file));
  if (!client) throw new Error(`no job client under ${toolchain}`);
  return client;
}

/**
 * One daemon job. The client stages a project and its tools; here they are an empty stand-in, because the read needs only the
 * board files and the binary. KICAD_API_IMAGE names the pinned image. An error stops the tool: a read never falls back to the Mac.
 */
export function fetchThroughDaemon(input: FetchInput, file: string): void {
  const toolchain = process.env.PCB_TOOLCHAIN_ROOT || fileRoot;
  const image = process.env.KICAD_API_IMAGE;
  if (!image) throw new Error('board JSON: set KICAD_API_IMAGE to the pinned KiCad image');
  const binary = join(toolchain, 'bin', BINARY);
  if (!existsSync(binary)) throw new Error(`board JSON: no ${binary}`);
  const standIn = mkdtempSync(join(tmpdir(), 'board-json-'));
  try {
    mkdirSync(join(standIn, 'tools'));
    mkdirSync(join(standIn, 'job'));
    const results = join(standIn, 'results');
    const run = spawnSync(process.execPath, ['--experimental-strip-types', '--no-warnings', jobClient(toolchain),
      ...jobArguments(input, binary, image, results)],
      { encoding: 'utf8', env: { ...process.env, IOT_LAB: standIn, PCB_TOOLCHAIN_ROOT: standIn } });
    if (run.status !== 0) throw new Error(`board JSON job of ${input.pcb} ended with ${run.status}: ${run.stderr.slice(-500)}`);
    copyFileSync(join(results, 'out', DOCUMENT), file);
  } finally {
    rmSync(standIn, { recursive: true, force: true });
  }
}
