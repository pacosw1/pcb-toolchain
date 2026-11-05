// Dated assembly stock observation of a release candidate, through tools/release-stock.mjs. Quantities are not reserved:
// engineering selection and complete assembly availability stay separate. Every check that can refuse the candidate runs
// before the first supplier request, so a stale candidate never queries.
import { lstatSync } from 'node:fs';
import { basename, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseIso } from './iso-time.ts';
import { owned, readBoard, type NativeBoard } from './part-native.ts';
import { SCHEMA } from './part-review.ts';
import { sha } from './pcb-workflow.ts';
import { get, item, PyError, run, truthy } from './py-compat.mjs';
import { caught, isFile, joinPath, jsonOf, pathExists, resolvePath } from './py-path.ts';
import { fullMatch, iterate, pyEquals, type Dict } from './py-dict.ts';

const BOARD_ID = /^[A-Z0-9][A-Z0-9-]*$/;
const SHA256 = /^[a-f0-9]{64}$/;
const LCSC = /^C[0-9]+$/;
const STOCK_SOURCE = 'https://jlcpcb.com/api/overseas-pcb-order/v1/shoppingCart/smtGood/selectSmtComponentList';
const TOOLS = fileURLToPath(new URL('..', import.meta.url)).replace(/\/$/, '');
const HANDLED = ['OSError', 'ValueError', 'KeyError', 'TypeError', 'RuntimeError', 'subprocess.TimeoutExpired', 'subprocess.CalledProcessError'];
const QUERY_SECONDS = 30;

export interface PopulationSource { path: unknown; exists: unknown; sha256: unknown }
export interface PopulationReport { board?: unknown; population_source?: PopulationSource }

export interface StockReport extends PopulationReport {
  schema: string;
  scope: string;
  status: string;
  qualified: boolean;
  stock_current: boolean;
  release_approved: boolean;
  blockers: { code: string; detail: string }[];
  inputs: Record<string, string>;
  [field: string]: unknown;
}

/** Runs the helper with the command given and returns its exit status. */
export type StockRunner = (command: string[], timeoutSeconds: number) => { status: number | null };

const valueError = (message: string) => new PyError('ValueError', message);
const isLink = (path: string): boolean => {
  try {
    return lstatSync(path).isSymbolicLink();
  } catch {
    return false;
  }
};
const parentName = (path: string, levels: number): string => {
  let folder = path;
  for (let level = 0; level < levels; level++) folder = dirname(folder);
  return basename(folder);
};

const defaultRunner: StockRunner = ([command, ...args], timeout) =>
  run(command as string, args, { timeout, stdio: ['inherit', process.stderr.fd, process.stderr.fd] });

/**
 * Checks the exact optional population policy, including recorded absence. Absolute paths retain the original backend
 * workspace context. This observes filesystem presence and hash only; it never runs native CAD or supplier tools.
 */
export function verifyPopulationSource(report: PopulationReport): void {
  const descriptor = report.population_source;
  const shaped = descriptor !== undefined && descriptor !== null && typeof descriptor === 'object'
    && Object.keys(descriptor).length === 3 && 'path' in descriptor && 'exists' in descriptor && 'sha256' in descriptor;
  if (!shaped || typeof descriptor.path !== 'string' || typeof descriptor.exists !== 'boolean') {
    throw valueError('stock observation lacks an explicit population policy presence binding');
  }
  const path = joinPath(descriptor.path);
  const exact = path.startsWith('/') && resolvePath(path) === path && !isLink(path) && basename(path) === 'variants.json'
    && parentName(path, 1) === report.board && parentName(path, 2) === 'boards' && parentName(path, 3) === 'hardware-design';
  if (!exact) throw valueError('stock population policy path is not its exact native board owner');
  if (descriptor.exists) {
    const expected = descriptor.sha256;
    if (typeof expected !== 'string' || !SHA256.test(expected) || !isFile(path) || sha(path) !== expected) {
      throw valueError('stock population policy changed or disappeared');
    }
  } else if (descriptor.sha256 !== null || pathExists(path)) throw valueError('stock population policy appeared after recorded absence');
}

export function stockPopulationCurrent(report: PopulationReport): boolean {
  try {
    verifyPopulationSource(report);
    return true;
  } catch (error) {
    if (caught(error, 'OSError', 'ValueError', 'TypeError', 'KeyError')) return false;
    throw error;
  }
}

function checkCandidateBinding(manifest: unknown, gate: unknown, board: string, native: NativeBoard, evidencePath: string): void {
  const inputs = item(item(item(gate, 'result'), 'provenance'), 'inputs');
  const recorded = new Map(iterate(inputs).map(row => [item(row, 'path'), item(row, 'sha256')]));
  const stale = get(get(manifest, 'artifacts', new Map()), 'fab/gate-evidence.json') !== sha(evidencePath)
    || !truthy(get(manifest, 'input_sha256')) || get(gate, 'input_sha256') !== item(manifest, 'input_sha256') || get(gate, 'board') !== board
    || Object.entries(native.native_inputs).some(([name, value]) => recorded.get(name) !== value);
  if (stale) throw valueError('candidate native board/schematic binding is stale; no stock request made');
}

const uniqueStrings = (value: unknown): value is string[] =>
  Array.isArray(value) && value.every(name => typeof name === 'string') && new Set(value).size === value.length;

function checkVariants(variants: unknown, native: NativeBoard): { names: string[]; fit: Dict } {
  const names = item(variants, 'variants');
  const fit = item(variants, 'fit') as Dict;
  const fitted = new Set(iterate(fit));
  const coverage = uniqueStrings(names) && names.length > 0 && names.every(name => name.trim())
    && fitted.size === native.parts.size && [...fitted].every(ref => native.parts.has(ref as string));
  if (!coverage) throw valueError('current variant population coverage is incomplete; no stock request made');
  for (const [ref, rows] of fit) {
    const valid = uniqueStrings(rows) && rows.every(name => names.includes(name)) && !(native.parts.get(ref)?.required && !rows.length);
    if (!valid) throw valueError(`current variant fit must explicitly cover native fitted references: ${ref}`);
  }
  return { names, fit };
}

/** Variant name: reference: LCSC code, as the current native parts and the variant policy say. */
function expectedPopulations(variantPath: string, native: NativeBoard, inputs: Record<string, string>): Map<string, Map<string, string>> {
  const parts = [...native.parts];
  if (!isFile(variantPath)) return new Map([['DEFAULT', new Map(parts.filter(([, part]) => part.required).map(([ref, part]) => [ref, part.lcsc]))]]);
  const { names, fit } = checkVariants(jsonOf(variantPath), native);
  inputs[variantPath] = sha(variantPath);
  return new Map(names.map(name => [name, new Map(parts
    .filter(([ref, part]) => part.in_bom && (fit.get(ref) as string[]).includes(name)).map(([ref, part]) => [ref, part.lcsc]))]));
}

/** The largest count of each LCSC code in one population, times the boards; and the MPN of each code. */
function requiredStock(populations: unknown, native: NativeBoard, boards: number): { required: Map<string, number>; models: Map<string, string> } {
  const required = new Map<string, number>();
  const models = new Map<string, string>();
  for (const population of (populations as Dict).values()) {
    const references = item(population, 'references') as Dict;
    for (const [ref, code] of references) {
      const part = native.parts.get(ref);
      if (!part || !part.mpn || part.lcsc !== code || (models.has(code as string) && models.get(code as string) !== part.mpn)) {
        throw valueError(`candidate reference/MPN/LCSC differs from actual native part: ${ref}`);
      }
      models.set(code as string, part.mpn);
    }
    const codes = [...references.values()];
    for (const code of codes) {
      if (typeof code !== 'string' || !LCSC.test(code)) throw valueError('candidate contains an invalid exact LCSC code');
      required.set(code, Math.max(required.get(code) ?? 0, codes.filter(other => other === code).length * boards));
    }
  }
  if (!required.size) throw valueError('candidate has no fitted assembly population');
  return { required, models };
}

function checkReceipt(receipt: unknown, board: string, manifestHash: string, day: string, boards: number, required: Map<string, number>): void {
  const parts = new Set(iterate(get(receipt, 'parts', new Map())));
  const bound = pyEquals(get(receipt, 'schema_version'), 1) && get(receipt, 'board') === board && get(receipt, 'candidate_sha256') === manifestHash
    && get(receipt, 'order_day_utc') === day && pyEquals(get(receipt, 'boards'), boards)
    && parts.size === required.size && [...required.keys()].every(code => parts.has(code));
  if (!bound) throw valueError('stock receipt candidate/board/day/quantity/coverage mismatch');
  if (get(receipt, 'source_url') !== STOCK_SOURCE) throw valueError('stock source differs from existing release helper');
}

function checkResponse(row: unknown, path: string, code: string, need: number, day: string): void {
  const fetched = get(row, 'fetched_at_utc', '');
  const sameDay = typeof fetched === 'string' && fetched.slice(0, 10) === day;
  if (isLink(path) || !pyEquals(get(row, 'required'), need) || sha(path) !== get(row, 'response_sha256') || !sameDay) {
    throw valueError(`stock original response/hash/day/quantity mismatch: ${code}`);
  }
  const time = parseIso(fetched);
  const utcDay = new Date(time.seconds * 1000).toISOString().slice(0, 10);
  if (!time.zoned || utcDay !== day) throw valueError(`stock original response timestamp lacks exact UTC day: ${code}`);
}

function observeResponse(row: unknown, receipts: string, code: string, need: number, mpn: string | undefined, day: string, inputs: Record<string, string>) {
  const name = get(row, 'response');
  if (typeof name !== 'string' || basename(name) !== name || ['', '.', '..'].includes(name)) throw valueError('invalid original stock response path');
  const path = joinPath(receipts, name);
  checkResponse(row, path, code, need, day);
  inputs[path] = sha(path);
  const orEmpty = (value: unknown) => (truthy(value) ? value : new Map());
  const info = orEmpty(get(orEmpty(get(jsonOf(path), 'data')), 'componentPageInfo'));
  const list = get(info, 'list');
  const exact = (truthy(list) ? iterate(list) : []).filter(entry => get(entry, 'componentCode') === code);
  const count = exact.length === 1 ? get(exact[0], 'stockCount') : null;
  if (typeof count !== 'bigint' || count < BigInt(need) || get(exact[0], 'componentModelEn') !== mpn) {
    throw valueError(`assembly stock is unavailable/ambiguous: ${code}`);
  }
  return { required: need, observed: count, mpn: get(exact[0], 'componentModelEn'), response_sha256: sha(path) };
}

function observe(report: StockReport, rootPath: string, board: string, candidatePath: string, boards: number, receiptsPath: string, runner: StockRunner): void {
  const root = resolvePath(rootPath);
  owned(root, `hardware-design/boards/${board}/gate.json`);
  const candidate = resolvePath(candidatePath);
  const receipts = resolvePath(receiptsPath);
  const manifestPath = joinPath(candidate, 'release-manifest.json');
  const manifest = jsonOf(manifestPath);
  const manifestHash = sha(manifestPath);
  if (!pyEquals(get(manifest, 'schema_version'), 1) || get(manifest, 'scope') !== 'cad_fabrication_candidate' || get(manifest, 'board') !== board) {
    throw valueError('candidate board/scope/schema mismatch; no stock request made');
  }
  if (pathExists(receipts)) throw valueError('stock receipts directory must be new; preserve original responses');
  const native = readBoard(root, board);
  if (native.blockers.length) throw valueError('native part identity is inconsistent; no stock request made');
  const evidencePath = joinPath(candidate, 'fab/gate-evidence.json');
  checkCandidateBinding(manifest, jsonOf(evidencePath), board, native, evidencePath);
  const variantPath = joinPath(root, 'hardware-design/boards', board, 'variants.json');
  const hasVariants = isFile(variantPath);
  report.population_source = { path: variantPath, exists: hasVariants, sha256: hasVariants ? sha(variantPath) : null };
  verifyPopulationSource(report);
  const variantInputs: Record<string, string> = {};
  const expected = expectedPopulations(variantPath, native, variantInputs);
  const populations = item(item(manifest, 'assembly'), 'populations') as Dict;
  const actual = new Map([...populations].map(([name, value]) => [name, item(value, 'references')]));
  if (!pyEquals(actual, expected) || ![...expected.values()].every(population => population.size)) {
    throw valueError('candidate populations differ from exact current native/variant scope; no stock request made');
  }
  const { required, models } = requiredStock(populations, native, boards);
  const day = new Date().toISOString().slice(0, 10);
  const helper = joinPath(TOOLS, 'release-stock.mjs');
  Object.assign(report, {
    candidate, candidate_sha256: manifestHash, order_day_utc: day, boards, required_quantities: required, receipts,
    inputs: { ...native.native_inputs, ...variantInputs, [manifestPath]: manifestHash, [evidencePath]: sha(evidencePath) },
    tool_inputs: Object.fromEntries([helper, joinPath(TOOLS, 'lib/py-compat.mjs')].map(path => [path, sha(path)])),
  });
  const result = runner(['node', helper, candidate, receipts, '--boards', String(boards)], QUERY_SECONDS * (required.size + 1));
  if (result.status) throw new PyError('RuntimeError', `existing stock helper failed; original/partial responses retained at ${receipts}`);
  const receiptPath = joinPath(receipts, 'stock.json');
  const receipt = jsonOf(receiptPath);
  report.inputs[receiptPath] = sha(receiptPath);
  checkReceipt(receipt, board, manifestHash, day, boards, required);
  const observed: Record<string, unknown> = {};
  for (const [code, need] of required) {
    observed[code] = observeResponse(item(item(receipt, 'parts'), code), receipts, code, need, models.get(code), day, report.inputs);
  }
  if (sha(manifestPath) !== manifestHash) throw valueError('candidate changed during stock observation');
  if (Object.entries(native.native_inputs).some(([name, value]) => sha(owned(root, name)) !== value)) {
    throw valueError('native board/schematic changed during stock observation');
  }
  if (Object.entries(report.inputs).some(([name, value]) => sha(name.startsWith('/') ? name : joinPath(rootPath, name)) !== value)) {
    throw valueError('candidate or original stock evidence changed during observation');
  }
  verifyPopulationSource(report);
  Object.assign(report, {
    status: 'observed', stock_current: true, observations: observed, receipt_sha256: sha(receiptPath),
    limits: ['Dated assembly stock observation only; quantities are not reserved. Engineering selection and complete assembly availability remain separate.'],
  });
}

/** Observe assembly availability through the existing exact release helper. */
export function stockBoard(root: string, board: string, candidate: string, boards: unknown, receipts: string, runner: StockRunner = defaultRunner): StockReport {
  const report: StockReport = {
    schema: SCHEMA, scope: 'assembly_stock_observation', board, status: 'blocked', qualified: false, stock_current: false, release_approved: false, blockers: [], inputs: {},
  };
  try {
    if (!fullMatch(BOARD_ID, board) || typeof boards !== 'number' || !Number.isInteger(boards) || boards < 1) {
      throw valueError('exact board and positive integer board quantity required');
    }
    observe(report, root, board, candidate, boards, receipts, runner);
  } catch (error) {
    if (!caught(error, ...HANDLED)) throw error;
    report.blockers.push({ code: 'stock_observation', detail: (error as Error).message });
  }
  return report;
}
