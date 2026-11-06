// Gate adapter for the shared placement screen.
import { resolve } from 'node:path';
import { runMain, UsageError } from './lib/cli.ts';
import { checkPlacementRules } from './lib/placement-rules.ts';
import { projectRoot } from './lib/project-root.mjs';
import type { Dict } from './lib/py-values.ts';

runMain(import.meta.url, argv => {
  const [board, path, candidate, output] = argv;
  if (!board || !path || !candidate || !output) throw new UsageError('placement-check BOARD RULES PCB OUTPUT');
  const report = checkPlacementRules(projectRoot(), board, candidate, output, resolve(path));
  if (!report) throw new Error(`missing placement rules: ${path}`);
  const count = (report.blockers as Dict[]).length;
  console.log(`placement: ${count} FAIL`);
  return report.status === 'passed' ? 0 : 1;
});
