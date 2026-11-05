// Board JSON for Mac-side tools. Reads go through the KiCad API on Hetzner only, on one pinned nightly, so a board goes there
// once: `iotroute board-json` runs as a small daemon job and the result is kept by content. Any change to the board, its
// project or rules, the JSON schema or the pinned KiCad commit misses the cache.
import { copyFileSync, existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { projectName, saveBoard } from './board-edit.ts';
import type { BoardDocument } from './board-types.ts';
import { cacheFolder, cachedWhole, contentKey, runDaemonJob, type DaemonJob } from './daemon-job.ts';
import { PINNED_IMAGE } from './env.mjs';
import { sha256File } from './json-file.ts';
import { fileRoot } from './project-root.mjs';

/** The schema this code reads, as `iotroute board-json` names it. */
export const BOARD_JSON_SCHEMA = 'iot-lab.board.v1';

/** Goes up when the document gains fields under the same schema, so a cached copy without them is not used. */
const DOCUMENT_REVISION = 3;

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
  const parts = [`.kicad_pcb=${sha256File(pcb)}`, fileHash('.kicad_pro'), fileHash('.kicad_dru'), `schema=${schema}`, `kicad=${kicadCommit}`, `refill=${refill}`, `revision=${DOCUMENT_REVISION}`];
  return contentKey(parts);
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
  const { cacheDir = cacheFolder('board-json'), schema = BOARD_JSON_SCHEMA, kicadCommit = pinnedKicadCommit(), fetcher = fetchThroughDaemon } = options;
  const { refill = false, refiller = refilledCopy } = options;
  const cached = join(cacheDir, `${cacheKey(pcb, schema, kicadCommit, refill)}.json`);
  const read = (file: string) => checkedDocument(readFileSync(file, 'utf8'), schema, kicadCommit, file);
  return cachedWhole(cached, read, fresh => {
    const work = mkdtempSync(join(tmpdir(), 'board-refill-'));
    try {
      const source = refill ? refiller(pcb, work) : pcb;
      fetcher({ pcb: source, project: projectFiles(source), kicadCommit }, fresh);
      const document = checkedDocument(readFileSync(fresh, 'utf8'), schema, kicadCommit, pcb);
      if (document.board_sha256 !== sha256File(source)) throw new Error(`${pcb}: the board JSON is of another file`);
      return document;
    } finally {
      rmSync(work, { recursive: true, force: true });
    }
  });
}

/** The read as a job: the board files and the binary, and nothing else. */
export function boardJob(input: FetchInput, binary: string, image: string): DaemonJob {
  const script = `mkdir -p out && chmod +x in/${BINARY} && exec in/${BINARY} board-json "in/$1" > out/${DOCUMENT}`;
  return { label: `board JSON job of ${input.pcb}`, inputs: [input.pcb, ...input.project, binary], image,
    timeoutS: JOB_TIMEOUT_S, cpus: JOB_CPUS, memGb: JOB_MEM_GB, command: ['sh', '-c', script, '_', basename(input.pcb)] };
}

/** One small daemon job. An error stops the tool: a read never falls back to the Mac. */
export function fetchThroughDaemon(input: FetchInput, file: string): void {
  const binary = join(process.env.PCB_TOOLCHAIN_ROOT || fileRoot, 'bin', BINARY);
  if (!existsSync(binary)) throw new Error(`board JSON: no ${binary}`);
  runDaemonJob(boardJob(input, binary, PINNED_IMAGE), out => copyFileSync(join(out, DOCUMENT), file));
}
