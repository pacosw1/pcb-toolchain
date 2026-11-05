// The owned child of a candidate run: tools/pcb-operation.ts RUN_FOLDER. Any failure still leaves a terminal operation receipt.
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { atomicJson } from './lib/json-file.ts';
import { runOperation } from './lib/pcb-candidate-run.ts';

const folder = process.argv[2] ?? '';

runOperation(folder).then(code => { process.exitCode = code; }, (error: unknown) => {
  mkdirSync(join(folder, 'operation'), { recursive: true });
  const cause = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
  atomicJson(join(folder, 'operation/result.json'), { status: 'error', exit_code: 2, cause });
  process.exitCode = 2;
});
