// Entry point of a TypeScript tool: runs main only when the file is the program, and turns a UsageError into exit code.
import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

export class UsageError extends Error {
  readonly code: number;
  constructor(message: string, code = 2) {
    super(message);
    this.code = code;
  }
}

const isProgram = (moduleUrl: string): boolean => {
  const program = process.argv[1];
  return program !== undefined && realpathSync(program) === realpathSync(fileURLToPath(moduleUrl));
};

/** An error other than UsageError ends the process as uncaught: exit 1 with its stack. */
export function runMain(moduleUrl: string, main: (argv: string[]) => number | Promise<number>): void {
  if (!isProgram(moduleUrl)) return;
  Promise.resolve().then(() => main(process.argv.slice(2))).then(code => { process.exitCode = code; }, (error: unknown) => {
    if (!(error instanceof UsageError)) throw error;
    console.error(error.message);
    process.exitCode = error.code;
  });
}
