// The call log: one start line and one end line for each `tools/pcb` call, appended to `<project>/.gate/calls.jsonl`.
// It is a record for people (Studio draws it as a timeline). No gate or command reads it, and it never changes an exit code.
// It holds no environment value, and a secret in the arguments is masked. A start line with no end line means that the
// end is not known: a reader must not take it as a pass. Pure part: tools/pcb-call.ts does the I/O.
import { join } from 'node:path';

export const CALL_SCHEMA = 'iot-lab.cli-call.v1';
const MAX_ARGS = 40, MAX_ARG = 200;
const SECRET_FLAG = /^--?(token|api[-_]?key|key|secret|password|passwd|auth|authorization|bearer)$/i;
const SECRET_NAME = /(key|token|secret|passw(or)?d|auth)/i;

export const callLogPath = (root: string): string => join(root, '.gate', 'calls.jsonl');

/** The arguments of a call, safe to store: secrets masked, each argument and the list cut. */
export function redactArgs(args: readonly string[]): string[] {
  const out: string[] = [];
  let mask = false;
  for (const arg of args.slice(0, MAX_ARGS)) {
    let value = arg;
    if (mask) value = '***', mask = false;
    else if (SECRET_FLAG.test(arg)) mask = true;
    else if (/^--?[^=\s]+=/.test(arg) && SECRET_FLAG.test(arg.slice(0, arg.indexOf('=')))) value = `${arg.slice(0, arg.indexOf('=') + 1)}***`;
    else if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(arg) && SECRET_NAME.test(arg.slice(0, arg.indexOf('=')))) value = `${arg.slice(0, arg.indexOf('=') + 1)}***`;
    out.push(value.slice(0, MAX_ARG));
  }
  if (args.length > MAX_ARGS) out.push('…');
  return out;
}

/** The dispatcher takes `--project DIR` first, then the command. With no command it runs `check`. */
export function commandOf(argv: readonly string[]): { project: string | null; command: string; args: string[] } {
  let project: string | null = null, rest = [...argv];
  if (rest[0] === '--project') { project = rest[1] ?? null; rest = rest.slice(2); }
  else if (rest[0]?.startsWith('--project=')) { project = rest[0].slice('--project='.length); rest = rest.slice(1); }
  return { project, command: rest[0] ?? 'check', args: rest.slice(1) };
}

export interface CallDeps { append: (line: string) => void; now: () => number; id: () => string; warn: (message: string) => void }
export interface Call { end: (code: number | null, signal: string | null) => void }

/** Writes the start line now, and the end line on `end`. A failed write is one warning, never an exception. */
export function openCall(deps: CallDeps, argv: readonly string[], who: { caller?: string; pid?: number }): Call {
  const id = deps.id(), began = deps.now(), { command, args } = commandOf(argv);
  const write = (record: Record<string, unknown>): boolean => {
    try { deps.append(JSON.stringify({ schema: CALL_SCHEMA, id, ...record })); return true; }
    catch (error) { deps.warn(`pcb: call log not written (${(error as Error).message})`); return false; }
  };
  const started = write({ phase: 'start', at: new Date(began).toISOString(), command, args: redactArgs(args), caller: who.caller, pid: who.pid });
  return {
    end(code, signal) {
      if (!started) return;      // no start line: a lone end line would say less than nothing
      const at = deps.now();
      write({ phase: 'end', at: new Date(at).toISOString(), exit_code: code, signal, duration_ms: at - began });
    },
  };
}
