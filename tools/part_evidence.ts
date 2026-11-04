// Content-addressed PDF inspection and source-bound reviewed native part use.
//
// Inspection never selects a part. A verified review establishes only its explicit engineering facts; stock, ERC/DRC,
// assembly, release and qualification are separate.
//
//   tools/part_evidence.ts status BOARD
//   tools/part_evidence.ts verify BOARD --manifest FILE
//   tools/part_evidence.ts selection BOARD --manifest FILE
//   tools/part_evidence.ts inspect FILE.pdf [--cache DIR] [--render-pages 1,13] [--dpi 144]
//   tools/part_evidence.ts stock BOARD --candidate DIR --boards N --receipts DIR
// All take [--root DIR] [--output FILE] [--json]. Exit 0 when passed, inspected or observed, else 1; 2 on bad usage.
import { parseArgs } from 'node:util';
import { runMain, UsageError } from './lib/cli.ts';
import { atomicJson } from './lib/json-file.ts';
import { sha } from './lib/pcb-workflow.ts';
import { defaultCache, inspectPdf } from './lib/pdf-evidence.ts';
import { SCHEMA, statusBoard, verifyManifest, verifySelection } from './lib/part-review.ts';
import { stockBoard } from './lib/part-stock.ts';
import { projectRoot } from './lib/project-root.mjs';
import { jsonCanonical, jsonDumps, pyStr } from './lib/py-compat.mjs';
import { caught, resolvePath } from './lib/py-path.ts';
import { sortKeys } from './lib/py-dict.ts';

const COMMANDS = ['status', 'verify', 'selection', 'inspect', 'stock'];
const SUMMARY = ['schema', 'scope', 'status', 'board', 'qualified', 'native_verified', 'cad_verified', 'stock_verified', 'stock_current'];
const INSPECT_SUMMARY = ['pdf', 'cache_hit', 'text_cache_hit', 'cache_key', 'text_cache_key', 'cache_directory', 'text_cache_directory'];
const SUCCESS = new Set(['passed', 'inspected', 'observed']);
const OUTER_ERRORS = ['OSError', 'ValueError', 'KeyError', 'RuntimeError', 'subprocess.TimeoutExpired', 'subprocess.CalledProcessError'];
const OPTIONS = {
  root: { type: 'string' }, output: { type: 'string' }, json: { type: 'boolean' }, manifest: { type: 'string' }, cache: { type: 'string' },
  'render-pages': { type: 'string' }, dpi: { type: 'string' }, candidate: { type: 'string' }, boards: { type: 'string' }, receipts: { type: 'string' },
} as const;
const ALLOWED: Record<string, string[]> = {
  status: [], verify: ['manifest'], selection: ['manifest'], inspect: ['cache', 'render-pages', 'dpi'], stock: ['candidate', 'boards', 'receipts'],
};
const REQUIRED: Record<string, string[]> = { verify: ['manifest'], selection: ['manifest'], stock: ['candidate', 'boards', 'receipts'] };

type Values = Partial<Record<keyof typeof OPTIONS, string | boolean>>;
interface Arguments { command: string; target: string; values: Values }
type Result = { status: string; [field: string]: unknown };

function parseCommand(argv: string[]): Arguments {
  let parsed;
  try {
    parsed = parseArgs({ args: argv, options: OPTIONS, allowPositionals: true });
  } catch (error) {
    throw new UsageError(`part_evidence: error: ${(error as Error).message}`);
  }
  const [command, target, ...rest] = parsed.positionals;
  if (command === undefined || !COMMANDS.includes(command)) throw new UsageError(`part_evidence: error: expected a command of ${COMMANDS.join(', ')}`);
  if (target === undefined || rest.length) throw new UsageError(`part_evidence: error: ${command} takes one target`);
  const values = parsed.values as Values;
  const common = ['root', 'output', 'json'];
  for (const name of Object.keys(values)) {
    if (!common.includes(name) && !(ALLOWED[command] as string[]).includes(name)) throw new UsageError(`part_evidence: error: unrecognized arguments: --${name}`);
  }
  const missing = (REQUIRED[command] ?? []).filter(name => values[name as keyof Values] === undefined);
  if (missing.length) throw new UsageError(`part_evidence: error: the following arguments are required: ${missing.map(name => `--${name}`).join(', ')}`);
  return { command, target, values };
}

function integer(text: string, flag: string): number {
  const value = text.trim();
  if (!/^[+-]?\d+$/.test(value)) throw new UsageError(`part_evidence: error: argument --${flag}: invalid int value: '${text}'`);
  return Number(value);
}

function pageList(text: string): number[] {
  return text.split(',').filter(Boolean).map(page => {
    if (!/^\s*[+-]?\d+\s*$/.test(page)) throw new Error(`invalid literal for int() with base 10: '${page}'`);
    return Number(page);
  });
}

async function execute({ command, target, values }: Arguments, root: string): Promise<Result> {
  const manifest = values.manifest as string;
  switch (command) {
    case 'inspect':
      return inspectPdf(target, (values.cache as string | undefined) ?? defaultCache(), pageList((values['render-pages'] as string | undefined) ?? ''),
        values.dpi === undefined ? 144 : integer(values.dpi as string, 'dpi'));
    case 'status': return statusBoard(root, target);
    case 'stock': return stockBoard(root, target, values.candidate as string, integer(values.boards as string, 'boards'), values.receipts as string);
    case 'selection': return verifySelection(root, target, manifest);
    default: return verifyManifest(root, target, manifest);
  }
}

function compactReceipt(command: string, result: Result, output: string): Map<string, unknown> {
  const keys = command === 'inspect' ? [...SUMMARY, ...INSPECT_SUMMARY] : SUMMARY;
  const blockers = result.blockers;
  return new Map<string, unknown>([
    ...keys.map((key): [string, unknown] => [key, result[key] ?? null]),
    ['blockers', Array.isArray(blockers) ? blockers.length : 0],
    ['report', { path: resolvePath(output), sha256: sha(output) }],
  ]);
}

function report(args: Arguments, result: Result): number {
  const { output, json } = args.values as { output?: string; json?: boolean };
  if (output !== undefined) atomicJson(output, sortKeys(result));
  const compact = (args.command === 'selection' || args.command === 'inspect') && output !== undefined && json;
  if (json) console.log(jsonCanonical(compact ? compactReceipt(args.command, result, output) : result, { separators: [', ', ': '] }));
  else console.log(`${result.status.toUpperCase()} parts: ${pyStr(result.board ?? result.pdf)}`);
  return SUCCESS.has(result.status) ? 0 : 1;
}

async function main(argv: string[]): Promise<number> {
  const args = parseCommand(argv);
  let result: Result;
  try {
    result = await execute(args, (args.values.root as string | undefined) ?? projectRoot());
  } catch (error) {
    if (error instanceof UsageError) throw error;
    result = {
      schema: SCHEMA, status: 'blocked', scope: 'part_evidence', qualified: false, stock_current: false, release_approved: false,
      blockers: [{ code: 'runtime', detail: (error as Error).message }],
    };
  }
  try {
    return report(args, result);
  } catch (error) {
    if (!caught(error, ...OUTER_ERRORS)) throw error;
    console.log(jsonDumps({ schema: SCHEMA, status: 'blocked', scope: 'part_evidence', blockers: [{ code: 'runtime', detail: (error as Error).message }] }));
    return 1;
  }
}

runMain(import.meta.url, main);
