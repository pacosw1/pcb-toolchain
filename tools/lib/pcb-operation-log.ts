// What a supervised operation reports: its operation/events.jsonl, the child tools it runs, and the worker reading those
// events and the gate's back as complete lines.
import { spawn } from 'node:child_process';
import { appendFileSync, closeSync, fstatSync, mkdirSync, openSync, readSync, writeSync } from 'node:fs';
import { join } from 'node:path';
import { MeasuredSpan } from './timing.ts';

export type Row = Record<string, unknown>;
export type Emit = (kind: string, data?: Row) => void;

const TEXT_LIMIT = 1600;
const PRODUCER = 'operations';

export function operationEvent(folder: string, kind: string, data: Row = {}): void {
  mkdirSync(join(folder, 'operation'), { recursive: true });
  appendFileSync(join(folder, 'operation/events.jsonl'), JSON.stringify({ schema_version: 1, time: new Date().toISOString(), type: kind, ...data }) + '\n');
}

export async function measuredStage<T>(emit: Emit, stage: string, category: string | null, work: () => T | Promise<T>): Promise<T> {
  const span = new MeasuredSpan(stage, category, PRODUCER);
  emit('stage.start', { ...span.fields });
  try {
    const value = await work();
    emit('stage.end', span.end());
    return value;
  } catch (error) {
    emit('stage.end', span.end('error'));
    throw error;
  }
}

/** Runs one tool to its end, keeping its output in operation/STAGE.log and streaming it as events. A signal is a nonzero exit. */
export function execute(folder: string, stage: string, command: string[], cwd: string, env: NodeJS.ProcessEnv): Promise<number> {
  const log = join(folder, 'operation', `${stage}.log`), span = new MeasuredSpan(stage, null, PRODUCER);
  operationEvent(folder, 'tool.start', { ...span.fields, log, command });
  const file = openSync(log, 'w');
  return new Promise<number>((resolve, reject) => {
    const child = spawn(command[0]!, command.slice(1), { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] });
    const output = (chunk: Buffer): void => {
      writeSync(file, chunk);
      const text = chunk.toString();
      operationEvent(folder, 'tool.output', { stage, span_id: span.fields.span_id, producer: PRODUCER, bytes: chunk.length, stream: 'stdout',
        text: text.slice(0, TEXT_LIMIT), truncated: text.length > TEXT_LIMIT });
    };
    child.stdout.on('data', output);
    child.stderr.on('data', output);
    child.once('error', error => {
      operationEvent(folder, 'tool.exit', { ...span.end('error', { code: null }), log });
      reject(error);
    });
    child.once('close', (code, signal) => {
      const exit = code ?? (signal ? 128 : 1);
      operationEvent(folder, 'tool.exit', { ...span.end(exit === 0 ? 'passed' : 'failed', { code: exit }), log });
      resolve(exit);
    });
  }).finally(() => closeSync(file));
}

/** A successful release moves its work folder to candidate/: one cursor per file keeps promotion from replaying its events. */
const RELEASE_FILES = ['gate/events.jsonl', 'stages.jsonl'];

function completeLines(path: string, offset: number): { rows: Row[]; offset: number } {
  let file: number;
  try {
    file = openSync(path, 'r');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { rows: [], offset };
    throw error;
  }
  try {
    const size = fstatSync(file).size - offset;
    if (size <= 0) return { rows: [], offset };
    const bytes = Buffer.alloc(size);
    const count = readSync(file, bytes, 0, size, offset);
    const end = bytes.subarray(0, count).lastIndexOf(0x0a) + 1;   // an unfinished last write stays unread
    const rows = bytes.subarray(0, end).toString('utf8').split('\n').filter(Boolean).map(line => JSON.parse(line) as Row);
    return { rows, offset: offset + end };
  } finally {
    closeSync(file);
  }
}

export class ProducerEvents {
  readonly #offsets = new Map<string, number>();
  readonly #folder: string;
  constructor(folder: string) { this.#folder = folder; }

  /** The new complete events of every producer of the run, oldest first. */
  read(): Row[] {
    const sources: [string, string][] = ['operation/events.jsonl', 'gate/events.jsonl'].map(name => [name, join(this.#folder, name)]);
    for (const name of RELEASE_FILES) {
      const moved = ['release-work', 'candidate'].map(prefix => join(this.#folder, prefix, name));
      const current = moved.find(path => { try { closeSync(openSync(path, 'r')); return true; } catch { return false; } });
      sources.push([`release/${name}`, current ?? moved[0]!]);
    }
    const rows: Row[] = [];
    for (const [key, path] of sources) {
      const found = completeLines(path, this.#offsets.get(key) ?? 0);
      for (const row of found.rows) {
        if (row.schema_version !== 1 || typeof row.type !== 'string') throw new Error('invalid producer event');
        rows.push(row);
      }
      this.#offsets.set(key, found.offset);
    }
    return rows.sort((a, b) => String(a.time ?? '').localeCompare(String(b.time ?? '')));
  }
}
