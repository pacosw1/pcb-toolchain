// Read-only gate summary and atomic index update for board_3d.sh.
import { randomBytes } from 'node:crypto';
import { readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const CORE = ['erc_errors', 'drc_errors', 'drc_parity', 'drc_unconnected'];
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const metric = value => typeof value === 'number' && Number.isFinite(value) && value >= 0;
const readJson = path => JSON.parse(readFileSync(path, 'utf8'));

export function project(path) {
  const config = readJson(path);
  if (!object(config) || typeof config.project !== 'string' || !config.project) throw new Error('gate.json needs a project');
  return config.project;
}

export function gateNote(root, board, sha) {
  const path = join(root, 'hardware-design/boards', board, 'gate-metrics.json');
  let result;
  try { result = readJson(path); }
  catch (error) {
    const kind = error?.code === 'ENOENT' ? 'FileNotFoundError' : error instanceof SyntaxError ? 'JSONDecodeError' : 'OSError';
    return `gate UNVERIFIED: no readable gate-metrics.json (${kind})`;
  }
  const metrics = object(result) ? result.metrics : null;
  if (!object(result) || result.schema_version !== 2 || result.board !== board || !object(metrics)) {
    return 'gate UNVERIFIED: gate-metrics.json is not schema 2 for this board';
  }
  const absent = CORE.filter(key => !metric(metrics[key]));
  if (absent.length) return `gate UNVERIFIED: metrics missing ${absent.join(', ')}`;
  const invalid = Object.keys(metrics).filter(key => !metric(metrics[key]));
  if (invalid.length) return `gate UNVERIFIED: invalid metrics ${invalid.join(', ')}`;
  if (result.pcb_sha256 !== sha) return 'gate UNVERIFIED: gate-metrics.json is for another version of the board file (stale)';
  const issues = Object.entries(metrics).filter(([key, value]) => metric(value) && value > 0 && !key.includes('warning'));
  return issues.length ? `gate NOT at target: ${issues.map(([key, value]) => `${key} ${value}`).join(', ')}` : 'gate at target';
}

export function record(root, out, board, sha) {
  const path = join(out, 'boards.json');
  let entries = [];
  try {
    const previous = readJson(path);
    if (Array.isArray(previous) && previous.every(row => object(row) && typeof row.name === 'string')) entries = previous;
  } catch { /* A missing or unreadable previous index starts a new one. */ }
  const rows = new Map(entries.map(row => [row.name, row]));
  const note = gateNote(root, board, sha);
  rows.set(board, { name: board, pcb_sha256: sha, note });
  const temp = `${path}.${randomBytes(8).toString('hex')}.tmp`;
  try { writeFileSync(temp, JSON.stringify([...rows.values()], null, 1), { flag: 'wx' }); renameSync(temp, path); }
  finally { rmSync(temp, { force: true }); }
  return { note, bytes: statSync(join(out, `${board}.glb`)).size };
}

function main(args) {
  if (args.length === 2 && args[0] === 'project') { console.log(project(args[1])); return; }
  if (args.length === 6 && args[0] === 'record') {
    const [, root, out, board, sha, missing] = args;
    const result = record(root, out, board, sha);
    console.log(`board_3d ${board}: PASS ${result.bytes} bytes GLB, ${missing} 3D models not found; ${result.note}`);
    return;
  }
  throw new Error('usage: metadata.mjs project GATE.json | record ROOT OUT BOARD SHA MISSING');
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { main(process.argv.slice(2)); }
  catch (error) { console.error(error.message); process.exitCode = 1; }
}
