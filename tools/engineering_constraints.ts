// Read-only reviewed placement checks; reports are written only to the supervisor's owned output.
import { parseArgs } from 'node:util';
import { checkManifest } from './lib/engineering-constraints.ts';
import { verifyManifest } from './lib/part-review.ts';
import { verifyEscapeEvidence } from './lib/route-decision-escape.ts';
import { atomicJson } from './lib/json-file.ts';
import { jsonDumps } from './lib/py-compat.mjs';
import { runMain, UsageError } from './lib/cli.ts';
import { projectRoot } from './lib/project-root.mjs';
import type { Dict } from './lib/py-values.ts';

const plain = (value: unknown): Dict => JSON.parse(jsonDumps(value)) as Dict;
async function main(argv: string[]): Promise<number> {
  const parsed = parseArgs({ args: argv, allowPositionals: true, options: { root: { type: 'string' }, output: { type: 'string' }, json: { type: 'boolean' }, manifest: { type: 'string' }, candidate: { type: 'string' }, 'escape-evidence': { type: 'string' } } });
  const [action, board, ...rest] = parsed.positionals;
  if (action !== 'check' || !board || rest.length || !parsed.values.manifest || !parsed.values.output) throw new UsageError('placement requires check BOARD --manifest FILE --output FILE');
  const services = { verifyManifest: (root: string, id: string, path: string) => plain(verifyManifest(root, id, path)),
    verifyEscapeEvidence: (contract: never, candidate: string, evidence: string) => verifyEscapeEvidence(plain(contract) as never, candidate, evidence) };
  const result = checkManifest(projectRoot(parsed.values.root), board, parsed.values.manifest, services as never,
    { candidate: parsed.values.candidate, escapeEvidence: parsed.values['escape-evidence'] });
  atomicJson(parsed.values.output, result);
  console.log(parsed.values.json ? jsonDumps(result) : `${result.status === 'passed' ? 'PASS' : 'STUCK'}: ${String(result.status)}`);
  return result.status === 'passed' ? 0 : 1;
}
runMain(import.meta.url, main);
