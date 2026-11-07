// Top and bottom images of a board: kicad-cli exports one SVG per side. A white rectangle goes behind the drawing.
// The runner is injected, so a test needs neither KiCad nor Docker. A missing or failed renderer is an error that names it.
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { kiCadPaths } from './env-paths.mjs';
import { VIEWS } from './block-views.ts';

export interface Tools { kicadCli: string }
export type Run = (command: string, args: string[]) => { status: number | null; stderr: string; error?: Error };

const TIMEOUT_MS = 300_000;
const SVG_OPEN = /<svg\b[^>]*>/;
const WHITE = '<rect width="100%" height="100%" fill="white"/>';

const spawn: Run = (command, args) => {
  const result = spawnSync(command, args, { encoding: 'utf8', timeout: TIMEOUT_MS });
  return { status: result.status, stderr: `${result.stderr ?? ''}${result.stdout ?? ''}`, error: result.error };
};

/** KICAD_CLI selects the program. Without it: the KiCad of this machine. */
export function imageTools(env: NodeJS.ProcessEnv = process.env): Tools {
  return { kicadCli: kiCadPaths(process.platform, homedir(), env).kicadCli };
}

function step(run: Run, name: string, command: string, args: string[], output: string): void {
  const result = run(command, args);
  if (result.error) throw new Error(`${name} could not start: ${result.error.message}`);
  if (result.status !== 0) throw new Error(`${name} failed (exit ${String(result.status)}): ${result.stderr.trim().slice(-400)}`);
  if (!existsSync(output) || statSync(output).size === 0) throw new Error(`${name} wrote no file: ${output}`);
}

/** Writes OUT/top.svg and OUT/bottom.svg for the board file `pcb`. The views are the front and back views of block-views.ts. */
export function renderImages(pcb: string, out: string, run: Run = spawn, tools: Tools = imageTools()): void {
  mkdirSync(out, { recursive: true });
  for (const [side, view] of [['top', 'front'], ['bottom', 'back']] as const) {
    const svg = join(out, `${side}.svg`);
    step(run, 'kicad-cli', tools.kicadCli, VIEWS[view]![1](pcb, svg), svg);
    const text = readFileSync(svg, 'utf8'), open = SVG_OPEN.exec(text);
    if (!open) throw new Error(`kicad-cli wrote no svg: ${svg}`);
    const end = open.index + open[0].length;
    writeFileSync(svg, `${text.slice(0, end)}${WHITE}${text.slice(end)}`);
  }
}
