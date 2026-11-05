// Command lines of the placer tools. A flag can take several words (`--param a=1 b=2`, `--size 100 60`) and a value can start
// with a dash (`--route-args "--layers F.Cu"`), which node:util parseArgs does not read.
import { UsageError } from '../lib/cli.ts';

export type Kind = 'text' | 'float' | 'int' | 'switch' | 'words';
export type Spec = Record<string, Kind>;

export interface Parsed {
  positionals: string[];
  text(name: string): string | undefined;
  float(name: string): number | undefined;
  int(name: string): number | undefined;
  has(name: string): boolean;
  words(name: string): string[];
}

const isNumber = (word: string): boolean => word !== '' && !Number.isNaN(Number(word));
const isFlag = (word: string): boolean => word.startsWith('-') && word !== '-' && !isNumber(word);

function number(name: string, kind: Kind, word: string): string {
  const bad = !isNumber(word) || (kind === 'int' && !Number.isInteger(Number(word)));
  if (bad) throw new UsageError(`${name}: bad value ${word}`);
  return word;
}

/** `usage` is the error text of an unknown flag or a missing value. Flags are given as `--name` or `-o`. */
export function parseOptions(argv: readonly string[], spec: Spec, usage: string): Parsed {
  const values = new Map<string, string[]>();
  const positionals: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const word = argv[i] as string;
    if (!isFlag(word)) {
      positionals.push(word);
      continue;
    }
    const split = word.indexOf('=');
    const name = split < 0 ? word : word.slice(0, split);
    const kind = spec[name];
    if (kind === undefined) throw new UsageError(`unknown option ${name}\n${usage}`);
    if (kind === 'switch') {
      values.set(name, []);
    } else if (split >= 0) {
      values.set(name, [...(kind === 'words' ? values.get(name) ?? [] : []), word.slice(split + 1)]);
    } else if (kind === 'words') {
      const rows = values.get(name) ?? [];
      while (i + 1 < argv.length && !isFlag(argv[i + 1] as string)) rows.push(argv[++i] as string);
      values.set(name, rows);
    } else {
      const next = argv[++i];
      if (next === undefined) throw new UsageError(`${name} needs a value\n${usage}`);
      values.set(name, [next]);
    }
  }
  const one = (name: string) => values.get(name)?.at(-1);
  const numeric = (name: string) => {
    const word = one(name);
    return word === undefined ? undefined : Number(number(name, spec[name] as Kind, word));
  };
  return { positionals, text: one, float: numeric, int: numeric, has: name => values.has(name), words: name => values.get(name) ?? [] };
}

/** A string of shell words, as a POSIX shell splits it: quotes group and a backslash escapes. */
export function shellWords(text: string): string[] {
  const words: string[] = [];
  let word: string | null = null;
  let quote: string | null = null;
  for (let i = 0; i < text.length; i++) {
    const c = text[i] as string;
    if (quote) {
      if (c === quote) quote = null;
      else if (c === '\\' && quote === '"' && '"\\'.includes(text[i + 1] ?? '')) word += text[++i] as string;
      else word += c;
    } else if (c === '"' || c === "'") {
      quote = c;
      word ??= '';
    } else if (c === '\\') {
      word = (word ?? '') + (text[++i] ?? '');
    } else if (/\s/.test(c)) {
      if (word !== null) words.push(word);
      word = null;
    } else {
      word = (word ?? '') + c;
    }
  }
  if (quote) throw new UsageError(`unbalanced quote in: ${text}`);
  if (word !== null) words.push(word);
  return words;
}

/** `k=v` words as a record: a number where it reads as one, else the word. */
export function parseParams(items: readonly string[]): Record<string, number | string> {
  const params: Record<string, number | string> = {};
  for (const item of items) {
    const split = item.indexOf('=');
    if (split < 0) throw new UsageError(`bad --param ${item}: use KEY=VALUE`);
    const value = item.slice(split + 1);
    params[item.slice(0, split)] = isNumber(value) ? Number(value) : value;
  }
  return params;
}
