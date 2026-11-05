// Append to the existing run journal under the same flock used by the Python CLI.
// iotroute opens once and writes through that exact locked descriptor, so replacing
// a path cannot make us append to a different inode than the one we locked.
import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { iotrouteBin } from './iotroute-bin.ts';
import { utc } from './pcb-runs.ts';
import { jsonDumps } from './py-compat.mjs';

export const NOTE_KINDS = ['intervention', 'decision', 'rework'] as const;
export type NoteKind = typeof NOTE_KINDS[number];

export async function note(folder: string, kind: NoteKind, message: string): Promise<void> {
  const command = iotrouteBin();
  const child = spawn(command, ['lock', 'append', join(folder, 'notes.jsonl')], { stdio: ['pipe', 'ignore', 'pipe'] });
  const input = jsonDumps({ time: utc(), kind, message }) + '\n';
  await new Promise<void>((resolve, reject) => {
    let stderr = '', inputError: Error | null = null;
    child.stderr.setEncoding('utf8').on('data', text => { stderr += text; });
    child.stdin.on('error', error => { inputError = error; });
    child.once('error', reject);
    child.once('close', (code, signal) => {
      if (code === 0 && !inputError) resolve();
      else reject(inputError ?? new Error(`note append failed: ${stderr.trim() || signal || `exit ${code}`}`));
    });
    // Keep stdin open as a liveness pipe. The helper stops without appending
    // if this process dies while it is waiting for the journal flock.
    child.stdin.write(input);
  });
}
