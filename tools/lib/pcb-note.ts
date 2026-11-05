// Append to the existing run journal under the same flock used by the Python CLI.
// iotroute opens once and writes through that exact locked descriptor, so replacing
// a path cannot make us append to a different inode than the one we locked.
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { iotrouteBin } from './iotroute-bin.ts';
import { utc } from './pcb-runs.ts';
import { jsonDumps } from './py-compat.mjs';

export const NOTE_KINDS = ['intervention', 'decision', 'rework'] as const;
export type NoteKind = typeof NOTE_KINDS[number];

export function note(folder: string, kind: NoteKind, message: string): void {
  const command = iotrouteBin();
  const result = spawnSync(command, ['lock', 'append', join(folder, 'notes.jsonl')], {
    input: jsonDumps({ time: utc(), kind, message }) + '\n', encoding: 'utf8',
  });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`note append failed: ${result.stderr.trim() || `exit ${result.status}`}`);
}
