// Source-bound route evidence and diagnosis. Loose reports never establish native freshness.
import { existsSync, readFileSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, sep } from 'node:path';
import { boardConfig } from './pcb-workflow.ts';
import { sourceSet } from './native-board.ts';
import { fingerprint } from './fingerprint.ts';
import { readObject, sha256File } from './json-file.ts';
import { resolvePath, withSuffix } from './py-path.ts';

export type Hashes = Record<string, string>;
export interface DiagnosticItem { uuid?: string; description?: string; pos?: { x: number; y: number } }
export interface NativeFinding { type?: string; severity?: string; description?: string; items?: DiagnosticItem[] }
export interface DrcReport {
  source?: string; coordinate_units?: string; included_severities?: string[];
  violations: NativeFinding[]; unconnected_items: NativeFinding[]; schematic_parity: NativeFinding[];
}
export interface Finding { classification: string; reason: string; refs: string[]; nets: string[]; [key: string]: unknown }
interface Connection { class?: string; blocking_parts?: string[]; net?: string; blocking_nets?: string[] }
interface EscapePad { ref?: string; net?: string; pad?: string }
export interface Diagnostics {
  triage?: { connections?: Connection[]; not_checked?: number };
  escape?: { boxed_in?: EscapePad[] };
  router?: { completed_nets?: string[] };
  rules?: string;
}
export interface GateConfig { snapshot_schematic_datasheets?: boolean; project: string; checks?: Record<string, boolean>; route_features?: Record<string, Record<string, unknown>> }
export interface FileDescriptor { path: string; sha256: string }
interface Receipt {
  schema?: string; board?: string; source_inputs?: Hashes; inputs?: Hashes; artifacts?: Record<string, FileDescriptor>;
  source_mutated?: boolean; drc_returncode?: number; drc_command?: string[]; drc_sha256?: string;
  changedDuringRun?: boolean; preflightErrors?: unknown[]; checks?: { drc?: { status?: string; metrics?: Record<string, unknown> } };
  provenance?: { inputs?: { path: string; sha256: string | null }[] };
}
export const IMPLEMENTATIONS = ['route_decision.ts', 'lib/route-decision.ts', 'lib/route-decision-board.ts',
  'lib/route-decision-evidence.ts', 'lib/route-decision-escape.ts', 'lib/route-decision-cli.ts', 'lib/board-edit.ts', 'lib/board-json.ts',
  'lib/board-types.ts', 'lib/native-board.ts', 'lib/pcb-workflow.ts', 'lib/json-file.ts', 'lib/fingerprint.ts'];
export const read = <T extends object = Record<string, unknown>>(file: string): T => readObject<T>(file);
export const same = (a: unknown, b: unknown): boolean => fingerprint(a) === fingerprint(b);
export const sourceInputs = (board: string): Hashes => Object.fromEntries(sourceSet(board));
export const inside = (file: string, root: string): boolean => {
  const rel = relative(root, file); return !isAbsolute(rel) && rel !== '..' && !rel.startsWith(`..${sep}`);
};
export function implementations(root: string): Hashes {
  return Object.fromEntries(IMPLEMENTATIONS.map(name => [name, sha256File(join(root, 'tools', name))]));
}
export function nativeInputs(root: string, board: string): { cfg: GateConfig; native: string; sources: Hashes } {
  root = resolvePath(root);
  const { folder, project } = boardConfig(root, board), cfg = read<GateConfig>(join(folder, 'gate.json'));
  const files = [join(folder, 'gate.json'), ...['.kicad_pcb', '.kicad_pro', '.kicad_dru', '.kicad_sch'].map(ext => withSuffix(project, ext))];
  return { cfg, native: withSuffix(project, '.kicad_pcb'), sources: Object.fromEntries(files.map(file => [relative(root, file), sha256File(file)])) };
}
export function names(row: NativeFinding): { refs: string[]; nets: string[] } {
  const refs = new Set<string>(), nets = new Set<string>();
  for (const item of row.items ?? []) {
    const description = item.description ?? '', ref = /\bof\s+([^\s,]+)/.exec(description), net = /\[([^\]]+)\]/.exec(description);
    if (ref) refs.add(ref[1]!); if (net) nets.add(net[1]!);
  }
  return { refs: [...refs].sort(), nets: [...nets].sort() };
}
export function checkReport(report: DrcReport, native?: string): void {
  if (native && (report.source !== basename(native) || report.coordinate_units !== 'mm' || !report.included_severities?.includes('error'))
    || !['violations', 'unconnected_items', 'schematic_parity'].every(key => Array.isArray(report[key as keyof DrcReport]))) {
    throw new Error('native report lacks exact source, units, severities or required checks');
  }
}
export function loadEvidence(root: string, board: string, evidence: string, seen = new Set<string>()): { diagnostics: Diagnostics; report: DrcReport; artifacts: Hashes } {
  root = resolvePath(root); evidence = resolvePath(evidence);
  if (seen.has(evidence) || seen.size >= 2) throw new Error('recursive routing evidence is not an original native receipt');
  seen = new Set(seen).add(evidence);
  const { native } = nativeInputs(root, board), raw = read<Receipt>(evidence), artifacts: Hashes = { [evidence]: sha256File(evidence) };
  const diagnostics: Diagnostics = {};
  if (raw.schema === 'iot-lab.route-evidence.v1') {
    if (raw.board !== board || !same(raw.source_inputs, sourceInputs(native))) throw new Error('routing diagnostics do not match current native sources');
    for (const [key, entry] of Object.entries(raw.artifacts ?? {})) {
      if (!['native', 'triage', 'escape', 'router', 'rules'].includes(key) || typeof entry?.path !== 'string') throw new Error('unknown diagnostic artifact');
      const path = resolvePath(entry.path);
      if (entry.sha256 !== sha256File(path)) throw new Error('changed routing diagnostic artifact: ' + key);
      artifacts[path] = sha256File(path);
      if (key === 'native') continue;
      if (key === 'rules') diagnostics.rules = readFileSync(path, 'utf8');
      else {
        const data = read<{ source_inputs?: Hashes; board?: string }>(path);
        if (!same(data.source_inputs, sourceInputs(native)) || resolvePath(data.board ?? '') !== native) throw new Error('diagnostic does not bind this exact native source: ' + key);
        Object.assign(diagnostics, { [key]: data });
      }
    }
    if (!raw.artifacts?.native) throw new Error('routing diagnostics require original native evidence');
    const original = loadEvidence(root, board, raw.artifacts.native.path, seen);
    return { diagnostics, report: original.report, artifacts: { ...artifacts, ...original.artifacts } };
  }
  const path = join(dirname(evidence), 'drc.json');
  if (raw.schema === 'iot-lab.native-export.v1') {
    if (resolvePath(raw.board ?? '') !== native || raw.source_mutated !== false || raw.drc_returncode !== 0
      || !same(raw.inputs, sourceInputs(native)) || !['--schematic-parity', '--refill-zones', '--severity-all'].every(flag => raw.drc_command?.includes(flag))) {
      throw new Error('stale or incomplete native export evidence');
    }
    if (raw.drc_sha256 !== sha256File(path)) throw new Error('native DRC report changed after export');
  } else if (raw.provenance) {
    if (raw.changedDuringRun !== false || raw.preflightErrors?.length) throw new Error('native gate source/preflight is invalid');
    const check = raw.checks?.drc;
    if (!check || !['passed', 'failed'].includes(check.status ?? '') || !check.metrics || !Object.keys(check.metrics).length
      || Object.values(check.metrics).some(v => v === null)) throw new Error('native DRC did not complete with valid metrics');
    const bound: Record<string, string | null> = {};
    for (const entry of raw.provenance.inputs ?? []) {
      if (entry.path.startsWith('external/')) continue;
      const file = resolvePath(join(root, entry.path));
      if (!inside(file, root)) throw new Error('gate input escapes repository');
      if (entry.sha256 === null ? existsSync(file) : !existsSync(file) || sha256File(file) !== entry.sha256) throw new Error('gate input changed: ' + entry.path);
      bound[entry.path] = entry.sha256;
    }
    if (bound[relative(root, native)] !== sha256File(native)) throw new Error('gate does not bind the configured native board');
    const events = join(dirname(evidence), 'events.jsonl');
    const rows = readFileSync(events, 'utf8').split(/\r?\n/).filter(Boolean).map(line => JSON.parse(line) as { type?: string; stage?: string; code?: number });
    const exits = rows.filter(row => row.type === 'tool.exit' && row.stage === 'drc');
    if (exits.length !== 1 || exits[0]!.code !== 0) throw new Error('native DRC process receipt is incomplete');
    artifacts[events] = sha256File(events);
  } else throw new Error('expected completed native gate/export receipt, not a loose diagnostic');
  const report = read<DrcReport>(path); checkReport(report, native); artifacts[path] = sha256File(path);
  return { diagnostics, report, artifacts };
}
export function classify(report: DrcReport, diagnostics: Diagnostics): Finding[] {
  const rows: Finding[] = [];
  const add = (classification: string, reason: string, refs: string[] = [], nets: string[] = [], details: Record<string, unknown> = {}): void => {
    rows.push({ classification, reason, refs: [...new Set(refs)].sort(), nets: [...new Set(nets)].sort(), ...details });
  };
  report.schematic_parity.forEach((row, native_index) => { const { refs, nets } = names(row); add('schematic_parity', 'Resolve schematic/native disagreement before copper work', refs, nets, { native_index }); });
  report.violations.forEach((row, native_index) => {
    if (row.severity === 'error') { const { refs, nets } = names(row); add('native_geometry', row.description ?? row.type ?? 'Native rule violation', refs, nets, { rule: row.type ?? null, native_index }); }
  });
  for (const row of diagnostics.triage?.connections ?? []) {
    const kind = row.class === 'ENCLOSED' ? 'model_enclosed' : row.class === 'ROUTER_MISS' ? 'router_miss' : 'constraints_unknown';
    add(kind, kind === 'router_miss' ? 'One connection is reachable in the diagnostic model; joint routability is unproven'
      : kind === 'model_enclosed' ? 'Diagnostic grid enclosure requires exact/native reconciliation' : 'Diagnostic could not resolve this connection',
    row.blocking_parts ?? [], row.net ? [row.net] : [], { blocking_nets: row.blocking_nets ?? [] });
  }
  if (diagnostics.triage?.not_checked) add('constraints_unknown', 'Some native opens were outside the bounded grid diagnosis', [], [], { not_checked: diagnostics.triage.not_checked });
  for (const row of diagnostics.escape?.boxed_in ?? []) add('escape_failure', 'No escape in the bounded grid model; not proof of physical impossibility', row.ref ? [row.ref] : [], row.net ? [row.net] : [], { pad: row.pad ?? null });
  const unknown = (diagnostics.rules ?? '').split(/\r?\n/).filter(line => /not compiled|not supported|not read|not model/i.test(line));
  if (unknown.length) add('constraints_unknown', 'Routing model did not represent named native rules', [], [], { rules: unknown });
  const opens = report.unconnected_items.map(names), completed = diagnostics.router?.completed_nets ?? [];
  const contradicted = [...new Set(opens.flatMap(row => row.nets.filter(net => completed.includes(net))))].sort();
  if (contradicted.length) add('native_router_disagreement', 'Router claimed these exact nets complete; fresh native connectivity has opens', [], contradicted);
  if (opens.length) add('native_open', 'Native connectivity remains incomplete', opens.flatMap(row => row.refs), opens.flatMap(row => row.nets), { connections: opens.length });
  if (!rows.length) add('no_routing_defect', 'Native report has no error, parity failure or open; no repair justified');
  return rows;
}
