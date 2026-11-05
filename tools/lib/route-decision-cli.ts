// Standalone repair snapshot: use the existing gate dependency resolver, then materialize exact file copies.
import { spawnSync } from 'node:child_process';
import { chmodSync, copyFileSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { basename, dirname, extname, join, relative } from 'node:path';
import { sha256File } from './json-file.ts';
import { inside, nativeInputs, same } from './route-decision-evidence.ts';
import { resolvePath, withSuffix } from './py-path.ts';
import { forms } from './sexpr.ts';
import type { SList } from './sexpr.ts';
const IGNORED = new Set(['.git', '.gate', '.claude', '.bench', '__pycache__', 'node_modules', 'fab', 'render', 'renders', 'reports', 'target']);
const BINARY = new Set(['.pyc', '.step', '.stp', '.wrl', '.mp4', '.gif']);
export function repairSnapshot(root: string, workspace: string, board: string): void {
  root = resolvePath(root); workspace = resolvePath(workspace);
  if (existsSync(workspace)) throw new Error('candidate workspace must be new');
  const { cfg, native } = nativeInputs(root, board), owner = relative(join(root, 'hardware-design/boards'), native).split('/')[0]!;
  const files = new Set<string>();
  function collect(dir: string): void {
    if (!existsSync(dir)) return;
    for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0)) {
      const path = join(dir, entry.name);
      if (IGNORED.has(entry.name) || entry.name.endsWith('.3dshapes') || entry.name.startsWith('.pcb-adopt-')) continue;
      if (dir === join(root, 'hardware-design/registry') && ['evidence', 'datasheets'].includes(entry.name)) continue;
      const stat = statSync(path);
      if (stat.isDirectory()) { if (lstatSync(path).isSymbolicLink()) throw new Error('directory symlinks need an explicit snapshot dependency: ' + path); collect(path); }
      else if (stat.isFile() && !BINARY.has(extname(path))) files.add(path);
    }
  }
  for (const dir of ['tools', `hardware-design/boards/${owner}`, 'hardware-design/blocks', 'hardware-design/registry']) collect(join(root, dir));
  const probe = spawnSync(process.execPath, [join(root, 'tools/pcb_snapshot_inputs.mjs'), root, board], { encoding: 'utf8', timeout: 20_000 });
  if (probe.error || probe.status !== 0) throw new Error('cannot resolve snapshot dependencies: ' + (probe.error?.message ?? probe.stderr.trim()));
  const dependencies: unknown = JSON.parse(probe.stdout);
  if (!Array.isArray(dependencies) || dependencies.some(p => typeof p !== 'string')) throw new Error('invalid snapshot dependency list');
  for (const name of dependencies as string[]) { const file = resolvePath(name); if (inside(file, root) && statSync(file, { throwIfNoEntry: false })?.isFile()) files.add(file); }
  for (const name of readdirSync(join(root, 'hardware-design'))) { const file = join(root, 'hardware-design', name); if (statSync(file).isFile()) files.add(file); }
  if (cfg.snapshot_schematic_datasheets) {
    const rootForm = forms(readFileSync(withSuffix(native, '.kicad_sch'), 'utf8'))[0] as SList;
    for (const symbol of rootForm) if (Array.isArray(symbol) && symbol[0] === 'symbol') {
      for (const field of symbol) if (Array.isArray(field) && field[0] === 'property' && field[1] === 'Datasheet' && typeof field[2] === 'string' && field[2]) {
        const pdf = join(root, 'hardware-design/registry/datasheets', basename(field[2])); if (statSync(pdf, { throwIfNoEntry: false })?.isFile()) files.add(pdf);
      }
    }
  }
  for (const name of ['FOCUS.md', 'AGENTS.md', 'CLAUDE.md']) if (existsSync(join(root, name))) files.add(join(root, name));
  const before = Object.fromEntries([...files].sort().map(file => [file, sha256File(file)]));
  mkdirSync(workspace, { recursive: true });
  for (const [file, hash] of Object.entries(before)) {
    const dest = join(workspace, relative(root, file)); mkdirSync(dirname(dest), { recursive: true });
    copyFileSync(file, dest); chmodSync(dest, statSync(file).mode);
    if (sha256File(dest) !== hash) throw new Error('source changed while creating candidate workspace');
  }
  if (!same(before, Object.fromEntries(Object.keys(before).map(file => [file, sha256File(file)])))) throw new Error('source changed while creating candidate workspace');
}
