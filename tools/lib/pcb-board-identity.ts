// Validate the JSON subset of pcbstudio.board.v1 without an extra YAML runtime.
// This observes identity only; it does not change CAD or certify a board.
import { readFileSync, realpathSync, statSync } from 'node:fs';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { createHash } from 'node:crypto';
import { pipeline as configuredPipeline } from './pcb-workflow.ts';

type Obj = Record<string, unknown>;
export type IdentityFinding = { code: string; detail: string };
const object = (x: unknown): x is Obj => x !== null && typeof x === 'object' && !Array.isArray(x);
const id = (x: unknown): x is string => typeof x === 'string' && /^[A-Z0-9][A-Z0-9-]*$/.test(x);
const boardFields = new Set(['schema', 'id', 'lifecycle', 'kind', 'variant_of', 'revisions']);
const revFields = new Set(['rev', 'state', 'pcb', 'sch', 'spec', 'bom', 'gate', 'pipeline', 'gates']);

// Resolve symlinks even for absent final path components.
function real(p: string): string {
  let current: string = sep;
  for (const part of resolve(p).split(sep).filter(Boolean)) {
    const next = join(current, part);
    try { current = realpathSync(next); } catch { current = next; }
  }
  return current;
}
function inside(base: string, value: unknown): string | null {
  if (typeof value !== 'string' || !value || isAbsolute(value)) return null;
  const root = real(base), path = real(join(root, value)), rel = relative(root, path);
  return rel !== '' && rel !== '..' && !rel.startsWith('..' + sep) && !isAbsolute(rel) ? path : null;
}
function file(p: string | null): boolean {
  if (!p) return false;
  try { return statSync(p).isFile(); } catch { return false; }
}

export function inspectBoardIdentity(rootArg: string, board: string, document: unknown): object {
  const root = real(rootArg), boards = real(join(root, 'hardware-design/boards'));
  const registryPath = join(root, 'hardware-design/registry/boards.json');
  const bytes = readFileSync(registryPath), registry: unknown = JSON.parse(bytes.toString());
  if (!object(registry) || registry.schema_version !== 1 || !Array.isArray(registry.boards)) throw new Error('invalid board registry');
  const matching = registry.boards.filter((x: unknown) => object(x) && x.id === board);
  if (matching.length !== 1) throw new Error('registry must contain exactly one entry for ' + board);
  const entry = matching[0] as Obj;
  if (!id(entry.directory) || entry.kind === 'gate-only') throw new Error('board has no independent Studio identity directory');
  const folder = inside(boards, entry.directory);
  if (!folder || !object(document)) throw new Error('invalid board directory or Studio document');
  const findings: IdentityFinding[] = [];
  const fail = (code: string, detail: string): void => { findings.push({ code, detail }); };
  for (const key of Object.keys(document)) if (!boardFields.has(key)) fail('unknown_field', key);
  if ((document.schema ?? 'pcbstudio.board.v1') !== 'pcbstudio.board.v1') fail('schema', 'unknown schema');
  for (const key of ['id', 'lifecycle', 'kind', 'variant_of'])
    if ((document[key] ?? null) !== (entry[key] ?? null)) fail('registry_mismatch', key);
  if (!Array.isArray(document.revisions ?? [])) throw new Error('revisions must be an array');
  const expected = new Map<string, Obj>();
  for (const rev of (Array.isArray(entry.revisions) ? entry.revisions : []))
    if (object(rev) && typeof rev.revision === 'string') expected.set(rev.revision, rev);
  const seen = new Set<string | null>();
  for (const value of (document.revisions ?? []) as unknown[]) {
    if (!object(value)) { fail('invalid_revision', 'revision must be an object'); continue; }
    for (const key of Object.keys(value)) if (!revFields.has(key)) fail('unknown_field', key);
    const rev = value.rev;
    if (rev !== null && (typeof rev !== 'string' || !rev)) { fail('invalid_revision', 'rev must be string or null'); continue; }
    if (seen.has(rev as string | null)) fail('duplicate_revision', String(rev));
    seen.add(rev as string | null);
    const registered = typeof rev === 'string' ? expected.get(rev) : undefined;
    if (!registered) fail('unregistered_revision', String(rev));
    else {
      for (const key of ['state', 'spec', 'bom', 'gate'])
        if ((value[key] ?? null) !== (registered[key] ?? null)) fail('registry_mismatch', `${rev}: ${key}`);
      for (const [key, ext] of [['pcb', '.kicad_pcb'], ['sch', '.kicad_sch']]) {
        const candidate = typeof registered.project === 'string' ? inside(folder, registered.project + ext) : null;
        const expectedPath = file(candidate) ? candidate : null;
        const got = value[key] == null ? null : inside(folder, value[key]);
        if (got !== expectedPath) fail('registry_mismatch', `${rev}: ${key}`);
      }
    }
    for (const key of ['pcb', 'sch', 'spec', 'bom', 'pipeline']) {
      if (value[key] != null && !file(inside(key === 'pipeline' ? root : folder, value[key]))) fail('missing_or_unsafe_path', `${rev}: ${key}`);
    }
    const gates = value.gates ?? [];
    if (!Array.isArray(gates)) { fail('invalid_gates', String(rev)); continue; }
    let primaryFound = false;
    for (const gate of gates) {
      if (!object(gate) || Object.keys(gate).some(key => !['name', 'config'].includes(key)) || !id(gate.name) || typeof (gate.config ?? 'gate.json') !== 'string') {
        fail('invalid_gate', String(rev)); continue;
      }
      const dir = inside(boards, gate.name), config = dir && inside(dir, gate.config ?? 'gate.json');
      if (!file(config)) { fail('invalid_gate', `${rev}: ${gate.name}`); continue; }
      if (gate.name === value.gate && (gate.config ?? 'gate.json') === 'gate.json') primaryFound = true;
      try {
        const cfg: unknown = JSON.parse(readFileSync(config!, 'utf8'));
        const target = object(cfg) && typeof cfg.project === 'string' ? real(join(dir!, cfg.project + '.kicad_pcb')) : null;
        const pcb = value.pcb == null ? null : inside(folder, value.pcb);
        if (!target || !inside(boards, relative(boards, target)) || target !== pcb) fail('gate_project_mismatch', `${rev}: ${gate.name}`);
      } catch { fail('invalid_gate', `${rev}: ${gate.name}`); }
    }
    if (value.gate != null && (!id(value.gate) || !primaryFound)) fail('gate_unlisted', String(rev));
    // Studio displays this field as a workflow capability. Its existence alone
    // does not establish that the CLI will execute it: gate.json is the
    // centralized toolchain's build-pipeline authority.
    if (value.pipeline != null) {
      let declared: unknown;
      if (id(value.gate)) {
        const gateDir = inside(boards, value.gate), gateFile = gateDir && inside(gateDir, 'gate.json');
        try { const cfg: unknown = gateFile && JSON.parse(readFileSync(gateFile, 'utf8')); if (object(cfg)) declared = cfg.pipeline; } catch { /* reported below */ }
      }
      if (typeof declared !== 'string' || !declared) fail('pipeline_authority_unknown', `${rev}: primary gate does not declare a build pipeline`);
      else if (value.pipeline !== declared) fail('pipeline_authority_mismatch', `${rev}: Studio pipeline differs from gate declaration`);
      else if (id(value.gate)) {
        try {
          if (configuredPipeline(root, value.gate) !== declared) fail('pipeline_authority_unknown', `${rev}: CLI cannot resolve the declared pipeline`);
        } catch {
          fail('pipeline_authority_invalid', `${rev}: CLI rejects the declared pipeline`);
        }
      }
    }
  }
  for (const rev of expected.keys()) if (!seen.has(rev)) fail('missing_revision', rev);
  return { schema_version: 1, board, registry_sha256: createHash('sha256').update(bytes).digest('hex'),
    ok: findings.length === 0, findings, scope: 'metadata consistency; qualification not assessed' };
}

export function readBoardIdentity(path: string): unknown {
  try { return JSON.parse(readFileSync(path, 'utf8')); }
  catch { throw new Error('expected JSON syntax, a YAML subset; convert Studio YAML before inspection'); }
}

/** Audit every registry entry, including entities without an independent manifest. */
export function auditBoardIdentities(rootArg: string): object {
  const root = real(rootArg), base = real(join(root, 'hardware-design/boards'));
  const bytes = readFileSync(join(root, 'hardware-design/registry/boards.json'));
  const registry: unknown = JSON.parse(bytes.toString());
  if (!object(registry) || registry.schema_version !== 1 || !Array.isArray(registry.boards)) throw new Error('invalid board registry');
  const records = registry.boards;
  const ids = new Map<string, Obj>();
  const rows: { board: string | null; status: string; reason?: string; findings?: unknown }[] = [];
  for (const entry of records) {
    if (!object(entry) || !id(entry.id)) { rows.push({ board: null, status: 'conflict', reason: 'invalid registry entry ID' }); continue; }
    if (ids.has(entry.id)) { rows.push({ board: entry.id, status: 'conflict', reason: 'duplicate registry ID' }); continue; }
    ids.set(entry.id, entry);
  }
  for (const [board, entry] of ids) {
    if (entry.kind === 'gate-only') {
      const owner = typeof entry.owner === 'string' ? ids.get(entry.owner) : undefined;
      const revisions = owner && Array.isArray(owner.revisions) ? owner.revisions : [];
      const folder = id(entry.directory) ? inside(base, entry.directory) : null;
      const pending = typeof entry.pending_gate === 'string' && folder !== null &&
        file(inside(folder, entry.pending_gate)) && !file(inside(folder, 'gate.json'));
      const matches = revisions.filter(value => object(value) && value.revision === entry.revision &&
        (value.gate === board || (value.gate === null && pending)));
      if (!folder || matches.length !== 1 || file(inside(folder, 'board.yaml'))) rows.push({ board, status: 'conflict', reason: 'invalid gate owner or unexpected independent manifest' });
      else rows.push({ board, status: 'not_applicable', reason: 'gate-only identity belongs to owner revision' });
      continue;
    }
    if (entry.kind === 'variant' && entry.directory == null) {
      const owner = typeof entry.variant_of === 'string' ? ids.get(entry.variant_of) : undefined;
      if (!owner || owner.kind !== 'board') rows.push({ board, status: 'conflict', reason: 'variant owner is missing or not a physical board' });
      else rows.push({ board, status: 'not_applicable', reason: 'virtual variant has no independent directory' });
      continue;
    }
    if (entry.kind !== 'board' && entry.kind !== 'variant') { rows.push({ board, status: 'conflict', reason: 'invalid registry kind' }); continue; }
    const folder = id(entry.directory) ? inside(base, entry.directory) : null;
    const path = folder && inside(folder, 'board.yaml');
    if (!path || !file(path)) { rows.push({ board, status: 'missing', reason: 'independent board.yaml is missing or unsafe' }); continue; }
    try {
      const result = inspectBoardIdentity(root, board, readBoardIdentity(path)) as { ok: boolean; findings: unknown };
      rows.push({ board, status: result.ok ? 'passed' : 'conflict', findings: result.findings });
    } catch (error) {
      rows.push({ board, status: 'conflict', reason: error instanceof Error ? error.message : String(error) });
    }
  }
  const counts = { passed: rows.filter(x => x.status === 'passed').length,
    not_applicable: rows.filter(x => x.status === 'not_applicable').length,
    missing: rows.filter(x => x.status === 'missing').length,
    conflict: rows.filter(x => x.status === 'conflict').length };
  return { schema_version: 1, registry_sha256: createHash('sha256').update(bytes).digest('hex'),
    ok: counts.missing === 0 && counts.conflict === 0, counts, boards: rows,
    scope: 'registry and Studio metadata consistency; qualification and build execution not assessed' };
}
