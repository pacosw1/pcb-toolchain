// Bare-board connectivity from the exact Gerber ZIP and plated drills shipped to the fabricator.
// Setup: npm ci --prefix tools/gerber-netcheck
// Run: node --experimental-strip-types tools/gerber_netcheck.ts BOARD [--root PROJECT]
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { parseArgs } from 'node:util';
import { boardJson } from './lib/board-json.ts';
import { runMain } from './lib/cli.ts';
import { kicadCli } from './lib/env.mjs';
import { projectRoot } from './lib/project-root.mjs';
import { checkInput, reportLines } from './gerber-netcheck/check.ts';
import { checkConnectivity } from './gerber-netcheck/native.ts';

export async function main(args: string[]): Promise<number> {
  try {
    const { positionals, values } = parseArgs({ args, allowPositionals: true, options: { root: { type: 'string' } } });
    if (positionals.length !== 1) throw new Error('usage: tools/gerber_netcheck.ts BOARD [--root PROJECT]');
    const board = positionals[0];
    const boardDir = join(projectRoot(values.root), 'hardware-design/boards', board);
    const gate = JSON.parse(readFileSync(join(boardDir, 'gate.json'), 'utf8')) as { project: string };
    if (typeof gate.project !== 'string' || !gate.project) throw new Error('gate.json has no project');
    const stem = join(boardDir, gate.project);
    const name = basename(stem);
    const archive = readFileSync(process.env.GNC_ZIP || join(boardDir, 'cad/fab', `${name}-gerber.zip`));
    const work = mkdtempSync(join(tmpdir(), 'gerber-netcheck-'));
    try {
      const netlist = join(work, 'net.xml');
      const exportNetlist = spawnSync(kicadCli, ['sch', 'export', 'netlist', '--format', 'kicadxml', '-o', netlist, `${stem}.kicad_sch`], { encoding: 'utf8' });
      if (exportNetlist.error || exportNetlist.status !== 0) throw new Error(`schematic netlist export failed: ${exportNetlist.error?.message ?? exportNetlist.stderr}`);
      const input = await checkInput(archive, name, boardJson(`${stem}.kicad_pcb`), readFileSync(netlist, 'utf8'));
      const report = checkConnectivity(input);
      reportLines(board, report).forEach(line => console.log(line));
      const passed = !Object.keys(report.opens).length && !report.shorts.length && !report.missing.length;
      console.log(`${passed ? 'PASS' : 'FAIL'} gerber_netcheck ${board}: fabrication connectivity`);
      return passed ? 0 : 1;
    } finally { rmSync(work, { recursive: true, force: true }); }
  } catch (error) {
    console.error(`FAIL gerber_netcheck: ${error instanceof Error ? error.message : String(error)}`);
    return 2;
  }
}

runMain(import.meta.url, main);
