// Test helper: a layout plan approval with an image of the board.
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { approveLayoutPlan, type LayoutStatus } from './layout-plan.ts';

export const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from('fixture')]);

/** Writes ROOT/layout-image.png (a PNG signature and a few bytes) and approves the plan with it. */
export function approveFixture(root: string, board: string, by = 'Ana', reason = 'reviewed'): Promise<LayoutStatus> {
  const image = join(root, 'layout-image.png');
  writeFileSync(image, PNG);
  return approveLayoutPlan(root, board, by, reason, image);
}
