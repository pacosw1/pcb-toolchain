// Test fixture: a sealed release run, and the person records that follow it.
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { sha256File } from './json-file.ts';
import { approveRelease } from './release-approval.mjs';
import { recordOrder } from './release-order.mjs';

const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from('image')]);

/** A release run of board X with the CAD of now. It returns the candidate folder. */
export function releaseRun(root: string, base: string, id: string, created: string, manifest = '{"revision":"a"}'): string {
  const folder = join(base, id), candidate = join(folder, 'candidate'), pcb = 'hardware-design/boards/X/X.kicad_pcb';
  mkdirSync(join(candidate, 'gate'), { recursive: true });
  writeFileSync(join(folder, 'run.json'), JSON.stringify({ run_id: id, board: 'X', operation: 'release', created_at: created }));
  writeFileSync(join(candidate, 'release-manifest.json'), manifest);
  writeFileSync(join(candidate, 'gate/result.json'), JSON.stringify({ provenance: { inputs: [{ path: pcb, sha256: sha256File(join(root, pcb)) }, { path: 'tools/gate.mjs', sha256: 'a' }] } }));
  writeFileSync(join(folder, 'result.json'), JSON.stringify({ status: 'passed', cleanup: { complete: true }, evidence_sha256: { 'run.json': sha256File(join(folder, 'run.json')) } }));
  return candidate;
}

export function approveCandidate(root: string, candidate: string): void {
  const report = join(root, 'report.json'), image = join(root, 'top.png');
  writeFileSync(report, JSON.stringify({ board: 'X', status: 'ready_for_user_review', checks: { cad_fabrication: { candidate_sha256: sha256File(join(candidate, 'release-manifest.json')) } } }));
  writeFileSync(image, PNG);
  approveRelease(root, 'X', candidate, { by: 'Ana', reason: 'checked', report, image });
}

export const orderCandidate = (root: string, candidate: string, reference = 'JLC-1'): void =>
  void recordOrder(root, 'X', candidate, { by: 'Ana', what: '5 boards', quantity: 5, reference });
