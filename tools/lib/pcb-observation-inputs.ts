// Reviewed observation boundaries. Reading a legacy Python source never imports or executes it.
import { existsSync, lstatSync, readdirSync, realpathSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { delimiter, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { sha256Text } from './fingerprint.ts';
import { sha256File } from './json-file.ts';
import { resolvePath, which } from './py-path.ts';

export const SCHEMA = 'iot-lab.observation-input-policy.v1';
export const COMMON = ['pcb_cli.py', 'pcb_operations.py', 'pcb_evidence.py', 'pcb_workflow.py',
  'pcb_timing.py', 'lean_workflow.py', 'lean_owned.py', 'lean_owned_exec.py', 'project_root.py'] as const;
const PARTS_ACTIONS = new Set(['inspect', 'selection', 'verify', 'status']);

// The certificate is deliberately unchanged during the port. Any producer edit falls back to the broad boundary.
const AUDITED: Record<string, string> = {
  'part_evidence.py': '1eb4560fb473c5e7313386ca97038b24f2dc71c563cf1e9956751cb1e96a9b08',
  'part_native.py': '9a21ded435da26ccedcb6da845bd9c7cc87b959d5d0a848d325e177b4a400287',
  'project_root.py': '698f463b76abaed6dcd1cc915b1c02373708244fd95372330c5bf10186325171',
  'pcb_cli.py': '382f8a12d952b0b9f2a87571ebebc8a445ab41a87f182f56e6ceebe2f3a17ecf',
  'pcb_operations.py': 'c9176dddcdf421d3d404a2ae246d93eaa3a88d6b663fbc9cd314c5b7d0470c7a',
  'pcb_evidence.py': '9d929244915407bddefd096f8a981113652e2706ea8785cf5ddb70061330687f',
  'pcb_workflow.py': '08ec41de3f9da4a8c45ecd8f9b2f007bb5a78703b7b36ecb942ab45fde982f93',
  'pcb_timing.py': '07ed104072e56166625ffc36e774892c3761832cf00fe72b6abef2d967f05ddd',
  'lean_workflow.py': '926caceb8697718d86e279e114a7c9a57b5f78f20afa635109460601c27f1bb8',
  'lean_owned.py': '6b975cc6fbbc75e2a0f0e0dbe4b73ce11032e0f2087ce39e881281e53428664e',
  'lean_owned_exec.py': 'dbee0c764a174ea3bae49f429d836d50b0d632bf828f20469a785d8268bc83ba',
  'lib/kicad-population.mjs': '0aebb28a1409de93200b081dc2226dede1225db367f72abdb156822e2de95040',
  'run_record.py': '015c92d8eb27ae21b98cc19e9ad9e7d48d83127618c31091978aff42c81031a6',
};

// Exact imports of the hash-certified sources on the parts path, including dormant imports and imported attributes.
// A manifest avoids keeping a second Python parser and the Python 3.9 stdlib-discovery workaround alive.
const IMPORTS: Record<string, string[]> = {
  'part_evidence.py': ['argparse', 'contextlib', 'copy', 'datetime', 'fcntl', 'hashlib', 'json', 'math', 'os', 'pathlib',
    're', 'shutil', 'subprocess', 'sys', 'tempfile', 'part_native', 'project_root', 'pcb_workflow', 'pcb_workflow.registry_revision'],
  'part_native.py': ['hashlib', 'json', 'math', 'os', 'pathlib', 're', 'shutil', 'subprocess', 'decimal'],
  'project_root.py': ['os', 'pathlib'],
  'pcb_workflow.py': ['hashlib', 'json', 'os', 'pathlib', 're', 'sys'],
  'run_record.py': ['datetime', 'json', 'os', 're', 'sys', 'time', 'argparse'],
};
const COMMON_STDLIB = ['argparse', 'array', 'base64', 'contextlib', 'ctypes', 'datetime', 'decimal', 'fcntl',
  'hashlib', 'json', 'locale', 'math', 'os', 'pathlib', 're', 'resource', 'selectors', 'shutil', 'signal', 'socket',
  'stat', 'struct', 'subprocess', 'sys', 'tempfile', 'threading', 'time', 'uuid'];
const ALLOWED_PYTHON = new Set(['PYTHON_MODERN', 'PYTHONPATH', 'PYTHONDONTWRITEBYTECODE', 'PYTHONUNBUFFERED',
  'PYTHONHASHSEED', 'PYTHONUTF8', 'PYTHONIOENCODING', 'PYTHONNOUSERSITE', 'PYTHONSAFEPATH']);
const EXCLUDED = new Set(['__pycache__', 'node_modules', '.git', '.gate']);
export interface ObservationPolicy {
  schema: typeof SCHEMA;
  mode: 'audited_parts' | 'conservative';
  entry: string;
  reason: string;
  context: {
    root: string; operation: string; action: string | null;
    python: { requested: string; resolved: string | null };
    environment: Record<string, string>; selected_tools: Record<string, string | null>; module_layout_sha256: string;
  };
}
export interface ObservationInputs { files: Record<string, string>; absent: string[]; policy: ObservationPolicy }

const symbolic = (path: string): boolean => lstatSync(path, { throwIfNoEntry: false })?.isSymbolicLink() ?? false;
const file = (path: string): boolean => statSync(path, { throwIfNoEntry: false })?.isFile() ?? false;
const sortedRecord = <T>(value: Record<string, T>): Record<string, T> => Object.fromEntries(Object.entries(value).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0));

export function launcher(command: string): string | null {
  const found = command ? which(command) : null;
  return found ? resolvePath(found) : null;
}

function environment(): Record<string, string> {
  return sortedRecord(Object.fromEntries(Object.entries(process.env).filter(([key, value]) => value !== undefined &&
    (['PATH', 'HOME', 'VIRTUAL_ENV', 'CONDA_PREFIX', 'PDFINFO', 'PDFTOTEXT', 'PDFTOPPM', 'NODE_OPTIONS', 'NODE_PATH'].includes(key)
      || /^(PYTHON|LD_|DYLD_)/.test(key))) as [string, string][]));
}

function selectedTools(): Record<string, string | null> {
  const selected: Record<string, string | null> = { node: launcher('node') };
  for (const name of ['pdfinfo', 'pdftotext', 'pdftoppm']) {
    const bundled = join(homedir(), '.cache/codex-runtimes/codex-primary-runtime/dependencies/native/poppler/poppler/bin', name);
    const candidate = process.env[name.toUpperCase()] || (file(bundled) ? bundled : launcher(name));
    selected[name] = candidate ? resolvePath(candidate) : null;
  }
  return selected;
}

function walk(directory: string, recursive = true): string[] {
  if (!existsSync(directory)) return [];
  return readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name < b.name ? -1 : 1).flatMap(entry => {
    const path = join(directory, entry.name);
    return entry.isDirectory() ? recursive && !EXCLUDED.has(entry.name) ? walk(path) : [] : [path];
  });
}

function moduleLayout(root: string): string {
  const tools = join(root, 'tools');
  const names = walk(tools).filter(path => !path.slice(path.lastIndexOf('/') + 1).startsWith('test_') && /\.(py|so|pyd|pyc)$/.test(path));
  return sha256Text(names.map(path => path.slice(tools.length + 1)).sort().join('\n'));
}

/** Files and lexical absences are checked separately by the receipt consumer. */
export function current(value: unknown): boolean {
  try {
    const policy = value as ObservationPolicy;
    if (policy?.schema !== SCHEMA || !['audited_parts', 'conservative'].includes(policy.mode)) return false;
    const context = policy.context;
    return typeof context.root === 'string' && statSync(context.root).isDirectory()
      && JSON.stringify(sortedRecord(context.environment)) === JSON.stringify(environment())
      && JSON.stringify(sortedRecord(context.selected_tools)) === JSON.stringify(sortedRecord(selectedTools()))
      && context.module_layout_sha256 === moduleLayout(context.root)
      && typeof context.python.requested === 'string' && context.python.resolved !== null
      && launcher(context.python.requested) === context.python.resolved;
  } catch { return false; }
}

export function collect(rootPath: string, operation: string, args: readonly string[], pythonCommand: string): ObservationInputs {
  const root = realpathSync(rootPath), tools = join(root, 'tools'), action = args[0] ?? null;
  const resolved = launcher(pythonCommand);
  const policy: ObservationPolicy = { schema: SCHEMA, mode: 'conservative', entry: operation === 'parts' ? 'part_evidence.py' : operation,
    reason: 'operation/action has no audited narrow boundary', context: { root, operation, action,
      python: { requested: pythonCommand, resolved }, environment: environment(), selected_tools: selectedTools(), module_layout_sha256: moduleLayout(root) } };
  const files: Record<string, string> = {}, absent = new Set<string>();
  const bind = (path: string): void => { path = resolve(path); if (file(path)) files[path] = sha256File(path); else absent.add(path); };
  // Bind both implementations while Python receipts and importers still exist.
  bind(join(tools, 'pcb_observation_inputs.py'));
  bind(fileURLToPath(import.meta.url));
  if (resolved) bind(resolved);
  const rejectCompiled = (base: string): void => {
    const candidates = new Set<string>();
    for (const stem of [base, join(base, '__init__')]) {
      for (const suffix of ['.pyc', '.so', '.pyd']) candidates.add(stem + suffix);
      const parent = dirname(stem), name = stem.slice(parent.length + 1);
      if (statSync(parent, { throwIfNoEntry: false })?.isDirectory()) {
        for (const entry of readdirSync(parent)) if (entry.startsWith(name + '.') && /\.(so|pyd)$/.test(entry)) candidates.add(join(parent, entry));
      }
    }
    let found: string | undefined;
    for (const path of [...candidates].sort()) { bind(path); if (existsSync(path) || symbolic(path)) found ??= path; }
    if (found) throw new Error('compiled or sourceless local import: ' + found);
  };
  const module = (name: string): void => {
    const parts = name.split('.');
    for (let count = 1; count <= parts.length; count++) {
      const base = join(tools, ...parts.slice(0, count));
      rejectCompiled(base);
      for (const path of [base + '.py', join(base, '__init__.py')]) {
        if (symbolic(path)) throw new Error('symlinked local Python dependency: ' + path);
        bind(path);
        if (file(path)) {
          const local = path.slice(tools.length + 1);
          if (files[path] !== AUDITED[local] || !(local in IMPORTS)) throw new Error('unreviewed local Python module: ' + path);
          if (!visited.has(local)) { visited.add(local); IMPORTS[local].forEach(module); }
        }
      }
    }
  };
  const visited = new Set<string>();
  if (operation === 'parts' && action !== null && PARTS_ACTIONS.has(action)) {
    try {
      if (!resolved) throw new Error('Python launcher is unavailable');
      if (process.env.NODE_OPTIONS || process.env.NODE_PATH) throw new Error('unreviewed Node startup override');
      if (Object.entries(process.env).some(([name, value]) => name.startsWith('PYTHON') && value && !ALLOWED_PYTHON.has(name))) throw new Error('unreviewed Python startup override');
      for (const [name, expected] of Object.entries(AUDITED)) {
        const path = join(tools, name); bind(path);
        if (symbolic(path) || !file(path) || files[path] !== expected) throw new Error('audited producer changed: ' + name);
      }
      for (const name of COMMON_STDLIB) {
        rejectCompiled(join(tools, name));
        for (const path of [join(tools, name + '.py'), join(tools, name, '__init__.py')]) {
          bind(path); if (existsSync(path) || symbolic(path)) throw new Error('local shadow of common stdlib import: ' + name);
        }
      }
      module('part_evidence'); module('run_record');
      for (const name of ['sitecustomize.py', 'usercustomize.py']) {
        const path = join(tools, name); if (existsSync(path) || symbolic(path)) throw new Error('local Python startup customization'); absent.add(path);
      }
      if ((process.env.PYTHONPATH ?? '').split(delimiter).some(value => value && resolve(root, value) !== tools)) throw new Error('external PYTHONPATH requires conservative boundary');
      policy.mode = 'audited_parts'; policy.reason = 'exact audited producers plus static local import closure';
    } catch (error) { policy.reason = error instanceof Error ? error.message : String(error); }
  }
  if (policy.mode === 'conservative') {
    for (const path of walk(tools)) {
      const name = path.slice(tools.length + 1);
      if ((/^[^/]+\.(py|ts)$/.test(name) || /^lib\/[^/]+\.(mjs|ts)$/.test(name)
        || /^(placer|pcb_search)\/[^/]+\.py$/.test(name) || /^pcb_engine\/.*\.py$/.test(name)
        || /^pcb_engine\/native\/[^/]+\.(mm|hpp|metal)$/.test(name)) && file(path)) bind(path);
    }
  }
  for (const name of Object.keys(files)) absent.delete(name);
  return { files: sortedRecord(files), absent: [...absent].sort(), policy };
}
