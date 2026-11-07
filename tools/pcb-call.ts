// Runs one `tools/pcb` script and records the call in `.gate/calls.jsonl` (see lib/call-log.ts).
// Usage: pcb-call.ts SCRIPT [ARGS...]. The script gets ARGS as given. The exit code and the signal pass through.
// A log problem is a warning on stderr. It never changes the result of the command. PCB_CALL_LOG=0 turns the log off.
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { appendFileSync, mkdirSync } from 'node:fs';
import { constants } from 'node:os';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { callLogPath, commandOf, openCall, type Call } from './lib/call-log.ts';
import { projectRoot } from './lib/project-root.mjs';

const [script, ...argv] = process.argv.slice(2);
if (!script) { process.stderr.write('usage: pcb-call.ts SCRIPT [ARGS...]\n'); process.exit(2); }

let call: Call | null = null;
if (process.env.PCB_CALL_LOG !== '0') {
  try {
    const file = callLogPath(projectRoot(commandOf(argv).project ?? undefined));
    const caller = /^[A-Za-z0-9_-]{1,20}$/.test(process.env.PCB_CALLER ?? '') ? process.env.PCB_CALLER : undefined;
    call = openCall({
      append: line => { mkdirSync(dirname(file), { recursive: true }); appendFileSync(file, `${line}\n`); },
      now: () => Date.now(), id: () => `${Date.now().toString(36)}${randomBytes(3).toString('hex')}`, warn: message => process.stderr.write(`${message}\n`),
    }, argv, { caller, pid: process.pid });
  } catch (error) { process.stderr.write(`pcb: call log not written (${(error as Error).message})\n`); }
}

const here = dirname(fileURLToPath(import.meta.url));
const child = spawn(process.execPath, ['--experimental-strip-types', '--no-warnings', resolve(here, script), ...argv], { stdio: 'inherit' });
for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP'] as const) process.on(signal, () => child.kill(signal));
child.on('error', error => { process.stderr.write(`pcb: cannot run ${script}: ${error.message}\n`); call?.end(127, null); process.exit(127); });
child.on('close', (code, signal) => {
  call?.end(code, signal);
  process.exitCode = code ?? 128 + (signal ? constants.signals[signal] ?? 0 : 0);
});
