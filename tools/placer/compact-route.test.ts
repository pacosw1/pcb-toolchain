// The summary line of the chosen step.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { bestLine } from './compact-route.ts';

test('the best line names step, halo, length, vias and reason', () => {
  const line = bestLine({
    best: { board: '/o/step-2/b/NET-CORE.kicad_pcb', s: 0.542, k: 1, unrouted: 0, box_sum: 2407, measure: { length_mm: 1580.3, vias: 296, routed: '/o/step-2/route-0/NET-CORE.kicad_pcb' } },
    best_step: 2, best_reason: 'shortest routed length of 4 measured passing steps',
  });
  assert.match(line, /^BEST board .*?\/step-(\d+)\//);   // tools/design_sweep.py parses this
  for (const part of ['step 2', 's 0.542', 'length 1580.3 mm', 'vias 296', 'shortest routed length']) assert.ok(line.includes(part));
});
