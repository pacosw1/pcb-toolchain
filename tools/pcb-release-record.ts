// tools/pcb release-approval BOARD: the G5 approval of a release candidate. It only records. It places no order and uploads no file.
import { existsSync, mkdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { isCanonicalRoot, verifySeal, withSealLock } from './lib/cad-seal.ts';
import { parseFlags, runMain, UsageError } from './lib/cli.ts';
import { durableAppend } from './lib/pcb-check-durable.ts';
import { projectRoot } from './lib/project-root.mjs';
import { jsonDumps } from './lib/py-compat.mjs';
import { approveRelease, releaseApprovalStatus } from './lib/release-approval.mjs';

const APPROVAL = 'usage: pcb [--project DIR] release-approval BOARD --candidate DIR [--json] [--approve --by NAME --reason TEXT --report FILE --image FILE]';

function logEvent(root: string, board: string, type: string, data: Record<string, unknown>): void {
  const path = join(root, '.gate/release-approval', `${board}.jsonl`);
  mkdirSync(dirname(path), { recursive: true });
  durableAppend(path, JSON.stringify({ time: new Date().toISOString(), type, board, ...data }) + '\n');
}

function approval(root: string, board: string, values: Record<string, string | boolean | undefined>): number {
  const { candidate, json, approve, by, reason, report, image } = values;
  if (typeof candidate !== 'string') throw new UsageError(APPROVAL);
  const given = [by, reason, report, image];
  if (approve ? given.some(value => typeof value !== 'string') : given.some(value => value !== undefined)) throw new UsageError(APPROVAL);
  const folder = resolve(candidate);
  if (approve) {
    if (!isCanonicalRoot(root)) throw new Error(`${root} is a run workspace or candidate copy, not canonical; it is never approved`);
    withSealLock(root, board, () => {
      verifySeal(root, board);
      const status = approveRelease(root, board, folder, { by: by as string, reason: reason as string, report: resolve(report as string), image: resolve(image as string) });
      logEvent(root, board, 'release_approval.approved', { ...status.approval });
    });
  }
  const status = releaseApprovalStatus(root, board, folder);
  const ok = status.state === 'approved';
  if (json) console.log(jsonDumps(status));
  else if (ok) console.log(`PASS: release of ${board} approved by ${status.approval!.by}`);
  else console.log(`FAIL: release approval of ${board} is ${status.state}${[...status.problems, ...status.stale].map(line => `\n  ${line}`).join('')}\nA person runs: tools/pcb release-approval ${board} --candidate DIR --approve --by NAME --reason TEXT --report FILE --image FILE`);
  return ok ? 0 : 1;
}

async function main(given: string[]): Promise<number> {
  const argv = [...given];
  let explicit: string | undefined;
  if (argv[0] === '--project') { explicit = argv[1]; argv.splice(0, 2); }
  else if (argv[0]?.startsWith('--project=')) { explicit = argv[0].slice(10); argv.shift(); }
  const command = argv.shift();
  void command;
  const usage = APPROVAL;
  const a = parseFlags(argv, {
    json: { type: 'boolean' }, candidate: { type: 'string' }, approve: { type: 'boolean' },
    by: { type: 'string' }, reason: { type: 'string' }, report: { type: 'string' }, image: { type: 'string' },
  }, usage);
  const [board, ...rest] = a.positionals;
  if (!board || rest.length) throw new UsageError(usage);
  const root = projectRoot(explicit);
  if (!existsSync(join(root, 'hardware-design/boards', board))) throw new Error(`unknown board ${board}: no folder hardware-design/boards/${board}`);
  return approval(root, board, a.values);
}
runMain(import.meta.url, main);
