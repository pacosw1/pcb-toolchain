// pcb project-check --layout [--strict BOARD]: the layout audit of a project as JSON on stdout, one summary line on stderr.
// Exit 0 for an audit, whatever it found; with --strict, 1 when BOARD has violations; 2 for a usage error.
import { parseArgs } from 'node:util';
import { auditLayout } from './lib/project-layout.ts';
import { projectRoot } from './lib/project-root.mjs';

const USAGE = 'usage: pcb [--project DIR] project-check --layout [--strict BOARD]';

function main(argv: string[]): number {
  const { values, positionals } = parseArgs({ args: argv, allowPositionals: true, options: {
    project: { type: 'string' }, layout: { type: 'boolean' }, strict: { type: 'string' },
  } });
  if (positionals.length !== 1 || positionals[0] !== 'project-check' || !values.layout) throw new Error(USAGE);
  const report = auditLayout(projectRoot(values.project), values.strict === undefined ? {} : { strict: values.strict });
  console.log(JSON.stringify(report, null, 2));
  const { boards, findings, by_type: types } = report.summary;
  const counts = Object.entries(types).map(([type, count]) => `${type}=${count}`).join(' ');
  if (report.strict) console.error(`${report.strict.pass ? 'PASS' : 'FAIL'}: project-check ${report.strict.board}: ${report.strict.violations} violations; project ${findings} findings: ${counts}`);
  else console.error(`AUDIT: project-check ${boards} boards, ${findings} findings: ${counts}`);
  return report.strict?.pass === false ? 1 : 0;
}

try {
  process.exitCode = main(process.argv.slice(2));   // no process.exit: a large report on a pipe must drain first
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 2;
}
