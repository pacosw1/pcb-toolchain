// The command line of tools/pcbtool.ts: argparse's reading of positionals and options, the exit of a command, and --budget.
import { UsageError } from './cli.ts';
import { splitlines } from './py-compat.mjs';
import { pyFloat } from './py-numbers.ts';

/** sys.exit(text): the text on stderr, exit 1, after what the command printed. */
export class CommandFailure extends Error {}

export type Value = string | number | boolean | null | string[] | number[];
export type Arguments = Record<string, Value>;
/** One line of a command's stdout. */
export type Print = (line: string) => void;

export interface Positional { name: string; type?: 'float'; many?: 'any' | 'some' }
export interface Option {
  /** The flag without dashes; the value is under the same name with - as _. */
  name: string;
  type?: 'float' | 'int' | 'string' | 'flag';
  fallback?: Value;
  /** A fixed count, or any number of values. */
  count?: number | 'any';
  /** nargs='?': this value when the flag stands alone. */
  whenAlone?: number;
}
export interface Command {
  positionals: Positional[];
  options?: Option[];
  /** Takes --budget: what a cut line is, and whether the last line stays. */
  budget?: BudgetRule;
  run: (args: Arguments, print: Print) => number | void | Promise<number | void>;
}

/** Without negative-number-like options, argparse reads -1.5 as a value. */
const isNumberText = (text: string): boolean => /^-\d+$|^-\d*\.\d+$/.test(text);
const isFlag = (text: string): boolean => text.startsWith('-') && text.length > 1 && !isNumberText(text);

function convert(text: string, type: Option['type'] | Positional['type'], usage: string): string | number {
  if (type === 'float') {
    try { return pyFloat(text); } catch { throw new UsageError(usage); }
  }
  if (type === 'int') {
    if (!/^\s*[+-]?\d+\s*$/.test(text)) throw new UsageError(usage);
    return Number(text);
  }
  return text;
}

const optionKey = (option: Option): string => option.name.replaceAll('-', '_');

/** The values of one option from the words after its flag; `used` is how many it took. */
function readOption(option: Option, inline: string | undefined, rest: string[], usage: string): { value: Value; used: number } {
  if (option.type === 'flag') {
    if (inline !== undefined) throw new UsageError(usage);
    return { value: true, used: 0 };
  }
  if (inline !== undefined) return { value: convert(inline, option.type, usage), used: 0 };
  if (option.whenAlone !== undefined) {
    if (rest[0] === undefined || isFlag(rest[0])) return { value: option.whenAlone, used: 0 };
    return { value: convert(rest[0], option.type, usage), used: 1 };
  }
  if (option.count === undefined) {
    if (rest[0] === undefined || isFlag(rest[0])) throw new UsageError(usage);
    return { value: convert(rest[0], option.type, usage), used: 1 };
  }
  const end = rest.findIndex(isFlag);
  const words = rest.slice(0, end < 0 ? rest.length : end);
  const taken = option.count === 'any' ? words : words.slice(0, option.count);
  if (option.count !== 'any' && taken.length < option.count) throw new UsageError(usage);
  return { value: taken.map(word => convert(word, option.type, usage)) as string[] | number[], used: taken.length };
}

/** A positional with `many` comes last in every command: it takes the words that are left. */
function bindPositionals(positionals: Positional[], words: string[], args: Arguments, usage: string): void {
  let next = 0;
  for (const positional of positionals) {
    if (positional.many) {
      if (positional.many === 'some' && next >= words.length) throw new UsageError(usage);
      args[positional.name] = words.slice(next);
      next = words.length;
    } else {
      if (words[next] === undefined) throw new UsageError(usage);
      args[positional.name] = convert(words[next]!, positional.type, usage);
      next += 1;
    }
  }
  if (next < words.length) throw new UsageError(usage);
}

const BUDGET: Option = { name: 'budget', type: 'int', whenAlone: 2000, fallback: null };

/** Positionals and options of one command. Abbreviated flags are not read: no caller uses them. */
export function parseCommand(command: Command, argv: string[], usage: string): Arguments {
  const options = [...(command.options ?? []), ...(command.budget ? [BUDGET] : [])];
  const args: Arguments = Object.fromEntries(options.map(o => [optionKey(o), o.fallback ?? (o.type === 'flag' ? false : null)]));
  const words: string[] = [];
  for (let i = 0; i < argv.length; i += 1) {
    const word = argv[i]!;
    if (word === '--') { words.push(...argv.slice(i + 1)); break; }
    if (!isFlag(word)) { words.push(word); continue; }
    const [flag, ...inline] = word.split('=');
    const option = options.find(o => `--${o.name}` === flag);
    if (!option) throw new UsageError(usage);
    const { value, used } = readOption(option, inline.length ? inline.join('=') : undefined, argv.slice(i + 1), usage);
    args[optionKey(option)] = value;
    i += used;
  }
  bindPositionals(command.positionals, words, args, usage);
  return args;
}

/** What a cut line is, for the note that names what was cut: a label and a net, or nothing. */
export type LineKind = (line: string) => [label: string | null, net: string | null];
export interface BudgetRule { kind: LineKind; keepLast: boolean }

const textSize = (lines: string[]): number => lines.reduce((sum, line) => sum + [...line].length + 1, 0);

function cutNote(cut: string[], kind: LineKind): string {
  const counts = new Map<string, number>();
  const nets = new Set<string>();
  for (const line of cut) {
    const [label, net] = kind(line);
    counts.set(label || 'lines', (counts.get(label || 'lines') ?? 0) + 1);
    if (net) nets.add(net);
  }
  const parts = [...counts].map(([label, count], i) => (i === 0 ? `${count} more ${label}` : `${count} ${label}`));
  return `... ${[...parts, ...(nets.size ? [`${nets.size} nets`] : []), 'not shown'].join(', ')}`;
}

/** The lines that fit in budget chars, newlines counted. One line names what was cut, so "not shown" never reads as "not present". */
export function budgetCut(lines: string[], budget: number, kind: LineKind, keepLast = false): string[] {
  if (textSize(lines) <= budget) return lines;
  const tail = keepLast ? lines.slice(-1) : [];
  const body = keepLast ? lines.slice(0, -1) : lines;
  for (let n = body.length; n > 0; n -= 1) {
    const kept = [...body.slice(0, n), cutNote(body.slice(n), kind), ...tail];
    if (textSize(kept) <= budget) return kept;
  }
  return [cutNote(body, kind), ...tail];
}

/** Runs a command; with --budget its output is held, cut and printed even when the command fails. */
export async function runCommand(command: Command, args: Arguments): Promise<number> {
  const budget = args.budget as number | null | undefined;
  if (!budget || !command.budget) return (await command.run(args, line => console.log(line))) ?? 0;
  const held: string[] = [];
  const flush = (): void => {
    const lines = held.flatMap(line => splitlines(line));
    if (lines.length) console.log(budgetCut(lines, budget, command.budget!.kind, command.budget!.keepLast).join('\n'));
  };
  try {
    return (await command.run(args, line => held.push(line))) ?? 0;
  } finally {
    flush();
  }
}
