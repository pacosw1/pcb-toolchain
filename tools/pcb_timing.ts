// Run one measured workflow stage, preserving command output and exit status.
//   tools/pcb_timing.ts --events FILE --stage NAME [--category operation] [--producer fabrication] -- COMMAND...
import { spawnSync } from 'node:child_process';
import { appendFileSync, mkdirSync } from 'node:fs';
import { constants } from 'node:os';
import { dirname } from 'node:path';
import { runMain, UsageError } from './lib/cli.ts';
import { jsonDumps, utcNow } from './lib/py-compat.mjs';
import { MeasuredSpan } from './lib/timing.ts';

const USAGE = 'usage: tools/pcb_timing.ts --events FILE --stage NAME [--category C] [--producer P] -- COMMAND...';
const VALUE_OPTIONS = ['--events', '--stage', '--category', '--producer'];

interface Options { events: string; stage: string; category: string; producer: string; command: string[] }

function parseArguments(argv: string[]): Options {
  const values = new Map<string, string>();
  let index = 0;
  for (; index < argv.length; index += 2) {
    const flag = argv[index]!;
    if (!VALUE_OPTIONS.includes(flag)) break;
    const value = argv[index + 1];
    if (value === undefined) throw new UsageError(USAGE);
    values.set(flag, value);
  }
  const rest = argv.slice(index);
  const command = rest[0] === '--' ? rest.slice(1) : rest;
  const events = values.get('--events');
  const stage = values.get('--stage');
  if (events === undefined || stage === undefined || !command.length) throw new UsageError(USAGE);
  return { events, stage, command, category: values.get('--category') ?? 'operation', producer: values.get('--producer') ?? 'fabrication' };
}

function main(argv: string[]): number {
  const { events, stage, category, producer, command } = parseArguments(argv);
  mkdirSync(dirname(events), { recursive: true });
  const emit = (type: string, data: object) =>
    appendFileSync(events, `${jsonDumps({ schema_version: 1, time: utcNow(), type, ...data })}\n`);
  const span = new MeasuredSpan(stage, category, producer);
  emit('stage.start', span.fields);
  const [program, ...args] = command as [string, ...string[]];
  const result = spawnSync(program, args, { stdio: 'inherit' });
  if (result.error) {
    emit('stage.end', span.end('error'));
    throw result.error;
  }
  const code = result.status ?? 128 + (constants.signals[result.signal!] ?? 0);
  emit('stage.end', span.end(code === 0 ? 'passed' : 'failed', { code: result.status ?? -(code - 128) }));
  return code;
}

runMain(import.meta.url, main);
