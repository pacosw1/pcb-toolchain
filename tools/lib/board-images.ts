// Top and bottom images of a board: kicad-cli exports an SVG per side, rsvg-convert makes a PNG with a white background.
// The runner is injected, so a test needs neither KiCad nor Docker. A missing or failed renderer is an error that names it.
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, statSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { kiCadPaths } from './env-paths.mjs';
import { VIEWS } from './block-views.ts';
import { which } from './py-path.ts';

export interface Tools { kicadCli: string; rsvg: string }
export type Run = (command: string, args: string[]) => { status: number | null; stderr: string; error?: Error };

const WIDTH = '1800';
const TIMEOUT_MS = 300_000;

const spawn: Run = (command, args) => {
  const result = spawnSync(command, args, { encoding: 'utf8', timeout: TIMEOUT_MS });
  return { status: result.status, stderr: `${result.stderr ?? ''}${result.stdout ?? ''}`, error: result.error };
};

/** KICAD_CLI and RSVG_CONVERT select the programs. Without them: the KiCad of this machine and rsvg-convert on the PATH. */
export function imageTools(env: NodeJS.ProcessEnv = process.env): Tools {
  return { kicadCli: kiCadPaths(process.platform, homedir(), env).kicadCli, rsvg: env.RSVG_CONVERT ?? which('rsvg-convert') ?? 'rsvg-convert' };
}

function step(run: Run, name: string, command: string, args: string[], output: string): void {
  const result = run(command, args);
  if (result.error) throw new Error(`${name} could not start: ${result.error.message}`);
  if (result.status !== 0) throw new Error(`${name} failed (exit ${String(result.status)}): ${result.stderr.trim().slice(-400)}`);
  if (!existsSync(output) || statSync(output).size === 0) throw new Error(`${name} wrote no file: ${output}`);
}

/** Writes OUT/top.png and OUT/bottom.png for the board file `pcb`. The views are the front and back views of block-views.ts. */
export function renderImages(pcb: string, out: string, run: Run = spawn, tools: Tools = imageTools()): void {
  mkdirSync(out, { recursive: true });
  const scratch = mkdtempSync(join(tmpdir(), 'board-images-'));
  try {
    for (const [side, view] of [['top', 'front'], ['bottom', 'back']] as const) {
      const svg = join(scratch, `${side}.svg`), png = join(out, `${side}.png`);
      step(run, 'kicad-cli', tools.kicadCli, VIEWS[view]![1](pcb, svg), svg);
      step(run, 'rsvg-convert', tools.rsvg, ['-b', 'white', '-w', WIDTH, '-o', png, svg], png);
    }
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}
