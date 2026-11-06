// The CLI/Studio agent supplies decisions as data; no model text is executed.
import { parseArgs } from 'node:util';
import { readFileSync } from 'node:fs';
import { setTimeout as delay } from 'node:timers/promises';
import { projectRoot } from './lib/project-root.mjs';
import { defaultLoopBackend } from './lib/route-loop-backend.ts';
import { startLoop, statusLoop, decideLoop, cancelLoop, listLoops, LOOP_TERMINAL } from './lib/route-loop.ts';

async function main(args: string[]): Promise<void> {
  let project: string | undefined;
  if (args[0] === '--project') {
    project = args[1];
    args = args.slice(2);
  } else if (args[0]?.startsWith('--project=')) {
    project = args[0].slice(10);
    args = args.slice(1);
  }
  if (args.shift() !== 'loop') throw Error('Use pcb loop start, status, wait, decide, cancel, or list.');
  const action = args.shift();
  const { values, positionals } = parseArgs({
    args,
    allowPositionals: true,
    options: {
      experimental: { type: 'boolean' },
      policy: { type: 'string' },
      revision: { type: 'string' },
      'decision-json': { type: 'string' },
      'decision-file': { type: 'string' },
      wait: { type: 'string', default: '20' },
      json: { type: 'boolean' }
    }
  });
  const root = projectRoot(project),
    backend = defaultLoopBackend();
  if (action === 'list') {
    if (positionals.length) throw Error('loop list takes no ID.');
    console.log(
      JSON.stringify(
        listLoops(root).map((s) => ({
          ...s,
          rounds: s.rounds.map((r) => ({
            ...r,
            evidence: r.evidence ? { ...r.evidence, report: undefined } : undefined
          }))
        }))
      )
    );
    return;
  }
  if (positionals.length !== 1) throw Error(action === 'start' ? 'Name one board gate.' : 'Provide one loop ID.');
  const subject = positionals[0]!;
  let result;
  if (action === 'start') {
    if (!values.experimental)
      throw Error('Add --experimental to enable this routing loop. Benchmarks have not shown a speed advantage.');
    if (!values.policy) throw Error('Provide --policy FILE with the bounded loop and routing policy.');
    result = await startLoop(root, subject, JSON.parse(readFileSync(values.policy, 'utf8')), backend);
  } else if (action === 'status') result = await statusLoop(root, subject, backend);
  else if (action === 'cancel') result = await cancelLoop(root, subject, backend);
  else if (action === 'decide') {
    const revision = Number(values.revision);
    if (!Number.isSafeInteger(revision) || revision < 1) throw Error('Provide the current --revision.');
    if (!!values['decision-json'] === !!values['decision-file'])
      throw Error('Provide one --decision-json or --decision-file.');
    const text = values['decision-json'] ?? readFileSync(values['decision-file']!, 'utf8');
    if (text.length > 16384) throw Error('Decision exceeds 16 KiB.');
    result = await decideLoop(root, subject, revision, JSON.parse(text), backend);
  } else if (action === 'wait') {
    const seconds = Number(values.wait);
    if (!Number.isSafeInteger(seconds) || seconds < 1 || seconds > 600)
      throw Error('Choose a wait from 1 to 600 seconds.');
    const until = Date.now() + seconds * 1000;
    do {
      result = await statusLoop(root, subject, backend);
      if (LOOP_TERMINAL.has(result.status) || result.status === 'decision_required') break;
      await delay(500);
    } while (Date.now() < until);
  } else throw Error('Use pcb loop start, status, wait, decide, cancel, or list.');
  console.log(JSON.stringify(result));
}
main(process.argv.slice(2)).catch((e: unknown) => {
  console.error(JSON.stringify({ status: 'error', cause: e instanceof Error ? e.message : String(e) }));
  process.exitCode = 2;
});
