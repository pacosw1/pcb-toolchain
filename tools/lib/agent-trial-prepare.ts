// `pcb trial prepare`: build the scratch project of an agent trial from a frozen lab commit, the way tools/bench-local.md does by hand.
// Reads the lab only through git (ls-tree, archive). The lab path is a parameter; no fixed path exists.
import { spawnSync } from 'node:child_process';
import { copyFileSync, cpSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, readlinkSync, rmSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, relative, resolve, sep } from 'node:path';
import { readCase } from './agent-trial-case.ts';
import { isCanonicalRoot, reseal, sealStatus } from './cad-seal.ts';
import { designExemption } from './design-exemption.ts';
import { gateInputs } from './gate-inputs.mjs';
import { atomicJson, sha256File } from './json-file.ts';

export const PREPARE_SCHEMA = 'iot-lab.agent-trial-prepare.v1';
export const EXEMPT_REASON = 'agent trial baseline';
const BOARDS = 'hardware-design/boards';
const REGISTRY = 'hardware-design/registry/boards.json';
/** Beside the board: what a gate reads in every board, and small. The big registry folders (datasheets, evidence, cad-assets) come only as the gate inputs name them. */
const SHARED = ['hardware-design/registry/components.json', 'hardware-design/registry/courtyard-bodies.json', 'hardware-design/registry/ibis',
  'hardware-design/registry/part-reviews', 'hardware-design/registry/reviews', 'hardware-design/registry/design-contracts', 'hardware-design/blocks', REGISTRY];
const PASSES = 4;
const CHUNK = 300;

export interface PrepareOptions { casePath: string; lab: string; out: string; toolchain: string; bin?: string }
type Files = Record<string, string>;

function run(command: string, args: string[], input?: Buffer): Buffer {
  const result = spawnSync(command, args, { input, maxBuffer: 2 ** 30 });
  if (result.error || result.status !== 0) throw new Error(`${command} ${args.slice(0, 4).join(' ')} failed: ${result.error?.message ?? result.stderr.toString().trim()}`);
  return result.stdout;
}
const git = (dir: string, ...args: string[]): string => run('git', ['-C', dir, ...args]).toString('utf8').trim();

/** The sha256 of every file below DIR/SUB (a symlink by its target), keyed by path relative to DIR. Hidden and generated folders are walked too. */
export function hashTree(root: string, sub: string): Files {
  const out: Files = {};
  const walk = (folder: string): void => {
    for (const entry of readdirSync(folder, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1))) {
      const path = join(folder, entry.name), key = relative(root, path).split(sep).join('/');
      if (lstatSync(path).isSymbolicLink()) out[key] = `link:${readlinkSync(path)}`;
      else if (entry.isDirectory()) walk(path);
      else out[key] = sha256File(path);
    }
  };
  if (existsSync(join(root, sub))) walk(join(root, sub));
  return out;
}

interface Lab { has(path: string): boolean; extract(paths: string[], project: string): void }

/** The tracked files of the lab commit. extract() archives the listed paths that exist there; the others are skipped. */
function openLab(dir: string, commit: string): Lab {
  const files = new Set(git(dir, 'ls-tree', '-r', '--name-only', '-z', commit).split('\0').filter(Boolean)), folders = new Set<string>();
  for (const file of files) for (let at = file.lastIndexOf('/'); at > 0; at = file.lastIndexOf('/', at - 1)) folders.add(file.slice(0, at));
  const has = (path: string): boolean => files.has(path) || folders.has(path);
  return {
    has,
    extract(paths, project) {
      const wanted = [...new Set(paths)].filter(has);
      for (let at = 0; at < wanted.length; at += CHUNK) run('tar', ['-x', '-C', project], run('git', ['-C', dir, 'archive', '--format=tar', commit, '--', ...wanted.slice(at, at + CHUNK)]));
    },
  };
}

/** The exemption row of the board in the scratch registry. The lab is never touched. */
function exempt(project: string, board: string): void {
  const path = join(project, REGISTRY);
  if (!existsSync(path)) throw new Error(`design_contract_exempt needs ${REGISTRY} in the lab commit`);
  const file = JSON.parse(readFileSync(path, 'utf8')) as { boards: Record<string, any>[] };
  const row = file.boards.find(entry => entry.id === board) ?? file.boards.find(entry => Array.isArray(entry.revisions) && entry.revisions.some((revision: any) => revision?.gate === board));
  if (!row) throw new Error(`${REGISTRY} has no row for ${board}`);
  row.design_contract_exempt = { reason: EXEMPT_REASON };
  writeFileSync(path, JSON.stringify(file, null, 1) + '\n');
  if (designExemption(project, board) !== EXEMPT_REASON) throw new Error(`could not record the exemption of ${board}`);
}

/** Archive what the gate of BOARD names in the lab, until nothing new is named. Returns the gate inputs that the project still lacks. */
function gateFiles(lab: Lab, project: string, board: string): string[] {
  const inLab = (path: string): string => relative(project, path).split(sep).join('/');
  const missing = (list: string[]): string[] => list.filter(path => !existsSync(path));
  let last = '';
  for (let pass = 0; pass < PASSES; pass++) {
    const list: string[] = gateInputs(project, board).files, state = `${list.length}:${missing(list).length}`;
    if (state === last) break;
    last = state;
    const codes = new Set<string>();
    for (const path of list) if (existsSync(path) && /\.kicad_(sch|pcb|pro|dru|mod|sym)$|-lib-table$/.test(path)) for (const code of readFileSync(path, 'utf8').match(/\bC\d+\b/g) ?? []) codes.add(code);
    const parts = [...codes].flatMap(code => [`hardware-design/registry/cad-assets/${code}`, `hardware-design/blocks/iot-lab.pretty/${code}.kicad_mod`]);
    lab.extract([...parts, ...missing(list).map(inLab).filter(path => !path.startsWith('..'))], project);
  }
  return missing(gateInputs(project, board).files).map(inLab);
}

function copyToolchain(toolchain: string, project: string, bin: string | undefined): string {
  cpSync(join(toolchain, 'tools'), join(project, 'tools'), { recursive: true, filter: source => !['node_modules', 'target'].includes(basename(source)) });
  if (bin) {
    mkdirSync(join(project, 'bin'), { recursive: true });
    const names = readdirSync(bin).filter(name => /^(iotroute|iotplace)-/.test(name));
    if (!names.length) throw new Error(`${bin} holds no iotroute or iotplace binary`);
    for (const name of names) copyFileSync(join(bin, name), join(project, 'bin', name));
  }
  return git(toolchain, 'rev-parse', 'HEAD');
}

const logLines = (project: string, board: string): number => readFileSync(join(project, '.gate/cad-seal', `${board}.jsonl`), 'utf8').split('\n').filter(Boolean).length;

export function prepareTrial(options: PrepareOptions): Record<string, any> {
  const { case: agentCase, sha256: caseSha } = readCase(options.casePath);
  const out = resolve(options.out), project = join(out, 'project'), lab = resolve(options.lab);
  if (!isCanonicalRoot(out)) throw new Error(`${out} has a .gate/ segment; a sealed project cannot live there`);
  if (existsSync(join(out, 'prepare.json'))) throw new Error(`${out} is already prepared; use a new --out`);
  if (existsSync(project) && readdirSync(project).length) throw new Error(`${project} is not empty; use a new --out`);
  let commit: string;
  try { commit = git(lab, 'rev-parse', '--verify', `${agentCase.lab.commit}^{commit}`); } catch { throw new Error(`commit ${agentCase.lab.commit} is not in the lab ${lab}`); }
  const source = openLab(lab, commit), board = agentCase.board;
  if (!source.has(`${BOARDS}/${board}/gate.json`)) throw new Error(`board ${board} has no gate.json in lab commit ${commit}`);
  const promptPath = resolve(dirname(options.casePath), agentCase.prompt.path);
  if (!existsSync(promptPath) || sha256File(promptPath) !== agentCase.prompt.sha256) throw new Error(`prompt ${agentCase.prompt.path} is missing or differs from its pinned SHA-256`);
  try {
    mkdirSync(project, { recursive: true });
    source.extract([`${BOARDS}/${board}`, ...SHARED, ...agentCase.inputs.map(input => input.path)], project);
    for (const input of agentCase.inputs) {
      if (!existsSync(join(project, input.path)) || sha256File(join(project, input.path)) !== input.sha256) throw new Error(`input ${input.path} differs from its pinned SHA-256 at lab commit ${commit}`);
    }
    const toolchainSha = copyToolchain(resolve(options.toolchain), project, options.bin && resolve(options.bin));
    const dirty = git(resolve(options.toolchain), 'status', '--porcelain', '--', 'tools') !== '';
    mkdirSync(join(project, '.claude'), { recursive: true });
    atomicJson(join(project, '.claude/settings.json'), { hooks: { PreToolUse: [{ matcher: 'Edit|Write|MultiEdit|NotebookEdit|Bash', hooks: [{ type: 'command', command: 'node tools/hooks/claude-cad-guard.mjs' }] }] } });
    const missingGateInputs = gateFiles(source, project, board);
    if (agentCase.design_contract_exempt) exempt(project, board);
    const labSeal = sealStatus(project, board).state;
    reseal(project, board, { tool: 'trial-prepare', run_id: null }, 'trial baseline');
    const files = hashTree(project, 'hardware-design');
    copyFileSync(options.casePath, join(out, 'case.json'));
    copyFileSync(promptPath, join(out, 'prompt.txt'));
    const record = {
      schema: PREPARE_SCHEMA, case_id: agentCase.case_id, board, case_sha256: caseSha, lab_commit: commit, toolchain: { git_sha: toolchainSha, tools_dirty: dirty },
      prompt: agentCase.prompt, inputs: agentCase.inputs, lab_seal: labSeal, seal_baseline_lines: logLines(project, board),
      design_contract_exempt_applied: agentCase.design_contract_exempt, missing_gate_inputs: missingGateInputs, files,
    };
    atomicJson(join(out, 'prepare.json'), record);
    return record;
  } catch (error) {
    // A half-built project would pass for a prepared one on the next try.
    for (const name of ['project', 'case.json', 'prompt.txt']) rmSync(join(out, name), { recursive: true, force: true });
    throw error;
  }
}
