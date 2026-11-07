// One table for the stages that change a layout: what a stage needs, what it must write, and the check that decides.
// A run stage needs its recorded source hashes (operation/source.json) and writes two images. Both are bound by the sealed
// run record (evidence_sha256), so this adds no second input check. The layout row names what a person approves.
import { join } from 'node:path';
import { isFile } from './py-path.ts';
import { sha256File } from './json-file.ts';

export interface StageContract { inputs: string[]; outputs: string[]; check: string }

const IMAGES = ['images/top.svg', 'images/bottom.svg'];
const RUN: StageContract = { inputs: ['operation/source.json'], outputs: IMAGES, check: 'candidate_board_gate' };

export const STAGE_CONTRACTS = {
  place: RUN,
  edit: RUN,
  route: RUN,
  build: RUN,
  repair: RUN,
  layout: { inputs: ['placement-constraints.json', 'route_plan'], outputs: ['image'], check: 'layout_plan' },
} as const satisfies Record<string, StageContract>;

type RunStage = 'place' | 'edit' | 'route' | 'build' | 'repair';

/** The stage of a candidate operation, or null for an operation with no contract (release). */
export function contractKey(manifest: { operation: string; kind?: string }): RunStage | null {
  if (manifest.operation === 'edit') return manifest.kind === 'place' ? 'place' : 'edit';
  return manifest.operation === 'route' || manifest.operation === 'build' || manifest.operation === 'repair' ? manifest.operation : null;
}

/** Why a passed run breaks its contract, or null. Each declared file must exist and its hash must be in the sealed record. */
export function contractProblem(manifest: { operation: string; kind?: string }, folder: string, sealed: Record<string, string>): string | null {
  const key = contractKey(manifest);
  if (!key) return null;
  for (const [role, names] of [['input', STAGE_CONTRACTS[key].inputs], ['output', STAGE_CONTRACTS[key].outputs]] as const) {
    for (const name of names) {
      if (!isFile(join(folder, name))) return `${key} stage ${role} ${name} is missing`;
      if (sealed[name] !== sha256File(join(folder, name))) return `${key} stage ${role} ${name} is not in the sealed run record`;
    }
  }
  return null;
}
