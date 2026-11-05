// rf_lines: RF trace rule gate (grounded coplanar waveguide), first used on CELLULAR (2026-10-09, D-120).
//
//   tools/rf_lines.ts BOARD.kicad_pcb SPEC.json [--verbose]
//
// SPEC (hardware-design/boards/<board>/rf-lines.json):
//   {"nets": ["/RF_MOD", "/RF_ANT"], "layer": "F.Cu", "ref_layer": "In1.Cu", "ground": "GND",
//    "width_mm": 0.38, "gap_mm": 0.20, "h_mm": 0.2104, "er": 4.4, "z_target": 50, "z_tol": 5,
//    "width_tol_mm": 0.005, "gap_tol_mm": 0.03, "max_length_mm": 15, "fence_pitch_max_mm": 2.0, "fence_offset_max_mm": 1.0}
// Checks (each one PASS or FAIL):
//   1. Z of the spec width/gap (conductor-backed CPW, quasi-static, Wadell / Ghione-Naldi with exact elliptic integrals)
//      within z_target +- z_tol.
//   2. Every track of the nets is on `layer` with width_mm +- width_tol_mm.
//   3. No via on the nets.
//   4. Gap: at each sample (0.25 mm step, not within 0.8 mm of a pad of a part that has a pad on the nets) the points at
//      W/2 + gap - tol on both sides touch no copper of another net on `layer`, and the points at W/2 + gap + tol + 0.05 are in
//      `ground` copper (the coplanar ground is there).
//   5. Reference: the sample is inside the filled `ground` zone on `ref_layer`.
//   6. Length of all tracks of the nets <= max_length_mm (per line when the SPEC has "lines": [{"name", "nets"}]).
//   7. Fence: at each sample, a `ground` via on each side within fence_offset_max_mm of the track edge and within
//      fence_pitch_max_mm / 2 along the track.
// The zones of a copy are refilled; the board is not changed. Prints "rf_lines: N PASS, M FAIL" (gate.mjs reads it).
import { boardJson } from './lib/board-json.ts';
import { parseFlags, runMain, UsageError } from './lib/cli.ts';
import { jsonLoad } from './lib/py-compat.mjs';
import { readRfSpec, rfChecks } from './lib/rf-lines.ts';

const USAGE = 'usage: tools/rf_lines.ts BOARD.kicad_pcb SPEC.json [--verbose]';

function main(argv: string[]): number {
  const { values, positionals } = parseFlags(argv, { verbose: { type: 'boolean' } }, USAGE);
  const [pcb, specFile] = positionals;
  if (pcb === undefined || specFile === undefined || positionals.length !== 2) throw new UsageError(USAGE);
  const spec = readRfSpec(jsonLoad(specFile));
  const { board } = boardJson(pcb, { refill: true });
  let passed = 0;
  let failed = 0;
  for (const { ok, message } of rfChecks(board, spec, values.verbose)) {
    if (ok) passed += 1; else failed += 1;
    console.log(`${ok ? 'PASS' : 'FAIL'} ${message}`);
  }
  console.log(`rf_lines: ${passed} PASS, ${failed} FAIL`);
  return failed ? 1 : 0;
}

runMain(import.meta.url, main);
