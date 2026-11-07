// Board rules and part reviews share the same source-bound contract.
import { existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { checkManifest, nativeGeometry, normalizedRules, SCHEMA, type Rule } from './engineering-constraints.ts';
import { readObject } from './json-file.ts';
import { verifyManifest as verifyParts } from './part-review.ts';
import { boardConfig } from './pcb-workflow.ts';
import { jsonDumps } from './py-compat.mjs';
import { withSuffix } from './py-path.ts';
import type { Dict } from './py-values.ts';
import { verifyEscapeEvidence } from './route-decision-escape.ts';

export const placementRulesPath = (root: string, board: string): string => join(root, 'hardware-design/boards', board, 'placement-constraints.json');

export function loadPlacementRules(root: string, board: string, path = placementRulesPath(root, board)): { schema: string; rules: Rule[] } {
  const value = readObject<Dict>(path);
  if (Object.keys(value).some(key => !['schema', 'rules'].includes(key))) throw new Error('unsupported placement rule file fields');
  normalizedRules(root, value, nativeGeometry(withSuffix(boardConfig(root, board).project, '.kicad_pcb')));
  return { schema: SCHEMA, rules: value.rules as Rule[] };
}

export function verifyManifest(root: string, board: string, path: string): Dict {
  const value = readObject<Dict>(path);
  if (value.schema === SCHEMA) {
    const constraints = loadPlacementRules(root, board, path);
    const inputs = Object.fromEntries(constraints.rules.map(rule => { const source = rule.source as { path: string; sha256: string }; return [source.path, source.sha256]; }));
    return { status: 'passed', constraints, inputs };
  }
  return JSON.parse(jsonDumps(verifyParts(root, board, path))) as Dict;   // The part review refuses any other schema.
}

export const placementServices = {
  verifyManifest,
  verifyEscapeEvidence: (contract: never, candidate: string, evidence: string) => verifyEscapeEvidence(JSON.parse(jsonDumps(contract)), candidate, evidence),
};

export function checkPlacementRules(root: string, board: string, candidate?: string, output?: string, path = placementRulesPath(root, board)): Dict | null {
  if (!existsSync(path)) return null;
  const report = checkManifest(root, board, path, placementServices as never, { candidate });
  if (output) {
    writeFileSync(output, `${jsonDumps(report, 2)}\n`);
    const failures = (report.blockers as Dict[]).map(row => `FAIL ${String(row.id ?? row.code)} measured=${String(row.measured_mm ?? row.measured ?? row.detail)} limit=${jsonDumps({ min: row.min_mm ?? null, max: row.max_mm ?? row.max ?? null })}`);
    writeFileSync(output.replace(/\.json$/, '.log'), `${failures.join('\n')}${failures.length ? '\n' : ''}`);
  }
  return report;
}
