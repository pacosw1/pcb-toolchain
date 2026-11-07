// Content-addressed PDF inspection. Inspection never selects a part: it extracts and caches page text and renders, keyed
// on the exact PDF, tools and options. A cache entry is a folder with a receipt and is only ever replaced whole.
//
// Rendered pages and DPI do not change text extraction, so text has its own entry under text/, and a new render request
// reuses it. Full inspection keys and receipts stay readable for older cache entries.
import { chmodSync, cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, relative } from 'node:path';
import { holdLock, type HeldLock } from './file-lock.ts';
import { digest, encoded } from './part-native.ts';
import { sha } from './pcb-workflow.ts';
import { decode, item, jsonLoads, processText, PyError, run, strip, tail } from './py-compat.mjs';
import { caught, isFile, resolvePath, withSuffix, which } from './py-path.ts';
import { isDict, pyEquals, type Dict } from './py-dict.ts';

/** Python waited on flock without a limit; holdLock needs a number. A bound this long never ends a real extraction. */
const LOCK_WAIT_S = 3600;
const POPPLER_BIN = '.cache/codex-runtimes/codex-primary-runtime/dependencies/native/poppler/poppler/bin';
const SCHEMA = 'iot-lab.part-evidence.v1';
const RECEIPT_FILES = new Set(['receipt.json', 'receipt.sha256']);
const TEXT_OPTIONS = ['-layout', '-enc', 'UTF-8'];

export interface ToolInfo { path: string; sha256: string; version: string }
type ToolName = 'pdftotext' | 'pdfinfo' | 'pdftoppm';
type Tools = Partial<Record<ToolName, ToolInfo>>;

const valueError = (message: string) => new PyError('ValueError', message);
const runtimeError = (message: string) => new PyError('RuntimeError', message);
const pageName = (number: number) => `pages/${String(number).padStart(4, '0')}.txt`;
const renderName = (number: number) => `renders/${String(number).padStart(4, '0')}.png`;
const isLink = (path: string): boolean => {
  try {
    return lstatSync(path).isSymbolicLink();
  } catch {
    return false;
  }
};

/** The executable of `name`, from the override, the upper-case variable, the bundled Poppler or PATH, with its identity. */
function pdfTool(name: ToolName, override?: string): ToolInfo {
  const bundled = join(homedir(), POPPLER_BIN, name);
  const candidate = override || process.env[name.toUpperCase()] || (isFile(bundled) ? bundled : which(name));
  if (!candidate) throw runtimeError(`${name} is required; configure ${name.toUpperCase()} or install Poppler`);
  const path = resolvePath(candidate);
  const result = run(path, ['-v'], { timeout: 10 });
  if (result.status) throw runtimeError(`${name} version probe failed: ${tail(processText(result.stderr), 500)}`);
  return { path, sha256: sha(path), version: strip(processText(result.stdout) + processText(result.stderr)) };
}
export { pdfTool as tool };

/** The page count of a PDF. `toolInputs` records the pdfinfo that was used and refuses a second, different one. */
export function pdfPages(path: string, info: ToolInfo = pdfTool('pdfinfo'), toolInputs?: Record<string, string>): number {
  const result = run(info.path, [path], { timeout: 30, env: { ...process.env, LC_ALL: 'C' } });
  const match = /^Pages:\s*([1-9][0-9]*)\s*$/m.exec(processText(result.stdout));
  if (result.status || !match) throw valueError(`cannot read actual PDF page count: ${tail(processText(result.stderr), 500)}`);
  if (sha(info.path) !== info.sha256) throw valueError('pdfinfo changed during page inspection');
  if (toolInputs) {
    const previous = toolInputs[info.path] ??= info.sha256;
    if (previous !== info.sha256) throw valueError('pdfinfo changed during verification');
  }
  return Number(match[1]);
}

/** Relative path: hash of every file of a cache folder except its receipt. */
function cacheFiles(directory: string): Record<string, string> {
  const files: Record<string, string> = {};
  const visit = (folder: string): void => {
    for (const entry of readdirSync(folder, { withFileTypes: true })) {
      const path = join(folder, entry.name);
      if (entry.isSymbolicLink()) throw valueError('PDF cache contains a symlink');
      if (entry.isDirectory()) visit(path);
      else if (entry.isFile() && !RECEIPT_FILES.has(entry.name)) files[relative(directory, path)] = sha(path);
    }
  };
  visit(directory);
  return files;
}

function validReceipt(directory: string, key: string, renderPages: unknown[], scope: string): Dict | null {
  const raw = readFileSync(join(directory, 'receipt.json'));
  if (digest(raw) !== strip(readFileSync(join(directory, 'receipt.sha256'), 'utf8'))) return null;
  const receipt = jsonLoads(raw);
  const count = item(receipt, 'page_count');
  if (typeof count !== 'bigint' || count < 1n) return null;
  const identity = new Map(['schema', 'pdf_sha256', 'tools', 'options'].map(name => [name, item(receipt, name)]));
  if (digest(encoded(identity)) !== key) return null;
  const expected = new Set(Array.from({ length: Number(count) }, (_, index) => pageName(index + 1)));
  for (const page of renderPages) expected.add(renderName(Number(page)));
  const artifacts = item(receipt, 'artifacts');
  const listed = isDict(artifacts) ? [...artifacts.keys()] : [];
  const sameFiles = listed.length === expected.size && listed.every(name => expected.has(name));
  const unchanged = item(receipt, 'key') === key && item(receipt, 'scope') === scope && item(receipt, 'reviewed') === false && sameFiles;
  return unchanged && pyEquals(cacheFiles(directory), artifacts) ? receipt as Dict : null;
}

function readCache(directory: string, key: string, renderPages: unknown[], scope = 'pdf_inspection'): Dict | null {
  try {
    return isLink(directory) ? null : validReceipt(directory, key, renderPages, scope);
  } catch (error) {
    if (caught(error, 'OSError', 'ValueError', 'KeyError', 'TypeError')) return null;
    throw error;
  }
}

function publish(staging: string, destination: string, identity: object, key: string, scope: string, count: number): Dict {
  const receipt = { ...identity, key, scope, page_count: count, reviewed: false, artifacts: cacheFiles(staging) };
  const raw = Buffer.concat([encoded(receipt), Buffer.from('\n')]);
  writeFileSync(join(staging, 'receipt.json'), raw);
  writeFileSync(join(staging, 'receipt.sha256'), `${digest(raw)}\n`);
  chmodSync(staging, 0o755);
  if (isLink(destination)) throw valueError('refusing symlink PDF cache entry');
  if (existsSync(destination)) rmSync(destination, { recursive: true, force: true });
  renameSync(staging, destination);
  return jsonLoads(raw) as Dict;
}

/** Keep independently mutable entries; accept only the validated page bytes. */
function copyPdfText(source: string, staging: string, receipt: Dict): void {
  mkdirSync(join(staging, 'pages'));
  const artifacts = item(receipt, 'artifacts');
  for (let number = 1; number <= Number(item(receipt, 'page_count')); number++) {
    const name = pageName(number);
    cpSync(join(source, name), join(staging, name));
    if (sha(join(staging, name)) !== item(artifacts, name)) throw valueError('PDF text cache changed during reuse');
  }
}

/** A private folder next to the cache entries for the work of `action`; gone afterwards unless it was published. */
async function inStaging<T>(parent: string, action: (staging: string) => T | Promise<T>): Promise<T> {
  const staging = mkdtempSync(join(parent, '.pdf-'));
  try {
    return await action(staging);
  } finally {
    if (existsSync(staging)) rmSync(staging, { recursive: true, force: true });
  }
}

interface Request {
  pdf: string;
  hash: string;
  tools: Tools;
  pages: number[];
  dpi: number;
}

function assertUnchanged(request: Request, message: string): void {
  const changed = sha(request.pdf) !== request.hash || Object.values(request.tools).some(info => sha(info.path) !== info.sha256);
  if (changed) throw valueError(message);
}

function extractPages(request: Request, staging: string, textKey: string): number {
  console.error(`START: PDF extraction ${textKey}`);
  const { pdfinfo, pdftotext } = request.tools as Required<Tools>;
  const count = pdfPages(request.pdf, pdfinfo);
  if (request.pages.some(page => page > count)) throw valueError('render page is outside actual PDF');
  const result = run(pdftotext.path, [...TEXT_OPTIONS, request.pdf, '-'], { timeout: 120 });
  if (result.status) throw runtimeError(`PDF extraction failed: ${tail(result.stderr.toString('utf8'), 1000)}`);
  const text = decode(result.stdout).split('\f');
  if (text.length && !strip(text.at(-1) as string)) text.pop();
  if (text.length !== count) throw valueError('extracted page boundaries differ from actual PDF page count');
  mkdirSync(join(staging, 'pages'));
  text.forEach((content, index) => writeFileSync(join(staging, pageName(index + 1)), content));
  return count;
}

function renderPages(request: Request, staging: string): void {
  if (!request.pages.length) return;
  mkdirSync(join(staging, 'renders'));
  for (const number of request.pages) {
    console.error(`START: PDF render page ${number} at ${request.dpi} DPI`);
    const prefix = join(staging, 'renders', String(number).padStart(4, '0'));
    const page = String(number);
    const result = run((request.tools.pdftoppm as ToolInfo).path,
      ['-f', page, '-l', page, '-singlefile', '-png', '-r', String(request.dpi), request.pdf, prefix], { timeout: 120 });
    if (result.status || !isFile(withSuffix(prefix, '.png'))) throw runtimeError('PDF page render failed');
  }
}

export interface Extractors { pdftotext?: string; pdfinfo?: string; pdftoppm?: string }

function checkRequest(pdf: string, pages: number[], dpi: number): void {
  if (!readFileSync(pdf).subarray(0, 1024).includes('%PDF-')) throw valueError('input is not a PDF');
  if (!Number.isInteger(dpi) || dpi <= 0) throw valueError('render DPI must be a positive integer');
  if (pages.some(page => !Number.isInteger(page) || page < 1)) throw valueError('render pages are one-based positive integers');
}

/** Runs `action` holding the flock of `path`, the file the Python tool locks; `action` may give it up early. */
async function withLock<T>(path: string, action: (lock: HeldLock) => Promise<T>): Promise<T> {
  const lock = await holdLock(path, { waitS: LOCK_WAIT_S });
  try {
    return await action(lock);
  } finally {
    await lock.release();
  }
}

export async function inspectPdf(pdfPath: string, cachePath: string, pagesAsked: Iterable<number> = [], dpi = 144, extractors: Extractors = {}) {
  const pdf = resolvePath(pdfPath);
  const cache = resolvePath(cachePath);
  const hash = sha(pdf);
  const pages = [...new Set(pagesAsked)].sort((a, b) => a - b);
  checkRequest(pdf, pages, dpi);
  const tools: Tools = { pdftotext: pdfTool('pdftotext', extractors.pdftotext), pdfinfo: pdfTool('pdfinfo', extractors.pdfinfo) };
  if (pages.length) tools.pdftoppm = pdfTool('pdftoppm', extractors.pdftoppm);
  const identity = { schema: 1, pdf_sha256: hash, tools, options: { text: TEXT_OPTIONS, render_pages: pages, dpi } };
  const key = digest(encoded(identity));
  const textIdentity = {
    schema: 1, pdf_sha256: hash, tools: { pdftotext: tools.pdftotext, pdfinfo: tools.pdfinfo }, options: { text: TEXT_OPTIONS },
  };
  const textKey = digest(encoded(textIdentity));
  mkdirSync(cache, { recursive: true });
  const textCache = join(cache, 'text');
  if (isLink(textCache)) throw valueError('refusing symlink PDF text cache');
  mkdirSync(textCache, { recursive: true });
  const textDirectory = join(textCache, textKey);
  const destination = join(cache, key);
  const request: Request = { pdf, hash, tools, pages, dpi };

  const textReceipt = async (existing: Dict | null): Promise<{ receipt: Dict; hit: boolean }> => {
    const cached = readCache(textDirectory, textKey, [], 'pdf_text_extraction');
    if (cached) return { receipt: cached, hit: true };
    const receipt = await inStaging(textCache, staging => {
      let count: number;
      if (existing) {
        count = Number(item(existing, 'page_count'));
        copyPdfText(destination, staging, existing);
      } else count = extractPages(request, staging, textKey);
      assertUnchanged(request, 'PDF or extractor changed during extraction');
      return publish(staging, textDirectory, textIdentity, textKey, 'pdf_text_extraction', count);
    });
    return { receipt, hit: existing !== null };
  };

  const fullReceipt = (text: Dict, textLock: HeldLock): Promise<Dict> => inStaging(cache, async staging => {
    copyPdfText(textDirectory, staging, text);
    // Rendering only uses this private copy: another request may reuse the same text while pages render.
    await textLock.release();
    renderPages(request, staging);
    assertUnchanged(request, 'PDF or extractor changed during inspection');
    return publish(staging, destination, identity, key, 'pdf_inspection', Number(item(text, 'page_count')));
  });

  return withLock(join(cache, `${key}.lock`), async () => {
    let receipt = readCache(destination, key, pages);
    const hit = receipt !== null;
    const textHit = await withLock(join(textCache, `${textKey}.lock`), async textLock => {
      const text = await textReceipt(receipt);
      if (pages.some(page => page > Number(item(text.receipt, 'page_count')))) throw valueError('render page is outside actual PDF');
      receipt ??= await fullReceipt(text.receipt, textLock);
      return text.hit;
    });
    const accepted = receipt as Dict;
    assertUnchanged(request, 'PDF or extractor changed before accepting inspection');
    if (!pyEquals(readCache(destination, key, pages), accepted)) throw valueError('PDF inspection cache changed before acceptance');
    const artifacts = item(accepted, 'artifacts') as Dict;
    const receiptFiles = ['receipt.json', 'receipt.sha256'].map(name => join(destination, name));
    return {
      schema: SCHEMA, scope: 'pdf_inspection', status: 'inspected', cache_hit: hit, cache_key: key, cache_directory: destination,
      pdf, text_cache_hit: textHit, text_cache_key: textKey, text_cache_directory: textDirectory,
      inputs: {
        [pdf]: hash, ...Object.fromEntries(receiptFiles.map(file => [file, sha(file)])),
        ...Object.fromEntries([...artifacts].map(([name, value]) => [join(destination, name), value])),
      },
      tool_inputs: Object.fromEntries(Object.values(tools).map(info => [info.path, info.sha256])),
      receipt: accepted, qualified: false, stock_current: false, release_approved: false,
    };
  });
}

/** Default folder of `inspect`. */
export const defaultCache = (): string => join(homedir(), '.cache/iot-lab/part-evidence');
