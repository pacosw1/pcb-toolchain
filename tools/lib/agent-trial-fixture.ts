// Test helper: a small lab (a git repository with one board), a toolchain checkout, a prompt and a case file for the agent trial tests.
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { CASE_SCHEMA } from './agent-trial-case.ts';

export const sha = (text: string): string => createHash('sha256').update(text).digest('hex');
const BOARD = 'hardware-design/boards/X';

export function write(root: string, files: Record<string, string>): void {
  for (const [path, text] of Object.entries(files)) { mkdirSync(dirname(join(root, path)), { recursive: true }); writeFileSync(join(root, path), text); }
}

export function git(dir: string, ...args: string[]): string {
  const run = spawnSync('git', ['-C', dir, '-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'commit.gpgsign=false', ...args], { encoding: 'utf8' });
  if (run.status !== 0) throw new Error(`git ${args.join(' ')}: ${run.stderr}`);
  return run.stdout.trim();
}

function repo(dir: string, files: Record<string, string>): string {
  write(dir, files);
  git(dir, 'init', '-q');
  git(dir, 'add', '-A');
  git(dir, 'commit', '-q', '-m', 'fixture');
  return git(dir, 'rev-parse', 'HEAD');
}

export interface Trial {
  base: string; lab: string; toolchain: string; out: string; casePath: string; commit: string; caseValue: Record<string, any>; cleanup(): void;
}

/** A lab with board X (C123 is used, C999 is not, a datasheet is never needed), a toolchain with a stub gate, and a valid case. */
export function trialFixture(extraGate: Record<string, unknown> = {}, extraLab: Record<string, string> = {}): Trial {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'agent-trial-')));
  const lab = join(base, 'lab'), toolchain = join(base, 'toolchain');
  const commit = repo(lab, {
    [`${BOARD}/gate.json`]: JSON.stringify({ project: 'cad/X', checks: { erc: true, drc: true }, ...extraGate }),
    [`${BOARD}/cad/X.kicad_pcb`]: '(kicad_pcb C123)', [`${BOARD}/cad/X.kicad_sch`]: '(kicad_sch C123)',
    [`${BOARD}/cad/X.kicad_pro`]: '{}', [`${BOARD}/cad/X.kicad_dru`]: '(version 1)',
    'hardware-design/registry/boards.json': JSON.stringify({ boards: [{ id: 'X', directory: 'X' }] }),
    'hardware-design/registry/courtyard-bodies.json': '{}',
    'hardware-design/registry/cad-assets/C123/part.txt': 'used', 'hardware-design/registry/cad-assets/C999/part.txt': 'unused',
    'hardware-design/registry/datasheets/big.pdf': 'pdf', 'hardware-design/blocks/iot-lab.pretty/C123.kicad_mod': 'footprint',
    ...extraLab,
  });
  repo(toolchain, {
    'tools/gate.mjs': '// stub gate', 'tools/hooks/claude-cad-guard.mjs': '// stub hook', 'tools/node_modules/dep/index.js': 'skipped',
    'tools/pcb': '#!/bin/sh\n',
  });
  write(base, { 'case/prompt.md': 'Make the board pass the gate.' });
  const caseValue = {
    schema: CASE_SCHEMA, case_id: 'fixture', board: 'X', lab: { commit },
    inputs: [{ path: `${BOARD}/cad/X.kicad_pcb`, sha256: sha('(kicad_pcb C123)') }],
    prompt: { path: 'prompt.md', sha256: sha('Make the board pass the gate.') },
    agent: { argv: ['claude', '-p', '@{prompt_file}', '--add-dir', '{root}'], parser: 'claude-stream-json' },
    budget: { timeout_s: 60, max_turns: 5 }, design_contract_exempt: false,
  };
  const casePath = join(base, 'case/case.json');
  writeFileSync(casePath, JSON.stringify(caseValue));
  return { base, lab, toolchain, out: join(base, 'out'), casePath, commit, caseValue, cleanup: () => rmSync(base, { recursive: true, force: true }) };
}

export const rewriteCase = (trial: Trial, change: (value: Record<string, any>) => void): void => {
  const value = JSON.parse(JSON.stringify(trial.caseValue)) as Record<string, any>;
  change(value);
  writeFileSync(trial.casePath, JSON.stringify(value));
};
