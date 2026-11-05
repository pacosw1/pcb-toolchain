// Supervised declared design assessment; original evidence stays read-only.
import { parseArgs } from 'node:util';
import { dirname } from 'node:path';
import { runMain, UsageError } from './lib/cli.ts';
import { atomicJson, sha256File } from './lib/json-file.ts';
import { jsonDumps } from './lib/py-compat.mjs';
import { evaluateContract } from './lib/design-contract-async.ts';
import { STAGES } from './lib/design-contract-load.ts';
import { designServices } from './lib/design-services.ts';
import { projectRoot } from './lib/project-root.mjs';
import { resolvePath } from './lib/py-path.ts';
import type { Dict } from './lib/py-values.ts';

async function main(argv: string[]): Promise<number> {
  const args = parseArgs({ args: argv, allowPositionals: true, options: { root: { type: 'string' }, output: { type: 'string' }, json: { type: 'boolean' }, contract: { type: 'string' }, through: { type: 'string' } } });
  const [action, id, ...extra] = args.positionals;
  if (action !== 'check' || !id || extra.length || !args.values.contract || !args.values.output || (args.values.through && !STAGES.includes(args.values.through)))
    throw new UsageError('design requires check DESIGN --contract FILE --output FILE [--through STAGE]');
  const root = projectRoot(args.values.root), output = args.values.output;
  const report = await evaluateContract(root, args.values.contract, args.values.through, designServices(root, dirname(output)));
  const blockers = report.blockers as Dict[];
  if (report.design_id !== id) {
    report.status = 'blocked';
    blockers.push({ code: 'design_identity', detail: 'CLI target differs from contract design_id', stage: args.values.through ?? 'requirements' });
  }
  atomicJson(output, report);
  const receipt = { schema: report.schema, status: report.status, design_id: report.design_id, through: report.through, qualified: false, blockers: blockers.length,
    next_action: report.next_action, report: { path: resolvePath(output), sha256: sha256File(output) } };
  console.log(args.values.json ? jsonDumps(receipt) : `${report.status === 'passed' ? 'PASS' : 'STUCK'}: design ${id}; ${blockers.length} blockers`);
  return report.status === 'passed' ? 0 : 1;
}
runMain(import.meta.url, main);
