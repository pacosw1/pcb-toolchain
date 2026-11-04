// argparse of Python 3.13 for the CLIs that came from it: subcommands, abbreviated options, exclusive groups, nargs + and
// REMAINDER, and the same usage, help and error text. Parsing follows _parse_known_args: each argument becomes A, O or -
// and the positionals match that pattern, so `parts --json status X --foo` gives --foo to the backend.
import { pyRepr } from './py-compat.mjs';
import { pyFloat } from './py-numbers.ts';

const NEGATIVE_NUMBER = /^-(?:\d+(?:_\d+)*(?:\.\d+(?:_\d+)*)?|\.\d+(?:_\d+)*)$/;
const INDENT = 2;
const MAX_HELP_POSITION = 24;
const NARROWEST_HELP = 11;
const PROG_SHARE = 0.75;

/** The parser ended the program: print `text` and exit with `code`. */
export class ParserExit extends Error {
  readonly code: number;
  readonly stream: 'stdout' | 'stderr';
  constructor(code: number, text: string, stream: 'stdout' | 'stderr') {
    super(text);
    this.code = code;
    this.stream = stream;
  }
}

/** A converter raises this to show its own message, as argparse.ArgumentTypeError does. */
export class ArgumentTypeError extends Error {}

export type Convert = (text: string) => unknown;
/** A converter and the name argparse prints for it: `invalid NAME value: 'x'`. */
export interface ValueType { name: string; convert: Convert }

export const floatType = (name: string, check: (value: number) => string | null): ValueType => ({
  name,
  convert: text => {
    const value = pyFloat(text);
    const problem = check(value);
    if (problem) throw new ArgumentTypeError(problem);
    return value;
  },
});

export const intType: ValueType = {
  name: 'int',
  convert: text => {
    const trimmed = text.trim();
    if (!/^[+-]?\d+(_\d+)*$/.test(trimmed)) throw new RangeError('not an int');
    return Number(trimmed.replaceAll('_', ''));
  },
};

export interface ArgumentOptions {
  type?: ValueType;
  choices?: readonly string[];
  default?: unknown;
  required?: boolean;
  help?: string;
  nargs?: '+' | '...';
  action?: 'store' | 'store_true' | 'append';
}

interface Action extends ArgumentOptions {
  flags: string[];
  dest: string;
  kind: 'store' | 'store_true' | 'append' | 'help' | 'parsers';
  group?: ExclusiveGroup;
}

type Tuple = { action: Action | null; flag: string; separator: string | null; value: string | null };
type Namespace = Record<string, unknown>;

const destOf = (flag: string): string => flag.replace(/^-+/, '').replaceAll('-', '_');
const takesValue = (action: Action): boolean => action.kind === 'store' || action.kind === 'append';
const nameOf = (action: Action): string => action.flags.length ? action.flags.join('/') : action.dest;

function nargsPattern(action: Action): string {
  if (action.kind === 'parsers') return '(-*A[-AO]*)';
  if (action.nargs === '...') return '([-AO]*)';
  if (action.nargs === '+') return action.flags.length ? '(A[A]*)' : '(-*A[A-]*)';
  if (!takesValue(action)) return '()';
  return action.flags.length ? '(A)' : '(-*A-*)';
}

const terminalColumns = (): number => {
  const given = Number(process.env.COLUMNS);
  if (Number.isInteger(given) && given > 0) return given;
  return process.stdout.columns || 80;
};

// textwrap.TextWrapper.wordsep_re: words, runs of space, hyphenated parts and em-dashes.
const WORD_PARTS = /(\s+|(?<=[\w!"'&.,?])-{2,}(?=\w)|\S+?(?:-(?:(?<=[^\d\W]{2}-)|(?<=[^\d\W]-[\w!"'&.,?]-))(?=[^\d\W]-?[^\d\W])|(?=\s|$)|(?<=[\w!"'&.,?])(?=-{2,}\w)))/;

function wrap(text: string, width: number): string[] {
  const chunks = text.replace(/\s+/g, ' ').trim().split(WORD_PARTS).filter(Boolean);
  const lines: string[] = [];
  let line = '';
  for (const chunk of chunks) {
    if (line.length + chunk.length <= width) {
      if (line || chunk !== ' ') line += chunk;
    } else {
      if (line) lines.push(line.trimEnd());
      line = chunk === ' ' ? '' : chunk;
    }
  }
  if (line.trim()) lines.push(line.trimEnd());
  return lines;
}

function wrappedLines(parts: string[], indent: string, width: number, prefix?: string): string[] {
  const lines: string[] = [];
  let line: string[] = [];
  let length = (prefix === undefined ? indent.length : prefix.length) - 1;
  for (const part of parts) {
    if (length + 1 + part.length > width && line.length) {
      lines.push(indent + line.join(' '));
      line = [];
      length = indent.length - 1;
    }
    line.push(part);
    length += part.length + 1;
  }
  if (line.length) lines.push(indent + line.join(' '));
  if (prefix !== undefined) lines[0] = lines[0]!.slice(indent.length);
  return lines;
}

class ExclusiveGroup {
  readonly members: Action[] = [];
  readonly #parser: ArgumentParser;
  constructor(parser: ArgumentParser) { this.#parser = parser; }
  add(flag: string, options: ArgumentOptions = {}): void {
    const action = this.#parser.add(flag, options);
    action.group = this;
    this.members.push(action);
  }
}

export class Subparsers {
  readonly action: Action;
  readonly parsers = new Map<string, ArgumentParser>();
  readonly #prog: string;
  constructor(action: Action, prog: string) {
    this.action = action;
    this.#prog = prog;
  }
  addParser(name: string): ArgumentParser {
    const parser = new ArgumentParser(`${this.#prog} ${name}`);
    this.parsers.set(name, parser);
    this.action.choices = [...this.parsers.keys()];
    return parser;
  }
}

export class ArgumentParser {
  readonly prog: string;
  readonly description: string;
  readonly #actions: Action[] = [];
  #subparsers: Subparsers | null = null;

  constructor(prog: string, description = '') {
    this.prog = prog;
    this.description = description;
    this.#actions.push({ flags: ['-h', '--help'], dest: 'help', kind: 'help', help: 'show this help message and exit' });
  }

  /** `name` is a positional; `--name` an option. A required option or positional is listed when it is missing. */
  add(name: string, options: ArgumentOptions = {}): Action {
    const positional = !name.startsWith('-');
    const action: Action = {
      ...options, flags: positional ? [] : [name], dest: positional ? name : destOf(name), kind: options.action ?? 'store',
      required: positional ? options.nargs !== '...' : options.required ?? false,
    };
    this.#actions.push(action);
    return action;
  }

  exclusive(): ExclusiveGroup { return new ExclusiveGroup(this); }

  addSubparsers(dest: string): Subparsers {
    const action: Action = { flags: [], dest, kind: 'parsers', required: true, choices: [] };
    this.#actions.push(action);
    this.#subparsers = new Subparsers(action, this.prog);
    return this.#subparsers;
  }

  #options(): Action[] { return this.#actions.filter(action => action.flags.length); }
  #positionals(): Action[] { return this.#actions.filter(action => !action.flags.length); }

  #metavar(action: Action): string {
    if (action.choices) return `{${action.choices.join(',')}}`;
    return action.flags.length ? action.dest.toUpperCase() : action.dest;
  }

  #argsUsage(action: Action): string {
    const metavar = this.#metavar(action);
    if (action.kind === 'parsers') return `${metavar} ...`;
    if (action.nargs === '...') return '...';
    return action.nargs === '+' ? `${metavar} [${metavar} ...]` : metavar;
  }

  #usageParts(actions: Action[]): string[] {
    const parts: string[] = [];
    for (const action of actions) {
      const text = action.flags.length ? [action.flags[0], ...(takesValue(action) ? [this.#argsUsage(action)] : [])].join(' ') : this.#argsUsage(action);
      const group = action.group;
      if (group) {
        const first = group.members[0] === action;
        const last = group.members.at(-1) === action;
        parts.push(`${first ? '[' : ''}${text}${last ? ']' : ' |'}`);
      } else {
        parts.push(action.flags.length && !action.required ? `[${text}]` : text);
      }
    }
    return parts;
  }

  formatUsage(): string {
    const prefix = 'usage: ';
    const width = terminalColumns() - 2;
    const optionals = this.#usageParts(this.#options());
    const positionals = this.#usageParts(this.#positionals());
    const whole = [this.prog, ...optionals, ...positionals].join(' ');
    if (prefix.length + whole.length <= width) return `${prefix}${whole}\n`;
    let lines: string[];
    if (prefix.length + this.prog.length <= PROG_SHARE * width) {
      const indent = ' '.repeat(prefix.length + this.prog.length + 1);
      lines = [...wrappedLines([this.prog, ...optionals], indent, width, prefix), ...wrappedLines(positionals, indent, width)];
    } else {
      const indent = ' '.repeat(prefix.length);
      lines = wrappedLines([...optionals, ...positionals], indent, width);
      if (lines.length > 1) lines = [...wrappedLines(optionals, indent, width), ...wrappedLines(positionals, indent, width)];
      lines = [this.prog, ...lines];
    }
    return `${prefix}${lines.join('\n')}\n`;
  }

  #invocation(action: Action): string {
    if (!action.flags.length) return this.#metavar(action);
    return takesValue(action) ? `${action.flags.join(', ')} ${this.#metavar(action)}` : action.flags.join(', ');
  }

  #actionHelp(action: Action, position: number, helpWidth: number): string {
    const header = this.#invocation(action);
    const room = position - INDENT - 2;
    const pad = ' '.repeat(INDENT);
    if (!action.help) return `${pad}${header}\n`;
    const lines = wrap(action.help, helpWidth);
    const first = header.length <= room ? `${pad}${header.padEnd(room)}  ${lines[0]}\n` : `${pad}${header}\n${' '.repeat(position)}${lines[0]}\n`;
    return first + lines.slice(1).map(line => `${' '.repeat(position)}${line}\n`).join('');
  }

  formatHelp(): string {
    const width = terminalColumns() - 2;
    const widest = Math.max(...this.#actions.map(action => this.#invocation(action).length + INDENT));
    const position = Math.min(widest + 2, Math.min(MAX_HELP_POSITION, Math.max(width - 20, INDENT * 2)));
    const helpWidth = Math.max(width - position, NARROWEST_HELP);
    const section = (title: string, actions: Action[]): string[] =>
      actions.length ? [`${title}:\n${actions.map(action => this.#actionHelp(action, position, helpWidth)).join('')}`] : [];
    const description = this.description ? [`${wrap(this.description, Math.max(width, NARROWEST_HELP)).join('\n')}\n`] : [];
    return [this.formatUsage(), ...description, ...section('positional arguments', this.#positionals()), ...section('options', this.#options())].join('\n');
  }

  error(message: string): never {
    throw new ParserExit(2, `${this.formatUsage()}${this.prog}: error: ${message}\n`, 'stderr');
  }

  #optionFlags(): Map<string, Action> {
    return new Map(this.#options().flatMap(action => action.flags.map(flag => [flag, action] as const)));
  }

  #abbreviations(argument: string, flags: Map<string, Action>): Tuple[] {
    const equal = argument.indexOf('=');
    const prefix = equal < 0 ? argument : argument.slice(0, equal);
    const separator = equal < 0 ? null : '=';
    const value = equal < 0 ? null : argument.slice(equal + 1);
    const found: Tuple[] = [];
    const short = !argument.startsWith('--');
    for (const [flag, action] of flags) {
      if (short && flag === argument.slice(0, 2)) found.push({ action, flag, separator: '', value: argument.slice(2) });
      else if (flag.startsWith(prefix)) found.push({ action, flag, separator, value });
    }
    return found;
  }

  #parseOptional(argument: string, flags: Map<string, Action>): Tuple[] | null {
    if (!argument || argument[0] !== '-') return null;
    const exact = flags.get(argument);
    if (exact) return [{ action: exact, flag: argument, separator: null, value: null }];
    if (argument.length === 1) return null;
    const equal = argument.indexOf('=');
    if (equal >= 0) {
      const action = flags.get(argument.slice(0, equal));
      if (action) return [{ action, flag: argument.slice(0, equal), separator: '=', value: argument.slice(equal + 1) }];
    }
    const found = this.#abbreviations(argument, flags);
    if (found.length) return found;
    if (NEGATIVE_NUMBER.test(argument) || argument.includes(' ')) return null;
    return [{ action: null, flag: argument, separator: null, value: null }];
  }

  #convert(action: Action, text: string): unknown {
    if (action.type) {
      try {
        const value = action.type.convert(text);
        this.#checkChoice(action, text);
        return value;
      } catch (error) {
        if (error instanceof ArgumentTypeError) this.error(`argument ${nameOf(action)}: ${error.message}`);
        if (error instanceof ParserExit) throw error;
        this.error(`argument ${nameOf(action)}: invalid ${action.type.name} value: ${pyRepr(text)}`);
      }
    }
    this.#checkChoice(action, text);
    return text;
  }

  #checkChoice(action: Action, text: string): void {
    if (action.choices && !action.choices.includes(text)) {
      this.error(`argument ${nameOf(action)}: invalid choice: ${pyRepr(text)} (choose from ${action.choices.join(', ')})`);
    }
  }

  #store(action: Action, values: string[], namespace: Namespace, extras: string[]): void {
    if (action.kind === 'parsers') {
      const [name, ...rest] = values as [string, ...string[]];
      this.#checkChoice(action, name);
      namespace[action.dest] = name;
      extras.push(...this.#subparsers!.parsers.get(name)!.#parseKnown(rest, namespace));
      return;
    }
    if (action.kind === 'help') throw new ParserExit(0, this.formatHelp(), 'stdout');
    if (action.kind === 'store_true') namespace[action.dest] = true;
    else if (action.kind === 'append') ((namespace[action.dest] ??= []) as unknown[]).push(this.#convert(action, values[0]!));
    else if (action.nargs) namespace[action.dest] = values.map(value => this.#convert(action, value));
    else namespace[action.dest] = this.#convert(action, values[0]!);
  }

  #parseKnown(argv: string[], namespace: Namespace): string[] {
    const flags = this.#optionFlags();
    const tuples = new Map<number, Tuple[]>();
    let pattern = '';
    let afterMarker = false;
    argv.forEach((argument, index) => {
      if (afterMarker) { pattern += 'A'; return; }
      if (argument === '--') { pattern += '-'; afterMarker = true; return; }
      const parsed = this.#parseOptional(argument, flags);
      if (parsed) tuples.set(index, parsed);
      pattern += parsed ? 'O' : 'A';
    });
    for (const action of this.#actions) {
      if (action.kind === 'store_true') namespace[action.dest] ??= action.default ?? false;
      else if (action.kind !== 'help' && action.kind !== 'parsers') namespace[action.dest] ??= action.default ?? (action.nargs === '...' ? [] : null);
    }
    const positionals = this.#positionals();
    const seen = new Set<Action>();
    const conflicts = new Map<ExclusiveGroup, Action>();
    const extras: string[] = [];
    const take = (action: Action, values: string[]): void => {
      seen.add(action);
      if (action.group) {
        const other = conflicts.get(action.group);
        if (other && other !== action) this.error(`argument ${nameOf(action)}: not allowed with argument ${nameOf(other)}`);
        conflicts.set(action.group, action);
      }
      this.#store(action, values, namespace, extras);
    };
    const consumePositionals = (start: number): number => {
      const counts = matchPartial(positionals, pattern.slice(start));
      for (const [index, action] of positionals.slice(0, counts.length).entries()) {
        const count = counts[index]!;
        const values = argv.slice(start, start + count);
        if (action.nargs !== '...') {
          const marker = values.indexOf('--');
          if (marker >= 0 && pattern.slice(start, start + count).includes('-')) values.splice(marker, 1);
        }
        start += count;
        take(action, values);
      }
      positionals.splice(0, counts.length);
      return start;
    };
    const consumeOptional = (start: number): number => {
      const found = tuples.get(start)!;
      if (found.length > 1) this.error(`ambiguous option: ${argv[start]} could match ${found.map(tuple => tuple.flag).join(', ')}`);
      const { action, value } = found[0]!;
      if (!action) { extras.push(argv[start]!); return start + 1; }
      if (value !== null) return this.#explicit({ ...found[0]!, action, value }, start, take);
      if (!takesValue(action)) { take(action, []); return start + 1; }
      if (pattern[start + 1] !== 'A') this.error(`argument ${nameOf(action)}: expected one argument`);
      take(action, [argv[start + 1]!]);
      return start + 2;
    };
    const lastOption = Math.max(-1, ...tuples.keys());
    let start = 0;
    while (start <= lastOption) {
      let next = start;
      while (next <= lastOption && !tuples.has(next)) next += 1;
      if (start !== next) {
        const stopped = consumePositionals(start);
        const moved = stopped > start;
        start = stopped;
        if (moved) continue;
      }
      if (!tuples.has(start)) {
        extras.push(...argv.slice(start, next));
        start = next;
      }
      start = consumeOptional(start);
    }
    const stop = consumePositionals(start);
    extras.push(...argv.slice(stop));
    const missing = this.#actions.filter(action => action.required && !seen.has(action)).map(nameOf);
    if (missing.length) this.error(`the following arguments are required: ${missing.join(', ')}`);
    return extras;
  }

  /** `--flag=value`, or `-abc` as a run of single-letter flags. Nothing runs until the whole run is known to be valid. */
  #explicit(tuple: Tuple & { action: Action; value: string }, start: number, take: (action: Action, values: string[]) => void): number {
    let { action, flag, value } = tuple;
    let glued = tuple.separator === '=';
    const flags = this.#optionFlags();
    const pending: Action[] = [];
    const ignored = (): never => this.error(`argument ${nameOf(action)}: ignored explicit argument ${pyRepr(value)}`);
    for (;;) {
      if (takesValue(action)) break;
      if (flag[1] === '-' || value === '' || glued || value[0] === '-') ignored();
      pending.push(action);
      flag = `-${value[0]}`;
      const next = flags.get(flag);
      if (!next) ignored();
      action = next!;
      value = value.slice(1);
      glued = false;
      if (!value) { pending.push(action); value = ''; break; }
    }
    pending.forEach(item => take(item, []));
    if (takesValue(action) && pending.at(-1) !== action) take(action, [value]);
    return start + 1;
  }

  parseArgs(argv: string[]): Namespace {
    const namespace: Namespace = {};
    const extras = this.#parseKnown(argv, namespace);
    if (extras.length) this.error(`unrecognized arguments: ${extras.join(' ')}`);
    return namespace;
  }
}

/** The arguments each leading positional takes, for as many positionals as the pattern can feed. */
function matchPartial(actions: Action[], pattern: string): number[] {
  for (let count = actions.length; count > 0; count -= 1) {
    const match = new RegExp(`^${actions.slice(0, count).map(nargsPattern).join('')}`).exec(pattern);
    if (match) return match.slice(1).map(group => group.length);
  }
  return [];
}
