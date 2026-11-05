// The xy box of a STEP model, measured by KiCad: a one-footprint board goes through `kicad-cli pcb export stl`, which reads the
// model with OpenCascade and places assemblies as KiCad does. The box is the box of the mesh, so a curved face can fall short
// of the exact body by the chord error of the mesh.
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { quoted } from './board-edit.ts';
import { pointsBox, type Box } from './courtyard.ts';
import { kicadCli } from './env.mjs';

const VERTEX = /^\s*vertex\s+(\S+)\s+(\S+)\s+\S+\s*$/gm;
const STEP_FILE = /\.(?:step|stp)$/i;

const probeBoard = (model: string): string => `(kicad_pcb (version 20241229) (generator "pcb-toolchain") (generator_version "10.0")
 (general (thickness 1.6))
 (paper "A4")
 (layers (0 "F.Cu" signal) (2 "B.Cu" signal) (25 "Edge.Cuts" user))
 (setup (pad_to_mask_clearance 0))
 (net 0 "")
 (footprint "probe:probe" (layer "F.Cu") (at 100 100)
  (attr smd)
  (model ${quoted(model)} (offset (xyz 0 0 0)) (scale (xyz 1 1 1)) (rotate (xyz 0 0 0))))
 (gr_rect (start 90 90) (end 110 110) (stroke (width 0.05) (type default)) (fill no) (layer "Edge.Cuts"))
)
`;

/** The box of the vertices of an ASCII STL, as OpenCascade writes it. */
export const stlBox = (text: string): Box | null =>
  pointsBox([...text.matchAll(VERTEX)].map(vertex => [Number(vertex[1]), Number(vertex[2])] as const));

function measure(file: string): Box {
  const work = mkdtempSync(join(tmpdir(), 'step-box-'));
  try {
    const board = join(work, 'probe.kicad_pcb');
    const mesh = join(work, 'probe.stl');
    writeFileSync(board, probeBoard(file));
    const run = spawnSync(kicadCli, ['pcb', 'export', 'stl', '--no-board-body', '--user-origin', '100x100mm', '--force', '--output', mesh, board], { encoding: 'utf8' });
    const box = existsSync(mesh) ? stlBox(readFileSync(mesh, 'utf8')) : null;
    if (!box) throw new Error(`${file}: STEP read failed (kicad-cli exit ${run.status}): ${run.stderr}`);
    return box;
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

const stem = (path: string): string => path.replace(/\.[^./]*$/, '');

/** The files that can hold the body of this model path, best first. */
export const stepCandidates = (path: string): string[] => [...new Set([`${stem(path)}.step`, `${stem(path)}.stp`, path])];

/** Raw xy box (mm, y up) of the first STEP file of this model path, or null with none. */
export function stepBox(path: string): Box | null {
  const file = stepCandidates(path).find(candidate => STEP_FILE.test(candidate) && statSync(candidate, { throwIfNoEntry: false })?.isFile());
  return file === undefined ? null : measure(file);
}
