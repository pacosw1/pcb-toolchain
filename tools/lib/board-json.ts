// Board JSON for Mac-side tools. Reads go through the KiCad API on Hetzner only, on one pinned nightly, so a board goes there
// once: `iotroute board-json` runs as a small daemon job and the result is kept by content. Any change to the board, its
// project or rules, the JSON schema or the pinned KiCad commit misses the cache.
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { projectName, saveBoard } from './board-edit.ts';
import type { BoardDocument } from './board-types.ts';
import { sha256File } from './json-file.ts';
import { fileRoot } from './project-root.mjs';

/** The schema this code reads, as `iotroute board-json` names it. */
export const BOARD_JSON_SCHEMA = 'iot-lab.board.v1';
/** KiCad 10 and the pinned nightly in one image: tools/remote-route-nightly.Dockerfile. */
const BOARD_JSON_IMAGE = 'iot-lab-route:10.0-nightly-4fe1ca2060';

const BINARY = 'iotroute-linux-x86_64';
const DOCUMENT = 'board.json';
/** To tune. A read takes seconds; 0.62 s to start a server on MC-MAIN, the largest board. */
const JOB_TIMEOUT_S = 300;
const JOB_CPUS = 1;
const JOB_MEM_GB = 2;

export interface FetchInput { pcb: string; project: string[]; kicadCommit: string }
/** Writes the board's JSON to `file`. */
export type BoardFetcher = (input: FetchInput, file: string) => void;

export interface BoardJsonOptions {
  cacheDir?: string; schema?: string; kicadCommit?: string; fetcher?: BoardFetcher;
  /** Read a copy whose zones KiCad 10 refilled. For checks of filled copper: the file may hold a stale fill. */
  refill?: boolean;
  /** The refill step; tests replace it. */
  refiller?: (pcb: string, outDir: string) => string;
}

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

export function cacheKey(pcb: string, schema: string, kicadCommit: string, refill = false): string {
  const fileHash = (suffix: string) => {
    const file = projectFiles(pcb).find(name => name.endsWith(suffix));
    return `${suffix}=${file ? sha256File(file) : 'absent'}`;
  };
  const parts = [`.kicad_pcb=${sha256File(pcb)}`, fileHash('.kicad_pro'), fileHash('.kicad_dru'), `schema=${schema}`, `kicad=${kicadCommit}`, `refill=${refill}`];
  return createHash('sha256').update(parts.join('\n')).digest('hex');
}

function checkedDocument(text: string, schema: string, kicadCommit: string, source: string): BoardDocument {
  const document = JSON.parse(text) as BoardDocument;
  if (document.schema !== schema) throw new Error(`${source}: board JSON schema ${document.schema}, this tool reads ${schema}`);
  if (document.kicad_commit !== kicadCommit) throw new Error(`${source}: read by KiCad ${document.kicad_commit}, not the pinned ${kicadCommit}`);
  return document;
}

/** KiCad 10 refills every zone of a copy and saves it; the source is only read. */
function refilledCopy(pcb: string, outDir: string): string {
  return saveBoard(pcb, readFileSync(pcb, 'utf8'), outDir).board;
}

/** The board's JSON, from the cache when nothing in the key changed. A file that fails the check is never kept. */
export function boardJson(pcb: string, options: BoardJsonOptions = {}): BoardDocument {
  const { cacheDir = defaultCacheDir(), schema = BOARD_JSON_SCHEMA, kicadCommit = pinnedKicadCommit(), fetcher = fetchThroughDaemon } = options;
  const { refill = false, refiller = refilledCopy } = options;
  const cached = join(cacheDir, `${cacheKey(pcb, schema, kicadCommit, refill)}.json`);
  if (existsSync(cached)) return checkedDocument(readFileSync(cached, 'utf8'), schema, kicadCommit, cached);
  mkdirSync(cacheDir, { recursive: true });
  const fresh = `${cached}.${process.pid}`;
  const work = mkdtempSync(join(tmpdir(), 'board-refill-'));
  try {
    const source = refill ? refiller(pcb, work) : pcb;
    fetcher({ pcb: source, project: projectFiles(source), kicadCommit }, fresh);
    const document = checkedDocument(readFileSync(fresh, 'utf8'), schema, kicadCommit, pcb);
    if (document.board_sha256 !== sha256File(source)) throw new Error(`${pcb}: the board JSON is of another file`);
    renameSync(fresh, cached);
    return document;
  } finally {
    rmSync(fresh, { force: true });
    rmSync(work, { recursive: true, force: true });
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
 * board files and the binary. An error stops the tool: a read never falls back to the Mac.
 */
export function fetchThroughDaemon(input: FetchInput, file: string): void {
  const toolchain = process.env.PCB_TOOLCHAIN_ROOT || fileRoot;
  const binary = join(toolchain, 'bin', BINARY);
  if (!existsSync(binary)) throw new Error(`board JSON: no ${binary}`);
  const standIn = mkdtempSync(join(tmpdir(), 'board-json-'));
  try {
    mkdirSync(join(standIn, 'tools'));
    mkdirSync(join(standIn, 'job'));
    const results = join(standIn, 'results');
    const run = spawnSync(process.execPath, ['--experimental-strip-types', '--no-warnings', jobClient(toolchain),
      ...jobArguments(input, binary, BOARD_JSON_IMAGE, results)],
      { encoding: 'utf8', env: { ...process.env, IOT_LAB: standIn, PCB_TOOLCHAIN_ROOT: standIn } });
    if (run.status !== 0) throw new Error(`board JSON job of ${input.pcb} ended with ${run.status}: ${run.stderr.slice(-500)}`);
    copyFileSync(join(results, 'out', DOCUMENT), file);
  } finally {
    rmSync(standIn, { recursive: true, force: true });
  }
}
