// The Python behaviour that tools ported off Python must keep byte for byte: their output files and messages are
// read by people, by other tools and by evidence hashes. Only what a ported tool needs; plain Node, no packages.
// Data from json loads as: dict = Map (insertion order, also for keys like "123"), list = Array, int = BigInt,
// float = Float (so 1.0 stays 1.0 and 12345678901234567890 stays exact), None = null.
import {spawnSync} from 'node:child_process';
import {lstatSync, readFileSync, readdirSync, writeSync} from 'node:fs';

export class PyError extends Error { constructor(type, message) { super(message); this.type = type; } }
export class SystemExit extends Error { constructor(code, message = '') { super(message); this.code = code; } }
export class Float { constructor(value) { this.value = value; } }

const write = (fd, text) => {
  const data = Buffer.from(text);
  for (let at = 0; at < data.length;) {
    try { at += writeSync(fd, data, at); } catch (e) { if (e.code !== 'EAGAIN') throw e; }
  }
};
export const print = (text = '') => write(1, text + '\n');
export const eprint = (text = '') => write(2, text + '\n');
export const sleep = seconds => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, seconds * 1000);

// Runs main. An uncaught Python exception ended in a traceback whose last line is "Type: message", with exit 1.
// That last line and the exit code are the contract; the frames named Python files and cannot be kept.
export function cli(main) {
  let code = 0;
  try { main(); } catch (e) {
    if (e instanceof SystemExit) { if (e.message) eprint(e.message); code = e.code; } else {
      const error = e.code && !(e instanceof PyError) && ERRNO[e.code] ? osError(e) : e;
      if (!(error instanceof PyError)) throw e;
      eprint(error.message ? `${error.type}: ${error.message}` : error.type);
      code = 1;
    }
  }
  process.exitCode = code;
}

export function pyRepr(value) {
  if (typeof value !== 'string') {
    if (value instanceof Map) return `{${[...value].map(([k, v]) => `${pyRepr(k)}: ${pyRepr(v)}`).join(', ')}}`;
    if (Array.isArray(value)) return `[${value.map(pyRepr).join(', ')}]`;
    return pyStr(value);
  }
  const quote = value.includes("'") && !value.includes('"') ? '"' : "'";
  let text = '';
  for (const c of value) {
    const n = c.codePointAt(0);
    if (c === '\\' || c === quote) text += '\\' + c;
    else if (c === '\n') text += '\\n'; else if (c === '\r') text += '\\r'; else if (c === '\t') text += '\\t';
    else if (c === ' ' || !/[\p{C}\p{Z}]/u.test(c)) text += c;   // str.isprintable
    else if (n < 0x100) text += '\\x' + n.toString(16).padStart(2, '0');
    else if (n < 0x10000) text += '\\u' + n.toString(16).padStart(4, '0');
    else text += '\\U' + n.toString(16).padStart(8, '0');
  }
  return quote + text + quote;
}

export function floatRepr(x) {
  if (Number.isNaN(x)) return 'nan';
  if (!Number.isFinite(x)) return x > 0 ? 'inf' : '-inf';
  if (x === 0) return Object.is(x, -0) ? '-0.0' : '0.0';
  const [mantissa, exponent] = Math.abs(x).toExponential().split('e');
  const digits = mantissa.replace('.', ''), e = Number(exponent), sign = x < 0 ? '-' : '';
  if (e < -4 || e >= 16) return `${sign}${digits[0]}${digits.length > 1 ? '.' + digits.slice(1) : ''}e${e < 0 ? '-' : '+'}${String(Math.abs(e)).padStart(2, '0')}`;
  if (e < 0) return `${sign}0.${'0'.repeat(-e - 1)}${digits}`;
  const whole = digits.padEnd(e + 1, '0');
  return `${sign}${whole.slice(0, e + 1)}.${whole.slice(e + 1) || '0'}`;
}

// str(value), for f-strings.
export function pyStr(value) {
  if (value === null || value === undefined) return 'None';
  if (value === true) return 'True';
  if (value === false) return 'False';
  if (value instanceof Float) return floatRepr(value.value);
  if (typeof value === 'number') return Number.isInteger(value) ? String(value) : floatRepr(value);
  if (typeof value === 'string' || typeof value === 'bigint') return String(value);
  return pyRepr(value);
}

export function truthy(value) {
  if (value instanceof Map) return value.size > 0;
  if (Array.isArray(value)) return value.length > 0;
  if (value instanceof Float) return value.value !== 0;
  return Boolean(value);
}

export const typeName = v => v === null || v === undefined ? 'NoneType' : Array.isArray(v) ? 'list' : v instanceof Map ? 'dict' : v instanceof Float ? 'float'
  : typeof v === 'string' ? 'str' : typeof v === 'boolean' ? 'bool' : 'int';
// d.get(key, default)
export function get(dict, key, otherwise = null) {
  if (!(dict instanceof Map)) throw new PyError('AttributeError', `'${typeName(dict)}' object has no attribute 'get'`);
  return dict.has(key) ? dict.get(key) : otherwise;
}
// d[key]
export function item(dict, key) {
  if (Array.isArray(dict) && typeof key === 'number') { if (key < dict.length) return dict[key]; throw new PyError('IndexError', 'list index out of range'); }
  if (dict instanceof Map) { if (dict.has(key)) return dict.get(key); throw new PyError('KeyError', pyRepr(key)); }
  if (Array.isArray(dict)) throw new PyError('TypeError', 'list indices must be integers or slices, not str');
  if (typeof dict === 'string') throw new PyError('TypeError', "string indices must be integers, not 'str'");
  throw new PyError('TypeError', `'${typeName(dict)}' object is not subscriptable`);
}
export function number(value) {
  if (value instanceof Float) return value.value;
  if (typeof value === 'bigint' || typeof value === 'number') return Number(value);
  if (value === true || value === false) return Number(value);
  throw new PyError('TypeError', `unsupported operand type(s): '${typeName(value)}'`);
}

// Strings by code point: Python indexes, slices, pads and sorts by code point; JS by UTF-16 unit.
const WHITESPACE = '\\t\\n\\v\\f\\r\\x1c-\\x1f \\x85\\xa0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000';
const EDGES = new RegExp(`^[${WHITESPACE}]+|[${WHITESPACE}]+$`, 'g');
export function strip(text) {
  if (typeof text !== 'string') throw new PyError('AttributeError', `'${typeName(text)}' object has no attribute 'strip'`);
  return text.replace(EDGES, '');
}
export function split(text, separator) {
  if (typeof text !== 'string') throw new PyError('AttributeError', `'${typeName(text)}' object has no attribute 'split'`);
  return text.split(separator);
}
export const head = (text, n) => [...text].slice(0, n).join('');
export const tail = (text, n) => [...text].slice(-n).join('');
export const ljust = (text, n) => text + ' '.repeat(Math.max(0, n - [...text].length));
export function compare(a, b) {
  const x = [...a], y = [...b];
  for (let i = 0; i < x.length && i < y.length; i++) {
    const d = x[i].codePointAt(0) - y[i].codePointAt(0);
    if (d) return d;
  }
  return x.length - y.length;
}
export const sorted = list => [...list].sort(compare);

// f'{x:.2f}': round half even on the exact binary value; toFixed rounds an exact tie up (0.125 -> 0.13, Python 0.12).
export function fixed(x, places) {
  const [whole, fraction] = Math.abs(x).toFixed(100).split('.');
  if (/^50*$/.test(fraction.slice(places))) {
    const kept = fraction.slice(0, places), last = Number((whole + kept).at(-1));
    if (last % 2 === 0) return (x < 0 ? '-' : '') + whole + (places ? '.' + kept : '');
  }
  return x.toFixed(places);
}

// Local date and UTC time as date.today() and datetime.now(timezone.utc).isoformat() write them.
export function today(now = new Date()) {
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
}
export const utcNow = (now = new Date()) => now.toISOString().replace(/(\.\d{3})Z$/, '$1000+00:00');

// OSError text for a failed fs call or spawn.
const ERRNO = {
  ENOENT: [2, 'No such file or directory', 'FileNotFoundError'], EACCES: [13, 'Permission denied', 'PermissionError'],
  EEXIST: [17, 'File exists', 'FileExistsError'], ENOTDIR: [20, 'Not a directory', 'NotADirectoryError'],
  EISDIR: [21, 'Is a directory', 'IsADirectoryError'],
};
export function osError(e, name) {
  const known = ERRNO[e.code];
  if (!known) return e;
  const path = e.path ?? name ?? e.spawnargs?.[0] ?? '';   // reading a folder: Node's EISDIR names no path
  return new PyError(known[2], `[Errno ${known[0]}] ${known[1]}: ${pyRepr(path)}${e.dest ? ` -> ${pyRepr(e.dest)}` : ''}`);
}

// open(path).read(): UTF-8, strict, the BOM stays in the text.
export function readText(path) {
  let data;
  try { data = readFileSync(path); } catch (e) { throw osError(e, path); }
  return decode(data);
}
export function decode(data) {
  try { return new TextDecoder('utf-8', {fatal: true, ignoreBOM: true}).decode(data); } catch {
    throw new PyError('UnicodeDecodeError', utf8Failure(data));
  }
}
// The message of the first bad sequence, as CPython's decoder words it.
function utf8Failure(data) {
  const message = (start, end, reason) => end - start === 1
    ? `'utf-8' codec can't decode byte 0x${data[start].toString(16).padStart(2, '0')} in position ${start}: ${reason}`
    : `'utf-8' codec can't decode bytes in position ${start}-${end - 1}: ${reason}`;
  for (let i = 0; i < data.length; i++) {
    const b = data[i];
    if (b < 0x80) continue;
    if (b < 0xc2 || b > 0xf4) return message(i, i + 1, 'invalid start byte');
    const length = b < 0xe0 ? 2 : b < 0xf0 ? 3 : 4;
    const low = b === 0xe0 ? 0xa0 : b === 0xf0 ? 0x90 : 0x80, high = b === 0xed ? 0x9f : b === 0xf4 ? 0x8f : 0xbf;
    for (let j = 1; j < length; j++) {
      if (i + j >= data.length) return message(i, data.length, 'unexpected end of data');
      const c = data[i + j];
      if (c < (j === 1 ? low : 0x80) || c > (j === 1 ? high : 0xbf)) return message(i, i + j, 'invalid continuation byte');
    }
    i += length - 1;
  }
  return "'utf-8' codec can't decode the input";
}

// str.splitlines: more line ends than \n.
export const splitlines = text => { const lines = text.split(/\r\n|[\n\r\v\f\x1c-\x1e\x85\u2028\u2029]/); if (lines.at(-1) === '') lines.pop(); return lines; };
// Text of a subprocess run with text=True: strict UTF-8, universal newlines.
export const processText = data => decode(data).replace(/\r\n?/g, '\n');

// What the * of glob.glob sees in a folder: no hidden names, a missing folder is empty.
export function globNames(folder) {
  try { return readdirSync(folder).filter(name => !name.startsWith('.')); } catch { return []; }
}
export function lexists(path) { try { lstatSync(path); return true; } catch { return false; } }

// subprocess.run with captured output. check=True raises what CalledProcessError raised.
export function run(command, args, {check = false, stdio = 'pipe', timeout} = {}) {
  if (command === '') throw new PyError('PermissionError', "[Errno 13] Permission denied: ''");
  const result = spawnSync(command, args, {maxBuffer: Infinity, stdio, timeout: timeout && timeout * 1000, killSignal: 'SIGKILL'});
  if (result.error?.code === 'ETIMEDOUT') throw new PyError('subprocess.TimeoutExpired', `Command '${pyRepr([command, ...args])}' timed out after ${timeout} seconds`);
  if (result.error) throw osError(result.error, command);
  if (check && result.status !== 0) {
    throw new PyError('subprocess.CalledProcessError', `Command '${pyRepr([command, ...args])}' returned non-zero exit status ${result.status}.`);
  }
  return result;
}

// csv.DictReader over text from open(path): universal newlines, then the csv module's state machine.
export function csvRows(text) {
  const source = text.replace(/\r\n?/g, '\n'), rows = [];
  let row = [], field = '', state = 'start', started = false;
  const save = () => { row.push(field); field = ''; };
  const end = () => { rows.push(row); row = []; state = 'start'; started = false; };
  for (const c of source) {
    started = true;
    if (state === 'quoted') { if (c === '"') state = 'quote'; else field += c; continue; }
    if (state === 'quote' && c === '"') { field += c; state = 'quoted'; continue; }
    if (c === ',') { save(); state = 'field-start'; continue; }
    if (c === '\n') {
      if (state === 'start') { end(); continue; }
      save(); end(); continue;
    }
    if ((state === 'start' || state === 'field-start') && c === '"') { state = 'quoted'; continue; }
    field += c; state = 'field';
  }
  if (started) { save(); rows.push(row); }
  return rows;
}
export function dictRows(text) {
  const rows = csvRows(text);
  const names = rows.shift() ?? [];
  return rows.filter(row => row.length).map(row => {
    const record = new Map(names.map((name, i) => [name, i < row.length ? row[i] : null]));
    return record;
  });
}
const csvField = value => {
  const field = value === null || value === undefined ? '' : pyStr(value);
  return /[",\r\n]/.test(field) ? `"${field.replaceAll('"', '""')}"` : field;
};
// csv.writer(f) with newline='': minimal quoting, CRLF.
export const csvLine = fields => (fields.length === 1 && fields[0] === '' ? '""' : fields.map(csvField).join(',')) + '\r\n';

// json.loads / json.load. For bytes json.loads skips a UTF-8 BOM; for text it refuses one.
class Scanner {
  constructor(text) { this.s = text; }
  fail(message, at) {
    const before = [...this.s.slice(0, at)], last = before.lastIndexOf('\n');
    const line = before.filter(c => c === '\n').length + 1, column = before.length - last;
    return new PyError('json.decoder.JSONDecodeError', `${message}: line ${line} column ${column} (char ${before.length})`);
  }
  space(at) { while (' \t\n\r'.includes(this.s[at] ?? '#')) at++; return at; }
  value(at) {
    const c = this.s[at];
    if (c === '"') return this.string(at + 1);
    if (c === '{') return this.object(at + 1);
    if (c === '[') return this.array(at + 1);
    for (const [word, value] of [['null', null], ['true', true], ['false', false], ['NaN', new Float(NaN)],
      ['Infinity', new Float(Infinity)], ['-Infinity', new Float(-Infinity)]]) {
      if (this.s.startsWith(word, at)) return [value, at + word.length];
    }
    const m = /^(-?(?:0|[1-9][0-9]*))(\.[0-9]+)?([eE][-+]?[0-9]+)?/.exec(this.s.slice(at, at + 400));
    if (!m) throw this.fail('Expecting value', at);
    return [m[2] || m[3] ? new Float(Number(m[0])) : BigInt(m[1]), at + m[0].length];
  }
  string(at) {
    const begin = at - 1;
    let text = '';
    for (;;) {
      const c = this.s[at];
      if (c === undefined) throw this.fail('Unterminated string starting at', begin);
      if (c === '"') return [text, at + 1];
      if (c < ' ') throw this.fail('Invalid control character at', at);
      if (c !== '\\') { text += c; at++; continue; }
      const e = this.s[at + 1];
      if (e === undefined) throw this.fail('Unterminated string starting at', begin);
      if (e === 'u') {
        const hex = this.s.slice(at + 2, at + 6);
        // The C scanner wants one more character after the four digits, so this also covers an escape that ends the text.
        if (at + 6 >= this.s.length || !/^[0-9a-fA-F]{4}$/.test(hex)) throw this.fail('Invalid \\uXXXX escape', at + 1);
        text += String.fromCharCode(parseInt(hex, 16)); at += 6; continue;
      }
      const plain = {'"': '"', '\\': '\\', '/': '/', b: '\b', f: '\f', n: '\n', r: '\r', t: '\t'}[e];
      if (plain === undefined) throw this.fail('Invalid \\escape', at);
      text += plain; at += 2;
    }
  }
  object(at) {
    const result = new Map();
    at = this.space(at);
    if (this.s[at] === '}') return [result, at + 1];
    if (this.s[at] !== '"') throw this.fail('Expecting property name enclosed in double quotes', at);
    for (;;) {
      const [key, afterKey] = this.string(at + 1);
      at = this.space(afterKey);
      if (this.s[at] !== ':') throw this.fail("Expecting ':' delimiter", at);
      const [value, afterValue] = this.value(this.space(at + 1));
      result.set(key, value);
      at = this.space(afterValue);
      if (this.s[at] === '}') return [result, at + 1];
      if (this.s[at] !== ',') throw this.fail("Expecting ',' delimiter", at);
      at = this.space(at + 1);
      if (this.s[at] !== '"') throw this.fail('Expecting property name enclosed in double quotes', at);
    }
  }
  array(at) {
    const result = [];
    at = this.space(at);
    if (this.s[at] === ']') return [result, at + 1];
    for (;;) {
      const [value, after] = this.value(at);
      result.push(value);
      at = this.space(after);
      if (this.s[at] === ']') return [result, at + 1];
      if (this.s[at] !== ',') throw this.fail("Expecting ',' delimiter", at);
      at = this.space(at + 1);
    }
  }
}
export function jsonLoads(input) {
  const bytes = typeof input !== 'string';
  let text = bytes ? decode(input) : input;
  if (text.startsWith('﻿')) {
    if (!bytes) throw new PyError('json.decoder.JSONDecodeError', 'Unexpected UTF-8 BOM (decode using utf-8-sig): line 1 column 1 (char 0)');
    text = text.slice(1);
  }
  const scanner = new Scanner(text);
  const [value, after] = scanner.value(scanner.space(0));
  const end = scanner.space(after);
  if (end !== text.length) throw scanner.fail('Extra data', end);
  return value;
}
export const jsonLoad = path => jsonLoads(readText(path));

// json.dumps: ensure_ascii, ", " and ": " separators, or indent.
const SHORT = {'"': '\\"', '\\': '\\\\', '\n': '\\n', '\r': '\\r', '\t': '\\t', '\f': '\\f', '\b': '\\b'};
const jsonString = text => `"${text.replace(/["\\]|[^ -~]/g, c => SHORT[c] ?? '\\u' + c.charCodeAt(0).toString(16).padStart(4, '0'))}"`;
export function jsonDumps(value, indent = null, depth = 0) {
  const inner = indent === null ? '' : '\n' + ' '.repeat(indent * (depth + 1));
  const outer = indent === null ? '' : '\n' + ' '.repeat(indent * depth);
  const separator = indent === null ? ', ' : ',' + inner;
  if (value === null || value === undefined) return 'null';
  if (value === true || value === false) return String(value);
  if (typeof value === 'string') return jsonString(value);
  if (typeof value === 'bigint') return String(value);
  if (typeof value === 'number') return pyStr(value);
  if (value instanceof Float) {
    if (Number.isNaN(value.value)) return 'NaN';
    if (!Number.isFinite(value.value)) return value.value > 0 ? 'Infinity' : '-Infinity';
    return floatRepr(value.value);
  }
  if (Array.isArray(value)) {
    if (!value.length) return '[]';
    return `[${inner}${value.map(v => jsonDumps(v, indent, depth + 1)).join(separator)}${outer}]`;
  }
  const entries = value instanceof Map ? [...value] : Object.entries(value);
  if (!entries.length) return '{}';
  return `{${inner}${entries.map(([k, v]) => `${jsonString(k)}: ${jsonDumps(v, indent, depth + 1)}`).join(separator)}${outer}}`;
}

// argparse for the shape these tools use: positionals, then options that take one value.
//   spec = {prog, positionals: ['bom'], options: [{flag: '--boards', type: 'int', fallback: 5n}, {flag: '--x', required: true}]}
// Same parse order, abbreviations and messages. The usage text is built on one line: the tools keep it under 78
// columns, where argparse does not wrap it. With a narrower COLUMNS argparse wraps it and this does not.
export function parseArgs(spec, argv) {
  const dest = flag => flag.replace(/^--/, '').replaceAll('-', '_');
  const metavar = o => dest(o.flag).toUpperCase();
  const usage = `usage: ${spec.prog} [-h]${spec.options.map(o => o.required ? ` ${o.flag} ${metavar(o)}` : ` [${o.flag} ${metavar(o)}]`).join('')}${spec.positionals.map(p => ' ' + p).join('')}\n`;
  const fail = message => {
    write(2, `${usage}${spec.prog}: error: ${message}\n`);
    throw new SystemExit(2);
  };
  const help = () => {
    const flags = spec.options.map(o => `  ${o.flag} ${metavar(o)}`);
    const column = Math.min(Math.max(12, ...flags.map(text => text.length)) + 2, 24);
    print([usage, 'positional arguments:'].join('\n') + '\n' + [...spec.positionals.map(p => '  ' + p), '', 'options:',
      '  -h, --help'.padEnd(column) + 'show this help message and exit', ...flags].join('\n'));
    throw new SystemExit(0);
  };
  const names = ['-h', '--help', ...spec.options.map(o => o.flag)];
  const classify = arg => {
    if (!arg.startsWith('-') || arg === '-') return null;
    if (names.includes(arg)) return {flag: arg};
    if (/^-[0-9]+$|^-[0-9]*\.[0-9]+$/.test(arg)) return null;
    const equal = arg.indexOf('=');
    const [text, value] = equal >= 0 ? [arg.slice(0, equal), arg.slice(equal + 1)] : [arg, undefined];
    if (names.includes(text)) return {flag: text, value};
    const matches = arg.startsWith('--') ? names.filter(n => n.startsWith(text)) : [];
    if (matches.length > 1) fail(`ambiguous option: ${arg} could match ${matches.join(', ')}`);
    if (matches.length === 1) return {flag: matches[0], value};
    if (arg.startsWith('-h')) return {flag: '-h', value: arg.slice(2)};
    if (arg.includes(' ')) return null;
    return {unknown: true};
  };
  const result = {}, positional = [], extras = [];
  const take = arg => { if (positional.length < spec.positionals.length) positional.push(arg); else extras.push(arg); };
  for (const o of spec.options) result[dest(o.flag)] = o.fallback ?? null;
  let onlyPositional = false;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (onlyPositional) { take(arg); continue; }
    if (arg === '--') { onlyPositional = true; continue; }
    const found = classify(arg);
    if (!found) { take(arg); continue; }
    if (found.unknown) { extras.push(arg); continue; }
    if (found.flag === '-h' || found.flag === '--help') {
      if (found.value !== undefined) fail(`argument -h/--help: ignored explicit argument ${pyRepr(found.value)}`);
      help();
    }
    const option = spec.options.find(o => o.flag === found.flag);
    let value = found.value;
    if (value === undefined) {
      const next = argv[i + 1];
      if (next === undefined || next === '--' || classify(next)) fail(`argument ${option.flag}: expected one argument`);
      value = next; i++;
    }
    if (option.type === 'int') {
      const text = strip(value);
      if (!/^[+-]?[0-9]+(_[0-9]+)*$/.test(text)) fail(`argument ${option.flag}: invalid int value: ${pyRepr(value)}`);
      value = BigInt(text.replaceAll('_', '').replace(/^\+/, ''));
    }
    result[dest(option.flag)] = value;
  }
  const missing = [...spec.positionals.slice(positional.length), ...spec.options.filter(o => o.required && result[dest(o.flag)] === null).map(o => o.flag)];
  if (missing.length) fail(`the following arguments are required: ${missing.join(', ')}`);
  spec.positionals.forEach((name, i) => { result[name] = positional[i]; });
  if (extras.length) fail(`unrecognized arguments: ${extras.join(' ')}`);
  return result;
}
